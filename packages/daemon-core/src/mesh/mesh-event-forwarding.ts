// ---------------------------------------------------------------------------
// mesh-event-forwarding — provider events of mesh sessions → turn evidence
// ---------------------------------------------------------------------------
// Wiring-unification C-W3 (docs/design/2026-09-23-wiring-unification.md §5 C2).
//
// Before C this file was the coordinator-notification engine: a 1,480-line
// `injectMeshSystemMessage` that re-derived "is this task done?" from each
// provider event (suppression windows, fingerprints, supersede, flip-miss
// nets, hollow requeue, recovery relaunch, report shadowing) and then queued
// pre-rendered text into the pending-events table for four different drains.
// After C the turn ledger is the only authority on "done" and seqscribe the
// only event path, so what is left here is small and has no decisions of its
// own:
//
//   1. EVIDENCE BUILDER. A mesh session's `agent:*` provider event becomes one
//      content-free `TurnEvidence`, observed through the ledger. The reducer
//      decides (commit / hold / reclaim / record); a commit's `turn.notify`
//      reaches the coordinator through the `turn.deliver` cursor. Text (the
//      final summary, the modal message, the question list) stays LOCAL in the
//      evidence row's envelope, or rides `mesh.<id>.handoff` when the attempt
//      is owned by another daemon.
//   2. NOTICES for the non-turn events (worktree bootstrap, refine, mission
//      close candidate, graph gates) through the coordinator notifier.
//   3. QUEUE EDGES the reducer does not own: a worker going idle registers as a
//      claim candidate and pulls its next queued task; a worktree bootstrap
//      terminal state is stamped onto the coordinator's mesh view and re-fires
//      the queue. (C-W4's scheduler owns the periodic claim.)
//   4. The dashboard mirror hook (cloud `onMeshCoordinatorEventForwarded`).
//
// Deleted with this rewrite (brief §2.3): the pending queue and every drain,
// the P2P pull re-injection (`handleMeshForwardEvent` now feeds the SAME
// evidence/notice path in-process), the unresolved-forward outbox, the
// suppression/fingerprint/supersede windows, the hollow requeue and recovery
// relaunch (reducer R33 / R20), and report shadowing (R17/R18).
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-components.js';
import { getMachineId } from '../config/config.js';
import { getMesh, getMeshByRepo, listMeshes } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import {
    daemonIdsEquivalent,
    expandDaemonIdForms,
    isTurnAttemptRef,
    meshNodeIdMatches,
    sessionIdsEquivalent,
    withStatusProbeMarker,
    type MeshNodeIdentified,
} from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getQueue } from './mesh-work-queue.js';
import { resolveWorkerDelegateRouting, recordUnroutableDelegateEvent, isUnroutableDelegateRejection } from './mesh-routing.js';
import { resolveMeshHostStatus } from './mesh-host-ownership.js';
import { traceMeshEventStage, traceMeshEventDrop } from '../shared/mesh-event-trace.js';
import { getLastDisplayMessage } from '../status/snapshot.js';
import { maybeInjectIdleActiveMissionReminder } from './mesh-idle-reminder.js';
import { registerMeshGraphQueueWakeHandler, registerMeshGraphGateNotifyHandler } from './mesh-graph-transition-runner.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import {
    getMeshWithCache,
    tryAssignQueueTask,
    triggerMeshQueue,
    runIdleMaintenanceThenAssignQueue,
    maybeAutoFastForwardIdleNode,
} from './mesh-queue-assignment.js';
import { markRemoteSessionGenerating, markRemoteSessionIdle, isAutoLaunchWithinAwaitClaimWindow } from './mesh-autolaunch-integrity.js';
import {
    readNonEmptyString,
    resolveEventSessionId,
    readWorkerResultMetadata,
    resolveMeshSurfacedSessionPreview,
    isFalseIdleCompletion,
} from './mesh-events-utils.js';
import { isMeshCoordinatorEvent } from './mesh-event-classify.js';
import type { CoordinatorSessionView } from './turn-ledger/routing.js';
import { meshNoticeRuntime, notifyMeshCoordinator, type CoordinatorNotice } from './turn-ledger/deliver.js';

// ---------------------------------------------------------------------------
// Remote Node Idle Session Tracking
// ---------------------------------------------------------------------------
const REMOTE_IDLE_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

function sweepExpiredRemoteIdleSessions(): void {
    try { MeshRuntimeStore.getInstance().pruneExpiredRemoteIdleSessions(); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Workspace-to-mesh lookup cache + meshId recovery (unchanged)
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

/** A forwarded event's mesh by the node it names (the coordinator-side stable fact). */
function recoverMeshIdByNodeId(nodeId: string): string {
    if (!nodeId) return '';
    for (const mesh of listMeshes()) {
        if (Array.isArray(mesh.nodes) && mesh.nodes.some((n: any) => meshNodeIdMatches(n, nodeId))) {
            return readNonEmptyString(mesh.id);
        }
    }
    return '';
}

/**
 * MESHID-DROP coordinator-anchor recovery: among the meshes this daemon HOSTS for
 * the anchor, the one whose nodes contain `nodeId`; with no nodeId, only an
 * unambiguous single hosted mesh. Never a guess (a wrong mesh id would land the
 * event in an unrelated mesh).
 */
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
        return byNode ? readNonEmptyString(byNode.id) : '';
    }
    return hosted.length === 1 ? readNonEmptyString(hosted[0].id) : '';
}

