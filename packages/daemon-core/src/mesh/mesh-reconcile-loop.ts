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
import { drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, buildPendingEventFingerprint, queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { handleMeshForwardEvent, shouldForceInjectMeshEvent, MESH_FORCE_INJECT_EVENTS, triggerMeshQueue } from './mesh-events-coordinator.js';
import {
    peekUnresolvedDelegateForwards,
    ackUnresolvedDelegateForward,
    expireStaleUnresolvedDelegateForwards,
} from './mesh-unresolved-forward-outbox.js';
import { readNonEmptyString, readMeshCompletionSummary } from './mesh-events-utils.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { expandDaemonIdForms, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getActiveDirectDispatches, getQueue, reclaimStrandedAssignedTask } from './mesh-work-queue.js';
import { readLedgerEntries } from './mesh-ledger.js';
import { pruneStaleDirectDispatches } from './mesh-active-work.js';
import { reconcileDirectDispatchCompletionFromTranscript } from './mesh-events-stale.js';
import { extractFinalAssistantSummaryEvidence } from '../providers/chat-message-normalization.js';
import type { ChatMessage } from '../types.js';

// Default reconcile cadence. approval/completion notifications to a live CLI
// coordinator land within at most one interval. Overridable via env for tuning.
const DEFAULT_RECONCILE_INTERVAL_MS = 4_000;

// PHASE 5 (auto-prune) conservative age gate. A direct dispatch whose node/session is
// orphaned (no longer in the live mesh) is only auto-pruned once it is at least this old,
// measured from its dispatch time. This protects against a node/session that is only
// *transiently* invisible (a momentary probe failure, a daemon restart) being pruned the
// instant it disappears. The MANUAL prune (mesh_prune_stale_direct) has no age gate — an
// operator pruning explicitly wants the orphan gone now. Overridable via env for tuning.
const DEFAULT_AUTO_PRUNE_MIN_AGE_MS = 24 * 60 * 60_000; // 24h

function resolveAutoPruneMinAgeMs(): number {
    const raw = readNonEmptyString(process.env.MESH_AUTO_PRUNE_MIN_AGE_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        // Clamp to [1h, 30d] so a mis-set env can't make the gate pathologically aggressive
        // (prune the moment something blinks) or effectively disable it forever.
        if (Number.isFinite(parsed) && parsed >= 60 * 60_000 && parsed <= 30 * 24 * 60 * 60_000) return parsed;
    }
    return DEFAULT_AUTO_PRUNE_MIN_AGE_MS;
}

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
    // Runtime session id of this coordinator instance (getState().instanceId). PHASE 2
    // strict-matches an event's targetCoordinatorSessionId against this so a completion
    // routes back to the exact originating coordinator session, not a sibling on the same
    // daemon (the multi-coordinator misroute).
    sessionId: string;
    idle: boolean;
    // True when the coordinator session is parked on a harness modal awaiting a
    // human answer — claude-cli AskUserQuestion (waiting_choice) or a tool-consent
    // prompt (waiting_approval). A force-inject into such a session would write raw
    // keystrokes the modal key handler consumes, silently selecting a choice the
    // user never made (data corruption). PHASE 2 excludes these from force-inject
    // and leaves the event queued for a later (modal-resolved) tick.
    modalParked: boolean;
}

