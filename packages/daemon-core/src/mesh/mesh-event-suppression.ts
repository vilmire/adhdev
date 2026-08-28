// EVENT-SUPPRESSION-EXTRACT (file-size gate decomposition, pure move from mesh-event-forwarding.ts):
// coordinator-side dedup/suppression/reconcile predicates and the turn-outbox drain / stale-worker
// stop / redrive-supersede helpers consumed exclusively by injectMeshSystemMessage there. No
// behavior change — see mesh-event-forwarding.ts for the call sites and injectMeshSystemMessage
// itself, which remains in that file and is threaded into evaluateMeshEventSuppression's ctx to
// avoid a circular import.
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, extractJsonObjectFromSummary, isIntentionalCleanupStopEntry, readLedgerEntriesByKind } from './mesh-ledger.js';
import { updateTaskStatus, getActiveDirectDispatches, getQueue, REDRIVE_RECLAIM_REASONS, REDRIVE_SUPERSEDE_WINDOW_MS } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { MeshRuntimeStore, pruneMeshRuntimeRetention } from './mesh-runtime-store.js';
import { queuePendingMeshCoordinatorEvent, prunePendingMeshCoordinatorEventsRetention, type PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { resolveMeshHostStatus } from './mesh-host-ownership.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { meshNodeIdMatches, sessionIdsEquivalent, withStatusProbeMarker, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import {
    findRecentTerminalLedgerEvidence,
    findTerminalLedgerEvidenceForTask,
    hasDispatchAfterTerminal,
    buildNoProgressCompletionReconciliation,
} from './mesh-events-stale.js';
import { hasMatchingTaskDispatchedEntry, readIntentionalCleanupStopEntries } from './mesh-read-model-consumers.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import {
    readNonEmptyString,
    readRefineJobId,
    readWorkerResultMetadata,
    isFalseIdleCompletion,
    isWeakCompletionEvidence,
} from './mesh-events-utils.js';
import {
    drainTurnOutbox,
    isTerminalTurnStage,
    runSessionDestructiveAction,
} from './mesh-turn-ledger.js';
import { resolveTurnAttemptRow } from './mesh-turn-presentation.js';
import {
    getMeshWithCache,
    sessionHasActiveAssignment,
    AUTO_LAUNCH_AWAIT_CLAIM_MS,
} from './mesh-queue-assignment.js';
import {
    authoritativeEvidenceOutranksLivePending,
    completionEligibleForLiveStateRetry,
    evaluateAuthoritativeTranscriptCompletion,
    holdCompletionForLiveStateRetry,
    readLiveTurnPendingEvidence,
    type LiveTurnEvidenceSource,
} from './mesh-completion-live-gate.js';
import { evaluateProviderEventAdmission } from './mesh-provider-event-admission.js';

// Throttle the pending-event retention DELETE so it runs at most hourly — the
// remote-idle sweep below fires on every completion/idle transition, but a table
// scan + DELETE should not. In-process timestamp; a restart re-arms it, which only
// means one prune shortly after boot (harmless, idempotent).
let lastPendingEventsPruneAt = 0;
const PENDING_EVENTS_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function sweepExpiredRemoteIdleSessions(): void {
    try {
        MeshRuntimeStore.getInstance().pruneExpiredRemoteIdleSessions();
    } catch { /* best-effort */ }
    // Piggyback the retention prunes on the same periodic sweep, but hourly — this
    // is the maintenance hook that keeps mesh-runtime.db from accumulating stale
    // rows without bound: mesh_pending_events (drained/orphaned rows) plus, on the
    // SAME cadence (SoT 1-11 (b)), the event ledger / tool-call log / terminal
    // queue retention in pruneMeshRuntimeRetention.
    const now = Date.now();
    if (now - lastPendingEventsPruneAt >= PENDING_EVENTS_PRUNE_INTERVAL_MS) {
        lastPendingEventsPruneAt = now;
        prunePendingMeshCoordinatorEventsRetention();
        pruneMeshRuntimeRetention();
    }
}

const INTENTIONAL_CLEANUP_STOP_SUPPRESSION_MS = 30 * 60 * 1000;

function isIntentionalCleanupStopMetadata(event: Record<string, unknown>): boolean {
    return event.intentional === true
        || event.intentionalStop === true
        || event.operatorCleanup === true
        || event.reason === 'operator_cleanup'
        || event.stopReason === 'operator_cleanup'
        || event.cleanupReason === 'operator_cleanup'
        || event.source === 'mesh_cleanup_sessions'
        || event.source === 'mesh_remove_node';
}

function hasRecentIntentionalCleanupStop(meshId: string, sessionId?: string, nodeId?: string): boolean {
    if (!sessionId && !nodeId) return false;
    const cutoff = Date.now() - INTENTIONAL_CLEANUP_STOP_SUPPRESSION_MS;
    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered (the 3 kinds isIntentionalCleanupStopEntry
    // accepts) + since=cutoff, no bare tail — `since` now does the 30-minute windowing
    // directly instead of relying on walking a fixed-size tail until timestamps age out,
    // so a genuine intentional-cleanup-stop can no longer be evicted by unrelated mesh
    // traffic filling a bare tail:200 window before the walk reaches the cutoff.
    // Stage 4B roster entry 5: served from the seqscribe replica behind the readiness
    // gate, from the ledger otherwise. Lossless — the predicate below reads only base
    // fields plus the four scalar payload keys isIntentionalCleanupStopEntry inspects
    // (`intentional`, `reason`, `intentionalStopReason`, `source`), all of which the
    // Stage 4B projection additions allow-list. See mesh-read-model-consumers.ts.
    const entries = readIntentionalCleanupStopEntries(meshId, new Date(cutoff).toISOString());
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!isIntentionalCleanupStopEntry(entry)) continue;
        // Session ids are single-form; sessionIdsEquivalent is the one canonical
        // exact-match predicate (see its doc for why no form expansion is needed).
        if (sessionId && sessionIdsEquivalent(entry.sessionId, sessionId)) return true;
        // Normalized node-id match (P4): the cleanup-stop entry's node id may be stored as
        // `nodeId` or `node_id` and the `nodeId` arg can be in either form — a raw `===`
        // would miss a genuine intentional-cleanup entry and fail to suppress the stop event.
        if (!sessionId && nodeId && meshNodeIdMatches(entry as unknown as MeshNodeIdentified, nodeId)) return true;
    }
    return false;
}

function shouldSuppressIntentionalCleanupStop(args: {
    event: string;
    meshId: string;
    metadataEvent: Record<string, unknown>;
    sessionId?: string;
    nodeId?: string;
}): boolean {
    if (args.event !== 'agent:stopped' && args.event !== 'monitor:no_progress') return false;
    if (isIntentionalCleanupStopMetadata(args.metadataEvent)) return true;
    return hasRecentIntentionalCleanupStop(args.meshId, args.sessionId, args.nodeId);
}

const RECENT_COMPLETION_FINGERPRINT_TTL_MS = 10 * 60 * 1000;

function hasFingerprintSeen(meshId: string, fingerprint: string): boolean {
    try {
        return MeshRuntimeStore.getInstance().hasCompletionFingerprint(meshId, fingerprint);
    } catch {
        return false;
    }
}

function recordFingerprintSeen(meshId: string, fingerprint: string): void {
    try {
        const db = MeshRuntimeStore.getInstance();
        db.recordCompletionFingerprint(meshId, fingerprint, RECENT_COMPLETION_FINGERPRINT_TTL_MS);
        db.sweepExpiredFingerprints();
    } catch { /* best-effort; duplicate events are preferable to a crash */ }
}

