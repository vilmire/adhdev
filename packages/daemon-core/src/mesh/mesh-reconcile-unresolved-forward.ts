// ---------------------------------------------------------------------------
// mesh-reconcile-unresolved-forward — worker-side forward outbox retry (PHASE 0)
// ---------------------------------------------------------------------------
// Pure move out of mesh-reconcile-loop.ts (no behavior change). Cloud-only
// delivery path for a worker that is NOT a member of the coordinator's mesh: it
// cannot be reached by the coordinator's PHASE 1 pull, so its completion must be
// PUSHED. This module owns that push:
//
//   • retryUnresolvedDelegateForwards — drains the durable outbox, routes a
//     self-addressed entry through the local router, recovers a missing meshId,
//     and bounds hard rejections (MAX_FORWARD_REJECTIONS) so a deterministically
//     refused payload cannot retry until the age expiry;
//   • the coalesced/non-overlapping nudge timer the enqueue site fires so the
//     retry runs early instead of waiting for the next periodic tick.
//
// The tick calling the retry (PHASE 0) and the loop setup registering the nudge
// stay in mesh-reconcile-loop.ts.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { LOG } from '../logging/logger.js';
import {
    peekUnresolvedDelegateForwards,
    ackUnresolvedDelegateForward,
    expireStaleUnresolvedDelegateForwards,
} from './mesh-unresolved-forward-outbox.js';
import { handleMeshForwardEvent, resolveForwardEventMeshId } from './mesh-events-coordinator.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { daemonIdsEquivalent, withStatusProbeMarker } from '@adhdev/mesh-shared';
import { resolveCoordinatorDaemonIds } from './mesh-reconcile-identity.js';

// Cloud-only: retry the worker-side unresolved-delegate forward outbox. For each
// durably-queued entry, push it to its coordinator daemon over P2P (mesh_forward_event)
// and ack (mark drained) ONLY on a successful, non-rejected response. A failed or
// rejected push leaves the entry queued for the next tick — at-least-once delivery.
// Stale entries (coordinator unreachable past the max age) are expired first so the
// outbox can't grow without bound. The coordinator dedups duplicate deliveries on its
// own fingerprint, so a retry that races the original immediate push is harmless.
// RECONCILE-MESHID-DROP: per-entry count of consecutive HARD rejections (the coordinator
// returned success:false, e.g. "meshId required"). A rejection means the push was delivered
// and deterministically refused — retrying the identical payload every 4s can never succeed,
// so it would loop until the 30-minute age expiry, spamming the log the whole time. After
// MAX_FORWARD_REJECTIONS such rejections we drop the entry (drain it) with ONE fail-loud
// warning. Transient transport failures (the dispatch throws — coordinator momentarily
// unreachable) do NOT count here; those legitimately retry until the age expiry. In-memory
// (keyed by the durable outbox row id) is sufficient: a daemon restart re-arms the loop, and
// the age expiry remains the durable backstop. Cleared whenever an entry is delivered/drained.
const unresolvedForwardRejectionCounts = new Map<string, number>();
const MAX_FORWARD_REJECTIONS = 5;

export function __resetUnresolvedForwardRejectionCountsForTests(): void {
    unresolvedForwardRejectionCounts.clear();
}

// ── Unresolved-forward reconcile nudge (polling single-model §2.1 (B)) ────────
// forwardUnresolvedDelegateEvent no longer pushes the event itself — it only
// persists to the durable outbox and fires a data-free nudge asking THIS loop to
// run the PHASE 0 retry soon. The nudge is:
//   - coalesced: one pending timer at a time, so a completion burst schedules a
//     single early retry pass instead of one per event;
//   - non-overlapping: skipped while a nudged pass is still in flight (the
//     periodic tick remains the backstop);
//   - loss-tolerant: an unregistered/cleared/failed nudge merely means delivery
//     waits for the next periodic tick (≤ one reconcile interval) — never a loss.
const UNRESOLVED_FORWARD_NUDGE_DELAY_MS = 250;
let unresolvedForwardNudgeTimer: NodeJS.Timeout | undefined;
let unresolvedForwardNudgeRunning = false;


