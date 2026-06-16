// ---------------------------------------------------------------------------
// mesh-unresolved-forward-outbox — durable retry for unresolved-delegate forwards
// ---------------------------------------------------------------------------
// A REMOTE worker daemon that is P2P-remote-controlled by a coordinator is NOT a
// member of the coordinator's mesh — it has no local mesh record. So when its
// completion event reaches setupMeshEventForwarding, resolveWorkerDelegateRouting
// returns mesh_unresolved: the worker carries the coordinator daemon anchor but no
// resolvable mesh id, so the normal queue-then-coordinator-pull path can't be used
// (the coordinator's reconcile PHASE 1 only pulls mesh.nodes, and this worker is in
// none of them — see docs/refactoring/2026-06-16-mesh-completion-polling-single-model.md).
//
// The ONLY delivery route for this case is a directed push to the coordinator
// daemon (mesh_forward_event over P2P). Previously that push was fire-and-forget:
// a single dispatchMeshCommand whose rejection was only logged, so one transient
// P2P failure dropped the completion forever (delivery_unroutable).
//
// This outbox makes that push DURABLE without inventing a new persistence layer:
// it reuses the existing mesh_pending_events SQLite table (the same store every
// other mesh coordinator event is persisted to), under a synthetic, reserved
// "mesh id" namespace so it never collides with a real mesh's queue. The worker's
// reconcile tick (PHASE 0) peeks the outbox, pushes each entry to its coordinator,
// and marks it drained (acked) ONLY on a successful push — a failed push leaves the
// row undrained for the next tick. Entries that exceed a max age are expired so the
// outbox can't grow unbounded when a coordinator stays permanently unreachable.
//
// Idempotency:
//   - Enqueue is idempotent on the event fingerprint (mesh_pending_events has a
//     UNIQUE (mesh_id, fingerprint) index + INSERT OR IGNORE), so the same
//     completion fired twice on the worker queues once.
//   - The receiver dedups independently: handleMeshForwardEvent → injectMeshSystemMessage
//     → queuePendingMeshCoordinatorEvent recomputes the fingerprint and suppresses a
//     duplicate, so an at-least-once retry that double-delivers is harmless.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { buildPendingEventFingerprint, type PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { readNonEmptyString } from './mesh-events-utils.js';

// Reserved synthetic mesh id for the worker-side unresolved-forward outbox. The `::`
// and leading `__` make it impossible to collide with a real mesh id (which are
// `mesh_*` / `mreg_*` slugs). Scoping rows by coordinator_daemon_id inside this one
// namespace lets a single worker forward to multiple coordinators.
export const UNRESOLVED_FORWARD_OUTBOX_MESH_ID = '__unresolved_forward_outbox__';

// Entries older than this are expired (dropped) rather than retried forever — a
// coordinator that has been unreachable this long is treated as gone. Generous
// enough to ride out a long coordinator outage / restart, bounded enough that a
// permanently-dead coordinator can't accumulate outbox rows indefinitely.
const UNRESOLVED_FORWARD_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export interface UnresolvedForwardEntry {
    /** Row id in mesh_pending_events; pass back to ack/expire after a push attempt. */
    id: string;
    /** The coordinator daemon to push this event to (mesh_forward_event target). */
    coordinatorDaemonId: string;
    /** The flat payload to forward (already shaped for handleMeshForwardEvent). */
    payload: Record<string, unknown>;
    /** When the entry was first enqueued (epoch ms) — used for age-based expiry. */
    queuedAt: number;
}

function getStore(): MeshRuntimeStore | undefined {
    try { return MeshRuntimeStore.getInstance(); } catch { return undefined; }
}

/**
 * Durably enqueue an unresolved-delegate forward for a coordinator daemon. The
 * `forwardPayload` is the flat shape handleMeshForwardEvent reads on the coordinator.
 * Idempotent on the event fingerprint. Returns true when a new row was written (or a
 * duplicate was harmlessly ignored), false on a hard persistence failure.
 */