/**
 * Worker-side meshId resolution for an event whose session carries no mesh
 * stamp: workspace → node id → the live session's own stamps. '' when even the
 * worker cannot resolve it (the event is then unroutable and says so).
 */
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
        } catch { /* best-effort — unresolved */ }
    }
    return '';
}

export function __resetMeshWorkspaceCacheForTests(): void {
    meshByWorkspaceCache.clear();
}

// ---------------------------------------------------------------------------
// Coordinator-daemon identity + local coordinator sessions (turn.deliver inputs)
// ---------------------------------------------------------------------------

/**
 * Every id form this daemon answers to as a coordinator daemon (status id,
 * machine id, and their prefixed/canonical variants) — a unicast notice may be
 * stamped with any of them depending on the dispatch path.
 */
export function resolveCoordinatorDrainDaemonIds(components: Pick<DaemonComponents, 'statusInstanceId'>): string[] {
    const statusInstanceId = readNonEmptyString(components.statusInstanceId);
    const machineId = readNonEmptyString(getMachineId());
    return expandDaemonIdForms([statusInstanceId, machineId]);
}

type InstanceLike = {
    category?: string;
    getState(): any;
    onEvent(event: string, data?: any): void;
    getDrainStatus?: () => string | null;
    isModalParked?: () => boolean;
};

/**
 * Raw drain-eligibility of a coordinator instance: the adapter turn-state with
 * the auto-approve hold-idle mask stripped (PTY-OVERTRUST-DRAIN), falling back
 * to the masked status for instances without `getDrainStatus()`.
 */
function coordinatorIsIdle(instance: InstanceLike): boolean {
    const drainStatus = typeof instance.getDrainStatus === 'function' ? instance.getDrainStatus() : null;
    if (drainStatus !== null && drainStatus !== undefined) return drainStatus === 'idle';
    return readNonEmptyString(instance.getState()?.status).toLowerCase() === 'idle';
}

function coordinatorIsModalParked(instance: InstanceLike): boolean {
    if (typeof instance.isModalParked === 'function') return instance.isModalParked() === true;
    const status = readNonEmptyString(instance.getState()?.status).toLowerCase();
    return status === 'waiting_choice' || status === 'waiting_approval';
}

/** This daemon's live CLI coordinator sessions of one mesh (the deliver consumer's routing snapshot). */
export function listLocalCoordinatorSessions(components: Pick<DaemonComponents, 'instanceManager'>, meshId: string): CoordinatorSessionView[] {
    const out: CoordinatorSessionView[] = [];
    for (const inst of components.instanceManager.getByCategory('cli') as unknown as InstanceLike[]) {
        const state = inst.getState();
        const settings = state?.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};
        if (readNonEmptyString(settings.meshCoordinatorFor) !== meshId) continue;
        const sessionId = readNonEmptyString(state?.instanceId);
        if (!sessionId) continue;
        out.push({ sessionId, idle: coordinatorIsIdle(inst), modalParked: coordinatorIsModalParked(inst) });
    }
    return out;
}

/**
 * `TurnEvidencePort`'s `ownerFor` (C-W5c): resolve the mesh worker delegate
 * routing for a session and reduce it to the port's `{daemonId, meshId} | null`
 * shape. Reuses `resolveWorkerDelegateRouting` (the same authority the deleted
 * `buildProviderEvidence` path routed through via `onProviderEvent`) so a
 * worker's owner resolves identically whether the port asks for it directly
 * (every producer site, after C-W5c) or a caller still routes through
 * `processMeshEvent`'s non-turn notice path.
 *
 * `null` = this daemon is the owner (no delegate routing, or the routing
 * resolves a mesh but no coordinator anchor — the common coordinator-local
 * worker case) or the session cannot be resolved at all (a cold PTY-exit
 * whose instance already tore down; the caller's `selfDaemonId` fallback in
 * the port then treats it as local, same as before this addition since the
 * pre-C-W5c path only ever saw evidence for live instances).
 */
