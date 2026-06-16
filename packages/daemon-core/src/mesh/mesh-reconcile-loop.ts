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
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { loadConfig } from '../config/config.js';
import { listMeshes } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { handleMeshForwardEvent, shouldForceInjectMeshEvent, MESH_FORCE_INJECT_EVENTS } from './mesh-events-coordinator.js';
import {
    peekUnresolvedDelegateForwards,
    ackUnresolvedDelegateForward,
    expireStaleUnresolvedDelegateForwards,
} from './mesh-unresolved-forward-outbox.js';
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

// Whether THIS daemon is the coordinator/host for a mesh — i.e. the daemon that
// owns coordinator ownership and must collect every worker node's completion
// events into its local queue. This is true regardless of whether a *live CLI*
// coordinator session currently exists: the coordinator is frequently a pure
// stdio MCP LLM (no live CLI session to inject into), and that LLM only sees the
// queue when it next calls a mesh tool. For it to see remote worker completions
// at all, the daemon must have already pulled them into the local queue on the
// timer — which is exactly what this predicate gates.
//
// Rule: this daemon hosts the mesh when meshHost.role is 'host' (the default for
// standalone-compat meshes with no host metadata) AND, when a hostDaemonId is
// pinned, it resolves to one of this daemon's ids. Member-only daemons return
// false — their own queue is pulled BY the host, not the other way around.
//
// `daemonIds` here is the EXPANDED self-identity set (runtime drain ids ∪ this
// daemon's mesh-config node id forms) — see resolveCoordinatorSelfIds. The
// pinned hostDaemonId is itself a config-form id and frequently does NOT equal a
// runtime id (bare machineId / status id), so gating on the runtime ids alone
// would wrongly classify the real host as a non-host and skip the remote pull
// entirely.
function daemonHostsMesh(mesh: LocalMeshEntry, daemonIds: string[]): boolean {
    const host = mesh.meshHost;
    // No metadata → default host (standalone compatibility, see createDefaultMeshHostMetadata).
    if (!host) return true;
    if (host.role && host.role !== 'host') return false;
    const hostDaemonId = readNonEmptyString(host.hostDaemonId);
    // Host role but no pinned hostDaemonId → treat as host (single-daemon / legacy).
    if (!hostDaemonId) return true;
    return daemonIds.includes(hostDaemonId);
}

// Resolve EVERY id-form this daemon answers to FOR A GIVEN MESH: the runtime drain
// ids (status id + bare machineId) unioned with this daemon's mesh-config identity
// forms — the self node's daemonId/machineId (the node whose daemonId/machineId
// matches a runtime id) and the pinned meshHost.hostDaemonId WHEN it is provably
// ours. This is the single source of truth for "is this id me?" across both the
// host gate and the remote pull filter; the worker's meshCoordinatorDaemonId stamp
// is guaranteed to be one of these forms (it comes from resolveCoordinatorDaemonId,
// which prefers the coordinator node's config-form daemonId over the runtime status id).
function resolveCoordinatorSelfIds(mesh: LocalMeshEntry, drainDaemonIds: string[]): string[] {
    const ids = new Set<string>(drainDaemonIds);
    // Expand with the config-form id(s) of the self node — the mesh node whose
    // daemonId/machineId matches a runtime id. Its config-form daemonId is exactly
    // what resolveCoordinatorNode()→resolveCoordinatorDaemonId() stamps onto a worker.
    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        const nodeMachineId = readNonEmptyString(node.machineId);
        const isSelf = (nodeDaemonId && drainDaemonIds.includes(nodeDaemonId))
            || (nodeMachineId && drainDaemonIds.includes(nodeMachineId));
        if (!isSelf) continue;
        if (nodeDaemonId) ids.add(nodeDaemonId);
        if (nodeMachineId) ids.add(nodeMachineId);
    }
    // The pinned host id is included ONLY when it is provably one of THIS daemon's ids
    // (it already matches a runtime id or a resolved self-node id). A hostDaemonId that
    // names a DIFFERENT daemon must NOT be claimed — that would make a member-only
    // daemon believe it is the host and pull queues it does not own. Having a node on
    // this daemon does not make this daemon the host; daemonHostsMesh still honours a
    // foreign hostDaemonId and rejects ownership.
    const hostDaemonId = readNonEmptyString(mesh.meshHost?.hostDaemonId);
    if (hostDaemonId && ids.has(hostDaemonId)) ids.add(hostDaemonId);
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

