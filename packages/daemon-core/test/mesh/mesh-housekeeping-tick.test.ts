import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// C4 (C-W4): the reconcile loop's NON-turn half. It keeps config/cache sync,
// graph gate timeouts / staleness / workspace-saga leases, the DS3 catch-up,
// disk + worktree retention and the idle reaper — and holds no turn or hold
// logic. The queue claim is exported for the turn scheduler's claim phase.

const mocks = vi.hoisted(() => ({
    listMeshes: vi.fn(() => [] as any[]),
    getMesh: vi.fn(() => undefined),
    catchup: vi.fn(async () => {}),
    disk: vi.fn(),
    orphan: vi.fn(async () => {}),
    reap: vi.fn(async () => {}),
    gates: vi.fn(() => ({ expiredGateIds: [] as string[] })),
    staleness: vi.fn(),
    saga: vi.fn(async () => {}),
    trigger: vi.fn(async () => ({})),
    pendingCount: vi.fn(() => 0),
    runtimeRetention: vi.fn(),
}));

vi.mock('../../src/config/config.js', () => ({ getMachineId: () => 'mach_self', getConfigDir: () => '/tmp/adhdev-hk-test', loadConfig: () => ({ machineId: 'mach_self' }), getMachineNickname: () => null }));
vi.mock('../../src/config/mesh-config.js', () => ({ listMeshes: mocks.listMeshes, getMesh: mocks.getMesh }));
vi.mock('../../src/mesh/mesh-auto-fast-forward.js', () => ({ runPendingCoordinatorCatchupScan: mocks.catchup }));
vi.mock('../../src/mesh/mesh-disk-retention.js', () => ({ runDiskRetentionSweep: mocks.disk, detectAndSignalOrphanWorktrees: mocks.orphan }));
vi.mock('../../src/mesh/mesh-worktree-retention.js', () => ({ runWorktreeNodeRetentionTick: vi.fn(async () => {}) }));
vi.mock('../../src/mesh/mesh-idle-session-reaper.js', () => ({ runIdleSessionReapPass: mocks.reap }));
vi.mock('../../src/mesh/mesh-retention-config.js', () => ({ resolveWorktreeNodeRetentionGraceMs: () => 0 }));
vi.mock('../../src/mesh/mesh-graph-gates.js', () => ({ sweepMeshGraphGateTimeouts: mocks.gates }));
vi.mock('../../src/mesh/mesh-graph-staleness.js', () => ({ sweepMeshGraphStaleness: mocks.staleness }));
vi.mock('../../src/mesh/mesh-graph-workspace-saga.js', () => ({ recoverExpiredWorkspaceSagas: mocks.saga }));
vi.mock('../../src/mesh/mesh-graph-workspace-ports.js', () => ({ createDefaultWorkspaceSagaPorts: () => ({}) }));
vi.mock('../../src/mesh/mesh-graph-provenance.js', () => ({ recordGraphGateExpired: vi.fn() }));
vi.mock('../../src/mesh/mesh-events-coordinator.js', () => ({ triggerMeshQueue: mocks.trigger }));
vi.mock('../../src/mesh/mesh-runtime-store.js', () => ({
    pruneMeshRuntimeRetention: mocks.runtimeRetention,
    MeshRuntimeStore: {
        getInstance: () => ({
            graphStore: () => ({ listGatesByMesh: () => [] }),
            pendingQueueTaskCount: mocks.pendingCount,
        }),
    },
}));

import {
    DISK_RETENTION_INTERVAL_MS,
    IDLE_SESSION_REAP_INTERVAL_MS,
    claimPendingQueues,
    runMeshHousekeepingTick,
    type HousekeepingState,
} from '../../src/mesh/mesh-housekeeping-tick.js';

const HOSTED = { id: 'mesh-hosted', nodes: [{ id: 'n1', daemonId: 'daemon_mach_self' }], meshHost: { role: 'host', hostDaemonId: 'daemon_mach_self' } };
const FOREIGN = { id: 'mesh-foreign', nodes: [{ id: 'n2', daemonId: 'daemon_mach_other' }], meshHost: { role: 'host', hostDaemonId: 'daemon_mach_other' } };

