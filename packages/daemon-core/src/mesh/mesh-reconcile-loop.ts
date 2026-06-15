// ---------------------------------------------------------------------------
// mesh-reconcile-loop — periodic queue → live coordinator reconciliation
// ---------------------------------------------------------------------------
// Single-model replacement for the old event-based "spontaneous forward" paths
// (remote P2P mesh_forward_event dispatch + live-CLI PTY fire-and-forget inject).
// Those pushed events at the moment a worker transitioned state, and silently
// dropped on the network (P2P) or when the coordinator was generating.
//
// The reliable backbone has always been the pending-events queue (SQLite +
// JSONL): every mesh coordinator event is persisted there before anything else
// (see injectMeshSystemMessage). What was missing was an *active* drainer that
// runs on a schedule rather than only when the coordinator (an LLM) happens to
// call a mesh tool.
//
// This loop is that drainer. On a fixed interval it:
//   1. Finds live CLI coordinator sessions on THIS daemon (meshCoordinatorFor
//      stamp). For each mesh, drains the local queue scoped to this daemon and
//      injects pending events into the coordinator. When a coordinator is idle it
//      receives every queued event. When ONLY generating coordinators exist (the
//      common case while the coordinator is blocked awaiting a worker result), the
//      loop force-drains ONLY the force-inject events (completion / approval / stop /
//      refine·bootstrap terminal) and force-writes them into the generating PTY —
//      the same busy-bypass send-guard escape the live-CLI inject used to use.
//      Non-force progress events stay queued for the next idle tick (injecting them
//      mid-generation would be noise). This is what makes a coordinator parked in
//      `generating` while awaiting a worker's completion actually receive it.
//   2. In cloud mode (dispatchMeshCommand present), pulls each remote worker
//      node daemon's queue over P2P (get_pending_mesh_events) and re-injects via
//      handleMeshForwardEvent — the same pull the MCP drainCoordinatorPendingEvents
//      already does, now driven by the daemon timer instead of an LLM tool call.
//
// IMPORTANT — limits of this loop:
//   - It only delivers to *live CLI coordinator instances* on this daemon. A
//     pure stdio MCP coordinator (an LLM with no live CLI session to inject
//     into) has no inject target here; that case stays pull-driven — the LLM
//     drains the queue when it calls mesh_status / mesh_read_chat. We do NOT try
//     to "wake" an LLM from the daemon; that is structurally impossible over a
//     stdio request/response transport. See docs/refactoring/2026-06-15-mesh-event-to-queue-polling.md §4.7.
//   - Queue persistence (queuePendingMeshCoordinatorEvent) and the SQLite
//     drained=1 idempotency are the trust backbone and are untouched by this loop.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { listMeshes } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { handleMeshForwardEvent, shouldForceInjectMeshEvent, MESH_FORCE_INJECT_EVENTS } from './mesh-events-coordinator.js';
import { readNonEmptyString } from './mesh-events-utils.js';

// Default reconcile cadence. approval/completion notifications to a live CLI
// coordinator land within at most one interval. Overridable via env for tuning.
const DEFAULT_RECONCILE_INTERVAL_MS = 4_000;

function resolveReconcileIntervalMs(): number {
    const raw = readNonEmptyString(process.env.MESH_RECONCILE_INTERVAL_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 60_000) return parsed;
    }
    return DEFAULT_RECONCILE_INTERVAL_MS;
}

interface LiveCoordinator {
    meshId: string;
    instance: ReturnType<DaemonComponents['instanceManager']['getInstance']>;
    idle: boolean;
}

