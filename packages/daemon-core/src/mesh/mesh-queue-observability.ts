import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import {
    PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON,
    type ProviderQuotaGateBlock,
} from './mesh-quota-routing.js';

export interface QuotaClaimGateContext {
    /** What triggered this claim evaluation — e.g. 'idle_claim_scan', 'auto_launch', 'direct_dispatch'. */
    trigger?: string;
    /** The id of the queued task this session was trying to claim, when known. */
    candidateTaskId?: string;
    /** True when the provider was pinned by requiredTags and the gate was overridden to let the claim proceed. */
    pinOverride?: boolean;
}

export interface QuotaClaimGateObservation {
    nodeId: string;
    sessionId: string;
    providerType: string;
    block: ProviderQuotaGateBlock;
    context?: QuotaClaimGateContext;
}

export interface QuotaClaimDrainTrace {
    blocked: QuotaClaimGateObservation[];
    evaluated: number;
    clear: number;
}

export type QuotaClaimGatePhase = 'blocked' | 'cleared' | 'overridden_by_pin';

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

export function logQuotaClaimBlockTransition(
    meshId: string,
    observation: QuotaClaimGateObservation,
    phase: QuotaClaimGatePhase = 'blocked',
): void {
    const key = quotaClaimBlockKey(meshId, observation);
    // Include the phase in the fingerprint so a transition from blocked → overridden_by_pin
    // (or back) is recorded as a distinct event, not swallowed by the unchanged-fingerprint guard.
    const fingerprint = `${phase}:${observation.block.reason}:${observation.block.window}:${observation.block.remainingPercent}:${observation.block.thresholdPercent}`;
    if (lastQuotaClaimBlockLog.get(key) === fingerprint) return;
    const wasBlocked = lastQuotaClaimBlockLog.has(key);
    rememberBounded(lastQuotaClaimBlockLog, key, fingerprint);

    const overrideNote = phase === 'overridden_by_pin'
        ? ' (provider pinned by requiredTags — gate overridden to honor the pin)'
        : '';
    LOG.info('MeshQueue', `QUOTA GATE: ${phase === 'overridden_by_pin' ? 'allowing' : 'deferring'} queue claim for node ${observation.nodeId} (${observation.sessionId}): ${quotaClaimBlockDescription(observation.providerType, observation.block)}${overrideNote}${phase === 'blocked' ? ' — trying remaining provider candidates; the task stays pending only if none can claim' : ''}`);
    // QUOTA-CLAIM-GATE-LEDGER: record only the transition INTO a phase (or a changed block
    // reason/window while already in that phase), never a steady-state repeat — mirrors the log
    // fingerprint above exactly so the ledger and the log agree on what counts as "new".
    // Without this, a provider pinned via requiredTags (the MAGI kind-panel case — no
    // fallback candidate to escape to) that goes quota-exhausted leaves NO ledger trace at
    // all while its replica parks pending indefinitely.
    try {
        const payload: Record<string, unknown> = {
            phase,
            nodeId: observation.nodeId,
            sessionId: observation.sessionId,
            providerType: observation.providerType,
            reason: observation.block.reason,
            window: observation.block.window,
            remainingPercent: observation.block.remainingPercent,
            thresholdPercent: observation.block.thresholdPercent,
            previouslyBlocked: wasBlocked,
        };
        if (observation.context?.trigger) {
            payload.trigger = observation.context.trigger;
        }
        if (observation.context?.candidateTaskId) {
            payload.candidateTaskId = observation.context.candidateTaskId;
        }
        if (observation.context?.pinOverride) {
            payload.pinOverride = true;
        }
        appendLedgerEntry(meshId, {
            kind: 'quota_claim_gate',
            nodeId: observation.nodeId,
            sessionId: observation.sessionId,
            providerType: observation.providerType,
            payload,
        });
    } catch { /* best-effort: diagnostics must never break the claim path */ }
}

export function clearQuotaClaimBlockState(meshId: string, nodeId: string, sessionId: string, providerType: string): void {
    const key = quotaClaimBlockKey(meshId, { nodeId, sessionId, providerType });
    // Only record a 'cleared' transition when this key was actually blocked before — a
    // never-blocked (node, session, provider) clearing on every ordinary claim would flood
    // the ledger with a 'cleared' entry per successful claim, which is the exact steady-state
    // noise this dedup discipline exists to avoid.
    if (lastQuotaClaimBlockLog.has(key)) {
        try {
            appendLedgerEntry(meshId, {
                kind: 'quota_claim_gate',
                nodeId,
                sessionId,
                providerType,
                payload: { phase: 'cleared', nodeId, sessionId, providerType },
            });
        } catch { /* best-effort: diagnostics must never break the claim path */ }
    }
    lastQuotaClaimBlockLog.delete(key);
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

// WORKTREE-BOOTSTRAP-STALE-BYPASS spam guard. tryAssignQueueTask's stale-backstop
// bypass lets the claim through while warning — but when the task is then refused
// downstream, the next ~4s drain tick re-enters the same gate (the bootstrap status
// still reads 'running' because the terminal-state stamp never reached this daemon's
// view) and warns AGAIN: 1,130 duplicate two-line warnings in a single day for one
// node (2026-08-21), three 5MB rotations deep, which pushed the coordinator boot
// window out of the logs entirely. Same transition-dedup discipline as the quota
// gate and claim-refusal above: warn once per (mesh, node, session); the caller
// clears the fingerprint the moment the gate observes a non-'running' bootstrap
// status, so a genuinely NEW stuck episode warns again.
const lastWorktreeBootstrapBypassLog = new Map<string, string>();

export function logWorktreeBootstrapStaleBypass(meshId: string, nodeId: string, sessionId: string): void {
    const key = `${meshId}:${nodeId}:${sessionId}`;
    if (lastWorktreeBootstrapBypassLog.has(key)) return;
    rememberBounded(lastWorktreeBootstrapBypassLog, key, 'bypassed');
    LOG.warn('MeshQueue', `Worktree node ${nodeId} (${sessionId}) bootstrap stuck 'running' beyond the stale backstop and its worktree is git-clean — treating bootstrap as silently complete and allowing the claim (the terminal-state stamp likely never reached this daemon's mesh view)`);
}

/** Clears the dedup fingerprint when the node's bootstrap leaves 'running' (the
 *  terminal-state stamp finally landed), so a later re-entry into the stuck state
 *  is reported as the new episode it is. */
export function clearWorktreeBootstrapStaleBypassState(meshId: string, nodeId: string, sessionId: string): void {
    lastWorktreeBootstrapBypassLog.delete(`${meshId}:${nodeId}:${sessionId}`);
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
