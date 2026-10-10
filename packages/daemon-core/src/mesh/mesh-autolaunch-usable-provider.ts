import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import type { RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON, type ProviderQuotaGateBlock } from './mesh-quota-routing.js';
import { recordLastQuotaRanking, quotaSpreadBonusByProvider } from './mesh-quota-ranking-records.js';
import type { QuotaFactsContext } from './mesh-quota-sources.js';
import type { QuotaFallbackCandidate } from './mesh-quota-fallback.js';
import { nodeSatisfiesRequiredTags, buildMeshNodeCapabilityTags } from './mesh-work-queue.js';
import { orderSlotsForProviderSelection, type FitnessTask } from './mesh-scheduling-fitness.js';
import { selectProviderWithDiagnostics, selectionRationaleFrom, type ResolvedProviderSelection } from './mesh-routing-decision.js';
import { slotProviderUnusableReason } from './mesh-slot-provider-usability.js';
import { taskRequiresDifficultyFloor } from './mesh-scheduling-fitness.js';

export async function resolveUsableProvider(
    components: DaemonComponents,
    nodeId: string,
    node: any,
    meshId: string | undefined,
    requiredTags?: string[],
    task?: FitnessTask,
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null,
    quotaFactsContext?: QuotaFactsContext | null,
    taskId?: string,
): Promise<ResolvedProviderSelection & {
    quotaGated?: Array<{ providerType: string; block: ProviderQuotaGateBlock }>;
    quotaClearOrder?: readonly string[];
    quotaCandidates?: readonly QuotaFallbackCandidate[];
}> {
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    // Slot-based order (node capability slots design, 2026-07-09): rank the node's capability
    // slots by task→slot fitness (difficulty/requiredTags) so the best-fit slot's
    // provider is tried first, and its model/thinkingLevel ride along. Falls back
    // to the legacy providerPriority-derived slots when no explicit slots exist.
    // The QUOTA SPREAD bonus folds into the fitness score as a per-provider number
    // computed HERE (the caller side) so scoreSlotForTask itself stays pure.
    //
    // SATURATED-SLOT STARVATION (kimi-never-selected): fitness alone ranked a
    // SATURATED slot ahead of an idle equally-fit one, and this loop returns the
    // first slot whose CLI is detected — it never consulted capacity. On a node
    // with `claude-cli/opus [difficult] maxParallel:1` and `kimi [difficult]
    // maxParallel:2`, both score the same +100 difficulty match, so the stable
    // sort put opus first by ARRAY ORDER on every difficult task and kimi was
    // never selected — not once. Worse, when opus was busy the loop still
    // returned claude-cli, and the downstream SLOT MODEL GUARD ('wait') / the
    // provider-cap check skipped the WHOLE NODE rather than falling through to
    // the node's idle second slot. So a second provider configured precisely to
    // absorb difficult-task overflow was unreachable whether opus was free OR
    // busy. (The quota-spread bonus widened the same gap: a provider whose quota
    // reads 'ok' earns up to +30 while one reporting an error earns 0, turning
    // the tie into a decisive loss.)
    //
    // Capacity is therefore the PRIMARY sort key: an idle slot outranks a
    // saturated one regardless of fitness, and fitness orders within each group.
    // Saturated slots are kept (not filtered) and merely sorted last, so when
    // EVERY slot is at its cap the selection — and the wait/notify semantics the
    // downstream guard derives from it — is byte-identical to before.
    const slots = resolveNodeCapabilitySlots(node, meshId);
    if (!slots.length) return { reason: 'missing_provider_priority' };
    const quotaBonusByProvider = task ? quotaSpreadBonusByProvider(node, quotaRouting, Date.now(), quotaFactsContext) : undefined;
    const orderedSlots = task
        ? orderSlotsForProviderSelection(slots, meshId ?? '', nodeId, node, task, quotaBonusByProvider)
        : slots;
    const difficultyFloorRequired = !!task && taskRequiresDifficultyFloor(node, task);
    if (difficultyFloorRequired && !orderedSlots.length) {
        return { reason: `task_difficulty_floor_unavailable:${task!.difficulty}` };
    }

    const failed: string[] = [];
    // ★PRE-SCORE EXCLUSIONS (prescore-exclusions-visibility): every slot this loop
    // rejects BEFORE it reaches usableSlots — required-tags mismatch or
    // slotProviderUnusableReason — is recorded here unconditionally, not only when
    // `failed` ends up being the sole evidence (the old `!usableSlots.length` branch
    // below). A rejected slot never reaches selectProviderWithDiagnostics, so it never
    // appears in `selectionTrajectory.candidates` or `intraNodeLosers` either — those
    // only ever see slots that survived THIS loop. Without this, claude-cli passing
    // made codex/kimi/grok's rejection reasons here get built then silently discarded
    // every single call, with zero log line and zero ledger trace (live 2026-10-10:
    // 5 difficult-task dispatches in a row showed `candidates=[claude-cli]` only, while
    // mesh_route_preview — which does not run this filter — admitted all 4).
    // Diagnostic only: does not change which slot becomes usable or wins.
    const preScoreExclusions: Array<{ providerType: string; model?: string; reason: string }> = [];
    // DYNAMIC PROVIDER PRIORITY BY QUOTA: the loop no longer returns the FIRST
    // detected slot. It enumerates EVERY usable (detected) candidate so the
    // quota gate can be applied INSIDE the selection loop — a quota-gated first
    // choice must fall through to the node's next provider, not skip the whole
    // node (previously the gate ran after this function returned a single pair,
    // so a gated provider sent the task to the next NODE even when this node
    // had another provider with quota to spare). Candidates are de-duped per
    // provider, keeping the first — best-ordered — slot for that provider.
    const usableSlots: Array<{ slot: NodeCapabilitySlot; providerType: string }> = [];
    for (const slot of orderedSlots) {
        const requestedType = slot.provider;
        const normalizedType = typeof providerLoader.resolveAlias === 'function'
            ? providerLoader.resolveAlias(requestedType)
            : requestedType;
        // Skip providers that can't satisfy the task's requiredTags (e.g. provider=kimi
        // means only kimi qualifies, not any other slot's provider).
        if (requiredTags?.length && !nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node, normalizedType))) {
            failed.push(`${requestedType}: required_tags_mismatch`);
            preScoreExclusions.push({ providerType: requestedType, ...(slot.model ? { model: slot.model } : {}), reason: 'required_tags_mismatch' });
            continue;
        }
        // Enablement + detection are judged by the machine that will spawn the CLI — a
        // remote member is never refused for THIS daemon's config (mesh-slot-provider-usability.ts).
        const unusable = await slotProviderUnusableReason(components, node, normalizedType, quotaFactsContext?.nodes);
        if (unusable) {
            failed.push(`${requestedType}: ${unusable}`);
            preScoreExclusions.push({ providerType: requestedType, ...(slot.model ? { model: slot.model } : {}), reason: unusable });
            continue;
        }
        usableSlots.push({ slot, providerType: normalizedType });
    }
    if (!usableSlots.length) {
        if (difficultyFloorRequired) {
            return { reason: `task_difficulty_floor_unavailable:${task!.difficulty}`, preScoreExclusions };
        }
        return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}`, preScoreExclusions };
    }

    // QUOTA GATE, inside the loop: split the usable candidates by the gate and
    // order the survivors by EXPIRY RISK, descending (remaining × elapsed window
    // fraction — an unused remainder evaporates at the
    // window reset, so the least-consumable-in-time remainder is spent first;
    // the owner-confirmed dynamic priority). Fail-open is inherited from
    // evaluateProviderQuotaGate unchanged: missing/unreadable readings are
    // never BLOCKED, and a wall-clock-stale reading whose window has not reset
    // ranks at the same weight as a fresh one instead of becoming progressively
    // less selectable. ALL-gated is reported under its own
    // reason so a quota WAIT is never conflated with a slot config error.
    const selection = selectProviderWithDiagnostics({
        node, nodeId, meshId, task: task!, taskId, quotaRouting, quotaFactsContext,
        quotaBonusByProvider, difficultyFloorRequired, usableSlots, preScoreExclusions,
    });
    if (selection.reason) return { reason: selection.reason, preScoreExclusions };
    const { ranked, winner } = selection;
    const { riskSnapshot, allLosers, ...routingDiagnostics } = selection.diagnostics;
    // `allLosers` is destructured OUT: the rationale's input, not durable.
    const rationale = selectionRationaleFrom(routingDiagnostics.selectionTrajectory, allLosers);
    if (!ranked.clear.length) {
        const detail = ranked.gated.map(g => `${g.providerType}: ${g.block.reason}`).join('; ');
        LOG.info('MeshQueue', `QUOTA GATE: every usable provider on node ${nodeId} is quota-gated (${detail}); leaving the task queued until a quota window resets`);
        recordLastQuotaRanking(nodeId, {
            decidedAt: Date.now(),
            clear: riskSnapshot,
            gated: ranked.gated.map(g => ({ providerType: g.providerType, reason: g.block.reason })), ...(taskId ? { taskId } : {}),
        });
        return { reason: `${ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON}: ${detail}`, preScoreExclusions };
    }
    const selectedWinner = winner!;
    LOG.debug('MeshQueue', `QUOTA RANK: node ${nodeId} clear=[${riskSnapshot.map(s => `${s.providerType}:${s.risk?.toFixed(1) ?? '?'}`).join(',')}] gated=[${ranked.gated.map(g => `${g.providerType}:${g.block.reason}`).join(',')}] winner=${selectedWinner.providerType}`);
    recordLastQuotaRanking(nodeId, {
        decidedAt: Date.now(),
        winner: selectedWinner.providerType,
        clear: riskSnapshot,
        gated: ranked.gated.map(g => ({ providerType: g.providerType, reason: g.block.reason })),
        ...(taskId ? { taskId } : {}), ...(rationale ? { rationale } : {}),
    });
    return {
        providerType: selectedWinner.providerType,
        ...(ranked.gated.length ? { quotaGated: ranked.gated } : {}),
        // QUOTA-BUSY FALLBACK inputs: the risk-ordered clear ranking and the
        // de-duplicated candidates it was drawn from, so a caller that finds the
        // winner saturated can walk to the next clear candidate WITHOUT re-running
        // selection (re-ranking would just re-elect the same busy winner — that
        // recomputation is the defect). Only `clear` is exposed: gated providers
        // must stay unreachable from the fallback path. See mesh-quota-fallback.ts.
        quotaClearOrder: ranked.clear,
        quotaCandidates: selection.candidates,
        ...(selectedWinner.slot.model ? { model: selectedWinner.slot.model } : {}),
        ...(selectedWinner.slot.thinkingLevel ? { thinkingLevel: selectedWinner.slot.thinkingLevel } : {}),
        // The slot that won selection. Returned so the caller can enforce
        // "the launch model must be one this slot declares" — a preset
        // model must not widen what the operator configured. See
        // slot-model-enforcement.ts.
        slot: selectedWinner.slot,
        ...routingDiagnostics,
    };
}

/** Test hook: provider selection with the quota gate applied inside the loop
 *  (dynamic provider priority by quota). */
export const __resolveUsableProviderForTests = resolveUsableProvider;