function components() {
    return {
        statusInstanceId: 'daemon_mach_self',
        router: {
            getCachedInlineMesh: vi.fn(() => undefined),
            deps: { sessionHostControl: { listSessions: async () => [] } },
            cleanupMeshSessions: vi.fn(),
        },
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMeshes.mockReturnValue([HOSTED, FOREIGN]);
});

describe('mesh housekeeping tick', () => {
    it('reads meshes.json ONCE per tick and runs every phase only for meshes this daemon hosts', async () => {
        await runMeshHousekeepingTick(components(), {}, 1_000);
        expect(mocks.listMeshes).toHaveBeenCalledTimes(1);
        expect(mocks.catchup).toHaveBeenCalledTimes(1);
        expect((mocks.catchup.mock.calls[0] as any[])[1]).toMatchObject({ id: 'mesh-hosted' });
        expect(mocks.gates).toHaveBeenCalledWith('mesh-hosted');
        expect(mocks.staleness).toHaveBeenCalledWith('mesh-hosted');
        expect(mocks.saga).toHaveBeenCalledWith('mesh-hosted', expect.anything());
        expect(mocks.gates).not.toHaveBeenCalledWith('mesh-foreign');
    });

    it('never claims the queue itself (the turn scheduler owns the claim phase)', async () => {
        mocks.pendingCount.mockReturnValue(3);
        await runMeshHousekeepingTick(components(), {}, 1_000);
        expect(mocks.trigger).not.toHaveBeenCalled();
        await claimPendingQueues(components());
        expect(mocks.trigger).toHaveBeenCalledTimes(1);
        expect(mocks.trigger).toHaveBeenCalledWith(expect.anything(), 'mesh-hosted');
    });

    it('claimPendingQueues skips a hosted mesh with no pending rows (O(1) COUNT)', async () => {
        mocks.pendingCount.mockReturnValue(0);
        await claimPendingQueues(components());
        expect(mocks.trigger).not.toHaveBeenCalled();
    });

    it('disk retention is hourly and the idle reaper runs every 5 minutes', async () => {
        const state: HousekeepingState = {};
        const c = components();
        await runMeshHousekeepingTick(c, state, 0);
        await runMeshHousekeepingTick(c, state, 4_000);
        expect(mocks.disk).toHaveBeenCalledTimes(1);
        expect(mocks.reap).toHaveBeenCalledTimes(1);
        await runMeshHousekeepingTick(c, state, IDLE_SESSION_REAP_INTERVAL_MS);
        expect(mocks.reap).toHaveBeenCalledTimes(2);
        expect(mocks.disk).toHaveBeenCalledTimes(1);
        await runMeshHousekeepingTick(c, state, DISK_RETENTION_INTERVAL_MS);
        expect(mocks.disk).toHaveBeenCalledTimes(2);
        // mesh-runtime.db row retention rides the same hourly cadence (C-W8 re-homed it).
        expect(mocks.runtimeRetention).toHaveBeenCalledTimes(2);
    });

    it('a failing phase is isolated — the rest of the tick still runs', async () => {
        mocks.catchup.mockRejectedValueOnce(new Error('boom'));
        mocks.gates.mockImplementationOnce(() => { throw new Error('gate boom'); });
        await expect(runMeshHousekeepingTick(components(), {}, 1_000)).resolves.toBeUndefined();
        expect(mocks.staleness).toHaveBeenCalled();
        expect(mocks.saga).toHaveBeenCalled();
    });

    it('holds NO turn or hold logic: no turn-ledger / legacy ledger / hold module in its imports', () => {
        const src = readFileSync(join(import.meta.dirname, '../../src/mesh/mesh-housekeeping-tick.ts'), 'utf8');
        const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        for (const spec of imports) {
            expect(spec, spec).not.toMatch(/turn-ledger|mesh-turn-ledger|acked-hold|stranded|synthesis|live-gate|events-pending|remote-event-pull/);
        }
        expect(src).not.toMatch(/updateTaskStatus|\.observe\(/);
    });
});
