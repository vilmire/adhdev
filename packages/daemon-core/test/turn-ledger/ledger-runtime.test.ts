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

import { meshRecord } from '../../src/mesh/mesh-record.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, recordDirectDispatchTask } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { acceptWorkerCompletionReport } from '../../src/mesh/worker-report.js';
import { __resetWorkerTaskTokensForTest, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
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
            const { task, store, ledger, ref } = setup(mesh);
            // Report while generating: recorded, awaits the idle edge (R17g).
            const recorded = ledger.observe(
                evd('worker_report', { outcome: 'completed', summary: SUMMARY, hasHandoffNotes: false }, { ...ref, source: 'worker_tool' }),
                { envelope: { workerResult: { decision: 'ok' }, finalSummary: 'local text' } },
            );
            expect(recorded).toMatchObject({ rule: 'R17g', attempt: { state: 'generating' } });
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('assigned');
            // The idle edge commits the REPORT — its envelope is the output version's.
            const result = ledger.observe(evd('turn_end', { strength: 'genuine' }, { ...ref, source: 'completion_flush_genuine' }), { envelope: { finalSummary: 'scraped text' } });
            expect(result).toMatchObject({ rule: 'R9t', attempt: { state: 'completed', terminal: { strength: 'tool_report', reason: 'worker_reported' } } });
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('completed');
            const output = store.graphStore().getLatestOutput(task.id);
            expect(output).toMatchObject({ version: 1, attempt: 1, status: 'completed' });
            expect(JSON.parse(output!.envelopeJson)).toMatchObject({ worker_result: { decision: 'ok' } });
            expect(store.turnStore().listEvents(ref.attemptRef.attemptId).filter((e) => e.kind === 'committed')).toHaveLength(1);
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

describe('mesh_direct commit flips its materialised queue row (rc.37 Finding C)', () => {
    // mesh_send_task opens a `mesh_direct` attempt (dispatch_accepted, no
    // attemptRef, eventId = taskId) and recordDirectDispatchTask materialises a
    // pre-assigned row. The reducer used to emit queue_status/graph_advance for
    // `mesh_queue` only, so the row stayed `assigned` after the ledger committed
    // (live: 2cb0ab79 committed by the scheduler, row still assigned).
    function openDirect(mesh: string) {
        const taskId = `direct-${randomUUID().slice(0, 8)}`;
        const ports = recordingPorts();
        const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher(), ports: { bus: ports.bus, cancelDispatch: ports.cancelDispatch } });
        const opened = ledger.observe(evd('dispatch_accepted', {
            scope: 'mesh_direct', messageId: taskId, meshId: mesh, nodeId: 'n1', providerType: 'claude-cli',
        } as any, { eventId: taskId, taskId, sessionId: 's1', source: 'dispatch', observedBy: 'dc', attemptRef: undefined }));
        const attemptId = opened.attempt!.attemptId;
        recordDirectDispatchTask(mesh, 'direct work', {
            id: taskId, assignedNodeId: 'n1', assignedSessionId: 's1', taskMode: 'code_change', difficulty: 'medium', attemptId,
        });
        const store = MeshRuntimeStore.getInstance();
        expect(store.findQueueEntryById(mesh, taskId)?.status).toBe('assigned');
        const ref = { attemptRef: { attemptId, generation: 0 }, taskId };
        ledger.observe(evd('delivered', { messageId: taskId, outcome: 'delivered', via: 'p2p' } as any, { ...ref, source: 'dispatch' }));
        ledger.observe(evd('turn_started', { retro: false }, ref));
        return { taskId, attemptId, store, ledger, ref };
    }

    it('a genuine turn_end commit moves the direct row assigned → completed', () => {
        const mesh = meshId();
        try {
            const { taskId, store, ledger, ref } = openDirect(mesh);
            const result = ledger.observe(evd('turn_end', { strength: 'genuine' }, ref));
            expect(result.attempt?.state).toBe('completed');
            expect(store.findQueueEntryById(mesh, taskId)?.status).toBe('completed');
        } finally {
            __clearMeshQueueForTests(mesh);
        }
    });

    it('a failed worker report moves the direct row assigned → failed', () => {
        const mesh = meshId();
        try {
            const { taskId, store, ledger, ref } = openDirect(mesh);
            expect(ledger.observe(evd('worker_report', { outcome: 'failed', summary: SUMMARY, hasHandoffNotes: false }, { ...ref, source: 'worker_tool' })).rule).toBe('R17g');
            expect(ledger.observe(evd('turn_end', { strength: 'genuine' }, ref)).rule).toBe('R9t');
            expect(store.findQueueEntryById(mesh, taskId)?.status).toBe('failed');
        } finally {
            __clearMeshQueueForTests(mesh);
        }
    });
});

