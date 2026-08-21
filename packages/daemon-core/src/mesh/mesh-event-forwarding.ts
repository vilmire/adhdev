import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { getMesh, getMeshByRepo, listMeshes } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, getSessionRecoveryContext } from './mesh-ledger.js';
import type { SessionRecoveryContext } from './mesh-ledger.js';
import { updateSessionTaskStatus, enqueueTask, updateDirectDispatchStatus, cleanupTerminalDirectDispatches, getActiveDirectDispatches, hasPendingDependents, getQueue } from './mesh-work-queue.js';
import { markSessionDeliveriesTerminal, updateSessionDeliveryStatus, consumeSessionDelivery } from './mesh-delivery-policy.js';
import { MeshRuntimeStore, pruneMeshRuntimeRetention } from './mesh-runtime-store.js';
import { maybeInjectIdleActiveMissionReminder } from './mesh-idle-reminder.js';
import { queuePendingMeshCoordinatorEvent, requeueDrainedPendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents, prunePendingMeshCoordinatorEventsRetention, readV2EnvelopeFromWire, type PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { resolveWorkerDelegateRouting, recordUnroutableDelegateEvent, isUnroutableDelegateRejection } from './mesh-routing.js';
import { resolveMeshHostStatus } from './mesh-host-ownership.js';
import { enqueueUnresolvedDelegateForward, nudgeUnresolvedForwardRetry } from './mesh-unresolved-forward-outbox.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { getLastDisplayMessage } from '../status/snapshot.js';
import { delegatedWorkerAutoApproveSettings } from '../repo-mesh-types.js';
import { loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';
import { describeRecoveryRelaunchDecision, quotaFactsContextForLiveRouting, resolveRecoveryRelaunchProvider } from './mesh-quota-routing.js';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { scheduleTaskCompletionSideEffectEvidence, applyTaskModeCompletionEvidence, FALSE_COMPLETION_GIT_CHECK_TIMEOUT_MS } from './mesh-completion-side-effect-evidence.js';
import { meshNodeIdMatches, daemonIdsEquivalent, expandDaemonIdForms, sessionIdsEquivalent, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import {
    findTerminalLedgerEvidenceForTask,
    hasUnterminalDirectDispatchLedgerEntry,
} from './mesh-events-stale.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { registerMeshGraphQueueWakeHandler } from './mesh-graph-transition-runner.js';
import {
    buildMeshSystemMessage,
    readNonEmptyString,
    resolveEventSessionId,
    readWorkerResultMetadata,
    resolveMeshSurfacedSessionPreview,
    isFalseIdleCompletion,
    isWeakCompletionEvidence,
} from './mesh-events-utils.js';
import { isMeshCoordinatorEvent, shouldForceInjectMeshEvent, EVENT_TO_LEDGER_KIND } from './mesh-event-classify.js';
import {
    classifyNonceEcho,
    enqueueTerminalOutbox,
    proposeTurnCompletion,
    recordTurnAck,
    recordTurnStage,
} from './mesh-turn-ledger.js';
import {
    getMeshWithCache,
    tryAssignQueueTask,
    triggerMeshQueue,
    runIdleMaintenanceThenAssignQueue,
    maybeAutoFastForwardIdleNode,
    sessionHasActiveAssignment,
    isLocalAutoLaunchNode,
    AUTO_LAUNCH_AWAIT_CLAIM_MS,
} from './mesh-queue-assignment.js';
import {
    sweepExpiredRemoteIdleSessions,
    readEventTimestamp,
    resolveGraphEnvelopeWorkerResult,
    resolveUnifiedCompletionEvidenceLevel,
    resolveActiveDirectDispatchTaskId,
    evaluateMeshEventSuppression,
    shouldSuppressAutoApprovingWorkerApproval,
    drainMeshTurnOutbox,
    scheduleTurnOutboxDrain,
    stopStaleMeshWorker,
    supersedeRedriveReclaimForLateCompletion,
    hasTerminalAuthorityForTask,
} from './mesh-event-suppression.js';
// Re-exported for backward compatibility: these now live in mesh-event-suppression.ts
// (pure move, file-size gate decomposition) but external importers still reach them via
// mesh-event-forwarding.js (mesh-reconcile-loop.ts, mesh-reconcile-stranded-dispatch.ts,
// test/mesh/mesh-evidence-level-unify.test.ts, test/mesh/mesh-graph-envelope-worker-result.test.ts).
export { drainMeshTurnOutbox, stopStaleMeshWorker, resolveGraphEnvelopeWorkerResult, resolveUnifiedCompletionEvidenceLevel } from './mesh-event-suppression.js';

// ---------------------------------------------------------------------------
// BOOTSTRAP-MSG: worktreeHasQueuedTask predicate (exported for unit testing)
// ---------------------------------------------------------------------------
// Returns true when a queue task entry should be counted as "this worktree node already
// has work being handled" — suppressing the misleading 'use mesh_launch_session' advice
// in the worktree_bootstrap_complete system message.
//
// Mirrors the autoLaunchPending logic in triggerMeshQueue (mesh-queue-assignment.ts):
//   • assigned           → true  (session claimed it)
//   • pending, no al     → true  (queue will auto-launch, no action needed)
//   • pending, al started|completed within AUTO_LAUNCH_AWAIT_CLAIM_MS
//                        → true  (session spun up, will claim soon)
//   • pending, al started|completed but OUTSIDE the window
//                        → false (launch timed out, manual launch IS needed)
//   • pending, other al  → true  (not yet tried, queue will handle)
export function bootstrapQueueTaskCountsAsHandled(
    task: { status: string; targetNodeId?: string | null; autoLaunch?: { status: string; updatedAt: string } | null },
    bootstrapNodeId: string,
    nowMs: number,
): boolean {
    if (!meshNodeIdMatches({ id: task.targetNodeId } as MeshNodeIdentified, bootstrapNodeId)) return false;
    if (task.status === 'assigned') return true;
    const al = task.autoLaunch;
    if (!al) return true;
    if (al.status === 'started' || al.status === 'completed') {
        const launchedAtMs = Date.parse(al.updatedAt);
        return Number.isFinite(launchedAtMs) && nowMs - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS;
    }
    return true;
}

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


function injectMeshSystemMessage(components: DaemonComponents, args: {
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
    // T4 (B3b): v2 envelope restored from a remote (P2P) relay's flat payload. Only the
    // relay path (handleMeshForwardEvent) sets it; the in-process forward path leaves it
    // undefined and the local emit stamp applies as usual. When present with a preserved
    // eventId, it is spread onto the re-queued pending event so stampPendingEventV2's
    // already-stamped short-circuit keeps the ORIGINAL eventId (cross-machine idempotency).
    v2Envelope?: Partial<Pick<PendingMeshCoordinatorEvent,
        'protocolVersion' | 'eventId' | 'scope' | 'dispatchedBy' | 'intendedFor'>>;
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

    // STALE-APPROVAL-AFTER-TERMINAL: a waiting_approval / waiting_choice that arrives AFTER
    // terminal authority already exists for its task is stale by construction — the turn is
    // over, so no CURRENT actionable modal can exist for it (mesh_approve against such a
    // projection fails 'Not in approval state': the provider exposes no matching modal).
    // Suppress BEFORE any side effect on this path (the owned-session mirror update, the
    // task_approval_needed / task_question_pending ledger append, the turn-stage write, the
    // coordinator forward) — letting it through re-pins awaiting_approval/awaiting_choice on
    // every projection surface and defers the reclaim/redrive the terminal already earned.
    // Approval and choice stay DISTINCT here: each is dropped only as its own event kind;
    // neither is ever mapped onto the other.
    if ((args.event === 'agent:waiting_approval' || args.event === 'agent:waiting_choice') && eventSessionId) {
        const approvalTaskId = readNonEmptyString(args.metadataEvent.taskId);
        if (approvalTaskId && hasTerminalAuthorityForTask(args.meshId, approvalTaskId)) {
            LOG.info('MeshEvents', `Suppressed ${args.event} for session ${eventSessionId} (mesh ${args.meshId}, task ${approvalTaskId}) — terminal authority already exists for the task; the approval/choice is stale (no current actionable modal)`);
            traceMeshEventDrop('stale_approval_after_terminal', traceCtx);
            return { success: true, forwarded: 0, suppressed: true, staleApprovalAfterTerminal: true };
        }
    }

    const sourceSession = args.sourceInstanceId
        ? components.instanceManager.getInstance(args.sourceInstanceId)
        : undefined;
    // Daemon-level routing anchor. Prefer the LIVE worker session's stamp; fall back to a
    // relayed targetCoordinatorDaemonId carried in metadataEvent (RC32 — mirrored by
    // buildRelayMetadataEvent from the forward payload). A sessionless producer — e.g. an
    // async refine job's accepted/completed/failed emitted on a remote executing daemon —
    // has no local sourceSession, so without the relayed fallback the queued event would
    // mint under THIS daemon's self-fallback id and the originating coordinator's drain
    // would exclude it (event trims to held). This does not weaken v2 targeting or the
    // cross-machine guards: it only re-scopes the event to the coordinator the producer
    // was already addressed to, and the live-session stamp still wins when present.
    const workerCoordinatorDaemonId = readNonEmptyString(
        (sourceSession?.getState()?.settings as Record<string, unknown>)?.meshCoordinatorDaemonId,
    ) || readNonEmptyString(args.metadataEvent.targetCoordinatorDaemonId);
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
        const base = (!last || !last.preview)
            ? args.metadataEvent
            : {
                ...args.metadataEvent,
                lastMessagePreview: last.preview,
                lastMessageRole: last.role,
                ...(last.receivedAt > 0 ? { lastMessageAt: last.receivedAt } : {}),
            };
        // MAGI: stamp the queue task's consensusGroupId onto the completion metadata
        // so the intentional-fan-out dedup exemption (buildPendingEventFingerprint)
        // can see it. The work queue is owned by THIS host/coordinator daemon — where
        // both the lookup and the dedup run — so the local lookup covers local and
        // relayed workers alike. Best-effort: never fail the event path on a miss, and
        // never clobber a consensusGroupId the worker already relayed.
        if (readNonEmptyString((base as Record<string, unknown>).consensusGroupId)) return base;
        const eventTaskId = readNonEmptyString(args.metadataEvent.taskId);
        if (!eventTaskId) return base;
        try {
            const entry = MeshRuntimeStore.getInstance().findQueueEntryById(args.meshId, eventTaskId);
            const consensusGroupId = readNonEmptyString((entry as { consensusGroupId?: unknown } | null)?.consensusGroupId);
            if (consensusGroupId) return { ...base, consensusGroupId };
        } catch { /* queue lookup is best-effort; absence just falls back to the generic fingerprint */ }
        return base;
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

    // Auto-approving worker: suppress its approval prompt ONLY when the modal was — or is
    // being — resolved LOCALLY within the recent cooldown. The daemon resolving the modal
    // locally makes the "[System] … waiting for approval" injection pure noise that hijacks
    // the coordinator's turn (the observed MAGI failure where a replica's repeated
    // auto-approvals flooded the coordinator and derailed its final synthesis). But a worker
    // whose auto-approve is merely CONFIGURED on and did NOT actually resolve this modal
    // (button-index mismatch, an unattended stall, a modal auto-approve declined to answer)
    // must still forward — otherwise no task_approval_needed ledger row is created, the
    // coordinator/inbox is never told, and the remote UNKNOWN-grace reclaim eventually tears
    // the worker off its task (APPROVAL-INBOX-BLINDSPOT, Fix A).
    if (args.event === 'agent:waiting_approval' && shouldSuppressAutoApprovingWorkerApproval(components, eventSessionId)) {
        LOG.info('MeshEvents', `Suppressed agent:waiting_approval for auto-approving worker session ${eventSessionId || '(unknown)'} (mesh ${args.meshId}) — modal resolved locally within cooldown, coordinator not notified`);
        traceMeshEventDrop('waiting_approval_auto_approving_worker', traceCtx);
        return { success: true, forwarded: 0, suppressed: true, autoApprovingWorkerApproval: true };
    }

    // Coordinator-side dedup/suppression gate (extracted, behavior-preserving). A non-null
    // outcome either short-circuits with a forwarded result or signals a no-progress→completion
    // reconciliation that we re-inject; null lets the event fall through to the ledger machinery.
    const suppression = evaluateMeshEventSuppression(args, {
        traceCtx,
        eventSessionId,
        eventNodeId,
        eventTimestamp,
        workerCoordinatorDaemonId,
        components,
        injectMeshSystemMessage,
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

    // TURN-LEDGER (Stage 5): approval and choice are NONTERMINAL suspended states of the
    // attempt — never completion writes. Record the suspension idempotently so the reducer
    // (and the Stage 6 projection) sees waiting_approval / waiting_choice; a later
    // generating event resumes the SAME attempt (no new prompt, no new attempt).
    // HELD SUSPENSIONS: when the edge races ahead of the consumed ACK (fast picker), the
    // reducer defers it into a durable hold (deferred:true — expected, NOT an error) and
    // applies it once consumed is durable; a genuine record failure is logged + traced,
    // never silently swallowed.
    if ((args.event === 'agent:waiting_approval' || args.event === 'agent:waiting_choice') && eventSessionId) {
        const suspendedTaskId = readNonEmptyString(args.metadataEvent.taskId);
        if (suspendedTaskId) {
            try {
                const recorded = recordTurnStage({
                    meshId: args.meshId,
                    taskId: suspendedTaskId,
                    stage: args.event === 'agent:waiting_approval' ? 'waiting_approval' : 'waiting_choice',
                    attemptId: readNonEmptyString(args.metadataEvent.attemptId) || undefined,
                    sessionId: eventSessionId,
                    occurredAtMs: eventTimestamp ?? undefined,
                });
                if (recorded?.deferred) {
                    traceMeshEventStage('turn_suspension_held', traceCtx, `${args.event} preceded the consumed ACK — held for post-consumed drain`);
                }
            } catch (e: any) {
                LOG.warn('TurnLedger', `Failed to record ${args.event} suspension for task ${suspendedTaskId} (session ${eventSessionId}): ${e?.message || e}`);
                traceMeshEventDrop('turn_suspension_record_error', traceCtx, e?.message ? String(e.message) : undefined);
            }
        }
    }

    function markSessionTerminal(sessionId: string, outcome: 'completed' | 'failed', occurredAtMs?: number | null, opts?: { tentativeIfDirect?: boolean }): { id?: string; taskMode?: string } | null {
        // C2: prefer an exact taskId match when the completion event carries one —
        // it's immune to coordinator↔worker clock skew that can hide the assigned row.
        const eventTaskId = readNonEmptyString(args.metadataEvent.taskId) || undefined;
        // FALSE-COMPLETION-GIT-EVIDENCE (gap 2 fix): snapshot the row's `updatedAt` BEFORE
        // any flip below overwrites it — this is the assign/dispatch timestamp (last time
        // the row transitioned INTO 'assigned', stamped by claimNextQueueTask/updateQueueEntry),
        // and it is the only reference point available to test whether a git change is
        // ATTRIBUTABLE to this task run rather than stale leftovers from an earlier one.
        // Read-only, best-effort: a lookup failure here must never affect the terminal
        // decision, so it silently yields undefined (checkGitEvidenceSync falls back to a
        // bare dirty check when sinceIso is unavailable — see its own comment).
        const preFlipAssignedAt = eventTaskId
            ? (() => { try { return MeshRuntimeStore.getInstance().findQueueEntryById(args.meshId, eventTaskId)?.updatedAt; } catch { return undefined; } })()
            : undefined;
        // WEAK-QUEUE-TENTATIVE (early-completed safety net, symmetric with the direct-dispatch
        // `tentativeIfDirect` guard below): a `completed` outcome whose evidence is WEAK — a
        // false-idle / missing_final_assistant emit (the CANON-C decoupled-immediate path that
        // stamps evidenceLevel=insufficient) — must NOT hard-flip a matched QUEUE row to
        // terminal. Until this net, only DIRECT dispatches were kept tentative on weak evidence;
        // a queue-claimed task's session flipped its row to 'completed' unconditionally, so a
        // worker that dropped to idle ~13s in with no final assistant closed the task early even
        // though it never produced an answer. Leaving the row 'assigned' hands it to the reconcile
        // loop's proven net (PHASE 4 records the GENUINE completion once the transcript lands via
        // findTerminalLedgerEvidenceForTask; PHASE 2.5 reclaims a truly-stranded row back to
        // 'pending' for re-dispatch, bounded by MAX_STRANDED_RECLAIMS) — never a permanent wedge.
        //
        // CRUCIAL SCOPE: this covers only the PREMATURE decoupled-immediate emit
        // (emittedAfterFinalizationTimeout !== true). A weak completion that already waited out the
        // full 30s COMPLETED_FINALIZATION_MAX_WAIT_MS window (emittedAfterFinalizationTimeout=true)
        // is handled by the FINALIZATION-TIMEOUT-FORCE branch below: the caller flips it terminal
        // as 'failed' (never wedge) — but NEVER 'completed', because a timeout is not completion
        // evidence (2026-08-18 opencode 92d11091: force-emitted completion with an empty summary,
        // zero commits, work never started). A `failed` outcome or a completion with
        // genuine evidence flips terminal as before too.
        const completionDiagnostic = args.metadataEvent.completionDiagnostic && typeof args.metadataEvent.completionDiagnostic === 'object'
            ? args.metadataEvent.completionDiagnostic as Record<string, unknown>
            : undefined;
        const emittedAfterFinalizationTimeout = completionDiagnostic?.emittedAfterFinalizationTimeout === true;
        // ORDERING SAFETY (owner-flagged fragility, now pinned): this is the SOLE, FROZEN read
        // of isWeakCompletionEvidence(args.metadataEvent) for this invocation. Every later use
        // in this function (weakCompleted below, the outbox `weak:` annotation, and
        // genuineTerminal near the flip-miss safety net) reads THIS captured boolean, never a
        // fresh live call on args.metadataEvent again. This is load-bearing, not stylistic:
        // isWeakCompletionEvidence itself treats record.reviewRecommended===true as ONE of its
        // weak-evidence signals (mesh-events-utils.ts) — and the gap-3 fix immediately below
        // (and the gap-1/gap-1-readonly fixes further down) STAMP reviewRecommended=true onto
        // this same args.metadataEvent object as their review-flag mechanism. A live re-call of
        // isWeakCompletionEvidence AFTER those mutations would read its own side effect back as
        // if it were original evidence — flipping genuineTerminal to false for exactly the
        // emittedAfterFinalizationTimeout case the CRUCIAL SCOPE comment above says must stay
        // genuine, silently skipping the flip-miss safety net for it. Freezing the read here,
        // before any mutation in this function runs, makes every downstream use ORDER-INDEPENDENT
        // by construction — a future reordering of the mutation blocks below cannot resurrect
        // this bug, because there is no live re-read left to reorder around. See
        // WEAK-EVIDENCE-SNAPSHOT-REGRESSION test coverage in mesh-events.test.ts.
        const weakEvidenceAtEntry = isWeakCompletionEvidence(args.metadataEvent);
        const weakCompleted = outcome === 'completed'
            && weakEvidenceAtEntry
            && !emittedAfterFinalizationTimeout;
        // FALSE-COMPLETION-GIT-EVIDENCE (gap 3 / timeout-gate-off): emittedAfterFinalizationTimeout
        // forces weakCompleted to false — see the CRUCIAL SCOPE note above. Pre-fix this flipped the
        // row to 'completed' with only a reviewRecommended flag — the gate was OFF exactly when a
        // slow/dying worker is MOST likely to produce a false completion (the 92d11091 incident:
        // "completed" with an empty summary and zero work). Now the caller records the event as a
        // FORCED TERMINATION instead: outcome 'failed' (the row still flips terminal — the
        // never-wedge liveness guarantee holds — but as a visible failure, not a completion), and
        // this block keeps stamping reviewRecommended + timedOutWithoutFinalAssistant so the
        // ledger and the coordinator message (buildMeshSystemMessage's forced-termination branch)
        // both say "no response, forcibly terminated". Gated on weakEvidenceAtEntry (the frozen
        // read above), not a fresh isWeakCompletionEvidence call — this IS the mutation the
        // ordering-safety note above warns about, so it must not read its own prior output.
        if (emittedAfterFinalizationTimeout && weakEvidenceAtEntry) {
            args.metadataEvent.reviewRecommended = true;
            args.metadataEvent.completionDiagnostic = {
                ...(completionDiagnostic || {}),
                timedOutWithoutFinalAssistant: true,
            };
            LOG.info('MeshQueue', `Completion for session ${sessionId} exhausted the finalization wait with no confirmed final assistant — recording FORCED TERMINATION (outcome=${outcome}; terminal, never wedge) flagged reviewRecommended; NOT a completion`);
        }
        // TURN-LEDGER (Stage 5): the reducer is the single causal authority for terminal
        // outcomes. A genuine terminal for a taskId-named completion is proposed BEFORE any
        // row flip; when an attempt exists and the proposal is REJECTED (stale attempt /
        // session mismatch / already-terminal-differently), the legacy flips below are
        // skipped — a late/duplicate/wrong-session completion can no longer re-complete or
        // resurrect state. The weak-completed tentative path (kept 'assigned') is not a
        // terminal and bypasses the reducer by design. Legacy tasks (no attempt row) get a
        // deterministic lazy attempt and the same exactly-once guarantee.
        let reducerAllowsFlip = true;
        if (eventTaskId && !weakCompleted) {
            try {
                recordTurnStage({
                    meshId: args.meshId,
                    taskId: eventTaskId,
                    stage: 'finalizing',
                    attemptId: readNonEmptyString(args.metadataEvent.attemptId) || undefined,
                    sessionId,
                    occurredAtMs: occurredAtMs ?? undefined,
                });
                const decision = proposeTurnCompletion({
                    meshId: args.meshId,
                    taskId: eventTaskId,
                    attemptId: readNonEmptyString(args.metadataEvent.attemptId) || undefined,
                    sessionId,
                    epoch: typeof args.metadataEvent.dispatchNonce === 'number' ? args.metadataEvent.dispatchNonce : undefined,
                    outcome,
                    source: 'provider_event',
                    occurredAtMs: occurredAtMs ?? undefined,
                    evidence: {
                        event: args.event,
                        ...(readNonEmptyString(args.metadataEvent.evidenceLevel) ? { evidenceLevel: readNonEmptyString(args.metadataEvent.evidenceLevel) } : {}),
                    },
                });
                if (!decision.committed) {
                    reducerAllowsFlip = false;
                    LOG.info('TurnLedger', `Completion for task ${eventTaskId} (session ${sessionId}, outcome ${outcome}) rejected by the turn reducer: ${decision.reason} — skipping queue/dispatch flips`);
                    traceMeshEventDrop('turn_reducer_completion_rejected', traceCtx, decision.reason);
                } else if (!decision.duplicate) {
                    // Persist the outbound coordinator-completion delivery state in the same
                    // commit window, so a crash between this commit and the pending-event
                    // queue write below is recoverable on restart (outbox drain re-queues an
                    // equivalent event; the pending-events fingerprint dedup keeps it
                    // exactly-once).
                    try {
                        enqueueTerminalOutbox({
                            meshId: args.meshId,
                            taskId: eventTaskId,
                            attemptId: decision.attemptId,
                            outcome,
                            payload: {
                                event: args.event,
                                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                                sessionId,
                                providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                                // Frozen read (weakEvidenceAtEntry), not a live re-call — see the
                                // ORDERING SAFETY note where it's captured.
                                weak: weakEvidenceAtEntry,
                            },
                        });
                        scheduleTurnOutboxDrain();
                    } catch { /* outbox is a recovery backstop — never fail the completion */ }
                }
            } catch { /* reducer unavailable — the pre-Stage-5 writers govern (shadow mode) */ }
        }
        if (!reducerAllowsFlip) {
            // The reducer rejected this terminal — no queue/dispatch/delivery mutation.
            return null;
        }
        const task = weakCompleted
            ? updateSessionTaskStatus(args.meshId, sessionId, 'assigned', {
                occurredAt: occurredAtMs != null ? new Date(occurredAtMs).toISOString() : undefined,
                taskId: eventTaskId,
            })
            : updateSessionTaskStatus(args.meshId, sessionId, outcome, {
                occurredAt: occurredAtMs != null ? new Date(occurredAtMs).toISOString() : undefined,
                taskId: eventTaskId,
                // GRAPH-ORCHESTRATION Phase B: hand the normalized completion envelope to
                // the choke point so the output version persists in the SAME transaction
                // as the terminal flip (design :317-327 step 2).
                envelope: {
                    finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
                    workerResult: resolveGraphEnvelopeWorkerResult(args.metadataEvent),
                    nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                    providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                },
            });
        if (weakCompleted && task) {
            LOG.info('MeshQueue', `Weak completion (${readNonEmptyString(args.metadataEvent.evidenceLevel) || 'missing_final_assistant'}) kept queue task ${task.id} tentative (session ${sessionId}); reconcile owns the genuine terminal`);
        }
        // FALSE-COMPLETION-GIT-EVIDENCE (gap 1 fix — per-taskMode evidence, not a
        // code_change-only special case): a GENUINE (non-weak) `completed` outcome is
        // otherwise trusted purely off the worker's self-reported transcript shape for EVERY
        // task mode, not only code_change. The full per-mode dispatch (structural registry,
        // git-evidence check, readonly-contract-violation check) lives in
        // applyTaskModeCompletionEvidence (mesh-completion-side-effect-evidence.ts) — kept
        // OUT of this shared file to minimize its footprint/merge-conflict surface; see that
        // function's own doc comment for the full design rationale. It mutates
        // args.metadataEvent in place (reviewRecommended/evidenceLevel/completionDiagnostic),
        // riding the same already-wired plumbing the rest of this function reads.
        if (outcome === 'completed' && !weakCompleted && task?.taskMode && eventTaskId) {
            applyTaskModeCompletionEvidence(components, {
                meshId: args.meshId,
                nodeId: args.nodeId,
                meshNodeId: readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                sessionId,
                taskId: task.id ?? eventTaskId,
                taskMode: task.taskMode,
                preFlipAssignedAt,
                timeoutMs: FALSE_COMPLETION_GIT_CHECK_TIMEOUT_MS,
                metadataEvent: args.metadataEvent,
            });
        }
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
        // COMPLETION-PROPAGATION F2 (double safety net): the flip found no matching assigned
        // row (task === null) but the completion echoed a taskId AND a queue row for that id is
        // STILL 'assigned'. This is the stranded flip-miss case F1's equivalence match is meant
        // to reconcile — NOT a direct dispatch (which legitimately has no queue row and is
        // covered by updateDirectDispatchStatus above). Record a terminal ledger entry keyed by
        // the echoed taskId and release the single-flight lock, so the reconcile PHASE 2.5
        // terminal-ledger branch (findTerminalLedgerEvidenceForTask by row.id) has a taskId-based
        // path to flip the stranded row terminal even if the direct SQL flip could not resolve
        // it, and a subsequent reclaim/requeue is not blocked by a stale in-flight mark. Gated
        // to GENUINE terminals (a weak / false-idle completion is left for the transcript
        // reconcile, matching the leaveDirectDispatchActive philosophy above). Frozen read
        // (weakEvidenceAtEntry), not a live re-call — see the ORDERING SAFETY note where it's
        // captured: a live re-read here would see this function's OWN reviewRecommended stamp
        // (the gap-3 timeout-gate fix, and the gap-1/readonly fixes below) as if it were
        // original weak evidence, wrongly flipping this to false and skipping the safety net
        // for exactly the emittedAfterFinalizationTimeout case the CRUCIAL SCOPE comment above
        // says must stay genuine.
        const genuineTerminal = outcome === 'failed' || !weakEvidenceAtEntry;
        if (!task && eventTaskId && genuineTerminal) {
            try {
                const strandedRow = MeshRuntimeStore.getInstance().findQueueEntryById(args.meshId, eventTaskId);
                if (strandedRow && strandedRow.status === 'assigned') {
                    endTaskDispatchInFlight(args.meshId, eventTaskId);
                    if (!findTerminalLedgerEvidenceForTask({ meshId: args.meshId, taskId: eventTaskId })) {
                        appendLedgerEntry(args.meshId, {
                            kind: outcome === 'completed' ? 'task_completed' : 'task_failed',
                            sessionId,
                            nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                            payload: {
                                taskId: eventTaskId,
                                event: args.event,
                                source: 'flip_miss_safety_net',
                                finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
                            },
                        });
                    }
                } else if (strandedRow && supersedeRedriveReclaimForLateCompletion(components, args.meshId, strandedRow, sessionId, outcome, args)) {
                    // TASK-PROMPT-REDRIVE-AFTER-COMPLETE (Fix C, late-completion supersede): the row
                    // is NOT 'assigned' — it was re-driven (reclaimed → 'pending', or already
                    // re-dispatched to a fresh session) because the long delivered-no-turn deadline
                    // fired before this genuine completion propagated. The completion proves the
                    // ORIGINAL worker finished, so it SUPERSEDES the re-drive: the helper flipped the
                    // row terminal and stopped any duplicate re-dispatch (handled inside).
                }
            } catch { /* best-effort safety net — never fail the completion path */ }
        }
        setImmediate(() => cleanupTerminalDirectDispatches());
        return task ? { id: task.id, taskMode: task.taskMode } : null;
    }

    let completedTaskForLedger: { id?: string; taskMode?: string } | null = null;
    // FINALIZATION-TIMEOUT-FORCE (2026-08-18 false-completion fix): a weak completion
    // emitted AFTER the finalization wait expired (emittedAfterFinalizationTimeout) is
    // recorded as a FORCED TERMINATION — outcome 'failed', ledger task_failed, and a
    // coordinator message that says "no response, forcibly terminated" — never as
    // 'completed'. A timeout is never completion evidence; the liveness guarantee is
    // preserved because the row still flips TERMINAL (failed), just not to 'completed'.
    // Set in the agent:generating_completed branch; read by the ledger append below.
    let forcedTimeoutNoResponse = false;
    // Fix B: direct-dispatch taskId used to attribute the terminal ledger entry when no
    // work-queue row matches (resolved BEFORE markSessionTerminal flips the dispatch terminal).
    let directDispatchTaskIdForLedger: string | undefined;
    // BOOTSTRAP-MSG: whether a queued task already targets this node, so the
    // worktree_bootstrap_complete [System] message reflects the auto-claim instead of
    // advising a manual mesh_launch_session (which would spawn a duplicate session).
    let worktreeHasQueuedTask = false;
    if (args.event === 'agent:generating_completed') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);

        if (sessionId) {
            // CANON-B / ARCH-REFACTOR R1: trust the taskId the completion echoed. With R1's
            // per-turn identity binding the worker stamps the COMPLETING turn's own taskId
            // (not the racy session scalar), so the echoed id is authoritative and this is
            // the path that should always be taken for an R1+ worker. The most-recent-by-
            // session heuristic (resolveActiveDirectDispatchTaskId) is retained ONLY as a
            // backward-compat fallback for legacy / version-skewed workers that carry no
            // taskId — it is the very re-derive R1 exists to make unnecessary, and must not
            // override a present echoed id, hence the `||` short-circuit order.
            directDispatchTaskIdForLedger = readNonEmptyString(args.metadataEvent.taskId)
                || resolveActiveDirectDispatchTaskId(args.meshId, sessionId);
            // A false-idle completion of a direct dispatch is recorded but kept tentative (the
            // dispatch row stays active for the reconcile fallback); a genuine completion is terminal.
            const isFalseIdle = isFalseIdleCompletion(args.metadataEvent);
            // FINALIZATION-TIMEOUT-FORCE: a weak completion emitted only because the finalization
            // wait expired is a forced termination, not a completion — flip 'failed' (terminal,
            // never wedge) so the task is visibly unconfirmed instead of falsely completed.
            // Computed BEFORE markSessionTerminal mutates args.metadataEvent (the frozen-read
            // ordering contract inside it), so this equals its weakEvidenceAtEntry snapshot.
            forcedTimeoutNoResponse = isWeakCompletionEvidence(args.metadataEvent)
                && (args.metadataEvent.completionDiagnostic
                    && typeof args.metadataEvent.completionDiagnostic === 'object'
                    && (args.metadataEvent.completionDiagnostic as Record<string, unknown>).emittedAfterFinalizationTimeout === true) === true;
            completedTaskForLedger = markSessionTerminal(sessionId, forcedTimeoutNoResponse ? 'failed' : 'completed', eventTimestamp, { tentativeIfDirect: isFalseIdle });
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
            // A forced-termination (finalization timeout, no response) is NOT a completion
            // — dependents are not woken off it; the derived-failure machinery owns them.
            const completedTaskId = completedTaskForLedger?.id;
            if (completedTaskId && !forcedTimeoutNoResponse && hasPendingDependents(args.meshId, completedTaskId)) {
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
            // WORKTREE-BOOTSTRAP-DISPATCH-RACE: a freshly cloned worktree session emits
            // agent:ready as soon as the CLI process reaches its idle prompt — which happens
            // BEFORE the worktree bootstrap (npm install + native-addon repair: node-datachannel,
            // better-sqlite3, ghostty-vt-node) has finished. Claiming a queued task on that early
            // ready dispatches work into a session whose runtime is half-built: the child daemon
            // dies loading the absent native addon → the worker session boots empty (no task ever
            // injected), the queue row reports assigned-but-dead, and the work silently leaks to /
            // gets re-routed onto the base node. Live evidence (the OPSRULES dispatch): node
            // node_6df455dd emitted agent:ready at 10:36:28 but worktree_bootstrap_complete only at
            // 10:36:56 — a 28s window in which a claim produced an empty session.
            //
            // Gate the claim on bootstrap state: if this node is a worktree whose bootstrap is still
            // 'running', register the idle session (so it stays a claim candidate) but DEFER the
            // claim. The claim re-fires on the next agent:ready / reconcile drain tick once bootstrap
            // reaches a terminal state. 'failed' is left to flow through unchanged — a failed
            // bootstrap surfaces its own coordinator event and a dispatch there fails loudly rather
            // than silently, which is the correct, visible behavior (deferring forever would hide it).
            let worktreeBootstrapPending = false;
            try {
                const mesh = getMeshWithCache(components, args.meshId);
                const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId)) as { worktreeBootstrap?: { status?: string } } | undefined;
                worktreeBootstrapPending = node?.worktreeBootstrap?.status === 'running';
            } catch { /* best-effort: unknown bootstrap state → do not defer (prior behavior) */ }

            sweepExpiredRemoteIdleSessions();
            try {
                MeshRuntimeStore.getInstance().setRemoteIdleSession(args.meshId, nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
            } catch { /* best-effort */ }
            if (worktreeBootstrapPending) {
                LOG.info('MeshQueue', `Deferring queue claim for worktree node ${nodeId} (${sessionId}): worktree bootstrap still running — early agent:ready precedes bootstrap completion; the idle session is registered and the claim will re-fire once bootstrap finishes (guards against dispatching into a half-built worktree → empty session / work leaking to the base node)`);
            } else {
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
            // REDRIVE-DUP: reject a STALE dispatch. When a delivered-but-unconsumed task is
            // reclaimed (reclaimStrandedAssignedTask) and re-dispatched to another node, the
            // ORIGINAL inject to the first node is not cancelled — it can still fire and make
            // that worker start the SAME taskId, double-executing it. The reclaim bumped the
            // task row's dispatchNonce, so the stranded inject's generating_started echoes a
            // nonce STRICTLY LESS than the row's current value. Detect that here: skip the ack
            // (do NOT resurrect the row onto this stale session) and stop the worker so it
            // discards the reclaimed task. A matching/greater nonce, or an absent nonce
            // (legacy worker), falls through to the normal ack — backward safe.
            const startedNonce = typeof args.metadataEvent.dispatchNonce === 'number'
                ? args.metadataEvent.dispatchNonce
                : undefined;
            if (startedTaskId && startedNonce !== undefined) {
                const currentRow = (() => {
                    try { return MeshRuntimeStore.getInstance().findQueueEntryById(args.meshId, startedTaskId); }
                    catch { return null; }
                })();
                const currentNonce = typeof currentRow?.dispatchNonce === 'number' ? currentRow.dispatchNonce : undefined;
                // TURN-LEDGER (Stage 5): the (taskId, attemptId, session) authority now
                // classifies the echo. A nonce below the row's current value is STALE only
                // when it comes from a DIFFERENT session than the current attempt's worker
                // (a genuinely superseded dispatch). When the echo comes FROM the current
                // assignee session — e.g. a reclaim bumped the nonce and re-dispatched to
                // the SAME session, and the resumed worker echoes its pre-reclaim nonce —
                // it is a resumption artifact: accept it and NEVER stop that worker (the
                // old guard killed the current legitimate assignee here).
                const classification = classifyNonceEcho({
                    meshId: args.meshId,
                    taskId: startedTaskId,
                    sessionId,
                    nonce: startedNonce,
                    currentNonce,
                });
                if (classification === 'same_session_compat') {
                    traceMeshEventStage('same_session_stale_nonce_compat', {
                        taskId: startedTaskId,
                        sessionId,
                        nodeId,
                        meshId: args.meshId,
                        event: 'agent:generating_started',
                    }, `nonce ${startedNonce} < ${currentNonce} accepted (current assignee)`);
                }
                if (classification === 'stale' && currentNonce !== undefined && startedNonce < currentNonce) {
                    LOG.warn('MeshQueue', `Rejecting stale mesh dispatch: task ${startedTaskId} generating_started from session ${sessionId} `
                        + `(node ${nodeId ?? '?'}) carries dispatchNonce ${startedNonce} < current ${currentNonce} — the task was reclaimed and `
                        + `re-dispatched; stopping this worker to prevent duplicate execution.`);
                    traceMeshEventDrop('stale_dispatch_nonce_rejected', {
                        taskId: startedTaskId,
                        sessionId,
                        nodeId,
                        meshId: args.meshId,
                        event: 'agent:generating_started',
                    }, `nonce ${startedNonce} < ${currentNonce}`);
                    stopStaleMeshWorker(components, {
                        meshId: args.meshId,
                        sessionId,
                        nodeId,
                        providerType: readNonEmptyString(args.metadataEvent.providerType) || readNonEmptyString(args.metadataEvent.cliType),
                        daemonId: readNonEmptyString(args.metadataEvent.sourceDaemonId) || readNonEmptyString(args.metadataEvent.daemonId),
                    });
                    return { success: true, forwarded: 0, suppressed: true, staleDispatchRejected: true };
                }
            }
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
            // DELIVERED-NOT-CONSUMED-REDRIVE: ack the delivery via consumeSessionDelivery, which
            // matches rows INCLUDING 'delivered'. The prior path filtered getActiveSessionDeliveries
            // — whose SQL EXCLUDES 'delivered' — so in the normal event order (transport confirm
            // flips 'delivered' BEFORE generating_started fires) the ack matched zero rows and the
            // delivery was stranded 'delivered', never reaching the 'acked' consume signal that
            // taskDeliveryConsumed() keys on. The store's monotonic guard only advances the row.
            // With a named taskId, key on (mesh, task); otherwise fall back to the whole session.
            consumeSessionDelivery(args.meshId, sessionId, 'acked', startedTaskId);
            // TURN-LEDGER (Stage 5): provider turn start IS the consumed evidence — the
            // prompt provably belongs to the active attempt. Record the consumed ACK and
            // the generating stage (idempotent; reordered/duplicate arrivals are no-ops).
            // From here on the attempt is injection-ineligible — no redrive may ever
            // re-inject this prompt.
            if (startedTaskId) {
                try {
                    const echoAttemptId = readNonEmptyString(args.metadataEvent.attemptId) || undefined;
                    // Session authority over the echoed id (Stage 5 contract): a same-session
                    // resumption may echo the PRE-reclaim attemptId. When the CURRENT attempt
                    // is bound to THIS session, the event belongs to the current attempt
                    // regardless of the echoed id; an echo from a DIFFERENT session keeps the
                    // echoed id so the reducer records it as a stale old-attempt event (inert).
                    const attemptIdForAck = (() => {
                        try {
                            const store = MeshRuntimeStore.getInstance();
                            const current = store.getCurrentTurnAttempt(args.meshId, startedTaskId);
                            if (!current) return echoAttemptId; // legacy task — reducer resolves lazily
                            if (!echoAttemptId || echoAttemptId === current.attemptId) return current.attemptId;
                            if (current.sessionId && sessionIdsEquivalent(current.sessionId, sessionId)) return current.attemptId;
                            return echoAttemptId;
                        } catch { return echoAttemptId; }
                    })();
                    recordTurnAck({
                        meshId: args.meshId,
                        taskId: startedTaskId,
                        kind: 'consumed',
                        attemptId: attemptIdForAck,
                        sessionId,
                        occurredAtMs: eventTimestamp ?? undefined,
                        evidence: { event: 'agent:generating_started' },
                    });
                    recordTurnStage({
                        meshId: args.meshId,
                        taskId: startedTaskId,
                        stage: 'generating',
                        attemptId: attemptIdForAck,
                        sessionId,
                        occurredAtMs: eventTimestamp ?? undefined,
                    });
                } catch { /* turn-ledger recording is best-effort — the delivery consume above already landed */ }
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
    } else if (args.event === 'worktree_bootstrap_complete' || args.event === 'worktree_bootstrap_failed') {
        // WORKTREE-BOOTSTRAP-REFIRE: the agent:ready branch above DEFERS the queue claim while
        // worktreeBootstrap.status === 'running' — a freshly cloned worktree emits agent:ready at
        // its idle prompt BEFORE bootstrap finishes, and dispatching then produces a half-built
        // session. The defer registers the idle session (setRemoteIdleSession) but schedules NO
        // retry; it relies on "the next agent:ready / reconcile drain tick" to re-fire. But
        // agent:ready is a one-shot (emitAgentReadyOnce, guarded by agentReadyEmitted) and the
        // session stays idle→idle after bootstrap, so no new agent:ready edge ever fires → the
        // deferred claim is stranded → the worker session boots empty (totalMessages=0) and the
        // coordinator relaunch/stop-loops. Re-fire the queue drain on the terminal bootstrap
        // transition: the idle session registered at defer time is now claimable (tryAssignQueueTask
        // has no bootstrap gate of its own). This runs on whichever daemon processes the event —
        // the local worker (when it co-hosts the coordinator) at emit time, or the remote
        // coordinator after it pulls the queued event — so the registered local/remote idle session
        // is drained in every topology. 'failed' is re-fired too so a deferred-then-failed bootstrap
        // dispatches and fails loudly/visibly rather than stranding silently. Falls through to the
        // coordinator broadcast below — the bootstrap event is still delivered to the coordinator.
        // WORKTREE-BOOTSTRAP-COORD-STATE: stamp the terminal bootstrap status onto the
        // COORDINATOR's mesh view BEFORE re-firing the queue. The clone+bootstrap ran on
        // the worker daemon (clone_mesh_node forwards to the source node's machine), so
        // persistWorktreeSetupState only flipped status→'complete' on the worker's mesh
        // object — the coordinator still holds the 'running' state it stamped from the
        // forwarded clone reply. Without this, the claim gate (agent:ready defer above +
        // mesh-queue-assignment) reads getMeshWithCache, sees 'running' forever, and
        // defers every claim — so this very re-fire loops against a gate that never opens
        // (claim never lands; idle session re-registered each tick; auto-launch spawns a
        // fresh session every cycle → runaway worktree-session multiplication). Stamping
        // the terminal state opens the gate so the deferred claim lands on this re-fire.
        const bootstrapNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (bootstrapNodeId) {
            try {
                // Fix (3): pass the worktree path so a hydrate-on-miss upsert (when this
                // coordinator never received the clone reply) can seed an addressable node.
                const bootstrapWorkspace = readNonEmptyString(args.metadataEvent.worktreePath)
                    || readNonEmptyString(args.metadataEvent.workspace);
                // DIRECT typed call, not `(components.router as any)?.method?.()`: the
                // optional-chain + cast form swallowed a missing router/method into a SILENT
                // no-op — indistinguishable from "stamped but the view never updated", which
                // is exactly the ambiguity that made the bootstrap-stuck log spam (see the
                // stale-backstop bypass in mesh-queue-assignment) undiagnosable. router is a
                // required DaemonComponents field and the method is public, so presence is
                // type-enforced; if a partial harness ever violates that, the TypeError lands
                // in this catch and is WARNED instead of vanishing.
                components.router.markWorktreeBootstrapTerminalState(
                    args.meshId,
                    bootstrapNodeId,
                    args.event === 'worktree_bootstrap_failed' ? 'failed' : 'complete',
                    bootstrapWorkspace ? { workspace: bootstrapWorkspace } : undefined,
                );
            } catch (e: any) {
                LOG.warn('MeshQueue', `Failed to stamp terminal bootstrap state for ${bootstrapNodeId} (mesh ${args.meshId}): ${e?.message || e}`);
            }
        }
        // BOOTSTRAP-MSG: detect whether the queue re-fire below has a task to auto-claim for
        // this node BEFORE setImmediate(triggerMeshQueue) runs — at this point a deferred task
        // is still 'pending' (it has not been claimed yet); 'assigned' covers a task already
        // claimed by an earlier tick. Either case means a session is being/has been spun up by
        // the queue, so the completion message must NOT advise a manual mesh_launch_session.
        // Only meaningful for the 'complete' transition (a failed bootstrap claims nothing).
        if (args.event === 'worktree_bootstrap_complete' && bootstrapNodeId) {
            try {
                const nowMs = Date.now();
                worktreeHasQueuedTask = getQueue(args.meshId, { status: ['pending', 'assigned'] })
                    .some((task) => bootstrapQueueTaskCountsAsHandled(task, bootstrapNodeId, nowMs));
            } catch (e: any) {
                LOG.warn('MeshQueue', `Failed to check queued task for ${bootstrapNodeId} (mesh ${args.meshId}): ${e?.message || e}`);
            }
        }
        setImmediate(() => {
            triggerMeshQueue(components, args.meshId).catch((e: any) => {
                LOG.warn('MeshQueue', `Queue re-fire after ${args.event} failed (mesh ${args.meshId}): ${e?.message || e}`);
            });
        });
    }

    // FINALIZATION-TIMEOUT-FORCE: the forced-termination flip above recorded the row as
    // 'failed' — the ledger entry must say the same (task_failed), not task_completed.
    const ledgerKind = forcedTimeoutNoResponse ? 'task_failed' as const : EVENT_TO_LEDGER_KIND[args.event];
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
                    // NOTIF Defect-2b: ONLY source==='default' (no parseable answer at all) is
                    // 'insufficient'. 'parseable_answer' (a real JSON answer that just isn't
                    // worker-result-shaped, e.g. a MAGI envelope) is concrete evidence and must
                    // resolve to 'sufficient' — resolveWorkerResult now upgrades that case so a
                    // complete, valid answer is no longer mislabelled insufficient/reviewRecommended.
                    //
                    // EVIDENCE-LEVEL-UNIFY: the LEDGER value is merged with whatever
                    // applyTaskModeCompletionEvidence already stamped onto
                    // args.metadataEvent.evidenceLevel earlier in markSessionTerminal, so a
                    // 'reported' stamp can never make the ledger forget a locally-computed
                    // 'insufficient' (and vice versa). See resolveUnifiedCompletionEvidenceLevel.
                    //
                    // ONE-WAY ON PURPOSE — do NOT write the resolved level back onto
                    // args.metadataEvent. That mutation looks like the natural way to make the
                    // later buildMeshSystemMessage read agree with the ledger, but
                    // metadataEvent.evidenceLevel is load-bearing for DEDUP, not just wording:
                    // buildPendingEventFingerprint (mesh-events-pending.ts) keys terminal
                    // completions `…::weak` / `…::genuine` off isWeakCompletionMetadata, which
                    // reads this very field. Stamping 'insufficient' back onto an ordinary
                    // completion (workerResult.source === 'default' is the COMMON plain-text
                    // finalSummary case, not an anomaly) moves it into the `::weak` slot, where
                    // it collides with an earlier weak synth for the same taskId and the
                    // genuine completion is dropped as a duplicate — the exact swallow that
                    // EARLYNOTIFY-GATEBYPASS guards against. The ledger records the stricter
                    // verdict; the coordinator-facing weakness signal stays owned by the
                    // producers that set it deliberately.
                    ...(() => {
                        const computedLevel = completionEvidence
                            ? completionEvidence.workerResult.source === 'default' ? 'insufficient' as const : 'sufficient' as const
                            : undefined;
                        const resolvedLevel = resolveUnifiedCompletionEvidenceLevel({
                            computedLevel,
                            priorLevel: readNonEmptyString(args.metadataEvent.evidenceLevel),
                        });
                        if (!resolvedLevel) return {};
                        return resolvedLevel === 'insufficient'
                            ? { evidenceLevel: resolvedLevel, reviewRecommended: true }
                            : { evidenceLevel: resolvedLevel };
                    })(),
                    // FALSE-COMPLETION-GIT-EVIDENCE: markSessionTerminal's synchronous git-clean
                    // gate stamps this onto metadataEvent BEFORE this ledger append runs — OR it
                    // into reviewRecommended (never downgrade the NOTIF Defect-2b verdict above)
                    // so a text-sufficient-but-workspace-clean completion still lands in the
                    // ledger with a review flag, matching what buildMeshSystemMessage already
                    // surfaced to the coordinator off the same metadataEvent mutation.
                    ...(args.metadataEvent.reviewRecommended === true ? { reviewRecommended: true } : {}),
                },
            });
            if (ledgerKind === 'task_completed') {
                scheduleTaskCompletionSideEffectEvidence(components, {
                    meshId: args.meshId,
                    taskId: completedTaskForLedger?.id || directDispatchTaskIdForLedger || undefined,
                    taskMode: completedTaskForLedger?.taskMode,
                    sessionId: ledgerSessionId,
                    nodeId: ledgerNodeId,
                });
            }
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
                        // DIFFICULTY-REQUIRED (recovery inheritance + fallback):
                        // enqueueTask now REQUIRES a difficulty, and this path re-enqueues a
                        // task the coordinator already classified — so inherit that
                        // classification from the ledger (getSessionRecoveryContext reads
                        // resolvedDifficulty off the same task_dispatched entry the message
                        // came from) rather than re-guessing it here.
                        //
                        // FALLBACK IS DELIBERATE AND MUST NOT THROW. This is the failure-
                        // RECOVERY path: it only ever runs because something already went
                        // wrong, and losing the relaunch is strictly worse than losing the
                        // difficulty hint. A legacy ledger entry (written before
                        // resolvedDifficulty existed), a direct dispatch that predates the
                        // required-difficulty guard, or an unparseable payload all yield null
                        // here. In that case fall back to 'freeform' — the axis member meaning
                        // "no difficulty-based constraint" — so the relaunch proceeds with
                        // ordinary routing, exactly the behaviour this path had when difficulty
                        // was optional. Do NOT convert this into a hard error.
                        const inheritedDifficulty = recoveryContext.lastTaskDifficulty ?? 'freeform';
                        if (!recoveryContext.lastTaskDifficulty) {
                            LOG.info('MeshRecovery', `No inheritable difficulty on the failed task's dispatch entry; relaunching with 'freeform' (ordinary routing).`);
                        }
                        const task = enqueueTask(args.meshId, recoveryContext.lastTaskMessage, {
                            targetNodeId: autoNodeId,
                            difficulty: inheritedDifficulty,
                        });
                        LOG.info('MeshRecovery', `Auto-requeued failed task: ${task.id} for node ${autoNodeId}`);

                        const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, autoNodeId));
                        // QUOTA GATE (recovery-relaunch path): the launch and claim paths both
                        // consult evaluateProviderQuotaGate; this one did not — it relaunched
                        // whatever provider had just died, so a quota-caused death repeated
                        // itself. The gate reads the provider's quota SNAPSHOT and never the
                        // death itself: a session that died with healthy quota (e.g. a CLI
                        // exiting 0 on an un-trusted worktree path) is not a quota signal, fails
                        // open, and relaunches exactly as before — as does an expired-token or
                        // other transient reading without fresh retained low windows, so a
                        // single-provider node can still relaunch the CLI that owns its own
                        // token refresh. Only a measured block diverts: to another gate-clear
                        // provider on this node, else to no relaunch, leaving the task ALREADY
                        // re-queued above pending for the drain. See resolveRecoveryRelaunchProvider.
                        const relaunch = node
                            ? resolveRecoveryRelaunchProvider(
                                node,
                                recoveryContext.failedProviderType,
                                resolveNodeCapabilitySlots(node, args.meshId).map((s: any) => s.provider),
                                mesh?.policy?.quotaRouting ?? null,
                                Date.now(),
                                // LIVE LOCAL READ: local nodes resolve against this
                                // daemon's live quota cache, not the git_status-stamped
                                // nodeFacts copy (mesh-quota-routing). Remote nodes keep
                                // reading their reported nodeFacts.
                                quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader),
                            )
                            : { action: 'block' as const };
                        const relaunchProviderType = relaunch.action === 'block' ? null : relaunch.providerType;
                        if (node) {
                            const gateLog = describeRecoveryRelaunchDecision(relaunch, autoNodeId, recoveryContext.failedProviderType, task.id);
                            if (gateLog) LOG.info('MeshRecovery', gateLog);
                        }
                        if (node && relaunchProviderType) {
                            components.cliManager.handleCliCommand('launch_cli', {
                                cliType: relaunchProviderType,
                                dir: node.workspace,
                                settings: {
                                    role: 'worker',
                                    meshNodeFor: args.meshId,
                                    meshNodeId: node.id,
                                    spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                                    // Coordinator-dispatched recovery relaunch: same auto-approve
                                    // policy as the primary worker launch path.
                                    ...delegatedWorkerAutoApproveSettings(
                                        mesh?.policy,
                                        node?.policy,
                                        components.providerLoader?.getMeta(relaunchProviderType),
                                        // Recovery relaunch: same repo-declared requested mode as the
                                        // primary path. node.workspace missing → null → provider default.
                                        (() => {
                                            const ws = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
                                            if (!ws) return null;
                                            try {
                                                const r = loadRepoMeshJsonConfig(ws);
                                                return r.sourceType === 'repo_file' && r.config ? r.config : null;
                                            } catch { return null; }
                                        })(),
                                        relaunchProviderType,
                                    ),
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
        worktreeHasQueuedTask,
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
        // T4 (B3b): restore the v2 envelope from the remote relay so the re-queue keeps the
        // ORIGINAL eventId. Spread LAST so its authoritative eventId/scope/identity win over
        // any default. queuePendingMeshCoordinatorEvent → stampPendingEventV2 then no-ops
        // (already-stamped short-circuit) instead of minting a fresh eventId. Empty object
        // for a v1 relay → unchanged v1 emit-stamp path (version-skew safe).
        ...(args.v2Envelope ?? {}),
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
        attemptId: readNonEmptyString(payload.attemptId) || readNonEmptyString(payload.meshActiveAttemptId),
        ...(typeof payload.dispatchNonce === 'number'
            ? { dispatchNonce: payload.dispatchNonce }
            : (typeof payload.meshActiveDispatchNonce === 'number'
                ? { dispatchNonce: payload.meshActiveDispatchNonce }
                : {})),
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
        // RC32: preserve the originating coordinator DAEMON anchor across the machine
        // boundary — the daemon-level analogue of meshCoordinatorSessionId above. A
        // sessionless producer (async refine terminal relayed via handleMeshForwardEvent)
        // carries no session stamp; without this mirror the receive-side fallback in
        // injectMeshSystemMessage has nothing to read and the re-queued event
        // self-fallbacks to THIS daemon's id, stranding it from the real coordinator.
        targetCoordinatorDaemonId: readNonEmptyString(payload.targetCoordinatorDaemonId),
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
        evidenceLevel: readNonEmptyString(payload.evidenceLevel),
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
        // agent:waiting_choice (mission f1d25e11): carry the FULL structured question
        // payload across the machine boundary so a REMOTE worker's AskUserQuestion reaches
        // the coordinator with every question + option intact — the coordinator renders
        // these and answers with mesh_answer_question. The local in-process forward path
        // preserves the whole event for free; this mirrors the fields for the remote relay.
        ...(payload.interactivePrompt && typeof payload.interactivePrompt === 'object' && !Array.isArray(payload.interactivePrompt) ? { interactivePrompt: payload.interactivePrompt } : {}),
        ...(readNonEmptyString(payload.promptId) ? { promptId: readNonEmptyString(payload.promptId) } : {}),
        ...(payload.multiSelect === true ? { multiSelect: true } : {}),
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
        // T4 (B3b): restore the v2 envelope carried at the top level of the relayed flat
        // payload (buildForwardPayloadFromPending → serializeV2EnvelopeToWire) so the
        // re-queue preserves the original eventId (idempotency) and unicast routing rather
        // than re-stamping a fresh v1/broadcast event. Empty for a v1 relay (version-skew safe).
        v2Envelope: readV2EnvelopeFromWire(payload),
    });
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
// The fix: the routing object still carries coordinatorDaemonId. Persist the raw event
// to the durable worker-side outbox addressed to that coordinator daemon; the reconcile
// loop's PHASE 0 delivers it (mesh_forward_event, acked, retry-capped). The coordinator
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
// fallback was possible (no coordinator anchor / no dispatch transport) OR the durable
// enqueue itself failed — the delivery_unroutable diagnostic is thereby narrowed to
// "could not even persist to the queue" (a real potential loss), per the polling-
// single-model design (docs/refactoring/2026-06-16-mesh-completion-polling-single-model.md §2.1/§2.6).
//
// Single delivery path (polling single-model): the spontaneous best-effort immediate
// push that used to run here was REMOVED. Every unresolved-delegate event is persisted
// to the outbox and delivered ONLY by setupMeshReconcileLoop's PHASE 0 retry (acked;
// a failed push leaves the row queued). For happy-path latency the enqueue emits a
// data-free reconcile NUDGE (nudgeUnresolvedForwardRetry) asking the loop to run the
// retry soon; a lost nudge costs at most one reconcile interval, never the event.
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

    // Persist durably. Idempotent on fingerprint, so a re-fired completion does not
    // duplicate the outbox row. The outbox is the ONLY delivery route now (no
    // spontaneous push), so a hard persistence failure means the event has nowhere to
    // live — return false so the caller records the delivery_unroutable diagnostic,
    // which is thereby narrowed to exactly this "could not even enqueue" real-loss case.
    const persisted = enqueueUnresolvedDelegateForward(coordinatorDaemonId, eventName, payload);
    // EVTTRACE: unresolved-mesh worker persisted its completion to the outbox (no meshId
    // available locally; coordinator will recover it on receive).
    const fwdTraceCtx = {
        taskId: (payload as Record<string, unknown>).taskId,
        sessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
        nodeId: readNonEmptyString(routing.nodeId) || readNonEmptyString(event.meshNodeId),
        event: eventName,
    };
    if (!persisted) {
        traceMeshEventDrop('outbox_enqueue_failed', fwdTraceCtx, `coordinatorDaemon=${coordinatorDaemonId}`);
        return false;
    }
    traceMeshEventStage('outbox_enqueue', fwdTraceCtx, `coordinatorDaemon=${coordinatorDaemonId} meshId=${readNonEmptyString(payload.meshId) || 'absent'}`);

    // Data-free reconcile nudge (polling single-model §2.1 (B)): ask the reconcile
    // loop to run its PHASE 0 outbox retry soon instead of pushing the payload here.
    // Delivery itself stays on the single acked PHASE 0 path; losing the nudge costs
    // at most one reconcile interval of latency, never the event.
    nudgeUnresolvedForwardRetry();
    LOG.info('MeshEvents', `Durably queued ${eventName} for unresolved-mesh worker at ${routing.workspace || '(no workspace)'} to coordinator daemon ${coordinatorDaemonId} (reconcile PHASE 0 delivers)`);
    return true;
}

/**
 * NOTIF-HELD-DRAIN (Fix 2): event-driven coordinator drain. The reconcile loop delivers a
 * worker's queued completion to an IDLE local coordinator only on its periodic poll. When a
 * coordinator is sitting idle awaiting exactly that completion, waiting up to a full poll
 * interval is the avoidable delivery latency the RCA flags — and combined with the (now-fixed)
 * modal-park false-positive it stretched into the multi-minute notification stall. So the
 * MOMENT a worker delegate event is persisted for a mesh, attempt the same idle-coordinator
 * drain immediately, mirroring the event-driven worker-claim path (agent:ready /
 * agent:generating_completed → triggerMeshQueue).
 *
 * Safety:
 *  - drainPendingMeshCoordinatorEvents marks rows drained=1 atomically, so this races the
 *    reconcile poll and the coordinator's own idle auto-flush harmlessly — exactly one consumes
 *    each row.
 *  - Only IDLE, non-modal-parked coordinators are delivery targets (never a generating /
 *    consent-modal PTY).
 *  - Strict session routing is honoured: an event naming an originating coordinator session is
 *    delivered only to that live idle session; anything not currently deliverable here
 *    (wrong/absent session, or a message-less lifecycle event) is RE-QUEUED — never dropped —
 *    so the reconcile loop's strict hold/expire path remains the single authority for it.
 */
export function flushPendingForMeshIdleCoordinators(components: DaemonComponents, meshId: string): void {
    // O(1) gate: skip the (relatively expensive) per-instance getState scan when the queue is
    // empty for this mesh.
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.pendingEventCount(meshId) === 0) return;
    } catch { /* store unavailable — fall through and let the drain decide */ }

    const idleCoordinators: { instance: ProviderInstance; sessionId: string }[] = [];
    try {
        for (const inst of components.instanceManager.getByCategory('cli')) {
            const state = inst.getState();
            const settings = state.settings && typeof state.settings === 'object'
                ? state.settings as Record<string, unknown>
                : {};
            if (readNonEmptyString(settings.meshCoordinatorFor) !== meshId) continue;
            const status = readNonEmptyString(state.status).toLowerCase();
            const modalParked = typeof (inst as any).isModalParked === 'function'
                ? (inst as any).isModalParked() === true
                : (status === 'waiting_choice' || status === 'waiting_approval');
            // PTY-OVERTRUST-DRAIN (Defect B): decide idle on the RAW adapter turn-state
            // (getDrainStatus, mask-stripped) to match the reconcile loop — getState().status
            // overlays the auto-approve hold-idle mask that paints a genuinely-idle coordinator
            // `generating`, which would make this opportunistic flush skip a real drain target.
            // Fall back to the masked literal for any instance without getDrainStatus().
            const drainStatus: string | null = typeof (inst as any).getDrainStatus === 'function'
                ? (inst as any).getDrainStatus()
                : null;
            const idle = drainStatus !== null ? drainStatus === 'idle' : (status === 'idle');
            if (idle && !modalParked) {
                idleCoordinators.push({ instance: inst, sessionId: readNonEmptyString(state.instanceId) });
            }
        }
    } catch { return; }
    if (idleCoordinators.length === 0) return; // no idle target now → leave for the reconcile poll

    const drainDaemonIds = resolveCoordinatorDrainDaemonIds(components);
    let pendingEvents: PendingMeshCoordinatorEvent[];
    try {
        pendingEvents = drainPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch (e: any) {
        LOG.warn('MeshEvents', `Event-driven coordinator drain failed for mesh ${meshId}: ${e?.message || e}`);
        return;
    }
    if (pendingEvents.length === 0) return;

    let delivered = 0;
    for (const pending of pendingEvents) {
        const wantSession = readNonEmptyString(pending.targetCoordinatorSessionId);
        const targets = wantSession
            ? idleCoordinators.filter(c => sessionIdsEquivalent(c.sessionId, wantSession))
            : idleCoordinators;
        // Not deliverable into an idle target here (wrong/absent session), or a message-less
        // lifecycle event (agent:ready / generating_started carry no coordinatorMessage and
        // must not be injected): re-queue so the reconcile loop owns it (lazy-synth / strict
        // hold/expire). Re-queue preserves queuedAt so the strict TTL measures true age.
        if (targets.length === 0 || !pending.coordinatorMessage) {
            // MUST be requeueDrainedPendingMeshCoordinatorEvent, not
            // queuePendingMeshCoordinatorEvent: this event was just DRAINED, and the
            // normal persist path cannot return a drained event to the queue. The
            // drained row still occupies UNIQUE (mesh_id, fingerprint), so INSERT OR
            // IGNORE silently discards the fresh copy while hasPendingEventFingerprint
            // (which filters drained = 0) reports no duplicate — the caller is told the
            // re-queue worked when nothing was written. The requeue helper instead flips
            // the existing row back to drained = 0, which also clears the v2 eventId
            // drained-baseline. queuedAt is preserved either way, so the strict TTL keeps
            // measuring true age.
            //
            // This was masked until now: the retired JSONL mirror re-appended the line
            // unconditionally, so the event came back on the next drain even though the
            // SQLite half was a no-op.
            try { requeueDrainedPendingMeshCoordinatorEvent(pending); } catch { /* best-effort re-queue */ }
            continue;
        }
        const message = pending.coordinatorMessage;
        const force = shouldForceInjectMeshEvent(pending.event);
        for (const c of targets) {
            c.instance.onEvent('send_message', {
                input: { text: message, textFallback: message },
                ...(force ? { force: true } : {}),
            });
            delivered++;
        }
    }
    if (delivered > 0) {
        LOG.info('MeshEvents', `Event-driven drain delivered ${delivered} pending event(s) to ${idleCoordinators.length} idle coordinator(s) for mesh ${meshId}`);
    }
}

export function setupMeshEventForwarding(components: DaemonComponents) {
    // GRAPH-ORCHESTRATION Phase B: drain target for the graph outbox's queue_wake
    // events (design :323-327 step 9). The wake rides the ORDINARY triggerMeshQueue —
    // the graph engine never dispatches directly. Registered here because this module
    // owns DaemonComponents; the transition runner deliberately imports no dispatch code.
    registerMeshGraphQueueWakeHandler((wakeMeshId) => {
        setImmediate(() => {
            triggerMeshQueue(components, wakeMeshId).catch((e: any) => {
                LOG.warn('MeshQueue', `Graph queue-wake trigger failed (mesh ${wakeMeshId}): ${e?.message || e}`);
            });
        });
    });
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
                                } else {
                                    // Nothing to flush → this idle edge left the coordinator with an
                                    // empty inbox. If the mesh is fully idle but still has active
                                    // missions, nudge (once/debounced) so a lingering mission is not
                                    // left drifting in 'active'. Suppressed when events WERE injected,
                                    // so we never pile a reminder on top of real completion traffic.
                                    maybeInjectIdleActiveMissionReminder(
                                        coordinatorMeshId,
                                        flushSource,
                                        getMesh(coordinatorMeshId)?.policy,
                                        undefined,
                                        components.instanceManager,
                                    );
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
                                getActiveDirectDispatches(coordinatorMeshId).some(d => sessionIdsEquivalent(d.sessionId, flushInstanceId))
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

        // NOTIF-HELD-DRAIN (Fix 2): the worker's event is now persisted in the pending queue.
        // If a local coordinator for this mesh is sitting idle awaiting it, deliver immediately
        // instead of waiting up to a full reconcile interval (event-driven, mirrors the
        // worker-claim path). No-op when no idle coordinator is present (held for reconcile).
        flushPendingForMeshIdleCoordinators(components, routing.meshId);
    });
}
