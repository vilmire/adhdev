import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, getSessionRecoveryContext, isIntentionalCleanupStopEntry, readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerKind, SessionRecoveryContext } from './mesh-ledger.js';
import { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, claimNextTask, updateSessionTaskStatus, enqueueTask, updateTaskStatus, getQueue, recordTaskAutoLaunch, updateDirectDispatchStatus, cleanupTerminalDirectDispatches, getActiveDirectDispatches, hasPendingDependents } from './mesh-work-queue.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { createSessionDelivery, markSessionDeliveriesTerminal, updateSessionDeliveryStatus, recordCompletionConflict } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { resolveWorkerDelegateRouting, recordUnroutableDelegateEvent, isUnroutableDelegateRejection } from './mesh-routing.js';
import { enqueueUnresolvedDelegateForward, peekUnresolvedDelegateForwards, ackUnresolvedDelegateForward } from './mesh-unresolved-forward-outbox.js';
import { getLastDisplayMessage } from '../status/snapshot.js';
import { resolveDelegatedWorkerAutoApprove, resolveProviderMaxParallel, resolveNodeSchedulingPriority, normalizeMeshSchedulingStrategy } from '../repo-mesh-types.js';
import type { RepoMeshSchedulingStrategy } from '../repo-mesh-types.js';
import { normalizeMeshNodeId, meshNodeIdMatches, expandDaemonIdForms, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import {
    findRecentTerminalLedgerEvidence,
    hasDispatchAfterTerminal,
    hasUnterminalDirectDispatchLedgerEntry,
    buildNoProgressCompletionReconciliation,
} from './mesh-events-stale.js';
import {
    buildMeshSystemMessage,
    readNonEmptyString,
    readRecord,
    resolveEventSessionId,
    readRefineJobId,
    readWorkerResultMetadata,
    resolveMeshSurfacedSessionPreview,
} from './mesh-events-utils.js';

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
const IDLE_AUTO_FAST_FORWARD_THROTTLE_MS = 30 * 60 * 1000;
const idleAutoFastForwardLastAttempt = new Map<string, number>();

function getCachedMeshByWorkspace(workspace: string): any {
    const now = Date.now();
    const cached = meshByWorkspaceCache.get(workspace);
    if (cached && now - cached.cachedAt < MESH_WORKSPACE_CACHE_TTL_MS) return cached.mesh;
    const mesh = getMeshByRepo(workspace);
    meshByWorkspaceCache.set(workspace, { mesh, cachedAt: now });
    return mesh;
}

export function __resetIdleAutoFastForwardForTests(): void {
    idleAutoFastForwardLastAttempt.clear();
}

export function __resetMeshWorkspaceCacheForTests(): void {
    meshByWorkspaceCache.clear();
}

function sweepExpiredRemoteIdleSessions(): void {
    try {
        MeshRuntimeStore.getInstance().pruneExpiredRemoteIdleSessions();
    } catch { /* best-effort */ }
}

function getMeshWithCache(components: DaemonComponents, meshId: string): any | undefined {
    const localMesh = getMesh(meshId);
    if (localMesh) return localMesh;
    return components.router?.getCachedInlineMesh(meshId);
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

function hasFingerprintSeen(fingerprint: string): boolean {
    try {
        return MeshRuntimeStore.getInstance().hasCompletionFingerprint(fingerprint);
    } catch {
        return false;
    }
}

function recordFingerprintSeen(fingerprint: string): void {
    try {
        const db = MeshRuntimeStore.getInstance();
        db.recordCompletionFingerprint(fingerprint, RECENT_COMPLETION_FINGERPRINT_TTL_MS);
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
    if (hasFingerprintSeen(fingerprint)) {
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
    recordFingerprintSeen(fingerprint);
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
    if (hasFingerprintSeen(fingerprint)) return true;
    recordFingerprintSeen(fingerprint);
    return false;
}

function isDuplicateRefineTerminalEvent(meshId: string, eventName: string, metadataEvent: Record<string, unknown>): boolean {
    const jobId = readRefineJobId({ metadataEvent });
    const fingerprint = jobId && new Set(['refine:completed', 'refine:failed']).has(eventName) ? `${meshId}::${eventName}::${jobId}` : '';
    if (!fingerprint) return false;
    if (hasFingerprintSeen(fingerprint)) return true;
    recordFingerprintSeen(fingerprint);
    return false;
}

// A worker/coordinator "false idle": the provider dropped to idle WITHOUT a confirmed
// final assistant message for the turn (a finalization timeout, or a "scheduled fallback"
// idle). This is the signal cli-provider-instance emits as
// completionDiagnostic.blockReason='missing_final_assistant' / finalAssistantPresent=false.
// Such a completion is NOT trustworthy terminal evidence: it must neither permanently
// terminate a direct-dispatch task nor suppress the genuine completion a later turn
// (commonly driven by a coordinator nudge / re-dispatch) produces.
function isFalseIdleCompletion(metadataEvent: Record<string, unknown>): boolean {
    const diag = readRecord(metadataEvent.completionDiagnostic);
    if (!diag) return false;
    return diag.finalAssistantPresent === false || diag.blockReason === 'missing_final_assistant';
}

// The genuine-completion counterpart: a real final summary / worker result is present and
// the completion is not flagged as a missing-final-assistant false idle. Used to decide
// whether a new completion may supersede a prior WEAK (false-idle) terminal.
function isGenuineCompletionEvidence(metadataEvent: Record<string, unknown>): boolean {
    if (isFalseIdleCompletion(metadataEvent)) return false;
    return !!readWorkerResultMetadata(metadataEvent) || !!readNonEmptyString(metadataEvent.finalSummary);
}

// True when a terminal ledger payload was recorded from WEAK completion evidence (a false
// idle): insufficient evidence level, review-recommended, or a missing-final-assistant
// completion diagnostic. A weak terminal is non-authoritative — a later genuine completion
// (live path) or a transcript reconcile (fallback path) may supersede it.
function isWeakTerminalLedgerPayload(payload: Record<string, unknown> | undefined): boolean {
    if (!payload) return false;
    if (payload.evidenceLevel === 'insufficient' || payload.reviewRecommended === true) return true;
    const diag = readRecord(payload.completionDiagnostic);
    return diag?.finalAssistantPresent === false || diag?.blockReason === 'missing_final_assistant';
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

// ---------------------------------------------------------------------------
// Queue assignment
// ---------------------------------------------------------------------------

export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string
): boolean {
    const mesh = getMeshWithCache(components, meshId);
    const node = mesh?.nodes.find((n: any) => readMeshNodeId(n) === nodeId);
    const capabilityTags = buildMeshNodeCapabilityTags(node, providerType);
    // Per-(node, provider) maxParallel cap (RepoMeshNodePolicy.providerRoles) layers
    // on top of the global/taskMode caps — stricter wins. Resolved here where the
    // claiming session's providerType + node policy are both known, then enforced
    // inside the atomic claim transaction so concurrent claims can't overshoot it.
    const providerMaxParallel = resolveProviderMaxParallel(node?.policy, providerType);
    const task = claimNextTask(meshId, nodeId, sessionId, capabilityTags, {
        providerType,
        ...(providerMaxParallel !== undefined ? { providerMaxParallel } : {}),
    });
    if (!task) {
        return false;
    }

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);

    if (node?.daemonId && components.dispatchMeshCommand) {
        const isLocalNode = components.cliManager.adapters.has(sessionId);
        if (!isLocalNode) {
            const localDaemonIdForDispatch = readNonEmptyString(loadConfig().machineId) || undefined;
            // (3) Originating coordinator session that enqueued this task — route its
            // completion back to that exact session (multi-coordinator). Carried over P2P
            // to the remote worker, which echoes it on its completion event.
            const sourceCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId) || undefined;
            const delivery = createSessionDelivery({
                meshId,
                nodeId,
                sessionId,
                providerType,
                taskId: task.id,
                kind: 'task',
                message: task.message,
                status: 'delivering',
                ...(sourceCoordinatorSessionId ? { sourceCoordinatorSessionId } : {}),
                ...(localDaemonIdForDispatch ? { sourceCoordinatorDaemonId: localDaemonIdForDispatch } : {}),
            });
            components.dispatchMeshCommand(node.daemonId, 'agent_command', {
                targetSessionId: sessionId,
                cliType: providerType,
                action: 'send_chat',
                message: task.message,
                meshContext: {
                    meshId,
                    nodeId,
                    taskId: task.id,
                    ...(localDaemonIdForDispatch ? { coordinatorDaemonId: localDaemonIdForDispatch } : {}),
                    ...(sourceCoordinatorSessionId ? { coordinatorSessionId: sourceCoordinatorSessionId } : {}),
                },
            }).then(() => {
                updateSessionDeliveryStatus(delivery.id, 'delivered');
            }).catch((e: any) => {
                LOG.error('MeshQueue', `Failed to dispatch task via P2P to remote node ${nodeId}: ${e?.message}`);
                updateSessionDeliveryStatus(delivery.id, 'failed', { lastError: e?.message, incrementAttempt: true });
                updateTaskStatus(meshId, task.id, 'pending');
                try {
                    appendLedgerEntry(meshId, {
                        kind: 'dispatch_failed' as any,
                        nodeId,
                        sessionId,
                        payload: { taskId: task.id, deliveryId: delivery.id, error: e?.message, retryable: true },
                    });
                } catch { /* ledger write is best-effort */ }
            });
            return true;
        }
    }

    // Stamp mesh context onto the session so completion events route correctly
    // via setupMeshEventForwarding. Without this, manually-opened idle sessions
    // (mesh_launch_session without auto-launch) lack meshNodeFor/meshNodeId and
    // agent:generating_completed is silently dropped as isMeshDelegate=false.
    try {
        const inst = components.instanceManager.getInstance(sessionId);
        if (inst && typeof inst.updateSettings === 'function') {
            // Adopting a (possibly manually-opened) local session as a worker: apply the
            // delegated-worker auto-approve policy here too, so a session that was launched
            // without autoApprove still auto-approves once the coordinator dispatches a task
            // to it (the "approval notification fires only for certain delegated sessions"
            // case). updateSettings preserves runtime mesh keys; passing autoApprove keeps it.
            //
            // This local-dispatch branch also runs on the coordinator daemon for a co-located
            // session, so the coordinator daemon id IS this daemon's id. Stamp it alongside
            // the node identity so the session is fully relay-safe (meshCoordinatorDaemonId is
            // the anchor the forwarder keys on), matching what mesh_launch_session stamps.
            const localDaemonId = readNonEmptyString(loadConfig().machineId);
            const localSourceCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId);
            inst.updateSettings({
                meshNodeFor: meshId,
                meshNodeId: nodeId,
                launchedByCoordinator: true,
                autoApprove: resolveDelegatedWorkerAutoApprove(mesh?.policy, node?.policy),
                ...(localDaemonId ? { meshCoordinatorDaemonId: localDaemonId } : {}),
                // (3) Stamp the originating coordinator session for session-anchored routing
                // of this co-located worker's completion. Absent → daemon-level fallback.
                ...(localSourceCoordinatorSessionId ? { meshCoordinatorSessionId: localSourceCoordinatorSessionId } : {}),
            });
        }
    } catch { /* best-effort — dispatch still proceeds */ }

    const delivery = createSessionDelivery({
        meshId,
        nodeId,
        sessionId,
        providerType,
        taskId: task.id,
        kind: 'task',
        message: task.message,
        status: 'delivering',
        ...(readNonEmptyString(task.sourceCoordinatorSessionId) ? { sourceCoordinatorSessionId: readNonEmptyString(task.sourceCoordinatorSessionId) } : {}),
        ...(readNonEmptyString(loadConfig().machineId) ? { sourceCoordinatorDaemonId: readNonEmptyString(loadConfig().machineId) } : {}),
    });
    components.cliManager.handleCliCommand('agent_command', {
        targetSessionId: sessionId,
        cliType: providerType,
        action: 'send_chat',
        message: task.message,
    }).then(() => {
        updateSessionDeliveryStatus(delivery.id, 'delivered');
    }).catch((e: any) => {
        // Mirror the remote-dispatch catch above: a local dispatch failure is most often a
        // transient busy/refusal (e.g. the adapter rejected send_chat while mid-generation),
        // not a permanent task failure. Marking the task terminal 'failed' here with no ledger
        // and no retry permanently killed tasks that a later tick would have delivered fine.
        // Return the task to 'pending' and record a retryable dispatch_failed ledger entry so
        // the reconcile loop re-dispatches it, exactly as the remote branch does.
        LOG.error('MeshQueue', `Failed to dispatch task locally to node ${nodeId}: ${e?.message}`);
        updateSessionDeliveryStatus(delivery.id, 'failed', { lastError: e?.message, incrementAttempt: true });
        updateTaskStatus(meshId, task.id, 'pending');
        try {
            appendLedgerEntry(meshId, {
                kind: 'dispatch_failed' as any,
                nodeId,
                sessionId,
                payload: { taskId: task.id, deliveryId: delivery.id, error: e?.message, retryable: true },
            });
        } catch { /* ledger write is best-effort */ }
    });

    return true;
}

const autoLaunchInProgress = new Set<string>();
const autoLaunchCooldownUntil = new Map<string, number>();
const AUTO_LAUNCH_COOLDOWN_MS = 5_000;
// A remote auto-launch (launch_cli forward) is fire-and-async: the worker session
// spawns, reaches idle, emits agent:ready, that ready is queued on the worker, pulled
// by this coordinator (reconcile PHASE 1), and only THEN claims the task. That round
// trip routinely exceeds the 5s per-(mesh,node) cooldown, so cooldown alone lets the
// reconcile loop fire a SECOND launch for the same still-pending task before the first
// session's claim lands — every tick spawns yet another orphan session (observed live:
// 26 sessions for one task). This is a per-TASK await-claim window: once a task has a
// successfully-launched session whose claim we are still waiting on, do not launch it
// again until the window lapses. It is generous (a slow remote spawn can take tens of
// seconds) but bounded so a launch that silently never reaches idle is eventually retried.
const AUTO_LAUNCH_AWAIT_CLAIM_MS = 90_000;

// De-dup for repeated `skipped` ledger noise: the reconcile loop re-runs the queue
// trigger every 4s, so a task that can't be claimed (e.g. a remote node with no
// transport, or a node under cooldown) would otherwise append an identical
// session_auto_launch{phase:'skipped'} entry on every tick — flooding the ledger.
// We suppress a `skipped` ledger append when the immediately-prior recorded event
// for that task was the SAME (phase, reason). Any non-skip phase (started/failed/
// completed) or a changed reason resets the de-dup so real transitions still record.
const lastAutoLaunchLedgerKey = new Map<string, string>();
const AUTO_LAUNCH_LEDGER_DEDUP_MAX = 2000;

function sweepExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of autoLaunchCooldownUntil) {
        if (now >= until) autoLaunchCooldownUntil.delete(key);
    }
}

