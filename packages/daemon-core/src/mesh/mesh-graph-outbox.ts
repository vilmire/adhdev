/**
 * The graph outbox drain and its three consumer seams. Terminal transactions write
 * durable outbox rows (queue wake, gate awaiting / lapsed / expired, stopped
 * downstream); the drain pages each row once through the handler registered by
 * setupMeshEventForwarding, which owns DaemonComponents — so the graph engine never
 * imports dispatch or notification code itself.
 */
import { GRAPH_STOP_OUTBOX_KINDS, parseGraphStopOutbox, type MeshGraphStopNotice } from './mesh-graph-stop-notice.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { LOG } from '../logging/logger.js';

// ── Queue wake outbox drain (steps 8-9) ───────────────────────────────────────

/**
 * The post-commit wake rides the ORDINARY queue trigger — the graph engine never
 * dispatches directly (design :92-96). Registered by setupMeshEventForwarding,
 * which owns DaemonComponents; the runner deliberately never imports dispatch code.
 */
let queueWakeHandler: ((meshId: string) => void) | undefined;

export function registerMeshGraphQueueWakeHandler(handler: (meshId: string) => void): void {
    queueWakeHandler = handler;
}

/**
 * Coordinator-facing gate notification, drained from the graph outbox.
 * `graph_gate_awaiting` fires when upstream completion opens a gate;
 * `graph_gate_lease_expired` when a claimed gate's lease lapses without release.
 * Payload fields come straight from the outbox row's JSON payload.
 */
export interface MeshGraphGateNotification {
    kind: 'graph_gate_awaiting' | 'graph_gate_lease_expired' | 'graph_gate_deadline_expired';
    meshId: string;
    graphId: string;
    gateId: string;
    ref?: string;
    action?: string;
    instructions?: string;
    deadlineAt?: string;
    /** graph_gate_deadline_expired only: the gate's node id. */
    nodeId?: string;
    /** graph_gate_deadline_expired only: the on_timeout policy that fired. */
    policy?: string;
    /** graph_gate_deadline_expired only: ms the gate had been open when it expired. */
    ageMs?: number;
}

// Same seam as the queue-wake handler: an opened/lapsed gate previously wrote a
// durable outbox row that NOTHING consumed — the coordinator could only learn
// about it by polling mesh_graph_view, which the Monitor rules forbid. Measured
// live 2026-08-24: 7 gates sat awaiting_coordinator for 3 days, two of them for
// work that had already landed on main. setupMeshEventForwarding registers a
// handler that pages the coordinator through pendingCoordinatorEvents.
let gateNotifyHandler: ((notification: MeshGraphGateNotification) => void) | undefined;

export function registerMeshGraphGateNotifyHandler(handler: (notification: MeshGraphGateNotification) => void): void {
    gateNotifyHandler = handler;
}

// Stopped-downstream notices (graph_dependency_blocked / graph_dependency_cancelled,
// mesh-graph-stop-notice.ts). Same seam as the gate pages: the outbox row is
// written in the terminal transaction and paged once on drain.
let stopNotifyHandler: ((notice: MeshGraphStopNotice) => void) | undefined;

export function registerMeshGraphStopNotifyHandler(handler: (notice: MeshGraphStopNotice) => void): void {
    stopNotifyHandler = handler;
}

export function __resetMeshGraphTransitionRunnerForTests(): void {
    queueWakeHandler = undefined;
    gateNotifyHandler = undefined;
    stopNotifyHandler = undefined;
}

/**
 * Outbox kind → coordinator notice kind. `graph_gate_expired` is written ONLY by
 * the deadline sweep (a lease lapse never writes it), so paging on it is exactly
 * the D3(b) "deadline expired" notice — once per expiry, because a drained row
 * is marked delivered and an expired gate is not re-swept until reclaimed.
 */
const GATE_NOTIFY_OUTBOX_KINDS = new Map<string, MeshGraphGateNotification['kind']>([
    ['graph_gate_awaiting', 'graph_gate_awaiting'],
    ['graph_gate_lease_expired', 'graph_gate_lease_expired'],
    ['graph_gate_expired', 'graph_gate_deadline_expired'],
]);

