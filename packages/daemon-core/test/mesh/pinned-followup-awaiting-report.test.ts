import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Live deadlock 2026-11-07 (bcde60ec / 6237d42f): a follow-up pinned to an IDLE session
// whose current mesh attempt only awaits its report was refused `session_already_assigned`.

const testTmpDir = path.join(tmpdir(), `adhdev-pinned-followup-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => { if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: vi.fn(), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => [] as any[]) }));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshClaimRefusal } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { supersedeAwaitingReportForPinnedFollowup } from '../../src/mesh/mesh-pinned-followup-supersede.js';
import { fakePublisher, recordingPorts, evd } from '../turn-ledger/ledger-harness.js';

const NODE = 'n1';
const SESSION = 's1';

afterEach(() => {
    vi.restoreAllMocks();
    setActiveTurnLedger(null as any);
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function scenario(opts: { endTurn: boolean }) {
    const mesh = `mesh_pf_${randomUUID().slice(0, 8)}`;
    const store = MeshRuntimeStore.getInstance();
    const old = enqueueTask(mesh, 'validate', { taskMode: 'code_change', difficulty: 'medium' } as any);
    store.updateQueueEntry({ ...getQueue(mesh).find(t => t.id === old.id)!, status: 'assigned', assignedNodeId: NODE, assignedSessionId: SESSION, updatedAt: new Date().toISOString() } as any);
    const ports = recordingPorts();
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher(), ports: { bus: ports.bus, cancelDispatch: ports.cancelDispatch } });
    setActiveTurnLedger(ledger);
    const ref = { attemptRef: { attemptId: `att-${old.id}`, generation: 0 }, taskId: old.id, sessionId: SESSION };
    ledger.observe(evd('dispatch_accepted', { scope: 'mesh_queue', messageId: 'msg-1', meshId: mesh, nodeId: NODE, coordinator: { daemonId: 'dc', coordinatorRunId: 'r', sessionId: 'coord' } }, { ...ref, source: 'dispatch', observedBy: 'dc' }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { ...ref, source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }, ref));
    if (opts.endTurn) ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { ...ref, source: 'completion_flush_genuine' }));
    const followup = enqueueTask(mesh, 'diagnose and report', { taskMode: 'code_change', difficulty: 'medium' } as any);
    store.updateQueueEntry({ ...getQueue(mesh).find(t => t.id === followup.id)!, targetSessionId: SESSION, updatedAt: new Date().toISOString() } as any);
    return { mesh, store, old, followup, ledger, ref, ports };
}

function claim(mesh: string) {
    const refusal: MeshClaimRefusal = {};
    const task = MeshRuntimeStore.getInstance().claimNextQueueTask(mesh, NODE, SESSION, [], { outRefusal: refusal });
    return { task, refusal };
}

describe('session-pinned follow-up vs an attempt awaiting its report', () => {
    it('deadlock: refused session_already_assigned, then delivered once the awaiting attempt is superseded', () => {
        const { mesh, store, old, followup, ledger, ref, ports } = scenario({ endTurn: true });
        try {
            expect(ledger.getAttempt(ref.attemptRef.attemptId)).toMatchObject({ state: 'finalizing' });
            const before = claim(mesh);
            expect(before.task).toBeNull();
            expect(before.refusal.reason).toBe('session_already_assigned');

            const res = supersedeAwaitingReportForPinnedFollowup(mesh, SESSION, { sessionIdle: true });
            expect(res.superseded).toEqual([old.id]);
            // earlier attempt settled on the ledger (not silently dropped), writer NOT stopped, row terminal+visible
            expect(ledger.getAttempt(ref.attemptRef.attemptId)?.terminal).toMatchObject({ outcome: 'failed' });
            expect(ports.calls.filter((c: string) => c.startsWith('cancel'))).toEqual([]);
            const oldRow = store.findQueueEntryById(mesh, old.id)!;
            expect(oldRow.status).toBe('failed');

            const after = claim(mesh);
            expect(after.task?.id).toBe(followup.id);
            expect(after.task?.assignedSessionId).toBe(SESSION);
            // idempotent: nothing more to supersede, the old task is not delivered into the busy session
            expect(supersedeAwaitingReportForPinnedFollowup(mesh, SESSION, { sessionIdle: true }).superseded).toEqual([]);
            expect(claim(mesh).task).toBeNull();
        } finally { __clearMeshQueueForTests(mesh); }
    });

    it('negative: a busy session is never touched', () => {
        const { mesh, store, old, ledger, ref } = scenario({ endTurn: true });
        try {
            const res = supersedeAwaitingReportForPinnedFollowup(mesh, SESSION, { sessionIdle: false });
            expect(res).toEqual({ superseded: [], skipped: 'session_busy' });
            expect(store.findQueueEntryById(mesh, old.id)?.status).toBe('assigned');
            expect(ledger.getAttempt(ref.attemptRef.attemptId)?.terminal).toBeFalsy();
            expect(claim(mesh).refusal.reason).toBe('session_already_assigned');
        } finally { __clearMeshQueueForTests(mesh); }
    });

    it('negative: a generating attempt (turn not ended) is never superseded', () => {
        const { mesh, store, old } = scenario({ endTurn: false });
        try {
            const res = supersedeAwaitingReportForPinnedFollowup(mesh, SESSION, { sessionIdle: true });
            expect(res).toEqual({ superseded: [], skipped: 'not_awaiting_report' });
            expect(store.findQueueEntryById(mesh, old.id)?.status).toBe('assigned');
            expect(claim(mesh).refusal.reason).toBe('session_already_assigned');
        } finally { __clearMeshQueueForTests(mesh); }
    });

    it('negative: without a pinned follow-up nothing is superseded', () => {
        const { mesh, store, old, followup } = scenario({ endTurn: true });
        try {
            store.updateQueueEntry({ ...store.findQueueEntryById(mesh, followup.id)!, targetSessionId: 'other_session' } as any);
            expect(supersedeAwaitingReportForPinnedFollowup(mesh, SESSION, { sessionIdle: true })).toEqual({ superseded: [], skipped: 'no_pinned_followup' });
            expect(store.findQueueEntryById(mesh, old.id)?.status).toBe('assigned');
        } finally { __clearMeshQueueForTests(mesh); }
    });

    it('negative: a task other live work depends on is never failed by the supersede', () => {
        const { mesh, store, old } = scenario({ endTurn: true });
        try {
            const dep = enqueueTask(mesh, 'after old', { taskMode: 'code_change', difficulty: 'medium' } as any);
            store.updateQueueEntry({ ...store.findQueueEntryById(mesh, dep.id)!, dependsOn: [old.id] } as any);
            expect(supersedeAwaitingReportForPinnedFollowup(mesh, SESSION, { sessionIdle: true })).toEqual({ superseded: [], skipped: 'has_dependents' });
            expect(store.findQueueEntryById(mesh, old.id)?.status).toBe('assigned');
        } finally { __clearMeshQueueForTests(mesh); }
    });
});