export function resolveEvidenceOwner(components: DaemonComponents, sessionId: string): { daemonId: string; meshId: string } | null {
    try {
        const routing = resolveWorkerDelegateRouting(components, sessionId, {
            getMeshById: (meshId) => getMeshWithCache(components, meshId),
            getMeshByWorkspace: (workspace) => getCachedMeshByWorkspace(workspace),
        });
        if (!routing.isDelegate || !routing.meshId || !routing.coordinatorDaemonId) return null;
        return { daemonId: routing.coordinatorDaemonId, meshId: routing.meshId };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Cancel executor + envelope helpers (moved from the deleted suppression module)
// ---------------------------------------------------------------------------

/**
 * Per-session ordering for destructive actions (stop/kill/teardown): each runs
 * strictly after the previous one queued for the same session settled. Moved
 * here from the retired legacy reducer module (C-W8) — this file is its only
 * caller. The chain stays settled-proof so a rejection never poisons later
 * actions.
 */
const sessionDestructiveChains = new Map<string, Promise<unknown>>();
function runSessionDestructiveAction<T>(sessionKey: string, act: () => Promise<T> | T): Promise<T> {
    const prior = sessionDestructiveChains.get(sessionKey) ?? Promise.resolve();
    const next = prior.then(act, act) as Promise<T>;
    sessionDestructiveChains.set(sessionKey, next.catch(() => undefined));
    return next;
}

/**
 * Stop a worker session whose dispatch the ledger cut (reclaim / R27a / R28a /
 * stale nonce): local `stop_cli` when the adapter lives here, else `stop_cli`
 * to the worker node's daemon over P2P with the short connect-wait marker.
 * Strictly ordered after any evidence read already in flight for the session.
 * The turn ledger's `cancelDispatch` port.
 */
export function stopStaleMeshWorker(
    components: DaemonComponents,
    args: { meshId: string; sessionId: string; nodeId?: string; providerType?: string; daemonId?: string; reason?: string },
): void {
    const { meshId, sessionId, providerType } = args;
    void runSessionDestructiveAction(sessionId, () => {
        const stopArgs: Record<string, unknown> = {
            targetSessionId: sessionId,
            ...(providerType ? { cliType: providerType } : {}),
            mode: 'hard',
            reason: args.reason ?? 'stale_mesh_dispatch_reclaimed',
        };
        try {
            const isLocal = components.cliManager?.adapters?.has?.(sessionId) === true;
            if (isLocal) {
                if (!stopArgs.cliType) {
                    const localType = components.cliManager?.adapters?.get?.(sessionId)?.cliType;
                    if (localType) stopArgs.cliType = localType;
                }
                Promise.resolve().then(() => components.cliManager.stopCli(stopArgs))
                    .catch((e: any) => LOG.warn('MeshQueue', `Local stop of stale worker ${sessionId} failed: ${e?.message || e}`));
                return;
            }
            let daemonId = args.daemonId;
            if (!daemonId && args.nodeId) {
                try {
                    const mesh = getMeshWithCache(components, meshId);
                    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, args.nodeId!));
                    daemonId = node ? readMeshNodeDaemonId(node) || undefined : undefined;
                } catch { /* best-effort */ }
            }
            if (daemonId && components.dispatchMeshCommand) {
                Promise.resolve(components.dispatchMeshCommand(daemonId, 'stop_cli', withStatusProbeMarker(stopArgs)))
                    .catch((e: any) => LOG.warn('MeshQueue', `Remote stop of stale worker ${sessionId} on daemon ${daemonId} failed: ${e?.message || e}`));
            } else {
                LOG.warn('MeshQueue', `Cannot stop stale worker ${sessionId}: no local adapter and no resolvable remote daemon id (node ${args.nodeId ?? '?'}).`);
            }
        } catch (e: any) {
            LOG.warn('MeshQueue', `stopStaleMeshWorker error for ${sessionId}: ${e?.message || e}`);
        }
    });
}

/**
 * KIMI-HOLLOW-COMPLETION: a completion whose producer proved a zero-byte final
 * answer with insufficient evidence and no structured report. Becomes
 * `turn_end{hollow:true}` (reducer R33 requeues once, R33f fails). Kept (used
 * by `mesh-events-coordinator.ts`) though its evidence-builder call site
 * (`buildProviderEvidence`) is deleted with C-W5c — this classification is
 * still needed by that other consumer.
 */
export function isHollowCompletion(metadataEvent: Record<string, unknown>): boolean {
    const diagnostic = readRecord(metadataEvent.completionDiagnostic);
    if (diagnostic?.finalAssistantContentLength !== 0) return false;
    if (readNonEmptyString(metadataEvent.evidenceLevel) !== 'insufficient') return false;
    if (readWorkerResultMetadata(metadataEvent)) return false;
    if (readNonEmptyString(diagnostic.finalSummarySource) === 'tool_report') return false;
    return true;
}

/**
 * BOOTSTRAP-MSG: does this queue row mean "the bootstrapped worktree node
 * already has work being handled" (so the completion text must not advise a
 * manual `mesh_launch_session` that would spawn a duplicate session)?
 */
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
        return isAutoLaunchWithinAwaitClaimWindow(Date.parse(al.updatedAt), nowMs);
    }
    return true;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// ---------------------------------------------------------------------------
// 1. Evidence builder — DELETED (wiring-unification C-W5c)
// ---------------------------------------------------------------------------
// `buildProviderEvidence`/`observeBuilt` used to build a mesh session's turn
// evidence a SECOND time from the legacy `agent:*` wire names on
// `provider_event`, duplicating what every producer site now submits
// directly through `TurnEvidencePort` (`providers/turn-evidence-port.ts`).
// The port is the sole producer since C-W5c: `wireTurnEvidencePort`
// (`boot/stages/mesh-runtime.ts`) gives it `ownerFor` (→ `resolveEvidenceOwner`
// below, the same `resolveWorkerDelegateRouting` authority this deleted
// builder used for `coordinatorDaemonId`) and `appendHandoff`, so a remote
// owner's text still rides `mesh.<id>.handoff` and a local owner's text still
// lands in the evidence row's local payload column — both exactly as this
// deleted code did, just from the ONE producer instead of two.
//
// `processMeshEvent` below therefore no longer builds evidence at all; it
// keeps only the non-turn NOTICE_EVENTS path and the queue-edge bookkeeping
// (`applyQueueEdges`) that the reducer does not own.

// ---------------------------------------------------------------------------
// 2. Non-turn events → notices
// ---------------------------------------------------------------------------

