import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// (copy of the ledger-runtime header) The production ledger (runtime-ledger.ts) over a real MeshRuntimeStore: a
// commit flips mesh_queue + persists the graph output version in the SAME txn
// as the turn rows, with NO legacy reducer call (the C2 choke point replaces
// commitTaskTerminal's replay fence, it does not wrap it); a reclaim
// requeues the row.

const testTmpDir = path.join(tmpdir(), `adhdev-turn-ledger-rt-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));

import { createNoticeSubmitInventory } from '../../src/mesh/turn-ledger/notice-submit-inventory.js';
import { createTurnDeliverHandler, createDeliverEdgeWaiter } from '../../src/mesh/turn-ledger/deliver.js';
import { observeAcceptedWorkerReport } from '../../src/mesh/turn-ledger/worker-report-evidence.js';
import { meshRecord } from '../../src/mesh/mesh-record.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, recordDirectDispatchTask } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { acceptWorkerCompletionReport } from '../../src/mesh/worker-report.js';
import { __resetWorkerTaskTokensForTest, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
import { T0, evd, fakePublisher, recordingPorts } from './ledger-harness.js';

function meshId(): string {
    return `mesh_wu_${randomUUID().slice(0, 8)}`;
}

afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const DAY = 24 * 3_600_000;

function setup(mesh: string) {
    const task = enqueueTask(mesh, 'work', { taskMode: 'code_change', difficulty: 'medium' } as any);
    const store = MeshRuntimeStore.getInstance();
    store.updateQueueEntry({ ...getQueue(mesh).find((t) => t.id === task.id)!, status: 'assigned', assignedNodeId: 'n1', assignedSessionId: 's1', updatedAt: new Date().toISOString() } as any);
    const ports = recordingPorts();
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', now: () => T0, publisher: fakePublisher(), ports: { bus: ports.bus, cancelDispatch: ports.cancelDispatch } });
    const ref = { attemptRef: { attemptId: `att-${task.id}`, generation: 0 }, taskId: task.id };
    ledger.observe(evd('dispatch_accepted', { scope: 'mesh_queue', messageId: 'msg-1', meshId: mesh, nodeId: 'n1', coordinator: { daemonId: 'dc', coordinatorRunId: 'r', sessionId: 'coord' } }, { ...ref, source: 'dispatch', observedBy: 'dc' }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { ...ref, source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }, ref));
    // The writer dies; the stop cannot be confirmed because its node is unreachable.
    ledger.observe(evd('session_error', { reason: 'provider_error' }, ref));
    expect(ledger.getAttempt(ref.attemptRef.attemptId)?.state).toBe('stopping');
    return { task, store, ledger, ref, ports };
}

/** A ledger over the same durable state, with a controllable clock and node reachability. */
function resumed(ports: any, clock: { at: number }, over: Record<string, unknown> = {}) {
    // Late-bound so a test can swap the stop port's answer after the ledger exists.
    return createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', now: () => clock.at, publisher: fakePublisher(), ports: { ...ports, cancelDispatch: (r: any) => ports.cancelDispatch(r), ...over } });
}

describe('stopping attempt bounded by writer-node unreachability', () => {
    const unreachable = () => { throw new Error('p2p_timeout'); };

    it('keeps stopping while the node has been unreachable for less than the bound', async () => {
        const mesh = meshId();
        const { task, store, ref, ports } = setup(mesh);
        ports.cancelDispatch = unreachable;
        const clock = { at: T0 + 1_000 };
        const live = resumed(ports, clock);
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        clock.at += DAY - 60_000;
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        expect(live.getAttempt(ref.attemptRef.attemptId)?.state).toBe('stopping');
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('assigned');
    });

    it('settles once, as failed writer_unreachable with one failed notice, past the bound', async () => {
        const mesh = meshId();
        const { task, store, ref, ports } = setup(mesh);
        ports.cancelDispatch = unreachable;
        const clock = { at: T0 + 1_000 };
        const live = resumed(ports, clock);
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        clock.at += DAY + 1_000;
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        const settled = live.getAttempt(ref.attemptRef.attemptId)!;
        expect(settled).toMatchObject({ state: 'failed', terminal: { outcome: 'failed', reason: 'writer_unreachable' } });
        expect(settled.data.writerStop?.settledBy).toBe('unreachable_bound');
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('failed');
        expect(ports.calls.filter((c) => c === 'revoke:s1')).toHaveLength(1);
        // Idempotent: a later tick neither re-settles nor re-notifies.
        clock.at += DAY;
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        const events = store.turnStore().listEvents(ref.attemptRef.attemptId);
        expect(events.filter((e) => e.kind === 'committed')).toHaveLength(1);
        expect(events.filter((e) => e.kind === 'notify' && (e.payload as { notify?: string }).notify === 'failed')).toHaveLength(1);
    });

    it('a reachable-but-not-quiescent answer resets the unreachable clock', async () => {
        const mesh = meshId();
        const { ref, ports } = setup(mesh);
        ports.cancelDispatch = unreachable;
        const clock = { at: T0 + 1_000 };
        const live = resumed(ports, clock);
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        clock.at += DAY - 1_000;
        ports.cancelDispatch = (r: any) => ({ ...r, success: true, quiescent: false });
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        ports.cancelDispatch = unreachable;
        clock.at += 2_000;
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        expect(live.getAttempt(ref.attemptRef.attemptId)?.state).toBe('stopping');
    });

    it('settles a writer whose node was removed from the mesh (two consecutive sightings)', async () => {
        const mesh = meshId();
        const { task, store, ref, ports } = setup(mesh);
        ports.cancelDispatch = unreachable;
        const clock = { at: T0 + 1_000 };
        const live = resumed(ports, clock, { writerNodeRemoved: () => true });
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        expect(live.getAttempt(ref.attemptRef.attemptId)?.state).toBe('stopping');
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        expect(live.getAttempt(ref.attemptRef.attemptId)).toMatchObject({ state: 'failed', terminal: { reason: 'writer_unreachable' } });
        expect(live.getAttempt(ref.attemptRef.attemptId)?.data.writerStop?.settledBy).toBe('node_removed');
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('failed');
    });

    it('a node returning after settlement cannot resurrect the attempt or the task', async () => {
        const mesh = meshId();
        const { task, store, ref, ports } = setup(mesh);
        ports.cancelDispatch = unreachable;
        const clock = { at: T0 + 1_000 };
        const live = resumed(ports, clock);
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        clock.at += DAY + 1_000;
        await live.resumeStoppingWriters(ref.attemptRef.attemptId);
        expect(live.getAttempt(ref.attemptRef.attemptId)?.state).toBe('failed');
        // The node comes back, still holding the session: its late turn end / completion /
        // quiescence receipt are all rejected against the terminal attempt.
        const late = live.observe(evd('turn_end', { strength: 'genuine' }, { ...ref, at: clock.at, source: 'completion_flush_genuine' }));
        expect(late.verdict).not.toBe('applied');
        ports.cancelDispatch = (r: any) => ({ ...r, success: true, quiescent: true, incarnation: 'returned-writer' });
        await live.resumeStoppingWriters();
        expect(live.getAttempt(ref.attemptRef.attemptId)).toMatchObject({ state: 'failed', terminal: { reason: 'writer_unreachable' } });
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('failed');
        expect(store.turnStore().listEvents(ref.attemptRef.attemptId).filter((e) => e.kind === 'committed')).toHaveLength(1);
    });

    it('ADHDEV_STOPPING_UNREACHABLE_MAX_MS resolves into the policy (default 24 h)', async () => {
        const { resolveTurnPolicy, DEFAULT_TURN_POLICY } = await import('../../src/mesh/turn-ledger/policy.js');
        expect(DEFAULT_TURN_POLICY.stoppingUnreachableMaxMs).toBe(DAY);
        expect(resolveTurnPolicy({ ADHDEV_STOPPING_UNREACHABLE_MAX_MS: '3600000' }).stoppingUnreachableMaxMs).toBe(3_600_000);
    });
});
