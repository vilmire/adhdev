import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import {
    PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON,
    type ProviderQuotaGateBlock,
} from './mesh-quota-routing.js';

export interface QuotaClaimGateObservation {
    nodeId: string;
    sessionId: string;
    providerType: string;
    block: ProviderQuotaGateBlock;
}

export interface QuotaClaimDrainTrace {
    blocked: QuotaClaimGateObservation[];
    evaluated: number;
    clear: number;
}

// Claim reconciliation runs every few seconds. Keep the existing per-candidate gate
// diagnostic, but emit it only when that candidate's gate verdict changes instead of
// repeating the same line on every poll. A clear verdict deletes the fingerprint so a
// later genuine re-entry into the gate is observable again.
const lastQuotaClaimBlockLog = new Map<string, string>();
const lastAllQuotaClaimBlockedLog = new Map<string, string>();

function quotaClaimBlockKey(meshId: string, observation: Pick<QuotaClaimGateObservation, 'nodeId' | 'sessionId' | 'providerType'>): string {
    return `${meshId}:${observation.nodeId}:${observation.sessionId}:${observation.providerType}`;
}

function quotaClaimBlockDescription(providerType: string, block: ProviderQuotaGateBlock): string {
    if (block.reason === PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON) {
        return `provider '${providerType}' reported quota exhausted`;
    }
    return `provider '${providerType}' had ${block.remainingPercent.toFixed(1)}% ${block.window} quota remaining (< ${block.thresholdPercent}% threshold)`;
}

function rememberBounded(map: Map<string, string>, key: string, value: string): void {
    map.set(key, value);
    if (map.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
    }
}

export function logQuotaClaimBlockTransition(meshId: string, observation: QuotaClaimGateObservation): void {
    const key = quotaClaimBlockKey(meshId, observation);
    const fingerprint = `${observation.block.reason}:${observation.block.window}:${observation.block.remainingPercent}:${observation.block.thresholdPercent}`;
    if (lastQuotaClaimBlockLog.get(key) === fingerprint) return;
    rememberBounded(lastQuotaClaimBlockLog, key, fingerprint);
    LOG.info('MeshQueue', `QUOTA GATE: deferring queue claim for node ${observation.nodeId} (${observation.sessionId}): ${quotaClaimBlockDescription(observation.providerType, observation.block)} — trying remaining provider candidates; the task stays pending only if none can claim`);
}

export function clearQuotaClaimBlockState(meshId: string, nodeId: string, sessionId: string, providerType: string): void {
    lastQuotaClaimBlockLog.delete(quotaClaimBlockKey(meshId, { nodeId, sessionId, providerType }));
}

export function logQuotaClaimFallbackSuccess(
    blocked: QuotaClaimGateObservation[],
    taskId: string,
    winner: { nodeId: string; sessionId: string; providerType: string },
): void {
    if (!blocked.length) return;
    const detail = blocked.map(item => quotaClaimBlockDescription(item.providerType, item.block)).join('; ');
    LOG.info('MeshQueue', `QUOTA GATE: queue claim fallback succeeded for task ${taskId}: ${detail} → provider '${winner.providerType}' claimed on node ${winner.nodeId} (${winner.sessionId})`);
}

export function logAllQuotaClaimCandidatesBlocked(meshId: string, trace: QuotaClaimDrainTrace, pendingTaskIds: string[]): void {
    if (!trace.blocked.length || trace.clear > 0 || trace.blocked.length !== trace.evaluated) return;
    const detail = trace.blocked.map(item => `${item.nodeId}/${quotaClaimBlockDescription(item.providerType, item.block)}`).join('; ');
    const fingerprint = `${pendingTaskIds.slice().sort().join(',')}|${detail}`;
    if (lastAllQuotaClaimBlockedLog.get(meshId) === fingerprint) return;
    rememberBounded(lastAllQuotaClaimBlockedLog, meshId, fingerprint);
    LOG.info('MeshQueue', `QUOTA GATE: every idle provider candidate was quota-gated for mesh ${meshId} (${detail}); task(s) ${pendingTaskIds.join(', ') || 'pending'} remain queued until a quota window resets`);
}

export function clearAllQuotaClaimCandidatesBlockedState(meshId: string): void {
    lastAllQuotaClaimBlockedLog.delete(meshId);
}

// A6-SILENT-REFUSAL. `tryAssignQueueTask`'s `if (!task) return false` swallowed every
// store-level claim gate — nine predicates plus two pre-checks — with no log, no ledger
// entry and no reason. A task that could never claim was indistinguishable from one with
// simply no work waiting, which is what turned a one-line auto-ff deferral into hours of
// misdiagnosis. This surfaces the gate that actually said no.
//
// Same transition-dedup discipline as the quota gate above: the reconcile loop re-runs the
// claim every ~4s, so an unchanged (task, gate) verdict must not repeat. A CHANGED reason
// (or a later successful claim, via clearClaimRefusalState) logs again, so real transitions
// stay observable. `no_pending_candidates` is the ordinary idle case and is never reported.
const lastClaimRefusalLog = new Map<string, string>();

function claimRefusalKey(meshId: string, nodeId: string, sessionId: string): string {
    return `${meshId}:${nodeId}:${sessionId}`;
}