// One reconcile tick. Two independent phases:
//
//   PHASE 1 — Remote queue pull (the fix for remote worktree completions never
//     reaching an MCP/LLM coordinator). For EVERY mesh this daemon hosts/
//     coordinates, pull each remote worker node's pending-events queue over P2P
//     into THIS daemon's local queue. This runs *regardless of whether a live CLI
//     coordinator exists* — the coordinator is usually a pure stdio MCP LLM with
//     no live CLI session, and it can only observe a remote worker's completion
//     once that event has been pulled into the local queue (which it then drains
//     on its next mesh tool call). Previously this pull was gated behind a live
//     CLI coordinator and so never ran for MCP/LLM coordinators — remote
//     completions sat on the remote node's queue until the LLM happened to call
//     mesh_read_chat, which triggered the MCP-side pull. The daemon now does it
//     autonomously on the timer. Standalone (no dispatchMeshCommand) skips this
//     phase entirely — there are no remote nodes to pull from.
//
//   PHASE 2 — Live CLI inject. For each mesh that has a live CLI coordinator on
//     THIS daemon, drain the local queue and inject pending events into the PTY.
//     Unchanged from before.
export async function runMeshReconcileTick(components: DaemonComponents): Promise<void> {
    const localDaemonId = readNonEmptyString(loadConfig().machineId) || undefined;
    // The id-set used to scope the local queue drain (status id + machineId). See
    // resolveCoordinatorDaemonIds — the status id is what the MCP layer stamps and
    // is mandatory here for a generating CLI coordinator to self-receive completions.
    const drainDaemonIds = resolveCoordinatorDaemonIds(components);
    const dispatchMeshCommand = components.dispatchMeshCommand;
    const store = (() => {
        try { return MeshRuntimeStore.getInstance(); } catch { return undefined; }
    })();

    // ── PHASE 0: retry the worker-side unresolved-delegate forward outbox ──────
    // Cloud-only (needs dispatchMeshCommand). A worker that is NOT a member of the
    // coordinator's mesh cannot be reached by the coordinator's PHASE 1 pull (it is
    // in no mesh.node), so its completion must be PUSHED to the coordinator. This
    // drains the durable outbox enqueued by forwardUnresolvedDelegateEvent and retries
    // any push that has not yet been acked. See mesh-unresolved-forward-outbox.ts.
    if (dispatchMeshCommand) {
        try {
            await retryUnresolvedDelegateForwards(components);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Unresolved-delegate forward retry failed: ${e?.message || e}`);
        }
    }

    // ── PHASE 1: pull remote node queues for every mesh this daemon hosts ──────
    // Cloud-only (dispatchMeshCommand present). Runs whether or not a live CLI
    // coordinator exists — this is what lets an MCP/LLM coordinator ever see a
    // remote worker's completion.
    if (dispatchMeshCommand) {
        for (const mesh of listMeshes()) {
            // Expand to every id-form this daemon answers to for this mesh (runtime
            // drain ids ∪ config-form node/host ids) and use it for BOTH the host gate
            // and the remote pull filter, so a worker stamp in any form is recovered.
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await pullRemoteNodeQueues(components, mesh, localDaemonId, selfIds);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Remote node pull failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 2: inject into live CLI coordinators on this daemon ──────────────
    const coordinators = findLiveCoordinators(components);
    if (coordinators.length === 0) {
        // No live CLI coordinator on this daemon — nothing to inject into.
        // (MCP-only LLM coordinators drain the local queue via their own tool
        //  calls; PHASE 1 above has already populated it from remote nodes.)
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

    for (const [meshId, meshCoordinators] of byMesh) {
        // Drain the local queue scoped to this coordinator daemon and inject.
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

// Cloud-only: retry the worker-side unresolved-delegate forward outbox. For each
// durably-queued entry, push it to its coordinator daemon over P2P (mesh_forward_event)
// and ack (mark drained) ONLY on a successful, non-rejected response. A failed or
// rejected push leaves the entry queued for the next tick — at-least-once delivery.
// Stale entries (coordinator unreachable past the max age) are expired first so the
// outbox can't grow without bound. The coordinator dedups duplicate deliveries on its
// own fingerprint, so a retry that races the original immediate push is harmless.
async function retryUnresolvedDelegateForwards(components: DaemonComponents): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;

    // Drop entries that have exhausted their retry budget (fail-loud inside).
    expireStaleUnresolvedDelegateForwards();

    const entries = peekUnresolvedDelegateForwards();
    if (entries.length === 0) return;

    for (const entry of entries) {
        let result: any;
        try {
            result = await dispatchMeshCommand(entry.coordinatorDaemonId, 'mesh_forward_event', entry.payload);
        } catch (e: any) {
            // Coordinator unreachable — keep the entry queued and try again next tick.
            LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} failed: ${e?.message || e} — left queued`);
            continue;
        }
        if (result && result.success === false) {
            LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} rejected (${readNonEmptyString(result.error) || 'no reason'}) — left queued`);
            continue;
        }
        // Acked — mark the durable copy delivered.
        ackUnresolvedDelegateForward(entry.id);
        LOG.info('MeshReconcile', `Retried+delivered unresolved-delegate ${readNonEmptyString(entry.payload.event)} to coordinator ${entry.coordinatorDaemonId}`);
    }
}

// Cloud-only: poll each remote worker node daemon for pending coordinator events
// and re-inject them locally via handleMeshForwardEvent (which re-queues +
// surfaces to the live coordinator on the next tick / immediately if idle).
//
// Scoping: the remote handler (get_pending_mesh_events) drains its queue filtered
// by coordinatorDaemonId — returning events targeted at that id OR unscoped, and
// leaving events targeted at a *different* coordinator. A remote worker stamps the
// coordinator id in one of SEVERAL forms (the canonical status id `standalone_`/
// `daemon_<machineId>` stamped by the MCP layer, the bare machineId stamped by the
// local queue path, OR — most commonly for remote launches — the coordinator mesh
// node's config-form `daemonId`, which resolveCoordinatorDaemonId prefers and which
// is NOT canonicalised). `candidateDaemonIds` is the already-expanded self-identity
// set (resolveCoordinatorSelfIds: runtime drain ids ∪ this daemon's mesh-config node/
// host id forms), so we pull ONCE PER candidate id and a completion stamped with any
// of them is recovered. The remote drain is atomic (drained=1), so issuing multiple
// pulls cannot double-deliver — the first pull that matches consumes the event; the
// rest see nothing. When no ids resolve we fall back to a single unscoped pull.
async function pullRemoteNodeQueues(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    localDaemonId: string | undefined,
    candidateDaemonIds: string[],
): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;
    const meshId = mesh.id;

    // One args object per candidate coordinator-id form, or a single unscoped pull
    // when none resolve.
    const pulls: Array<Record<string, unknown>> = candidateDaemonIds.length > 0
        ? candidateDaemonIds.map(id => ({ meshId, coordinatorDaemonId: id }))
        : [{ meshId }];

    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        // Skip nodes without a daemon, and nodes on THIS daemon (their events are
        // already in the local queue drained in PHASE 2). "This daemon" is matched
        // against the full self-identity set (candidateDaemonIds), not just the bare
        // localDaemonId — a self node can be registered under the config-form daemonId
        // (`daemon_<machineId>`) which would NOT equal bare localDaemonId, and pulling
        // from ourselves over P2P is both wasteful and a self-dispatch hazard.
        if (!nodeDaemonId) continue;
        if (localDaemonId && nodeDaemonId === localDaemonId) continue;
        if (candidateDaemonIds.includes(nodeDaemonId)) continue;

        for (const pendingEventArgs of pulls) {
            let events: unknown;
            try {
                events = await dispatchMeshCommand(nodeDaemonId, 'get_pending_mesh_events', pendingEventArgs);
            } catch {
                // Remote pull is best-effort; the node may be offline. Retry next tick.
                break; // node unreachable — don't bother with the other id form this tick.
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