export function readEventTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function buildMeshCompletionFingerprint(args: {
    meshId: string;
    event: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    timestamp?: number | null;
    finalSummary?: string;
    coordinatorDaemonId?: string;
}): string {
    const timestampPart = Number.isFinite(args.timestamp)
        ? String(args.timestamp)
        : readNonEmptyString(args.finalSummary).slice(0, 200);
    return [
        args.meshId,
        args.event,
        args.sessionId,
        args.providerType || '',
        args.providerSessionId || '',
        timestampPart,
        args.coordinatorDaemonId || '',
    ].join('::');
}

function isDuplicateMeshCompletionEvent(args: {
    meshId: string;
    event: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    timestamp?: number | null;
    finalSummary?: string;
    coordinatorDaemonId?: string;
    taskId?: string;
    nodeId?: string;
}): boolean {
    const fingerprint = buildMeshCompletionFingerprint(args);
    if (!fingerprint) return false;
    if (hasFingerprintSeen(args.meshId, fingerprint)) {
        // MESH-COMPLEXITY-AUDIT Part 8-2: the dedup DECISION is the fingerprint
        // match on the line above — that is the no-loss-neutral gate and it is
        // unchanged. The former mesh_completion_conflicts diagnostic side-record
        // (which task lost a fingerprint collision) had no production reader and
        // played no part in the delivery contract, so it was dropped. Suppressing
        // the duplicate here is unaffected: a genuine second, distinct completion
        // has a different fingerprint (different taskId/timestamp/summary) and
        // therefore does not match, so it is NOT suppressed here.
        return true;
    }
    recordFingerprintSeen(args.meshId, fingerprint);
    return false;
}

function isDuplicateMeshApprovalEvent(args: {
    meshId: string;
    sessionId: string;
    providerType?: string;
    timestamp?: number | null;
    modalMessage?: string;
    modalButtons?: unknown;
}): boolean {
    const modalButtons = Array.isArray(args.modalButtons)
        ? args.modalButtons.map(button => String(button).trim()).filter(Boolean)
        : [];
    const approvalIdentity = Number.isFinite(args.timestamp)
        ? String(args.timestamp)
        : JSON.stringify({ message: args.modalMessage || '', buttons: modalButtons });
    if (!approvalIdentity || approvalIdentity === '{"message":"","buttons":[]}') return false;
    const fingerprint = [
        args.meshId,
        'agent:waiting_approval',
        args.sessionId,
        args.providerType || '',
        approvalIdentity,
    ].join('::');
    if (hasFingerprintSeen(args.meshId, fingerprint)) return true;
    recordFingerprintSeen(args.meshId, fingerprint);
    return false;
}

function isDuplicateRefineTerminalEvent(meshId: string, eventName: string, metadataEvent: Record<string, unknown>): boolean {
    const jobId = readRefineJobId({ metadataEvent });
    const fingerprint = jobId && new Set(['refine:completed', 'refine:failed']).has(eventName) ? `${meshId}::${eventName}::${jobId}` : '';
    if (!fingerprint) return false;
    if (hasFingerprintSeen(meshId, fingerprint)) return true;
    recordFingerprintSeen(meshId, fingerprint);
    return false;
}

// NOTIF-MISS (FIX 2): the set of `source` tags the transcript-reconcile synthesis path stamps
// onto the terminal ledger entry it writes (mesh-events-stale.reconcileDirectDispatchCompletion
// FromTranscript). A terminal carrying one of these was NOT produced by an actual provider
// agent_status_event — it is a coordinator-side reconstruction from the worker's transcript. The
// authoritative real completion must never be permanently masked by such a synthesized record.
const RECONCILED_COMPLETION_SOURCES = new Set([
    'direct_task_transcript_reconciliation',
    'daemon_reconcile_transcript_completion',
    'mcp_mesh_status_transcript_reconciliation',
    'no_progress_reconciliation',
]);

// True when the recorded terminal ledger entry was SYNTHESIZED by transcript reconciliation
// rather than emitted by the real provider event. The reconcile path tags its ledger payload
// with a reconcile `source`; a genuine provider completion carries no such tag (or a normal
// completionDiagnostic.reason). Both the explicit source AND the diagnostic reason are checked so
// either carrier identifies the synthesized record.
function isSynthesizedReconciledTerminal(terminalPayload: Record<string, unknown>): boolean {
    const source = readNonEmptyString(terminalPayload.source);
    if (source && RECONCILED_COMPLETION_SOURCES.has(source)) return true;
    const diagnostic = terminalPayload.completionDiagnostic;
    if (diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)) {
        const reason = readNonEmptyString((diagnostic as Record<string, unknown>).reason);
        if (reason && RECONCILED_COMPLETION_SOURCES.has(reason)) return true;
    }
    return false;
}

// True when the INCOMING completion event is a REAL provider agent_status_event (an actual
// agent:generating_completed from the live session) rather than itself a synthesized/reconciled
// re-injection. We must only let a real event override a synthesized terminal — a second
// synthesized re-arrival should still dedup normally. A real provider event carries no reconcile
// `source` tag; a re-injected reconciliation does.
function isRealProviderCompletionEvent(metadataEvent: Record<string, unknown>): boolean {
    const source = readNonEmptyString(metadataEvent.source);
    return !source || !RECONCILED_COMPLETION_SOURCES.has(source);
}

// The genuine-completion counterpart: a real final summary / worker result is present and
// the completion is not flagged as a missing-final-assistant false idle. Used to decide
// whether a new completion may supersede a prior WEAK (false-idle) terminal. NOTE this gates
// only on isFalseIdleCompletion (the completionDiagnostic subset), NOT the broader
// isWeakCompletionEvidence — preserving the original semantics where a self-declared
// weak/insufficient event still counts as genuine if it carries a real final summary.
function isGenuineCompletionEvidence(metadataEvent: Record<string, unknown>): boolean {
    if (isFalseIdleCompletion(metadataEvent)) return false;
    return !!readWorkerResultMetadata(metadataEvent) || !!readNonEmptyString(metadataEvent.finalSummary);
}

/**
 * The worker result for the GRAPH OUTPUT ENVELOPE (design :149-163), which is what
 * downstream `inputs_from` pointers like `/worker_result/validationResults` select
 * against.
 *
 * readWorkerResultMetadata alone reads only pre-populated event fields
 * (workerResult / meshWorkerResult / structuredResult). Across daemon-core exactly
 * ONE writer ever sets those: the remote-relay passthrough. A LOCAL completion has
 * no writer at all, so the envelope's worker_result was always undefined and every
 * documented pointer into it silently missed — the failure this fixes.
 *
 * The ledger's own evidence record has always fallen back to parsing the worker's
 * trailing JSON block out of the final summary (resolveWorkerResult →
 * extractJsonObjectFromSummary). This applies the same fallback to the envelope so
 * both surfaces agree on what the worker reported.
 *
 * REMOTE-RELAY SAFETY: the pre-populated metadata is checked FIRST and returned
 * as-is. A relayed completion therefore takes exactly the path it took before this
 * change; the parse only runs when there was nothing to relay. It is a pure
 * fallback, never an override.
 *
 * Shape note: the parsed object is passed through unnormalized, matching how a
 * relayed workerResult is passed through — so `/worker_result/<field>` selects the
 * worker's own reported keys (status, changedFiles, validationResults, gitStatus,
 * errors, nextAction) exactly as documented. extractJsonObjectFromSummary already
 * requires that worker-result shape before it will match, so a stray JSON blob in
 * the summary is not mistaken for a result.
 */
export function resolveGraphEnvelopeWorkerResult(metadataEvent: Record<string, unknown>): Record<string, unknown> | undefined {
    const explicit = readWorkerResultMetadata(metadataEvent);
    if (explicit) return explicit;
    return extractJsonObjectFromSummary(readNonEmptyString(metadataEvent.finalSummary) || undefined);
}