// The set of coordinator-daemon ids THIS daemon answers to when draining the
// pending-events queue. A unicast completion event is stamped with the worker's
// meshCoordinatorDaemonId, which can be either:
//   - the daemon's canonical status id (`standalone_<machineId>` / `daemon_<machineId>`),
//     stamped by the MCP layer via ctx.localDaemonId (= getStatus().status.instanceId), or
//   - the bare machineId, stamped by the local queue-assignment path (loadConfig().machineId).
// Draining with only one of these silently misses events stamped with the other —
// the exact reason a generating coordinator never self-received local completions.
// We accept BOTH so the drain matches regardless of which path stamped the event.
function resolveCoordinatorDaemonIds(components: DaemonComponents): string[] {
    const ids = new Set<string>();
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    if (statusInstanceId) ids.add(statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    if (machineId) ids.add(machineId);
    return [...ids];
}

// Find live CLI coordinator instances on THIS daemon, keyed by mesh.
function findLiveCoordinators(components: DaemonComponents): LiveCoordinator[] {
    const out: LiveCoordinator[] = [];
    for (const inst of components.instanceManager.getByCategory('cli')) {
        const state = inst.getState();
        const settings = state.settings && typeof state.settings === 'object'
            ? state.settings as Record<string, unknown>
            : {};
        const meshId = readNonEmptyString(settings.meshCoordinatorFor);
        if (!meshId) continue;
        const status = readNonEmptyString(state.status).toLowerCase();
        out.push({ meshId, instance: inst, idle: status === 'idle' });
    }
    return out;
}

// Inject a drained pending event into a live coordinator session. Force-inject
// events carry force:true so they bypass the busy send-guard and land in the PTY
// even while the coordinator is generating (see shouldForceInjectMeshEvent).
function injectPendingIntoCoordinator(
    coordinator: LiveCoordinator['instance'],
    pending: PendingMeshCoordinatorEvent,
): void {
    if (!coordinator || !pending.coordinatorMessage) return;
    const force = shouldForceInjectMeshEvent(pending.event);
    coordinator.onEvent('send_message', {
        input: { text: pending.coordinatorMessage, textFallback: pending.coordinatorMessage },
        ...(force ? { force: true } : {}),
    });
}

// One reconcile tick across every mesh that has a live CLI coordinator here.
export async function runMeshReconcileTick(components: DaemonComponents): Promise<void> {
    const coordinators = findLiveCoordinators(components);
    if (coordinators.length === 0) {
        // No live CLI coordinator on this daemon — nothing to inject into.
        // (MCP-only LLM coordinators drain the queue via their own tool calls.)
        return;
    }

    // Group coordinators by mesh; multiple coordinator instances for one mesh is
    // unusual but supported (each gets the same drained events).
    const byMesh = new Map<string, LiveCoordinator[]>();
    for (const c of coordinators) {
        const list = byMesh.get(c.meshId);
        if (list) list.push(c);
        else byMesh.set(c.meshId, [c]);
    }

    const localDaemonId = readNonEmptyString(loadConfig().machineId) || undefined;
    // The id-set used to scope the local queue drain (status id + machineId). See
    // resolveCoordinatorDaemonIds — the status id is what the MCP layer stamps and
    // is mandatory here for a generating CLI coordinator to self-receive completions.
    const drainDaemonIds = resolveCoordinatorDaemonIds(components);
    const dispatchMeshCommand = components.dispatchMeshCommand;
    const store = (() => {
        try { return MeshRuntimeStore.getInstance(); } catch { return undefined; }
    })();

    for (const [meshId, meshCoordinators] of byMesh) {
        // (a) Cloud-only: pull remote worker node daemons' queues over P2P and
        //     re-inject locally. This is the same cross-daemon pull the MCP
        //     drainCoordinatorPendingEvents performs, lifted to the daemon timer.
        //     On standalone (no dispatchMeshCommand) this whole block is skipped,
        //     keeping cloud/standalone identical for the local case.
        if (dispatchMeshCommand) {
            try {
                await pullRemoteNodeQueues(components, meshId, localDaemonId);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Remote node pull failed for mesh ${meshId}: ${e?.message || e}`);
            }
        }

        // (b) Drain the local queue scoped to this coordinator daemon and inject.
        //     - If an idle coordinator exists, FULL-drain and deliver every event to it
        //       (it can receive non-force progress events without deadlocking).
        //     - If only GENERATING coordinators exist, force-drain ONLY the force-inject
        //       events (completion/approval/stop/refine·bootstrap terminal) and force-inject
        //       them so a coordinator parked in `generating` while awaiting that very event
        //       is not deadlocked. Non-force progress events stay queued for the next idle
        //       tick — injecting them would be noise mid-generation. Both drains mark the
        //       consumed rows drained=1 atomically, so the pull path can't re-deliver.
        const idleCoordinators = meshCoordinators.filter(c => c.idle);
        const generatingCoordinators = meshCoordinators.filter(c => !c.idle);
        const targetCoordinators = idleCoordinators.length > 0 ? idleCoordinators : generatingCoordinators;
        const forceOnly = idleCoordinators.length === 0;

        // O(1) guard: skip the drain entirely when the queue is empty.
        if (store) {
            try {
                if (store.pendingEventCount(meshId) === 0) continue;
            } catch { /* fall through to drain */ }
        }

        let pendingEvents: PendingMeshCoordinatorEvent[] = [];
        try {
            pendingEvents = drainPendingMeshCoordinatorEvents(
                meshId,
                drainDaemonIds.length > 0 ? drainDaemonIds : localDaemonId,
                forceOnly ? { onlyEvents: MESH_FORCE_INJECT_EVENTS } : undefined,
            );
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Drain failed for mesh ${meshId}: ${e?.message || e}`);
            continue;
        }
        if (pendingEvents.length === 0) continue;

        const mode = forceOnly ? 'force-drain → generating' : 'inject → idle';
        LOG.info('MeshReconcile', `Reconcile ${mode}: ${pendingEvents.length} pending event(s) → ${targetCoordinators.length} coordinator(s) for mesh ${meshId}`);
        for (const pending of pendingEvents) {
            for (const c of targetCoordinators) {
                injectPendingIntoCoordinator(c.instance, pending);
            }
        }
    }
}

// Cloud-only: poll each remote worker node daemon for pending coordinator events
// and re-inject them locally via handleMeshForwardEvent (which re-queues +
// surfaces to the live coordinator on the next tick / immediately if idle).
async function pullRemoteNodeQueues(
    components: DaemonComponents,
    meshId: string,
    localDaemonId: string | undefined,
): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;
    const mesh = listMeshes().find(m => m.id === meshId);
    if (!mesh) return;

    const pendingEventArgs: Record<string, unknown> = {
        meshId,
        ...(localDaemonId ? { coordinatorDaemonId: localDaemonId } : {}),
    };

    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        // Skip nodes without a daemon, and nodes on THIS daemon (their events are
        // already in the local queue drained in step (b)).
        if (!nodeDaemonId) continue;
        if (localDaemonId && nodeDaemonId === localDaemonId) continue;

        let events: unknown;
        try {
            events = await dispatchMeshCommand(nodeDaemonId, 'get_pending_mesh_events', pendingEventArgs);
        } catch {
            // Remote pull is best-effort; the node may be offline. Retry next tick.
            continue;
        }
        const list = extractPendingEvents(events).filter(e => readNonEmptyString(e?.meshId) === meshId);
        for (const event of list) {
            const payload = buildForwardPayloadFromPending(event);
            if (!payload.event || !payload.meshId) continue;
            try {
                handleMeshForwardEvent(components, payload);
            } catch { /* best-effort re-inject */ }
        }
    }
}