function normalizeProviderPriority(policy: unknown): string[] {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

function isTerminalSessionStatus(status: string): boolean {
    return ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(status);
}

function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (isTerminalSessionStatus(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}

function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

function resolveAutoFastForwardPolicy(mesh: any): { enabled: boolean; maxBehind?: number; requireCleanSubmodules: boolean } {
    const record = mesh?.policy?.autoFastForward && typeof mesh.policy.autoFastForward === 'object' && !Array.isArray(mesh.policy.autoFastForward)
        ? mesh.policy.autoFastForward as Record<string, unknown>
        : {};
    const maxBehind = Number(record.maxBehind);
    return {
        enabled: record.enabled !== false,
        ...(Number.isFinite(maxBehind) && maxBehind >= 0 ? { maxBehind: Math.floor(maxBehind) } : {}),
        requireCleanSubmodules: record.requireCleanSubmodules !== false,
    };
}

function sessionStateLooksActive(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    const chatStatus = readNonEmptyString(state?.activeChat?.status).toLowerCase();
    // 'long_generating' is retained as a legacy alias for the renamed 'no_progress' busy status.
    const active = new Set(['generating', 'streaming', 'no_progress', 'long_generating', 'working', 'starting', 'waiting_approval']);
    return active.has(status) || active.has(chatStatus);
}

function nodeHasActiveMeshWork(components: DaemonComponents, meshId: string, nodeId: string, currentSessionId?: string): boolean {
    if (nodeHasActiveAssignment(meshId, nodeId)) return true;
    return components.instanceManager.getByCategory('cli').some((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (instNodeId !== nodeId) return false;
        const sessionId = readNonEmptyString(state.instanceId);
        if (currentSessionId && sessionId === currentSessionId && isIdleSessionState(state)) return false;
        return sessionStateLooksActive(state);
    });
}

function isLaunchableNode(node: any): boolean {
    if (!node || node.status === 'disabled' || node.status === 'removed') return false;
    const health = readNonEmptyString(node.health).toLowerCase();
    if (!health) return true;
    return health === 'online' || health === 'unknown';
}

/** Whether a mesh node's daemon/machine identity resolves to THIS coordinator daemon
 *  (i.e. the queue session can be spawned by a direct local `launch_cli`). */
function isLocalAutoLaunchNode(node: any): boolean {
    const daemonId = readNonEmptyString(node?.daemonId);
    const machineId = readNonEmptyString(node?.machineId);
    const appConfig = loadConfig();
    const localMachineId = readNonEmptyString(appConfig.machineId) || readNonEmptyString(appConfig.registeredMachineId);
    const cloudDaemonId = localMachineId ? `daemon_${localMachineId}` : '';
    const standaloneDaemonId = localMachineId ? `standalone_${localMachineId}` : '';

    const daemonMatchesLocal = !daemonId || daemonId === cloudDaemonId || daemonId === standaloneDaemonId;
    const machineMatchesLocal = !machineId || (!!localMachineId && machineId === localMachineId);

    if (node?.isLocalWorktree === true) {
        return daemonMatchesLocal && machineMatchesLocal;
    }
    if (daemonId || machineId) {
        return daemonMatchesLocal && machineMatchesLocal;
    }
    return true;
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
    const daemonId = readNonEmptyString(node?.daemonId);
    if (!daemonId) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    if (!components.dispatchMeshCommand) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    const coordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
    if (!coordinatorDaemonId) return { mode: 'skip', reason: 'remote_auto_launch_no_coordinator_daemon_id' };
    return { mode: 'remote', daemonId, coordinatorDaemonId };
}

function activeAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any }).length;
}