// The set of coordinator-daemon ids THIS daemon answers to when draining the
// pending-events queue. A unicast completion event is stamped with the worker's
// meshCoordinatorDaemonId, which can be either:
//   - the daemon's canonical status id (`standalone_<machineId>` / `daemon_<machineId>`),
//     stamped by the MCP layer via ctx.localDaemonId (= getStatus().status.instanceId), or
//   - the bare machineId, stamped by the local queue-assignment path (loadConfig().machineId).
//   - the config-form node daemonId (`daemon_<machineId>`), which the MCP layer's
//     resolveCoordinatorDaemonId prefers and stamps onto direct-dispatch workers.
// Draining with only one of these silently misses events stamped with the other —
// the exact reason a generating coordinator never self-received local completions,
// and the base-node completion-surface bug (base completions land full-form
// `daemon_<machineId>` while a coordinator that only knows itself as bare
// `<machineId>` never matches them). We expand to EVERY equivalent form so the
// scope match (host gate, self-node detection, and the drain IN-filter downstream)
// succeeds regardless of which path stamped the event.
function resolveCoordinatorDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    return expandDaemonIdForms([statusInstanceId, machineId]);
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
        // getState() overlays the modal-park statuses: an active AskUserQuestion
        // prompt surfaces as waiting_choice, a tool-consent prompt as waiting_approval.
        // Lowercase literal compare — the SessionStatus enum is forked across modules
        // and waiting_choice is absent from some of them (see cli-provider-instance).
        const modalParked = status === 'waiting_choice' || status === 'waiting_approval';
        const sessionId = readNonEmptyString(state.instanceId);
        out.push({ meshId, instance: inst, sessionId, idle: status === 'idle', modalParked });
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
    // EVTTRACE: event surfaced to the coordinator (injected into its live CLI session).
    // This is the terminal happy-path stage. Observation only.
    traceMeshEventStage('surfaced', {
        taskId: pending.metadataEvent?.taskId,
        sessionId: pending.metadataEvent?.targetSessionId ?? pending.targetCoordinatorSessionId,
        nodeId: pending.nodeId,
        meshId: pending.meshId,
        event: pending.event,
    }, force ? 'force-inject' : 'inject');
    coordinator.onEvent('send_message', {
        input: { text: pending.coordinatorMessage, textFallback: pending.coordinatorMessage },
        ...(force ? { force: true } : {}),
    });
}

// Held-event ledger dedup: fingerprints of held terminal events already written as an
// `event_held` ledger audit record in THIS process. Prevents the 4s reconcile tick from
// re-logging the same held event every interval while a coordinator stays modal-parked.
// Per-process only (not persisted) — if the daemon restarts while an event is still held
// it is re-logged once, which is desirable: it re-confirms the event is still undelivered.
const heldEventLedgerRecorded = new Set<string>();