export function scheduleUnresolvedForwardNudge(components: DaemonComponents): void {
    if (!components.dispatchMeshCommand) return; // no transport → periodic tick handles/no-ops
    if (unresolvedForwardNudgeTimer) return;     // coalesce a burst into one early pass
    unresolvedForwardNudgeTimer = setTimeout(() => {
        unresolvedForwardNudgeTimer = undefined;
        if (unresolvedForwardNudgeRunning) return; // an earlier pass is in flight — tick covers
        unresolvedForwardNudgeRunning = true;
        void retryUnresolvedDelegateForwards(components)
            .catch((e: any) => LOG.warn('MeshReconcile', `Nudged unresolved-forward retry failed: ${e?.message || e}`))
            .finally(() => { unresolvedForwardNudgeRunning = false; });
    }, UNRESOLVED_FORWARD_NUDGE_DELAY_MS);
    // Never keep the process alive solely for a pending nudge.
    if (typeof unresolvedForwardNudgeTimer.unref === 'function') unresolvedForwardNudgeTimer.unref();
}

export function clearUnresolvedForwardNudge(): void {
    if (unresolvedForwardNudgeTimer) {
        clearTimeout(unresolvedForwardNudgeTimer);
        unresolvedForwardNudgeTimer = undefined;
    }
}