export function recordClaimRefusal(meshId: string, args: {
    nodeId: string;
    sessionId: string;
    providerType?: string;
    reason: string;
    detail?: string;
}): void {
    // The empty-queue case is not a refusal — reporting it would fire on every idle tick.
    if (!args.reason || args.reason === 'no_pending_candidates') {
        clearClaimRefusalState(meshId, args.nodeId, args.sessionId);
        return;
    }
    const key = claimRefusalKey(meshId, args.nodeId, args.sessionId);
    const fingerprint = `${args.reason}|${args.detail || ''}`;
    if (lastClaimRefusalLog.get(key) === fingerprint) return;
    rememberBounded(lastClaimRefusalLog, key, fingerprint);
    LOG.info('MeshQueue', `CLAIM REFUSED on node ${args.nodeId} (${args.sessionId}${args.providerType ? `, ${args.providerType}` : ''}) for mesh ${meshId}: ${args.reason}${args.detail ? ` — ${args.detail}` : ''}`);
    try {
        appendLedgerEntry(meshId, {
            kind: 'claim_refused',
            nodeId: args.nodeId,
            sessionId: args.sessionId,
            ...(args.providerType ? { providerType: args.providerType } : {}),
            payload: {
                reason: args.reason,
                ...(args.detail ? { detail: args.detail } : {}),
            },
        });
    } catch { /* best-effort: diagnostics must never break the claim path */ }
}

/** A successful claim clears the fingerprint so a later genuine re-entry into the same
 *  gate is reported again instead of being suppressed by a stale verdict. */
export function clearClaimRefusalState(meshId: string, nodeId: string, sessionId: string): void {
    lastClaimRefusalLog.delete(claimRefusalKey(meshId, nodeId, sessionId));
}

export function logAutoLaunchQuotaFallbackSuccess(
    resolved: { providerType?: string; quotaGated?: Array<{ providerType: string; block: ProviderQuotaGateBlock }> },
    taskId: string,
    nodeId: string,
    sessionId?: string,
): void {
    if (!resolved.providerType || !resolved.quotaGated?.length) return;
    const detail = resolved.quotaGated.map(item => quotaClaimBlockDescription(item.providerType, item.block)).join('; ');
    LOG.info('MeshQueue', `QUOTA GATE: auto-launch fallback succeeded for task ${taskId} on node ${nodeId}: ${detail} → spawned provider '${resolved.providerType}'${sessionId ? ` (${sessionId})` : ''}`);
}

// De-dup for repeated `skipped` ledger noise: the reconcile loop re-runs the queue
// trigger every 4s, so a task that can't be claimed (e.g. a remote node with no
// transport, or a node under cooldown) would otherwise append an identical
// session_auto_launch{phase:'skipped'} entry on every tick — flooding the ledger.
// We suppress a `skipped` ledger append when the immediately-prior recorded event
// for that task was the SAME (phase, reason). Any non-skip phase (started/failed/
// completed) or a changed reason resets the de-dup so real transitions still record.
const lastAutoLaunchLedgerKey = new Map<string, string>();
/** @internal Split-visibility only: mesh-skip-notify bounds its own notify de-dup map by
 *  the same cap. Not part of this module's public surface — no consumer outside
 *  src/mesh imports it, and neither re-export barrel lists it. */
export const AUTO_LAUNCH_LEDGER_DEDUP_MAX = 2000;

export function recordAutoLaunchEvent(meshId: string, args: {
    phase: 'skipped' | 'started' | 'failed' | 'completed';
    taskId: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    reason?: string;
    error?: string;
    // LEDGER-TASK-TRACEABILITY (D): the resolved execution profile the auto-launch
    // resolved for this worker, so session_auto_launch records what model/thinking the
    // spawned worker actually launched with (not just the provider).
    model?: string;
    thinkingLevel?: string;
}) {
    // Suppress consecutive identical `skipped` entries for the same task (4s reconcile
    // re-trigger noise). Non-skip phases and changed reasons always record and reset
    // the de-dup so genuine state transitions remain visible in the ledger.
    const dedupKey = `${meshId}:${args.taskId}`;
    const currentSig = `${args.phase}|${args.reason || ''}`;
    if (args.phase === 'skipped' && lastAutoLaunchLedgerKey.get(dedupKey) === currentSig) {
        return;
    }
    lastAutoLaunchLedgerKey.set(dedupKey, currentSig);
    if (lastAutoLaunchLedgerKey.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
        // Bound memory: drop the oldest insertion (Map preserves insertion order).
        const oldest = lastAutoLaunchLedgerKey.keys().next().value;
        if (oldest !== undefined) lastAutoLaunchLedgerKey.delete(oldest);
    }
    try {
        appendLedgerEntry(meshId, {
            kind: 'session_auto_launch',
            nodeId: args.nodeId,
            sessionId: args.sessionId,
            providerType: args.providerType,
            // (B) promote taskId so this entry joins the task lifecycle timeline.
            ...(args.taskId ? { taskId: args.taskId } : {}),
            payload: {
                phase: args.phase,
                taskId: args.taskId,
                reason: args.reason,
                error: args.error,
                // (D) resolved execution profile for the spawned worker.
                ...(args.model ? { resolvedModel: args.model } : {}),
                ...(args.thinkingLevel ? { resolvedThinkingLevel: args.thinkingLevel } : {}),
            },
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to record auto-launch ledger event: ${e?.message || e}`);
    }
}
