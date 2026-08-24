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
//      loop holds the terminal events for the coordinator's next idle tick.
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
//
// This file is the ORCHESTRATION layer. The three domain halves it drives were
// extracted (pure move, no behavior change) into:
//   • mesh-reconcile-coordinator-drain — live coordinator discovery, the idle
//     drain / approval-nudge / strict-route delivery primitives (PHASE 2);
//   • mesh-reconcile-stranded-dispatch — the assigned-row watchdogs and their
//     deadline/streak state (PHASE 2.5 / 2.6);
//   • mesh-reconcile-unresolved-forward — the worker-side forward outbox retry
//     and its nudge timer (PHASE 0).
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { listMeshes, getMesh } from '../config/mesh-config.js';
import { maybeInjectIdleActiveMissionReminder } from './mesh-idle-reminder.js';
import { LOG, getLogLevel } from '../logging/logger.js';
import {
    drainPendingMeshCoordinatorEvents,
    getPendingMeshCoordinatorEvents,
    buildPendingEventFingerprint,
    requeueDrainedPendingMeshCoordinatorEvent,
} from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { triggerMeshQueue } from './mesh-events-coordinator.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { registerUnresolvedForwardRetryNudge } from './mesh-unresolved-forward-outbox.js';
import {
    resolveCoordinatorDaemonIds,
    daemonHostsMesh,
    resolveCoordinatorSelfIds,
} from './mesh-reconcile-identity.js';
import {
    resolveAutoPruneMinAgeMs,
    resolvePendingHeldDrainEscalateMs,
    resolveReconcileIntervalMs,
} from './mesh-reconcile-config.js';
import { pullRemoteNodeQueues } from './mesh-remote-event-pull.js';
import { runDiskRetentionSweep, detectAndSignalOrphanWorktrees } from './mesh-disk-retention.js';
import { runWorktreeNodeRetentionTick, type WorktreeRetentionDeps } from './mesh-worktree-retention.js';
import { resolveWorktreeNodeRetentionGraceMs } from './mesh-retention-config.js';
import {
    reconcileUnterminatedDirectDispatches,
    autoPruneStaleDirectDispatches,
} from './mesh-completion-synthesis.js';
import { drainMeshTurnOutbox } from './mesh-event-forwarding.js';
import { runContinuousAutoFastForwardScan, runPendingCoordinatorCatchupScan } from './mesh-queue-assignment.js';
import {
    reclaimOrphanedTurnAttempts,
    reclaimQueueTerminatedTurnAttempts,
    reconstructActiveAttempts,
    drainHeldTurnSuspensionsForMesh,
} from './mesh-turn-ledger.js';
import {
    type LiveCoordinator,
    findLiveCoordinators,
    drainAndInjectIntoTargets,
    drainAndDeliverApprovalNudges,
    recordHeldTerminalEventsToLedger,
    oldestHeldTerminalEventAgeMs,
    reconfirmGenuinelyIdleCoordinators,
    holdOrExpireStrictUnmatchedEvent,
} from './mesh-reconcile-coordinator-drain.js';
import {
    recoverStrandedAssignedDispatches,
    reconcileZombieAssignedTasks,
    reconcileUnsettledTerminalAttempts,
} from './mesh-reconcile-stranded-dispatch.js';
import {
    retryUnresolvedDelegateForwards,
    scheduleUnresolvedForwardNudge,
    clearUnresolvedForwardNudge,
} from './mesh-reconcile-unresolved-forward.js';
import { recoverExpiredWorkspaceSagas } from './mesh-graph-workspace-saga.js';
import { createDefaultWorkspaceSagaPorts } from './mesh-graph-workspace-ports.js';
import { sweepMeshGraphGateTimeouts } from './mesh-graph-gates.js';
import { sweepMeshGraphStaleness } from './mesh-graph-staleness.js';
import { recordGraphGateExpired } from './mesh-graph-provenance.js';

// Re-export the extracted public API so existing importers (mesh-events.ts barrel;
// the reconcile-loop test suite) keep their `from './mesh-reconcile-loop.js'` paths.
export { getMeshV2BackstopCounters, __resetMeshV2BackstopCountersForTests } from './mesh-reconcile-v2-backstop.js';
export { __resetReconcileInFlightSynthDebounceForTests } from './mesh-reconcile-acked-hold.js';
export {
    resolveCoordinatorDrainDeliverability,
    shouldHoldPendingDrainForBusyLocalCoordinator,
} from './mesh-reconcile-coordinator-drain.js';
export {
    __resetReclaimUnknownStreakForTests,
    restampReboundMeshWorkerAssignment,
    reconcileZombieAssignedTasks,
    reconcileUnsettledTerminalAttempts,
} from './mesh-reconcile-stranded-dispatch.js';
export { __resetUnresolvedForwardRejectionCountsForTests } from './mesh-reconcile-unresolved-forward.js';

