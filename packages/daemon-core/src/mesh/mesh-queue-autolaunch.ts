/**
 * Queue auto-launch subsystem — extracted from mesh-queue-assignment.ts (pure move,
 * no behavior change) to keep that file under the repo file-size gate, following the
 * mesh-candidacy-predicates.ts / mesh-claim-refusal.ts precedent.
 *
 * Owns the auto-launch decision + spawn path for pending queue tasks: the
 * per-(mesh,node) and per-(mesh,task) launch locks, the launch cooldown clock,
 * target resolution (local spawn vs forwarded launch_cli), provider selection with
 * the quota gate applied in-loop (resolveUsableProvider), the auto-launch ledger
 * writes (markAutoLaunch), and the main scan (maybeAutoLaunchOneQueueSession).
 *
 * mesh-queue-assignment.ts re-exports the test hooks so existing import paths are
 * unaffected, and imports maybeAutoLaunchOneQueueSession back for triggerMeshQueue —
 * a function-level circular import mirroring the earlier splits from this file.
 */
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, getQueue, recordTaskAutoLaunch, isTaskReadonly, taskDependenciesSatisfied, meshTaskNotBeforeReady, meshTaskPriorityRank, requeueTask, parkTaskTargetPin, failRetentionExpiredParkedTask } from './mesh-work-queue.js';
import { clearClaimDeferralForNode, noteClaimDeferredForNode, shouldRedriveDeferredClaim } from './mesh-claim-refusal.js';
import { waitForRemoteSessionReady } from './mesh-remote-ready-wait.js';
import { resolveProviderMaxParallel, resolveMaxParallelTasks, resolveMaxReadonlyParallelTasks, resolveQuotaRoutingPolicy, resolveNodeMaxConcurrentSessions } from '../repo-mesh-types.js';
import type { RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { meshNodeIdMatches, withStatusProbeMarker, type NodeCapabilitySlot } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { resolveDaemonSiblingNodeIds, effectiveSlotCap } from './mesh-daemon-slot-axis.js';
import { quotaSpreadBonusByProvider, recordLastQuotaRanking, quotaFactsContextForLiveRouting, ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON, type ProviderQuotaGateBlock, type QuotaFactsContext } from './mesh-quota-routing.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, isMeshNodeFreshEnoughToLaunch } from './mesh-node-identity.js';
import { isModelCompatibleWithProvider } from './model-provider-compat.js';
import { decideSlotForModel, finalizeSlotSelection } from './slot-model-enforcement.js';
import { noteTargetPinCleared } from './mesh-turn-ledger.js';
import { isWorkspaceAutoFastForwardInFlight, resolveAutoFastForwardPolicy, isDirtyNode } from './mesh-auto-fast-forward.js';
import { isActionableSkipReason, isTargetNodeTransientlyUnresolved, resolveDeadTargetVerdict, retractActionableSkipIfPreviouslyNotified, notifyCoordinatorOfActionableSkip, resolveTargetPinTtlVerdict, TARGET_SESSION_PIN_TTL_MS, TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON } from './mesh-skip-notify.js';
import { PARKED_SKIP_REASON, parkExpiredTargetPin, settleParkedQueueTask, taskIsParked } from './mesh-task-parking.js';
import { activeWriteAssignedCount, activeReadonlyAssignedCount, nodeHasActiveAssignment, resolveSchedulingStrategy, orderEligibleNodes, orderSlotsForProviderSelection, scoreSlotForTask, activeProviderAssignedCount, slotCoversTaskDifficulty, taskRequiresDifficultyFloor, slotHasCapacity, resolveLaunchAxis, type RankableNode, type FitnessTask } from './mesh-scheduling-fitness.js';
import { logAutoLaunchQuotaFallbackSuccess, recordAutoLaunchEvent, recordClaimRefusal } from './mesh-queue-observability.js';
import { buildAutoLaunchRoutingDecision, selectProviderWithDiagnostics, selectionRationaleFrom, type ResolvedProviderSelection } from './mesh-routing-decision.js';
import { selectQuotaBusyFallback, type QuotaFallbackCandidate } from './mesh-quota-fallback.js';
import { autoLaunchWriteWouldClobberWinner, driveExpiredAwaitClaim, autoLaunchAwaitClaimBackoff, claimAfterRemoteAutoLaunch, AUTO_LAUNCH_AWAIT_CLAIM_MS, __clearAwaitClaimBackoffForTests, __resetAutoLaunchOrphanNotifiedForTests } from './mesh-autolaunch-integrity.js';
import { autoLaunchWriteWouldClobberDifficultyFloorWaitClock, handleDifficultyFloorSkip, isDifficultyFloorWaitReason, launchSideDifficultyFloorMismatch } from './mesh-difficulty-floor.js';
import { maybeParkSpawnCappedTask } from './mesh-autolaunch-spawn-cap.js';
import { normalizeProviderPriority, isLaunchableNode, isLocalAutoLaunchNode, liveSessionCountForNode, nodeHasLiveSessionPendingClaim } from './mesh-candidacy-predicates.js';
import {
    delegatedWorkerAutoApproveSettingsForNode,
    localCoordinatorDaemonId,
    readMeshNodeId,
    remoteSessionReadyProbe,
    tryAssignQueueTask,
    waitForLocalSessionReady,
} from './mesh-queue-assignment.js';

// Per-(mesh,NODE) launch lock: two concurrent launches never land on the SAME node. It does
// NOT cover the same TASK across DIFFERENT nodes — autoLaunchTaskInProgress below closes that.
const autoLaunchInProgress = new Set<string>();
// AUTOLAUNCH-TASK-RACE. Per-(mesh,TASK) launch lock, keyed `${meshId}::${taskId}`. Held across
// the WHOLE per-task iteration (all gates + the launch), released in a `finally` so no early
// `continue` / `return` / throw can strand it — a stranded entry would wedge the task pending
// forever, which is strictly worse than the duplicate it prevents.
// Why a per-TASK lock is needed on top of the per-node one, and the live evidence for it:
// see the AUTOLAUNCH-TASK-RACE section at the top of mesh-autolaunch-integrity.ts.
const autoLaunchTaskInProgress = new Set<string>();
const autoLaunchCooldownUntil = new Map<string, number>();
const AUTO_LAUNCH_COOLDOWN_MS = 5_000;


// AUTOLAUNCH-CLAIM-CHURN. For a REMOTE node the launch→claim handshake is purely
// event-sourced: the worker's agent:ready must be pulled (reconcile PHASE 1) to run
// setRemoteIdleSession before the drain can claim. If that pull is lost, nothing recovers,
// and after AUTO_LAUNCH_AWAIT_CLAIM_MS the loop used to blindly RESPAWN a new session — whose
// respawn guards (nodeHasLiveSessionPendingClaim / liveSessionCountForNode) scan only the LOCAL
// instanceManager, so the remote pending-claim session is invisible and a fresh ghost accumulates
// every ~90s (observed live 2026-07-04: task 8b188c64, and 7 ghost sessions on this worktree's
// own task at 11:23-11:34). Instead of respawning on window expiry, we re-drive the claim for the
// EXISTING session; when its liveness cannot be positively determined we EXTEND the window with
// exponential backoff (90 → 180 → 360s) and, only after the cap, deliver the task directly into
// the launched session (the mesh_send_task-equivalent) rather than spawning another worker.
const AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES = 2;


// Test hooks: reset / seed the await-claim backoff state between cases.
export function __resetAutoLaunchAwaitClaimBackoffForTests(): void {
    __clearAwaitClaimBackoffForTests();
    autoLaunchTaskInProgress.clear();
    autoLaunchInProgress.clear();
    __resetAutoLaunchOrphanNotifiedForTests();
}
/** @internal Test-only: is the per-task auto-launch lock held? The AUTOLAUNCH-TASK-RACE suite
 *  asserts it is released on every exit path (a leak would wedge the task pending forever). */
export function __autoLaunchTaskLockHeldForTests(meshId: string, taskId: string): boolean {
    return autoLaunchTaskInProgress.has(`${meshId}::${taskId}`);
}

function sweepExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of autoLaunchCooldownUntil) {
        if (now >= until) autoLaunchCooldownUntil.delete(key);
    }
}


