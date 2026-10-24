import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// The production ledger (runtime-ledger.ts) over a real MeshRuntimeStore: a
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

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { acceptWorkerCompletionReport } from '../../src/mesh/worker-report.js';
import { __resetWorkerTaskTokensForTest, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
import { claimNextTask, getMeshQueueStats, updateTaskStatus, requeueTaskForLedgerReclaim } from '../../src/mesh/mesh-work-queue.js';
import { summarizeMissionTasks, isMissionAllTasksTerminal, upsertMeshMission, maybeEmitMissionCloseCandidate, getMeshMission } from '../../src/mesh/mesh-missions.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { getLocalRecordSummary, readTurnTerminalViews } from '../../src/mesh/mesh-local-records.js';
import { computeMeshTaskStats, rollupMissionStats } from '../../src/mesh/mesh-task-stats.js';
import { legacyWorkerBlockedTasks, projectWorkerOutcomeViews } from '../../src/mesh/mesh-worker-outcome-view.js';
import { SUMMARY, evd, fakePublisher, recordingPorts } from './ledger-harness.js';

function meshId(): string {
    return `mesh_tl_${randomUUID().slice(0, 8)}`;
}

afterEach(() => {
    setActiveTurnLedger(null);
    __resetWorkerTaskTokensForTest();
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

describe('RC28 worker reported blocked outcome', () => {
    for (const outcome of ['blocked', 'failed', 'completed'] as const) {
        it(`${outcome}: actual report persists independently of branch convergence after reload and end`, async () => {
            const mesh = meshId();
            const { task, store, ledger, ref } = setup(mesh);
            const row = store.findQueueEntryById(mesh, task.id)!;
            const mission = upsertMeshMission(mesh, { title: 'Review readiness', goal: 'Await independent review', status: 'active' });
            store.updateQueueEntry({ ...row, ...(outcome === 'completed' ? { readonly: true, taskMode: 'live_debug_readonly' as const } : {}), missionId: mission.id, attemptId: ref.attemptRef.attemptId });
            const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId: ref.attemptRef.attemptId, sessionId: 's1' });
            setActiveTurnLedger(ledger);
            const result = acceptWorkerCompletionReport({ token: token.token }, {
                outcome, summary: outcome === 'completed' ? 'Read-only review complete: REQUESTCHANGES' : 'Committed work awaits independent review',
                branchState: 'blocked_review', blockers: outcome === 'blocked' ? ['Independent review required'] : [], touchedFiles: [],
            });
            expect(result.accepted).toBe(true);
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe(outcome);
            expect(store.getLatestTaskOutput(task.id)).toMatchObject({ status: outcome, version: 1 });
            const end = ledger.observe(evd('turn_end', { strength: 'genuine' }, { ...ref, source: 'completion_flush_genuine' }));
            expect(end.attempt?.terminal).toMatchObject({ outcome, strength: 'tool_report' });
            await ledger.flushPublish();
            const snapshot = store.db.prepare('SELECT * FROM mesh_task_outputs WHERE task_id = ?').all(task.id);
            setActiveTurnLedger(null);
            __resetMeshRuntimeStoreForTests();
            const reloaded = MeshRuntimeStore.getInstance();
            const restored = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher() });
            expect(restored.getAttempt(ref.attemptRef.attemptId)?.state).toBe(outcome);
            expect(reloaded.findQueueEntryById(mesh, task.id)?.status).toBe(outcome);
            expect(JSON.parse(reloaded.getLatestTaskOutput(task.id)!.envelopeJson)).toMatchObject({ status: outcome, evidence: { reportedOutcome: outcome, branchState: 'blocked_review' } });
            const stats = getMeshQueueStats(mesh);
            const local = getLocalRecordSummary(mesh);
            expect(local.taskFailed).toBe(outcome === 'failed' ? 1 : 0);
            expect(local.taskBlocked).toBe(outcome === 'blocked' ? 1 : 0);
            const taskStats = computeMeshTaskStats(mesh);
            expect(taskStats[0]).toMatchObject({ status: outcome, terminalKind: `task_${outcome}` });
            expect(rollupMissionStats('mission', taskStats)).toMatchObject({ blocked: outcome === 'blocked' ? 1 : 0, failed: outcome === 'failed' ? 1 : 0 });
            expect(stats[outcome]).toBe(1);
            expect(stats.active).toBe(0);
            if (outcome === 'blocked') {
                expect(stats.failed).toBe(0);
                const aggregate = summarizeMissionTasks(mesh, mission.id);
                expect(aggregate.blocked).toBe(1);
                enqueueTask(mesh, 'dependent must wait', { dependsOn: [task.id], taskMode: 'live_debug_readonly', difficulty: 'medium' });
                expect(claimNextTask(mesh, 'n1', 's2')).toBeNull();
                expect(isMissionAllTasksTerminal(aggregate)).toBe(false);
                expect(maybeEmitMissionCloseCandidate(mesh, mission.id)).toBe(false);
                expect(getMeshMission(mesh, mission.id)).toMatchObject({ status: 'active' });
                expect(getMeshMission(mesh, mission.id)?.closeCandidateEmittedAt).toBeFalsy();
                updateTaskStatus(mesh, task.id, 'pending');
                requeueTaskForLedgerReclaim(mesh, task.id, 'session_dead', new Date().toISOString());
                expect(reloaded.findQueueEntryById(mesh, task.id)?.status).toBe('blocked');
            }
            const claim = vi.fn();
            await createTurnScheduler({ ledger: restored, claim, log: { info() {}, warn() {}, error() {} } }).tick();
            expect(restored.store.listOpenAttempts({ ownerDaemonId: 'dc' })).toHaveLength(0);
            expect(reloaded.db.prepare('SELECT * FROM mesh_task_outputs WHERE task_id = ?').all(task.id)).toEqual(snapshot);
            await restored.flushPublish();
        });
    }
});

