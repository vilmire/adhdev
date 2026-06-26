import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { getMesh, getMeshByRepo, listMeshes } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, getSessionRecoveryContext, isIntentionalCleanupStopEntry, readLedgerEntries } from './mesh-ledger.js';
import type { SessionRecoveryContext } from './mesh-ledger.js';
import { updateSessionTaskStatus, enqueueTask, updateDirectDispatchStatus, cleanupTerminalDirectDispatches, getActiveDirectDispatches, hasPendingDependents } from './mesh-work-queue.js';
import { markSessionDeliveriesTerminal, updateSessionDeliveryStatus, recordCompletionConflict } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import { resolveWorkerDelegateRouting, recordUnroutableDelegateEvent, isUnroutableDelegateRejection } from './mesh-routing.js';
import { resolveMeshHostStatus } from './mesh-host-ownership.js';
import { enqueueUnresolvedDelegateForward, peekUnresolvedDelegateForwards, ackUnresolvedDelegateForward } from './mesh-unresolved-forward-outbox.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { getLastDisplayMessage } from '../status/snapshot.js';
import { resolveDelegatedWorkerAutoApprove } from '../repo-mesh-types.js';
import { meshNodeIdMatches, daemonIdsEquivalent, expandDaemonIdForms, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import {
    findRecentTerminalLedgerEvidence,
    hasDispatchAfterTerminal,
    hasUnterminalDirectDispatchLedgerEntry,
    buildNoProgressCompletionReconciliation,
} from './mesh-events-stale.js';
import {
    buildMeshSystemMessage,
    readNonEmptyString,
    resolveEventSessionId,
    readRefineJobId,
    readWorkerResultMetadata,
    resolveMeshSurfacedSessionPreview,
    isFalseIdleCompletion,
    isWeakCompletionEvidence,
} from './mesh-events-utils.js';
import { isMeshCoordinatorEvent, shouldForceInjectMeshEvent, EVENT_TO_LEDGER_KIND } from './mesh-event-classify.js';
import {
    getMeshWithCache,
    tryAssignQueueTask,
    triggerMeshQueue,
    runIdleMaintenanceThenAssignQueue,
    maybeAutoFastForwardIdleNode,
    sessionHasActiveAssignment,
} from './mesh-queue-assignment.js';

// The set of coordinator-daemon ids this daemon answers to when draining the
// pending-events queue. Mirrors resolveCoordinatorDaemonIds in mesh-reconcile-loop:
// a unicast event may be stamped with the status id, the bare machineId, OR the
// config-form node daemonId (`daemon_<machineId>`) depending on which dispatch path
// created the worker. We expand to EVERY equivalent form so a `daemon_<machineId>`
// completion matches a coordinator that knows itself as bare `<machineId>` (the
// base-node completion-surface bug) and vice versa.
function resolveCoordinatorDrainDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    return expandDaemonIdForms([statusInstanceId, machineId]);
}

// ---------------------------------------------------------------------------
// Remote Node Idle Session Tracking
// ---------------------------------------------------------------------------
const REMOTE_IDLE_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Workspace-to-mesh lookup cache
// ---------------------------------------------------------------------------
const meshByWorkspaceCache = new Map<string, { mesh: any; cachedAt: number }>();
const MESH_WORKSPACE_CACHE_TTL_MS = 5_000;

function getCachedMeshByWorkspace(workspace: string): any {
    const now = Date.now();
    const cached = meshByWorkspaceCache.get(workspace);
    if (cached && now - cached.cachedAt < MESH_WORKSPACE_CACHE_TTL_MS) return cached.mesh;
    const mesh = getMeshByRepo(workspace);
    meshByWorkspaceCache.set(workspace, { mesh, cachedAt: now });
    return mesh;
}

// Deterministic meshId recovery for a forwarded worker event that carries no meshId.
// An unresolved-mesh worker (forwardUnresolvedDelegateEvent) cannot resolve its own
// meshId locally, so it pushes the event with nodeId + workspace only and relies on
// the coordinator — which hosts the mesh — to recover the id. Workspace recovery
// (getCachedMeshByWorkspace → getMeshByRepo) is the fast path but can miss (a worktree
// clone whose repoIdentity differs, or a transient cache state), which left the retry
// permanently rejected with "meshId required". The node-id IS a stable, coordinator-side
// fact: scan the hosted meshes for the one whose node matches the forwarded nodeId
// (3-form normalizer). This is timing-independent and never depends on repo lookup.
function recoverMeshIdByNodeId(nodeId: string): string {
    if (!nodeId) return '';
    for (const mesh of listMeshes()) {
        if (Array.isArray(mesh.nodes) && mesh.nodes.some((n: any) => meshNodeIdMatches(n, nodeId))) {
            return readNonEmptyString(mesh.id);
        }
    }
    return '';
}

// MESHID-DROP coordinator-anchor recovery (Fix B): the last-resort meshId recovery for an
// unresolved-delegate forward whose payload carries the worker's coordinator anchor
// (meshCoordinatorDaemonId) but no resolvable meshId — neither workspace nor nodeId scan
// matched (a freshly-cloned worktree node not yet registered under the forwarded id form, or
// an empty payload nodeId). The receiving daemon IS the coordinator/host, so scope to the
// meshes IT hosts whose host daemon matches the anchor (daemonIdsEquivalent — never a raw
// compare, so daemon_mach_/mach_/standalone_ forms all match the same machine). Among those:
//   • a nodeId → the mesh whose nodes contain it (meshNodeIdMatches 3-form) wins;
//   • no nodeId → fall back to the anchor's SINGLE hosted mesh only. Ambiguity (the anchor
//     hosts >1 mesh and no node disambiguates) returns '' rather than guess — a wrong meshId
//     would inject the completion into an unrelated mesh's ledger, worse than the retry-cap drop.
export function recoverMeshIdByCoordinatorAndNode(coordinatorDaemonId: string, nodeId: string): string {
    if (!coordinatorDaemonId) return '';
    const hosted = listMeshes().filter(mesh => {
        const host = resolveMeshHostStatus(mesh);
        return host.role === 'host'
            && (!host.hostDaemonId || daemonIdsEquivalent(host.hostDaemonId, coordinatorDaemonId));
    });
    if (hosted.length === 0) return '';
    if (nodeId) {
        const byNode = hosted.find(mesh =>
            Array.isArray(mesh.nodes) && mesh.nodes.some((n: any) => meshNodeIdMatches(n, nodeId)));
        if (byNode) return readNonEmptyString(byNode.id);
        // nodeId present but matched no hosted mesh — do NOT fall through to the single-mesh
        // guess; the node belongs to a mesh we don't host (or under a different id), and
        // guessing would misroute. Stay unresolved.
        return '';
    }
    // No nodeId to disambiguate: only safe when the anchor hosts exactly one mesh.
    return hosted.length === 1 ? readNonEmptyString(hosted[0].id) : '';
}

// RECONCILE-MESHID-DROP: WORKER-side meshId resolution for an unresolved-delegate
// forward payload. forwardUnresolvedDelegateEvent omits meshId by design (the worker
// "can't resolve it") and relies on the COORDINATOR recovering it from workspace/nodeId.
// That recovery fails when the no_node_binding session's payload has an empty nodeId AND
// the coordinator's workspace→mesh lookup misses (a worktree clone whose repoIdentity
// differs / a cache miss) — leaving the reconcile retry rejected with "meshId required"
// every 4s forever. The worker actually has MORE context than the stripped payload gives
// the coordinator: it hosts the node as a member and holds the LIVE session, whose
// settings.meshNodeFor / meshNodeId are authoritative even when they were not stamped
// onto the original event. Resolve here (worker side) and stamp meshId onto the payload so
// the coordinator accepts it. Mirrors the receiver's recovery order, then adds the live-
// session fallback. Returns '' when even the worker cannot resolve it (truly unresolvable —
// the retry cap then drops it instead of looping). No side effects; safe to call per retry.
export function resolveForwardEventMeshId(
    components: DaemonComponents,
    payload: Record<string, unknown>,
): string {
    const direct = readNonEmptyString(payload.meshId);
    if (direct) return direct;
    const workspace = readNonEmptyString(payload.workspace);
    const byWorkspace = workspace ? readNonEmptyString(getCachedMeshByWorkspace(workspace)?.id) : '';
    if (byWorkspace) return byWorkspace;
    const byNode = recoverMeshIdByNodeId(readNonEmptyString(payload.nodeId));
    if (byNode) return byNode;
    // Live-session fallback: the worker session may carry meshNodeFor / meshNodeId now even
    // though the original event didn't (a late stamp, or an event that fired before binding).
    const sessionId = readNonEmptyString(payload.targetSessionId)
        || readNonEmptyString(payload.sessionId)
        || readNonEmptyString(payload.instanceId);
    if (sessionId) {
        try {
            const state = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
            const settings = (state?.settings as Record<string, unknown>) || {};
            const meshNodeFor = readNonEmptyString(settings.meshNodeFor);
            if (meshNodeFor) return meshNodeFor;
            const byStamp = recoverMeshIdByNodeId(readNonEmptyString(settings.meshNodeId));
            if (byStamp) return byStamp;
            const sessionWorkspace = readNonEmptyString(state?.workspace);
            const bySessionWorkspace = sessionWorkspace ? readNonEmptyString(getCachedMeshByWorkspace(sessionWorkspace)?.id) : '';
            if (bySessionWorkspace) return bySessionWorkspace;
        } catch { /* best-effort — fall through to unresolved */ }
    }
    return '';
}


