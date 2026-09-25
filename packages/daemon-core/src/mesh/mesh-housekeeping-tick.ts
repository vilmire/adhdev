// ---------------------------------------------------------------------------
// mesh-housekeeping-tick — the non-turn half of the old reconcile loop
// ---------------------------------------------------------------------------
// Wiring-unification Phase C4 (C-W4). `mesh-reconcile-loop.ts` ran ten phases
// on one 4 s timer; the turn-lifecycle ones (remote pull, live-coordinator
// inject, stranded/zombie/unsettled watchdogs, transcript synth, direct-dispatch
// auto-prune, unresolved-forward retry) are gone — the turn ledger's scheduler
// (`turn-ledger/scheduler.ts`), the `turn.deliver` cursor and topic replication
// replace them. What is left here holds NO turn or hold logic: config/cache
// sync, graph gate timeouts / staleness / workspace-saga leases, the DS3
// coordinator catch-up, disk + worktree retention and the idle-session reaper.
// The queue claim (old PHASE 3) is exported for the scheduler's claim phase,
// because a ledger reclaim returns a row to `pending` and the claim must run
// in the same tick.
//
// Cadences are unchanged: the cheap phases every tick, disk/worktree
// retention hourly, the idle reaper every 5 minutes.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-components.js';
import { getMachineId } from '../config/config.js';
import { listMeshes, getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { triggerMeshQueue } from './mesh-events-coordinator.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { resolveCoordinatorDaemonIds, daemonHostsMesh, resolveCoordinatorSelfIds } from './mesh-reconcile-identity.js';
import { runDiskRetentionSweep, detectAndSignalOrphanWorktrees } from './mesh-disk-retention.js';
import { pruneMeshRuntimeRetention } from './mesh-runtime-store.js';
import { runWorktreeNodeRetentionTick, type WorktreeRetentionDeps } from './mesh-worktree-retention.js';
import { runIdleSessionReapPass, type IdleSessionReaperDeps } from './mesh-idle-session-reaper.js';
import { resolveWorktreeNodeRetentionGraceMs } from './mesh-retention-config.js';
import { runPendingCoordinatorCatchupScan } from './mesh-auto-fast-forward.js';
import { recoverExpiredWorkspaceSagas } from './mesh-graph-workspace-saga.js';
import { createDefaultWorkspaceSagaPorts } from './mesh-graph-workspace-ports.js';
import { sweepMeshGraphGateTimeouts } from './mesh-graph-gates.js';
import { sweepMeshGraphStaleness } from './mesh-graph-staleness.js';
import { sweepMeshGraphStalls } from './mesh-graph-stall.js';
import { recordGraphGateExpired } from './mesh-graph-provenance.js';

/** Disk/worktree retention: artifacts age in days and the fs/git walk is heavy — hourly. */
export const DISK_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Idle delegated-session reaper: bounds a 30 min TTL's overshoot to +5 min. */
export const IDLE_SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000;

export interface HousekeepingState {
    lastDiskRetentionRunAt?: number;
    lastIdleSessionReapRunAt?: number;
}

/** The meshes this daemon hosts this tick, with the id-set each is hosted under. */
export function hostedMeshes(components: DaemonComponents, meshes: readonly LocalMeshEntry[] = listMeshes()): Array<{ mesh: LocalMeshEntry; selfIds: string[] }> {
    const drainDaemonIds = resolveCoordinatorDaemonIds(components);
    const out: Array<{ mesh: LocalMeshEntry; selfIds: string[] }> = [];
    for (const mesh of meshes) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (daemonHostsMesh(mesh, selfIds)) out.push({ mesh, selfIds });
    }
    return out;
}

/**
 * Queue claim net (old PHASE 3): for every hosted mesh with at least one
 * pending row, one `triggerMeshQueue`. O(1) per idle mesh (an indexed COUNT).
 * Skipped entirely when SQLite is unavailable. The turn scheduler runs this
 * as its claim phase, right after the hold sweep / probe that may have
 * reclaimed a row.
 */