/**
 * EVIDENCE-LEVEL-UNIFY: the ledger-append block in markSessionTerminal computes its own
 * evidenceLevel ('insufficient'/'sufficient') from completionEvidence.workerResult.source,
 * independent of whatever applyTaskModeCompletionEvidence (mesh-completion-side-effect-
 * evidence.ts, called earlier in the same function) already stamped onto
 * metadataEvent.evidenceLevel (its git-clean gate stamps 'reported' as a fallback-only
 * marker, i.e. only when nothing was set yet). Left unmerged, the ledger entry and the
 * coordinator-facing message (buildMeshSystemMessage, called later off the SAME
 * metadataEvent object) disagreed on the same completion — e.g. ledger='insufficient' /
 * reviewRecommended=true while the message suffix showed only 'evidence_level=reported'.
 *
 * 'insufficient' is the strictly weak signal — isWeakCompletionEvidence
 * (mesh-events-utils.ts) treats only 'insufficient'/'weak' as weak, NOT 'reported' — so this
 * never downgrades away from 'insufficient', mirroring the reviewRecommended merge next to
 * this block's call site (never downgrade the NOTIF Defect-2b verdict).
 */
export function resolveUnifiedCompletionEvidenceLevel(args: {
    computedLevel: 'insufficient' | 'sufficient' | undefined;
    priorLevel: string | undefined;
}): string | undefined {
    if (args.computedLevel === 'insufficient' || args.priorLevel === 'insufficient') return 'insufficient';
    return args.computedLevel || args.priorLevel;
}

// (FALSEIDLE-BGCHILD-b) A later genuine completion of the SAME task that carries a
// substantively different — and fuller — final summary than the recorded terminal is the REAL
// final that an earlier (false-idle) completion pre-empted, not a duplicate. The background-child
// false idle is the nasty case the plain isWeakCompletionEvidence supersession misses: the
// early completion's screen parser DID see a prior/intermediate standard assistant, so it is
// recorded as a STRONG terminal with a non-empty (but truncated) finalSummary. Without this the
// providerSessionId/finalSummary dedup below swallows the genuine final and the coordinator is
// stuck with the truncated mid-turn text forever (the one-shot-consumption symptom). Same-task,
// new event is genuine, prior terminal summary is a strict prefix of (or otherwise shorter than)
// the new one → treat as the corrected final and let it through. Conservative: requires the new
// summary to be genuine evidence AND meaningfully longer, so an identical re-arrival or a SHORTER
// later summary is still deduped.
function supersedesTruncatedTerminalSummary(args: {
    terminalPayload: Record<string, unknown>;
    metadataEvent: Record<string, unknown>;
    terminalTaskId: string;
    eventTaskId: string;
}): boolean {
    // Only applies when both name the SAME task (a distinct task is handled by distinctTaskCompletion).
    if (!args.terminalTaskId || !args.eventTaskId || args.terminalTaskId !== args.eventTaskId) return false;
    if (!isGenuineCompletionEvidence(args.metadataEvent)) return false;
    const terminalSummary = readNonEmptyString(args.terminalPayload.finalSummary);
    const eventSummary = readNonEmptyString(args.metadataEvent.finalSummary);
    if (!eventSummary) return false;
    // Identical text → genuine duplicate, keep deduping.
    if (terminalSummary === eventSummary) return false;
    // The recorded terminal was a known-weak (false-idle) one → already handled by the weak
    // supersession path; nothing extra to do here.
    if (isWeakCompletionEvidence(args.terminalPayload)) return false;
    // No prior summary at all, or the new summary strictly extends / is meaningfully longer than
    // the recorded one → the recorded terminal was the truncated pre-emption; supersede it.
    if (!terminalSummary) return true;
    if (eventSummary.startsWith(terminalSummary)) return true;
    return eventSummary.length > terminalSummary.length + 32;
}

