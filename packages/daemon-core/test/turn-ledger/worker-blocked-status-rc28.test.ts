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

import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { evaluateTaskOwnedPathsAdmission } from '../../src/mesh/mesh-runtime-store-claim.js';
import { __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { acceptWorkerCompletionReport, acceptWorkerCompletionReportForIdentity } from '../../src/mesh/worker-report.js';
import { __resetWorkerTaskTokensForTest, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
import { claimNextTask, getMeshQueueStats, updateTaskStatus, requeueTaskForLedgerReclaim } from '../../src/mesh/mesh-work-queue.js';
import { summarizeMissionTasks, isMissionAllTasksTerminal, upsertMeshMission, maybeEmitMissionCloseCandidate, getMeshMission } from '../../src/mesh/mesh-missions.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { getLocalRecordSummary, readLocalRecords, readTurnTerminalViews } from '../../src/mesh/mesh-local-records.js';
import { computeMeshTaskStats, rollupMissionStats } from '../../src/mesh/mesh-task-stats.js';
import { legacyWorkerBlockedTasks, projectWorkerOutcomeViews } from '../../src/mesh/mesh-worker-outcome-view.js';
import { SUMMARY, T0, evd, fakePublisher, recordingPorts } from './ledger-harness.js';

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
        expect(store.getQueueStatusCounts(mesh)).toMatchObject({ counts: { failed: 0, blocked: 1 }, legacyReportedBlockedCount: 1 });
        const query = (statuses: string[], view: boolean) => meshStoreIpcHandlers.queue_query({} as any, { v: TURN_IPC_PROTOCOL_VERSION, meshId: mesh, statuses, view, withCounts: true });
        expect(await query(['blocked'], true)).toMatchObject({ success: true, entries: [{ id: task.id, status: 'blocked', statusProvenance: { storedStatus: 'failed' } }], legacyReportedBlockedCount: 1 });
        expect(await query(['failed'], true)).toMatchObject({ success: true, entries: [] });
        expect(await query(['failed'], false)).toMatchObject({ success: true, entries: [{ id: task.id, status: 'failed' }] });
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
        const { task, store, ledger, ref, ports } = setup(mesh);
        setActiveTurnLedger(ledger);
        const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId: ref.attemptRef.attemptId, sessionId: 's1' });
        expect(acceptWorkerCompletionReport({ token: token.token }, { outcome: 'blocked', summary: 'Review required', branchState: 'blocked_review' }).accepted).toBe(true);
        ledger.observe(evd('session_error', { reason: 'provider_error' }, ref));
        expect(ledger.getAttempt(ref.attemptRef.attemptId)).toMatchObject({ state: 'stopping', terminal: null });
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('blocked');
        expect(store.hasActiveAssignment(mesh, 's1', 'n1')).toBe(true);
        ports.cancelDispatch = (req) => ({ ...req, success: true, quiescent: true, incarnation: 'fixture-native-writer' });
        const restored = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', now: () => T0 + 1_000, publisher: fakePublisher(), ports });
        await restored.resumeStoppingWriters();
        expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('failed');
        expect(restored.getAttempt(ref.attemptRef.attemptId)?.terminal).toMatchObject({ outcome: 'failed', reason: 'session_error' });
        expect(legacyWorkerBlockedTasks(store, mesh).size).toBe(0);
        await ledger.flushPublish();
    });

    async function finishReportedTurn(mesh: string, outcome: 'blocked' | 'failed', terminalAt: number, legacy = false) {
        const r = setup(mesh);
        setActiveTurnLedger(r.ledger);
        const token = mintWorkerTaskToken({ meshId: mesh, taskId: r.task.id, attemptId: r.ref.attemptRef.attemptId, sessionId: 's1' });
        expect(acceptWorkerCompletionReport({ token: token.token }, { outcome, summary: 'Fixture terminal', branchState: 'blocked_review' }).accepted).toBe(true);
        r.ledger.observe(evd('turn_end', { strength: 'genuine' }, { ...r.ref, source: 'completion_flush_genuine' }));
        await r.ledger.flushPublish();
        if (legacy) {
            const row = r.store.findQueueEntryById(mesh, r.task.id)!;
            r.store.updateQueueEntry({ ...row, status: 'failed' });
            const output = r.store.getLatestTaskOutput(r.task.id)!;
            const envelope = { ...JSON.parse(output.envelopeJson), status: 'failed' };
            r.store.db.prepare("UPDATE mesh_task_outputs SET status='failed', envelope_json=? WHERE task_id=?").run(JSON.stringify(envelope), r.task.id);
            r.store.db.prepare("UPDATE turn_attempts SET state='failed', terminal_outcome='failed' WHERE attempt_id=?").run(r.ref.attemptRef.attemptId);
        }
        r.store.db.prepare('UPDATE turn_attempts SET terminal_at=? WHERE attempt_id=?').run(terminalAt, r.ref.attemptRef.attemptId);
        return r;
    }

    it('blocked filter tail counts matching projected records rather than newer genuine failure', async () => {
        const mesh = meshId();
        const b = await finishReportedTurn(mesh, 'blocked', 20001, true);
        await finishReportedTurn(mesh, 'failed', 20002);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'] }).map(v => v.payload?.taskId)).toEqual([b.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], tail: 1 }).map(v => v.payload?.taskId)).toEqual([b.task.id]);
        expect(readLocalRecords(mesh, { kind: ['task_blocked'], tail: 1 }).map(v => v.taskId)).toEqual([b.task.id]);
    });

    it('failed filter tail counts genuine failure rather than newer projected legacy blocked', async () => {
        const mesh = meshId();
        const f = await finishReportedTurn(mesh, 'failed', 20001);
        await finishReportedTurn(mesh, 'blocked', 20002, true);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_failed'] }).map(v => v.payload?.taskId)).toEqual([f.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_failed'], tail: 1 }).map(v => v.payload?.taskId)).toEqual([f.task.id]);
        expect(readLocalRecords(mesh, { kind: ['task_failed'], tail: 1 }).map(v => v.taskId)).toEqual([f.task.id]);
    });

    it('preserves order, oldestFirst, sinceMs, excludeIds, and native vs legacy blocked distinction across mixed tails', async () => {
        const mesh = meshId();
        const t1 = await finishReportedTurn(mesh, 'blocked', 30001, true);
        const t2 = await finishReportedTurn(mesh, 'failed', 30002);
        const t3 = await finishReportedTurn(mesh, 'blocked', 30003, false);
        const t4 = await finishReportedTurn(mesh, 'failed', 30004);
        const t5 = await finishReportedTurn(mesh, 'blocked', 30005, true);

        const newestTwoBlocked = readTurnTerminalViews(mesh, { kinds: ['task_blocked'], tail: 2 });
        expect(newestTwoBlocked.map(v => v.taskId)).toEqual([t3.task.id, t5.task.id]);
        expect(newestTwoBlocked[0].payload?.statusProvenance).toBeUndefined();
        expect(newestTwoBlocked[1].payload?.statusProvenance).toMatchObject({ storedStatus: 'failed', attemptId: t5.ref.attemptRef.attemptId });

        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], tail: 2, oldestFirst: true }).map(v => v.taskId)).toEqual([t1.task.id, t3.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_failed'], tail: 2 }).map(v => v.taskId)).toEqual([t2.task.id, t4.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_failed'], tail: 1, oldestFirst: true }).map(v => v.taskId)).toEqual([t2.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], tail: 1, excludeIds: [`${t5.ref.attemptRef.attemptId}#committed`] }).map(v => v.taskId)).toEqual([t3.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], tail: 1, sinceMs: 30004 }).map(v => v.taskId)).toEqual([t5.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_failed'], tail: 1, sinceMs: 30004 }).map(v => v.taskId)).toEqual([t4.task.id]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], taskId: t2.task.id, tail: 1 })).toEqual([]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], taskId: t1.task.id, tail: 1 }).map(v => v.taskId)).toEqual([t1.task.id]);

        const query = (statuses: string[], view: boolean) => meshStoreIpcHandlers.queue_query({} as any, { v: TURN_IPC_PROTOCOL_VERSION, meshId: mesh, statuses, view });
        expect(((await query(['blocked'], true)) as any).entries.map((e: any) => e.id)).toEqual([t1.task.id, t3.task.id, t5.task.id]);
        expect(((await query(['failed'], true)) as any).entries.map((e: any) => e.id)).toEqual([t2.task.id, t4.task.id]);
        expect(((await query(['blocked'], false)) as any).entries.map((e: any) => e.id)).toEqual([t3.task.id]);
        expect(((await query(['failed'], false)) as any).entries.map((e: any) => e.id)).toEqual([t1.task.id, t2.task.id, t4.task.id, t5.task.id]);
    });

    it('enforces generation provenance, terminal conflict, and session binding controls', async () => {
        const mesh = meshId();
        const r = await finishReportedTurn(mesh, 'blocked', 40001, true);
        expect(legacyWorkerBlockedTasks(r.store, mesh).has(r.task.id)).toBe(true);
        const a = r.store.turnStore().getAttempt(r.ref.attemptRef.attemptId)!;
        const data = { ...a.data, report: { ...(a.data as any).report, generation: 99 } };
        r.store.db.prepare('UPDATE turn_attempts SET data_json=? WHERE attempt_id=?').run(JSON.stringify(data), r.ref.attemptRef.attemptId);
        expect(legacyWorkerBlockedTasks(r.store, mesh).has(r.task.id)).toBe(false);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_blocked'], tail: 1 })).toEqual([]);
        expect(readTurnTerminalViews(mesh, { kinds: ['task_failed'], tail: 1 }).map(v => v.taskId)).toEqual([r.task.id]);

        const failedTurn = await finishReportedTurn(mesh, 'failed', 40002);
        setActiveTurnLedger(failedTurn.ledger);
        const lateToken = mintWorkerTaskToken({ meshId: mesh, taskId: failedTurn.task.id, attemptId: failedTurn.ref.attemptRef.attemptId, sessionId: 's1' });
        const beforeOutput = failedTurn.store.getLatestTaskOutput(failedTurn.task.id);
        expect(acceptWorkerCompletionReport({ token: lateToken.token }, { outcome: 'blocked', summary: 'Late review label', branchState: 'blocked_review' }).accepted).toBe(false);
        expect(failedTurn.store.findQueueEntryById(mesh, failedTurn.task.id)?.status).toBe('failed');
        expect(failedTurn.store.getLatestTaskOutput(failedTurn.task.id)).toEqual(beforeOutput);

        const wrongSession = setup(mesh);
        setActiveTurnLedger(wrongSession.ledger);
        const wrongToken = mintWorkerTaskToken({ meshId: mesh, taskId: wrongSession.task.id, attemptId: wrongSession.ref.attemptRef.attemptId, sessionId: 'unrelated-session' });
        expect(acceptWorkerCompletionReport({ token: wrongToken.token }, { outcome: 'blocked', summary: 'Unrelated session', branchState: 'blocked_review' }).accepted).toBe(false);
        expect(wrongSession.store.findQueueEntryById(mesh, wrongSession.task.id)?.status).toBe('assigned');
        expect(wrongSession.store.getLatestTaskOutput(wrongSession.task.id)).toBeNull();
        await wrongSession.ledger.flushPublish();
    });
});