// Live preview rc.44 run 12: `report_completion` was accepted (queue row flipped,
// `worker_tool_report` audit row) but the turn ledger never saw it — the idle end
// that followed re-opened await_report and the attempt committed WEAK 10 min later.
describe('report_completion reaches the turn ledger (design §F2, rc.44 run 12)', () => {
    afterEach(() => {
        setActiveTurnLedger(null);
        __resetWorkerTaskTokensForTest();
    });

    it('an accepted report while generating is observed (R17g, await_end); the idle end commits it (R9t) with one completion notice', () => {
        const mesh = meshId();
        try {
            const { task, store, ledger, ref } = setup(mesh);
            setActiveTurnLedger(ledger);
            const attemptId = ref.attemptRef.attemptId;
            const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId, sessionId: 's1' });
            const accepted = acceptWorkerCompletionReport({ token: token.token }, { outcome: 'completed', summary: 'run-12 report text', touchedFiles: [] });
            expect(accepted).toMatchObject({ accepted: true, outcome: 'completed' });
            const attempt = ledger.getAttempt(attemptId)!;
            expect(attempt).toMatchObject({ state: 'generating', terminal: null, data: { report: { generation: 0, outcome: 'completed' } } });
            expect(store.turnStore().activeHolds(attemptId).map((h) => h.reason)).toContain('await_end');

            const end = ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { ...ref, source: 'completion_flush_genuine' }));
            expect(end.rule).toBe('R9t');
            expect(ledger.getAttempt(attemptId)!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
            expect(store.turnStore().activeHolds(attemptId)).toEqual([]);
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('completed');
            const events = store.turnStore().listEvents(attemptId);
            expect(events.filter((e) => e.kind === 'committed')).toHaveLength(1);
            expect(events.filter((e) => e.kind === 'notify' && (e.payload as { notify?: string }).notify === 'completed')).toHaveLength(1);
            expect(events.filter((e) => e.kind === 'turn_end').map((e) => e.rule)).toEqual(['R9t']);
        } finally {
            __clearMeshQueueForTests(mesh);
        }
    });
});

describe('boot migration on the live store (C integration, C-W8 v2, C-W9a v3)', () => {
    it('v1 recreates no legacy table; v2 and v3 are no-op drops on a fresh store; records land in mesh_local_records (user_version 3)', () => {
        const mesh = meshId();
        const store = MeshRuntimeStore.getInstance();
        const exists = (t: string) => !!store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
        const report = store.runTurnLedgerMigrationV1({ ownerDaemonId: 'dc', exportPath: null });
        expect(report.skipped).toBe(false);
        // C-W9a: the event ledger is no longer re-created — no legacy table is.
        for (const t of ['mesh_event_ledger', 'mesh_session_delivery', 'mesh_direct_dispatches', 'mesh_turn_attempts', 'mesh_pending_events', 'mesh_inflight_hold', 'mesh_completion_fingerprints']) {
            expect(exists(t), t).toBe(false);
        }
        // Records go to the local-record table instead.
        meshRecord(mesh, 'task_dispatched', { payload: { taskId: 't-1' } }, { local: true });
        expect(store.localRecordStore().query(mesh)).toHaveLength(1);
        // Idempotent: v1 is a no-op at user_version ≥ 1.
        expect(store.runTurnLedgerMigrationV1({ ownerDaemonId: 'dc', exportPath: null }).skipped).toBe(true);
        const v2 = store.runTurnLedgerMigrationV2({ exportPath: null });
        expect(v2.skipped).toBe(false);
        expect(store.db.pragma('user_version', { simple: true })).toBe(2);
        expect(store.runTurnLedgerMigrationV2({ exportPath: null }).skipped).toBe(true);
        const v3 = store.runTurnLedgerMigrationV3({ exportPath: null, jsonlDir: null });
        expect(v3).toMatchObject({ skipped: false, droppedTables: [] });
        expect(store.db.pragma('user_version', { simple: true })).toBe(3);
        expect(store.runTurnLedgerMigrationV3({ exportPath: null, jsonlDir: null }).skipped).toBe(true);
        // The fresh record survived every step.
        expect(store.localRecordStore().query(mesh)).toHaveLength(1);
    });
});