/** Active assignments that hold the one-active-per-node / global-parallel invariant
 *  (everything except read-only diagnoses, which run unbounded by the write cap). */
export function activeWriteAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => task.taskMode !== 'live_debug_readonly').length;
}

/** Active read-only (live_debug_readonly) assignments, for the read-only safety cap. */
export function activeReadonlyAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => task.taskMode === 'live_debug_readonly').length;
}

function nodeHasActiveAssignment(meshId: string, nodeId: string): boolean {
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedNodeId === nodeId);
}

/** Active (status='assigned') task count for a node — the load metric for
 *  least-loaded / round-robin ranking. Lower = preferred. */
function nodeActiveLoad(meshId: string, nodeId: string): number {
    return MeshRuntimeStore.getInstance().nodeActiveAssignmentCount(meshId, nodeId);
}

/**
 * The mesh-wide scheduling strategy. Defaults to 'first_eligible' (strict
 * no-change) for any mesh that does not set it. Only governs the final tie-break;
 * eligibility, capacity, and priority gates apply identically to every strategy.
 */
function resolveSchedulingStrategy(mesh: any): RepoMeshSchedulingStrategy {
    return normalizeMeshSchedulingStrategy(mesh?.policy?.schedulingStrategy);
}

/**
 * Order eligible nodes for assignment per the mesh scheduling pipeline:
 *   PRIORITY (schedulingPriority desc) → TIE-BREAK (strategy).
 *
 * The caller has already applied the TAG hard-filter and is responsible for the
 * MAX-ALLOC capacity gate (the per-node launch/claim checks). This function only
 * decides the *preference order* among nodes that are otherwise eligible.
 *
 * - 'first_eligible' (default): returns the input order verbatim and does NOT touch
 *   the round-robin cursor — byte-for-byte the pre-feature behavior.
 * - 'priority_only': schedulingPriority desc, then input order (load ignored).
 * - 'least_loaded': schedulingPriority desc, then active load asc, then input order.
 * - 'round_robin': same as least_loaded, but among nodes tied at (priority, load)
 *   the input order is rotated by a per-mesh cursor that advances once per pass.
 *
 * `nodes` carries the original config/array index so the tie-break can fall back to
 * deterministic input order. `bumpCursor` advances the round-robin cursor exactly
 * once per scheduling pass (only consulted for 'round_robin').
 */