/**
 * Resolve how a pending queue task should be auto-launched onto a node.
 *
 * - `local`: spawn directly on this daemon via cliManager.handleCliCommand('launch_cli').
 * - `remote`: forward `launch_cli` to the node's daemon via dispatchMeshCommand
 *   (mirrors what mesh_launch_session does). Requires dispatchMeshCommand AND a
 *   resolvable coordinator daemonId for relay-safe completion routing.
 * - `skip`: not launchable from here — carries the reason (e.g. a remote node with
 *   no dispatch transport, or no coordinator daemonId to stamp).
 */
function resolveAutoLaunchTarget(components: DaemonComponents, node: any): {
    mode: 'local' | 'remote' | 'skip';
    reason?: string;
    daemonId?: string;
    coordinatorDaemonId?: string;
} {
    if (isLocalAutoLaunchNode(node)) return { mode: 'local' };

    // Remote node. Forwarding the launch is possible only with a dispatch transport
    // (cloud mode) plus a coordinator daemonId to stamp into the worker so completion
    // events route back here. Without either, fall back to a graceful skip.
    //
    // CANON-IDENTITY: read the daemonId through the normalizing helper (same defect class
    // as the dispatch guard above). A raw `node.daemonId` read misses non-top-level-camelCase
    // serialization forms (daemon_id / machine.daemonId / lastProbe.machine.daemon_id / …),
    // so a genuinely-remote node arriving in one of those forms read empty here and was
    // wrongly skipped as `remote_auto_launch_unsupported`. readMeshNodeDaemonId returns
    // undefined (falsy) when absent — equivalent to the old readNonEmptyString + !daemonId
    // guard, so local/self auto-launch is unchanged.
    const daemonId = readMeshNodeDaemonId(node ?? {});
    if (!daemonId) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    if (!components.dispatchMeshCommand) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    // CANON: stamp the canonical `daemon_mach_` coordinator anchor onto the remote
    // worker (meshCoordinatorDaemonId) so its completion forwards back under the same
    // form every other dispatch path uses — no producer-side coordinator-id skew.
    const coordinatorDaemonId = localCoordinatorDaemonId();
    if (!coordinatorDaemonId) return { mode: 'skip', reason: 'remote_auto_launch_no_coordinator_daemon_id' };
    return { mode: 'remote', daemonId, coordinatorDaemonId };
}

function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
    // LEDGER-TASK-TRACEABILITY (D): resolved execution profile for started/completed.
    model?: string;
    thinkingLevel?: string;
}) {
    const reason = args.reason || args.error;
    const difficultyFloorSkip = args.status === 'skipped' && isDifficultyFloorWaitReason(reason);
    if (difficultyFloorSkip) {
        handleDifficultyFloorSkip({ meshId, taskId, reason: reason!, nodeId: args.nodeId, coordinatorDaemonId: localCoordinatorDaemonId() });
    } else if (!autoLaunchWriteWouldClobberWinner(meshId, taskId, args, AUTO_LAUNCH_AWAIT_CLAIM_MS) && !autoLaunchWriteWouldClobberDifficultyFloorWaitClock(meshId, taskId, args.status)) {
        recordTaskAutoLaunch(meshId, taskId, {
            status: args.status,
            reason,
            nodeId: args.nodeId,
            providerType: args.providerType,
            sessionId: args.sessionId,
        });
    }
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
        ...(args.model ? { model: args.model } : {}),
        ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
    });
    // Fix (1): actively notify the coordinator of a non-self-resolving skip; re-arm the
    // notification on any non-skip transition (started/completed) so a later genuine skip
    // re-notifies.
    if (args.status === 'skipped') {
        if (isActionableSkipReason(args.reason)) {
            notifyCoordinatorOfActionableSkip(meshId, taskId, args.reason, args.nodeId);
        } else if (!difficultyFloorSkip && args.reason === TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON) {
            // FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): the unmatch is now known to be a
            // self-resolving clone/bootstrap window — retract any earlier actionable blocker we
            // paged for this same task. Other transient/back-pressure reasons (cooldown, caps)
            // intentionally do NOT retract: they can mask a still-standing real blocker.
            retractActionableSkipIfPreviouslyNotified(meshId, taskId);
        }
    } else {
        // started/completed: the task is progressing — re-arm the de-dup ledger and retract
        // any still-undelivered stale blocker for it.
        retractActionableSkipIfPreviouslyNotified(meshId, taskId);
    }
}

export const __markAutoLaunchForTests = markAutoLaunch;