// C1 (data safety): when a terminal completion/approval/bootstrap event cannot be
// delivered because the only coordinators are modal-parked, the event is held at
// drained=0 in the pending queue (SQLite + JSONL) for a later tick. That queue is
// disk-persisted but carries no operator-visible audit trail and can be silently
// dropped by the pending-file trim (100 KB / 50-entry cap). To guarantee a held
// completion's worker summary is never silently lost, mirror each held terminal event
// into the coordinator's mesh ledger as an `event_held` entry — auditable and
// recoverable (the finalSummary survives even if the pending copy is later trimmed or
// the coordinator session is force-resolved before re-drain). Idempotent per process
// via heldEventLedgerRecorded so a long modal park does not spam the ledger.
function recordHeldTerminalEventsToLedger(
    meshId: string,
    drainDaemonIds: string[],
    reason: string,
    heldForCoordinatorCount: number,
): void {
    let pending: readonly PendingMeshCoordinatorEvent[];
    try {
        pending = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch {
        return; // best-effort audit — never let a peek failure break the tick
    }
    for (const event of pending) {
        // Only audit terminal/force-inject events (completion / approval / stop / refine·
        // bootstrap). Silent lifecycle events (agent:ready / generating_started) carry no
        // worker output to preserve and re-drain harmlessly, so they need no audit trail.
        if (!shouldForceInjectMeshEvent(event.event)) continue;
        const fingerprint = buildPendingEventFingerprint(event);
        const key = `${meshId}::${fingerprint || `${event.event}::${event.nodeId || ''}::${event.queuedAt}`}`;
        if (heldEventLedgerRecorded.has(key)) continue;
        heldEventLedgerRecorded.add(key);
        const finalSummary = readMeshCompletionSummary(event.metadataEvent);
        try {
            appendLedgerEntry(meshId, {
                kind: 'event_held',
                ...(event.nodeId ? { nodeId: event.nodeId } : {}),
                payload: {
                    event: event.event,
                    reason,
                    recoverable: true,
                    heldForCoordinators: heldForCoordinatorCount,
                    nodeLabel: event.nodeLabel,
                    ...(event.workspace ? { workspace: event.workspace } : {}),
                    targetCoordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
                    queuedAt: event.queuedAt,
                    ...(fingerprint ? { fingerprint } : {}),
                    ...(finalSummary ? { finalSummary } : {}),
                },
            });
            LOG.info('MeshReconcile', `Ledger-recorded held ${event.event} for mesh ${meshId} (reason ${reason}) — recoverable from ledger`);
        } catch (e: any) {
            // Failed to persist — drop the dedup marker so the next tick retries.
            heldEventLedgerRecorded.delete(key);
            LOG.warn('MeshReconcile', `Failed to ledger-record held ${event.event} for mesh ${meshId}: ${e?.message || e}`);
        }
    }
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
// Bug B: how long a row may sit 'assigned' with an unconfirmed dispatch before the
// watchdog reclaims it. Must be comfortably larger than the per-dispatch confirm
// timeout (DISPATCH_CONFIRM_TIMEOUT_MS in mesh-events-coordinator) so a slow-but-live
// dispatch still inside its normal confirm window is never reclaimed early — this is
// the durable backstop for the case the in-process confirm timer can't cover (a timer
// lost to a daemon restart between claim and confirm).
const ASSIGNED_STRANDED_DEADLINE_MS = 5 * 60_000;

// PHASE 2.5 — assigned-stranded dispatch watchdog (Bug B). claimNextTask atomically
// flips a row to 'assigned' BEFORE the fire-and-forget dispatch runs. If that dispatch
// neither rejects (→ no .catch requeue) nor is confirmed delivered — a relay that hangs
// without acking, or a confirm timer lost across a restart — the row stays 'assigned'
// forever: it contributes 0 pending, so PHASE 3 (gated on pendingQueueTaskCount>0) never
// re-examines it, and nothing but a manual requeue clears it. This is that missing net.
//
// Regression guard: a row whose delivery IS confirmed (delivered/acked/completed) is a
// genuinely in-flight (or completion-lost) task — left to PHASE 4's completion reconcile,
// never reclaimed here. And the deadline is generous so a slow-but-live dispatch still in
// its normal confirm window is never reclaimed early. Reclaimed rows return to 'pending'
// with ownership cleared, so the PHASE 3 trigger below re-dispatches them this same tick.
function recoverStrandedAssignedDispatches(meshId: string, store: MeshRuntimeStore): void {
    const assigned = getQueue(meshId, { status: ['assigned'] });
    if (!assigned.length) return;
    const nowMs = Date.now();
    for (const row of assigned) {
        const dispatchedAtMs = Date.parse(row.dispatchTimestamp ?? '');
        if (!Number.isFinite(dispatchedAtMs)) continue;              // no dispatch ts → can't age it
        if (nowMs - dispatchedAtMs < ASSIGNED_STRANDED_DEADLINE_MS) continue;  // still in confirm window
        if (store.taskHasConfirmedDelivery(meshId, row.id)) continue;          // dispatched → PHASE 4's job
        const reclaimed = reclaimStrandedAssignedTask(meshId, row.id, {
            reason: 'assigned_stranded_dispatch_unconfirmed',
            ageMs: nowMs - dispatchedAtMs,
        });
        if (reclaimed) {
            LOG.warn('MeshReconcile', `Reclaimed stranded assigned task ${row.id} on mesh ${meshId} `
                + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}, dispatched `
                + `${Math.round((nowMs - dispatchedAtMs) / 1000)}s ago, never confirmed delivered → ${reclaimed.status})`);
            // EVTTRACE: the dispatch for this task was stranded (assigned, never confirmed
            // delivered) and reclaimed (CANON-B) — its expected completion event never
            // arrived. Observation only; the reclaim decision above is unchanged.
            traceMeshEventDrop('assigned_stranded_reclaim', {
                taskId: row.id,
                sessionId: row.assignedSessionId,
                nodeId: row.assignedNodeId,
                meshId,
                event: 'agent:generating_completed',
            }, `unconfirmed ${Math.round((nowMs - dispatchedAtMs) / 1000)}s → ${reclaimed.status}`);
        }
    }
}

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

    // ── PHASE 2.5: assigned-stranded dispatch watchdog (Bug B) ─────────────────
    // Runs before PHASE 3 so any row it returns to 'pending' is re-dispatched by the
    // PHASE 3 trigger in this same tick. See recoverStrandedAssignedDispatches.
    if (store) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                recoverStrandedAssignedDispatches(mesh.id, store);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Assigned-stranded watchdog failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 3: recover pending queue claims for newly-idle sessions ──────────
    // The event-driven claim paths (agent:ready / agent:generating_completed in
    // mesh-events-coordinator) re-claim the queue the moment a session goes idle,
    // but that depends on a single event being emitted AND (for a remote node)
    // successfully forwarded to this coordinator. If that event is missed/dropped,
    // a pending task targeting a now-idle session would sit unclaimed forever —
    // there was no periodic safety net. This phase is that net: for every mesh this
    // daemon hosts that has at least one pending task, run one triggerMeshQueue so a
    // session that became idle without a delivered ready-event still gets its work.
    //
    // O(1) guard: skip the (relatively expensive) full idle-session + remote-idle
    // scan entirely when the queue has no pending tasks — a COUNT(*) over the
    // indexed status column, so an idle mesh costs one cheap query per tick.
    // claimNextQueueTask is atomic, so racing the event-driven path can only have
    // one winner; double-claiming is impossible.
    for (const mesh of listMeshes()) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (!daemonHostsMesh(mesh, selfIds)) continue;
        if (store) {
            try {
                if (store.pendingQueueTaskCount(mesh.id) === 0) continue;
            } catch { /* fall through and let triggerMeshQueue decide */ }
        }
        try {
            await triggerMeshQueue(components, mesh.id);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Pending-claim recovery trigger failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }

    // ── PHASE 4: synthesize lost completions for unterminated direct dispatches ─
    // Symmetric to PHASE 3 (which recovers a *lost claim* for a newly-idle session)
    // but for the opposite gap: a worker that ALREADY completed, went idle, and
    // whose terminal completion event was never persisted (dropped before reaching
    // the queue/outbox, or its forward was lost). PHASE 1/2/3 can only deliver an
    // event that exists in a queue — they cannot recover a completion that was
    // never recorded, so the coordinator keeps believing the worker is generating.
    //
    // reconcileDirectDispatchCompletionFromTranscript already synthesizes the
    // missing terminal event from the worker's transcript, but until now it ran
    // ONLY when an LLM coordinator polled mesh_status (mcp_mesh_status_transcript_
    // reconciliation). This phase pulls that same correction onto the daemon timer
    // so it no longer depends on the LLM polling. The reconcile is idempotent
    // (hasTerminalLedgerAfterDispatch guards against re-synthesis), so attempting it
    // every tick for the same dispatch is safe — once a terminal exists it no-ops.
    for (const mesh of listMeshes()) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (!daemonHostsMesh(mesh, selfIds)) continue;
        try {
            await reconcileUnterminatedDirectDispatches(components, mesh, selfIds, localDaemonId);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Completion reconcile failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }

    // ── PHASE 5: auto-prune orphaned direct dispatch records ───────────────────
    // staleDirectWork (orphaned direct-dispatch rows whose node/session is no longer in the
    // live mesh) otherwise accumulates indefinitely: a removed worktree node or a cleanly
    // terminated session leaves its direct-dispatch row behind, stuck in a non-terminal status
    // (e.g. generating) for days. This is NOT a false-idle bug — it is the separate problem of
    // orphaned records that the only existing cleanup path (manual MCP mesh_prune_stale_direct)
    // never reaches unless an operator runs it by hand.
    //
    // This phase runs the SAME prune core the manual tool calls (pruneStaleDirectDispatches),
    // in execute mode, on the daemon timer. The only difference from the manual path is a
    // conservative age gate (DEFAULT_AUTO_PRUNE_MIN_AGE_MS): a freshly-orphaned record is held
    // back until it is provably stale, so a transient probe miss never auto-prunes live work.
    // Every other safety rule is inherited unchanged from the core — active/pending/generating
    // work and fresh unacknowledged dispatch failures are never pruned, ledger-only audit entries
    // are preserved, and the prune itself is recorded with a direct_dispatch_pruned ledger entry.
    // Idempotent: a pruned row is gone from getActiveDirectDispatches, so the next tick finds
    // nothing to re-prune. Isolated in its own try/catch per mesh so it can never kill the tick.
    {
        const minAgeMs = resolveAutoPruneMinAgeMs();
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await autoPruneStaleDirectDispatches(components, mesh, selfIds, localDaemonId, minAgeMs);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Auto-prune stale direct failed for mesh ${mesh.id}: ${e?.message || e}`);
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
        // A coordinator parked on a harness modal (waiting_choice / waiting_approval)
        // is non-idle, so it would otherwise be treated as a force-inject target. It
        // must NOT be: a force-inject writes raw keystrokes into the PTY, which the
        // modal's key handler consumes and silently resolves to a choice the user
        // never made. Force-inject is only safe into a coordinator parked in plain
        // `generating` (the deadlock the force path exists to break). So generating
        // targets are the non-idle, non-modal-parked coordinators.
        const generatingCoordinators = meshCoordinators.filter(c => !c.idle && !c.modalParked);
        const modalParkedCoordinators = meshCoordinators.filter(c => !c.idle && c.modalParked);
        const targetCoordinators = idleCoordinators.length > 0 ? idleCoordinators : generatingCoordinators;
        const forceOnly = idleCoordinators.length === 0;

        // ── modal-blocked short-circuit (MUST precede the drain) ──────────────────
        // When the ONLY coordinators for this mesh are modal-parked (no idle, no plain
        // generating target), there is nowhere safe to deliver. We skip-and-requeue:
        // by NOT draining we leave the events at drained=0 in the queue, so a later tick
        // (once the modal is resolved and the coordinator returns to idle/generating)
        // delivers them. This short-circuit MUST run BEFORE drainPendingMeshCoordinatorEvents
        // — the drain marks rows drained=1 atomically, which would lose the events for a
        // coordinator that is only transiently blocked. (Note: generating is still
        // force-injected via generatingCoordinators — we never block the deadlock-break.)
        if (targetCoordinators.length === 0) {
            if (modalParkedCoordinators.length > 0) {
                LOG.info('MeshReconcile', `Reconcile skip → modal-parked: holding pending event(s) for mesh ${meshId} (${modalParkedCoordinators.length} coordinator(s) awaiting a modal answer; events left queued)`);
                // C1: mirror held terminal events into the ledger so a held completion's
                // worker summary is auditable/recoverable even if the modal is never
                // resolved, the coordinator restarts, or the pending file is later trimmed.
                // The events stay queued (drained=0) for re-drain on a later tick; this only
                // adds the durable audit copy. Idempotent per process — only newly-held
                // events are logged. O(1)-gated: skip the peek when the queue is empty.
                let hasPending = true;
                if (store) {
                    try { hasPending = store.pendingEventCount(meshId) > 0; } catch { /* peek below */ }
                }
                if (hasPending) {
                    recordHeldTerminalEventsToLedger(
                        meshId,
                        drainDaemonIds.length > 0 ? drainDaemonIds : (localDaemonId ? [localDaemonId] : []),
                        'modal_parked',
                        modalParkedCoordinators.length,
                    );
                }
            }
            continue;
        }

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
            // Strict session routing (multi-coordinator): when the event names an
            // originating coordinator session, deliver ONLY to the live coordinator whose
            // session id matches — a sibling coordinator on the same daemon must NOT receive
            // another coordinator's completion. When the event carries no session id (legacy /
            // version-skewed / single-coordinator), fall back to the daemon-level set
            // (unchanged behaviour — regression-0 for the common case).
            const wantSession = readNonEmptyString(pending.targetCoordinatorSessionId);
            if (wantSession) {
                const matched = targetCoordinators.filter(c => c.sessionId === wantSession);
                if (matched.length === 0) {
                    // The originating coordinator session is not deliverable on this daemon
                    // right now (gone, or modal-parked and excluded from targets). Strict mode
                    // does NOT broadcast to siblings — hold the event for a later tick, and
                    // ledger-expire it past a TTL so it can never wedge forever.
                    holdOrExpireStrictUnmatchedEvent(pending, wantSession, meshId);
                    continue;
                }
                for (const c of matched) injectPendingIntoCoordinator(c.instance, pending);
                continue;
            }
            for (const c of targetCoordinators) {
                injectPendingIntoCoordinator(c.instance, pending);
            }
        }
    }
}