// The latest still-active direct-dispatch taskId for a session, resolved BEFORE the
// completion flips the dispatch row terminal. Direct dispatches (mesh_send_task) have no
// work-queue row, so this is the only taskId available to attribute the terminal ledger
// entry (and thus mesh task-stats) to — without it the terminal carries no taskId and the
// task surfaces as status='unknown' / terminalKind=null in computeMeshTaskStats.
export function resolveActiveDirectDispatchTaskId(meshId: string, sessionId: string): string | undefined {
    try {
        // Session ids are single-form; sessionIdsEquivalent is the one canonical
        // exact-match predicate — no node-id-style form normalization needed.
        const matches = getActiveDirectDispatches(meshId).filter(d => sessionIdsEquivalent(d.sessionId, sessionId));
        if (!matches.length) return undefined;
        // getActiveDirectDispatches returns rows ordered by dispatched_at ASC; the last is
        // the most recent dispatch (the re-dispatch / nudge whose completion this is).
        return readNonEmptyString(matches[matches.length - 1].taskId) || undefined;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// CAUSAL-COMPLETION-GATE (Fix A, rc.15 orchestration RCA): auto-launch sessions can emit a
// spurious agent:generating_completed before the task was ever delivered to / consumed by the
// session — a freshly spawned worker's boot/idle-prompt output can be misread by the provider's
// own completion detector as a finished turn (totalMessages=0: the worker never actually
// processed the task). The provider's weak/false-idle self-report is not guaranteed to catch a
// pure boot artifact, so this is an INDEPENDENT, coordinator-side check scoped to the exact race:
// a task still 'pending' whose in-window autoLaunch record names THIS session. For that narrow
// case we require causal evidence — the delivery was consumed (taskDeliveryConsumed) or a
// task_dispatched ledger entry proves the turn actually started — before letting the completion
// through. An already-claimed/dispatched task (the overwhelming majority of completions) never
// matches (its status is no longer 'pending'), so this never broadens into general suppression.
// ---------------------------------------------------------------------------

// The in-window, not-yet-claimed queue task (if any) whose autoLaunch record names this exact
// session. Bounded to AUTO_LAUNCH_AWAIT_CLAIM_MS — the same window the claim-churn/respawn guards
// use — so a task whose autoLaunch attempt is long expired (and has since moved on to backoff /
// direct-dispatch fallback, or a fresh auto-launch attempt) is never matched here.
function findInWindowUnclaimedAutoLaunchTask(meshId: string, sessionId: string, nowMs: number): MeshWorkQueueEntry | undefined {
    return getQueue(meshId, { status: ['pending'] }).find(task => {
        const al = task.autoLaunch;
        if (!al || al.status !== 'completed' || !al.sessionId) return false;
        if (!sessionIdsEquivalent(al.sessionId, sessionId)) return false;
        const launchedAtMs = Date.parse(al.updatedAt);
        return Number.isFinite(launchedAtMs) && nowMs - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS;
    });
}

// Turn-start evidence distinct from taskDeliveryConsumed: a task_dispatched ledger entry naming
// BOTH this taskId and this sessionId proves the coordinator itself recorded a genuine dispatch
// of this task onto this session. A task still 'pending' (the only case this gate applies to)
// normally has no such entry — task_dispatched is written when the claim transitions the row to
// 'assigned' — so this is a defensive alternate signal, not the expected path.
function hasMatchingTaskDispatchedLedgerEntry(meshId: string, taskId: string, sessionId: string): boolean {
    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered, no bare tail. This feeds the
    // CAUSAL-COMPLETION-GATE below — a false negative here suppresses a genuine task
    // completion as a "boot artifact." A bare tail:200 window can be crowded out by
    // unrelated mesh traffic before the real task_dispatched row is found.
    //
    // Stage 4A roster entry 3: served from the seqscribe replica behind the
    // readiness gate, from the ledger otherwise. Lossless — reads only
    // sessionId (base) and taskId (base + allow-listed payload key). The
    // gate's lagRows===0 condition exists for exactly this consumer's danger
    // direction: a lagging index would report "no dispatch" for one that exists.
    return hasMatchingTaskDispatchedEntry(meshId, taskId, sessionId);
}

// Coordinator-side suppression/reconcile gate for an incoming mesh event. Each clause is a
// closed dedup/suppression concern that only inspects the event + already-resolved context and
// either (a) returns a `suppress` result the caller forwards verbatim, (b) returns a `reconcile`
// signal carrying the rewritten metadataEvent for the caller to re-inject as
// agent:generating_completed, or (c) returns null to let the event fall through to the
// terminal/ledger machinery. Extracted verbatim from injectMeshSystemMessage — no behavior
// change; the only side effects (best-effort remote-idle cleanup, LOG, trace) fire on the same
// paths as before.
export function evaluateMeshEventSuppression(
    args: {
        meshId: string;
        sourceInstanceId?: string;
        nodeId?: string;
        nodeLabel: string;
        event: string;
        metadataEvent: Record<string, unknown>;
    },
    ctx: {
        traceCtx: Parameters<typeof traceMeshEventDrop>[1];
        eventSessionId: string;
        eventNodeId: string;
        eventTimestamp: number | null;
        workerCoordinatorDaemonId: string | undefined;
        components: DaemonComponents;
        // Injected by the caller (injectMeshSystemMessage lives in mesh-event-forwarding.ts,
        // which imports this module) to avoid a circular import while preserving the exact
        // recursive re-injection behavior of the pre-extraction inline code. Typed structurally
        // against its own args shape (not Record<string, unknown>) so passing the real function
        // in from mesh-event-forwarding.ts type-checks.
        injectMeshSystemMessage: (components: DaemonComponents, args: {
            meshId: string;
            sourceInstanceId?: string;
            nodeId?: string;
            nodeLabel: string;
            event: string;
            metadataEvent: Record<string, unknown>;
            v2Envelope?: Partial<Pick<PendingMeshCoordinatorEvent,
                'protocolVersion' | 'eventId' | 'scope' | 'dispatchedBy' | 'intendedFor'>>;
        }) => unknown;
    },
):
    | { kind: 'suppress'; result: { success: true; forwarded: 0; suppressed: true; [extra: string]: unknown } }
    | { kind: 'reconcile'; metadataEvent: Record<string, unknown> }
    | null {
    const { traceCtx, eventSessionId, eventNodeId, eventTimestamp, workerCoordinatorDaemonId, components, injectMeshSystemMessage } = ctx;

    const intentionalCleanupStop = shouldSuppressIntentionalCleanupStop({
        event: args.event,
        meshId: args.meshId,
        metadataEvent: args.metadataEvent,
        sessionId: eventSessionId || undefined,
        nodeId: eventNodeId || undefined,
    });
    if (intentionalCleanupStop) {
        if (eventSessionId && eventNodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(args.meshId, eventNodeId, eventSessionId);
            } catch { /* best-effort */ }
        }
        LOG.info('MeshEvents', `Suppressed ${args.event} for intentionally cleanup-stopped session ${eventSessionId || '(unknown session)'}`);
        traceMeshEventDrop('intentional_cleanup_stop', traceCtx);
        return { kind: 'suppress', result: { success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true } };
    }

    if (args.event === 'monitor:no_progress') {
        const reconciledCompletion = buildNoProgressCompletionReconciliation({
            meshId: args.meshId,
            nodeId: args.nodeId,
            nodeLabel: args.nodeLabel,
            metadataEvent: args.metadataEvent,
            sourceInstanceId: args.sourceInstanceId,
        });
        if (reconciledCompletion?.source === 'no_progress_reconciliation') {
            LOG.info('MeshEvents', `Reconciled no-progress monitor to completion for session ${eventSessionId || '(unknown session)'}`);
            return { kind: 'reconcile', metadataEvent: reconciledCompletion };
        }
        if (reconciledCompletion?.source === 'no_progress_terminal_ledger_suppression') {
            LOG.info('MeshEvents', `Suppressed no-progress monitor because terminal ledger evidence already exists for session ${eventSessionId || '(unknown session)'}`);
            traceMeshEventDrop('no_progress_terminal_ledger_suppression', traceCtx, `terminalKind=${reconciledCompletion.terminalLedgerKind}`);
            return {
                kind: 'suppress',
                result: {
                    success: true,
                    forwarded: 0,
                    suppressed: true,
                    terminalLedgerEvidence: true,
                    terminalLedgerKind: reconciledCompletion.terminalLedgerKind,
                },
            };
        }
    }

    if (isDuplicateRefineTerminalEvent(args.meshId, args.event, args.metadataEvent)) {
        LOG.info('MeshEvents', `Suppressed duplicate ${args.event} for refine job ${readRefineJobId({ metadataEvent: args.metadataEvent })}`);
        traceMeshEventDrop('duplicate_refine_terminal', traceCtx);
        return { kind: 'suppress', result: { success: true, forwarded: 0, suppressed: true, duplicateRefineTerminalEvent: true } };
    }

    if (args.event === 'agent:waiting_approval' && eventSessionId) {
        const duplicateApproval = isDuplicateMeshApprovalEvent({
            meshId: args.meshId,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            timestamp: eventTimestamp,
            modalMessage: readNonEmptyString(args.metadataEvent.modalMessage) || undefined,
            modalButtons: args.metadataEvent.modalButtons,
        });
        if (duplicateApproval) {
            LOG.info('MeshEvents', `Suppressed duplicate approval event for mesh ${args.meshId} session ${eventSessionId}`);
            traceMeshEventDrop('duplicate_approval', traceCtx);
            return { kind: 'suppress', result: { success: true, forwarded: 0, suppressed: true, duplicateApproval: true } };
        }
    }
    if (args.event === 'agent:generating_completed' && eventSessionId) {
        // MID-TURN-LIVE-STATE-GATE: live pending evidence remains a completion veto unless the
        // incoming event carries the provider's versioned CLEAN transcript proof, that proof is
        // fresh and non-empty, and (task, attempt, session, dispatchNonce) exactly match the
        // current reducer attempt. Even authoritative transcript evidence only outranks a
        // modal/screen observation whose PTY clock or reducer suspension edge proves it stale;
        // a fresh approval/choice, adapter response, or trailing transcript tool remains
        // nonterminal.
        //
        // A vetoed event whose strong transcript envelope already passed every freshness/content/
        // causal check receives one content-free in-memory hold keyed by the same identity. A
        // summary alone can never arm it. For at most 5s it re-checks the LOCAL live state; once
        // that state clears it re-enters this normal pipeline
        // exactly once. The hold stores no summary/transcript/modal content, expires boundedly,
        // and is dropped on terminal, cancellation, reassignment, missing session, or identity
        // mismatch. The turn reducer plus terminal outbox remain the exactly-once authorities.
        //
        // Remote/unknown sessions are outside this synchronous gate, as before; absence of a local
        // instance never fabricates pending evidence and never arms a hold.
        const liveInstance = components.instanceManager?.getInstance?.(eventSessionId) as
            LiveTurnEvidenceSource | undefined;
        if (typeof liveInstance?.getLiveTurnPendingEvidence === 'function'
            || typeof liveInstance?.hasLiveTurnPendingEvidence === 'function') {
            const live = readLiveTurnPendingEvidence(liveInstance);
            if (live.pending) {
                const taskId = readNonEmptyString(args.metadataEvent.taskId);
                const attempt = taskId
                    ? MeshRuntimeStore.getInstance().getCurrentTurnAttempt(args.meshId, taskId)
                    : null;
                const authority = evaluateAuthoritativeTranscriptCompletion({
                    metadataEvent: args.metadataEvent,
                    eventSessionId,
                    attempt,
                });
                if (authoritativeEvidenceOutranksLivePending(authority, live)) {
                    LOG.info('MeshEvents', `Accepted agent:generating_completed for session ${eventSessionId} (mesh ${args.meshId}): fresh clean-path transcript evidence for the current attempt is newer than the stale ${live.kind ?? 'live'} snapshot`);
                } else {
                    const retryEligible = completionEligibleForLiveStateRetry({
                        metadataEvent: args.metadataEvent,
                        eventSessionId,
                        attempt,
                    });
                    const heldForRetry = retryEligible
                        && holdCompletionForLiveStateRetry(components, args, eventSessionId, Date.now(), injectMeshSystemMessage);
                    // ATTEMPT-SETTLE diagnostics: when the authority decision carries a
                    // profile detail, name the concrete (authorityClass, evidenceSource,
                    // timing) triple. The bare reason string told us a contract pair was
                    // violated but not WHICH side was wrong, so a live drop could not be
                    // diagnosed without waiting for another recurrence. Content-free
                    // classification labels only — safe under the content boundary.
                    const authorityDetail = !authority.authoritative && authority.detail
                        ? ` [authorityClass=${authority.detail.authorityClass ?? 'none'}`
                          + ` evidenceSource=${authority.detail.evidenceSource ?? 'none'}`
                          + ` timing=${authority.detail.timing ?? 'none'}]`
                        : '';
                    LOG.info('MeshEvents', `Suppressed agent:generating_completed for session ${eventSessionId} (mesh ${args.meshId}): current live evidence remains pending (${live.kind ?? 'unknown'}); transcript authority=${authority.authoritative ? 'fresh_but_not_newer' : authority.reason}${authorityDetail}${heldForRetry ? ' — bounded content-free retry armed' : ''}`);
                    traceMeshEventDrop(
                        'mid_turn_live_state_pending',
                        traceCtx,
                        `${heldForRetry ? 'retry_held' : 'dropped'}`
                        + `${authority.authoritative ? '' : ` authority=${authority.reason}${authorityDetail}`}`,
                    );
                    return {
                        kind: 'suppress',
                        result: {
                            success: true,
                            forwarded: 0,
                            suppressed: true,
                            midTurnLiveStatePending: true,
                            ...(heldForRetry ? { completionRetryHeld: true } : {}),
                        },
                    };
                }
            }
        }
        // TERMINAL-ADMISSION-ALL-PATHS (provider_event): route this path — the one that
        // actually produced the 10:49 false completion — through the single terminal-admission
        // choke point. See mesh-provider-event-admission.ts for the incident, the narrow rule
        // it enforces (transcript_growing only), and the liveness contract that keeps genuine
        // completions flowing. A decline arms the SAME bounded content-free hold the live-state
        // gate above uses, so it delays by at most the hold TTL and never drops.
        {
            const admission = evaluateProviderEventAdmission({
                instance: components.instanceManager?.getInstance?.(eventSessionId),
                providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                // Dispatch boundary for native-marker turn scoping. Best-effort: an
                // unresolvable attempt leaves it undefined, which only widens marker
                // acceptance — it can never fabricate a veto.
                turnStartedAtMs: (() => {
                    const taskId = readNonEmptyString(args.metadataEvent.taskId);
                    if (!taskId) return undefined;
                    try {
                        const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(args.meshId, taskId);
                        const at = Date.parse(attempt?.acceptedAt || attempt?.createdAt || '');
                        return Number.isFinite(at) ? at : undefined;
                    } catch { return undefined; }
                })(),
            });
            if (admission.kind === 'decline') {
                const heldForRetry = holdCompletionForLiveStateRetry(
                    components, args, eventSessionId, Date.now(), injectMeshSystemMessage);
                LOG.info('MeshEvents', `Suppressed agent:generating_completed for session ${eventSessionId} (mesh ${args.meshId}): terminal admission declined (${admission.reason}) — ${admission.detail}${heldForRetry ? ' — bounded content-free retry armed' : ''}`);
                traceMeshEventDrop(
                    'provider_event_terminal_admission_declined',
                    traceCtx,
                    `${admission.reason} ${heldForRetry ? 'retry_held' : 'dropped'}`,
                );
                return {
                    kind: 'suppress',
                    result: {
                        success: true,
                        forwarded: 0,
                        suppressed: true,
                        terminalAdmissionDeclined: true,
                        ...(heldForRetry ? { completionRetryHeld: true } : {}),
                    },
                };
            }
            // TERMINAL-ADMISSION-OBSERVABILITY (2026-08-18): the decline above was the
            // ONLY verdict ever logged, so after a false completion it was impossible to
            // tell "the gate admitted" from "the gate never observed" (the 14e39b9e gap —
            // a decline here did not bind the OTHER terminal path that admitted the same
            // transcript 7s later). Trace both non-decline verdicts:
            //   - admit → terminal_admission_admitted (evidenceLevel:reason)
            //   - unobserved → terminal_admission_not_enforced:<reason>
            if (admission.kind === 'admit') {
                traceMeshEventStage('terminal_admission_admitted', traceCtx,
                    `${admission.evidenceLevel}:${admission.reason}`);
            } else {
                traceMeshEventStage('terminal_admission_not_enforced', traceCtx, admission.reason);
            }
        }
        // NO-DISPATCH-NATIVE-COMPLETION-GATE (rc.16 follow-up): a session that was launched
        // but never given ANY task can still emit its own native agent:generating_completed off
        // a startup/greeting artifact (e.g. cursor-cli's "→ Plan, search, build anything" idle
        // prompt right after boot) — the WARMUPGAP note on markSessionTerminal below already
        // recognizes this shape (no echoed taskId, no active assignment) but only skips the
        // dispatch-row side effect; the event itself still becomes a coordinator-visible
        // task_completed. Suppress it outright here, narrowly: the event carries no taskId, the
        // session holds no active assignment (queue OR direct-dispatch), AND the session has NO
        // terminal ledger history at all (a session with a PRIOR terminal has been dispatched at
        // least once before and falls through to the existing terminal/dedup logic below
        // unchanged). Structural/causal only — no message-content inspection. A completion that
        // is NOT weak (a real final summary / worker result, not a bare false-idle status flag)
        // still passes through: a session that was somehow handed a genuine answer without a
        // tracked dispatch must not have that answer silently dropped.
        if (!readNonEmptyString(args.metadataEvent.taskId)
            && !sessionHasActiveAssignment(args.meshId, eventSessionId)
            && !findRecentTerminalLedgerEvidence({ meshId: args.meshId, sessionId: eventSessionId, nodeId: eventNodeId || undefined })
            && isWeakCompletionEvidence(args.metadataEvent)) {
            LOG.info('MeshEvents', `Suppressed agent:generating_completed for session ${eventSessionId} (mesh ${args.meshId}): no taskId, no active assignment, and no prior terminal ledger evidence — a pre-dispatch startup/greeting artifact, not a real task completion`);
            traceMeshEventDrop('no_dispatch_native_completion', traceCtx);
            return {
                kind: 'suppress',
                result: { success: true, forwarded: 0, suppressed: true, noDispatchNativeCompletion: true },
            };
        }
        // CAUSAL-COMPLETION-GATE (Fix A): fail closed ONLY for the scoped auto-launch race —
        // an in-window, still-'pending' task whose autoLaunch record names this exact session,
        // with neither a consumed delivery nor a matching task_dispatched ledger entry. Every
        // other completion (already-claimed tasks, direct dispatches, expired auto-launch
        // windows) falls through unchanged to the existing dedup/terminal-ledger logic below.
        const inWindowTask = findInWindowUnclaimedAutoLaunchTask(args.meshId, eventSessionId, Date.now());
        if (inWindowTask) {
            const causalEvidence = MeshRuntimeStore.getInstance().taskDeliveryConsumed(args.meshId, inWindowTask.id)
                || hasMatchingTaskDispatchedLedgerEntry(args.meshId, inWindowTask.id, eventSessionId);
            if (!causalEvidence) {
                LOG.warn('MeshEvents', `Suppressed premature agent:generating_completed for auto-launch session ${eventSessionId} (mesh ${args.meshId}): task ${inWindowTask.id} delivery not yet consumed and no turn-start evidence — likely a boot artifact before the task was ever dispatched`);
                traceMeshEventDrop('autolaunch_completion_before_causal_evidence', traceCtx, `taskId=${inWindowTask.id}`);
                return {
                    kind: 'suppress',
                    result: { success: true, forwarded: 0, suppressed: true, autoLaunchCausalGateFailed: true, taskId: inWindowTask.id },
                };
            }
        }
        const terminal = findRecentTerminalLedgerEvidence({
            meshId: args.meshId,
            sessionId: eventSessionId,
            nodeId: eventNodeId || undefined,
        });
        if (terminal?.kind === 'task_completed' && !sessionHasActiveAssignment(args.meshId, eventSessionId)) {
            const newDispatchAfterTerminal = hasDispatchAfterTerminal(args.meshId, eventSessionId, terminal.id);
            // Fix B (re-dispatch 2nd-completion routing): a prior terminal recorded from a FALSE
            // idle (weak evidence / no confirmed final assistant) must NOT permanently suppress a
            // later GENUINE completion of the same session. providerSessionId is stable across a
            // session's turns, so the providerSessionId/finalSummary dedup below would otherwise
            // swallow the real 2nd-turn completion that a coordinator nudge (direct re-dispatch)
            // drove — exactly the missed-event bug. When the prior terminal was weak and the new
            // event carries genuine completion evidence, let it through so it is recorded and
            // re-attributed to the latest task (the normal task_completed path below).
            const supersedesWeakTerminal = isWeakCompletionEvidence(terminal.payload)
                && isGenuineCompletionEvidence(args.metadataEvent)
                // P1-5a follow-up: a weak SYNTH terminal is supersedable by a later GENUINE
                // completion, but a re-injected reconcile replay (same synth event, same
                // summary) is NOT a genuine completion — it must still dedup against its own
                // terminal (NOTIF-MISS FIX 2 "no regression" invariant). Gate the supersession
                // on the incoming event being a REAL provider completion, the same bar
                // supersedesSynthesizedTerminal below applies.
                && isRealProviderCompletionEvent(args.metadataEvent);
            // CANON-B (direct-dispatch completion race): a FAST direct dispatch (mesh_send_task)
            // to an already-idle, previously-used session can have its genuine completion reach
            // this coordinator handler BEFORE the dispatching side records the new task's dispatch
            // row / task_dispatched ledger entry — insertDirectDispatch + appendLedgerEntry both run
            // AFTER the agent_command await resolves, while the worker may already be done. In that
            // window sessionHasActiveAssignment is false (no active dispatch row, no unterminal
            // ledger entry yet), so this prior-terminal dedup engages; and because providerSessionId
            // is STABLE across a reused session's turns, the providerSessionId/finalSummary match
            // below would suppress the NEW task's completion as a duplicate of the PRIOR task —
            // silently losing it (the observed intermittent miss; fresh enqueue/autoLaunch is immune
            // because a fresh session has no prior same-providerSessionId terminal and the queue row
            // is claimed atomically before dispatch). The echoed taskId is the authoritative
            // discriminator: when the completion names a DIFFERENT task than the recorded terminal,
            // it is a genuinely new task's completion, never a duplicate — let it through so it is
            // attributed to its own taskId. A same-task re-arrival (taskId equal) or a taskId-less
            // legacy event still falls through to the providerSessionId/finalSummary dedup.
            const terminalTaskId = readNonEmptyString(terminal.payload.taskId);
            const eventTaskId = readNonEmptyString(args.metadataEvent.taskId);
            const distinctTaskCompletion = !!eventTaskId && !!terminalTaskId && eventTaskId !== terminalTaskId;
            // (FALSEIDLE-BGCHILD-b) Same-task genuine completion carrying a fuller summary than the
            // recorded (truncated, false-idle-pre-empted) terminal supersedes it — see helper.
            const supersedesTruncatedTerminal = supersedesTruncatedTerminalSummary({
                terminalPayload: terminal.payload,
                metadataEvent: args.metadataEvent,
                terminalTaskId,
                eventTaskId,
            });
            // NOTIF-MISS (FIX 2): the recorded terminal was SYNTHESIZED by transcript reconciliation
            // (no real provider event), and THIS incoming event is the authoritative REAL provider
            // completion. The reconcile path may fire ~1s after a direct dispatch from a reused
            // session's stale transcript tail, writing a synthesized terminal whose providerSessionId
            // (stable across a session's turns) and/or finalSummary then match the real completion —
            // so the providerSessionId/finalSummary dedup below would drop the genuine event and the
            // coordinator would never learn the task finished. A synthesized record must NEVER
            // permanently mask the real completion: let the real event through (it is re-recorded by
            // the normal task_completed path, superseding the synthesized one). A second SYNTHESIZED
            // re-arrival is NOT a real event and still dedups normally.
            // RECONCILE-SYNTH-PREEMPTS-COMPLETION: the bar here is deliberately LOWER than the
            // weak/truncated supersessions above — a synthesized terminal is a coordinator-side
            // reconstruction, never a real provider event, so ANY genuine real provider completion
            // for the session must win over it. Requiring the full isGenuineCompletionEvidence
            // (finalSummary OR workerResult present) dropped the real event whenever the relay did
            // not re-populate finalSummary at this layer — exactly the observed 71s task whose real
            // generating_completed hit drop:duplicate_completion_terminal_ledger after a premature
            // synth. We require only that the incoming event is a REAL provider completion that is
            // not itself a false idle (missing-final-assistant); a real-but-false-idle event still
            // does not supersede (it is not trustworthy terminal evidence either).
            const supersedesSynthesizedTerminal = isSynthesizedReconciledTerminal(terminal.payload)
                && isRealProviderCompletionEvent(args.metadataEvent)
                && !isFalseIdleCompletion(args.metadataEvent);
            if (!newDispatchAfterTerminal && !supersedesWeakTerminal && !distinctTaskCompletion && !supersedesTruncatedTerminal && !supersedesSynthesizedTerminal) {
                const terminalProviderSessionId = readNonEmptyString(terminal.payload.providerSessionId);
                const terminalFinalSummary = readNonEmptyString(terminal.payload.finalSummary);
                const eventProviderSessionId = readNonEmptyString(args.metadataEvent.providerSessionId);
                const eventFinalSummary = readNonEmptyString(args.metadataEvent.finalSummary);
                if (
                    (terminalProviderSessionId && terminalProviderSessionId === eventProviderSessionId)
                    || (terminalFinalSummary && terminalFinalSummary === eventFinalSummary)
                    || args.metadataEvent.source === 'no_progress_reconciliation'
                ) {
                    LOG.info('MeshEvents', `Suppressed duplicate completion with existing terminal ledger evidence for mesh ${args.meshId} session ${eventSessionId}`);
                    traceMeshEventDrop('duplicate_completion_terminal_ledger', traceCtx);
                    return { kind: 'suppress', result: { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true, terminalLedgerEvidence: true } };
                }
            }
        }
        const duplicateCompletion = isDuplicateMeshCompletionEvent({
            meshId: args.meshId,
            event: args.event,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
            timestamp: eventTimestamp,
            finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
            coordinatorDaemonId: workerCoordinatorDaemonId || undefined,
            taskId: readNonEmptyString(args.metadataEvent.taskId) || undefined,
            nodeId: eventNodeId || undefined,
        });
        if (duplicateCompletion) {
            LOG.info('MeshEvents', `Suppressed duplicate completion for mesh ${args.meshId} session ${eventSessionId}`);
            traceMeshEventDrop('duplicate_completion', traceCtx);
            return { kind: 'suppress', result: { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true } };
        }
    }
    if (args.event === 'agent:stopped' && eventSessionId) {
        const duplicateStopped = isDuplicateMeshCompletionEvent({
            meshId: args.meshId,
            event: args.event,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
            timestamp: eventTimestamp,
            finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
            coordinatorDaemonId: workerCoordinatorDaemonId || undefined,
            taskId: readNonEmptyString(args.metadataEvent.taskId) || undefined,
            nodeId: eventNodeId || undefined,
        });
        if (duplicateStopped) {
            LOG.info('MeshEvents', `Suppressed duplicate stopped event for mesh ${args.meshId} session ${eventSessionId}`);
            traceMeshEventDrop('duplicate_stopped', traceCtx);
            return { kind: 'suppress', result: { success: true, forwarded: 0, suppressed: true, duplicateStopped: true } };
        }
    }

    return null;
}

/**
 * APPROVAL-INBOX-BLINDSPOT (Fix A): decide whether an agent:waiting_approval from an
 * auto-approving worker can be SUPPRESSED (never forwarded to the coordinator).
 *
 * A MAGI/delegated worker launched with autoApprove:true resolves its own approval modals
 * locally, so a forwarded agent:waiting_approval is transient noise: it injects a
 * "[System] … is waiting for approval, use mesh_approve" turn the coordinator cannot usefully
 * act on (the modal is already auto-resolving) and, mid-MAGI-collect, HIJACKS the
 * coordinator's synthesis turn — the observed failure where a replica's repeated
 * auto-approvals drowned out the completion events.
 *
 * BUT the OLD gate suppressed on the autoApprove *intent* alone (settings.autoApprove===true),
 * which is the blind spot: if the worker's local resolveModal never actually fired/resolved
 * (button-index mismatch, a modal auto-approve declined to answer, an unattended stall), the
 * event was STILL dropped — so no task_approval_needed ledger row was created,
 * mesh_list_pending_approvals stayed 0, the coordinator was never told, and the remote
 * UNKNOWN-grace reclaim eventually tore the worker off its task. This tightens the gate:
 * suppress ONLY when auto-approve is on AND we can positively confirm the modal was — or is
 * being — resolved LOCALLY within the recent cooldown (approvalRecentlyResolvedLocally). If
 * auto-approve is configured but has NOT actually resolved this modal, we FORWARD so the
 * coordinator/inbox is told and can act.
 */
export function shouldSuppressAutoApprovingWorkerApproval(components: DaemonComponents, sessionId: string): boolean {
    if (!sessionId) return false;
    try {
        const instance = components.instanceManager?.getInstance?.(sessionId);
        const state = instance?.getState?.();
        const settings = (state?.settings as Record<string, unknown>) || {};
        if (settings.autoApprove !== true) return false;
        // Positive local-resolution signal required to suppress. Absent it, forward so the
        // coordinator is told and a task_approval_needed ledger row is created.
        const resolvedLocally = (instance as { approvalRecentlyResolvedLocally?: () => boolean } | undefined)
            ?.approvalRecentlyResolvedLocally;
        return typeof resolvedLocally === 'function' ? resolvedLocally.call(instance) === true : false;
    } catch {
        return false;
    }
}

/**
 * TURN-LEDGER (Stage 5): deliver due durable outbox rows (coordinator-bound terminal
 * notifications) into the pending-events queue. Exactly-once is preserved TWO ways:
 * the outbox row id (`<attemptId>:terminal`) is INSERT-OR-IGNORE at enqueue, and the
 * pending-events fingerprint dedup collapses a redelivery onto the same
 * [meshId, event, taskId, weak|genuine] fingerprint the original completion used —
 * so a crash between the reducer's terminal commit and the normal queue write, or a
 * restart with a pending outbox row, still yields exactly one coordinator completion.
 */
export async function drainMeshTurnOutbox(opts?: { meshId?: string }): Promise<{ delivered: number; failed: number; rescheduled: number }> {
    return drainTurnOutbox(async (row) => {
        const payload = row.payload as Record<string, unknown>;
        const event = typeof payload.event === 'string' ? payload.event : 'agent:generating_completed';
        const metadataEvent: Record<string, unknown> = {
            ...(row.taskId ? { taskId: row.taskId } : {}),
            ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
            ...(typeof payload.providerType === 'string' ? { providerType: payload.providerType } : {}),
            // Fingerprint parity with the original completion: weak originals stamped
            // evidenceLevel=insufficient; a bare record (no completionDiagnostic) reads
            // as genuine — see isWeakCompletionEvidence / buildPendingEventFingerprint.
            ...(payload.weak === true ? { evidenceLevel: 'insufficient' } : {}),
            source: 'turn_outbox_redelivery',
            outboxRedelivery: true,
        };
        const queued = queuePendingMeshCoordinatorEvent({
            event,
            meshId: row.meshId,
            nodeId: typeof payload.nodeId === 'string' ? payload.nodeId : undefined,
            metadataEvent,
            queuedAt: Date.now(),
        } as PendingMeshCoordinatorEvent);
        if (!queued) throw new Error('pending queue rejected outbox redelivery');
    }, { meshId: opts?.meshId });
}

let turnOutboxDrainScheduled = false;

/** Best-effort async drain trigger (coalesced) after a terminal commit enqueued a row. */
export function scheduleTurnOutboxDrain(): void {
    if (turnOutboxDrainScheduled) return;
    turnOutboxDrainScheduled = true;
    setImmediate(() => {
        turnOutboxDrainScheduled = false;
        drainMeshTurnOutbox().catch(() => { /* failure leaves rows pending — retried on the next trigger/boot drain */ });
    });
}

/**
 * REDRIVE-DUP: stop a worker session that started a STALE (reclaimed) mesh dispatch,
 * so it discards the reclaimed task before it double-executes it. Prefers the local
 * transport when the session's adapter lives on this daemon; otherwise forwards a
 * `stop_cli` to the worker node's daemon over P2P (best-effort — a failed stop only
 * loses the belt-and-suspenders stop; the ack was already rejected, so the coordinator
 * never treats the stale run as the authoritative execution).
 */
export function stopStaleMeshWorker(
    components: DaemonComponents,
    args: { meshId: string; sessionId: string; nodeId?: string; providerType?: string; daemonId?: string },
): void {
    const { meshId, sessionId, providerType } = args;
    // TURN-LEDGER (Stage 5): a destructive stop/kill/teardown is strictly ordered AFTER
    // every evidence collection already in flight for this session (and the reducer
    // decision built on it). The historical 6ms race issued a transcript read and a
    // stop CONCURRENTLY against the same session, and teardown destroyed the only
    // evidence source before the read completed. The per-session ordering chain makes
    // that interleaving structurally impossible — this stop runs only after prior
    // reads resolve. Fire-and-forget from the caller's perspective, as before.
    void runSessionDestructiveAction(sessionId, () => {
        const stopArgs: Record<string, unknown> = {
            targetSessionId: sessionId,
            ...(providerType ? { cliType: providerType } : {}),
            mode: 'hard',
            reason: 'stale_mesh_dispatch_reclaimed',
        };
        try {
            const isLocal = components.cliManager?.adapters?.has?.(sessionId) === true;
            if (isLocal) {
                // cliType is required by stop_cli; resolve it from the local adapter when the
                // event carried no providerType.
                if (!stopArgs.cliType) {
                    const localType = components.cliManager?.adapters?.get?.(sessionId)?.cliType;
                    if (localType) stopArgs.cliType = localType;
                }
                Promise.resolve(components.cliManager?.handleCliCommand?.('stop_cli', stopArgs))
                    .catch((e: any) => LOG.warn('MeshQueue', `Local stop of stale worker ${sessionId} failed: ${e?.message || e}`));
                return;
            }
            // Remote: resolve the worker node's daemon id (event metadata first, then the mesh node).
            let daemonId = args.daemonId;
            if (!daemonId && args.nodeId) {
                try {
                    const mesh = getMeshWithCache(components, meshId);
                    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, args.nodeId!));
                    daemonId = node ? readMeshNodeDaemonId(node) || undefined : undefined;
                } catch { /* best-effort */ }
            }
            if (daemonId && components.dispatchMeshCommand) {
                // OFFLINE-NODE-BLOCKING: this stop is fire-and-forget. Without a short connect-wait,
                // a stop_cli to a worker node whose daemon is powered off leaves a pending request
                // hanging for the full 90s connect deadline before its .catch fires (a leaked
                // pending per stale worker). Stamp the status-origin marker so the daemon-cloud relay
                // grants the SHORT connect-wait budget — an offline node rejects in ~2s and the .catch
                // logs it immediately. The marker only affects the connect wait and is stripped before
                // stop_cli executes, so a live worker is stopped identically. (Best-effort by design:
                // a failed stop only loses the belt-and-suspenders stop; the ack was already rejected.)
                Promise.resolve(components.dispatchMeshCommand(daemonId, 'stop_cli', withStatusProbeMarker(stopArgs)))
                    .catch((e: any) => LOG.warn('MeshQueue', `Remote stop of stale worker ${sessionId} on daemon ${daemonId} failed: ${e?.message || e}`));
            } else {
                LOG.warn('MeshQueue', `Cannot stop stale worker ${sessionId}: no local adapter and no resolvable remote daemon id (node ${args.nodeId ?? '?'}). Ack already rejected — task will re-strand-and-fail if the worker completes.`);
            }
        } catch (e: any) {
            LOG.warn('MeshQueue', `stopStaleMeshWorker error for ${sessionId}: ${e?.message || e}`);
        }
    });
}

