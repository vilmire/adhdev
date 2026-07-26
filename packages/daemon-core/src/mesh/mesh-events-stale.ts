import { appendLedgerEntry, buildTaskCompletionEvidence, readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerKind } from './mesh-ledger.js';
import { updateDirectDispatchStatus, cleanupTerminalDirectDispatches } from './mesh-work-queue.js';
import { markSessionDeliveriesTerminal } from './mesh-delivery-policy.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { readNonEmptyString, readRecord, resolveEventSessionId, readWorkerResultMetadata, isWeakCompletionEvidence, buildMeshSystemMessage } from './mesh-events-utils.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { LOG } from '../logging/logger.js';
import { meshNodeIdMatches, sessionIdsEquivalent, type MeshNodeIdentified } from '@adhdev/mesh-shared';

// EARLYNOTIFY-GATEBYPASS (d): every completed-emit producer that bypasses the CLI-provider
// completion gate (transcript-reconcile synth here, no-progress reconcile below, the fast-collapse
// synth in cli-provider-instance) records a completion-gate trace so a synthesized "completed and
// idle" emit can never again be silent. Content-free by construction — keyed by taskId + source
// only, never worker/screen text. completion-gate is an ALWAYS_ON_TRACE_CATEGORY, so recordDebugTrace
// self-gates and lands in the ring even on a production daemon.
function recordSynthCompletionGateTrace(stage: string, payload: Record<string, unknown>): void {
    recordDebugTrace({ category: 'completion-gate', stage, level: 'debug', payload });
}

// ---------------------------------------------------------------------------
// Stale direct-dispatch detection & transcript reconciliation
// ---------------------------------------------------------------------------

// NOTIF-MISS grace gate. A direct dispatch (mesh_send_task) to an ALREADY-IDLE,
// previously-used session reuses a transcript that still holds the PRIOR turn's final
// assistant message. The session momentarily reads `idle` in the first second after
// dispatch (the worker hasn't started generating yet), so the transcript reconcile here
// would otherwise synthesize a "completion" ~1s after dispatch from that stale tail —
// writing a synthesized task_completed + queuing a completion event. When the REAL
// completion fires minutes later, checkSuppressMeshEvent drops it as a duplicate of the
// synthesized one (same providerSessionId/finalSummary), so the coordinator never learns
// the task actually finished. The grace period refuses to synthesize until enough time has
// passed since dispatch that a genuine same-task completion is plausible, closing the race
// window. The stale-summary timestamp guard (transcript predates dispatch) and FIX 2 in
// mesh-event-forwarding (a synthesized completion never suppresses the authoritative real
// one) are the correctness backstops; this grace just stops the synthesis from firing in
// the first place for the common case. An idle-session dispatch (dispatchedToIdleSession)
// is the exact race above, so it gets a LONGER grace than a dispatch to a session that was
// already generating (where a transcript reconcile is far less likely to be premature).
const DIRECT_DISPATCH_RECONCILE_GRACE_MS = 60_000;
const DIRECT_DISPATCH_IDLE_SESSION_RECONCILE_GRACE_MS = 120_000;