// Strict-routing TTL: how long a drained completion whose originating coordinator session
// is not currently deliverable is held (re-queued for re-drain) before it is ledger-
// expired. Bounded so a coordinator session that never returns cannot wedge the event
// forever; broad enough to ride out a transient modal-park / brief restart.
const STRICT_SESSION_MATCH_TTL_MS = 60_000;

// Re-queue (hold) a strict-routed event whose coordinator session is not live, or — once it
// has aged past STRICT_SESSION_MATCH_TTL_MS — ledger-expire it (recoverable) and drop it.
// We deliberately do NOT broadcast an aged-out event to sibling coordinators: that is the
// very misroute strict routing exists to prevent. The drain already marked the row drained=1,
// so re-queuing re-persists a fresh undrained copy (dedup keys on drained=0 only); queuedAt is
// preserved so the TTL measures the event's true age across re-queues.
function holdOrExpireStrictUnmatchedEvent(
    pending: PendingMeshCoordinatorEvent,
    wantSession: string,
    meshId: string,
): void {
    const queuedAt = typeof pending.queuedAt === 'number' ? pending.queuedAt : Date.now();
    if (Date.now() - queuedAt <= STRICT_SESSION_MATCH_TTL_MS) {
        try {
            queuePendingMeshCoordinatorEvent(pending); // preserves queuedAt → true age retained
            LOG.info('MeshReconcile', `Strict route hold: coordinator session ${wantSession} not live on mesh ${meshId} — re-queued (${pending.event})`);
            // EVTTRACE: event held (re-queued) — its originating coordinator session is not
            // currently deliverable. Held, not dropped; surfaces later or expires past TTL.
            traceMeshEventDrop('strict_route_hold', {
                taskId: pending.metadataEvent?.taskId,
                sessionId: pending.metadataEvent?.targetSessionId ?? wantSession,
                nodeId: pending.nodeId,
                meshId,
                event: pending.event,
            }, `coordinatorSession=${wantSession} not live`);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Strict route re-queue failed for ${pending.event} on mesh ${meshId}: ${e?.message || e}`);
        }
        return;
    }
    const finalSummary = readMeshCompletionSummary(pending.metadataEvent || {});
    try {
        appendLedgerEntry(meshId, {
            kind: 'event_held',
            ...(pending.nodeId ? { nodeId: pending.nodeId } : {}),
            payload: {
                event: pending.event,
                reason: 'strict_route_expired',
                recoverable: true,
                targetCoordinatorSessionId: wantSession,
                targetCoordinatorDaemonId: pending.targetCoordinatorDaemonId ?? null,
                nodeLabel: pending.nodeLabel,
                ...(pending.workspace ? { workspace: pending.workspace } : {}),
                queuedAt,
                ...(finalSummary ? { finalSummary } : {}),
            },
        });
        LOG.warn('MeshReconcile', `Strict route expire: coordinator session ${wantSession} never returned for mesh ${meshId} — recorded to ledger (recoverable), dropped (${pending.event})`);
        // EVTTRACE: event expired past the strict-route TTL — dropped (recoverable, ledgered).
        traceMeshEventDrop('strict_route_expired', {
            taskId: pending.metadataEvent?.taskId,
            sessionId: pending.metadataEvent?.targetSessionId ?? wantSession,
            nodeId: pending.nodeId,
            meshId,
            event: pending.event,
        }, `coordinatorSession=${wantSession} never returned`);
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Failed to ledger-expire strict-unmatched ${pending.event} for mesh ${meshId}: ${e?.message || e}`);
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
        // EVTTRACE correlation context for this outbox entry's retry.
        const entryTraceCtx = {
            taskId: (entry.payload as Record<string, unknown>).taskId,
            sessionId: readNonEmptyString(entry.payload.targetSessionId) || readNonEmptyString(entry.payload.sessionId),
            nodeId: readNonEmptyString(entry.payload.nodeId),
            event: readNonEmptyString(entry.payload.event),
        };
        let result: any;
        try {
            traceMeshEventStage('forward_send', entryTraceCtx, `retry → ${entry.coordinatorDaemonId}`);
            result = await dispatchMeshCommand(entry.coordinatorDaemonId, 'mesh_forward_event', entry.payload);
        } catch (e: any) {
            // Coordinator unreachable — keep the entry queued and try again next tick.
            LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} failed: ${e?.message || e} — left queued`);
            traceMeshEventDrop('retry_forward_failed', entryTraceCtx, e?.message || String(e));
            continue;
        }
        if (result && result.success === false) {
            LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} rejected (${readNonEmptyString(result.error) || 'no reason'}) — left queued`);
            traceMeshEventDrop('retry_forward_rejected', entryTraceCtx, readNonEmptyString(result.error) || 'no reason');
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
        if (daemonIdsEquivalent(nodeDaemonId, localDaemonId)) continue;
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

// Pull the read_chat payload out of whatever envelope the transport returned.
// A local commandHandler.handle() returns the CommandResult directly; a remote
// dispatchMeshCommand returns it possibly wrapped in { payload } / { result }.
function unwrapReadChatPayload(raw: unknown): Record<string, unknown> | null {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        if (Array.isArray(record.messages)) return record;
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return cursor && typeof cursor === 'object' ? cursor as Record<string, unknown> : null;
}

function readChatPayloadStatus(payload: Record<string, unknown> | null): string {
    return readNonEmptyString(payload?.status).toLowerCase();
}

// PHASE 4 helper. For every active (non-terminal) direct dispatch this daemon
// hosts, confirm the worker session is idle via a read_chat and — if a final
// assistant summary is present but no terminal ledger exists for that dispatch —
// synthesize the missing completion through reconcileDirectDispatchCompletionFromTranscript.
//
// read_chat is resolved against the target node: a node on THIS daemon is read
// through the local commandHandler; a remote node is read over P2P via
// dispatchMeshCommand. Both yield the same { messages, status, providerSessionId }
// shape. We only synthesize when the session reports idle AND a final assistant
// message exists — the same evidence bar the MCP poll path uses — so an actively
// generating worker is never falsely completed. The reconcile itself is idempotent.
async function reconcileUnterminatedDirectDispatches(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
): Promise<void> {
    const dispatches = getActiveDirectDispatches(mesh.id);
    if (dispatches.length === 0) return; // cheap exit — nothing dispatched, nothing to reconcile

    const dispatchMeshCommand = components.dispatchMeshCommand;
    const nodeById = new Map(mesh.nodes.map(n => [n.id, n] as const));

    for (const dispatch of dispatches) {
        const sessionId = readNonEmptyString(dispatch.sessionId);
        const nodeId = readNonEmptyString(dispatch.nodeId);
        const taskId = readNonEmptyString(dispatch.taskId);
        if (!sessionId || !nodeId || !taskId) continue;

        const node = nodeById.get(nodeId);
        const nodeDaemonId = readNonEmptyString(node?.daemonId);
        // A node is local when it has no daemonId, names this daemon, or actually
        // has a live instance here. Anything else is reached over P2P.
        const isLocalNode = !nodeDaemonId
            || selfIds.includes(nodeDaemonId)
            || daemonIdsEquivalent(nodeDaemonId, localDaemonId)
            || !!components.instanceManager.getInstance(sessionId);

        const providerType = readNonEmptyString(dispatch.providerType);
        const readArgs: Record<string, unknown> = {
            sessionId,
            targetSessionId: sessionId,
            tailLimit: 10,
            ...(node?.workspace ? { workspace: node.workspace } : {}),
            ...(providerType ? { agentType: providerType, providerType } : {}),
        };

        let payload: Record<string, unknown> | null = null;
        try {
            if (isLocalNode) {
                const result = await components.commandHandler.handle('read_chat', readArgs);
                if (result && (result as { success?: boolean }).success === false) continue;
                payload = unwrapReadChatPayload(result);
            } else if (dispatchMeshCommand) {
                const result = await dispatchMeshCommand(nodeDaemonId, 'read_chat', readArgs);
                payload = unwrapReadChatPayload(result);
                if (payload && (payload as { success?: boolean }).success === false) continue;
            } else {
                continue; // remote node but no P2P transport — can't read; retry next tick
            }
        } catch {
            continue; // best-effort; session may be gone or node offline — retry next tick
        }
        if (!payload) continue;

        // Only act on a session that has actually settled to idle. A generating /
        // waiting_approval session is mid-turn — synthesizing a completion now would
        // be wrong. (idle is the only status the MCP poll path reconciles too.)
        if (readChatPayloadStatus(payload) !== 'idle') continue;

        const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
        const evidence = extractFinalAssistantSummaryEvidence(messages);
        if (!evidence.finalSummary) continue; // no assistant result yet — nothing to attribute

        const providerSessionId = readNonEmptyString(payload.providerSessionId);
        const coordinatorDaemonId = selfIds.find(id => !!id);
        try {
            const result = reconcileDirectDispatchCompletionFromTranscript({
                meshId: mesh.id,
                nodeId,
                sessionId,
                providerType: providerType || undefined,
                providerSessionId: providerSessionId || undefined,
                taskId,
                finalSummary: evidence.finalSummary,
                ...(evidence.transcriptMessageAt ? { transcriptMessageAt: evidence.transcriptMessageAt } : {}),
                ...(coordinatorDaemonId ? { targetCoordinatorDaemonId: coordinatorDaemonId } : {}),
                source: 'daemon_reconcile_transcript_completion',
            });
            if (result.reconciled) {
                LOG.info('MeshReconcile', `Synthesized missing completion (${result.kind}) for task ${taskId} on node ${nodeId} (mesh ${mesh.id})`);
            }
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Transcript completion reconcile threw for task ${taskId}: ${e?.message || e}`);
        }
    }
}

// PHASE 5 helper. Build the live-node view (mesh.nodes decorated with each node's live
// session list) and run the shared prune core in execute mode with the conservative age gate.
//
// Orphan detection needs the SAME live-session evidence the manual MCP prune uses: a node still
// in mesh.nodes whose session list no longer contains the dispatched sessionId is "session not
// present" (prunable); a node missing from mesh.nodes entirely is "node no longer in live mesh"
// (prunable). We obtain live sessions per node via get_status_metadata — local nodes through the
// local commandHandler, remote nodes over P2P (dispatchMeshCommand) — exactly the transports
// PHASE 4 already uses. A node we cannot probe (offline) keeps an empty session list; combined
// with the age gate that only matters once the orphan is genuinely old.
//
// O(1) fast exit: when there are no active direct dispatches at all there is nothing to prune,
// so we skip the (per-node) status probes entirely — an idle mesh costs one indexed query.
async function autoPruneStaleDirectDispatches(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
    minAgeMs: number,
): Promise<void> {
    const directDispatches = getActiveDirectDispatches(mesh.id);
    if (directDispatches.length === 0) return; // nothing dispatched → nothing to prune

    const liveNodes = await collectLiveNodesWithSessions(components, mesh, selfIds, localDaemonId);

    const result = pruneStaleDirectDispatches({
        meshId: mesh.id,
        queue: getQueue(mesh.id),
        ledgerEntries: readLedgerEntries(mesh.id, { tail: 500 }),
        directDispatches,
        nodes: liveNodes,
        execute: true,
        minAgeMs,
        source: 'daemon_reconcile_auto_prune',
    });

    // Log only when something was actually pruned — silence on the common no-op tick.
    if (result.prunedCount > 0) {
        LOG.info('MeshReconcile', `Auto-pruned ${result.prunedCount} orphaned direct dispatch record(s) for mesh ${mesh.id}`);
    }
}

// Probe each node for its live session list (get_status_metadata) and return mesh.nodes
// decorated with a `sessions` array — the shape buildMeshActiveWork / sessionStatusFromNodes
// consume to decide whether a dispatched session is still present. Best-effort: an unreachable
// node yields an empty session list rather than throwing.
async function collectLiveNodesWithSessions(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
): Promise<any[]> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    return Promise.all(mesh.nodes.map(async (node) => {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        const isLocalNode = !nodeDaemonId
            || selfIds.includes(nodeDaemonId)
            || daemonIdsEquivalent(nodeDaemonId, localDaemonId);
        let statusResult: unknown;
        try {
            if (isLocalNode) {
                statusResult = await components.commandHandler.handle('get_status_metadata', {});
            } else if (dispatchMeshCommand) {
                statusResult = await dispatchMeshCommand(nodeDaemonId, 'get_status_metadata', {});
            } else {
                return node; // remote node, no P2P transport — leave undecorated
            }
        } catch {
            return node; // unreachable — leave undecorated (empty session list)
        }
        const sessions = extractStatusMetadataSessions(statusResult);
        return sessions.length > 0 ? { ...node, sessions } : node;
    }));
}

// Pull the live session list out of a get_status_metadata result, tolerating the same
// envelope shapes unwrapReadChatPayload handles (direct CommandResult or { payload }/{ result }).
function extractStatusMetadataSessions(raw: unknown): any[] {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        const status = record.status && typeof record.status === 'object' ? record.status as Record<string, unknown> : undefined;
        if (status && Array.isArray(status.sessions)) return status.sessions;
        if (Array.isArray(record.sessions)) return record.sessions;
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return [];
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
        // Preserve the originating coordinator session id across the relay. It is normally
        // carried inside metadataEvent.meshCoordinatorSessionId (spread below), but pass the
        // top-level field through explicitly too so the handleMeshForwardEvent whitelist
        // recovers it regardless of which carrier the producing daemon used.
        ...(readNonEmptyString(event?.targetCoordinatorSessionId)
            ? { targetCoordinatorSessionId: readNonEmptyString(event.targetCoordinatorSessionId) }
            : {}),
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