interface RankableNode { nodeId: string; node: any; index: number }

/** Test-only: the pure node-ordering stage (PRIORITY → TIE-BREAK). Exposed so the
 *  scheduling pipeline can be unit-tested without standing up live CLI sessions. */
export function __orderEligibleNodesForTests(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean },
): RankableNode[] {
    return orderEligibleNodes(meshId, strategy, nodes, opts);
}

function orderEligibleNodes(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean },
): RankableNode[] {
    if (strategy === 'first_eligible' || nodes.length <= 1) {
        return nodes;
    }

    const priorityOf = (n: { node: any }) => resolveNodeSchedulingPriority(n.node?.policy);

    // Round-robin rotation offset: rotate the deterministic input order by a
    // per-mesh cursor so the tie-break winner among equal (priority, load) nodes
    // cycles across passes. The cursor advances once per scheduling pass.
    let rotation = 0;
    if (strategy === 'round_robin') {
        const cursor = opts?.bumpCursor
            ? MeshRuntimeStore.getInstance().bumpSchedulerCursor(meshId)
            : MeshRuntimeStore.getInstance().getSchedulerCursor(meshId);
        rotation = ((cursor % nodes.length) + nodes.length) % nodes.length;
    }

    // Rotation rank: position of each node after rotating input order by `rotation`.
    // For non-round-robin strategies rotation is 0, so this is just the input index.
    const rotationRank = (index: number) => (index - rotation + nodes.length) % nodes.length;

    return [...nodes].sort((a, b) => {
        const prioDelta = priorityOf(b) - priorityOf(a); // higher priority first
        if (prioDelta !== 0) return prioDelta;
        if (strategy === 'least_loaded' || strategy === 'round_robin') {
            const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
            if (loadDelta !== 0) return loadDelta;
        }
        return rotationRank(a.index) - rotationRank(b.index);
    });
}

/** Active assignments on a (node, provider) — pre-launch guard for the per-(node,
 *  provider) maxParallel cap. The authoritative enforcement is in the claim
 *  transaction; this only avoids spawning a session that would fail the claim. */
function activeProviderAssignedCount(meshId: string, nodeId: string, providerType: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => task.assignedNodeId === nodeId && task.assignedProviderType === providerType).length;
}

function sessionHasActiveAssignment(meshId: string, sessionId: string): boolean {
    if (getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedSessionId === sessionId)) {
        return true;
    }
    // Direct dispatches (mesh_send_task) are tracked in mesh_direct_dispatches, not the
    // work queue. A session completing a still-active direct dispatch IS an active
    // assignment — without this, findRecentTerminalLedgerEvidence dedup wrongly suppresses
    // the canonical agent:generating_completed for direct-dispatch tasks (validation/general),
    // so the coordinator polling get_pending_mesh_events never observes task_completed and the
    // session goes silently idle. This check runs before markSessionTerminal marks the
    // dispatch terminal, so the in-flight dispatch is still observable here.
    try {
        if (getActiveDirectDispatches(meshId).some(d => d.sessionId === sessionId)) return true;
        if (hasUnterminalDirectDispatchLedgerEntry(meshId, sessionId)) return true;
    } catch { /* best-effort — fall through to false */ }
    return false;
}

function liveSessionCountForNode(components: DaemonComponents, meshId: string, nodeId: string): number {
    return components.instanceManager.getByCategory('cli').filter((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (instNodeId !== nodeId) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        return !isTerminalSessionStatus(status);
    }).length;
}

function recordAutoLaunchEvent(meshId: string, args: {
    phase: 'skipped' | 'started' | 'failed' | 'completed';
    taskId: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    reason?: string;
    error?: string;
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
            payload: {
                phase: args.phase,
                taskId: args.taskId,
                reason: args.reason,
                error: args.error,
            },
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to record auto-launch ledger event: ${e?.message || e}`);
    }
}

function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
}) {
    recordTaskAutoLaunch(meshId, taskId, {
        status: args.status,
        reason: args.reason || args.error,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
    });
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
    });
}

async function resolveUsableProvider(
    components: DaemonComponents,
    nodeId: string,
    node: any,
    requiredTags?: string[],
): Promise<{ providerType?: string; reason?: string }> {
    const providerPriority = normalizeProviderPriority(node?.policy);
    if (!providerPriority.length) return { reason: 'missing_provider_priority' };
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    const failed: string[] = [];
    for (const requestedType of providerPriority) {
        const normalizedType = typeof providerLoader.resolveAlias === 'function'
            ? providerLoader.resolveAlias(requestedType)
            : requestedType;
        // Skip providers that can't satisfy the task's requiredTags (e.g. provider=hermes-cli
        // means only hermes-cli qualifies, not any other type in providerPriority).
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
        if (detected) return { providerType: normalizedType };
        failed.push(`${requestedType}: not detected`);
    }
    return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}` };
}

// Canonical mesh node-id normalization. A node may arrive from the local config
// form (`id`) or the inline-cache form (`nodeId`/`node_id`) — see
// readInlineMeshNodeId in commands/router.ts. Comparing only `node.id` against a
// task.targetNodeId silently drops inline-cached worktree nodes, leaving a
// target-routed task permanently pending with a misleading
// `no_node_satisfies_required_tags` skip.
function readMeshNodeId(node: any): string {
    // Delegate to the shared 3-way (id / nodeId / node_id) normalizer so this
    // and every other mesh node-id read agree on identity. Coalesce to '' to
    // preserve the existing string return contract for callers that do
    // `=== task.targetNodeId` / `if (!nodeId)`.
    return normalizeMeshNodeId(node) ?? '';
}