// ---------------------------------------------------------------------------
// MID-TURN-CAUSAL-ADMISSION (rc.16 unified completion ingress)
// ---------------------------------------------------------------------------
// Verified incidents: the coordinator received a WEAK synthesized completion mid-turn —
// after an interim narration bubble ("Let me find…") — while the worker's raw PTY still
// showed `Working (43s)` and further tool calls continued. Every transcript-synth ingress
// (reconcile-loop PHASE 4, the assigned-stranded watchdog's transcript propagation, the MCP
// mesh_status poll) funnels through reconcileDirectDispatchCompletionFromTranscript, which
// queues the coordinator completion DIRECTLY — bypassing the injectMeshSystemMessage →
// evaluateMeshEventSuppression → hasLiveTurnPendingEvidence gate (3a48f660) that protects
// the native provider-event path. evaluateTranscriptSynthAdmission is the ONE reusable
// causal admission point closing that bypass: every synth caller passes its causal evidence
// through the `causalAdmission` arg and the choke point enforces it uniformly.
export interface TranscriptSynthCausalAdmission {
    /**
     * Synchronous re-check of a resolvable LOCAL live instance's CURRENT turn state — the
     * same hasLiveTurnPendingEvidence() discriminator the 3a48f660 mid-turn gate uses on the
     * native-event path. A pending verdict VETOES an eager transcript synth. Fail-open by
     * construction: absent (remote/unknown session, separate-process caller), not a function,
     * or throwing → no veto; the caller's bounded transcript evidence/settle behavior remains
     * the operative net, so a missing transcript source never wedges.
     */
    liveTurnPendingEvidence?: () => boolean;
    /**
     * The caller is a BOUNDED last-resort backstop firing at its max-wait (the acked-hold
     * death deadline, the delivered-no-turn redrive deadline). A bounded backstop overrides
     * the live-pending veto — preserving the genuine-final fail-open / max-wait semantics —
     * but NEVER overrides the trailing-tool veto (a stale weak interim summary must not
     * become final merely because a timeout fired while newer transcript/tool activity
     * exists).
     */
    boundedBackstop?: boolean;
    /**
     * The caller's transcript read shows tool/terminal activity AFTER the latest final-looking
     * assistant bubble (hasTrailingToolActivityAfterFinalAssistant) — the bubble is interim
     * narration ("Let me explore…"), the turn is still executing. Absolute veto: the worker is
     * demonstrably alive and mid-turn, so even a bounded backstop keeps holding (the hold is
     * still released by the session-death read-failure backstop and the stranded-reclaim /
     * orphan-prune nets, so this cannot wedge forever).
     */
    trailingToolActivityAfterFinalAssistant?: boolean;
}

export type TranscriptSynthAdmissionVerdict =
    | { admitted: true }
    | { admitted: false; reason: 'live_turn_pending_evidence' | 'trailing_tool_activity_after_final_assistant' };

export function evaluateTranscriptSynthAdmission(admission?: TranscriptSynthCausalAdmission): TranscriptSynthAdmissionVerdict {
    if (!admission) return { admitted: true };
    if (admission.trailingToolActivityAfterFinalAssistant === true) {
        return { admitted: false, reason: 'trailing_tool_activity_after_final_assistant' };
    }
    if (!admission.boundedBackstop && typeof admission.liveTurnPendingEvidence === 'function') {
        let pending = false;
        try { pending = admission.liveTurnPendingEvidence() === true; } catch { /* fail open — never block on a diagnostic throw */ }
        if (pending) return { admitted: false, reason: 'live_turn_pending_evidence' };
    }
    return { admitted: true };
}

/**
 * Resolve the liveTurnPendingEvidence probe for `sessionId` from a components-shaped object
 * (anything exposing instanceManager.getInstance). Returns undefined when no live instance
 * resolves or the instance does not expose hasLiveTurnPendingEvidence — the fail-open
 * remote/unknown case. Shared by every transcript-synth caller so the probe is resolved ONE
 * way (UNIFY: same discriminator as the 3a48f660 native-event gate).
 */
export function resolveLiveTurnPendingEvidence(
    components: { instanceManager?: { getInstance?: (sessionId: string) => unknown } } | undefined,
    sessionId: string,
): (() => boolean) | undefined {
    try {
        const instance = components?.instanceManager?.getInstance?.(sessionId) as
            { hasLiveTurnPendingEvidence?: () => boolean } | undefined;
        if (typeof instance?.hasLiveTurnPendingEvidence !== 'function') return undefined;
        const probe = instance.hasLiveTurnPendingEvidence.bind(instance);
        return () => probe();
    } catch {
        return undefined; // resolution itself failed → fail open
    }
}