/**
 * TASK-PROMPT-REDRIVE-AFTER-COMPLETE (Fix C): a genuine completion echoed a taskId whose queue
 * row is NOT 'assigned' anymore — because the assigned-stranded watchdog RE-DROVE it (long
 * delivered-no-turn deadline / unknown-grace) while this very completion was still in flight.
 * For an autoLaunch/worktree worker the turn-lifecycle events don't reliably reach the
 * coordinator ledger, so the deadline fires before the completion propagates (observed live at
 * 0.9s–98s late). The re-drive re-injects the SAME prompt into the already-finished worker (the
 * owner's symptom). This late completion PROVES the original turn finished, so it SUPERSEDES the
 * re-drive: flip the row terminal and stop any duplicate re-dispatch.
 *
 * Bounded to a row reclaimed for a RE-DRIVE reason within {@link REDRIVE_SUPERSEDE_WINDOW_MS} of
 * its `requeuedAt` — outside that window a `pending` row is an unrelated retry (or a fresh
 * re-dispatched turn whose own completion this is not), and is left untouched. Returns true when
 * it superseded the re-drive (row flipped terminal), false to fall through to normal handling.
 */
export function supersedeRedriveReclaimForLateCompletion(
    components: DaemonComponents,
    meshId: string,
    row: MeshWorkQueueEntry,
    completingSessionId: string,
    outcome: 'completed' | 'failed',
    args: { nodeId?: string; event: string; metadataEvent: Record<string, unknown> },
): boolean {
    // Only a re-drive reclaim is superseded. A row reclaimed as never-delivered
    // (assigned_stranded_dispatch_unconfirmed) never ran, so a completion for it is not a
    // late race — leave it to the normal path. A row already terminal is a no-op.
    if (!row.requeueReason || !REDRIVE_RECLAIM_REASONS.has(row.requeueReason)) return false;
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') return false;
    const requeuedAtMs = Date.parse(row.requeuedAt ?? '');
    if (!Number.isFinite(requeuedAtMs)) return false;
    if (Date.now() - requeuedAtMs > REDRIVE_SUPERSEDE_WINDOW_MS) return false;

    // The re-drive may have already re-dispatched the SAME prompt onto a FRESH session (row is
    // 'assigned' again to a different session). That duplicate is executing work the original
    // worker already finished — stop it so the prompt is not run twice. (When the row is still
    // 'pending' there is no duplicate yet; flipping it terminal below prevents PHASE 3 from ever
    // re-dispatching it.)
    const reDispatchedSessionId = row.assignedSessionId;
    if (
        row.status === 'assigned'
        && reDispatchedSessionId
        && !sessionIdsEquivalent(reDispatchedSessionId, completingSessionId)
    ) {
        stopStaleMeshWorker(components, {
            meshId,
            sessionId: reDispatchedSessionId,
            nodeId: row.assignedNodeId,
            providerType: row.assignedProviderType,
        });
    }

    // Flip the row terminal by its exact id (immune to the cleared session ownership) and record
    // the terminal ledger evidence, so the reconcile watchdog's terminal-ledger branch also sees
    // it and no further reclaim fires.
    endTaskDispatchInFlight(meshId, row.id);
    updateTaskStatus(meshId, row.id, outcome === 'completed' ? 'completed' : 'failed');
    if (!findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id })) {
        try {
            appendLedgerEntry(meshId, {
                kind: outcome === 'completed' ? 'task_completed' : 'task_failed',
                sessionId: completingSessionId,
                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                payload: {
                    taskId: row.id,
                    event: args.event,
                    source: 'redrive_late_completion_supersede',
                    reclaimReason: row.requeueReason,
                    reclaimAgeMs: Date.now() - requeuedAtMs,
                    finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
                },
            });
        } catch { /* best-effort ledger write */ }
    }
    LOG.warn('MeshQueue', `Late completion superseded re-drive for task ${row.id} on mesh ${meshId} `
        + `(reclaimed '${row.requeueReason}' ${Math.round((Date.now() - requeuedAtMs) / 1000)}s ago; completing session ${completingSessionId}) `
        + `→ flipped ${outcome}${(row.status === 'assigned' && reDispatchedSessionId && !sessionIdsEquivalent(reDispatchedSessionId, completingSessionId)) ? `, stopped duplicate re-dispatch on ${reDispatchedSessionId}` : ''}`);
    traceMeshEventDrop('redrive_late_completion_supersede', {
        taskId: row.id,
        sessionId: completingSessionId,
        nodeId: row.assignedNodeId ?? args.nodeId,
        meshId,
        event: args.event,
    }, `${row.requeueReason} ${Math.round((Date.now() - requeuedAtMs) / 1000)}s → ${outcome}`);
    return true;
}