const NOTICE_EVENTS = new Set([
    'refine:accepted',
    'refine:completed',
    'refine:failed',
    'worktree_bootstrap_complete',
    'worktree_bootstrap_failed',
    'mission_close_candidate',
]);

function worktreeHasQueuedTaskFor(meshId: string, nodeId: string): boolean {
    try {
        const nowMs = Date.now();
        return getQueue(meshId, { status: ['pending', 'assigned'] })
            .some((task) => bootstrapQueueTaskCountsAsHandled(task as any, nodeId, nowMs));
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 3. Queue edges (idle registration + claim, bootstrap terminal state)
// ---------------------------------------------------------------------------

function registerIdleWorkerAndClaim(components: DaemonComponents, args: { meshId: string; nodeId: string; sessionId: string; providerType: string; falseIdle: boolean }): void {
    const { meshId, nodeId, sessionId, providerType } = args;
    if (args.falseIdle) {
        runIdleMaintenanceThenAssignQueue(components, { meshId, nodeId, sessionId, providerType });
        return;
    }
    // OVEREAGER-REMOTE-IDLE: re-register the now-idle session as a claim
    // candidate, then claim for THIS session first (the enqueue drain must not
    // re-pick a session that just took work).
    markRemoteSessionIdle(meshId, sessionId);
    sweepExpiredRemoteIdleSessions();
    try {
        MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
    } catch { /* best-effort */ }
    setImmediate(() => {
        maybeAutoFastForwardIdleNode(components, { meshId, nodeId, sessionId, providerType })
            .finally(() => {
                try {
                    const assigned = tryAssignQueueTask(components, meshId, nodeId, sessionId, providerType);
                    if (assigned) MeshRuntimeStore.getInstance().deleteRemoteIdleSession(meshId, nodeId, sessionId);
                } catch (e: any) {
                    LOG.warn('MeshQueue', `Failed to assign idle queue task for ${nodeId}: ${e?.message || e}`);
                }
            });
    });
}

function applyQueueEdges(components: DaemonComponents, meshId: string, nodeId: string, eventName: string, event: Record<string, unknown>, sessionId: string): void {
    const providerType = readNonEmptyString(event.providerType);
    if (eventName === 'agent:generating_started' || eventName === 'agent:stopped') {
        if (sessionId && nodeId) {
            try { MeshRuntimeStore.getInstance().deleteRemoteIdleSession(meshId, nodeId, sessionId); } catch { /* best-effort */ }
        }
        if (sessionId) {
            if (eventName === 'agent:generating_started') markRemoteSessionGenerating(meshId, sessionId);
            else markRemoteSessionIdle(meshId, sessionId);
        }
        return;
    }
    if (eventName === 'agent:generating_completed' && sessionId && nodeId && providerType) {
        registerIdleWorkerAndClaim(components, { meshId, nodeId, sessionId, providerType, falseIdle: isFalseIdleCompletion(event) });
        return;
    }
    if (eventName === 'agent:ready' && sessionId && nodeId && providerType) {
        // WORKTREE-BOOTSTRAP-DISPATCH-RACE: a fresh worktree reaches its idle
        // prompt before its bootstrap finishes — register the idle session but
        // defer the claim until the bootstrap terminal edge re-fires the queue.
        let worktreeBootstrapPending = false;
        try {
            const mesh = getMeshWithCache(components, meshId);
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId)) as { worktreeBootstrap?: { status?: string } } | undefined;
            worktreeBootstrapPending = node?.worktreeBootstrap?.status === 'running';
        } catch { /* unknown → do not defer */ }
        if (worktreeBootstrapPending) {
            markRemoteSessionIdle(meshId, sessionId);
            try {
                MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
            } catch { /* best-effort */ }
            LOG.info('MeshQueue', `Deferring queue claim for worktree node ${nodeId} (${sessionId}): bootstrap still running`);
            return;
        }
        registerIdleWorkerAndClaim(components, { meshId, nodeId, sessionId, providerType, falseIdle: false });
    }
}

/**
 * WORKTREE-BOOTSTRAP-COORD-STATE + REFIRE: stamp the terminal bootstrap state
 * onto the coordinator's mesh view (so the claim gate opens) and re-fire the
 * queue so a claim deferred on the early agent:ready lands now.
 */
function applyBootstrapTerminal(components: DaemonComponents, meshId: string, nodeId: string, eventName: string, event: Record<string, unknown>): void {
    if (nodeId) {
        const workspace = readNonEmptyString(event.worktreePath) || readNonEmptyString(event.workspace);
        const daemonId = readNonEmptyString(event.originDaemonId) || readNonEmptyString(event.daemonId);
        const machineId = readNonEmptyString(event.originMachineId) || readNonEmptyString(event.machineId);
        components.router.markWorktreeBootstrapTerminalState(
            meshId,
            nodeId,
            eventName === 'worktree_bootstrap_failed' ? 'failed' : 'complete',
            (workspace || daemonId || machineId)
                ? { ...(workspace ? { workspace } : {}), ...(daemonId ? { daemonId } : {}), ...(machineId ? { machineId } : {}) }
                : undefined,
        );
    }
    setImmediate(() => {
        triggerMeshQueue(components, meshId).catch((e: any) => {
            LOG.warn('MeshQueue', `Queue re-fire after ${eventName} failed (mesh ${meshId}): ${e?.message || e}`);
        });
    });
}