export function __resetMeshWorkspaceCacheForTests(): void {
    meshByWorkspaceCache.clear();
}

function sweepExpiredRemoteIdleSessions(): void {
    try {
        MeshRuntimeStore.getInstance().pruneExpiredRemoteIdleSessions();
    } catch { /* best-effort */ }
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
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const timestamp = new Date(entry.timestamp).getTime();
        if (!Number.isNaN(timestamp) && timestamp < cutoff) break;
        if (!isIntentionalCleanupStopEntry(entry)) continue;
        if (sessionId && entry.sessionId === sessionId) return true;
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

function readEventTimestamp(value: unknown): number | null {
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
        if (args.taskId) {
            recordCompletionConflict({
                meshId: args.meshId,
                fingerprint,
                conflictingTaskId: args.taskId,
                conflictingSessionId: args.sessionId,
                event: args.event,
            });
        }
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
function resolveActiveDirectDispatchTaskId(meshId: string, sessionId: string): string | undefined {
    try {
        const matches = getActiveDirectDispatches(meshId).filter(d => d.sessionId === sessionId);
        if (!matches.length) return undefined;
        // getActiveDirectDispatches returns rows ordered by dispatched_at ASC; the last is
        // the most recent dispatch (the re-dispatch / nudge whose completion this is).
        return readNonEmptyString(matches[matches.length - 1].taskId) || undefined;
    } catch {
        return undefined;
    }
}

// Coordinator-side suppression/reconcile gate for an incoming mesh event. Each clause is a
// closed dedup/suppression concern that only inspects the event + already-resolved context and
// either (a) returns a `suppress` result the caller forwards verbatim, (b) returns a `reconcile`
// signal carrying the rewritten metadataEvent for the caller to re-inject as
// agent:generating_completed, or (c) returns null to let the event fall through to the
// terminal/ledger machinery. Extracted verbatim from injectMeshSystemMessage — no behavior
// change; the only side effects (best-effort remote-idle cleanup, LOG, trace) fire on the same
// paths as before.
function evaluateMeshEventSuppression(
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
    },
):
    | { kind: 'suppress'; result: { success: true; forwarded: 0; suppressed: true; [extra: string]: unknown } }
    | { kind: 'reconcile'; metadataEvent: Record<string, unknown> }
    | null {
    const { traceCtx, eventSessionId, eventNodeId, eventTimestamp, workerCoordinatorDaemonId } = ctx;

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
                && isGenuineCompletionEvidence(args.metadataEvent);
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

function injectMeshSystemMessage(components: DaemonComponents, args: {
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
}) {
    const eventSessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
    const eventNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);

    // EVTTRACE correlation context for this event's coordinator-side lifecycle (queue /
    // dedup / suppress). Observation only — never read by any decision below.
    const traceCtx = {
        taskId: args.metadataEvent.taskId,
        sessionId: eventSessionId,
        nodeId: eventNodeId,
        meshId: args.meshId,
        event: args.event,
    };

    const sourceSession = args.sourceInstanceId
        ? components.instanceManager.getInstance(args.sourceInstanceId)
        : undefined;
    const workerCoordinatorDaemonId = readNonEmptyString(
        (sourceSession?.getState()?.settings as Record<string, unknown>)?.meshCoordinatorDaemonId,
    );
    // Session-level routing anchor (multi-coordinator). Prefer the LIVE worker session's
    // stamp; fall back to a relayed value carried in metadataEvent.meshCoordinatorSessionId
    // (a remote worker's completion arrives via handleMeshForwardEvent with no local
    // sourceSession, so the stamp can only ride in the relayed metadata). Empty on legacy /
    // version-skewed dispatches → the event stays daemon-broadcast (no regression).
    const workerCoordinatorSessionId = readNonEmptyString(
        (sourceSession?.getState()?.settings as Record<string, unknown>)?.meshCoordinatorSessionId,
    ) || readNonEmptyString(args.metadataEvent.meshCoordinatorSessionId);

    // T2: a summary-less completion (and any non-completion status-sync event) carries no
    // assistant text on the event, so resolveMeshSurfacedSessionPreview had nothing to surface
    // and the coordinator's inbox mirror stayed stuck on the first dispatched user task. When
    // THIS daemon hosts the live worker instance (sourceSession present), derive the worker's
    // latest display message straight from its transcript and attach it to the event as
    // lastMessagePreview/lastMessageRole/lastMessageAt. resolveMeshSurfacedSessionPreview reads
    // these as an assistant-only fallback; they also ride the pending-queue + P2P relay
    // (handleMeshForwardEvent whitelist) so a remote coordinator can surface them. A remote
    // coordinator has no local instance and keeps relying on the relayed fields — unchanged.
    const enrichedMetadataEvent = ((): Record<string, unknown> => {
        const last = sourceSession ? getLastDisplayMessage(sourceSession.getState()) : null;
        if (!last || !last.preview) return args.metadataEvent;
        return {
            ...args.metadataEvent,
            lastMessagePreview: last.preview,
            lastMessageRole: last.role,
            ...(last.receivedAt > 0 ? { lastMessageAt: last.receivedAt } : {}),
        };
    })();

    // R2: cloud P2P dashboard metadata sync. The cloud daemon used to do this from its own
    // relay listener; now the single core forwarder invokes the injected hook (no-op on
    // standalone) so the event path stays single-listener and the local code path is identical
    // across standalone and cloud.
    if (components.onMeshCoordinatorEventForwarded) {
        try {
            // T: the coordinator surfaces a remote worker's session but holds no local
            // instance for it, so the status snapshot can't derive a preview and the
            // mirror would stay stuck on the first dispatched user task. Resolve the
            // worker's latest assistant reply (carried on the completion event's
            // finalSummary / workerResult) into a preview the mirror can stamp, so the
            // mobile inbox reflects the assistant response. Completion events carry assistant
            // text as finalSummary; a summary-less completion / status sync falls back to the
            // worker's latest assistant display message (enrichedMetadataEvent.lastMessage*).
            // For a mid-turn user-only event this is undefined and the prior surfaced preview
            // is preserved downstream (no clobber).
            const surfacedPreview = resolveMeshSurfacedSessionPreview(enrichedMetadataEvent);
            components.onMeshCoordinatorEventForwarded({
                event: args.event,
                meshId: args.meshId,
                nodeId: eventNodeId || undefined,
                ...enrichedMetadataEvent,
                // Ensure a `workspace` field reaches updateMeshOwnedSession even when the
                // worker provider event only carried `workspaceName`. The merge spread of
                // metadataEvent above wins when it already has a non-empty `workspace`.
                workspace: readNonEmptyString(args.metadataEvent.workspace)
                    || readNonEmptyString(args.metadataEvent.workspaceName)
                    || undefined,
                ...(surfacedPreview ? {
                    meshSessionLastMessagePreview: surfacedPreview.preview,
                    meshSessionLastMessageRole: surfacedPreview.role,
                    meshSessionLastMessageAt: surfacedPreview.receivedAt || undefined,
                } : {}),
            });
        } catch { /* dashboard metadata sync is best-effort */ }
    }

    const eventTimestamp = readEventTimestamp(args.metadataEvent.timestamp);
    // Coordinator-side dedup/suppression gate (extracted, behavior-preserving). A non-null
    // outcome either short-circuits with a forwarded result or signals a no-progress→completion
    // reconciliation that we re-inject; null lets the event fall through to the ledger machinery.
    const suppression = evaluateMeshEventSuppression(args, {
        traceCtx,
        eventSessionId,
        eventNodeId,
        eventTimestamp,
        workerCoordinatorDaemonId,
    });
    if (suppression) {
        if (suppression.kind === 'reconcile') {
            return injectMeshSystemMessage(components, {
                ...args,
                event: 'agent:generating_completed',
                metadataEvent: suppression.metadataEvent,
            });
        }
        return suppression.result;
    }

    function markSessionTerminal(sessionId: string, outcome: 'completed' | 'failed', occurredAtMs?: number | null, opts?: { tentativeIfDirect?: boolean }): { id?: string } | null {
        // C2: prefer an exact taskId match when the completion event carries one —
        // it's immune to coordinator↔worker clock skew that can hide the assigned row.
        const eventTaskId = readNonEmptyString(args.metadataEvent.taskId) || undefined;
        const task = updateSessionTaskStatus(args.meshId, sessionId, outcome, {
            occurredAt: occurredAtMs != null ? new Date(occurredAtMs).toISOString() : undefined,
            taskId: eventTaskId,
        });
        // Fix A (early-terminal prevention): a false-idle completion (no confirmed final
        // assistant) for a DIRECT dispatch — i.e. no work-queue row matched — must not flip the
        // dispatch row terminal. Leaving it active lets the reconcile loop (PHASE 4) re-read the
        // transcript and record the genuine completion once the worker truly finishes (commonly
        // after a coordinator nudge / re-dispatch). A matched queue task, or a completion with
        // genuine evidence, is marked terminal as before.
        // WARMUPGAP: a no-taskId completion from a session that holds no active assignment is a
        // pre-assignment warmup / ghost event (a worker spawns, idles, and emits idle→generating→
        // completed before any task is dispatched, with meshActiveTaskId unset so the event carries
        // no taskId). Letting it through would hit the session_id fallback in updateDirectDispatchStatus
        // and flip a sibling/stale dispatch row this event does not own — the real task later lands on
        // a corrupted row and never reaches completed. Skip the dispatch update for that case. A
        // taskId-carrying completion (real task), or any completion whose session currently holds an
        // active assignment (legacy/relayed worker), still flips as before.
        const leaveDirectDispatchActive = (!task && opts?.tentativeIfDirect === true)
            || (!eventTaskId && !sessionHasActiveAssignment(args.meshId, sessionId));
        if (!leaveDirectDispatchActive) {
            // CANON-B: flip the exact dispatch row the completion echoed its taskId for; the
            // session_id fallback (no echoed taskId) still covers legacy/relayed workers.
            updateDirectDispatchStatus(args.meshId, sessionId, outcome, eventTaskId);
        }
        markSessionDeliveriesTerminal(args.meshId, sessionId, outcome);
        setImmediate(() => cleanupTerminalDirectDispatches());
        return task ? { id: task.id } : null;
    }

    let completedTaskForLedger: { id?: string } | null = null;
    // Fix B: direct-dispatch taskId used to attribute the terminal ledger entry when no
    // work-queue row matches (resolved BEFORE markSessionTerminal flips the dispatch terminal).
    let directDispatchTaskIdForLedger: string | undefined;
    if (args.event === 'agent:generating_completed') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);

        if (sessionId) {
            // CANON-B: trust the taskId the completion echoed; only fall back to the
            // most-recent-by-session heuristic when the worker carried none.
            directDispatchTaskIdForLedger = readNonEmptyString(args.metadataEvent.taskId)
                || resolveActiveDirectDispatchTaskId(args.meshId, sessionId);
            // A false-idle completion of a direct dispatch is recorded but kept tentative (the
            // dispatch row stays active for the reconcile fallback); a genuine completion is terminal.
            const isFalseIdle = isFalseIdleCompletion(args.metadataEvent);
            completedTaskForLedger = markSessionTerminal(sessionId, 'completed', eventTimestamp, { tentativeIfDirect: isFalseIdle });
            if (nodeId && providerType) {
                // OVEREAGER-REMOTE-IDLE (Defect A+B): re-register the now-idle remote session into
                // the remote-idle store, symmetric with the agent:ready branch. Previously
                // setRemoteIdleSession ran ONLY on agent:ready, while agent:generating_started
                // DELETES the entry — so the FIRST turn a remote worker runs permanently evicts it
                // from the store, and generating_completed never re-added it. A later
                // mesh_enqueue_task's triggerMeshQueue then read getRemoteIdleSessions() == 0
                // (remoteIdleSessionsChecked:0) for a session that is genuinely live-idle, needlessly
                // auto-launching a second worker (Defect A). Worse, the two idle-session sources then
                // disagreed: the enqueue drain saw 0 (store empty) and auto-launched + left the queue
                // task pending, while THIS completing session's runIdleMaintenanceThenAssignQueue
                // claimed the same still-pending row straight from SQL — so the task body injected into
                // BOTH the reused idle session and the auto-launched one (Defect B). Re-registering here
                // unifies the source: the next triggerMeshQueue drain sees the live idle session, reuses
                // it (claimed:true, no auto-launch), and injects exactly once. Skip a false-idle
                // (mid-turn / no-final-assistant) completion — that session is NOT genuinely idle.
                if (!isFalseIdle) {
                    sweepExpiredRemoteIdleSessions();
                    try {
                        MeshRuntimeStore.getInstance().setRemoteIdleSession(args.meshId, nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
                    } catch { /* best-effort */ }
                    setImmediate(() => {
                        maybeAutoFastForwardIdleNode(components, { meshId: args.meshId, nodeId, sessionId, providerType })
                            .finally(() => {
                                try {
                                    // Claim for THIS session first; on success drop the just-registered
                                    // idle entry so the enqueue drain doesn't re-pick an already-busy session.
                                    const assigned = tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                                    if (assigned) MeshRuntimeStore.getInstance().deleteRemoteIdleSession(args.meshId, nodeId, sessionId);
                                } catch (e: any) {
                                    LOG.warn('MeshQueue', `Failed to assign idle queue task after completion for ${nodeId}: ${e?.message || e}`);
                                }
                            });
                    });
                } else {
                    runIdleMaintenanceThenAssignQueue(components, { meshId: args.meshId, nodeId, sessionId, providerType });
                }
            }
            // M1-3: wake dependents of the completed task. The maintenance path above
            // only assigns to the completing session; dependents may be claimable by
            // other idle sessions, so run a full queue trigger when any are waiting.
            const completedTaskId = completedTaskForLedger?.id;
            if (completedTaskId && hasPendingDependents(args.meshId, completedTaskId)) {
                setImmediate(() => {
                    triggerMeshQueue(components, args.meshId).catch((e: any) => {
                        LOG.warn('MeshQueue', `Dependent wake after task ${completedTaskId} failed: ${e?.message || e}`);
                    });
                });
            }
        }
    } else if (args.event === 'agent:ready') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId) || undefined;
        const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary) || undefined;
        const workerResult = readWorkerResultMetadata(args.metadataEvent);
        const hasCompletionEvidence = !!finalSummary || !!workerResult;
        if (sessionId && hasCompletionEvidence) {
            completedTaskForLedger = markSessionTerminal(sessionId, 'completed');
            if (completedTaskForLedger) {
                try {
                    appendLedgerEntry(args.meshId, {
                        kind: 'task_completed',
                        nodeId: nodeId || undefined,
                        sessionId,
                        providerType: providerType || undefined,
                        payload: {
                            event: args.event,
                            nodeLabel: args.nodeLabel,
                            taskId: completedTaskForLedger.id,
                            completedViaReady: true,
                            providerSessionId,
                            finalSummary,
                            workerResult,
                            evidence: buildTaskCompletionEvidence({
                                event: 'agent:ready',
                                nodeId,
                                sessionId,
                                providerType: providerType || undefined,
                                providerSessionId,
                                finalSummary,
                                workerResult,
                            }),
                        },
                    });
                } catch (e: any) {
                    LOG.warn('MeshLedger', `Failed to record task_completed from ready: ${e?.message || e}`);
                }
            }
        }

        if (sessionId && nodeId && providerType) {
            sweepExpiredRemoteIdleSessions();
            try {
                MeshRuntimeStore.getInstance().setRemoteIdleSession(args.meshId, nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
            } catch { /* best-effort */ }
            setImmediate(() => {
                maybeAutoFastForwardIdleNode(components, { meshId: args.meshId, nodeId, sessionId, providerType })
                    .finally(() => {
                        try {
                            const assigned = tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                            if (assigned) MeshRuntimeStore.getInstance().deleteRemoteIdleSession(args.meshId, nodeId, sessionId);
                        } catch (e: any) {
                            LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${nodeId}: ${e?.message || e}`);
                        }
                    });
            });
        }
    } else if (args.event === 'agent:generating_started') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(args.meshId, nodeId, sessionId);
            } catch { /* best-effort */ }
        }
        if (sessionId) {
            // CANON-B: a generating_started that echoes its taskId acks exactly the dispatch
            // and the delivery for THAT task — not every in-flight dispatch/delivery on the
            // session. A session that already holds a freshly-dispatched (still 'dispatched')
            // sibling must keep that row 'dispatched' so its own confirm can match it; acking
            // by session would mark it 'acked' prematurely and hide a genuine non-delivery.
            const startedTaskId = readNonEmptyString(args.metadataEvent.taskId) || undefined;
            // WARMUPGAP: only ack a dispatch row when the event names its task, or the session
            // currently holds an active assignment. A no-taskId generating_started from an
            // unassigned session is a pre-assignment warmup — the session_id fallback would ack a
            // sibling/stale dispatch row this event does not own, marking it 'acked' prematurely and
            // hiding a genuine non-delivery. Skip the dispatch ack for that ghost case (the delivery
            // acks below are bound to actual deliveries and stay a no-op for a warmup session).
            //
            // MESH-DISPATCH-MISROUTE (fix 3, consumer residual): when the event carries no taskId
            // (a legacy/relayed worker whose producer never stamped meshActiveTaskId) but the
            // session owns EXACTLY ONE active dispatch, resolve that row's taskId and flip it by PK
            // instead of the session_id sweep — the sweep flips every non-terminal row for the
            // session ("may flip a sibling dispatch row"). With ≥2 active rows the owner is
            // ambiguous, so resolvedAckTaskId stays undefined and we DROP the ack rather than
            // mis-flip a sibling (the genuine ack arrives once the producer/reconcile names a task).
            if (startedTaskId) {
                updateDirectDispatchStatus(args.meshId, sessionId, 'acked', startedTaskId);
            } else if (sessionHasActiveAssignment(args.meshId, sessionId)) {
                const soleTaskId = (() => {
                    try { return MeshRuntimeStore.getInstance().getSoleActiveDirectDispatchTaskId(args.meshId, sessionId); }
                    catch { return null; }
                })();
                if (soleTaskId) {
                    updateDirectDispatchStatus(args.meshId, sessionId, 'acked', soleTaskId);
                }
            }
            const activeDeliveries = ((): { id: string; taskId: string | null }[] => {
                try { return MeshRuntimeStore.getInstance().getActiveSessionDeliveries(args.meshId, sessionId); }
                catch { return []; }
            })();
            const deliveriesToAck = startedTaskId
                ? activeDeliveries.filter(d => d.taskId === startedTaskId)
                : activeDeliveries;
            for (const d of deliveriesToAck) {
                updateSessionDeliveryStatus(d.id, 'acked');
            }
        }
    } else if (args.event === 'agent:stopped') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(args.meshId, nodeId, sessionId);
            } catch { /* best-effort */ }
        }
        if (sessionId) {
            // CANON-B: prefer the echoed taskId; session heuristic is the fallback.
            directDispatchTaskIdForLedger = readNonEmptyString(args.metadataEvent.taskId)
                || resolveActiveDirectDispatchTaskId(args.meshId, sessionId);
            completedTaskForLedger = markSessionTerminal(sessionId, 'failed');
        }
    }

    const ledgerKind = EVENT_TO_LEDGER_KIND[args.event];
    if (ledgerKind) {
        try {
            const ledgerNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined;
            const ledgerSessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined;
            const ledgerProviderType = readNonEmptyString(args.metadataEvent.providerType) || undefined;
            const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId) || undefined;
            const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary) || undefined;
            const workerResult = readWorkerResultMetadata(args.metadataEvent);
            const completionEvidence = ledgerKind === 'task_completed' && ledgerNodeId && ledgerSessionId
                ? buildTaskCompletionEvidence({
                    event: 'agent:generating_completed',
                    nodeId: ledgerNodeId,
                    sessionId: ledgerSessionId,
                    providerType: ledgerProviderType,
                    providerSessionId,
                    finalSummary,
                    workerResult,
                })
                : undefined;
            appendLedgerEntry(args.meshId, {
                kind: ledgerKind,
                nodeId: ledgerNodeId,
                sessionId: ledgerSessionId,
                providerType: ledgerProviderType,
                payload: {
                    event: args.event,
                    nodeLabel: args.nodeLabel,
                    // Fix B: fall back to the direct-dispatch taskId when no work-queue row
                    // matched, so the terminal entry is attributable in mesh task-stats
                    // (otherwise the direct task shows status='unknown' / terminalKind=null).
                    taskId: completedTaskForLedger?.id || directDispatchTaskIdForLedger || undefined,
                    providerSessionId,
                    finalSummary,
                    workerResult,
                    completionDiagnostic: args.metadataEvent.completionDiagnostic && typeof args.metadataEvent.completionDiagnostic === 'object'
                        ? args.metadataEvent.completionDiagnostic
                        : undefined,
                    evidence: completionEvidence,
                    // B2: evidenceLevel lets coordinator know when completion evidence is insufficient.
                    ...(completionEvidence
                        ? completionEvidence.workerResult.source === 'default'
                            ? { evidenceLevel: 'insufficient', reviewRecommended: true }
                            : { evidenceLevel: 'sufficient' }
                        : {}),
                },
            });
        } catch (e: any) {
            LOG.warn('MeshLedger', `Failed to record ${ledgerKind}: ${e?.message || e}`);
        }
    }

    let recoveryContext: SessionRecoveryContext | null = null;
    if (args.event === 'agent:stopped') {
        try {
            const mesh = getMesh(args.meshId);
            const maxRetries = mesh?.policy?.maxTaskRetries ?? 1;

            recoveryContext = getSessionRecoveryContext(args.meshId, {
                sessionId: resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined,
                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                maxRetries,
            });
            recoveryContext.failedProviderType = readNonEmptyString(args.metadataEvent.providerType) || null;

            if (recoveryContext.retryRecommended && recoveryContext.consecutiveNodeFailures > 0) {
                appendLedgerEntry(args.meshId, {
                    kind: 'recovery_attempted',
                    nodeId: recoveryContext.failedNodeId || undefined,
                    sessionId: recoveryContext.failedSessionId || undefined,
                    providerType: recoveryContext.failedProviderType || undefined,
                    payload: {
                        consecutiveFailures: recoveryContext.consecutiveNodeFailures,
                        taskAttemptCount: recoveryContext.taskAttemptCount,
                        retryRecommended: recoveryContext.retryRecommended,
                        advice: recoveryContext.advice,
                    },
                });

                if (recoveryContext.lastTaskMessage && recoveryContext.failedNodeId && recoveryContext.failedProviderType) {
                    const autoNodeId = recoveryContext.failedNodeId;
                    try {
                        const task = enqueueTask(args.meshId, recoveryContext.lastTaskMessage, {
                            targetNodeId: autoNodeId
                        });
                        LOG.info('MeshRecovery', `Auto-requeued failed task: ${task.id} for node ${autoNodeId}`);

                        const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, autoNodeId));
                        if (node) {
                            components.cliManager.handleCliCommand('launch_cli', {
                                cliType: recoveryContext.failedProviderType,
                                dir: node.workspace,
                                settings: {
                                    role: 'worker',
                                    meshNodeFor: args.meshId,
                                    meshNodeId: node.id,
                                    spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                                    // Coordinator-dispatched recovery relaunch: same auto-approve
                                    // policy as the primary worker launch path.
                                    autoApprove: resolveDelegatedWorkerAutoApprove(mesh?.policy, node?.policy),
                                    launchedByCoordinator: true,
                                }
                            }).catch((e: any) => LOG.error('MeshRecovery', `Failed to auto-relaunch session for ${node.id}: ${e?.message}`));
                        }
                    } catch (e: any) {
                        LOG.warn('MeshRecovery', `Failed to execute auto-recovery: ${e?.message}`);
                    }
                }
            }

            LOG.info('MeshRecovery', `Recovery context for ${args.nodeLabel}: ${recoveryContext.advice}`);
        } catch (e: any) {
            LOG.warn('MeshRecovery', `Failed to build recovery context: ${e?.message || e}`);
        }
    }

    const messageText = buildMeshSystemMessage({
        event: args.event,
        nodeLabel: args.nodeLabel,
        metadataEvent: args.metadataEvent,
        recoveryContext,
    });
    if (!messageText) {
        // Lifecycle events that carry no coordinator-facing message (agent:ready /
        // agent:generating_started) still drive the remote-claim state machine: the
        // coordinator's agent:ready branch above runs setRemoteIdleSession +
        // tryAssignQueueTask, and agent:generating_started clears the remote-idle entry.
        // For a LOCAL worker whose coordinator is a REMOTE daemon those side effects ran
        // on the wrong daemon (this worker's empty queue / store), so the coordinator never
        // learns the auto-launched session went idle and re-auto-launches it forever
        // (queue task stuck pending). Queue the silent event so the coordinator pulls it
        // (PHASE 1 pullRemoteNodeQueues → handleMeshForwardEvent) and re-runs the claim on
        // the daemon that actually owns the queue. Gate strictly on a present, REMOTE
        // coordinator daemon id: a co-located worker already ran the claim on the right
        // daemon, and a coordinator processing a *pulled* event has no sourceSession so
        // workerCoordinatorDaemonId is empty — neither re-queues, so there is no loop.
        const isSilentClaimRelevantEvent = args.event === 'agent:ready' || args.event === 'agent:generating_started';
        const coordinatorIsRemote = !!workerCoordinatorDaemonId
            && !resolveCoordinatorDrainDaemonIds(components).includes(workerCoordinatorDaemonId);
        if (!(isSilentClaimRelevantEvent && coordinatorIsRemote)) {
            return { success: false, error: 'unsupported mesh event' };
        }
    }

    // ── Queue-only delivery (single-model: queue + periodic poll) ──────────────
    // Every mesh coordinator event — terminal or not, local-coordinator or
    // remote — is persisted to the pending-events queue (SQLite + JSONL) and
    // NOTHING is pushed here. The old spontaneous-forward paths were removed:
    //   - F1 remote P2P `mesh_forward_event` dispatch (network/stamp-dependent,
    //     silently dropped on P2P failure or missing meshCoordinatorDaemonId)
    //   - F3 live-CLI PTY `send_message` fire-and-forget inject (silently
    //     dropped when the coordinator was generating)
    // Delivery to a live CLI coordinator now happens via setupMeshReconcileLoop,
    // which drains this queue on a fixed interval and injects into the coordinator
    // only when it is idle. A pure stdio MCP (LLM) coordinator — which has no live
    // CLI session to inject into — drains the queue itself when it calls a mesh
    // tool (mesh_status / mesh_read_chat). Either way the queue is the single
    // source of truth and the only thing this function writes to.
    //
    // targetCoordinatorDaemonId scopes the event to a specific coordinator daemon
    // (unicast) when the worker carries one, so the reconcile loop on the right
    // daemon drains it and other daemons skip it. Absent → broadcast/backfill.
    const pendingEvent = {
        event: args.event,
        meshId: args.meshId,
        nodeLabel: args.nodeLabel,
        nodeId: args.nodeId || undefined,
        workspace: readNonEmptyString(args.metadataEvent.workspace)
            || readNonEmptyString(args.metadataEvent.workspaceName),
        metadataEvent: {
            ...enrichedMetadataEvent,
            ...(recoveryContext ? { recoveryContext } : {}),
            // Stash the coordinator session id INSIDE metadataEvent too, so it survives the
            // P2P relay serialization (buildForwardPayloadFromPending spreads metadata; the
            // handleMeshForwardEvent whitelist reads it back) — a top-level field alone would
            // be dropped when the event crosses a machine boundary.
            ...(workerCoordinatorSessionId ? { meshCoordinatorSessionId: workerCoordinatorSessionId } : {}),
        },
        // Silent lifecycle events (agent:ready / agent:generating_started) carry no
        // coordinator message; they are queued only so the coordinator re-runs the
        // remote-claim state machine on pull. injectPendingIntoCoordinator skips
        // entries without a coordinatorMessage, so a live CLI coordinator is not spammed.
        ...(messageText ? { coordinatorMessage: messageText } : {}),
        queuedAt: Date.now(),
        ...(workerCoordinatorDaemonId ? { targetCoordinatorDaemonId: workerCoordinatorDaemonId } : {}),
        // Top-level session anchor for the local PHASE 2 strict-match on the coordinator
        // daemon. Absent → daemon-level broadcast (legacy / single-coordinator path).
        ...(workerCoordinatorSessionId ? { targetCoordinatorSessionId: workerCoordinatorSessionId } : {}),
    };
    if (queuePendingMeshCoordinatorEvent(pendingEvent)) {
        LOG.info('MeshEvents', `Queued ${args.event} for coordinator (mesh ${args.meshId}${workerCoordinatorDaemonId ? `, coordinator daemon ${workerCoordinatorDaemonId}` : ''}${workerCoordinatorSessionId ? `, coordinator session ${workerCoordinatorSessionId}` : ''})`);
        // EVTTRACE: event persisted to the coordinator pending queue (awaiting reconcile drain).
        traceMeshEventStage('queued', traceCtx, workerCoordinatorDaemonId ? `coordinatorDaemon=${workerCoordinatorDaemonId}` : 'broadcast');
    } else {
        // EVTTRACE: queue rejected the event (dedup at queue time / persistence guard).
        traceMeshEventDrop('queue_dedup', traceCtx);
    }
    return { success: true, forwarded: 0 };
}

// Reconstruct the metadataEvent that injectMeshSystemMessage consumes from a forwarded
// (cross-machine) mesh event. The remote relay hop arrives as a flat payload, NOT the
// original provider event object, so this whitelists the fields the coordinator-side
// pipeline reads and re-projects them. Kept pure + exported so the relay-path field
// preservation (esp. taskId) is unit-testable without driving injectMeshSystemMessage.
//
// IMPORTANT asymmetry: the LOCAL in-process forward path (onMeshCoordinatorEventForwarded)
// passes the whole event through as metadataEvent, so every field on the event survives
// there for free. This remote-only path must explicitly mirror each field it needs.
export function buildRelayMetadataEvent(payload: Record<string, unknown>): Record<string, unknown> {
    const relayModalMessage = readNonEmptyString(payload.modalMessage);
    const relayModalButtons = Array.isArray(payload.modalButtons)
        ? (payload.modalButtons as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        : null;
    return {
        // Preserve the dispatch task id across the machine boundary. The `received` trace
        // stage reads payload.taskId; without mirroring it here the rebuilt metadataEvent
        // loses it, so injectMeshSystemMessage's traceCtx.taskId and the
        // updateDirectDispatchStatus(eventTaskId) call go undefined — the EvtTrace
        // queued/surfaced stages show task=- and the direct-dispatch ledger falls back to a
        // session_id match (which can flip a sibling row). The local in-process forward path
        // keeps event.taskId/meshActiveTaskId for free; this mirrors it for the remote relay.
        // Same taskId/meshActiveTaskId ordering the local unroutable trace uses.
        taskId: readNonEmptyString(payload.taskId) || readNonEmptyString(payload.meshActiveTaskId),
        targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.instanceId),
        providerType: readNonEmptyString(payload.providerType),
        providerSessionId: readNonEmptyString(payload.providerSessionId),
        // Preserve the originating coordinator SESSION id across the machine boundary so
        // the completion routes back to the exact coordinator session (multi-coordinator).
        // buildForwardPayloadFromPending spreads the worker event's metadata, so the id
        // arrives as payload.meshCoordinatorSessionId; the top-level targetCoordinatorSessionId
        // is also accepted as a fallback. injectMeshSystemMessage re-derives the routing
        // anchors from this. Absent → daemon-level fallback (version-skew safe).
        meshCoordinatorSessionId: readNonEmptyString(payload.meshCoordinatorSessionId) || readNonEmptyString(payload.targetCoordinatorSessionId),
        // Carry the session identity fields the worker provider event emits so the
        // coordinator's mirror (updateMeshOwnedSession) gets a real workspace/title/
        // settings. Without these the remote-relay hop reconstructs metadataEvent with
        // an empty workspace, and the dashboard flaps to the generic
        // "Terminal (Mesh Node)" title (and degrades the provider label) between live
        // events and the periodic get_status_metadata snapshot. The local in-process
        // forward path (onMeshCoordinatorEventForwarded) already preserves these; this
        // mirrors them for the remote-only relay path.
        workspace: readNonEmptyString(payload.workspace) || readNonEmptyString(payload.workspaceName),
        workspaceName: readNonEmptyString(payload.workspaceName) || readNonEmptyString(payload.workspace),
        sessionTitle: readNonEmptyString(payload.sessionTitle),
        sessionStatus: readNonEmptyString(payload.sessionStatus),
        sessionChatStatus: readNonEmptyString(payload.sessionChatStatus),
        providerName: readNonEmptyString(payload.providerName),
        ...(payload.sessionSettings && typeof payload.sessionSettings === 'object' && !Array.isArray(payload.sessionSettings) ? { sessionSettings: payload.sessionSettings } : {}),
        finalSummary: readNonEmptyString(payload.finalSummary) || readNonEmptyString(payload.summary),
        // T2: carry the worker's status-snapshot last-message preview across the machine
        // boundary so a summary-less completion still surfaces the assistant reply in the
        // coordinator's inbox mirror. resolveMeshSurfacedSessionPreview reads these
        // (assistant-role only) when finalSummary is absent.
        lastMessagePreview: readNonEmptyString(payload.lastMessagePreview),
        lastMessageRole: readNonEmptyString(payload.lastMessageRole),
        ...(payload.lastMessageAt !== undefined ? { lastMessageAt: payload.lastMessageAt } : {}),
        jobId: readNonEmptyString(payload.jobId),
        interactionId: readNonEmptyString(payload.interactionId),
        status: readNonEmptyString(payload.status),
        targetDaemonId: readNonEmptyString(payload.targetDaemonId),
        startedAt: readNonEmptyString(payload.startedAt),
        completedAt: readNonEmptyString(payload.completedAt),
        retryOfJobId: readNonEmptyString(payload.retryOfJobId),
        ...(relayModalMessage ? { modalMessage: relayModalMessage } : {}),
        ...(relayModalButtons && relayModalButtons.length > 0 ? { modalButtons: relayModalButtons } : {}),
        ...(payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? { result: payload.result } : {}),
        ...(payload.completionDiagnostic && typeof payload.completionDiagnostic === 'object' && !Array.isArray(payload.completionDiagnostic) ? { completionDiagnostic: payload.completionDiagnostic } : {}),
        ...(payload.workerResult && typeof payload.workerResult === 'object' && !Array.isArray(payload.workerResult) ? { workerResult: payload.workerResult } : {}),
        ...(payload.meshWorkerResult && typeof payload.meshWorkerResult === 'object' && !Array.isArray(payload.meshWorkerResult) ? { meshWorkerResult: payload.meshWorkerResult } : {}),
        ...(payload.structuredResult && typeof payload.structuredResult === 'object' && !Array.isArray(payload.structuredResult) ? { structuredResult: payload.structuredResult } : {}),
        ...(payload.timestamp !== undefined ? { timestamp: payload.timestamp } : {}),
        intentional: payload.intentional === true,
        intentionalStop: payload.intentionalStop === true,
        operatorCleanup: payload.operatorCleanup === true,
        reason: readNonEmptyString(payload.reason),
        stopReason: readNonEmptyString(payload.stopReason),
        cleanupReason: readNonEmptyString(payload.cleanupReason),
        source: readNonEmptyString(payload.source),
    };
}

export function handleMeshForwardEvent(components: DaemonComponents, payload: Record<string, unknown>) {
    const eventName = readNonEmptyString(payload.event);
    if (!isMeshCoordinatorEvent(eventName)) {
        return { success: false, error: 'unsupported mesh event' };
    }
    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);

    // The fallback worker-forward path (forwardUnresolvedDelegateEvent) cannot resolve a
    // mesh id locally on the remote worker, so it forwards the event with nodeId +
    // workspace only. The coordinator hosting the mesh CAN resolve it. Two recovery
    // paths, in order:
    //   1) workspace → mesh (fast path; cached repoIdentity lookup), then
    //   2) nodeId → mesh (deterministic backstop; scans hosted meshes for the node).
    // Workspace recovery alone was unreliable — a worktree clone whose repoIdentity
    // differs, or a transient cache miss, left the reconcile retry permanently rejected
    // ("meshId required") so the worker's completion never surfaced to the coordinator.
    // The nodeId is a stable coordinator-side fact and resolves timing-independently.
    const meshId = readNonEmptyString(payload.meshId)
        || (workspace ? readNonEmptyString(getCachedMeshByWorkspace(workspace)?.id) : '')
        || recoverMeshIdByNodeId(nodeId)
        // Fix B last resort: workspace + nodeId scan both missed, but the worker stamped
        // its coordinator anchor onto the forward (forwardUnresolvedDelegateEvent). Recover
        // via the hosted mesh that anchor owns (+ node disambiguation), guarding ambiguity.
        || recoverMeshIdByCoordinatorAndNode(
            readNonEmptyString(payload.meshCoordinatorDaemonId) || readNonEmptyString(payload.coordinatorDaemonId),
            nodeId,
        );
    if (!meshId) {
        // EVTTRACE: forwarded event rejected at receive — no meshId could be resolved
        // (no payload.meshId, no workspace→mesh, no nodeId→mesh). Observation only.
        traceMeshEventDrop('meshId_required', {
            taskId: payload.taskId,
            sessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
            nodeId,
            event: eventName,
        }, workspace ? `workspace=${workspace} unresolved` : 'no workspace/nodeId');
        return { success: false, error: 'meshId required' };
    }
    // EVTTRACE: forwarded event accepted at receive (meshId resolved).
    // NOTIF-MISS (FIX 3): mirror buildRelayMetadataEvent's taskId fallback. A worker provider
    // completion stamps its task id as `meshActiveTaskId` (settings → event), not always the
    // top-level `taskId`, so reading payload.taskId alone rendered `task=-` at the received stage
    // (the [stage:queued] task=<id> → [stage:received] task=- loss). Falling back to
    // meshActiveTaskId keeps the trace task-scoped end-to-end so same-task redelivery is
    // distinguishable from a different task's real completion.
    traceMeshEventStage('received', {
        taskId: readNonEmptyString(payload.taskId) || readNonEmptyString(payload.meshActiveTaskId),
        sessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
        nodeId,
        meshId,
        event: eventName,
    });
    const nodeLabel = nodeId ? `Node '${nodeId}'` : workspace ? `Agent at ${workspace}` : 'Remote agent';

    return injectMeshSystemMessage(components, {
        meshId,
        nodeId,
        nodeLabel,
        event: eventName,
        metadataEvent: buildRelayMetadataEvent(payload),
    });
}

// ---------------------------------------------------------------------------
// Per-coordinator forward serialization (P2P send-backpressure relief).
//
// When several workers finish at once, each completion runs forwardUnresolvedDelegate
// Event and fires its own `mesh_forward_event` push. Firing the whole burst
// concurrently dumps it into the single per-peer P2P DataChannel buffer in one tick,
// which starves the rpc_ack/rpc_res replies the same channel must carry — a
// coordinator's inbound `git_status` then times out even though the worker's own
// forward acks return in ~1s. To cap the concurrent burst we serialize the immediate
// pushes per coordinator: at most one push is in flight to a given coordinator at a
// time, the rest run in arrival order behind it. A lone event (idle lane) still
// dispatches immediately — only a genuine burst is paced. Durability is unchanged:
// every event is already persisted to the outbox before the push runs, so serializing
// only delays the best-effort fast path; PHASE 0 retry still covers any gap. This pairs
// with the DataChannel send-buffer gate in daemon-cloud's mesh manager (writeRequest),
// which is the hard guarantee; this throttle keeps the burst from piling up there.
interface CoordinatorForwardLane { tail: Promise<unknown>; depth: number; }
const coordinatorForwardLanes = new Map<string, CoordinatorForwardLane>();
function enqueueCoordinatorForwardPush(coordinatorDaemonId: string, run: () => Promise<unknown>): void {
    let lane = coordinatorForwardLanes.get(coordinatorDaemonId);
    if (!lane) { lane = { tail: Promise.resolve(), depth: 0 }; coordinatorForwardLanes.set(coordinatorDaemonId, lane); }
    const wasIdle = lane.depth === 0;
    lane.depth += 1;
    const dec = (): void => { lane!.depth -= 1; };
    if (wasIdle) {
        // Idle lane → dispatch synchronously, so a lone completion (the common case) has
        // ZERO added latency and the push call happens in-line. Only a genuine burst —
        // events arriving while a push is still in flight — is paced (else branch).
        lane.tail = Promise.resolve(run()).catch(() => {}).then(dec, dec);
    } else {
        // Burst: queue behind the in-flight push(es) in arrival order so the whole burst
        // is not dumped into the shared DataChannel buffer at once. The tail is guarded
        // so one rejecting push never wedges the lane for the next.
        lane.tail = lane.tail.then(() => run()).catch(() => {}).then(dec, dec);
    }
}

// ---------------------------------------------------------------------------
// Worker-side fallback forward for unresolved-mesh delegates.
//
// A REMOTE worker daemon that is being P2P-remote-controlled by a coordinator is
// NOT a member of the coordinator's mesh — it has no local mesh record. So when its
// completion event reaches the forwarder, resolveWorkerDelegateRouting() resolves the
// coordinator anchor (meshCoordinatorDaemonId) from the worker envelope but cannot
// resolve the mesh id (neither meshNodeFor nor a workspace→mesh lookup yields one) and
// returns isDelegate=false / mesh_unresolved. Before this fallback the event was dropped
// (delivery_unroutable) and only recovered later when the coordinator happened to pull
// the worker's queue — which it can't, because the worker never queued an unroutable
// event. Live symptom: `WARN [MeshEvents] delivery_unroutable: ... mesh unresolved`.
//
// The fix: the routing object still carries coordinatorDaemonId. Forward the raw event
// straight to that coordinator daemon over P2P (mesh_forward_event). The coordinator
// hosts the mesh, so it recovers the mesh id by workspace in handleMeshForwardEvent and
// injects/queues it normally. meshId is intentionally omitted from the payload (the
// worker has none); workspace is the routing anchor the coordinator resolves from.
//
// No loop / no double-delivery:
//  - This only fires on the WORKER (the coordinator-own session is rejected by the
//    resolver before reaching here), and the coordinator merely injects — it does not
//    re-enter this forwarder for the relayed event.
//  - It fires only when the normal queue path did NOT run (isDelegate=false), so the
//    event is never both queued locally and forwarded.
//
// Returns true when the event was durably accepted for delivery to the coordinator
// daemon (so the caller skips the delivery_unroutable diagnostic); false when no
// fallback was possible (no coordinator anchor / no dispatch transport).
//
// Durability: the directed push to the coordinator is the ONLY delivery route for an
// unresolved-mesh worker (it is in no mesh.node the coordinator can pull). So instead
// of a fire-and-forget push that drops on one transient P2P failure, the event is
// persisted to the worker-side outbox FIRST and only acked after a successful push.
// A best-effort immediate push keeps latency low on the happy path; a failed or
// un-acked push leaves the durable row for setupMeshReconcileLoop's PHASE 0 to retry.
function forwardUnresolvedDelegateEvent(
    components: DaemonComponents,
    routing: ReturnType<typeof resolveWorkerDelegateRouting>,
    event: Record<string, unknown>,
): boolean {
    const coordinatorDaemonId = readNonEmptyString(routing.coordinatorDaemonId);
    if (!coordinatorDaemonId) return false;
    if (!components.dispatchMeshCommand) return false;

    const eventName = readNonEmptyString(event.event);
    if (!eventName) return false;

    // Flat payload mirroring buildForwardPayloadFromPending / what handleMeshForwardEvent
    // reads. nodeId/workspace come from the worker envelope so the coordinator can name and
    // locate the node.
    const payload: Record<string, unknown> = {
        ...event,
        event: eventName,
        nodeId: readNonEmptyString(routing.nodeId) || readNonEmptyString(event.meshNodeId) || undefined,
        workspace: readNonEmptyString(routing.workspace) || readNonEmptyString(event.workspace) || undefined,
        // Fix B: carry the resolved coordinator anchor so the coordinator's receive-side
        // recovery (recoverMeshIdByCoordinatorAndNode) can match this forward to one of the
        // meshes it hosts when workspace + nodeId both miss. routing.coordinatorDaemonId is
        // the same anchor this forward is addressed to (coordinatorDaemonId below).
        meshCoordinatorDaemonId: coordinatorDaemonId,
    };
    // RECONCILE-MESHID-DROP: stamp meshId when the WORKER can resolve it (member node /
    // live-session meshNodeFor). Historically omitted "because the worker can't resolve
    // it", but for a member-hosted node a no_node_binding session's coordinator-side
    // recovery (empty payload nodeId + workspace cache miss) fails and the retry is
    // rejected "meshId required" forever. Resolving here makes the forward self-sufficient;
    // when unresolvable even here it stays absent and the coordinator's own workspace/nodeId
    // recovery still runs (unchanged), with the retry cap as the loop backstop.
    const resolvedMeshId = resolveForwardEventMeshId(components, payload);
    if (resolvedMeshId) payload.meshId = resolvedMeshId;

    // Self-addressed fallback: the resolved coordinator IS this daemon (a self-
    // coordinating / single-node mesh, or a delegate whose coordinator anchor resolved
    // to our own id). A cross-daemon mesh_forward_event to our own id is REFUSED by the
    // dispatch self-dial guard ("route via the local router instead"), so persisting it
    // to the outbox would only loop forever in PHASE 0's retry, never acked. Honour the
    // guard's advice: route the event straight through the local receiver — the exact
    // path the coordinator runs on receiving a remote push — and skip the outbox entirely.
    const selfDaemonIds = resolveCoordinatorDrainDaemonIds(components);
    if (selfDaemonIds.some(self => daemonIdsEquivalent(self, coordinatorDaemonId))) {
        try {
            handleMeshForwardEvent(components, payload);
            LOG.info('MeshEvents', `Self-addressed unresolved-delegate ${eventName} routed via local router (coordinator ${coordinatorDaemonId} is self) — outbox skipped`);
        } catch (e: any) {
            LOG.warn('MeshEvents', `Local route of self-addressed unresolved-delegate ${eventName} failed: ${e?.message || e}`);
        }
        return true;
    }

    // 1) Persist durably FIRST. Idempotent on fingerprint, so a re-fired completion
    //    does not duplicate the outbox row. If persistence fails we still attempt the
    //    push below (degrades to the old at-most-once behaviour rather than dropping
    //    the chance entirely).
    const persisted = enqueueUnresolvedDelegateForward(coordinatorDaemonId, eventName, payload);
    // EVTTRACE: unresolved-mesh worker persisted its completion to the outbox (no meshId
    // available locally; coordinator will recover it on receive).
    const fwdTraceCtx = {
        taskId: (payload as Record<string, unknown>).taskId,
        sessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
        nodeId: readNonEmptyString(routing.nodeId) || readNonEmptyString(event.meshNodeId),
        event: eventName,
    };
    traceMeshEventStage('outbox_enqueue', fwdTraceCtx, `coordinatorDaemon=${coordinatorDaemonId} meshId=absent`);

    // 2) Best-effort immediate push for low latency. On success, ack the outbox row so
    //    the retry loop won't re-send it. On failure, leave it queued — PHASE 0 retries.
    traceMeshEventStage('forward_send', fwdTraceCtx, 'immediate push');
    // Serialize per coordinator so a multi-worker completion burst is paced rather than
    // dumped concurrently into the shared P2P DataChannel buffer (see coordinator
    // ForwardLanes). dispatchMeshCommand was null-checked above; capture it for the
    // deferred closure.
    const dispatchMeshCommand = components.dispatchMeshCommand;
    enqueueCoordinatorForwardPush(coordinatorDaemonId, () =>
        Promise.resolve(dispatchMeshCommand(coordinatorDaemonId, 'mesh_forward_event', payload))
            .then((result: any) => {
                if (result && result.success === false) {
                    LOG.warn('MeshEvents', `Immediate forward of ${eventName} to coordinator ${coordinatorDaemonId} rejected (${readNonEmptyString(result.error) || 'no reason'}) — left queued for retry`);
                    traceMeshEventDrop('immediate_forward_rejected', fwdTraceCtx, readNonEmptyString(result.error) || 'no reason');
                    return;
                }
                // Acked. Mark the durable copy delivered so the retry loop skips it.
                if (persisted) ackUnresolvedDelegateForwardByFingerprint(coordinatorDaemonId, eventName, payload);
            })
            .catch((e: any) => {
                // Coordinator momentarily unreachable; the durable row stays queued and the
                // reconcile loop retries it. Trace so the relay attempt is visible.
                LOG.warn('MeshEvents', `Immediate forward of ${eventName} to coordinator ${coordinatorDaemonId} failed: ${e?.message || e} — left queued for retry`);
            }));
    LOG.info('MeshEvents', `Durably forwarded ${eventName} for unresolved-mesh worker at ${routing.workspace || '(no workspace)'} to coordinator daemon ${coordinatorDaemonId}`);
    return true;
}

// Ack a just-pushed outbox entry by re-deriving its row from the same coordinator +
// event + payload. We don't thread the row id back from enqueue (the immediate push is
// fire-then-ack), so locate it among the undrained entries by matching coordinator and
// the flat payload's forward identity. A miss is harmless — the retry loop's own
// receiver-side dedup suppresses a duplicate delivery.
function ackUnresolvedDelegateForwardByFingerprint(
    coordinatorDaemonId: string,
    eventName: string,
    payload: Record<string, unknown>,
): void {
    const match = peekUnresolvedDelegateForwards().find(entry =>
        daemonIdsEquivalent(entry.coordinatorDaemonId, coordinatorDaemonId)
        && readNonEmptyString(entry.payload.event) === eventName
        && readNonEmptyString(entry.payload.targetSessionId || entry.payload.sessionId || entry.payload.instanceId)
            === readNonEmptyString(payload.targetSessionId || payload.sessionId || payload.instanceId)
        && readNonEmptyString(entry.payload.workspace) === readNonEmptyString(payload.workspace),
    );
    if (match) ackUnresolvedDelegateForward(match.id);
}

export function setupMeshEventForwarding(components: DaemonComponents) {
    components.instanceManager.onEvent((event) => {
        // --- Coordinator idle auto-flush (fast path) ---
        // When a coordinator session becomes idle, immediately flush any pending
        // coordinator events that accumulated while it was generating, rather than
        // waiting up to one reconcile interval for setupMeshReconcileLoop to do it.
        // Both paths drain the SAME queue via drainPendingMeshCoordinatorEvents,
        // whose SQLite drained=1 marking is atomic — whichever fires first consumes
        // the events and the other gets nothing, so there is no double-delivery.
        // This runs before the delegate routing below so that coordinator-own idle
        // transitions are handled first.
        // Exception: a coordinator that is itself a direct-dispatch target still needs
        // to go through delegate routing so that the dispatching coordinator receives a
        // pendingCoordinatorEvents entry for the completion.
        if (event.event === 'agent:ready' || event.event === 'agent:generating_completed') {
            const flushInstanceId = readNonEmptyString(event.instanceId);
            if (flushInstanceId) {
                const flushSource = components.instanceManager.getInstance(flushInstanceId);
                if (flushSource && flushSource.category === 'cli') {
                    const flushState = flushSource.getState();
                    const flushSettings = flushState.settings && typeof flushState.settings === 'object' ? flushState.settings as Record<string, unknown> : {};
                    const coordinatorMeshId = readNonEmptyString(flushSettings.meshCoordinatorFor);
                    if (coordinatorMeshId) {
                        const status = readNonEmptyString(flushState.status).toLowerCase();
                        if (status === 'idle') {
                            try {
                                // Drain with the daemon's full coordinator-id set (status id + machineId).
                                // The MCP layer stamps the prefixed status id (`standalone_<machineId>` /
                                // `daemon_<machineId>`) as the worker's meshCoordinatorDaemonId; draining
                                // with bare machineId alone would miss those unicast events. Mirrors
                                // resolveCoordinatorDaemonIds in mesh-reconcile-loop.
                                const drainDaemonIds = resolveCoordinatorDrainDaemonIds(components);
                                const pendingEvents = drainPendingMeshCoordinatorEvents(coordinatorMeshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
                                if (pendingEvents.length > 0) {
                                    LOG.info('MeshEvents', `Auto-flushing ${pendingEvents.length} pending coordinator event(s) for mesh ${coordinatorMeshId} on coordinator idle`);
                                    for (const pending of pendingEvents) {
                                        if (!pending.coordinatorMessage) continue;
                                        const forcePending = shouldForceInjectMeshEvent(pending.event);
                                        flushSource.onEvent('send_message', {
                                            input: { text: pending.coordinatorMessage, textFallback: pending.coordinatorMessage },
                                            ...(forcePending ? { force: true } : {}),
                                        });
                                    }
                                }
                            } catch (e: any) {
                                LOG.warn('MeshEvents', `Failed to auto-flush pending coordinator events: ${e?.message || e}`);
                            }
                        }
                        // Skip delegate routing unless this coordinator session is itself
                        // a direct-dispatch target — in that case fall through so the
                        // dispatching coordinator gets a pendingCoordinatorEvents entry.
                        let hasDirectDispatch = false;
                        try {
                            hasDirectDispatch =
                                getActiveDirectDispatches(coordinatorMeshId).some(d => d.sessionId === flushInstanceId)
                                || hasUnterminalDirectDispatchLedgerEntry(coordinatorMeshId, flushInstanceId);
                        } catch { /* best-effort */ }
                        if (!hasDirectDispatch) return;
                    }
                }
            }
        }

        // --- Delegate event routing ---
        if (!isMeshCoordinatorEvent(event.event)) return;

        const instanceId = readNonEmptyString(event.instanceId);
        if (!instanceId) return;

        // R1: all session→node→mesh→coordinator interpretation is folded into the single
        // resolveWorkerDelegateRouting() resolver. No stamp (meshNodeFor / meshNodeId /
        // meshCoordinatorDaemonId / meshCoordinatorNodeId / launchedByCoordinator) is read
        // here to make a routing decision — the resolver is the one authority, and the
        // forwarder consumes its typed result only.
        const routing = resolveWorkerDelegateRouting(components, instanceId, {
            getMeshById: (meshId) => getMeshWithCache(components, meshId),
            getMeshByWorkspace: (workspace) => getCachedMeshByWorkspace(workspace),
        });
        if (!routing.isDelegate) {
            // Fallback: a REMOTE worker that isn't a member of the coordinator's mesh can't
            // resolve a mesh id locally (mesh_unresolved), but it still carries the coordinator
            // daemon anchor. Forward the event straight to that coordinator over P2P instead of
            // dropping it — the coordinator hosts the mesh and recovers the id by workspace.
            if (isUnroutableDelegateRejection(routing)
                && forwardUnresolvedDelegateEvent(components, routing, event)) {
                return;
            }
            // R4: a worker that presented a valid envelope but resolved to no mesh (and could
            // not be fallback-forwarded — e.g. no coordinator anchor) used to be dropped
            // silently. Leave a fail-loud diagnostic so the missing completion is traceable.
            // Benign non-delegate rejections (not_cli / no_workspace / etc.) are no-ops inside
            // recordUnroutableDelegateEvent.
            // EVTTRACE: a delegate event that could not be routed AND could not be
            // fallback-forwarded (no coordinator anchor). Only mesh_unresolved is a real
            // drop; the benign non-delegate rejections are ordinary non-mesh traffic.
            if (isUnroutableDelegateRejection(routing)) {
                traceMeshEventDrop('unroutable', {
                    taskId: (event as Record<string, unknown>).meshActiveTaskId ?? (event as Record<string, unknown>).taskId,
                    sessionId: routing.sessionId,
                    nodeId: routing.nodeId,
                    event: event.event,
                }, 'no coordinator anchor / mesh_unresolved');
            }
            recordUnroutableDelegateEvent(routing, event.event);
            return;
        }

        injectMeshSystemMessage(components, {
            meshId: routing.meshId,
            sourceInstanceId: instanceId,
            nodeId: routing.nodeId,
            nodeLabel: routing.nodeLabel,
            event: event.event,
            metadataEvent: event,
        });
    });
}