function toGateNotification(kind: string, meshId: string, rawPayload: string | null | undefined): MeshGraphGateNotification | null {
    const noticeKind = GATE_NOTIFY_OUTBOX_KINDS.get(kind);
    if (!noticeKind) return null;
    let payload: Record<string, unknown> = {};
    try {
        const parsed = rawPayload ? JSON.parse(rawPayload) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch { /* malformed payload → notify with ids we have */ }
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined);
    const gateId = str(payload.gateId);
    const graphId = str(payload.graphId);
    if (!gateId || !graphId) return null;
    const ageMs = typeof payload.ageMs === 'number' && Number.isFinite(payload.ageMs) ? payload.ageMs : undefined;
    return {
        kind: noticeKind,
        meshId,
        graphId,
        gateId,
        ref: str(payload.ref),
        action: str(payload.action),
        instructions: str(payload.instructions),
        deadlineAt: str(payload.deadlineAt),
        ...(noticeKind === 'graph_gate_deadline_expired' ? {
            ...(str(payload.nodeId) ? { nodeId: str(payload.nodeId) } : {}),
            ...(str(payload.policy) ? { policy: str(payload.policy) } : {}),
            ...(ageMs !== undefined ? { ageMs } : {}),
        } : {}),
    };
}

/**
 * Step 9 — drain pending graph outbox rows AFTER the state-change transaction
 * committed. `queue_wake` events invoke the registered wake handler; gate
 * awaiting/lease-expired events page the coordinator through the registered
 * gate-notify handler (→ pendingCoordinatorEvents). Every other kind is a
 * durable notification record consumed by pull surfaces (mesh_graph_view,
 * ledger) — draining marks it delivered so it is never double-fired.
 * Best-effort per row: a failing wake leaves the row pending with a retry stamp.
 */
export function drainMeshGraphOutbox(meshId: string): number {
    const store = MeshRuntimeStore.getInstance();
    const graphStore = store.graphStore();
    const pending = graphStore.listPendingOutboxEvents(meshId);
    let drained = 0;
    for (const event of pending) {
        const nowIso = new Date().toISOString();
        try {
            if (event.kind === 'queue_wake') {
                if (queueWakeHandler) queueWakeHandler(event.meshId);
                // No handler registered (e.g. a daemon without event forwarding): the
                // reconcile loop's periodic triggerMeshQueue covers the wake — the row
                // is still marked delivered so it cannot accumulate forever.
            } else if (GATE_NOTIFY_OUTBOX_KINDS.has(event.kind)) {
                const notification = toGateNotification(event.kind, event.meshId, event.payload);
                if (notification && gateNotifyHandler) gateNotifyHandler(notification);
                // No handler / unparsable payload: mark delivered anyway — the gate
                // remains visible in mesh_graph_view (nextCoordinatorAction) and the
                // reconcile deadline sweep still governs its timeout policy.
            } else if ((GRAPH_STOP_OUTBOX_KINDS as readonly string[]).includes(event.kind)) {
                const notice = parseGraphStopOutbox(event.kind, event.meshId, event.payload);
                if (notice && stopNotifyHandler) stopNotifyHandler(notice);
                // No handler / malformed: delivered anyway — the durable row stays
                // readable, and the stall sweep still pages a graph that cannot move.
            }
            graphStore.markOutboxEventStatus(event.id, 'delivered', nowIso);
            drained += 1;
        } catch (e: any) {
            try {
                graphStore.markOutboxEventStatus(event.id, 'pending', nowIso, {
                    incrementAttempt: true,
                    nextAttemptAtMs: Date.now() + 5_000,
                });
            } catch { /* bookkeeping must never throw past the drain */ }
            LOG.warn('MeshGraph', `Graph outbox drain failed for ${event.kind} ${event.id} (mesh ${meshId}): ${e?.message || e}`);
        }
    }
    return drained;
}