// ---------------------------------------------------------------------------
// The one entry point: a mesh event of a (local or relayed) session
// ---------------------------------------------------------------------------

export interface MeshEventInput {
    meshId: string;
    eventName: string;
    event: Record<string, unknown>;
    nodeId: string;
    nodeLabel: string;
    sessionId: string;
    /** The live worker session's settings (empty for a relayed event). */
    settings: Record<string, unknown>;
    /** The coordinator daemon the worker reports to ('' = this daemon / unknown). */
    coordinatorDaemonId: string;
    /** The coordinator session the worker reports to, when stamped. */
    coordinatorSessionId: string;
}

export interface MeshEventResult {
    success: boolean;
    evidence?: string;
    notice?: string;
    error?: string;
}

/**
 * Notice / queue edges for one mesh event. Never throws. Evidence
 * construction is gone (C-W5c): a mesh session's `agent:*` events now reach
 * `TurnEvidencePort` directly from the provider instance that observed them
 * (`providers/turn-evidence-port.ts`'s `emit*` helpers), never through this
 * bus-subscriber path — see the "1. Evidence builder — DELETED" note above.
 */
export function processMeshEvent(components: DaemonComponents, input: MeshEventInput): MeshEventResult {
    const { meshId, eventName, event, nodeId, sessionId } = input;
    const traceCtx = { taskId: event.taskId ?? event.meshActiveTaskId, sessionId, nodeId, meshId, event: eventName };
    const result: MeshEventResult = { success: true };
    try {
        if (NOTICE_EVENTS.has(eventName)) {
            if (eventName === 'worktree_bootstrap_complete' || eventName === 'worktree_bootstrap_failed') {
                // A stamp failure is loud but never costs the coordinator its notice.
                try {
                    applyBootstrapTerminal(components, meshId, nodeId, eventName, event);
                } catch (e: any) {
                    LOG.error('MeshQueue', `Failed to stamp terminal bootstrap state for ${nodeId || '-'} (mesh ${meshId}): ${e?.message || e}`);
                    result.error = e?.message || String(e);
                }
            }
            const notice: CoordinatorNotice = {
                meshId,
                event: eventName,
                nodeLabel: input.nodeLabel,
                ...(nodeId ? { nodeId } : {}),
                ...(readNonEmptyString(event.workspace) ? { workspace: readNonEmptyString(event.workspace) } : {}),
                metadataEvent: event,
                ...(input.coordinatorDaemonId ? { targetCoordinatorDaemonId: input.coordinatorDaemonId } : {}),
                ...(input.coordinatorSessionId ? { targetCoordinatorSessionId: input.coordinatorSessionId } : {}),
                ...(eventName === 'worktree_bootstrap_complete' && nodeId && worktreeHasQueuedTaskFor(meshId, nodeId) ? { worktreeHasQueuedTask: true } : {}),
            };
            const queued = notifyMeshCoordinator(notice);
            traceMeshEventStage(queued ? 'queued' : 'notice_deduped', traceCtx);
            result.notice = eventName;
            return result;
        }

        applyQueueEdges(components, meshId, nodeId, eventName, event, sessionId);
    } catch (e: any) {
        LOG.warn('MeshEvents', `mesh event ${eventName} (mesh ${meshId}, session ${sessionId || '-'}) failed: ${e?.message || e}`);
        result.success = false;
        result.error = e?.message || String(e);
    }
    return result;
}

/**
 * The mesh a forwarded (`mesh_forward_event`) payload belongs to: its meshId,
 * else the mesh owning its workspace, else recovered from its nodeId (and the
 * coordinator id it names). Shared by the handler and the router's mesh
 * sender gate (commands/mesh-sender.ts `node_owner`), so both judge the SAME
 * mesh's roster.
 */
export function resolveForwardedEventMeshId(payload: Record<string, unknown>): string {
    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);
    return readNonEmptyString(payload.meshId)
        || (workspace ? readNonEmptyString(getCachedMeshByWorkspace(workspace)?.id) : '')
        || recoverMeshIdByNodeId(nodeId)
        || recoverMeshIdByCoordinatorAndNode(
            readNonEmptyString(payload.meshCoordinatorDaemonId) || readNonEmptyString(payload.coordinatorDaemonId),
            nodeId,
        );
}

/**
 * A mesh event reported by ANOTHER process path rather than this daemon's own
 * provider bus: the in-process refine jobs, the `mesh_forward_event` command
 * (a worker daemon's direct report, cli-agent's forward). Resolves the mesh,
 * then takes the same evidence / notice path as a local event. The payload is
 * the flat relay shape (`buildRelayMetadataEvent`).
 */