// Reconcile-loop timing tunables + their env-override resolvers
// (DEFAULT_RECONCILE_INTERVAL_MS, DEFAULT_AUTO_PRUNE_MIN_AGE_MS,
// DEFAULT_PENDING_HELD_DRAIN_ESCALATE_MS, resolveReconcileIntervalMs,
// resolveAutoPruneMinAgeMs, resolvePendingHeldDrainEscalateMs) live in
// ./mesh-reconcile-config.ts (A-3 extraction) and are imported above.

// Disk/worktree retention throttle. The reconcile tick runs every ~4s, but the
// retention sweep (fs walks + git worktree list) is far too heavy for that cadence
// and its artifacts age in days, so it runs at most once per hour. `undefined`
// means "never run yet" → runs on the first tick after daemon start so a long-lived
// backlog is reclaimed promptly rather than an hour later. Per-process; a restart
// re-runs it immediately, which is the desired behavior (a restart is exactly when
// stale artifacts from the previous run should be swept).
const DISK_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1h
let lastDiskRetentionRunAt: number | undefined;

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
    // any push that has not yet been acked. Since the spontaneous immediate push was
    // removed (polling single-model §2.1), this PHASE 0 retry is the ONLY delivery
    // path for unresolved-delegate events; the enqueue site nudges an early run of it
    // (scheduleUnresolvedForwardNudge) so happy-path latency stays sub-interval.
    // See mesh-unresolved-forward-outbox.ts.
    if (dispatchMeshCommand) {
        try {
            await retryUnresolvedDelegateForwards(components);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Unresolved-delegate forward retry failed: ${e?.message || e}`);
        }
    }

    // ── PHASE 0.1: drain the durable TURN-LEDGER outbox (Stage 5) ────────────
    // Coordinator-bound terminal notifications persisted at reducer commit time.
    // Rows whose delivery failed are rescheduled with backoff — this per-tick drain
    // is their retry pump (the commit-time and boot drains cover the happy paths).
    // Exactly-once: pending-events fingerprint dedup collapses any redelivery.
    try {
        await drainMeshTurnOutbox();
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Turn outbox drain failed: ${e?.message || e}`);
    }

    // ── PHASE 0.5: merge file-config membership into the router's inline cache ─
    // MESH-MEMBERSHIP-INLINE-CACHE-SYNC: getMeshForCommand's inline-cache-preferred
    // read (mesh_status / mesh_list_nodes / get_mesh) resolves a meshId from
    // router.inlineMeshCache whenever ANYTHING has warmed it (e.g. a cloud
    // coordinator launch with inlineMesh — see mesh-coordinator-launch.ts). Once
    // warmed, that cache — not meshes.json — is what every live read serves.
    // add_mesh_node/remove_mesh_node now push their own writes into the cache
    // too, but a change made by ANOTHER daemon (or a direct meshes.json edit)
    // reaches only this daemon's file config, never its in-memory cache. This
    // loop already re-reads listMeshes() every tick for its own queue work, so
    // reuse that read to fold the current file-config membership into the cache
    // via the same reconcileInlineMeshCache path getMeshForCommand itself uses
    // (getCachedInlineMesh(meshId, incoming) merges — it does not overwrite —
    // preferring cache-only nodes when the cache is newer, e.g. a just-cloned
    // worktree not yet flushed to disk).
    //
    // Deliberately gated on `router.getCachedInlineMesh(mesh.id)` (no second arg)
    // returning a hit FIRST: calling the merging overload unconditionally would
    // warm the cache for every local-config mesh on every tick, flipping meshes
    // that have NEVER been inline-cached from always-fresh 'local_config' reads
    // to a resolution sourced from a snapshot that's only as fresh as the last
    // 4s tick. Only merge into a cache entry that already exists.
    if (components.router) {
        for (const mesh of listMeshes()) {
            try {
                if (components.router.getCachedInlineMesh(mesh.id)) {
                    components.router.getCachedInlineMesh(mesh.id, mesh);
                }
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Inline-cache membership merge failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
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
                await recoverStrandedAssignedDispatches(components, mesh, store, localDaemonId, selfIds);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Assigned-stranded watchdog failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
            // PHASE 2.6 — assigned-zombie sweep: terminal-fails the rows PHASE 2.5
            // can never age (no dispatchTimestamp) whose session is positively gone.
            try {
                reconcileZombieAssignedTasks(components, mesh, selfIds);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Assigned-zombie sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
            // ATTEMPT-SETTLE-CHOKE-POINT backstop: settle attempts left non-terminal
            // under an already-terminal task row. The updateTaskStatus choke point makes
            // this a no-op in steady state; a firing is logged loudly because it means a
            // terminal writer bypassed the choke point.
            try {
                reconcileUnsettledTerminalAttempts(mesh);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Unsettled-attempt safety net failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 2.6: DS3 coordinator local catch-up ──────────────────────────────
    // Drain `coordinator_catchup` markers a remote node's Refinery queued after pushing
    // the base to origin, and guarded-ff this daemon's own coordinator base checkout up to
    // the pushed commit (busy → deferred to a later tick; ahead/diverged/dirty → the ff
    // helper structured-blocks, never rebases). Runs for EVERY mesh this daemon hosts
    // (not gated on continuous mode) and BEFORE PHASE 3 so a caught-up base is current
    // before any new task is dispatched. No markers → immediate no-op.
    for (const mesh of listMeshes()) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (!daemonHostsMesh(mesh, selfIds)) continue;
        try {
            await runPendingCoordinatorCatchupScan(components, mesh);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Coordinator catch-up scan failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }

    // ── PHASE 2.7: continuous remote auto fast-forward (opt-in, default OFF) ────
    // mode:"continuous" + remoteNodes:true only. Catch up an online/clean/behind
    // REMOTE base node that emits no fresh idle edge (e.g. a long-idle base node while
    // upstream advanced). Runs BEFORE PHASE 3's queue claim so a node it advances is
    // caught up before any new task is dispatched onto it. Cloud-only (dispatchMeshCommand);
    // a per-node cooldown + workspace lease inside the scan keep the 4s cadence from
    // hammering peers. No-op for every mesh that has not opted into continuous mode, so
    // the default (idle-edge only) path is byte-for-byte unchanged.
    if (dispatchMeshCommand) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await runContinuousAutoFastForwardScan(components, mesh);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Continuous auto fast-forward scan failed for mesh ${mesh.id}: ${e?.message || e}`);
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
    // The mesh work-queue is SQLite-only (claimNextQueueTask/countQueueStatus all go
    // through MeshRuntimeStore — there is no JSONL fallback for the QUEUE, only for
    // pending EVENTS drained in PHASE 1/2). So when SQLite is unavailable (store
    // undefined, e.g. better-sqlite3 native load failure on a clean install),
    // triggerMeshQueue can do no useful work — it would only re-throw inside the
    // store and emit the WARN below every tick × mesh count, flooding the logs. Skip
    // the phase entirely in that case; the JSONL event-delivery path is unaffected.
    if (store) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                if (store.pendingQueueTaskCount(mesh.id) === 0) continue;
            } catch { /* fall through and let triggerMeshQueue decide */ }
            try {
                await triggerMeshQueue(components, mesh.id);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Pending-claim recovery trigger failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
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

    // ── PHASE 5.4: coordinator-gate deadline sweep (orchestration C2, wired in E) ──
    // ★ The sweep can only EXPIRE a gate, never release one (design :431-432):
    // elapsed time is never completion evidence. `hold` retains downstream blocks
    // for an explicit reclaim, `cancel_downstream` cancels the pending downstream
    // subtree, `fail_graph` fails the graph. There is deliberately NO auto_release
    // policy — do not add one.
    //
    // A LAPSED LEASE is reported but never acts: only a new claim at a HIGHER
    // fencing generation may take a gate over, and that is a coordinator decision
    // (the previous owner may already have performed the external side effect).
    //
    // Cheap by construction: one indexed query per mesh over gates in
    // awaiting_coordinator/claimed. Isolated per mesh so a sweep fault cannot kill
    // the tick.
    if (store) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                const gateStore = store.graphStore();
                // Snapshot the policy/deadline BEFORE the sweep mutates the rows —
                // afterwards the gate is `expired` and the reason for expiry would
                // have to be re-derived.
                const preSweep = new Map(
                    gateStore.listGatesByMesh(mesh.id, ['awaiting_coordinator', 'claimed'])
                        .map(g => [g.gateId, { graphId: g.graphId, onTimeout: g.onTimeout, deadlineAt: g.deadlineAt }]),
                );
                const swept = sweepMeshGraphGateTimeouts(mesh.id);
                for (const gateId of swept.expiredGateIds) {
                    const meta = preSweep.get(gateId);
                    recordGraphGateExpired(mesh.id, {
                        gateId,
                        graphId: meta?.graphId,
                        policy: meta?.onTimeout ?? 'hold',
                        deadlineAt: meta?.deadlineAt,
                    });
                }
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Graph gate sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 5.45: graph/gate staleness reminders (G3) ─────────────────────
    // Read-only visibility sweep: a graph that stopped advancing or a gate that
    // kept waiting past the staleness threshold pages the coordinator again,
    // once per reminder window (windowed fingerprint anchor — see
    // mesh-graph-staleness.ts). Never mutates graph/gate/queue state; timeout
    // POLICY remains PHASE 5.4's job. Isolated per mesh like the other phases.
    if (store) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                sweepMeshGraphStaleness(mesh.id);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Graph staleness sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 5.5: graph workspace-saga lease recovery (orchestration D) ─────
    // Expired workspace-intent leases resume preparation or compensation with a
    // higher fencing generation (design :506-507). Git/FS work stays outside the
    // queue transaction. Isolated per mesh so a saga fault cannot kill the tick.
    if (store) {
        // Registry seam: a prepared worktree is published into live mesh
        // membership (meshes.json + the router's inline cache) so it is an
        // ordinary dispatch target. get_mesh reads the inline cache alone when
        // one is warm, so the router half is not optional on a coordinator.
        const router = components.router;
        const workspacePorts = createDefaultWorkspaceSagaPorts(router
            ? {
                registry: {
                    getCachedInlineMesh: meshId => router.getCachedInlineMesh(meshId),
                    updateInlineMeshNode: (meshId, m, node) => router.updateInlineMeshNode(meshId, m, node),
                    removeInlineMeshNode: (meshId, m, nodeId) => router.removeInlineMeshNode(meshId, m, nodeId),
                    invalidateAggregateMeshStatus: meshId => router.invalidateAggregateMeshStatus(meshId),
                },
            }
            : {});
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await recoverExpiredWorkspaceSagas(mesh.id, workspacePorts);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Workspace saga recover failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
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

    // ── PHASE 6: disk / worktree retention (hourly, mission 86def38d) ──────────
    // Legacy on-disk artifacts under ~/.adhdev accumulated with NO lifetime and grew
    // the data volume until a refine bootstrap failed at 98% disk. This throttled pass
    // (≤1×/hour — the artifacts age in days and the fs/git walk is too heavy for the 4s
    // tick) reclaims them:
    //   • JSONL ledger files older than 30d (legacy after the SQLite ledger)
    //   • terminated session-host runtime files older than 14d (live never touched)
    //   • mesh-runtime.db.bak-* backups older than 7d
    //   • closed ledger rotation files past the per-mesh byte/count caps (oldest
    //     first, terminal counts folded into the archived-counts rollup first)
    //   • orphan worktree DETECTION → cleanup_candidate ledger signal (NEVER deleted).
    // Runs BEFORE PHASE 2's early return so it fires whether or not a live CLI
    // coordinator exists on this daemon. Isolated in try/catch so it can never kill the
    // tick. All file deletions are defensive (age + live-runtime guards in the pure
    // selectors); worktree cleanup stays manual/coordinator-driven.
    {
        const nowMs = Date.now();
        const due = lastDiskRetentionRunAt === undefined
            || (nowMs - lastDiskRetentionRunAt) >= DISK_RETENTION_INTERVAL_MS;
        if (due) {
            lastDiskRetentionRunAt = nowMs;
            try {
                runDiskRetentionSweep(nowMs);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Disk retention sweep failed: ${e?.message || e}`);
            }
            // Orphan-worktree detection is per-mesh (needs the mesh's base repo + node set)
            // and only for meshes this daemon hosts (its local base checkout is the git anchor).
            for (const mesh of listMeshes()) {
                const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
                if (!daemonHostsMesh(mesh, selfIds)) continue;
                try {
                    await detectAndSignalOrphanWorktrees(mesh, nowMs);
                } catch (e: any) {
                    LOG.warn('MeshReconcile', `Orphan worktree detection failed for mesh ${mesh.id}: ${e?.message || e}`);
                }
            }
            // ── PHASE 6.5: converged local worktree-node retention (Slice 2) ──
            // Auto-removal of local worktree clone nodes whose feature branch is
            // PROVEN converged and that have passed the full exclusion precheck on
            // two separate retention passes spanning the grace window (default 48h;
            // 0 disables — see mesh-worktree-retention.ts). Same hourly cadence as
            // the disk sweep: git probes are too heavy for the 4s tick. Runs BEFORE
            // PHASE 2's early return so MCP-only daemons retain nodes too. Dry-run
            // plan + per-node reason codes are content-free logged; a grace of 0
            // disables execution entirely.
            if (components.router && resolveWorktreeNodeRetentionGraceMs() > 0) {
                const router = components.router;
                const retentionDeps: WorktreeRetentionDeps = {
                    precheckLocalWorktreeRemovable: args => router.precheckLocalWorktreeRemovable(args),
                    cleanupLocalWorktreeNode: args => router.cleanupLocalWorktreeNode(args),
                    getWorktreeForceCleanupConvergence: args => router.getWorktreeForceCleanupConvergence(args),
                    cleanupMeshSessions: args => router.cleanupMeshSessions(args as Parameters<typeof router.cleanupMeshSessions>[0]),
                    listSessions: async () => {
                        try { return await router.deps.sessionHostControl?.listSessions() ?? []; } catch { return []; }
                    },
                    getCachedInlineMesh: meshId => router.getCachedInlineMesh(meshId),
                    removeInlineMeshNode: (meshId, mesh, nodeId) => router.removeInlineMeshNode(meshId, mesh, nodeId),
                    invalidateAggregateMeshStatus: meshId => router.invalidateAggregateMeshStatus(meshId),
                };
                const tickId = `reconcile-${nowMs}`;
                for (const mesh of listMeshes()) {
                    const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
                    if (!daemonHostsMesh(mesh, selfIds)) continue;
                    try {
                        await runWorktreeNodeRetentionTick(retentionDeps, { mesh, nowMs, tickId, execute: true, executeMode: 'auto' });
                    } catch (e: any) {
                        LOG.warn('MeshReconcile', `Worktree-node retention failed for mesh ${mesh.id}: ${e?.message || e}`);
                    }
                }
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
        //       (the idle input box accepts the prompt as a real next turn). The drain
        //       marks consumed rows drained=1 atomically, so the pull path can't re-deliver.
        //     - If only GENERATING coordinators exist (no idle target), we HOLD: leave the
        //       events queued (drained=0) for the coordinator's next idle/turn-end tick.
        //
        // NOTIF-SURFACE-LOCAL (false-idle hold): we used to force-inject terminal events
        // (completion/approval/stop/refine·bootstrap) straight into a *generating*
        // coordinator's PTY (forceSendMessage → atomic content+\r write), on the theory it
        // bypassed the busy send-guard and broke the await-result deadlock. But a raw PTY
        // write into a claude-cli that is mid-generation is NOT consumed as a new turn — the
        // bytes land in the terminal input buffer and the LLM never reads them on its next
        // turn. The `surfaced/force-inject` trace fired, the row was marked drained=1, and the
        // genuine completion was lost forever (the exact same-daemon local-worktree miss: the
        // coordinator's OWN session is generating at the moment its worker completes). The
        // deadlock the force path guarded against does not actually require force: a
        // coordinator that dispatched a task via mesh_send_task returns to idle when that
        // tool call resolves (dispatch is fire-and-forget; the worker runs for minutes while
        // the coordinator is idle/between turns), so the completion lands on the very next
        // idle tick (≤ one reconcile interval). Holding the event undrained for that idle
        // tick is therefore the single, reliable delivery — and it is the SAME skip-and-hold
        // the modal-park branch below already uses. This also makes double-injection
        // structurally impossible: there is exactly one delivery path (the idle full-drain),
        // so we never need a surface-time fingerprint to dedup a force-write against a re-drain.
        const idleCoordinators = meshCoordinators.filter(c => c.idle);
        // A coordinator parked on a harness modal (waiting_choice / waiting_approval) is
        // non-idle; it is held under the modal-park branch (a force-inject into a modal would
        // write raw keystrokes the modal key handler eats, silently selecting a choice the
        // user never made). A plainly-generating coordinator (non-idle, non-modal-parked) is
        // ALSO held now — for the false-idle reason above — but separately, so the C1 ledger
        // audit and the operator-facing skip log can name the right hold reason.
        const generatingCoordinators = meshCoordinators.filter(c => !c.idle && !c.modalParked);
        const modalParkedCoordinators = meshCoordinators.filter(c => !c.idle && c.modalParked);
        // Only an IDLE coordinator is a deliverable target. A generating coordinator's PTY
        // does not consume an injected prompt as a turn, so it is held (not a target).
        const targetCoordinators = idleCoordinators;

        // ── no-idle-target short-circuit (MUST precede the drain) ─────────────────
        // When there is no IDLE coordinator for this mesh — only generating and/or
        // modal-parked ones — there is nowhere a queued event can land as a real turn.
        // We skip-and-hold: by NOT draining we leave the events at drained=0 in the queue,
        // so a later tick (once a coordinator returns to idle) delivers them. This
        // short-circuit MUST run BEFORE drainPendingMeshCoordinatorEvents — the drain marks
        // rows drained=1 atomically, which would lose the events for a coordinator that is
        // only transiently busy (the false-idle local-worktree miss). Both the generating
        // hold and the modal-park hold record a C1 ledger audit copy so a held completion's
        // worker summary is recoverable even if the coordinator never returns or the pending
        // file is later trimmed.
        if (targetCoordinators.length === 0) {
            // ── APPROVAL-Q1-REALTIME: level-deliver approval nudges BEFORE the hold ──
            // Approval events are LEVEL-backed (task_approval_needed ledger →
            // mesh_status awaiting_approval), so they must not be edge-held like a
            // completion (whose payload lives only in the pending event). Drain and
            // deliver them to the busy coordinator's inbox (non-force, next-turn-boundary)
            // this tick, dropping any already-resolved (stale) nudge — and leave ONLY the
            // completion/other events in the queue for the existing hold semantics below
            // (their behaviour is unchanged: shouldForceInjectMeshEvent no longer sees the
            // approval rows because this drained them). MUST run first so the modal-park
            // orphan-escape and the generating-hold audit only ever see non-approval events.
            drainAndDeliverApprovalNudges(meshId, drainDaemonIds, localDaemonId, meshCoordinators);
            // If approval nudges were the only queued events, nothing remains to hold — skip
            // the hold branches (and their "holding pending event(s)" log) entirely.
            if (store) {
                try { if (store.pendingEventCount(meshId) === 0) continue; } catch { /* fall through */ }
            }
            if (modalParkedCoordinators.length > 0) {
                // ── orphan escape (MUST precede the blanket modal-park hold) ──────────
                // A modal-parked coordinator with no idle/generating sibling otherwise
                // wedges EVERY pending event under `modal_parked` until that modal resolves
                // — including a STRICT-routed completion whose originating coordinator
                // session is GONE (an orphan: the worktree/session that produced it was
                // removed, or that coordinator session died). Such an event will never be
                // deliverable to its target session no matter what the modal-parked sibling
                // does, so holding it under modal_parked is a permanent-held leak (the very
                // "data restart re-reproduces it" symptom — the gate is reconstructed live
                // from the still-parked modal, so a restart does not clear it). Route those
                // orphan events through the strict-route hold/expire path so the bounded
                // STRICT_SESSION_MATCH_TTL eventually expires them (recoverable, ledgered)
                // instead of leaving them held forever. A strict event whose target session
                // IS live but merely modal-parked is left to the blanket hold below (it is
                // genuinely transiently blocked, not orphaned).
                const liveSessionIds = new Set(
                    meshCoordinators.map(c => readNonEmptyString(c.sessionId)).filter(Boolean),
                );
                let orphanEscaped = 0;
                // Events routed to strict-route this tick — excluded from the modal_parked
                // audit below, which is not the reason they are held.
                const strictRoutedFingerprints = new Set<string>();
                const hasPendingForOrphanPeek = !store
                    || (() => { try { return store.pendingEventCount(meshId) > 0; } catch { return true; } })();
                if (hasPendingForOrphanPeek) {
                    // Identify which pending event NAMES correspond to orphan-targeted events
                    // (a strict targetCoordinatorSessionId that matches no live coordinator).
                    let peeked: readonly PendingMeshCoordinatorEvent[] = [];
                    try {
                        peeked = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
                    } catch { peeked = []; }
                    const isOrphan = (e: PendingMeshCoordinatorEvent): boolean => {
                        const want = readNonEmptyString(e.targetCoordinatorSessionId);
                        return !!want && !liveSessionIds.has(want);
                    };
                    const orphanEventNames = new Set(peeked.filter(isOrphan).map(e => e.event));
                    if (orphanEventNames.size > 0) {
                        // The drain filter is event-NAME scoped (not per-row), so draining by the
                        // orphan event names also pulls any non-orphan event sharing that name. Drain
                        // them all, then re-route: orphan-targeted events go through the strict-route
                        // hold/expire path (bounded TTL → eventually ledger-expired, recoverable);
                        // non-orphan events of the same name are re-queued unchanged (queuedAt
                        // preserved) so they remain genuinely held for their still-live, modal-parked
                        // target. This is the same per-event strict routing PHASE 2 does below — just
                        // reached here because the blanket modal-park short-circuit would otherwise
                        // wedge the orphans forever.
                        let drained: PendingMeshCoordinatorEvent[] = [];
                        try {
                            drained = drainPendingMeshCoordinatorEvents(
                                meshId,
                                drainDaemonIds.length > 0 ? drainDaemonIds : localDaemonId,
                                { onlyEvents: orphanEventNames },
                            );
                        } catch (e: any) {
                            LOG.warn('MeshReconcile', `Orphan-escape drain failed for mesh ${meshId}: ${e?.message || e}`);
                            drained = [];
                        }
                        for (const pending of drained) {
                            if (isOrphan(pending)) {
                                holdOrExpireStrictUnmatchedEvent(pending, readNonEmptyString(pending.targetCoordinatorSessionId), meshId);
                                // Strict-route now owns this event's hold lifecycle (and its own
                                // ledger audit), so exclude it from the modal_parked audit below —
                                // it is not held because a sibling sits on a modal.
                                strictRoutedFingerprints.add(buildPendingEventFingerprint(pending));
                                orphanEscaped++;
                            } else {
                                // Still-live (modal-parked) target — re-queue unchanged so it is held
                                // for the next modal-resolved tick, exactly like the blanket hold would.
                                // STRICT-ROUTE-HOLD-DURABILITY: these rows were just drained, so the
                                // normal persist path is a silent no-op here for the same reason as the
                                // strict hold (UNIQUE fingerprint + INSERT OR IGNORE). Use the durable
                                // undrain so a modal-parked hold also survives a restart.
                                try { requeueDrainedPendingMeshCoordinatorEvent(pending); } catch { /* best-effort re-queue */ }
                            }
                        }
                    }
                }
                LOG.info('MeshReconcile', `Reconcile skip → modal-parked: holding pending event(s) for mesh ${meshId} (${modalParkedCoordinators.length} coordinator(s) awaiting a modal answer; events left queued${orphanEscaped > 0 ? `; ${orphanEscaped} orphan-targeted event(s) routed to strict-route TTL` : ''})`);
                // NOTIF (B) diagnostic: name the session(s) classified modal-parked so the
                // same-tick coordDiag line (paired by sessionId) shows whether the modal-park
                // overlay is a real human-await or an unreleased mask (the getState_overlay origin).
                if (getLogLevel() === 'debug') {
                    LOG.debug('MeshReconcile', `coordHoldModalParked mesh=${meshId} heldFor=[${modalParkedCoordinators.map(c => c.sessionId || '?').join(',')}] (these were classified modal-parked; cross-ref same-tick coordDiag by sessionId)`);
                }
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
                        strictRoutedFingerprints,
                    );
                }
            } else if (generatingCoordinators.length > 0) {
                // ── generating hold (NOTIF-SURFACE-LOCAL false-idle fix) ─────────────
                // The only coordinator(s) for this mesh are plainly generating (no idle, no
                // modal). A raw force-write into a generating claude-cli PTY is not consumed
                // as a turn, so we do NOT inject and do NOT drain — the events stay queued
                // (drained=0) and the next tick that finds the coordinator idle full-drains
                // them as real turns (the coordinator returns to idle when its current
                // tool-call/turn resolves; a dispatched worker runs for minutes while the
                // coordinator is idle, so this lands within one reconcile interval). C1: mirror
                // any held terminal events into the ledger so a completion's worker summary is
                // recoverable even before that idle tick. Idempotent per process; O(1)-gated.
                let hasPending = true;
                if (store) {
                    try { hasPending = store.pendingEventCount(meshId) > 0; } catch { /* peek below */ }
                }
                if (hasPending) {
                    // ── PTY-OVERTRUST-DRAIN (Defect B, fix B): age-based escape ───────────
                    // Fix A already routes the common mask-driven false-busy to the idle path,
                    // so reaching here means the coordinator's RAW adapter reads generating.
                    // That is almost always genuine — but a status-source desync fix A does not
                    // reach can momentarily make the raw adapter read generating while the PTY
                    // is actually at a turn end, stranding the completion across many ticks. As a
                    // TIME-BASED BACKSTOP, once the oldest held terminal event has aged past the
                    // escalate threshold, RE-CONFIRM each held coordinator's raw adapter idle and,
                    // if genuinely idle, drain ONCE into it. The re-confirmation gate is what makes
                    // this safe: it NEVER injects into a genuinely-generating PTY (that is the
                    // data-loss force-inject path intentionally removed). A coordinator still
                    // genuinely generating stays held.
                    const escalateMs = resolvePendingHeldDrainEscalateMs();
                    const heldAgeMs = oldestHeldTerminalEventAgeMs(
                        meshId,
                        drainDaemonIds.length > 0 ? drainDaemonIds : (localDaemonId ? [localDaemonId] : []),
                    );
                    if (heldAgeMs >= escalateMs) {
                        const escapeTargets = reconfirmGenuinelyIdleCoordinators(generatingCoordinators);
                        if (escapeTargets.length > 0) {
                            LOG.info('MeshReconcile', `Reconcile age-escape → generating-hold: held terminal event(s) for mesh ${meshId} aged ${Math.round(heldAgeMs / 1000)}s (≥ ${Math.round(escalateMs / 1000)}s) and ${escapeTargets.length} coordinator(s) re-confirmed genuinely idle on the raw adapter — draining once`);
                            const drained = drainAndInjectIntoTargets(meshId, drainDaemonIds, localDaemonId, escapeTargets, 'age-escape');
                            if (drained > 0) continue; // delivered → no hold this tick
                        }
                    }
                    LOG.info('MeshReconcile', `Reconcile skip → generating: holding pending event(s) for mesh ${meshId} (${generatingCoordinators.length} coordinator(s) busy; events left queued for the next idle tick)`);
                    // NOTIF (B) diagnostic: this is the hold that strands the completion. Name
                    // the sessionId(s) the loop just classified non-idle/non-modal so the
                    // same-tick coordDiag line above (paired by sessionId) reveals which status
                    // source diverged. If a coordDiag for one of these sessions shows getState
                    // (or lastStatus/adapterRaw) === idle, that is the runtime desync origin.
                    if (getLogLevel() === 'debug') {
                        LOG.debug('MeshReconcile', `coordHoldGenerating mesh=${meshId} heldFor=[${generatingCoordinators.map(c => c.sessionId || '?').join(',')}] (these were classified busy; cross-ref same-tick coordDiag by sessionId)`);
                    }
                    recordHeldTerminalEventsToLedger(
                        meshId,
                        drainDaemonIds.length > 0 ? drainDaemonIds : (localDaemonId ? [localDaemonId] : []),
                        'generating_no_idle_coordinator',
                        generatingCoordinators.length,
                    );
                }
            }
            continue;
        }

        // O(1) guard: skip the drain entirely when the queue is empty.
        if (store) {
            try {
                if (store.pendingEventCount(meshId) === 0) {
                    // An idle coordinator is present (the no-idle short-circuit already
                    // `continue`d above) and the pending queue is empty → this mesh is at a
                    // fully-idle edge with nothing to inject. Nudge (once/debounced) if it
                    // still has active missions but no work in flight, so a lingering mission
                    // is not left drifting in 'active'. Best-effort; never blocks the loop.
                    maybeInjectIdleActiveMissionReminder(
                        meshId,
                        targetCoordinators[0].instance,
                        getMesh(meshId)?.policy,
                        undefined,
                        components.instanceManager,
                    );
                    continue;
                }
            } catch { /* fall through to drain */ }
        }

        // An idle coordinator is present (targetCoordinators.length > 0): FULL-drain every
        // queued event and deliver it to the idle input box as a real turn. The no-idle case
        // (generating/modal-only) was already held above and never reaches here, so there is
        // no force-drain-into-generating path left — the single delivery is the idle drain.
        drainAndInjectIntoTargets(meshId, drainDaemonIds, localDaemonId, targetCoordinators, 'idle');
    }
}