async function maybeAutoLaunchOneQueueSession(components: DaemonComponents, meshId: string, mesh: any): Promise<boolean> {
    const queue = getQueue(meshId);
    const pending = queue.filter(task => task.status === 'pending');
    if (!pending.length) return false;

    const maxParallelTasks = Math.max(1, Math.floor(Number(mesh?.policy?.maxParallelTasks) || 2));
    // Read-only diagnoses carry no isolation/merge cost, so they are exempt from the
    // write-task parallel cap. To prevent runaway auto-launch they get their own,
    // higher safety cap (2x the write cap).
    const maxReadonlyParallelTasks = Math.max(2, maxParallelTasks * 2);
    for (const task of pending) {
        const isReadonly = task.taskMode === 'live_debug_readonly';
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
        if (task.targetSessionId) {
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
            if (Number.isFinite(launchedAtMs) && Date.now() - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS) {
                // Record the skip in the ledger ONLY (dedup'd). Do NOT call markAutoLaunch
                // here: recordTaskAutoLaunch overwrites task.autoLaunch wholesale, which would
                // erase the very `completed` record (status + sessionId + updatedAt) this guard
                // reads on the next tick, reopening the duplicate-launch hole it closes.
                recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'awaiting_launched_session_claim', nodeId: task.autoLaunch.nodeId, sessionId: task.autoLaunch.sessionId });
                continue;
            }
        }

        const candidateNodes = Array.isArray(mesh?.nodes)
            ? mesh.nodes.filter((node: any) => {
                if (task.targetNodeId && readMeshNodeId(node) !== task.targetNodeId) return false;
                // Skip nodes that can never satisfy requiredTags regardless of which provider
                // from providerPriority is selected. A node satisfies tags if at least one
                // provider in its priority list would produce matching capability tags.
                if (task.requiredTags?.length) {
                    const priorities = normalizeProviderPriority(node?.policy);
                    const providerCandidates = priorities.length ? priorities : [undefined as unknown as string];
                    return providerCandidates.some(p =>
                        nodeSatisfiesRequiredTags(task.requiredTags, buildMeshNodeCapabilityTags(node, p))
                    );
                }
                return true;
            })
            : [];
        if (!candidateNodes.length) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'no_node_satisfies_required_tags', nodeId: task.targetNodeId });
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
                { bumpCursor: true },
            ).map((c: RankableNode) => c.node);

        for (const node of orderedCandidateNodes) {
            const nodeId = readMeshNodeId(node);
            if (!nodeId) continue;
            const launchKey = `${meshId}:${nodeId}`;
            const now = Date.now();
            const cooldownUntil = autoLaunchCooldownUntil.get(launchKey) || 0;
            if (cooldownUntil > 0 && now >= cooldownUntil) autoLaunchCooldownUntil.delete(launchKey);
            if (autoLaunchInProgress.has(launchKey)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_in_progress', nodeId });
                continue;
            }
            if (now < cooldownUntil) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_cooldown', nodeId });
                continue;
            }
            if (isDirtyNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'dirty_workspace', nodeId });
                continue;
            }
            if (!isLaunchableNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_not_launch_ready', nodeId });
                continue;
            }
            const launchTarget = resolveAutoLaunchTarget(components, node);
            if (launchTarget.mode === 'skip') {
                // Remote node we can't reach (no transport / no coordinator daemonId).
                // Set a cooldown so the 4s reconcile loop doesn't re-attempt this node
                // every tick; the de-dup'd skip ledger keeps it diagnosable without flood.
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: launchTarget.reason || 'auto_launch_unavailable', nodeId });
                autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                continue;
            }
            // Write tasks keep the one-active-per-node invariant (worktree isolation);
            // read-only (live_debug_readonly) diagnoses may auto-launch onto a node
            // that already has an active assignment.
            if (task.taskMode !== 'live_debug_readonly' && nodeHasActiveAssignment(meshId, nodeId)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_has_active_assignment', nodeId });
                continue;
            }
            const maxConcurrentSessions = Number(node?.policy?.maxConcurrentSessions);
            if (Number.isFinite(maxConcurrentSessions) && maxConcurrentSessions >= 0 && liveSessionCountForNode(components, meshId, nodeId) >= maxConcurrentSessions) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_concurrent_sessions_reached', nodeId });
                continue;
            }

            autoLaunchInProgress.add(launchKey);
            try {
                const resolved = await resolveUsableProvider(components, nodeId, node, task.requiredTags);
                if (!resolved.providerType) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: resolved.reason || 'provider_unusable', nodeId });
                    continue;
                }

                // Don't spawn a session for a (node, provider) already at its declared
                // maxParallel cap — it would launch only to fail the claim. The claim
                // transaction enforces the cap regardless; this just avoids a doomed launch.
                const providerCap = resolveProviderMaxParallel(node?.policy, resolved.providerType);
                if (
                    providerCap !== undefined
                    && activeProviderAssignedCount(meshId, nodeId, resolved.providerType) >= providerCap
                ) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_provider_parallel_reached', nodeId, providerType: resolved.providerType });
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
                    // global per-provider-type autoApprove config (see shouldAutoApprove).
                    autoApprove: resolveDelegatedWorkerAutoApprove(mesh?.policy, node?.policy),
                    launchedByCoordinator: true,
                    autoLaunchedForQueueTaskId: task.id,
                };

                if (launchTarget.mode === 'remote') {
                    // Relay-safe completion routing: stamp the coordinator anchor the same way
                    // mesh_launch_session does so the worker forwards events back to this daemon.
                    const remoteSettings: Record<string, unknown> = {
                        ...launchSettings,
                        meshCoordinatorDaemonId: launchTarget.coordinatorDaemonId,
                        meshCoordinatorNodeId: nodeId,
                    };
                    markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType });
                    let launchResult: any;
                    try {
                        launchResult = await components.dispatchMeshCommand!(launchTarget.daemonId!, 'launch_cli', {
                            cliType: resolved.providerType,
                            dir: node.workspace,
                            settings: remoteSettings,
                        });
                    } catch (e: any) {
                        markAutoLaunch(meshId, task.id, { status: 'failed', reason: `remote_launch_dispatch_failed: ${e?.message || String(e)}`, nodeId, providerType: resolved.providerType });
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return false;
                    }
                    const payload = (launchResult && typeof launchResult === 'object' && 'payload' in launchResult && launchResult.payload && typeof launchResult.payload === 'object')
                        ? launchResult.payload
                        : launchResult;
                    if (!payload?.success) {
                        const reason = readNonEmptyString(payload?.error) || 'remote_launch_cli_failed';
                        markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: resolved.providerType });
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return false;
                    }
                    // Remote launch is async: the worker session will register and emit agent:ready,
                    // which (forwarded back here) drives the claim via the normal event path / PHASE 1
                    // reconcile. Set a cooldown so the 4s loop doesn't re-launch before that lands.
                    const remoteSessionId = readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.id) || readNonEmptyString(payload.runtimeSessionId);
                    markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId: remoteSessionId || undefined });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return true;
                }

                markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType });
                const launchResult: any = await components.cliManager.handleCliCommand('launch_cli', {
                    cliType: resolved.providerType,
                    dir: node.workspace,
                    settings: launchSettings,
                });
                if (!launchResult?.success) {
                    const reason = launchResult?.error || 'launch_cli_failed';
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return false;
                }
                const sessionId = readNonEmptyString(launchResult.sessionId) || readNonEmptyString(launchResult.id) || readNonEmptyString(launchResult.runtimeSessionId);
                if (!sessionId) {
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason: 'launch_missing_session_id', nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return false;
                }
                markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId });
                tryAssignQueueTask(components, meshId, nodeId, sessionId, resolved.providerType);
                return true;
            } catch (e: any) {
                markAutoLaunch(meshId, task.id, { status: 'failed', error: e?.message || String(e), nodeId });
                autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                return false;
            } finally {
                autoLaunchInProgress.delete(launchKey);
            }
        }
    }
    return false;
}

