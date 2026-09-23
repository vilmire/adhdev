import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// The production ledger (runtime-ledger.ts) over a real MeshRuntimeStore: a
// commit flips mesh_queue + persists the graph output version in the SAME txn
// as the turn rows, with NO legacy reducer call (the C2 choke point replaces
// commitTaskTerminalAndAdvanceGraph's step 1, it does not wrap it); a reclaim
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

import * as legacyTurnLedger from '../../src/mesh/mesh-turn-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { SUMMARY, evd, fakePublisher, recordingPorts } from './ledger-harness.js';

function meshId(): string {
    return `mesh_tl_${randomUUID().slice(0, 8)}`;
}

afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function setup(mesh: string) {
    const task = enqueueTask(mesh, 'work', { taskMode: 'code_change', difficulty: 'medium' } as any);
    const store = MeshRuntimeStore.getInstance();
    store.updateQueueEntry({ ...getQueue(mesh).find((t) => t.id === task.id)!, status: 'assigned', assignedNodeId: 'n1', assignedSessionId: 's1', updatedAt: new Date().toISOString() } as any);
    const ports = recordingPorts();
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher(), ports: { bus: ports.bus, cancelDispatch: ports.cancelDispatch } });
    const ref = { attemptRef: { attemptId: `att-${task.id}`, generation: 0 }, taskId: task.id };
    ledger.observe(evd('dispatch_accepted', { scope: 'mesh_queue', messageId: 'msg-1', meshId: mesh, coordinator: { daemonId: 'dc', coordinatorRunId: 'r', sessionId: 'coord' } }, { ...ref, source: 'dispatch', observedBy: 'dc' }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { ...ref, source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }, ref));
    return { task, store, ledger, ref, ports };
}

describe('runtime ledger over mesh-runtime.db', () => {
    it('a worker report commits the attempt AND the queue row + output version in one txn, without the legacy reducer', () => {
        const mesh = meshId();
        try {
            const spy = vi.spyOn(legacyTurnLedger, 'proposeTurnCompletion');
            const { task, store, ledger, ref } = setup(mesh);
            const result = ledger.observe(
                evd('worker_report', { outcome: 'completed', summary: SUMMARY, hasHandoffNotes: false }, { ...ref, source: 'worker_tool' }),
                { envelope: { workerResult: { decision: 'ok' }, finalSummary: 'local text' } },
            );
            expect(result).toMatchObject({ rule: 'R17', attempt: { state: 'completed' } });
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('completed');
            const output = store.graphStore().getLatestOutput(task.id);
            expect(output).toMatchObject({ version: 1, attempt: 1, status: 'completed' });
            expect(JSON.parse(output!.envelopeJson)).toMatchObject({ worker_result: { decision: 'ok' } });
            expect(store.turnStore().listEvents(ref.attemptRef.attemptId).filter((e) => e.kind === 'committed')).toHaveLength(1);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            __clearMeshQueueForTests(mesh);
        }
    });

    it('a reclaim requeues the row (assignment cleared, nonce bumped) and cuts the old session', () => {
        const mesh = meshId();
        try {
            const { task, store, ledger, ref, ports } = setup(mesh);
            const before = store.findQueueEntryById(mesh, task.id)!;
            const result = ledger.observe(evd('process_exit', { exitCode: 137 }, { ...ref, source: 'pty_exit' }));
            expect(result).toMatchObject({ rule: 'R20', attempt: { generation: 1, state: 'accepted' } });
            const row = store.findQueueEntryById(mesh, task.id)!;
            expect(row.status).toBe('pending');
            expect(row.assignedSessionId).toBeUndefined();
            expect(row.dispatchNonce).toBe((before.dispatchNonce || 0) + 1);
            expect(ports.calls).toContain('cancel:s1:g0');
        } finally {
            __clearMeshQueueForTests(mesh);
        }
    });

    it('a replayed commit against an already-terminal queue row advances nothing twice (replay fence kept)', () => {
        const mesh = meshId();
        try {
            const { task, store, ledger, ref } = setup(mesh);
            ledger.observe(evd('turn_end', { strength: 'genuine' }, ref));
            expect(store.graphStore().getLatestOutput(task.id)?.version).toBe(1);
            // A legacy writer flips nothing new; a second (recorded) scrape cannot re-advance.
            ledger.observe(evd('turn_end', { strength: 'genuine' }, ref));
            expect(store.graphStore().getLatestOutput(task.id)?.version).toBe(1);
        } finally {
            __clearMeshQueueForTests(mesh);
        }
    });
});

describe('boot migration on the live store (C integration)', () => {
    it('leaves the migrating boot with the legacy tables recreated EMPTY — the state every later open has — so remaining legacy writers do not throw until a restart', () => {
        const mesh = meshId();
        const store = MeshRuntimeStore.getInstance();
        const report = store.runTurnLedgerMigrationV1({ ownerDaemonId: 'dc', exportPath: null });
        expect(report.skipped).toBe(false);
        expect(report.droppedTables).toEqual(expect.arrayContaining(['mesh_session_delivery', 'mesh_event_ledger']));
        const exists = (t: string) => !!store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
        expect(exists('mesh_session_delivery')).toBe(true);
        expect(exists('mesh_event_ledger')).toBe(true);
        // A remaining writer works in the same boot.
        store.appendLedgerEntry({ id: randomUUID(), meshId: mesh, timestamp: new Date().toISOString(), kind: 'task_dispatched' });
        expect(store.readLedgerEntriesOrdered(mesh)).toHaveLength(1);
        // Idempotent: the second run is a no-op at user_version 1.
        expect(store.runTurnLedgerMigrationV1({ ownerDaemonId: 'dc', exportPath: null }).skipped).toBe(true);
    });
});