// The remote P2P pull helpers (pullRemoteNodeQueues + payload/envelope utilities)
// live in ./mesh-remote-event-pull.ts, and the PHASE-4 completion-synthesis /
// PHASE-5 auto-prune (reconcileUnterminatedDirectDispatches,
// autoPruneStaleDirectDispatches) live in ./mesh-completion-synthesis.ts
// (A-3 extraction). Both are imported at the top of this file.
interface ReconcileLoopHandle {
    stop(): void;
}

// Start the periodic reconcile loop. Returns a handle with stop() for shutdown.
export function setupMeshReconcileLoop(components: DaemonComponents): ReconcileLoopHandle {
    const intervalMs = resolveReconcileIntervalMs();
    let running = false;
    // TURN-LEDGER (Stage 5) restart recovery, once at loop start (before the first
    // tick can make redrive/completion decisions from incomplete state):
    //   1. reconstruct the durable active-attempt set per mesh — the reconcile
    //      redrive/deadline gates read the SAME attempt rows, so a restart resumes
    //      delivery/reconciliation from durable state instead of the lost in-memory
    //      streaks, and a recovered ≥consumed attempt is injection-ineligible by
    //      construction (no duplicate prompt injection);
    //   2. drain the durable turn outbox — any coordinator completion committed
    //      before the crash but not yet delivered is re-queued now (exactly-once via
    //      the outbox id + pending-events fingerprint dedup);
    //   3. drain held suspensions — a waiting_* edge held before a crash whose
    //      consumed ACK is already durable is applied through the FSM now (rows
    //      still pre-consumed stay held for the live ACK; terminal-attempt rows are
    //      dropped). Never re-injects a prompt and never re-drives an event.
    setImmediate(() => {
        void (async () => {
            try {
                for (const mesh of listMeshes()) {
                    // ORPHAN-LEGACY-ATTEMPT (fix ②): close superseded-but-open attempts
                    // BEFORE reconstructing the active set, so the reconcile loop never
                    // resumes tracking a row nothing can ever terminate (and the
                    // recovery log line stops listing rows that are dead by
                    // construction). Cheap and bounded: one indexed scan per mesh, and
                    // it runs inside the existing setImmediate — off the boot critical
                    // path, before the first tick makes any redrive/completion call.
                    const reclaimed = reclaimOrphanedTurnAttempts(mesh.id);
                    if (reclaimed.closed > 0) {
                        LOG.info('TurnLedger', `Restart recovery: reclaimed ${reclaimed.closed} orphaned (superseded) turn attempt(s) for mesh ${mesh.id}`);
                    }
                    // STORE-CONTRAST-CLOSURE: runs AFTER the seq-supersession sweep
                    // above, so a stale non-current sibling row is already closed by
                    // the time this scans — see reclaimQueueTerminatedTurnAttempts.
                    const queueReclaimed = reclaimQueueTerminatedTurnAttempts(mesh.id);
                    if (queueReclaimed.closed > 0) {
                        LOG.info('TurnLedger', `Restart recovery: reclaimed ${queueReclaimed.closed} nonterminal turn attempt(s) whose queue row already finished for mesh ${mesh.id}`);
                    }
                    const recovered = reconstructActiveAttempts(mesh.id);
                    if (recovered.length > 0) {
                        LOG.info('TurnLedger', `Restart recovery: reconstructed ${recovered.length} active turn attempt(s) for mesh ${mesh.id} `
                            + `(${recovered.map(a => `${a.taskId.slice(0, 8)}@${a.stage}`).join(', ')})`);
                    }
                    drainHeldTurnSuspensionsForMesh(mesh.id);
                }
            } catch (e: any) {
                LOG.warn('TurnLedger', `Restart attempt reconstruction failed (reconcile continues on row state): ${e?.message || e}`);
            }
            try {
                const drained = await drainMeshTurnOutbox();
                if (drained.delivered + drained.failed + drained.rescheduled > 0) {
                    LOG.info('TurnLedger', `Restart outbox drain: delivered=${drained.delivered} rescheduled=${drained.rescheduled} failed=${drained.failed}`);
                }
            } catch (e: any) {
                LOG.warn('TurnLedger', `Restart outbox drain failed (rows stay pending; retried on next commit/boot): ${e?.message || e}`);
            }
        })();
    });
    const timer = setInterval(() => {
        if (running) return; // never overlap ticks
        running = true;
        void runMeshReconcileTick(components)
            .catch((e: any) => LOG.warn('MeshReconcile', `Reconcile tick error: ${e?.message || e}`))
            .finally(() => { running = false; });
    }, intervalMs);
    // Don't keep the process alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
    // Register the unresolved-forward nudge handler: the enqueue site
    // (forwardUnresolvedDelegateEvent) fires it after persisting an outbox row so
    // the PHASE 0 retry runs early instead of waiting for the next periodic tick.
    registerUnresolvedForwardRetryNudge(() => scheduleUnresolvedForwardNudge(components));
    LOG.info('MeshReconcile', `Mesh reconcile loop started (interval ${intervalMs}ms)`);
    return {
        stop() {
            clearInterval(timer);
            registerUnresolvedForwardRetryNudge(undefined);
            clearUnresolvedForwardNudge();
            LOG.info('MeshReconcile', 'Mesh reconcile loop stopped');
        },
    };
}