describe('combined composition physical writer checkpoints', () => {
    for (const outcome of ['blocked', 'completed', 'failed'] as const) {
        it(`${outcome}: stopping retains assignment, ownership and capacity until exact quiescence`, async () => {
            const mesh = meshId();
            const { task, store, ledger, ref, ports } = setup(mesh);
            const row = store.findQueueEntryById(mesh, task.id)!;
            store.updateQueueEntry({ ...row, assignedProviderType: 'codex', assignedModel: 'fixture-model', ownedPaths: { paths: [{ path: 'src/shared.ts', subtree: false }] } });
            const candidate = { ...row, id: 'other-task', ownedPaths: { paths: [{ path: 'src/shared.ts', subtree: false }] } };
            const checkClaims = (held: boolean) => {
                expect(store.hasActiveAssignment(mesh, 's1', 'n1')).toBe(held);
                expect(store.hasActiveSessionAssignment(mesh, 's1')).toBe(held);
                expect(store.hasActiveNodeWriteAssignment(mesh, 'n1')).toBe(held);
                expect(store.nodeActiveAssignmentCount(mesh, 'n1')).toBe(held ? 1 : 0);
                expect(store.activeProviderAssignmentCount(mesh, 'n1', 'codex')).toBe(held ? 1 : 0);
                expect(store.activeSlotAssignmentCount(mesh, 'n1', 'codex', 'fixture-model')).toBe(held ? 1 : 0);
                expect(store.assignedRowsMeshWide(mesh)).toHaveLength(held ? 1 : 0);
                expect(evaluateTaskOwnedPathsAdmission(store, mesh, candidate).allowed).toBe(!held);
                expect(store.hasActiveAssignment(mesh, 'other-session', 'other-node')).toBe(false);
                expect(store.hasActiveSessionAssignment(mesh, 'other-session')).toBe(false);
                expect(store.hasActiveNodeWriteAssignment(mesh, 'other-node')).toBe(false);
                expect(store.activeProviderAssignmentCount(mesh, 'other-node', 'codex')).toBe(0);
                expect(store.activeProviderAssignmentCount(mesh, 'n1', 'other-provider')).toBe(0);
                expect(store.activeSlotAssignmentCount(mesh, 'n1', 'codex', 'other-model')).toBe(0);
                expect(store.assignedRowsMeshWide('other-mesh')).toHaveLength(0);
            };
            checkClaims(true); // Assigned rows still reserve the physical writer.
            setActiveTurnLedger(ledger);
            const token = mintWorkerTaskToken({ meshId: mesh, taskId: task.id, attemptId: ref.attemptRef.attemptId, sessionId: 's1' });
            expect(acceptWorkerCompletionReport({ token: token.token }, { outcome, summary: 'Pre-idle report', touchedFiles: [] }).accepted).toBe(true);
            ledger.observe(evd('session_error', { reason: 'provider_error' }, ref));
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe(outcome);
            checkClaims(true);
            const stoppedRow = store.findQueueEntryById(mesh, task.id)!;
            expect(() => store.updateQueueEntry({ ...stoppedRow, status: 'pending' })).toThrow('writer_checkpoint_pending');
            expect(() => store.updateQueueEntry({ ...stoppedRow, assignedSessionId: 'replacement' })).toThrow('writer_checkpoint_pending');
            // A successful reply for another generation cannot release this writer.
            ports.cancelDispatch = req => ({ ...req, generation: req.generation + 1, success: true, quiescent: true, incarnation: 'fixture-native-writer' });
            const wrongGeneration = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', now: () => T0 + 1_000, publisher: fakePublisher(), ports });
            await wrongGeneration.resumeStoppingWriters();
            expect(wrongGeneration.getAttempt(ref.attemptRef.attemptId)).toMatchObject({ generation: 0, state: 'stopping', terminal: null });
            checkClaims(true);
            ports.cancelDispatch = req => ({ ...req, success: true, quiescent: true, incarnation: 'fixture-native-writer' });
            const restored = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', now: () => T0 + 1_000, publisher: fakePublisher(), ports });
            await restored.resumeStoppingWriters();
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('failed');
            expect(restored.getAttempt(ref.attemptRef.attemptId)?.terminal).toMatchObject({ outcome: 'failed', reason: 'session_error' });
            checkClaims(false); // Settled terminal rows no longer reserve anything.
        });
    }

    for (const explicitAttempt of [true, false]) {
        it(`stopping report with attemptId ${explicitAttempt ? 'present' : 'omitted'} returns checkpoint_pending`, () => {
            const mesh = meshId();
            const { task, store, ledger, ref } = setup(mesh);
            ledger.observe(evd('session_error', { reason: 'provider_error' }, ref));
            setActiveTurnLedger(ledger);
            const identity = { token: 'fixture-identity', meshId: mesh, taskId: task.id, sessionId: 's1', ...(explicitAttempt ? { attemptId: ref.attemptRef.attemptId } : {}) };
            const report = { outcome: 'blocked' as const, summary: 'Report during stop' };
            const result = acceptWorkerCompletionReportForIdentity(identity, report, {});
            expect(result).toMatchObject({ accepted: false, refusal: 'rejected_by_reducer', detail: expect.stringContaining('checkpoint_pending:report retained') });
            expect(store.findQueueEntryById(mesh, task.id)?.status).toBe('assigned');
            expect(ledger.getAttempt(ref.attemptRef.attemptId)).toMatchObject({ state: 'stopping', terminal: null });
            expect(store.getLatestTaskOutput(task.id)).toBeNull();
            const events = store.db.prepare("SELECT kind FROM turn_events WHERE attempt_id = ? AND kind = 'worker_report'").all(ref.attemptRef.attemptId);
            expect(events).toHaveLength(1);
            expect(acceptWorkerCompletionReportForIdentity({ ...identity, sessionId: 'other-session' }, report, {})).toMatchObject({ accepted: false, detail: 'session_mismatch' });
            setActiveTurnLedger(null);
            expect(acceptWorkerCompletionReportForIdentity(identity, report, {})).toMatchObject({ accepted: false, detail: 'checkpoint_pending:no_owner_ledger' });
            expect(store.hasActiveSessionAssignment(mesh, 's1')).toBe(true);
        });
    }
});