export function handleMeshForwardEvent(components: DaemonComponents, payload: Record<string, unknown>): MeshEventResult {
    const eventName = readNonEmptyString(payload.event);
    if (!isMeshCoordinatorEvent(eventName)) {
        return { success: false, error: 'unsupported mesh event' };
    }
    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);
    const meshId = resolveForwardedEventMeshId(payload);
    if (!meshId) {
        traceMeshEventDrop('meshId_required', {
            taskId: payload.taskId,
            sessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
            nodeId,
            event: eventName,
        }, workspace ? `workspace=${workspace} unresolved` : 'no workspace/nodeId');
        return { success: false, error: 'meshId required' };
    }
    const event = buildRelayMetadataEvent(payload);
    traceMeshEventStage('received', { taskId: event.taskId, sessionId: event.targetSessionId, nodeId, meshId, event: eventName });
    return processMeshEvent(components, {
        meshId,
        eventName,
        event,
        nodeId,
        nodeLabel: nodeId ? `Node '${nodeId}'` : workspace ? `Agent at ${workspace}` : 'Remote agent',
        sessionId: readNonEmptyString(event.targetSessionId),
        settings: {},
        // The relayed return address (a sessionless producer — an async refine job
        // on the executing daemon — carries it on the payload). Absent = this
        // daemon (it hosts the coordinator and owns the attempt).
        coordinatorDaemonId: readNonEmptyString(event.targetCoordinatorDaemonId),
        coordinatorSessionId: readNonEmptyString(event.meshCoordinatorSessionId),
    });
}

// Reconstruct the metadata of a flat relayed payload (field allow-list; the
// in-process path keeps the whole provider event). Unchanged from pre-C.
export function buildRelayMetadataEvent(payload: Record<string, unknown>): Record<string, unknown> {
    const relayModalMessage = readNonEmptyString(payload.modalMessage);
    const relayModalButtons = Array.isArray(payload.modalButtons)
        ? (payload.modalButtons as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        : null;
    const inner = readRecord(payload.metadataEvent);
    return {
        taskId: readNonEmptyString(payload.taskId) || readNonEmptyString(payload.meshActiveTaskId),
        attemptId: readNonEmptyString(payload.attemptId) || readNonEmptyString(payload.meshActiveAttemptId),
        ...(isTurnAttemptRef(payload.attemptRef) ? { attemptRef: payload.attemptRef } : {}),
        ...(typeof payload.dispatchNonce === 'number'
            ? { dispatchNonce: payload.dispatchNonce }
            : (typeof payload.meshActiveDispatchNonce === 'number' ? { dispatchNonce: payload.meshActiveDispatchNonce } : {})),
        targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.instanceId),
        providerType: readNonEmptyString(payload.providerType),
        providerSessionId: readNonEmptyString(payload.providerSessionId),
        meshCoordinatorSessionId: readNonEmptyString(payload.meshCoordinatorSessionId) || readNonEmptyString(payload.targetCoordinatorSessionId),
        targetCoordinatorDaemonId: readNonEmptyString(payload.targetCoordinatorDaemonId),
        workspace: readNonEmptyString(payload.workspace) || readNonEmptyString(payload.workspaceName),
        workspaceName: readNonEmptyString(payload.workspaceName) || readNonEmptyString(payload.workspace),
        sessionTitle: readNonEmptyString(payload.sessionTitle),
        sessionStatus: readNonEmptyString(payload.sessionStatus),
        sessionChatStatus: readNonEmptyString(payload.sessionChatStatus),
        providerName: readNonEmptyString(payload.providerName),
        ...(readRecord(payload.sessionSettings) ? { sessionSettings: payload.sessionSettings } : {}),
        finalSummary: readNonEmptyString(payload.finalSummary) || readNonEmptyString(payload.summary),
        evidenceLevel: readNonEmptyString(payload.evidenceLevel),
        lastMessagePreview: readNonEmptyString(payload.lastMessagePreview),
        lastMessageRole: readNonEmptyString(payload.lastMessageRole),
        ...(payload.lastMessageAt !== undefined ? { lastMessageAt: payload.lastMessageAt } : {}),
        jobId: readNonEmptyString(payload.jobId),
        interactionId: readNonEmptyString(payload.interactionId),
        status: readNonEmptyString(payload.status),
        targetDaemonId: readNonEmptyString(payload.targetDaemonId),
        originDaemonId: readNonEmptyString(payload.originDaemonId) || readNonEmptyString(payload.daemonId) || readNonEmptyString(inner?.originDaemonId),
        originMachineId: readNonEmptyString(payload.originMachineId) || readNonEmptyString(payload.machineId) || readNonEmptyString(inner?.originMachineId),
        startedAt: readNonEmptyString(payload.startedAt),
        completedAt: readNonEmptyString(payload.completedAt),
        retryOfJobId: readNonEmptyString(payload.retryOfJobId),
        ...(relayModalMessage ? { modalMessage: relayModalMessage } : {}),
        ...(relayModalButtons && relayModalButtons.length > 0 ? { modalButtons: relayModalButtons } : {}),
        ...(readRecord(payload.interactivePrompt) ? { interactivePrompt: payload.interactivePrompt } : {}),
        ...(readNonEmptyString(payload.promptId) ? { promptId: readNonEmptyString(payload.promptId) } : {}),
        ...(payload.multiSelect === true ? { multiSelect: true } : {}),
        ...(readRecord(payload.result) ? { result: payload.result } : {}),
        ...(readRecord(payload.completionDiagnostic) ? { completionDiagnostic: payload.completionDiagnostic } : {}),
        ...(readRecord(payload.workerResult) ? { workerResult: payload.workerResult } : {}),
        ...(readRecord(payload.meshWorkerResult) ? { meshWorkerResult: payload.meshWorkerResult } : {}),
        ...(readRecord(payload.structuredResult) ? { structuredResult: payload.structuredResult } : {}),
        ...(payload.timestamp !== undefined ? { timestamp: payload.timestamp } : {}),
        ...(readNonEmptyString(payload.worktreePath) ? { worktreePath: readNonEmptyString(payload.worktreePath) } : {}),
        ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
        ...(readNonEmptyString(payload.error) ? { error: readNonEmptyString(payload.error) } : {}),
        intentional: payload.intentional === true,
        intentionalStop: payload.intentionalStop === true,
        operatorCleanup: payload.operatorCleanup === true,
        reason: readNonEmptyString(payload.reason),
        stopReason: readNonEmptyString(payload.stopReason),
        cleanupReason: readNonEmptyString(payload.cleanupReason),
        source: readNonEmptyString(payload.source),
        resolution: readNonEmptyString(payload.resolution),
    };
}