describe('RC28 recovery and compatibility in an isolated fixture database', () => {
    it('persisted blocked report survives reload and bounded await_end expiry without requeue', async () => {
        const mesh = meshId();
        const { task, ledger, ref } = setup(mesh);
        setActiveTurnLedger(ledger);
        const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId: ref.attemptRef.attemptId, sessionId: 's1' });
        const at = Date.now();
        expect(acceptWorkerCompletionReport({ token: token.token }, { outcome: 'blocked', summary: 'Committed; independent review needed', branchState: 'blocked_review' }, { nowMs: at }).accepted).toBe(true);
        const deadline = ledger.store.activeHolds(ref.attemptRef.attemptId).find(hold => hold.reason === 'await_end')!.until!;
        await ledger.flushPublish();
        setActiveTurnLedger(null);
        __resetMeshRuntimeStoreForTests();
        const reloaded = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher(), now: () => deadline + 1 });
        const claim = vi.fn();
        await createTurnScheduler({ ledger: reloaded, now: () => deadline + 1, claim, log: { info() {}, warn() {}, error() {} } }).tick();
        expect(reloaded.getAttempt(ref.attemptRef.attemptId)?.terminal).toMatchObject({ outcome: 'blocked', reason: 'worker_reported' });
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(mesh, task.id)?.status).toBe('blocked');
        expect(reloaded.store.activeHolds(ref.attemptRef.attemptId)).toHaveLength(0);
        expect(reloaded.store.listOpenAttempts({ ownerDaemonId: 'dc' })).toHaveLength(0);
        await reloaded.flushPublish();
    });

    it('legacy failed records project blocked only with matching provenance and stay byte-for-byte unchanged', async () => {
        const mesh = meshId();
        const { task, store, ledger, ref } = setup(mesh);
        setActiveTurnLedger(ledger);
        const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId: ref.attemptRef.attemptId, sessionId: 's1' });
        expect(acceptWorkerCompletionReport({ token: token.token }, { outcome: 'blocked', summary: 'Committed; awaiting review', branchState: 'blocked_review' }).accepted).toBe(true);
        ledger.observe(evd('turn_end', { strength: 'genuine' }, { ...ref, source: 'completion_flush_genuine' }));
        await ledger.flushPublish();
        // Construct historical old-mapping rows in this disposable test DB only.
        const row = store.findQueueEntryById(mesh, task.id)!;
        store.updateQueueEntry({ ...row, status: 'failed', missionId: 'mission' });
        const output = store.getLatestTaskOutput(task.id)!;
        const envelope = { ...JSON.parse(output.envelopeJson), status: 'failed' };
        store.db.prepare("UPDATE mesh_task_outputs SET status='failed', envelope_json=? WHERE task_id=?").run(JSON.stringify(envelope), task.id);
        store.db.prepare("UPDATE turn_attempts SET state='failed', terminal_outcome='failed' WHERE attempt_id=?").run(ref.attemptRef.attemptId);
        const history = () => ['mesh_queue', 'mesh_task_outputs', 'turn_attempts', 'turn_events'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all());
        const before = history();
        const view = projectWorkerOutcomeViews(store, mesh, [store.findQueueEntryById(mesh, task.id)!])[0] as any;
        expect(view).toMatchObject({ status: 'blocked', statusProvenance: { storedStatus: 'failed', derivedFrom: 'worker_tool_report', attemptId: ref.attemptRef.attemptId, outputVersion: 1 } });
        expect(getMeshQueueStats(mesh)).toMatchObject({ failed: 0, blocked: 1, active: 0 });
        expect(store.getQueueStatusCounts(mesh).counts).toMatchObject({ failed: 0, blocked: 1 });
        expect(summarizeMissionTasks(mesh, 'mission')).toMatchObject({ failed: 0, blocked: 1 });
        expect(readTurnTerminalViews(mesh)[0]).toMatchObject({ kind: 'task_blocked', payload: { outcome: 'blocked', statusProvenance: { storedStatus: 'failed' } } });
        expect(getLocalRecordSummary(mesh)).toMatchObject({ taskFailed: 0, taskBlocked: 1 });
        expect(history()).toEqual(before);
        // A real runtime failure after the report is NOT the old mapping.
        store.db.prepare("UPDATE turn_attempts SET terminal_reason='session_error', terminal_strength='genuine' WHERE attempt_id=?").run(ref.attemptRef.attemptId);
        expect(legacyWorkerBlockedTasks(store, mesh).size).toBe(0);
        expect(getMeshQueueStats(mesh)).toMatchObject({ failed: 1, blocked: 0 });
        store.db.prepare("UPDATE turn_attempts SET terminal_reason='worker_reported', terminal_strength='tool_report' WHERE attempt_id=?").run(ref.attemptRef.attemptId);
        for (const evidence of [{ branchState: 'blocked_review' }, { ...envelope.evidence, reportedOutcome: 'failed' }, { ...envelope.evidence, summarySource: 'transcript' }]) {
            store.db.prepare('UPDATE mesh_task_outputs SET envelope_json=? WHERE task_id=?').run(JSON.stringify({ ...envelope, evidence }), task.id);
            expect(legacyWorkerBlockedTasks(store, mesh).size).toBe(0);
        }
    });

    it('a runtime error after an accepted blocked report remains failed', async () => {
        const mesh = meshId();
        const { task, store, ledger, ref } = setup(mesh);
        setActiveTurnLedger(ledger);
        const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId: ref.attemptRef.attemptId, sessionId: 's1' });
        expect(acceptWorkerCompletionReport({ token: token.token }, { outcome: 'blocked', summary: 'Review required', branchState: 'blocked_review' }).accepted).toBe(true);
        ledger.observe(evd('session_error', { reason: 'provider_error' }, ref));
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('failed');
        expect(ledger.getAttempt(ref.attemptRef.attemptId)?.terminal).toMatchObject({ outcome: 'failed', reason: 'session_error' });
        expect(legacyWorkerBlockedTasks(store, mesh).size).toBe(0);
        await ledger.flushPublish();
    });
});