export interface MeshQueueTriggerResult {
    success: true;
    meshId: string;
    pendingBefore: number;
    assignedBefore: number;
    pendingAfter: number;
    assignedAfter: number;
    claimed: boolean;
    newlyAssignedTasks: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
    }>;
    localIdleSessionsChecked: number;
    remoteIdleSessionsChecked: number;
    skippedSessions: Array<{
        nodeId?: string;
        sessionId?: string;
        reason: string;
        status?: string;
    }>;
    autoLaunchStarted: boolean;
    noIdleMeshSessionAvailable?: boolean;
}

function countQueueStatus(meshId: string, status: 'pending' | 'assigned'): number {
    return getQueue(meshId, { status: [status] as any }).length;
}

function getQueueStatusById(meshId: string): Map<string, string> {
    return new Map(getQueue(meshId).map(task => [task.id, task.status]));
}

export async function triggerMeshQueue(components: DaemonComponents, meshId: string): Promise<MeshQueueTriggerResult> {
    const mesh = getMeshWithCache(components, meshId);
    const pendingBefore = countQueueStatus(meshId, 'pending');
    const assignedBefore = countQueueStatus(meshId, 'assigned');
    const beforeStatus = getQueueStatusById(meshId);
    const skippedSessions: MeshQueueTriggerResult['skippedSessions'] = [];
    let localIdleSessionsChecked = 0;
    let remoteIdleSessionsChecked = 0;
    let autoLaunchStarted = false;
    if (!mesh) {
        return {
            success: true,
            meshId,
            pendingBefore,
            assignedBefore,
            pendingAfter: pendingBefore,
            assignedAfter: assignedBefore,
            claimed: false,
            newlyAssignedTasks: [],
            localIdleSessionsChecked,
            remoteIdleSessionsChecked,
            skippedSessions: [{ reason: 'mesh_not_found' }],
            autoLaunchStarted,
            noIdleMeshSessionAvailable: true,
        };
    }

    // Collect every idle mesh session (local CLI instances + remote idle records)
    // as drain candidates. The drain ORDER depends on the scheduling strategy:
    //   - 'first_eligible' (default): local-first, then remote, exactly as before.
    //   - otherwise: local + remote merged into one pool and drained in scheduling
    //     order (priority → load → tie-break). This local-first debias is required
    //     because without it the coordinator's own local node is always visited
    //     first and greedily absorbs all untargeted work before any remote idle
    //     session is even considered — the comparator alone can't spread work if
    //     local is always tried first.
    type IdleCandidate = { nodeId: string; sessionId: string; providerType: string; origin: 'local' | 'remote'; node: any };
    const strategy = resolveSchedulingStrategy(mesh);
    const localCandidates: IdleCandidate[] = [];

    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};

        const instMeshId = readNonEmptyString(settings.meshNodeFor);
        if (instMeshId !== meshId) continue;

        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (!nodeId) continue;

        if (!isIdleSessionState(state)) {
            const status = readNonEmptyString(state.status).toLowerCase();
            skippedSessions.push({
                nodeId,
                sessionId: readNonEmptyString(state.instanceId),
                reason: isTerminalSessionStatus(status) ? 'terminal_session' : 'session_not_idle',
                status: status || undefined,
            });
            continue;
        }

        const sessionId = state.instanceId;
        const providerType = state.type || readNonEmptyString(settings.providerType);

        if (providerType) {
            localIdleSessionsChecked += 1;
            localCandidates.push({ nodeId, sessionId, providerType, origin: 'local', node: mesh.nodes.find((n: any) => readMeshNodeId(n) === nodeId) });
        } else {
            skippedSessions.push({
                nodeId,
                sessionId,
                reason: 'provider_type_missing',
            });
        }
    }

    let remoteSessions: Array<{ nodeId: string; sessionId: string; providerType: string }> = [];
    try {
        remoteSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions();
    } catch { /* best-effort */ }

    const remoteCandidates: IdleCandidate[] = [];
    for (const idle of remoteSessions) {
        // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
        // `n.id`, so an inline-cached worktree node whose identity arrived under a
        // different form is not silently dropped — leaving a remote idle session
        // unable to claim its pending queue task.
        const node = mesh.nodes.find((n: any) => meshNodeIdMatches(n, idle.nodeId));
        if (node) {
            remoteIdleSessionsChecked += 1;
            remoteCandidates.push({ nodeId: idle.nodeId, sessionId: idle.sessionId, providerType: idle.providerType, origin: 'remote', node });
        }
    }

    const assignIdleCandidate = (candidate: IdleCandidate): void => {
        const assigned = tryAssignQueueTask(components, meshId, candidate.nodeId, candidate.sessionId, candidate.providerType);
        if (assigned && candidate.origin === 'remote') {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(candidate.nodeId, candidate.sessionId);
            } catch { /* best-effort */ }
        }
    };

    if (strategy === 'first_eligible') {
        // Strict no-change: drain local idle sessions first (original order), then
        // remote idle sessions. tryAssignQueueTask is a no-op when nothing matches.
        for (const candidate of localCandidates) assignIdleCandidate(candidate);
        for (const candidate of remoteCandidates) assignIdleCandidate(candidate);
    } else {
        // Merge local + remote into one pool and drain in scheduling order. Each
        // assignment mutates a node's active load, and the next pick re-reads it,
        // so re-ranking after every assignment keeps the spread fair as load shifts.
        const pool = [...localCandidates, ...remoteCandidates];
        const baseIndex = new Map<string, number>();
        pool.forEach((c, i) => { if (!baseIndex.has(c.nodeId)) baseIndex.set(c.nodeId, i); });
        // Bump the round-robin cursor once for this whole drain pass.
        const uniqueNodes = [...new Set(pool.map(c => c.nodeId))]
            .map((nodeId, index) => ({ nodeId, node: pool.find(c => c.nodeId === nodeId)?.node, index }));
        const ranked = orderEligibleNodes(meshId, strategy, uniqueNodes, { bumpCursor: true });
        const rankIndex = new Map<string, number>(ranked.map((r, i) => [r.nodeId, i]));
        const remaining = [...pool];
        while (remaining.length > 0) {
            // Re-rank each pass so a node that just took work defers its next session.
            remaining.sort((a, b) => {
                const aPrio = resolveNodeSchedulingPriority(a.node?.policy);
                const bPrio = resolveNodeSchedulingPriority(b.node?.policy);
                if (aPrio !== bPrio) return bPrio - aPrio;
                if (strategy === 'least_loaded' || strategy === 'round_robin') {
                    const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
                    if (loadDelta !== 0) return loadDelta;
                }
                return (rankIndex.get(a.nodeId) ?? 0) - (rankIndex.get(b.nodeId) ?? 0);
            });
            assignIdleCandidate(remaining.shift()!);
        }
    }

    autoLaunchStarted = await maybeAutoLaunchOneQueueSession(components, meshId, mesh);
    const afterQueue = getQueue(meshId);
    const pendingAfter = afterQueue.filter(task => task.status === 'pending').length;
    const assignedAfter = afterQueue.filter(task => task.status === 'assigned').length;
    const newlyAssignedTasks = afterQueue
        .filter(task => task.status === 'assigned' && beforeStatus.get(task.id) !== 'assigned')
        .map(task => ({
            id: task.id,
            nodeId: task.assignedNodeId,
            sessionId: task.assignedSessionId,
        }));
    return {
        success: true,
        meshId,
        pendingBefore,
        assignedBefore,
        pendingAfter,
        assignedAfter,
        claimed: newlyAssignedTasks.length > 0,
        newlyAssignedTasks,
        localIdleSessionsChecked,
        remoteIdleSessionsChecked,
        skippedSessions,
        autoLaunchStarted,
        ...(pendingAfter > 0 && newlyAssignedTasks.length === 0 && localIdleSessionsChecked === 0 && remoteIdleSessionsChecked === 0 && !autoLaunchStarted
            ? { noIdleMeshSessionAvailable: true }
            : {}),
    };
}