// ---------------------------------------------------------------------------
// Dashboard mirror (cloud `onMeshCoordinatorEventForwarded`, no-op on standalone)
// ---------------------------------------------------------------------------

function mirrorToDashboard(components: DaemonComponents, meshId: string, nodeId: string, eventName: string, event: Record<string, unknown>, sourceSession: any): void {
    if (!components.onMeshCoordinatorEventForwarded) return;
    try {
        const last = sourceSession ? getLastDisplayMessage(sourceSession.getState()) : null;
        const enriched = (!last || !last.preview)
            ? event
            : { ...event, lastMessagePreview: last.preview, lastMessageRole: last.role, ...(last.receivedAt > 0 ? { lastMessageAt: last.receivedAt } : {}) };
        const surfaced = resolveMeshSurfacedSessionPreview(enriched);
        components.onMeshCoordinatorEventForwarded({
            event: eventName,
            meshId,
            nodeId: nodeId || undefined,
            ...enriched,
            workspace: readNonEmptyString(event.workspace) || readNonEmptyString(event.workspaceName) || undefined,
            ...(surfaced ? {
                meshSessionLastMessagePreview: surfaced.preview,
                meshSessionLastMessageRole: surfaced.role,
                meshSessionLastMessageAt: surfaced.receivedAt || undefined,
            } : {}),
        });
    } catch { /* dashboard metadata sync is best-effort */ }
}

// ---------------------------------------------------------------------------
// Setup: bus subscriber + graph seams
// ---------------------------------------------------------------------------

function onCoordinatorIdleEdge(components: DaemonComponents, instanceId: string): boolean {
    const source = components.instanceManager.getInstance(instanceId);
    if (!source || source.category !== 'cli') return false;
    const state = source.getState();
    const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};
    const coordinatorMeshId = readNonEmptyString(settings.meshCoordinatorFor);
    if (!coordinatorMeshId) return false;
    // Notices reach an idle coordinator through the turn.deliver cursor (it waits
    // on this very status edge). Only the idle-mission nudge is left here: when
    // the coordinator idles with an empty inbox and active missions remain.
    const rt = meshNoticeRuntime.current();
    if (rt && !rt.hasUndelivered(coordinatorMeshId) && coordinatorIsIdle(source as unknown as InstanceLike)) {
        void maybeInjectIdleActiveMissionReminder(
            coordinatorMeshId,
            // D2: through the daemon's one send funnel (shared messageId dedupe).
            { sessionId: instanceId, input: components.cliManager.input },
            getMesh(coordinatorMeshId)?.policy,
            undefined,
            components.instanceManager,
            undefined,
            (() => {
                const cached = components.router?.aggregateMeshStatusCache?.get(coordinatorMeshId)?.snapshot?.nodes;
                return Array.isArray(cached) ? cached : undefined;
            })(),
        ).catch((e: any) => {
            LOG.warn('MeshEvents', `idle mission reminder failed (mesh ${coordinatorMeshId}): ${e?.message || e}`);
        });
    }
    return true;
}