function extractPendingEvents(raw: unknown): any[] {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
        const events = (raw as Record<string, unknown>).events;
        if (Array.isArray(events)) return events;
    }
    return [];
}

// Flatten a queued PendingMeshCoordinatorEvent into the flat payload shape
// handleMeshForwardEvent expects (mirrors the MCP buildMeshForwardPayloadFromPendingEvent).
function buildForwardPayloadFromPending(event: any): Record<string, unknown> {
    const metadata = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : {};
    return {
        event: readNonEmptyString(event?.event),
        meshId: readNonEmptyString(event?.meshId),
        nodeId: readNonEmptyString(event?.nodeId) || readNonEmptyString(metadata.meshNodeId),
        workspace: readNonEmptyString(event?.workspace) || readNonEmptyString(metadata.workspace),
        ...metadata,
    };
}

interface ReconcileLoopHandle {
    stop(): void;
}

// Start the periodic reconcile loop. Returns a handle with stop() for shutdown.
export function setupMeshReconcileLoop(components: DaemonComponents): ReconcileLoopHandle {
    const intervalMs = resolveReconcileIntervalMs();
    let running = false;
    const timer = setInterval(() => {
        if (running) return; // never overlap ticks
        running = true;
        void runMeshReconcileTick(components)
            .catch((e: any) => LOG.warn('MeshReconcile', `Reconcile tick error: ${e?.message || e}`))
            .finally(() => { running = false; });
    }, intervalMs);
    // Don't keep the process alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
    LOG.info('MeshReconcile', `Mesh reconcile loop started (interval ${intervalMs}ms)`);
    return {
        stop() {
            clearInterval(timer);
            LOG.info('MeshReconcile', 'Mesh reconcile loop stopped');
        },
    };
}