async function maybeAutoFastForwardIdleNode(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId?: string;
    providerType?: string;
}): Promise<void> {
    const mesh = getMeshWithCache(components, args.meshId);
    const node = mesh?.nodes?.find((candidate: any) => meshNodeIdMatches(candidate, args.nodeId));
    const workspace = readNonEmptyString(node?.workspace);
    if (!workspace) return;
    if (!existsSync(workspace)) return;

    const policy = resolveAutoFastForwardPolicy(mesh);
    if (!policy.enabled) return;
    if (nodeHasActiveMeshWork(components, args.meshId, args.nodeId, args.sessionId)) return;

    const throttleKey = `${args.meshId}:${args.nodeId}`;
    const now = Date.now();
    const lastAttempt = idleAutoFastForwardLastAttempt.get(throttleKey) || 0;
    if (now - lastAttempt < IDLE_AUTO_FAST_FORWARD_THROTTLE_MS) return;
    idleAutoFastForwardLastAttempt.set(throttleKey, now);

    const submoduleIgnorePaths = Array.isArray(node?.policy?.submoduleIgnorePaths)
        ? node.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
        : undefined;
    try {
        const dryRun = await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            execute: false,
            dryRun: true,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: 'idle_auto',
        });
        if (!dryRun || dryRun.code !== 'fast_forward_available' || dryRun.allowed !== true) return;
        const behind = Number(dryRun.current?.behind);
        if (policy.maxBehind !== undefined && Number.isFinite(behind) && behind > policy.maxBehind) return;
        if (policy.requireCleanSubmodules) {
            const submodules = Array.isArray(dryRun.current?.submodules) ? dryRun.current.submodules : [];
            if (submodules.some((submodule: any) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return;
        }
        await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            execute: true,
            dryRun: false,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: 'idle_auto',
        });
    } catch (e: any) {
        LOG.warn('MeshFastForward', `Idle auto fast-forward check failed for ${args.nodeId}: ${e?.message || e}`);
    }
}