export function findRecentTerminalLedgerEvidence(args: {
    meshId: string;
    sessionId?: string;
    nodeId?: string;
}): { id: string; kind: MeshLedgerKind; payload: Record<string, unknown>; timestamp: string } | null {
    if (!args.sessionId && !args.nodeId) return null;
    // Tail-limit: 200 entries gives a wide enough window to catch terminal events for active
    // sessions while avoiding a full O(n) scan. If a terminal is older than 200 entries,
    // the MeshRuntimeStore fingerprint dedup will still block duplicate processing downstream.
    const entries = readLedgerEntries(args.meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') continue;
        if (args.sessionId && sessionIdsEquivalent(entry.sessionId, args.sessionId)) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
        // Normalized node-id match (P4): a ledger entry may store its node id as `nodeId`
        // (runtime form) or `node_id` (DB column form leaked onto the object). A raw `===`
        // against args.nodeId drops the entry when the entry's stored form differs from the
        // form the caller passes, so a valid terminal completion goes unfound. meshNodeIdMatches
        // normalizes the entry across all 3 forms before comparing. (The entry's typed shape
        // omits the open index signature MeshNodeIdentified declares, hence the cast.)
        if (!args.sessionId && args.nodeId && meshNodeIdMatches(entry as unknown as MeshNodeIdentified, args.nodeId)) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
    }
    return null;
}

// Returns true when a task_dispatched entry for the given session appears AFTER the terminal
// entry (identified by terminalId) in ledger order. Positional (append) order is used rather
// than timestamp comparison because both entries may share the same millisecond.
export function hasDispatchAfterTerminal(meshId: string, sessionId: string, terminalId: string): boolean {
    // 200-entry window matches findRecentTerminalLedgerEvidence for consistency.
    const entries = readLedgerEntries(meshId, { tail: 200 });
    let pastTerminal = false;
    for (const entry of entries) {
        if (!pastTerminal) {
            if (entry.id === terminalId) pastTerminal = true;
            continue;
        }
        if (entry.kind === 'task_dispatched' && sessionIdsEquivalent(entry.sessionId, sessionId)) return true;
    }
    return false;
}

export function hasUnterminalDirectDispatchLedgerEntry(meshId: string, sessionId: string): boolean {
    // Some dispatch paths can persist task_dispatched before the direct-dispatch DB row is
    // available. Recover routing from ledger order so coordinator self-targets still emit
    // task_completed and pendingCoordinatorEvents.
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!sessionIdsEquivalent(entry.sessionId, sessionId)) continue;
        if (entry.kind === 'task_completed' || entry.kind === 'task_failed' || entry.kind === 'task_stalled') {
            return false;
        }
        if (entry.kind === 'task_dispatched' && entry.payload?.source === 'direct') {
            return true;
        }
    }
    return false;
}

