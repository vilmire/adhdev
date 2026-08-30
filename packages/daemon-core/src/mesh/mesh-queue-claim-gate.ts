import type { ProviderLoader } from '../providers/provider-loader.js';
import { evaluateProviderQuotaGate, quotaFactsContextForLiveRouting } from './mesh-quota-routing.js';
import { clearQuotaClaimBlockState, logQuotaClaimBlockTransition, type QuotaClaimDrainTrace } from './mesh-queue-observability.js';
import { getQueue } from './mesh-work-queue.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';

/**
 * PIN OVERRIDE: when a pending task is explicitly pinned to this provider via
 * requiredTags (e.g. provider=codex-cli), the pin is authoritative: the claim
 * proceeds and the ledger records 'overridden_by_pin' instead of 'blocked', so
 * an operator can later see "the gate was low but the pin was honored". The
 * candidate task id is included in the ledger context to distinguish this from
 * an idle-session scan blocked on some other task.
 */
export function providerPinOverrideCandidateTaskId(meshId: string, providerType: string): string | undefined {
    const pending = getQueue(meshId, { status: ['pending'] });
    for (const task of pending) {
        const tags = task.requiredTags ?? [];
        if (tags.includes(`provider=${providerType}`)) {
            return task.id;
        }
    }
    return undefined;
}

/**
 * QUOTA GATE (claim path): the same evaluateProviderQuotaGate the auto-launch
 * loop applies before SPAWNING a session also gates an idle session's CLAIM —
 * otherwise an idle session on a quota-exhausted node would pull the pending
 * task the launch gate deliberately left queued. Same WAIT semantics: the
 * window resets, so the block is not actionable — the task stays pending
 * (caller returns false without touching its status) and the drain simply
 * moves on to the next candidate / re-fires on the next tick. Reads only the
 * in-memory nodeFacts bundle or same-daemon clone source (synchronous; never
 * triggers a quota fetch). Missing/stale/unmarked non-'ok' snapshots fail OPEN
 * exactly as in the launch path; fresh last-good windows remain measurable.
 * Log-only like the caller's lease defer — no ledger entry, so a repeatedly
 * gated claim does not flood the ledger every drain tick.
 *
 * Returns true when the caller must refuse the claim (return false without
 * touching task status); false when the claim may proceed — including a
 * pin-overridden block, which is logged as 'overridden_by_pin' before this
 * returns false.
 */
export function evaluateQuotaClaimGateForAssignment(args: {
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
    /** Model of the slot selected for this claim, when the launch path has it.
     * Absent idle/legacy sessions retain the provider headline gate. */
    model?: string;
    trigger: string;
    node: any;
    mesh: any;
    providerLoader: ProviderLoader;
    quotaClaimTrace?: QuotaClaimDrainTrace;
}): boolean {
    const { meshId, nodeId, sessionId, providerType, model, trigger, node, mesh, providerLoader, quotaClaimTrace } = args;
    const pinCandidateTaskId = providerPinOverrideCandidateTaskId(meshId, providerType);
    const isPinOverride = !!pinCandidateTaskId;
    const quotaClaimBlock = evaluateProviderQuotaGate(
        node,
        providerType,
        mesh?.policy?.quotaRouting ?? null,
        Date.now(),
        quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, providerLoader),
        { model },
    );
    if (quotaClaimTrace) quotaClaimTrace.evaluated += 1;
    if (quotaClaimBlock) {
        const observation = {
            nodeId,
            sessionId,
            providerType,
            block: quotaClaimBlock,
            context: { trigger, candidateTaskId: pinCandidateTaskId, pinOverride: isPinOverride },
        };
        if (isPinOverride) {
            logQuotaClaimBlockTransition(meshId, observation, 'overridden_by_pin');
            return false;
        }
        logQuotaClaimBlockTransition(meshId, observation, 'blocked');
        quotaClaimTrace?.blocked.push(observation);
        return true;
    }
    clearQuotaClaimBlockState(meshId, nodeId, sessionId, providerType);
    if (quotaClaimTrace) quotaClaimTrace.clear += 1;
    return false;
}