function runIdleMaintenanceThenAssignQueue(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
}): void {
    setImmediate(() => {
        maybeAutoFastForwardIdleNode(components, args)
            .finally(() => {
                try {
                    tryAssignQueueTask(components, args.meshId, args.nodeId, args.sessionId, args.providerType);
                } catch (e: any) {
                    LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${args.nodeId}: ${e?.message || e}`);
                }
            });
    });
}

// ---------------------------------------------------------------------------
// Core event injection
// ---------------------------------------------------------------------------

const MESH_COORDINATOR_EVENTS = new Set([
    'agent:generating_started',
    'agent:generating_completed',
    'agent:waiting_approval',
    'agent:stopped',
    'agent:ready',
    'monitor:no_progress',
    'refine:accepted',
    'refine:completed',
    'refine:failed',
    'worktree_bootstrap_complete',
    'worktree_bootstrap_failed',
]);

const EVENT_TO_LEDGER_KIND: Record<string, MeshLedgerKind> = {
    'agent:generating_completed': 'task_completed',
    'agent:waiting_approval': 'task_approval_needed',
    'agent:stopped': 'task_failed',
    'monitor:no_progress': 'task_stalled',
};

export function isMeshCoordinatorEvent(eventName: unknown): eventName is string {
    return typeof eventName === 'string' && MESH_COORDINATOR_EVENTS.has(eventName);
}

// Terminal events that the coordinator is actively blocked waiting on. When the
// coordinator CLI session dispatches a task (e.g. mesh_send_task) it stays in
// `generating` until the result arrives — but a generating coordinator queues
// incoming send_message calls into its adapter's pendingOutboundQueue, which is
// only flushed on the coordinator's OWN idle transition. That transition can't
// happen until it receives this very event → deadlock. We force-inject these so
// they bypass the busy send-guard and land in the PTY while generating.
export const MESH_FORCE_INJECT_EVENTS: ReadonlySet<string> = new Set([
    'agent:generating_completed',
    'agent:stopped',
    'agent:waiting_approval',
    'refine:completed',
    'refine:failed',
    'worktree_bootstrap_complete',
    'worktree_bootstrap_failed',
]);

export function shouldForceInjectMeshEvent(eventName: unknown): boolean {
    return typeof eventName === 'string' && MESH_FORCE_INJECT_EVENTS.has(eventName);
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
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(eventNodeId, eventSessionId);
            } catch { /* best-effort */ }
        }
        LOG.info('MeshEvents', `Suppressed ${args.event} for intentionally cleanup-stopped session ${eventSessionId || '(unknown session)'}`);
        return { success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true };
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
            return injectMeshSystemMessage(components, {
                ...args,
                event: 'agent:generating_completed',
                metadataEvent: reconciledCompletion,
            });
        }
        if (reconciledCompletion?.source === 'no_progress_terminal_ledger_suppression') {
            LOG.info('MeshEvents', `Suppressed no-progress monitor because terminal ledger evidence already exists for session ${eventSessionId || '(unknown session)'}`);
            return {
                success: true,
                forwarded: 0,
                suppressed: true,
                terminalLedgerEvidence: true,
                terminalLedgerKind: reconciledCompletion.terminalLedgerKind,
            };
        }
    }

    if (isDuplicateRefineTerminalEvent(args.meshId, args.event, args.metadataEvent)) {
        LOG.info('MeshEvents', `Suppressed duplicate ${args.event} for refine job ${readRefineJobId({ metadataEvent: args.metadataEvent })}`);
        return { success: true, forwarded: 0, suppressed: true, duplicateRefineTerminalEvent: true };
    }

    const eventTimestamp = readEventTimestamp(args.metadataEvent.timestamp);
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
            return { success: true, forwarded: 0, suppressed: true, duplicateApproval: true };
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
            const supersedesWeakTerminal = isWeakTerminalLedgerPayload(terminal.payload)
                && isGenuineCompletionEvidence(args.metadataEvent);
            if (!newDispatchAfterTerminal && !supersedesWeakTerminal) {
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
                    return { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true, terminalLedgerEvidence: true };
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
            return { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true };
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
            return { success: true, forwarded: 0, suppressed: true, duplicateStopped: true };
        }
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
        const leaveDirectDispatchActive = !task && opts?.tentativeIfDirect === true;
        if (!leaveDirectDispatchActive) {
            updateDirectDispatchStatus(args.meshId, sessionId, outcome);
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
            directDispatchTaskIdForLedger = resolveActiveDirectDispatchTaskId(args.meshId, sessionId);
            // A false-idle completion of a direct dispatch is recorded but kept tentative (the
            // dispatch row stays active for the reconcile fallback); a genuine completion is terminal.
            const isFalseIdle = isFalseIdleCompletion(args.metadataEvent);
            completedTaskForLedger = markSessionTerminal(sessionId, 'completed', eventTimestamp, { tentativeIfDirect: isFalseIdle });
            if (nodeId && providerType) {
                runIdleMaintenanceThenAssignQueue(components, { meshId: args.meshId, nodeId, sessionId, providerType });
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
                MeshRuntimeStore.getInstance().setRemoteIdleSession(nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
            } catch { /* best-effort */ }
            setImmediate(() => {
                maybeAutoFastForwardIdleNode(components, { meshId: args.meshId, nodeId, sessionId, providerType })
                    .finally(() => {
                        try {
                            const assigned = tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                            if (assigned) MeshRuntimeStore.getInstance().deleteRemoteIdleSession(nodeId, sessionId);
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
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(nodeId, sessionId);
            } catch { /* best-effort */ }
        }
        if (sessionId) {
            updateDirectDispatchStatus(args.meshId, sessionId, 'acked');
            const activeDeliveries = ((): { id: string }[] => {
                try { return MeshRuntimeStore.getInstance().getActiveSessionDeliveries(args.meshId, sessionId); }
                catch { return []; }
            })();
            for (const d of activeDeliveries) {
                updateSessionDeliveryStatus(d.id, 'acked');
            }
        }
    } else if (args.event === 'agent:stopped') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(nodeId, sessionId);
            } catch { /* best-effort */ }
        }
        if (sessionId) {
            directDispatchTaskIdForLedger = resolveActiveDirectDispatchTaskId(args.meshId, sessionId);
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

                        const node = mesh?.nodes.find((n: any) => n.id === autoNodeId);
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
    }
    return { success: true, forwarded: 0 };
}

export function handleMeshForwardEvent(components: DaemonComponents, payload: Record<string, unknown>) {
    const eventName = readNonEmptyString(payload.event);
    if (!isMeshCoordinatorEvent(eventName)) {
        return { success: false, error: 'unsupported mesh event' };
    }
    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);

    // The fallback worker-forward path (forwardUnresolvedDelegateEvent) cannot resolve a
    // mesh id locally on the remote worker, so it forwards the event with workspace only.
    // The coordinator hosting the mesh CAN resolve it: recover the mesh id by workspace
    // when the payload doesn't carry one.
    const meshId = readNonEmptyString(payload.meshId)
        || (workspace ? readNonEmptyString(getCachedMeshByWorkspace(workspace)?.id) : '');
    if (!meshId) return { success: false, error: 'meshId required' };
    const nodeLabel = nodeId ? `Node '${nodeId}'` : workspace ? `Agent at ${workspace}` : 'Remote agent';
    const relayModalMessage = readNonEmptyString(payload.modalMessage);
    const relayModalButtons = Array.isArray(payload.modalButtons)
        ? (payload.modalButtons as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        : null;

    return injectMeshSystemMessage(components, {
        meshId,
        nodeId,
        nodeLabel,
        event: eventName,
        metadataEvent: {
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
        },
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
    // reads. meshId is omitted on purpose — the worker can't resolve it; the coordinator
    // recovers it from workspace. nodeId/workspace come from the worker envelope so the
    // coordinator can name and locate the node.
    const payload: Record<string, unknown> = {
        ...event,
        event: eventName,
        nodeId: readNonEmptyString(routing.nodeId) || readNonEmptyString(event.meshNodeId) || undefined,
        workspace: readNonEmptyString(routing.workspace) || readNonEmptyString(event.workspace) || undefined,
    };

    // 1) Persist durably FIRST. Idempotent on fingerprint, so a re-fired completion
    //    does not duplicate the outbox row. If persistence fails we still attempt the
    //    push below (degrades to the old at-most-once behaviour rather than dropping
    //    the chance entirely).
    const persisted = enqueueUnresolvedDelegateForward(coordinatorDaemonId, eventName, payload);

    // 2) Best-effort immediate push for low latency. On success, ack the outbox row so
    //    the retry loop won't re-send it. On failure, leave it queued — PHASE 0 retries.
    Promise.resolve(components.dispatchMeshCommand(coordinatorDaemonId, 'mesh_forward_event', payload))
        .then((result: any) => {
            if (result && result.success === false) {
                LOG.warn('MeshEvents', `Immediate forward of ${eventName} to coordinator ${coordinatorDaemonId} rejected (${readNonEmptyString(result.error) || 'no reason'}) — left queued for retry`);
                return;
            }
            // Acked. Mark the durable copy delivered so the retry loop skips it.
            if (persisted) ackUnresolvedDelegateForwardByFingerprint(coordinatorDaemonId, eventName, payload);
        })
        .catch((e: any) => {
            // Coordinator momentarily unreachable; the durable row stays queued and the
            // reconcile loop retries it. Trace so the relay attempt is visible.
            LOG.warn('MeshEvents', `Immediate forward of ${eventName} to coordinator ${coordinatorDaemonId} failed: ${e?.message || e} — left queued for retry`);
        });
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
        entry.coordinatorDaemonId === coordinatorDaemonId
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