export function findTerminalLedgerEvidenceForTask(args: {
    meshId: string;
    taskId?: string;
    sessionId?: string;
    nodeId?: string;
    tail?: number;
}): { id: string; kind: Extract<MeshLedgerKind, 'task_completed' | 'task_failed' | 'task_stalled'>; payload: Record<string, unknown>; timestamp: string } | null {
    const taskId = readNonEmptyString(args.taskId);
    if (!taskId) return null;
    const entries = readLedgerEntries(args.meshId, { tail: args.tail ?? 500 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') continue;
        const terminalTaskId = readNonEmptyString(entry.payload?.taskId);
        if (terminalTaskId !== taskId) continue;
        if (entry.kind === 'task_completed' && isWeakCompletionEvidence(entry.payload)) continue;
        if (args.sessionId && entry.sessionId && !sessionIdsEquivalent(entry.sessionId, args.sessionId)) continue;
        if (!args.sessionId && args.nodeId && entry.nodeId && !meshNodeIdMatches(entry as unknown as MeshNodeIdentified, args.nodeId)) continue;
        return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
    }
    return null;
}

function findDirectDispatchLedgerEntry(args: {
    meshId: string;
    taskId: string;
    sessionId?: string;
}): { id: string; timestamp: string; nodeId?: string; sessionId?: string; providerType?: string; payload: Record<string, unknown> } | null {
    const entries = readLedgerEntries(args.meshId, { tail: 500 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_dispatched') continue;
        const payloadTaskId = readNonEmptyString(entry.payload?.taskId);
        if (payloadTaskId !== args.taskId) continue;
        if (args.sessionId && entry.sessionId && !sessionIdsEquivalent(entry.sessionId, args.sessionId)) continue;
        return {
            id: entry.id,
            timestamp: entry.timestamp,
            nodeId: entry.nodeId,
            sessionId: entry.sessionId,
            providerType: entry.providerType,
            payload: entry.payload || {},
        };
    }
    return null;
}

function hasTerminalLedgerAfterDispatch(args: {
    meshId: string;
    taskId: string;
    sessionId?: string;
    dispatchEntryId?: string;
    dispatchTimestamp?: string;
}): boolean {
    const entries = readLedgerEntries(args.meshId, { tail: 500 });
    let afterDispatch = !args.dispatchEntryId && !args.dispatchTimestamp;
    const dispatchTime = args.dispatchTimestamp ? new Date(args.dispatchTimestamp).getTime() : Number.NaN;
    for (const entry of entries) {
        if (!afterDispatch) {
            if (args.dispatchEntryId && entry.id === args.dispatchEntryId) {
                afterDispatch = true;
                continue;
            }
            if (!args.dispatchEntryId && Number.isFinite(dispatchTime)) {
                const entryTime = new Date(entry.timestamp).getTime();
                if (Number.isFinite(entryTime) && entryTime >= dispatchTime) afterDispatch = true;
            }
            if (!afterDispatch) continue;
        }
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') continue;
        // Fix C (reconcile fallback expansion): a task_completed recorded from a FALSE idle
        // (weak evidence / no confirmed final assistant) is NOT authoritative terminal
        // evidence. Skip it so the transcript reconcile can still synthesize the GENUINE
        // completion for a re-dispatched / prematurely-terminated direct task instead of
        // bailing with alreadyTerminal.
        if (entry.kind === 'task_completed' && isWeakCompletionEvidence(entry.payload)) continue;
        const terminalTaskId = readNonEmptyString(entry.payload?.taskId);
        if (terminalTaskId && terminalTaskId === args.taskId) return true;
        if (terminalTaskId && terminalTaskId !== args.taskId) continue;
        if (args.sessionId && sessionIdsEquivalent(entry.sessionId, args.sessionId)) return true;
    }
    return false;
}

export function reconcileDirectDispatchCompletionFromTranscript(args: {
    meshId: string;
    nodeId?: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    taskId: string;
    finalSummary: string;
    transcriptMessageAt?: string;
    completedAt?: string;
    targetCoordinatorDaemonId?: string;
    /**
     * NOTIF-DROP-SYNTH-NO-MESSAGE: the originating coordinator SESSION that dispatched this
     * task (the `coordinatorSessionId` stamped onto the task_dispatched ledger payload at
     * dispatch). Stamped onto the synthesized completion's targetCoordinatorSessionId so PHASE 2
     * STRICT routing matches the exact coordinator session — instead of relying on the
     * daemon-keyed fallback. When the caller does not pass it, it is recovered from the dispatch
     * ledger entry below; absent on legacy rows → daemon-level routing (unchanged).
     */
    targetCoordinatorSessionId?: string;
    /**
     * WATCHDOG-FINALSUMMARY-LOST: fallback dispatch anchor for a CLAIM-PATH row that has no
     * `task_dispatched` direct-dispatch ledger entry (findDirectDispatchLedgerEntry → null). The
     * assigned-stranded watchdog already PROVED the transcript is idle-with-final-assistant AND
     * dated at/after this timestamp before calling; supplying it dates the completion for the
     * ledger/diagnostics. Direct-dispatch callers omit it → the ledger entry's timestamp is used
     * (unchanged).
     */
    dispatchTimestamp?: string;
    /**
     * WATCHDOG-FINALSUMMARY-LOST: the caller (the assigned-stranded watchdog poll,
     * pollAssignedTaskTerminalEvidence) has ALREADY enforced the turn-end proof this function's
     * grace + transcript_not_proven gates exist for — a settled-idle read, a final assistant dated
     * at/after dispatch, no trailing tool activity, and a continuous-idle streak. Those gates guard
     * the direct-dispatch first-idle-tick synth that fires ~1s after dispatch off a possibly-stale
     * tail; the watchdog does not fire until that proof holds, so re-applying the (60s/120s) grace
     * here would only DELAY a completion the watchdog already validated. When set, skip the grace +
     * transcript_not_proven gates (the terminal-ledger dedup + weak-supersession backstops remain).
     * Direct-dispatch callers omit it → the gates apply exactly as before (no regression).
     */
    preValidatedTranscriptEvidence?: boolean;
    /**
     * MID-TURN-CAUSAL-ADMISSION (rc.16): causal admission evidence for the unified guard —
     * see TranscriptSynthCausalAdmission. Every transcript-synth caller (PHASE 4 reconcile,
     * watchdog transcript propagation, MCP mesh_status poll) passes what it knows; the choke
     * point evaluates it BEFORE writing the terminal ledger or queuing the coordinator
     * completion. A veto returns { reconciled: false, reason } — callers treat that exactly
     * like their other not-yet-proven outcomes (hold and re-evaluate next tick), so the held
     * completion re-evaluates the causal evidence every pass and releases exactly once after
     * the state clears (the terminal-ledger dedup above makes the release idempotent).
     */
    causalAdmission?: TranscriptSynthCausalAdmission;
    source?: string;
}): { reconciled: boolean; kind?: MeshLedgerKind; alreadyTerminal?: boolean; workerResult?: unknown; ledgerEntryId?: string; reason?: string } {
    const finalSummary = readNonEmptyString(args.finalSummary);
    if (!args.meshId || !args.taskId || !args.sessionId || !finalSummary) {
        return { reconciled: false, reason: 'missing_required_completion_evidence' };
    }

    const dispatch = findDirectDispatchLedgerEntry({
        meshId: args.meshId,
        taskId: args.taskId,
        sessionId: args.sessionId,
    });
    if (hasTerminalLedgerAfterDispatch({
        meshId: args.meshId,
        taskId: args.taskId,
        sessionId: args.sessionId,
        dispatchEntryId: dispatch?.id,
        dispatchTimestamp: dispatch?.timestamp,
    })) {
        return { reconciled: false, alreadyTerminal: true, reason: 'terminal_ledger_entry_exists' };
    }

    // MID-TURN-CAUSAL-ADMISSION (rc.16): the unified guard every gate-bypassing synth must
    // pass. Ordered BEFORE any ledger write / queue so a vetoed synth leaves no trace other
    // than the completion-gate trace (observability parity with the synth-fire trace below).
    const admission = evaluateTranscriptSynthAdmission(args.causalAdmission);
    if (!admission.admitted) {
        LOG.info('MeshEvents', `Transcript synth vetoed for task ${args.taskId} session ${args.sessionId} (source ${args.source || 'direct_task_transcript_reconciliation'}): ${admission.reason} — holding the completion; it re-evaluates on the next reconcile pass`);
        recordSynthCompletionGateTrace('synth-veto', {
            producer: 'transcript_reconcile',
            source: args.source || 'direct_task_transcript_reconciliation',
            taskId: args.taskId,
            reason: admission.reason,
        });
        return { reconciled: false, reason: admission.reason };
    }

    const nodeId = readNonEmptyString(args.nodeId) || dispatch?.nodeId;
    const providerType = readNonEmptyString(args.providerType) || dispatch?.providerType || readNonEmptyString(dispatch?.payload.providerType);
    const completedAt = args.completedAt || new Date().toISOString();
    const evidence = buildTaskCompletionEvidence({
        event: 'agent:generating_completed',
        nodeId: nodeId || 'unknown',
        sessionId: args.sessionId,
        providerType,
        providerSessionId: readNonEmptyString(args.providerSessionId),
        finalSummary,
        completedAt,
    });
    const workerResult = evidence.workerResult;
    // EARLYNOTIFY-GATEBYPASS (c): a transcript-reconcile synth is TENTATIVE unless the worker's
    // summary self-attributes to this turn — i.e. it parsed a worker-result-shaped JSON
    // (`final_summary_json`), the same self-attribution the grace gate below exempts. A plain-text
    // transcript tail proves neither turn-finality nor that this reconcile beat the real completion,
    // so it is marked WEAK: buildPendingEventFingerprint then keys it `…::weak`, leaving the
    // `…::genuine` slot free for the worker's own later agent:generating_completed to surface (the
    // CANON-B weak→genuine supersession) instead of being dropped as a duplicate.
    const selfAttributing = workerResult.source === 'final_summary_json';
    // WATCHDOG-FINALSUMMARY-LOST: prefer the ledger dispatch timestamp; fall back to the caller's
    // proven anchor (a claim-path row has no task_dispatched ledger entry to date).
    const dispatchTime = dispatch?.timestamp
        ? new Date(dispatch.timestamp).getTime()
        : (args.dispatchTimestamp ? new Date(args.dispatchTimestamp).getTime() : Number.NaN);
    const transcriptTime = args.transcriptMessageAt ? new Date(args.transcriptMessageAt).getTime() : Number.NaN;
    const transcriptAfterDispatch = Number.isFinite(dispatchTime) && Number.isFinite(transcriptTime) && transcriptTime >= dispatchTime;
    if (!args.preValidatedTranscriptEvidence && workerResult.source !== 'final_summary_json' && !transcriptAfterDispatch) {
        return { reconciled: false, reason: 'transcript_not_proven_after_dispatch' };
    }
    // NOTIF-MISS grace gate (FIX 1): refuse to synthesize a completion for a direct dispatch
    // until a grace period has elapsed since its dispatch. A direct dispatch to an ALREADY-IDLE,
    // previously-used session reuses a transcript that still holds the PRIOR turn's final
    // assistant message; the session momentarily reads `idle` in the first second after dispatch
    // (the worker hasn't started generating yet), so without this gate the reconcile would
    // synthesize a "completion" ~1s after dispatch from that stale tail. When the REAL completion
    // fires minutes later, checkSuppressMeshEvent drops it as a duplicate of the synthesized one
    // (same providerSessionId/finalSummary) — the coordinator never learns the task finished.
    // The grace refuses synthesis until a genuine same-task completion is plausible. An idle-
    // session dispatch (dispatchedToIdleSession) is the exact race, so it gets a LONGER grace.
    // A structured final_summary_json is self-attributing (the provider emitted it for THIS turn),
    // so it is exempt; the grace only guards the ambiguous plain-text-tail case. When the dispatch
    // entry is missing we cannot date it and do NOT block (the stale-summary timestamp guard +
    // FIX 2 supersession remain the correctness backstops).
    if (!args.preValidatedTranscriptEvidence && Number.isFinite(dispatchTime) && workerResult.source !== 'final_summary_json') {
        const dispatchedToIdleSession = dispatch?.payload?.dispatchedToIdleSession === true;
        const graceMs = dispatchedToIdleSession
            ? DIRECT_DISPATCH_IDLE_SESSION_RECONCILE_GRACE_MS
            : DIRECT_DISPATCH_RECONCILE_GRACE_MS;
        if (Date.now() - dispatchTime < graceMs) {
            return { reconciled: false, reason: 'direct_dispatch_grace_period' };
        }
    }
    const workerFailed = workerResult.status === 'failed' || (workerResult.status !== 'completed' && workerResult.errors.length > 0);
    const kind: MeshLedgerKind = workerFailed ? 'task_failed' : 'task_completed';

    const entry = appendLedgerEntry(args.meshId, {
        kind,
        nodeId: nodeId || undefined,
        sessionId: args.sessionId,
        providerType: providerType || undefined,
        payload: {
            event: 'agent:generating_completed',
            source: args.source || 'direct_task_transcript_reconciliation',
            taskId: args.taskId,
            providerSessionId: readNonEmptyString(args.providerSessionId),
            finalSummary,
            workerResult,
            completionDiagnostic: {
                reason: 'direct_task_transcript_reconciliation',
                dispatchEntryId: dispatch?.id,
                dispatchTimestamp: dispatch?.timestamp,
                transcriptMessageAt: readNonEmptyString(args.transcriptMessageAt),
                // Honestly reflect self-attribution: a plain-text tail did NOT prove a turn-final
                // assistant message (only a self-attributing final_summary_json did).
                transcriptFinalAssistantPresent: selfAttributing,
            },
            evidence,
        },
    });
    // CANON-B: this reconcile path always knows the exact taskId — flip that dispatch row, not
    // whichever sibling the session_id happens to match.
    updateDirectDispatchStatus(args.meshId, args.sessionId, kind === 'task_completed' ? 'completed' : 'failed', args.taskId);
    markSessionDeliveriesTerminal(args.meshId, args.sessionId, kind === 'task_completed' ? 'completed' : 'failed');
    setImmediate(() => cleanupTerminalDirectDispatches());
    // NOTIF-DROP-SYNTH-NO-MESSAGE: the queued synth completion MUST carry a coordinatorMessage,
    // or injectPendingIntoCoordinator early-returns (`!pending.coordinatorMessage`) and the row is
    // drained-without-inject → no [System] surface. The ~8s-later native completion then collides
    // on the taskId-anchored fingerprint and is blocked at INSERT, so the notification is lost
    // forever. Build the SAME [System] message the native path builds (buildMeshSystemMessage) so
    // the synth is itself a complete, deliverable completion. Routing is made STRICT too: stamp the
    // originating coordinator session so PHASE 2 strict-match delivers to the exact coordinator
    // session that dispatched the task instead of falling back to a daemon-level broadcast.
    const eventName = kind === 'task_completed' ? 'agent:generating_completed' : 'agent:stopped';
    const nodeLabel = nodeId ? `Node '${nodeId}'` : 'Remote agent';
    const metadataEvent = {
        targetSessionId: args.sessionId,
        providerType: providerType || undefined,
        providerSessionId: readNonEmptyString(args.providerSessionId),
        finalSummary,
        taskId: args.taskId,
        workerResult,
        // EARLYNOTIFY-GATEBYPASS (c): mark a non-self-attributing synth WEAK so its pending
        // fingerprint is `…::weak` (isWeakCompletionMetadata reads evidenceLevel), never claiming
        // the genuine dedup slot. evidenceLevel:'weak' is deliberately NOT a false-idle marker
        // (the transcript tail existed) — it keeps the completion superseable, not suppressed.
        ...(selfAttributing ? {} : { evidenceLevel: 'weak' as const }),
        completionDiagnostic: {
            reason: 'direct_task_transcript_reconciliation',
            terminalLedgerKind: kind,
            terminalLedgerId: entry.id,
        },
    };
    // Originating coordinator session: prefer the explicit arg; otherwise recover it from the
    // task_dispatched ledger payload (the MCP dispatch path stamps `coordinatorSessionId` there).
    // Absent on legacy rows → undefined → daemon-level routing (unchanged, no regression).
    const targetCoordinatorSessionId = readNonEmptyString(args.targetCoordinatorSessionId)
        || readNonEmptyString(dispatch?.payload?.coordinatorSessionId);
    // COORD-EVENT-MISROUTE (anchor preservation): the DISPATCHING coordinator's daemon anchor.
    // Prefer the DISPATCH LEDGER's `coordinatorDaemonId` (the daemon that ISSUED the task) over the
    // caller-supplied arg — the synth caller (mesh-completion-synthesis) resolves the arg from its
    // OWN selfIds, which on a remote worker's reconcile is the WORKER daemon, not the coordinator.
    // Using the worker's self-daemon as the anchor makes coordinatorIdentityFromEmitFields treat
    // the completion as addressed to the worker daemon; when the coordinator lives on a DIFFERENT
    // machine that anchor never matches, selfFallback fires and stampPendingEventV2 broadcasts the
    // completion to ANY coordinator (contracts.ts shouldDeliverPendingEventToCoordinator → true for
    // broadcast), the cross-machine misroute. The ledger value is the authoritative issuing-daemon
    // anchor. Absent on legacy rows → fall back to the arg → daemon-level routing (no regression).
    const targetCoordinatorDaemonId = readNonEmptyString(dispatch?.payload?.coordinatorDaemonId)
        || readNonEmptyString(args.targetCoordinatorDaemonId);
    queuePendingMeshCoordinatorEvent({
        event: eventName,
        meshId: args.meshId,
        nodeLabel,
        nodeId: nodeId || undefined,
        metadataEvent,
        coordinatorMessage: buildMeshSystemMessage({ event: eventName, nodeLabel, metadataEvent }),
        queuedAt: Date.now(),
        ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
        ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
    });

    // (d) The synth fired — record it so this gate-bypassing emit is observable.
    recordSynthCompletionGateTrace('synth-fire', {
        producer: 'transcript_reconcile',
        source: args.source || 'direct_task_transcript_reconciliation',
        taskId: args.taskId,
        kind,
        selfAttributing,
        evidenceLevel: selfAttributing ? 'sufficient' : 'weak',
    });

    return { reconciled: true, kind, workerResult, ledgerEntryId: entry.id };
}

export function buildNoProgressCompletionReconciliation(args: {
    meshId: string;
    nodeId?: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    sourceInstanceId?: string;
}): Record<string, unknown> | null {
    const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
    const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
    const providerType = readNonEmptyString(args.metadataEvent.providerType);
    const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId);
    const workerResult = readWorkerResultMetadata(args.metadataEvent);
    const completionDiagnostic = readRecord(args.metadataEvent.completionDiagnostic);
    const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary);
    const status = readNonEmptyString(args.metadataEvent.status).toLowerCase();
    // EARLYNOTIFY-GATEBYPASS (c): a bare status flag (idle/ready/completed) with NO worker text is
    // the weakest possible "done" evidence — it is exactly the false-idle the no-progress monitor
    // fires on. Only a real assistant summary / worker result / confirmed final-assistant makes this
    // reconcile self-attributing. When it is not, mark the synthesized completion WEAK so a later
    // genuine completion can still supersede it (and buildMeshSystemMessage appends a verify hint).
    const noProgressSelfAttributing = Boolean(
        finalSummary || workerResult || completionDiagnostic?.finalAssistantPresent === true,
    );
    const explicitCompletionEvidence = Boolean(
        noProgressSelfAttributing
        || status === 'idle'
        || status === 'ready'
        || status === 'completed',
    );
    if (explicitCompletionEvidence) {
        // (d) A no-progress→completion synth bypasses the CLI provider gate — trace it.
        recordSynthCompletionGateTrace('synth-fire', {
            producer: 'no_progress_reconcile',
            source: 'no_progress_reconciliation',
            taskId: readNonEmptyString(args.metadataEvent.taskId),
            selfAttributing: noProgressSelfAttributing,
            evidenceLevel: noProgressSelfAttributing ? 'sufficient' : 'weak',
        });
        return {
            ...args.metadataEvent,
            targetSessionId: sessionId,
            providerType,
            providerSessionId,
            finalSummary,
            source: 'no_progress_reconciliation',
            reconciledFromEvent: 'monitor:no_progress',
            timestamp: args.metadataEvent.timestamp ?? Date.now(),
            ...(noProgressSelfAttributing ? {} : { evidenceLevel: 'weak' as const }),
            completionDiagnostic: {
                ...(completionDiagnostic || {}),
                reconciliationReason: 'provider_completion_evidence',
            },
        };
    }

    const terminal = findRecentTerminalLedgerEvidence({
        meshId: args.meshId,
        sessionId: sessionId || undefined,
        nodeId: nodeId || undefined,
    });
    if (!terminal) return null;
    return {
        ...args.metadataEvent,
        source: 'no_progress_terminal_ledger_suppression',
        terminalLedgerKind: terminal.kind,
        terminalLedgerAt: terminal.timestamp,
    };
}