export async function claimPendingQueues(components: DaemonComponents, meshes?: readonly LocalMeshEntry[]): Promise<void> {
    let store: MeshRuntimeStore | undefined;
    try { store = MeshRuntimeStore.getInstance(); } catch { return; }
    for (const { mesh } of hostedMeshes(components, meshes)) {
        try {
            if (store.pendingQueueTaskCount(mesh.id) === 0) continue;
        } catch { /* fall through and let triggerMeshQueue decide */ }
        try {
            await triggerMeshQueue(components, mesh.id);
        } catch (e: any) {
            LOG.warn('MeshHousekeeping', `Pending-claim trigger failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }
}

/**
 * One housekeeping pass. Each phase is isolated per mesh — a fault in one
 * never stops the rest. `meshes` is read ONCE per tick (listMeshes re-parses
 * meshes.json on every call).
 */
export async function runMeshHousekeepingTick(
    components: DaemonComponents,
    state: HousekeepingState = {},
    nowMs: number = Date.now(),
): Promise<void> {
    const meshesSnapshot = listMeshes();
    const hosted = hostedMeshes(components, meshesSnapshot);
    let store: MeshRuntimeStore | undefined;
    try { store = MeshRuntimeStore.getInstance(); } catch { store = undefined; }

    // ── inline-cache membership merge (MESH-MEMBERSHIP-INLINE-CACHE-SYNC) ──
    // A membership change made by another daemon (or a meshes.json edit) reaches
    // only the file config; fold it into an ALREADY-warm router cache entry. Never
    // warm a cold entry — that would switch fresh `local_config` reads to a
    // snapshot as stale as the last tick.
    if (components.router) {
        for (const mesh of meshesSnapshot) {
            try {
                if (components.router.getCachedInlineMesh(mesh.id)) components.router.getCachedInlineMesh(mesh.id, mesh);
            } catch (e: any) {
                LOG.warn('MeshHousekeeping', `Inline-cache membership merge failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── DS3 coordinator local catch-up ──
    // Drain coordinator_catchup markers a remote Refinery queued and guarded-ff
    // this daemon's base checkout (busy → deferred; ahead/diverged/dirty → blocked).
    for (const { mesh } of hosted) {
        try {
            await runPendingCoordinatorCatchupScan(components, mesh);
        } catch (e: any) {
            LOG.warn('MeshHousekeeping', `Coordinator catch-up scan failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }

    if (store) {
        // ── graph coordinator-gate deadline sweep ──
        // Can only EXPIRE a gate, never release one: elapsed time is not
        // completion evidence. A lapsed lease is reported, never acted on.
        for (const { mesh } of hosted) {
            try {
                const gateStore = store.graphStore();
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
                LOG.warn('MeshHousekeeping', `Graph gate sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }

        // ── graph/gate staleness reminders (read-only visibility) ──
        for (const { mesh } of hosted) {
            try {
                sweepMeshGraphStaleness(mesh.id);
            } catch (e: any) {
                LOG.warn('MeshHousekeeping', `Graph staleness sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
            // N(c): an `active` graph where nothing can move pages once per stuck state.
            try {
                sweepMeshGraphStalls(mesh.id);
            } catch (e: any) {
                LOG.warn('MeshHousekeeping', `Graph stall sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }

        // ── workspace-saga lease recovery ──
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
        for (const { mesh } of hosted) {
            try {
                await recoverExpiredWorkspaceSagas(mesh.id, workspacePorts);
            } catch (e: any) {
                LOG.warn('MeshHousekeeping', `Workspace saga recover failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── disk / worktree retention (hourly) ──
    const diskDue = state.lastDiskRetentionRunAt === undefined
        || (nowMs - state.lastDiskRetentionRunAt) >= DISK_RETENTION_INTERVAL_MS;
    if (diskDue) {
        state.lastDiskRetentionRunAt = nowMs;
        try {
            runDiskRetentionSweep(nowMs);
        } catch (e: any) {
            LOG.warn('MeshHousekeeping', `Disk retention sweep failed: ${e?.message || e}`);
        }
        // mesh-runtime.db row retention (tool-call log, terminal queue rows,
        // terminal session deliveries, terminal mesh turn attempts, graph
        // control plane). Its hourly caller went with the retired reconcile
        // loop (C-W3/C-W4, 2ddca06f) — re-homed here on the same cadence (C-W8).
        // Best-effort by construction (never throws).
        pruneMeshRuntimeRetention();
        for (const { mesh } of hosted) {
            try {
                await detectAndSignalOrphanWorktrees(mesh, nowMs);
            } catch (e: any) {
                LOG.warn('MeshHousekeeping', `Orphan worktree detection failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
        // Converged local worktree-node retention (grace 0 disables).
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
            const tickId = `housekeeping-${nowMs}`;
            for (const { mesh } of hosted) {
                try {
                    await runWorktreeNodeRetentionTick(retentionDeps, { mesh, nowMs, tickId, execute: true, executeMode: 'auto' });
                } catch (e: any) {
                    LOG.warn('MeshHousekeeping', `Worktree-node retention failed for mesh ${mesh.id}: ${e?.message || e}`);
                }
            }
        }
    }

    // ── idle delegated-session reaper (5 min) ──
    // Stops the CLI runtime of a coordinator-launched delegate idle past the
    // mesh's delegatedSessionIdleTtlMinutes; the session-host record is kept.
    if (components.router) {
        const reapDue = state.lastIdleSessionReapRunAt === undefined
            || (nowMs - state.lastIdleSessionReapRunAt) >= IDLE_SESSION_REAP_INTERVAL_MS;
        if (reapDue) {
            state.lastIdleSessionReapRunAt = nowMs;
            const router = components.router;
            const reaperDeps: IdleSessionReaperDeps = {
                listSessions: async () => {
                    try { return await router.deps.sessionHostControl?.listSessions() ?? []; } catch { return []; }
                },
                cleanupMeshSessions: args => router.cleanupMeshSessions(args as Parameters<typeof router.cleanupMeshSessions>[0]),
            };
            for (const { mesh } of hosted) {
                try {
                    await runIdleSessionReapPass(reaperDeps, { meshId: mesh.id, policy: getMesh(mesh.id)?.policy, now: nowMs });
                } catch (e: any) {
                    LOG.warn('MeshHousekeeping', `Idle session reap failed for mesh ${mesh.id}: ${e?.message || e}`);
                }
            }
        }
    }
}

export interface HousekeepingHandle {
    stop(): void;
}

/**
 * Start the housekeeping timer (single-flight, unref'd). `claim` runs the
 * queue claim here too — only when no turn scheduler owns the claim phase.
 */
export function startMeshHousekeeping(components: DaemonComponents, intervalMs: number, opts: { claim?: boolean } = {}): HousekeepingHandle {
    const state: HousekeepingState = {};
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        void (async () => {
            await runMeshHousekeepingTick(components, state);
            if (opts.claim) await claimPendingQueues(components);
        })()
            .catch((e: any) => LOG.warn('MeshHousekeeping', `Housekeeping tick error: ${e?.message || e}`))
            .finally(() => { running = false; });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    LOG.info('MeshHousekeeping', `Mesh housekeeping started (interval ${intervalMs}ms, local daemon ${readNonEmptyString(getMachineId()) || 'unknown'})`);
    return {
        stop() {
            clearInterval(timer);
            LOG.info('MeshHousekeeping', 'Mesh housekeeping stopped');
        },
    };
}