async function resolveUsableProvider(
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

    // Slot-based order (ORCHESTRATION_NODE_SLOTS.md): rank the node's capability
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
        // Skip providers that can't satisfy the task's requiredTags (e.g. provider=hermes-cli
        // means only hermes-cli qualifies, not any other slot's provider).
        if (requiredTags?.length && !nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node, normalizedType))) {
            failed.push(`${requestedType}: required_tags_mismatch`);
            continue;
        }
        if (typeof providerLoader.isMachineProviderEnabled === 'function' && !providerLoader.isMachineProviderEnabled(normalizedType)) {
            failed.push(`${requestedType}: disabled`);
            continue;
        }
        let detected: any;
        try {
            detected = await detectCLI(normalizedType, providerLoader, { includeVersion: false });
        } catch (e: any) {
            failed.push(`${requestedType}: detect failed: ${e?.message || e}`);
            continue;
        }
        if (typeof providerLoader.setCliDetectionResults === 'function') {
            providerLoader.setCliDetectionResults([{
                id: normalizedType,
                installed: !!detected,
                path: detected?.path,
            }], false);
        }
        (components as any).onStatusChange?.();
        if (detected) {
            usableSlots.push({ slot, providerType: normalizedType });
            continue;
        }
        failed.push(`${requestedType}: not detected`);
    }
    if (!usableSlots.length) {
        if (difficultyFloorRequired) {
            return { reason: `task_difficulty_floor_unavailable:${task!.difficulty}` };
        }
        return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}` };
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
        quotaBonusByProvider, difficultyFloorRequired, usableSlots,
    });
    if (selection.reason) return { reason: selection.reason };
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
        return { reason: `${ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON}: ${detail}` };
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


export async function maybeAutoLaunchOneQueueSession(components: DaemonComponents, meshId: string, mesh: any): Promise<boolean> {
    const queue = getQueue(meshId);
    // DEPENDSON-GATE-SYMMETRY: status index over the FULL queue (incl. completed)
    // so the dependency gate below sees the terminal state of every referenced
    // dependency, not just the still-active rows.
    const statusById = new Map(queue.map(task => [task.id, task.status] as const));
    // G6: scan higher task-level priority first so a high-priority task auto-launches its
    // session ahead of an older normal/low task (getQueue is FIFO; a stable sort by priority
    // rank descending keeps created_at order within a priority band). The claim path applies
    // the same ordering, so the launched session pulls the same task the scan chose.
    const pending = queue
        .filter(task => task.status === 'pending')
        .sort((a, b) => meshTaskPriorityRank(b.priority) - meshTaskPriorityRank(a.priority));
    // AUTOLAUNCH-CLAIM-CHURN: prune await-claim backoff state for tasks of this mesh that are no
    // longer pending (claimed/completed/cancelled) so the map cannot grow without bound.
    {
        const pendingIds = new Set(pending.map(t => t.id));
        const prefix = `${meshId}::`;
        for (const key of [...autoLaunchAwaitClaimBackoff.keys()]) {
            if (key.startsWith(prefix) && !pendingIds.has(key.slice(prefix.length))) autoLaunchAwaitClaimBackoff.delete(key);
        }
    }
    if (!pending.length) return false;

    // Launch-freshness threshold: reuse the auto-fast-forward policy's maxBehind (default
    // 0 → any behind blocks) so the launch gate and the repair path agree on how far
    // behind is tolerable. Resolved once per pass and shared across every candidate node.
    const freshnessGate = { maxBehind: resolveAutoFastForwardPolicy(mesh).maxBehind };

    // Write cap + read-only cap resolved through the shared helpers from the
    // MACHINE-LOCAL stored mesh policy (no repo-file overlay). These are the same
    // resolvers the observability projection uses, so the enforced and exposed
    // caps can never drift.
    const maxParallelTasks = resolveMaxParallelTasks(mesh?.policy?.maxParallelTasks);
    // Read-only diagnoses carry no isolation/merge cost, so they are exempt from the
    // write-task parallel cap. To prevent runaway auto-launch they get their own,
    // higher safety cap (default 2× the write cap).
    const maxReadonlyParallelTasks = resolveMaxReadonlyParallelTasks(maxParallelTasks);
    for (const task of pending) {
        // AUTOLAUNCH-TASK-RACE: take the per-TASK lock before ANY gate — everything below is
        // await-interruptible, so this is the only point that can serialize two overlapping
        // triggerMeshQueue passes onto the same task (rationale: mesh-autolaunch-integrity.ts).
        // The busy branch records to the LEDGER ONLY: markAutoLaunch would overwrite
        // task.autoLaunch wholesale and clobber the in-flight racer's record.
        const taskLaunchKey = `${meshId}::${task.id}`;
        if (autoLaunchTaskInProgress.has(taskLaunchKey)) {
            recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'auto_launch_task_in_progress' });
            continue;
        }
        autoLaunchTaskInProgress.add(taskLaunchKey);
        try {
            // DEPENDSON-GATE-SYMMETRY: never spawn a session for a task whose
            // dependsOn set is not all-completed (or that carries a system block). The
            // launched session would idle→claim and be refused by the SAME predicate in
            // claimNextQueueTask, producing orphan-session / re-launch churn. Skip it so
            // a later tick — after the dependency completes — launches it. Tasks with no
            // dependsOn pass through unchanged (predicate is true).
            if (!taskDependenciesSatisfied(task, statusById)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'dependencies_unsatisfied' });
                continue;
            }
            // G7: never spawn a session for a task still held by its notBefore gate — the launched
            // session would idle→claim and be refused by the SAME gate in claimNextQueueTask,
            // producing orphan-session churn. Skip it so a later tick (after not_before passes)
            // launches it. Tasks with no notBefore pass through unchanged.
            if (!meshTaskNotBeforeReady(task)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'not_before_delayed' });
                continue;
            }
            const isReadonly = isTaskReadonly(task);
            if (isReadonly) {
                if (activeReadonlyAssignedCount(meshId) >= maxReadonlyParallelTasks) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_readonly_parallel_tasks_reached' });
                    continue;
                }
            } else if (activeWriteAssignedCount(meshId) >= maxParallelTasks) {
                // Write tasks are capped; skip this one but keep scanning so a later
                // read-only task in the queue can still launch under its own cap.
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_parallel_tasks_reached' });
                continue;
            }
            // PIN-PARKING: a parked row awaits a COORDINATOR decision, so no daemon-side
            // self-heal may touch it. Must stay BEFORE the pin branch below: the dead-target
            // self-heal would otherwise "rescue" a parked task by requeueing it with the
            // session pin cleared — silently re-homing the very delta parking protects.
            if (taskIsParked(task)) {
                settleParkedQueueTask(
                    meshId,
                    task,
                    reason => markAutoLaunch(meshId, task.id, { status: 'skipped', reason }),
                    failRetentionExpiredParkedTask,
                );
                continue;
            }
            if (task.targetSessionId) {
                // DEAD-TARGET-SELFHEAL: before the unconditional target_session_constraint skip,
                // check whether the pinned session/node has DIED (absent from the live mesh). A
                // hard-pinned task whose target is gone can NEVER re-enter 'assigned' (the claim
                // gate refuses every non-matching session) and this skip fires forever with no
                // liveness check — the triple-walled stranded-pending defect. If the pin is
                // confirmed dead past the grace window, requeue it (clearing the dead session
                // pin, and the node pin too when the NODE itself is gone) so a live idle session
                // can claim it. requeueTask counts toward maxTaskRetries → bounded self-heal that
                // auto-fails past the cap (the desired terminal state, unblocking dependents).
                const deadTarget = resolveDeadTargetVerdict(components, meshId, mesh, task);
                if (deadTarget.dead) {
                    const requeued = requeueTask(meshId, task.id, {
                        reason: deadTarget.reason,
                        clearTargetSession: true,
                        // Keep the node pin if only the SESSION died on a still-live node; clear it
                        // when the NODE itself is absent (nothing to pin to).
                        clearTargetNode: deadTarget.nodeDead,
                    });
                    if (requeued) {
                        noteTargetPinCleared(deadTarget.reason);
                        LOG.warn('MeshQueue', `DEAD-TARGET-SELFHEAL: task ${task.id} (mesh ${meshId}) was pinned to a dead target (${deadTarget.reason}); requeued${deadTarget.nodeDead ? ' and unpinned node' : ''} (requeueCount=${requeued.requeueCount ?? '?'}, status=${requeued.status}).`);
                    }
                    // Keep the skip for THIS tick (the requeue already flipped the row to
                    // pending/failed); a later tick assigns/launches the now-unpinned task.
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_dead_requeued' });
                    continue;
                }
                // TARGET-PIN TTL → PARKING. The pin is NOT provably dead (a live session, or a
                // remote/unobservable one the dead-target verdict must not guess about) but has
                // waited past the bounded TTL, measured over UNPRODUCTIVE time only. On expiry
                // the task PARKS rather than unpinning: a cleared pin let any compatible session
                // claim a delta written for one session's context — a wrong delivery, not a late
                // one. See mesh-task-parking.
                if (parkExpiredTargetPin(meshId, task, resolveTargetPinTtlVerdict(components, task), TARGET_SESSION_PIN_TTL_MS, (m, t, r) => parkTaskTargetPin(m, t, { reason: r }))) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: PARKED_SKIP_REASON });
                    continue;
                }
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_constraint' });
                continue;
            }

            // Per-task await-claim guard. A prior auto-launch already spawned a session for
            // this task and we are waiting for that session's idle→claim to land (remote
            // claims arrive via the worker→coordinator agent:ready pull, which can lag well
            // past the per-node cooldown). Re-launching now would spawn a duplicate orphan
            // session that never gets work. The task leaves `pending` the instant the claim
            // succeeds, so this guard only suppresses the in-flight window; if the launched
            // session never reaches idle within the window, a later tick retries.
            if (task.autoLaunch?.status === 'completed' && task.autoLaunch.sessionId) {
                const launchedAtMs = Date.parse(task.autoLaunch.updatedAt);
                const alSessionId = readNonEmptyString(task.autoLaunch.sessionId);
                const alNodeId = readNonEmptyString(task.autoLaunch.nodeId);
                const alProvider = readNonEmptyString(task.autoLaunch.providerType);
                if (Number.isFinite(launchedAtMs) && Date.now() - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS) {
                    // AUTOLAUNCH-DEFERRED-CLAIM: this guard's premise — "a claim is already in
                    // flight, just wait" — is FALSE when the launch's single inline claim was
                    // refused by the ff lease. Re-drive it instead of waiting out the window
                    // (rationale + bounding: mesh-claim-refusal.ts).
                    if (shouldRedriveDeferredClaim(meshId, alNodeId, alSessionId, () => isWorkspaceAutoFastForwardInFlight(readNonEmptyString(
                        (Array.isArray(mesh?.nodes) ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, alNodeId)) : undefined)?.workspace,
                    )))) {
                        if (tryAssignQueueTask(components, meshId, alNodeId, alSessionId, alProvider, undefined, undefined, 'auto_launch')) {
                            clearClaimDeferralForNode(meshId, alNodeId);
                            recordAutoLaunchEvent(meshId, { phase: 'completed', taskId: task.id, reason: 'fast_forward_deferred_claim_redriven', nodeId: alNodeId, sessionId: alSessionId });
                            LOG.info('MeshQueue', `Auto-launch re-drove the auto-fast-forward-deferred claim for task ${task.id} into session ${alSessionId} on node ${alNodeId} (mesh ${meshId})`);
                            return true;
                        }
                        // Still refused — the ledger now names the gate (recordClaimRefusal).
                        // Spend one unit of the budget; once exhausted this falls through to
                        // the ordinary await-claim window.
                        noteClaimDeferredForNode(meshId, alNodeId);
                    }
                    // Record the skip in the ledger ONLY (dedup'd). Do NOT call markAutoLaunch
                    // here: recordTaskAutoLaunch overwrites task.autoLaunch wholesale, which would
                    // erase the very `completed` record (status + sessionId + updatedAt) this guard
                    // reads on the next tick, reopening the duplicate-launch hole it closes.
                    recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'awaiting_launched_session_claim', nodeId: alNodeId, sessionId: alSessionId });
                    continue;
                }
                // AUTOLAUNCH-CLAIM-CHURN: the initial await-claim window expired. Rather than a blind
                // respawn (which the local-only respawn guards can't dedup for a remote pending-claim
                // session → ghost accumulation), re-drive the claim for the EXISTING launched session,
                // backing off on unknown liveness and direct-dispatching after the cap. Only a
                // 'respawn' directive falls through to a fresh launch below.
                if (Number.isFinite(launchedAtMs) && alSessionId && alNodeId) {
                    const outcome = driveExpiredAwaitClaim(components, meshId, task, { sessionId: alSessionId, nodeId: alNodeId, providerType: alProvider }, tryAssignQueueTask);
                    if (outcome === 'claimed' || outcome === 'fallback') return true; // progress; suppress a duplicate launch
                    if (outcome === 'backoff') continue;                              // window extended; no respawn
                    // outcome === 'respawn' → session provably gone; proceed to a fresh launch below.
                }
            }

            // AUTOLAUNCH-SPAWN-CAP (P3): durable per-task launch budget. Deliberately AFTER the
            // await-claim guard (an in-flight claim is never parked mid-wait) and BEFORE node
            // selection — the alternative here is another launch. See mesh-autolaunch-spawn-cap.ts.
            if (maybeParkSpawnCappedTask(meshId, task, parkTaskTargetPin, reason => markAutoLaunch(meshId, task.id, { status: 'skipped', reason }))) continue;

            const candidateNodes = Array.isArray(mesh?.nodes)
                ? mesh.nodes.filter((node: any) => {
                    // Bug A: match the target pin with the shared 3-form (id / nodeId / node_id)
                    // normalizer, mirroring the remote-idle drain (meshNodeIdMatches at the
                    // getRemoteIdleSessions filter). A strict `readMeshNodeId(node) !== targetNodeId`
                    // dropped a target node whose identity arrived under a different form (a freshly
                    // mesh_clone_node'd worktree), emptying candidateNodes and mislabelling the skip.
                    if (task.targetNodeId && !meshNodeIdMatches(node, task.targetNodeId)) return false;
                    // WTDISPATCH-FANOUT: a convergence task is base-only (it merges/pushes onto
                    // base). Never auto-launch a worktree-clone session for it — that is the very
                    // fan-out the claim guard refuses, so spinning the session up would only waste
                    // a launch that can never claim. Mirrors claimNextQueueTask's convergence gate.
                    if (task.taskMode === 'convergence' && node?.isLocalWorktree === true) return false;
                    // Skip nodes that can never satisfy requiredTags regardless of which provider
                    // is selected. A node satisfies tags if at least one provider it can launch
                    // would produce matching capability tags. Enumerate providers from the node's
                    // capability slots (the single source of truth — a provider that lives only in
                    // slots, e.g. cursor-cli, is otherwise invisible to providerPriority-keyed
                    // enumeration), falling back to the legacy providerPriority.
                    if (task.requiredTags?.length) {
                        const slotProviders = resolveNodeCapabilitySlots(node, meshId).map(s => s.provider).filter(Boolean);
                        const priorities = slotProviders.length ? slotProviders : normalizeProviderPriority(node?.policy);
                        const providerCandidates = priorities.length ? priorities : [undefined as unknown as string];
                        return providerCandidates.some(p =>
                            nodeSatisfiesRequiredTags(task.requiredTags, buildMeshNodeCapabilityTags(node, p))
                        );
                    }
                    return true;
                })
                : [];
            if (!candidateNodes.length) {
                // Bug A: distinguish the two ways the candidate set empties. A task pinned to a
                // targetNodeId whose node is absent from the mesh (or whose id arrived under a
                // different form) is a ROUTING miss — report it as `target_node_id_unmatched`, not
                // the hard-coded `no_node_satisfies_required_tags`, which mislabelled a 3-form
                // node-id mismatch as a capability failure and sent diagnosis down the wrong path.
                // Only fall back to the tag reason when no target pin is in play, or the pin DID
                // match a node but its tags excluded it (a genuine capability miss).
                const targetPinUnmatched = !!task.targetNodeId
                    && !(Array.isArray(mesh?.nodes) && mesh.nodes.some((n: any) => meshNodeIdMatches(n, task.targetNodeId)));
                // Fix (2): a `convergence` task is base-only — the candidate filter above
                // (`taskMode === 'convergence' && node.isLocalWorktree`) deliberately drops every
                // worktree-clone node, so candidateNodes can empty out NOT because the target is
                // missing or tag-incapable, but because every node the task could land on is a
                // worktree. Reporting that as `target_node_id_unmatched` / `no_node_satisfies_
                // required_tags` mislabels the cause and sends diagnosis down the wrong path.
                // Detect it explicitly and report the same reason mesh_send_task uses for a direct
                // convergence dispatch onto a worktree, so both surfaces agree.
                const convergenceOntoWorktree = task.taskMode === 'convergence'
                    && Array.isArray(mesh?.nodes)
                    && (() => {
                        const matched = (mesh.nodes as any[]).filter((n: any) =>
                            !task.targetNodeId || meshNodeIdMatches(n, task.targetNodeId));
                        return matched.length > 0 && matched.every((n: any) => n?.isLocalWorktree === true);
                    })();
                // FALSE-BLOCKER-CLONE-QUEUE: an unmatched target pin is only a PERMANENT routing
                // miss when the node is genuinely absent — a freshly cloned worktree whose
                // inline-cache entry has not propagated here yet (or whose bootstrap is still
                // running) is TRANSIENTLY unresolved and auto-claims shortly. Report that as the
                // transient (non-actionable) reason so the coordinator is not paged with a false
                // "actionable blocker — will NOT clear on its own". A genuinely dead node is neither
                // bootstrap-running nor inside the clone grace window → stays 'target_node_id_unmatched'.
                const targetTransientlyUnresolved = targetPinUnmatched
                    && isTargetNodeTransientlyUnresolved(mesh, task);
                markAutoLaunch(meshId, task.id, {
                    status: 'skipped',
                    reason: convergenceOntoWorktree
                        ? 'mesh_convergence_target_is_worktree'
                        : targetTransientlyUnresolved
                            ? TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON
                            : (targetPinUnmatched ? 'target_node_id_unmatched' : 'no_node_satisfies_required_tags'),
                    nodeId: task.targetNodeId,
                });
                continue;
            }

            // PRIORITY → TIE-BREAK: order the eligible (TAG-filtered) candidate nodes by
            // the mesh scheduling strategy. 'first_eligible' (default) returns them in
            // config/array order unchanged, so distribution is strictly opt-in. The
            // per-node MAX-ALLOC capacity gate (nodeHasActiveAssignment, provider cap,
            // maxConcurrentSessions) is still applied inside the loop below; this only
            // chooses which eligible node is *tried first*.
            const strategy = resolveSchedulingStrategy(mesh);
            const orderedCandidateNodes = strategy === 'first_eligible'
                ? candidateNodes
                : orderEligibleNodes(
                    meshId,
                    strategy,
                    candidateNodes
                        .map((node: any, index: number) => ({ nodeId: readMeshNodeId(node), node, index }))
                        .filter((c: RankableNode) => c.nodeId),
                    // Auto-launch drains one task at a time, so the task IS in scope here —
                    // pass it through for the 'fitness' strategy's task→slot ranking. The
                    // mesh's quotaRouting thresholds ride along so the fitness score can
                    // include the quota-headroom spread bonus (fail-open when unset).
                    { bumpCursor: true, task: { difficulty: (task as any).difficulty, requiredTags: task.requiredTags }, quotaRouting: mesh?.policy?.quotaRouting ?? null, quotaFactsContext: quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader) },
                ).map((c: RankableNode) => c.node);

            // LEDGER-TASK-TRACEABILITY (A): accumulate the candidate nodes that were
            // considered but skipped before the winning node, so task_dispatched can record
            // WHY the other nodes lost (cooldown, dirty, cap, provider mismatch, …). Bounded
            // so a large fleet can't bloat the entry. markSkip mirrors markAutoLaunch's skip
            // side effect AND appends to this list in one call.
            const skippedCandidates: Array<{ nodeId: string; reason: string }> = [];
            const SKIPPED_CANDIDATES_MAX = 5;
            const markSkip = (nodeIdForSkip: string, reason: string, extra?: { providerType?: string }) => {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason, nodeId: nodeIdForSkip, ...(extra || {}) });
                if (nodeIdForSkip && skippedCandidates.length < SKIPPED_CANDIDATES_MAX) {
                    skippedCandidates.push({ nodeId: nodeIdForSkip, reason });
                }
            };

            for (const node of orderedCandidateNodes) {
                const nodeId = readMeshNodeId(node);
                if (!nodeId) continue;
                const launchKey = `${meshId}:${nodeId}`;
                const now = Date.now();
                const cooldownUntil = autoLaunchCooldownUntil.get(launchKey) || 0;
                if (cooldownUntil > 0 && now >= cooldownUntil) autoLaunchCooldownUntil.delete(launchKey);
                if (autoLaunchInProgress.has(launchKey)) {
                    markSkip(nodeId, 'auto_launch_in_progress');
                    continue;
                }
                if (now < cooldownUntil) {
                    markSkip(nodeId, 'auto_launch_cooldown');
                    continue;
                }
                if (isDirtyNode(node)) {
                    markSkip(nodeId, 'dirty_workspace');
                    continue;
                }
                if (!isLaunchableNode(node)) {
                    // Names the HEALTH gate specifically (isMeshNodeHealthLaunchable:
                    // resolved health must be 'online' or 'unknown'). Deliberately NOT
                    // called `node_not_launch_ready`: that read as the negation of the
                    // node status field `launchReady`, which answers an entirely
                    // different question — finalizeMeshNodeStatus computes it from
                    // daemonId + machineStatus/connection + worktree bootstrap, and
                    // never consults health. A node can therefore legitimately report
                    // `launchReady: true` while being skipped here for degraded/dirty/
                    // wrong_branch health, which looked like a contradiction rather
                    // than two independent gates. Matches the self-describing style of
                    // the sibling reasons (dirty_workspace, node_stale_behind_upstream).
                    markSkip(nodeId, 'node_health_not_launchable');
                    continue;
                }
                // FRESHNESS gate (distinct from the health gate above): a clean-tree node that
                // is `behind` its upstream reads as 'online' and passes isLaunchableNode, so
                // without this it could win fitness routing and run a fresh worker against
                // stale code. Skip a node whose git telemetry proves it stale (behind >
                // maxBehind, or a submodule out of sync). Reuse the auto-fast-forward policy's
                // maxBehind threshold so "how far behind is tolerable" is configured in ONE
                // place. Telemetry-absent nodes pass (never block on missing data). The 4s
                // reconcile retries once the node's auto-ff repair path catches it up.
                if (!isMeshNodeFreshEnoughToLaunch(node, freshnessGate)) {
                    markSkip(nodeId, 'node_stale_behind_upstream');
                    continue;
                }
                const launchTarget = resolveAutoLaunchTarget(components, node);
                if (launchTarget.mode === 'skip') {
                    // Remote node we can't reach (no transport / no coordinator daemonId).
                    // Set a cooldown so the 4s reconcile loop doesn't re-attempt this node
                    // every tick; the de-dup'd skip ledger keeps it diagnosable without flood.
                    markSkip(nodeId, launchTarget.reason || 'auto_launch_unavailable');
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    continue;
                }
                // DOUBLE-DISPATCH auto-launch gate (see nodeHasLiveSessionPendingClaim): when this
                // node already has a live session on its way to claim (idle / booting / momentary
                // non-idle flip), do NOT spawn a second one — that session pulls the pending task
                // via the normal idle→claim / agent:ready drain. Launching here races it and yields
                // a duplicate worker that double-stamps the same taskId. Applies to read-only tasks
                // too: an idle session can claim either kind, while a genuinely BUSY session (holding
                // its own assigned task) is excluded by the helper, so a read-only launch onto a
                // busy-but-no-idle node is still allowed. Skip with a transient (non-actionable)
                // reason so the coordinator is not paged; the 4s reconcile retries, and once the
                // existing session goes terminal this gate clears and a legitimate launch proceeds.
                if (nodeHasLiveSessionPendingClaim(components, meshId, nodeId, task, node)) {
                    markSkip(nodeId, 'node_has_live_session_pending_claim');
                    continue;
                }
                // Write tasks keep the one-active-per-node invariant (worktree isolation);
                // read-only diagnoses may auto-launch onto a node that already has an active
                // assignment. Classified by the shared isTaskReadonly predicate.
                if (!isTaskReadonly(task) && nodeHasActiveAssignment(meshId, nodeId)) {
                    markSkip(nodeId, 'node_has_active_assignment');
                    continue;
                }
                const maxConcurrentSessions = resolveNodeMaxConcurrentSessions(node?.policy?.maxConcurrentSessions);
                if (liveSessionCountForNode(components, meshId, nodeId) >= maxConcurrentSessions) {
                    markSkip(nodeId, 'max_concurrent_sessions_reached');
                    continue;
                }

                autoLaunchInProgress.add(launchKey);
                try {
                    const resolved = await resolveUsableProvider(components, nodeId, node, meshId, task.requiredTags, { difficulty: (task as any).difficulty, requiredTags: task.requiredTags }, mesh?.policy?.quotaRouting ?? null, quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader), task.id);
                    if (!resolved.providerType) {
                        // The QUOTA GATE now runs INSIDE resolveUsableProvider's selection
                        // loop (a gated first-choice provider falls through to the node's
                        // next provider instead of skipping the whole node), so a quota
                        // refusal arrives here as the reason: the non-actionable
                        // ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON when every usable provider
                        // is gated (WAIT — the window resets, the task stays queued, the
                        // coordinator is not paged), never the actionable
                        // 'provider_priority_unusable' (slot configuration error).
                        markSkip(nodeId, resolved.reason || 'provider_unusable');
                        continue;
                    }
                    // Slot-derived model/thinking precedence (see resolveLaunchAxis):
                    // an EXPLICIT task.model/thinkingLevel always wins; a
                    // PRESET-stamped one yields to the difficulty-covering slot's
                    // own value; otherwise the slot fills what the task left blank.
                    const slotCoversDifficulty = slotCoversTaskDifficulty(resolved.slot, (task as any).difficulty);
                    const requestedModel = resolveLaunchAxis(task.model, (task as any).modelSource, resolved.model, slotCoversDifficulty);
                    const effectiveThinkingLevel = resolveLaunchAxis(task.thinkingLevel, (task as any).thinkingLevelSource, resolved.thinkingLevel, slotCoversDifficulty);

                    // SLOT MODEL GUARD: the requested model must be one this node's slots
                    // declare, so a difficulty→brain preset (difficult → 'opus') cannot launch
                    // a model the operator never configured. Three outcomes — run / wait
                    // (declared but at cap; stays queued, no page) / notify (never declared;
                    // pages the coordinator) — specified in slot-model-enforcement.ts.
                    //
                    // ★ PROVIDER PAIRING: scoped to resolved.providerType — the provider
                    // actually spawned below (launch_cli cliType). The guard supplies the MODEL
                    // half of the launch while `resolved` supplies the PROVIDER half, so an
                    // unscoped call let a foreign provider's slot answer for the model and broke
                    // the pair. See slot-model-enforcement.ts "PROVIDER PAIRING" for the full
                    // mechanism and the downstream damage (ledger resolvedModel → claim
                    // assignedModel → empty difficulty allowance → dropped per-slot cap).
                    const nodeSlotAvailability = () => resolveNodeCapabilitySlots(node, meshId).map(slot => ({
                        slot,
                        available: slotHasCapacity(meshId, nodeId, node, slot, mesh?.nodes, isReadonly),
                    }));
                    let effectiveProviderType = resolved.providerType;
                    let effectiveRequestedModel = requestedModel;
                    let effectiveWinningSlot = resolved.slot;
                    let slotDecision = decideSlotForModel({
                        requestedModel,
                        providerType: effectiveProviderType,
                        slots: nodeSlotAvailability(),
                    });
                    if (slotDecision.outcome === 'wait') {
                        // QUOTA-BUSY FALLBACK: the winner is quota-CLEAR but saturated.
                        // Ranking is recomputed from scratch every tick with no memory of
                        // "this was busy last tick", so without this the same saturated
                        // provider is re-elected indefinitely while an idle sibling slot on
                        // this very node is never tried. Walk the already-computed clear
                        // ranking instead of re-ranking (re-ranking reproduces the defect).
                        //
                        // Confined to 'wait' by construction: gated providers are absent from
                        // quotaClearOrder, and 'notify' is handled below, untouched. When the
                        // toggle is off — or no later candidate can run — this falls through
                        // to the original markSkip, byte-identical to the previous behaviour.
                        const fallback = resolveQuotaRoutingPolicy(mesh?.policy?.quotaRouting ?? null).quotaBusyFallback
                            ? selectQuotaBusyFallback({
                                clearOrder: resolved.quotaClearOrder ?? [],
                                candidates: resolved.quotaCandidates ?? [],
                                busyProviderType: resolved.providerType,
                                probe: candidate => decideSlotForModel({
                                    // Re-resolve the model against the CANDIDATE's own slot: the
                                    // requested model was derived from the busy winner's slot, and
                                    // carrying it over would ask the fallback provider to honour a
                                    // model it may never declare — the exact (provider, model)
                                    // pair-splitting slot-model-enforcement.ts forbids.
                                    requestedModel: resolveLaunchAxis(
                                        task.model,
                                        (task as any).modelSource,
                                        candidate.slot.model,
                                        slotCoversTaskDifficulty(candidate.slot, (task as any).difficulty),
                                    ),
                                    providerType: candidate.providerType,
                                    slots: nodeSlotAvailability(),
                                }).outcome === 'run',
                            })
                            : { outcome: 'exhausted' as const, skipped: [] };
                        if (fallback.outcome === 'fallback') {
                            const { candidate } = fallback;
                            LOG.info('MeshQueue', `QUOTA-BUSY FALLBACK: provider '${resolved.providerType}' on node ${nodeId} is quota-clear but saturated for model '${requestedModel}' (task ${task.id}); falling through to next quota-clear candidate '${candidate.providerType}'${fallback.skipped.length ? ` (also busy: ${fallback.skipped.join(', ')})` : ''}`);
                            effectiveProviderType = candidate.providerType;
                            effectiveWinningSlot = candidate.slot;
                            effectiveRequestedModel = resolveLaunchAxis(
                                task.model,
                                (task as any).modelSource,
                                candidate.slot.model,
                                slotCoversTaskDifficulty(candidate.slot, (task as any).difficulty),
                            );
                            slotDecision = decideSlotForModel({
                                requestedModel: effectiveRequestedModel,
                                providerType: effectiveProviderType,
                                slots: nodeSlotAvailability(),
                            });
                        }
                    }
                    if (slotDecision.outcome === 'wait') {
                        LOG.info('MeshQueue', `SLOT MODEL GUARD: model '${effectiveRequestedModel}' is declared on node ${nodeId} for provider '${effectiveProviderType}' but every matching slot is at its maxParallel cap (task ${task.id}); leaving the task queued until a slot goes idle`);
                        markSkip(nodeId, slotDecision.reason, { providerType: effectiveProviderType });
                        continue;
                    }
                    if (slotDecision.outcome === 'notify') {
                        LOG.warn('MeshQueue', `SLOT MODEL GUARD: no '${effectiveProviderType}' slot on node ${nodeId} declares model '${effectiveRequestedModel}' (declared: ${slotDecision.declaredModels.join(', ') || 'none'}) for task ${task.id}; not launching — surfacing to the coordinator to re-drive`);
                        markSkip(nodeId, slotDecision.reason, { providerType: effectiveProviderType });
                        continue;
                    }
                    const finalization = finalizeSlotSelection({
                        // The fallback-adjusted winning slot: when the quota-busy fallback
                        // moved the launch to a later candidate, the demotion bookkeeping
                        // must compare against THAT slot, not the abandoned busy one.
                        winningSlot: effectiveWinningSlot,
                        decidedSlot: slotDecision.slot,
                        decidedModel: slotDecision.model,
                        winningSlotHasCapacity: !!effectiveWinningSlot && slotHasCapacity(meshId, nodeId, node, effectiveWinningSlot, mesh?.nodes, isReadonly),
                    });
                    const rawEffectiveModel = finalization.model;
                    const demotionReason = finalization.demotionReason;

                    // CODEX-400 GUARD: the difficulty→brain presets (and MAGI slots) carry
                    // provider-agnostic Anthropic model aliases (opus/sonnet/haiku). Now that
                    // resolved.providerType is definitively known, drop the model if it is a
                    // Claude model but the provider is NOT Anthropic-backed (codex-cli /
                    // antigravity-cli / hermes-cli): forwarding `claude-*` as an initialModel
                    // makes those providers convert it to `-c model='claude-...'`, and a
                    // ChatGPT-account codex then rejects the launch with a 400. Stripping it
                    // lets the provider fall back to its own default model; the provider-neutral
                    // thinkingLevel axis is preserved. This is the single authoritative point
                    // that enforces the invariant across every model source (preset, slot,
                    // explicit) because both remote and local launch consume effectiveModel below.
                    const effectiveModel = isModelCompatibleWithProvider(rawEffectiveModel, effectiveProviderType)
                        ? rawEffectiveModel
                        : undefined;
                    if (rawEffectiveModel && effectiveModel === undefined) {
                        LOG.info('MeshQueue', `CODEX-400 GUARD: dropped incompatible launch model '${rawEffectiveModel}' for non-Anthropic provider '${effectiveProviderType}' on node ${nodeId} (task ${task.id}); provider will use its own default model`);
                    }

                    // LAUNCH-SIDE DIFFICULTY FLOOR PARITY (full rationale on the helper in
                    // mesh-difficulty-floor.ts): the FINAL (provider, model) must clear the
                    // claim side's own difficulty predicate before spawning, or the spawn is
                    // refused 'difficulty_floor_unmet' forever — the 2026-09-08 respawn runaway.
                    const floorMiss = launchSideDifficultyFloorMismatch(node, resolveNodeCapabilitySlots(node, meshId), effectiveProviderType, effectiveModel, task, nodeId);
                    if (floorMiss) { markSkip(nodeId, floorMiss, { providerType: effectiveProviderType }); continue; }

                    // Don't spawn a session for a (daemon, provider) already at its declared
                    // maxParallel cap — it would launch only to fail the claim. The claim
                    // transaction enforces the cap regardless; this just avoids a doomed launch.
                    // Counted over the daemon machine (sibling worktrees included), matching
                    // the claim-side scope so the two layers cannot disagree.
                    const providerCap = effectiveSlotCap(
                        resolveProviderMaxParallel(resolveNodeCapabilitySlots(node, meshId), effectiveProviderType),
                        isReadonly,
                    );
                    if (
                        providerCap !== undefined
                        && activeProviderAssignedCount(
                            meshId,
                            nodeId,
                            effectiveProviderType,
                            resolveDaemonSiblingNodeIds(nodeId, mesh?.nodes),
                        ) >= providerCap
                    ) {
                        markSkip(nodeId, 'max_provider_parallel_reached', { providerType: effectiveProviderType });
                        continue;
                    }

                    // Shared worker-launch envelope. For a local node it spawns directly on this
                    // daemon; for a remote node the identical command is forwarded to the node's
                    // daemon (mirrors mesh_launch_session), with the coordinator daemonId stamped
                    // so the worker's completion events route back to this coordinator.
                    const launchSettings: Record<string, unknown> = {
                        // Worker launch envelope: role + mesh context so worker can route completion events.
                        role: 'worker',
                        meshNodeFor: meshId,
                        meshNodeId: nodeId,
                        spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                        // Coordinator-dispatched worker: auto-approve unless mesh/node policy
                        // opts out (default true). Lands in settingsOverride and beats the
                        // global per-provider-type boolean/mode through explicit opposite-key clearing.
                        ...delegatedWorkerAutoApproveSettingsForNode(
                            mesh,
                            node,
                            components.providerLoader?.getMeta(effectiveProviderType),
                            effectiveProviderType,
                        ),
                        launchedByCoordinator: true,
                        autoLaunchedForQueueTaskId: task.id,
                    };

                    // Both post-ready paths must claim against the same selected slot/model contract.
                    const requiredTags = Array.isArray(task.requiredTags) ? task.requiredTags.filter((t): t is string => !!t) : [];
                    const buildRoutingDecision = () => buildAutoLaunchRoutingDecision({
                        node,
                        meshId,
                        task: { difficulty: (task as any).difficulty, requiredTags: task.requiredTags },
                        resolved: resolved as ResolvedProviderSelection & { providerType: string; slot: NodeCapabilitySlot },
                        quotaRouting: mesh?.policy?.quotaRouting ?? null,
                        quotaFactsContext: quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader),
                        skippedCandidates,
                        requiredTagsResult: {
                            required: requiredTags,
                            satisfied: !requiredTags.length || nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node, effectiveProviderType)),
                            missing: requiredTags.filter(t => !buildMeshNodeCapabilityTags(node, effectiveProviderType).includes(t)),
                        },
                        effectiveModel,
                        effectiveThinkingLevel,
                        executedSlot: slotDecision.slot,
                        demotionReason,
                    });

                    if (launchTarget.mode === 'remote') {
                        // Relay-safe completion routing: stamp the coordinator anchor the same way
                        // mesh_launch_session does so the worker forwards events back to this daemon.
                        const remoteSettings: Record<string, unknown> = {
                            ...launchSettings,
                            meshCoordinatorDaemonId: launchTarget.coordinatorDaemonId,
                            meshCoordinatorNodeId: nodeId,
                        };
                        markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: effectiveProviderType, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                        let launchResult: any;
                        try {
                            // OFFLINE-NODE-BLOCKING: no peer-connected pre-check before this remote
                            // launch_cli meant an OFFLINE target node sank the dispatch into the 90s
                            // connect deadline, stalling the 4s auto-launch loop for a full 90s. Stamp
                            // the status-origin marker so the daemon-cloud relay grants the SHORT
                            // connect-wait budget — an offline node throws in ~2s, the catch below sets
                            // the 25s cooldown (autoLaunchCooldownUntil) that already gates retries, so
                            // the loop moves on. The marker only affects the connect wait and is
                            // stripped before launch_cli executes, so a live node spawns identically.
                            launchResult = await components.dispatchMeshCommand!(launchTarget.daemonId!, 'launch_cli', withStatusProbeMarker({
                                cliType: effectiveProviderType,
                                dir: node.workspace,
                                settings: remoteSettings,
                                // MAGI-KIND-PANEL model axis: forward the task's model override so the
                                // remote worker session launches with it (initialModel). Best-effort.
                                // Slot-aware: task override wins, else the matched slot's model.
                                ...(effectiveModel ? { initialModel: effectiveModel } : {}),
                                // BRAIN-ROUTING thinking axis: forward the effective thinking level (initialThinkingLevel).
                                ...(effectiveThinkingLevel ? { initialThinkingLevel: effectiveThinkingLevel } : {}),
                            }));
                        } catch (e: any) {
                            markAutoLaunch(meshId, task.id, { status: 'failed', reason: `remote_launch_dispatch_failed: ${e?.message || String(e)}`, nodeId, providerType: effectiveProviderType });
                            autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                            return false;
                        }
                        const payload = (launchResult && typeof launchResult === 'object' && 'payload' in launchResult && launchResult.payload && typeof launchResult.payload === 'object')
                            ? launchResult.payload
                            : launchResult;
                        if (!payload?.success) {
                            const reason = readNonEmptyString(payload?.error) || 'remote_launch_cli_failed';
                            markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: effectiveProviderType });
                            autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                            return false;
                        }
                        // Remote launch is async: the worker session will register and emit agent:ready,
                        // which (forwarded back here) drives the claim via the normal event path / PHASE 1
                        // reconcile. Set a cooldown so the 4s loop doesn't re-launch before that lands.
                        const remoteSessionId = readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.id) || readNonEmptyString(payload.runtimeSessionId);
                        markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: effectiveProviderType, sessionId: remoteSessionId || undefined, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                        logAutoLaunchQuotaFallbackSuccess(resolved, task.id, nodeId, remoteSessionId || undefined);
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        // REMOTE-READY-WAIT: readiness barrier, symmetric with the local path's
                        // waitForLocalSessionReady below and on the same 15s budget. The remote
                        // worker's agent:ready is ALREADY forwarded here (it lands as a
                        // remote-idle row); this awaits it instead of returning the instant
                        // launch_cli resolves. On timeout we proceed exactly as before, so the
                        // worst case is today's behavior — what it buys is not starting the
                        // 25-40s delivered_not_consumed judgement clock against a session that
                        // is not yet interactive, which for the five emitsPtyTurnEvents:false
                        // providers has no other way to prove it is alive.
                        //
                        // The cooldown is set BEFORE the await on purpose: it must gate the 4s
                        // loop for the whole wait, not only after it. (The per-node and per-task
                        // autoLaunch in-progress locks are released in `finally` blocks that sit
                        // outside this branch, so they cover the whole wait regardless.)
                        //
                        // Swallowed by construction: this branch runs inside the launch try/catch,
                        // whose catch marks the auto-launch FAILED. A readiness barrier must never
                        // be able to turn a launch that genuinely succeeded into a recorded failure.
                        if (remoteSessionId) {
                            await waitForRemoteSessionReady(meshId, nodeId, remoteSessionId, {
                                isReady: remoteSessionReadyProbe(meshId, nodeId, remoteSessionId),
                            }).catch(() => false);
                            // Without the selected model, a remote session was judged against the
                            // provider-slot intersection and could refuse `difficulty_floor_unmet`
                            // despite the preview-selected slot having headroom.
                            const routingDecision = buildRoutingDecision();
                            claimAfterRemoteAutoLaunch(components, meshId, nodeId, remoteSessionId, effectiveProviderType,
                                (c, m, n, s, p) => tryAssignQueueTask(c, m, n, s, p, routingDecision, undefined, 'auto_launch'));
                        }
                        return true;
                    }

                    markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: effectiveProviderType, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                    const launchResult: any = await components.cliManager.handleCliCommand('launch_cli', {
                        cliType: effectiveProviderType,
                        dir: node.workspace,
                        settings: launchSettings,
                        // MAGI-KIND-PANEL model axis: local launch forwards the effective model
                        // (task override, else matched slot) as initialModel (CLI → modelLaunchArgs; ACP → setConfigOption).
                        ...(effectiveModel ? { initialModel: effectiveModel } : {}),
                        // BRAIN-ROUTING thinking axis: forward the effective thinking level (initialThinkingLevel).
                        ...(effectiveThinkingLevel ? { initialThinkingLevel: effectiveThinkingLevel } : {}),
                    });
                    if (!launchResult?.success) {
                        const reason = launchResult?.error || 'launch_cli_failed';
                        markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: effectiveProviderType });
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return false;
                    }
                    const sessionId = readNonEmptyString(launchResult.sessionId) || readNonEmptyString(launchResult.id) || readNonEmptyString(launchResult.runtimeSessionId);
                    if (!sessionId) {
                        markAutoLaunch(meshId, task.id, { status: 'failed', reason: 'launch_missing_session_id', nodeId, providerType: effectiveProviderType });
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return false;
                    }
                    markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: effectiveProviderType, sessionId, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                    logAutoLaunchQuotaFallbackSuccess(resolved, task.id, nodeId, sessionId);
                    // Readiness barrier: a freshly-spawned local CLI session is NOT yet
                    // interactive — its PTY prints the input prompt (and the adapter flips
                    // isReady()) only ~2-6s after launch. Dispatching the task immediately
                    // pushes the first (often large) message into a not-yet-ready PTY, which
                    // could throw "not ready" and bounce the task through requeue (on win32
                    // this raced the auto-launch cooldown and stranded the worker idle).
                    // Await interactive readiness before claiming/dispatching so the very
                    // first message lands cleanly. The adapter's queue-until-ready path is the
                    // backstop if readiness is reported late; this just avoids the churn.
                    await waitForLocalSessionReady(components, sessionId);
                    const routingDecision = buildRoutingDecision();
                    tryAssignQueueTask(components, meshId, nodeId, sessionId, effectiveProviderType, routingDecision, undefined, 'auto_launch');
                    return true;
                } catch (e: any) {
                    markAutoLaunch(meshId, task.id, { status: 'failed', error: e?.message || String(e), nodeId });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                    return false;
                } finally {
                    autoLaunchInProgress.delete(launchKey);
                }
            }
        } finally {
            // Every exit path: fallthrough, `continue`, `return`, and any throw from the
            // awaited provider resolution / launch dispatch. A leak wedges the task forever.
            autoLaunchTaskInProgress.delete(taskLaunchKey);
        }
    }
    return false;
}