export async function retryUnresolvedDelegateForwards(components: DaemonComponents): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;

    // Drop entries that have exhausted their retry budget (fail-loud inside).
    expireStaleUnresolvedDelegateForwards();

    const entries = peekUnresolvedDelegateForwards();
    if (entries.length === 0) {
        // Nothing queued — clear any stale per-entry rejection counters so the map can't grow.
        if (unresolvedForwardRejectionCounts.size > 0) unresolvedForwardRejectionCounts.clear();
        return;
    }

    // Every id-form THIS daemon answers to. A self-addressed outbox entry (coordinator
    // == this daemon) must never be cross-dialled — see the self-route branch below.
    const selfIds = resolveCoordinatorDaemonIds(components);
    const isSelfCoordinatorId = (id: string): boolean =>
        selfIds.some(self => daemonIdsEquivalent(self, id));

    for (const entry of entries) {
        // EVTTRACE correlation context for this outbox entry's retry.
        const entryTraceCtx = {
            taskId: (entry.payload as Record<string, unknown>).taskId,
            sessionId: readNonEmptyString(entry.payload.targetSessionId) || readNonEmptyString(entry.payload.sessionId),
            nodeId: readNonEmptyString(entry.payload.nodeId),
            event: readNonEmptyString(entry.payload.event),
        };

        // Self-addressed forward: the coordinator daemon this entry targets IS this
        // daemon (a self-coordinating / single-node mesh, or a delegate whose coordinator
        // anchor resolved to our own id). A cross-daemon mesh_forward_event to our own id
        // is REFUSED by the dispatch self-dial guard ("Refusing to send ... to this
        // daemon's own id; route via the local router instead") on every retry, so the
        // entry can never be acked and loops forever (~every tick), spamming the log and
        // pinning the outbox row permanently undrained. Honour the guard's own advice:
        // route the event straight through the local receiver (handleMeshForwardEvent —
        // the same path the coordinator runs on receiving a remote push), then ack it.
        // We drain regardless of the local result: a cross-daemon dispatch could not have
        // resolved it either (the guard rejects before the receiver ever runs), so leaving
        // it queued only re-spams. handleMeshForwardEvent has the BEST recovery chance —
        // this daemon hosts the mesh, so its workspace/nodeId → meshId recovery applies.
        if (isSelfCoordinatorId(entry.coordinatorDaemonId)) {
            let localResult: any;
            try {
                traceMeshEventStage('forward_send', entryTraceCtx, `self → local router (${entry.coordinatorDaemonId})`);
                localResult = handleMeshForwardEvent(components, entry.payload);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Local route of self-addressed forward to ${entry.coordinatorDaemonId} threw: ${e?.message || e} — draining anyway to break the retry loop`);
            }
            ackUnresolvedDelegateForward(entry.id);
            unresolvedForwardRejectionCounts.delete(entry.id);
            if (localResult && localResult.success === false) {
                LOG.warn('MeshReconcile', `Self-addressed unresolved-delegate ${readNonEmptyString(entry.payload.event)} rejected by local router (${readNonEmptyString(localResult.error) || 'no reason'}) — drained to break the self-forward retry loop`);
                traceMeshEventDrop('self_forward_local_rejected', entryTraceCtx, readNonEmptyString(localResult.error) || 'no reason');
            } else {
                LOG.info('MeshReconcile', `Self-addressed unresolved-delegate ${readNonEmptyString(entry.payload.event)} routed via local router (coordinator ${entry.coordinatorDaemonId} is self) — drained`);
            }
            continue;
        }

        // RECONCILE-MESHID-DROP: the stored forward payload was built when the worker
        // "couldn't resolve" its meshId, so the coordinator rejects it "meshId required"
        // when its own workspace/nodeId recovery misses. The worker can usually resolve it
        // now (member node membership / live-session meshNodeFor) — stamp it on so the
        // coordinator accepts. Covers entries persisted before this fix AND late-bound
        // sessions. No-op when the payload already carries a meshId or none is resolvable.
        let pushPayload = entry.payload;
        if (!readNonEmptyString(pushPayload.meshId)) {
            const recoveredMeshId = resolveForwardEventMeshId(components, pushPayload);
            if (recoveredMeshId) {
                pushPayload = { ...pushPayload, meshId: recoveredMeshId };
                traceMeshEventStage('forward_meshid_recovered', entryTraceCtx, `meshId=${recoveredMeshId}`);
            }
        }

        let result: any;
        try {
            traceMeshEventStage('forward_send', entryTraceCtx, `retry → ${entry.coordinatorDaemonId}`);
            // OFFLINE-NODE-BLOCKING: stamp the status-origin marker so the daemon-cloud relay
            // grants the SHORT connect-wait budget. Without it, a retry to a coordinator whose
            // daemon is powered off sinks into the 90s connect deadline per entry, serializing
            // the whole unresolved-forward outbox behind one dead coordinator. With it, the
            // dispatch throws in ~2s and the entry is left queued for the next tick — the
            // existing retry-backoff and age-expiry below are unchanged. The marker only
            // affects the connect wait and is stripped before mesh_forward_event executes, so
            // delivery semantics are identical.
            result = await dispatchMeshCommand(entry.coordinatorDaemonId, 'mesh_forward_event', withStatusProbeMarker(pushPayload));
        } catch (e: any) {
            // Coordinator unreachable (transport threw) — keep the entry queued and try again
            // next tick. This is NOT a hard rejection, so it does not count toward the cap;
            // the age expiry bounds a permanently-offline coordinator.
            LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} failed: ${e?.message || e} — left queued`);
            traceMeshEventDrop('retry_forward_failed', entryTraceCtx, e?.message || String(e));
            continue;
        }
        if (result && result.success === false) {
            // Hard rejection: the push was delivered and deterministically refused. Retrying
            // the identical payload can never succeed, so bound it — after MAX_FORWARD_REJECTIONS
            // drop (drain) the entry with one fail-loud warning instead of re-spamming every tick.
            const rejections = (unresolvedForwardRejectionCounts.get(entry.id) || 0) + 1;
            unresolvedForwardRejectionCounts.set(entry.id, rejections);
            const reason = readNonEmptyString(result.error) || 'no reason';
            if (rejections >= MAX_FORWARD_REJECTIONS) {
                ackUnresolvedDelegateForward(entry.id);
                unresolvedForwardRejectionCounts.delete(entry.id);
                LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} rejected ${rejections}x (${reason}) — dropping unresolved-delegate ${readNonEmptyString(entry.payload.event)} (sess=${readNonEmptyString(entry.payload.targetSessionId) || readNonEmptyString(entry.payload.sessionId) || '-'}) to stop the retry loop`);
                traceMeshEventDrop('retry_forward_exhausted', entryTraceCtx, `${reason} (${rejections} rejections)`);
            } else {
                LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} rejected (${reason}) — left queued (attempt ${rejections}/${MAX_FORWARD_REJECTIONS})`);
                traceMeshEventDrop('retry_forward_rejected', entryTraceCtx, reason);
            }
            continue;
        }
        // Acked — mark the durable copy delivered.
        ackUnresolvedDelegateForward(entry.id);
        unresolvedForwardRejectionCounts.delete(entry.id);
        LOG.info('MeshReconcile', `Retried+delivered unresolved-delegate ${readNonEmptyString(entry.payload.event)} to coordinator ${entry.coordinatorDaemonId}`);
    }
}