export function setupMeshEventForwarding(components: DaemonComponents): () => void {
    // GRAPH-ORCHESTRATION: the graph outbox's queue_wake rides the ordinary
    // triggerMeshQueue (the graph engine never dispatches directly).
    registerMeshGraphQueueWakeHandler((wakeMeshId) => {
        setImmediate(() => {
            triggerMeshQueue(components, wakeMeshId).catch((e: any) => {
                LOG.warn('MeshQueue', `Graph queue-wake trigger failed (mesh ${wakeMeshId}): ${e?.message || e}`);
            });
        });
    });
    // GRAPH-GATE-NOTIFY: an opened / lease-lapsed coordinator gate pages the
    // coordinator as a notice (gateId anchors the dedupe id).
    registerMeshGraphGateNotifyHandler((notification) => {
        const gateLabel = notification.ref || notification.gateId;
        const actionLabel = notification.action ? ` (${notification.action})` : '';
        const ageLabel = typeof notification.ageMs === 'number'
            ? ` after ${Math.max(1, Math.round(notification.ageMs / 3_600_000))}h`
            : '';
        const coordinatorMessage = notification.kind === 'graph_gate_awaiting'
            ? `Coordinator gate '${gateLabel}'${actionLabel} is awaiting you (graph ${notification.graphId}). `
              + `${notification.instructions ? `Instructions: ${notification.instructions} ` : ''}`
              + `Claim it with mesh_graph_gate_claim (gateId: ${notification.gateId}), perform the action, then release or abandon it. `
              + 'Downstream tasks stay blocked until the gate is released.'
            : notification.kind === 'graph_gate_deadline_expired'
                // D3(b): elapsed time is NOT completion evidence — the gate was
                // expired (policy applied), never released.
                ? `Coordinator gate '${gateLabel}'${actionLabel} passed its deadline${ageLabel} without release and is now expired `
                  + `(graph ${notification.graphId}, gateId: ${notification.gateId}, policy: ${notification.policy ?? 'hold'}). `
                  + (notification.policy === 'hold' || !notification.policy
                      ? 'Downstream stays blocked. Extend it (mesh_graph_gate_extend), reclaim and release it with evidence, or abandon it if the work is obsolete.'
                      : 'The timeout policy already settled its downstream; nothing is waiting on this gate.')
                : `Coordinator gate '${gateLabel}'${actionLabel} lease expired without release (graph ${notification.graphId}, gateId: ${notification.gateId}). `
                  + 'If the external action already happened, reconcile its evidence and release; otherwise reclaim the gate before retrying.';
        notifyMeshCoordinator({
            event: `mesh:${notification.kind}`,
            meshId: notification.meshId,
            nodeLabel: gateLabel,
            // A deadline expiry is keyed per deadline so an extended/reclaimed
            // gate that expires AGAIN pages again; the same expiry never twice.
            eventId: notification.kind === 'graph_gate_deadline_expired'
                ? `gate:${notification.kind}:${notification.gateId}:${notification.deadlineAt ?? ''}`
                : `gate:${notification.kind}:${notification.gateId}`,
            metadataEvent: {
                source: 'mesh_graph_outbox',
                taskId: notification.gateId,
                gateId: notification.gateId,
                graphId: notification.graphId,
                ...(notification.ref ? { ref: notification.ref } : {}),
                ...(notification.action ? { action: notification.action } : {}),
                ...(notification.deadlineAt ? { deadlineAt: notification.deadlineAt } : {}),
                // graph node id — NOT a mesh node id, hence the distinct key.
                ...(notification.nodeId ? { gateNodeId: notification.nodeId } : {}),
                ...(notification.policy ? { policy: notification.policy } : {}),
                ...(typeof notification.ageMs === 'number' ? { ageMs: notification.ageMs } : {}),
            },
            coordinatorMessage,
        });
    });

    const onProviderEvent = (event: any) => {
        const eventName = readNonEmptyString(event?.event);
        const instanceId = readNonEmptyString(event?.instanceId);
        if (!instanceId) return;
        if (eventName === 'agent:ready' || eventName === 'agent:generating_completed') {
            // A coordinator's own idle edge: not a delegate event unless the
            // coordinator is itself a direct-dispatch target (routing decides below).
            if (onCoordinatorIdleEdge(components, instanceId)) {
                const routing = resolveWorkerDelegateRouting(components, instanceId, {
                    getMeshById: (meshId) => getMeshWithCache(components, meshId),
                    getMeshByWorkspace: (workspace) => getCachedMeshByWorkspace(workspace),
                });
                if (!routing.isDelegate) return;
            }
        }
        if (!isMeshCoordinatorEvent(eventName)) return;

        const routing = resolveWorkerDelegateRouting(components, instanceId, {
            getMeshById: (meshId) => getMeshWithCache(components, meshId),
            getMeshByWorkspace: (workspace) => getCachedMeshByWorkspace(workspace),
        });
        const sourceSession = components.instanceManager.getInstance(instanceId);
        const state = sourceSession?.getState?.();
        const settings = state?.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};
        let meshId = routing.isDelegate ? routing.meshId : '';
        if (!meshId && isUnroutableDelegateRejection(routing)) {
            // A worker that is not a member of the coordinator's mesh: resolve
            // the mesh on the worker side (its live stamps / workspace) — the
            // topic replication then carries the evidence; no outbox.
            meshId = resolveForwardEventMeshId(components, { ...event, workspace: routing.workspace, nodeId: routing.nodeId });
        }
        if (!meshId) {
            if (isUnroutableDelegateRejection(routing)) {
                traceMeshEventDrop('unroutable', {
                    taskId: event.meshActiveTaskId ?? event.taskId,
                    sessionId: routing.sessionId,
                    nodeId: routing.nodeId,
                    event: eventName,
                }, 'mesh unresolved on the worker');
            }
            recordUnroutableDelegateEvent(routing, eventName);
            return;
        }
        const nodeId = routing.nodeId || readNonEmptyString(event.meshNodeId) || readNonEmptyString(settings.meshNodeId);
        mirrorToDashboard(components, meshId, nodeId, eventName, event, sourceSession);
        processMeshEvent(components, {
            meshId,
            eventName,
            event,
            nodeId,
            nodeLabel: routing.nodeLabel || (nodeId ? `Node '${nodeId}'` : 'Worker'),
            sessionId: resolveEventSessionId(event, instanceId),
            settings,
            coordinatorDaemonId: routing.coordinatorDaemonId || readNonEmptyString(settings.meshCoordinatorDaemonId),
            coordinatorSessionId: readNonEmptyString(settings.meshCoordinatorSessionId),
        });
    };
    if (!components.bus) {
        throw new Error('setupMeshEventForwarding requires components.bus');
    }
    return components.bus.on('provider_event', (e) => onProviderEvent(e.event), { name: 'mesh.forwarding' });
}