export function enqueueUnresolvedDelegateForward(
    coordinatorDaemonId: string,
    eventName: string,
    forwardPayload: Record<string, unknown>,
): boolean {
    const target = readNonEmptyString(coordinatorDaemonId);
    const event = readNonEmptyString(eventName);
    if (!target || !event) return false;
    const store = getStore();
    if (!store) return false;

    const queuedAt = Date.now();
    // Reuse the standard pending-event fingerprint so enqueue is idempotent AND the
    // receiver's own dedup keys on a comparable identity. We synthesise the minimal
    // PendingMeshCoordinatorEvent shape buildPendingEventFingerprint needs.
    const fingerprintSource: PendingMeshCoordinatorEvent = {
        event,
        meshId: UNRESOLVED_FORWARD_OUTBOX_MESH_ID,
        nodeLabel: readNonEmptyString(forwardPayload.nodeId) || readNonEmptyString(forwardPayload.workspace) || 'unresolved-delegate',
        nodeId: readNonEmptyString(forwardPayload.nodeId) || undefined,
        workspace: readNonEmptyString(forwardPayload.workspace) || undefined,
        metadataEvent: forwardPayload,
        queuedAt,
        targetCoordinatorDaemonId: target,
    };
    // Scope the fingerprint to the coordinator so two coordinators awaiting the same
    // worker session don't collapse into one outbox row.
    const fingerprint = `${target}::${buildPendingEventFingerprint(fingerprintSource)}`;

    try {
        const inserted = store.insertPendingEvent({
            id: randomUUID(),
            meshId: UNRESOLVED_FORWARD_OUTBOX_MESH_ID,
            coordinatorDaemonId: target,
            event,
            // Store the flat forward payload + the queue timestamp so the retry tick can
            // rebuild the push args and apply age-based expiry without a schema change.
            payload: { forwardPayload, coordinatorDaemonId: target, queuedAt },
            fingerprint,
            queuedAt,
        });
        if (inserted) {
            LOG.info('MeshEvents', `Durably queued unresolved-delegate ${event} for coordinator ${target} (outbox)`);
        }
        return true;
    } catch (e: any) {
        LOG.warn('MeshEvents', `Failed to persist unresolved-delegate forward to outbox: ${e?.message || e}`);
        return false;
    }
}

/** Peek (non-destructive) every undrained outbox entry across all coordinators. */
export function peekUnresolvedDelegateForwards(): UnresolvedForwardEntry[] {
    const store = getStore();
    if (!store) return [];
    let rows: Array<{ id: string; event: string; payload: unknown }>;
    try {
        rows = store.peekPendingEvents(UNRESOLVED_FORWARD_OUTBOX_MESH_ID);
    } catch {
        return [];
    }
    const out: UnresolvedForwardEntry[] = [];
    for (const row of rows) {
        const stored = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
        const coordinatorDaemonId = readNonEmptyString(stored.coordinatorDaemonId);
        const forwardPayload = stored.forwardPayload && typeof stored.forwardPayload === 'object'
            ? stored.forwardPayload as Record<string, unknown>
            : undefined;
        if (!coordinatorDaemonId || !forwardPayload) continue;
        const queuedAt = typeof stored.queuedAt === 'number' ? stored.queuedAt : 0;
        out.push({ id: row.id, coordinatorDaemonId, payload: forwardPayload, queuedAt });
    }
    return out;
}

/** Mark an outbox entry delivered (acked) after a successful push. */
export function ackUnresolvedDelegateForward(id: string): void {
    const store = getStore();
    if (!store) return;
    try { store.markPendingEventsDrainedById([id]); } catch { /* best-effort */ }
}

/**
 * Drop outbox entries that have exceeded the max retry age. Returns the count
 * expired so the caller can log a fail-loud trace (a dropped completion is a real
 * loss; it must be visible, not silent).
 */
export function expireStaleUnresolvedDelegateForwards(nowMs: number = Date.now()): number {
    const entries = peekUnresolvedDelegateForwards();
    const staleIds = entries
        .filter(e => e.queuedAt > 0 && nowMs - e.queuedAt >= UNRESOLVED_FORWARD_MAX_AGE_MS)
        .map(e => e.id);
    if (staleIds.length === 0) return 0;
    const store = getStore();
    if (!store) return 0;
    try {
        const removed = store.deletePendingEventsById(staleIds);
        if (removed > 0) {
            LOG.warn('MeshEvents', `Expired ${removed} unresolved-delegate forward(s) after ${Math.round(UNRESOLVED_FORWARD_MAX_AGE_MS / 60000)}m of failed retries — coordinator unreachable, completion dropped`);
        }
        return removed;
    } catch {
        return 0;
    }
}

/** Test helper: purge the entire outbox. */
export function __clearUnresolvedDelegateForwardOutboxForTests(): void {
    const store = getStore();
    if (!store) return;
    try { store.clearPendingEventsForMesh(UNRESOLVED_FORWARD_OUTBOX_MESH_ID); } catch { /* nothing to clear */ }
}