/**
 * STALE-APPROVAL-AFTER-TERMINAL (terminal-stale-approval-projection): terminal authority
 * for a task — the evidence after which a waiting_approval / waiting_choice naming that
 * task can only be STALE. Any of:
 *   1. the turn reducer's current attempt for the task is terminal (committed via
 *      proposeTurnCompletion — genuine completions only);
 *   2. the queue row itself is terminal (completed/failed/cancelled);
 *   3. a non-weak task_completed / task_failed terminal ledger entry names the task
 *      (findTerminalLedgerEvidenceForTask already excludes weak/false-idle completions).
 * Deliberately NOT authority:
 *   - a WEAK / false-idle completion (the worker may still be mid-turn — a following
 *     approval can be genuine);
 *   - task_stalled (a stalled task can resume and genuinely block on an approval);
 *   - an autoLaunch 'completed' record (that marks the LAUNCH, not the task result).
 * A genuine approval always PRECEDES the terminal — at that point none of this exists,
 * so it is never touched by the guard.
 */
export function hasTerminalAuthorityForTask(meshId: string, taskId: string): boolean {
    try {
        const row = resolveTurnAttemptRow({ meshId, taskId });
        if (row && (row.terminalOutcome || isTerminalTurnStage(row.stage))) return true;
    } catch { /* best-effort — fall through to the other authority signals */ }
    try {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (entry && (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled')) return true;
    } catch { /* best-effort */ }
    try {
        const evidence = findTerminalLedgerEvidenceForTask({ meshId, taskId });
        if (evidence && evidence.kind !== 'task_stalled') return true;
    } catch { /* best-effort */ }
    return false;
}
