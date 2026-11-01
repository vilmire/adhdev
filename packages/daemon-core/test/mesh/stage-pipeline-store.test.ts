import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';

const testTmpDir = path.join(tmpdir(), `adhdev-stage-store-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => { if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const meshConfigMocks = vi.hoisted(() => ({ getMesh: vi.fn(), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => [] as any[]) }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: meshConfigMocks.getMesh, getMeshByRepo: meshConfigMocks.getMeshByRepo, listMeshes: meshConfigMocks.listMeshes }));
vi.mock('../../src/config/mesh-config-routing.js', async (importOriginal) => ({ ...(await importOriginal<any>()), getDifficultyBrains: vi.fn(() => undefined) }));

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, cancelTask, enqueueTask, getQueueEntryById, requeueTaskForLedgerReclaim } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { commitTaskTerminal, applyTaskTerminalInTxn } from '../../src/mesh/mesh-task-terminal.js';
import { bindMeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js';
import { setStageHookTarget } from '../../src/mesh/stage-hooks.js';
import { setStageNoticeLookup, isStageInternalNotice } from '../../src/mesh/stage-notice-silence.js';
import { isStagePipelineParked } from '../../src/mesh/stage-state.js';
import { assertNotStageChild } from '../../src/mesh/stage-guards.js';
import { sweepOrphanedUncorrelatedDispatches } from '../../src/mesh/mesh-orphaned-dispatch-sweep.js';
import { collectSessionIdsWithActiveWork } from '../../src/mesh/mesh-idle-session-reaper.js';
import { findPriorWorkerReport, WORKER_REPORT_EVENT_KIND } from '../../src/mesh/worker-report.js';
import { reviewRoutingRefusal } from '../../src/mesh/mesh-task-routing-contract.js';
import { attestLocalOwnership } from '../../src/mesh/mesh-physical-ownership.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';

let currentMesh: string | undefined;
const dirs: string[] = [];
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    setStageHookTarget(null); setStageNoticeLookup(null);
    meshConfigMocks.getMesh.mockReset();
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
function newMesh(): string {
    currentMesh = `mesh_stage_${randomUUID().slice(0, 8)}`;
    bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
    return currentMesh;
}
const medium = { taskMode: 'code_change', difficulty: 'medium' } as any;
const stagey = { ...medium, review: true } as any;
const store = () => MeshRuntimeStore.getInstance();
function assigned(mesh: string, id: string, patch: Partial<MeshWorkQueueEntry> = {}) {
    store().updateQueueEntry({ ...store().findQueueEntryById(mesh, id)!, status: 'assigned', assignedNodeId: 'node_a', assignedSessionId: 'sess-impl', assignedProviderType: 'claude-cli', ...patch } as any);
}

describe('enqueue review option', () => {
    it('is explicit at the daemon (R5 default-on lives in the MCP layer), validated, and opt-out wins', () => {
        const mesh = newMesh();
        expect(enqueueTask(mesh, 'fix', medium).stagePlan).toBeUndefined();
        const on = enqueueTask(mesh, 'fix', { ...medium, review: true });
        expect(on.stagePlan).toEqual({ review: true, maxRevisions: 2, independence: 'fresh_session_ok' });
        expect(on.stageState).toMatchObject({ phase: 'implementing', round: 0 });
        expect(enqueueTask(mesh, 'fix', { ...medium, difficulty: 'easy' }).stagePlan).toBeUndefined();
        expect(enqueueTask(mesh, 'fix', { ...medium, difficulty: 'easy', review: true }).stagePlan).toBeTruthy();
        expect(enqueueTask(mesh, 'fix', { ...medium, review: false }).stagePlan).toBeUndefined();
        expect(enqueueTask(mesh, 'look', { taskMode: 'live_debug_readonly', difficulty: 'medium' } as any).stagePlan).toBeUndefined();
        expect(enqueueTask(mesh, 'fix', { ...medium, review: { max_revisions: 1, independence: 'different_provider' } }).stagePlan).toMatchObject({ maxRevisions: 1, independence: 'different_provider' });
        expect(() => enqueueTask(mesh, 'fix', { ...medium, review: { max_revisions: 9 } })).toThrow(/invalid_review_option/);
    });
});

describe('terminal choke point hold', () => {
    it('holds an intermediate completed on a stage parent and fires the hook; release commits', async () => {
        const mesh = newMesh();
        const calls: string[] = [];
        setStageHookTarget({ onImplCompleted: async (_m, id, a) => { calls.push(`impl:${id}:${a}`); }, onChildTerminal: async (_m, id) => { calls.push(`child:${id}`); }, onChildClaimed: async () => undefined });
        const parent = enqueueTask(mesh, 'fix', stagey);
        assigned(mesh, parent.id);
        const held = commitTaskTerminal({ meshId: mesh, taskId: parent.id, status: 'completed', attemptId: 'att1', source: 'worker_tool_report' });
        expect(held).toMatchObject({ committed: true, held: true });
        expect(getQueueEntryById(mesh, parent.id)!.status).toBe('assigned');
        expect(store().getLatestTaskOutput(parent.id)).toBeFalsy();
        await Promise.resolve();
        expect(calls).toEqual([`impl:${parent.id}:att1`]);
        // the ledger-effect path is held too
        store().transaction(() => applyTaskTerminalInTxn({ meshId: mesh, taskId: parent.id, status: 'completed', attemptId: 'att1', occurredAtMs: Date.now() }));
        expect(getQueueEntryById(mesh, parent.id)!.status).toBe('assigned');
        // a blocked/failed report is NOT held
        const other = enqueueTask(mesh, 'fix2', stagey); assigned(mesh, other.id);
        expect(commitTaskTerminal({ meshId: mesh, taskId: other.id, status: 'blocked', source: 'worker_tool_report' }).held).toBeUndefined();
        expect(getQueueEntryById(mesh, other.id)!.status).toBe('blocked');
        // release: hold lifted by the pipeline, then the final commit lands
        const cur = getQueueEntryById(mesh, parent.id)!; cur.stageState!.released = true; store().updateQueueEntry(cur);
        expect(commitTaskTerminal({ meshId: mesh, taskId: parent.id, status: 'completed', source: 'queue_policy' }).held).toBeUndefined();
        expect(getQueueEntryById(mesh, parent.id)!.status).toBe('completed');
    });

    it('a non-stage task is never held; a child terminal fires the child hook', async () => {
        const mesh = newMesh();
        const calls: string[] = [];
        setStageHookTarget({ onImplCompleted: async () => undefined, onChildTerminal: async (_m, id) => { calls.push(id); }, onChildClaimed: async () => undefined });
        const plain = enqueueTask(mesh, 'easy', { ...medium, difficulty: 'easy' }); assigned(mesh, plain.id);
        expect(commitTaskTerminal({ meshId: mesh, taskId: plain.id, status: 'completed', source: 'worker_tool_report' }).held).toBeUndefined();
        const parent = enqueueTask(mesh, 'fix', stagey); assigned(mesh, parent.id);
        const child = enqueueTask(mesh, 'review it', { difficulty: 'medium', stageChild: { parentTaskId: parent.id, round: 1, review: { sourceTaskId: parent.id, independence: 'different_provider' } } } as any);
        expect(child).toMatchObject({ origin: 'stage', parentTaskId: parent.id, stageRole: 'review', readonly: true, taskMode: 'validation' });
        assigned(mesh, child.id);
        commitTaskTerminal({ meshId: mesh, taskId: child.id, status: 'completed', source: 'worker_tool_report' });
        await Promise.resolve();
        expect(calls).toContain(child.id); // the runtime itself ignores non-stage ids
    });
});

describe('parked predicate + watchdogs', () => {
    it('is true only for assigned parents in self_checking/awaiting_review/reviewing', () => {
        const mesh = newMesh();
        const parent = enqueueTask(mesh, 'fix', stagey);
        for (const [phase, expected] of [['implementing', false], ['revising', false], ['self_checking', true], ['awaiting_review', true], ['reviewing', true], ['done', false]] as const) {
            const e = store().findQueueEntryById(mesh, parent.id)!;
            e.status = 'assigned'; e.stageState!.phase = phase; e.stageState!.released = false;
            expect(isStagePipelineParked(e)).toBe(expected);
        }
        const e = store().findQueueEntryById(mesh, parent.id)!; e.status = 'pending'; e.stageState!.phase = 'awaiting_review';
        expect(isStagePipelineParked(e)).toBe(false);
    });

    it('ledger reclaim, orphan sweep and the reaper active-work set leave a parked parent alone', () => {
        const mesh = newMesh();
        const parent = enqueueTask(mesh, 'fix', stagey);
        assigned(mesh, parent.id, { updatedAt: '2020-01-01T00:00:00.000Z' });
        const e = store().findQueueEntryById(mesh, parent.id)!; e.stageState!.phase = 'awaiting_review'; store().updateQueueEntry(e);
        expect(requeueTaskForLedgerReclaim(mesh, parent.id, 'stranded', new Date().toISOString())?.status).toBe('assigned');
        expect(getQueueEntryById(mesh, parent.id)!.assignedSessionId).toBe('sess-impl');
        const failed = sweepOrphanedUncorrelatedDispatches(mesh, { now: Date.now(), requestProbe: () => undefined, liveness: () => 'not_live' } as any);
        expect(failed.map(f => f.id)).not.toContain(parent.id);
        expect(getQueueEntryById(mesh, parent.id)!.status).toBe('assigned');
        expect([...collectSessionIdsWithActiveWork(mesh)]).toContain('sess-impl');
        // control: the same row, not a stage parent, IS recycled by the reclaim
        const plain = enqueueTask(mesh, 'easy', { ...medium, difficulty: 'easy' });
        assigned(mesh, plain.id);
        expect(requeueTaskForLedgerReclaim(mesh, plain.id, 'stranded', new Date().toISOString())?.status).toBe('pending');
    });
});

describe('child management + cancel propagation', () => {
    it('refuses coordinator cancel of a child; parent cancel cancels the open child', () => {
        const mesh = newMesh();
        const parent = enqueueTask(mesh, 'fix', stagey); assigned(mesh, parent.id);
        const child = enqueueTask(mesh, 'review', { difficulty: 'medium', stageChild: { parentTaskId: parent.id, round: 1, review: { sourceTaskId: parent.id, independence: 'different_provider' } } } as any);
        const p = store().findQueueEntryById(mesh, parent.id)!; p.stageState!.reviewTaskIds = [child.id]; p.stageState!.phase = 'awaiting_review'; p.attemptId = undefined; store().updateQueueEntry(p);
        expect(() => cancelTask(mesh, child.id, { reason: 'nope' })).toThrow(/stage_child_managed/);
        expect(() => assertNotStageChild(mesh, child.id)).toThrow(/stage_child_managed/);
        expect(() => assertNotStageChild(mesh, parent.id)).not.toThrow();
        cancelTask(mesh, parent.id, { reason: 'operator' });
        expect(getQueueEntryById(mesh, child.id)!.status).toBe('cancelled');
    });
});

describe('notice silence', () => {
    it('silences review-child and held-parent completion notices only', () => {
        setStageNoticeLookup((_m, t) => (t === 'child' ? 'child' : t === 'parent' ? 'held_parent' : null));
        expect(isStageInternalNotice('m', 'child', 'completed')).toBe(true);
        expect(isStageInternalNotice('m', 'child', 'failed')).toBe(true);
        expect(isStageInternalNotice('m', 'parent', 'completed')).toBe(true);
        expect(isStageInternalNotice('m', 'parent', 'failed')).toBe(false);
        expect(isStageInternalNotice('m', 'parent', 'approval')).toBe(false);
        expect(isStageInternalNotice('m', 'plain', 'completed')).toBe(false);
        expect(isStageInternalNotice('m', undefined, 'completed')).toBe(false);
    });
});

describe('findPriorWorkerReport per attempt (§8.2)', () => {
    it('a second attempt of the same task is not "already reported"', () => {
        const mesh = newMesh();
        const t = enqueueTask(mesh, 'fix', medium); assigned(mesh, t.id);
        const turns = store().turnStore();
        const ins = (attemptId: string, atMs: number) => turns.insertWorkerEvent({ eventId: `e-${attemptId}`, attemptId, sessionId: 's', kind: WORKER_REPORT_EVENT_KIND, dedupeKey: 'completed', payload: { outcome: 'completed' }, atMs });
        seedMeshAttempt({ meshId: mesh, taskId: t.id, sessionId: 's', attemptId: 'att-1', attemptNo: 0, stage: 'completed' });
        seedMeshAttempt({ meshId: mesh, taskId: t.id, sessionId: 's', attemptId: 'att-2', attemptNo: 1, stage: 'generating' });
        ins('att-1', 1000);
        const first = findPriorWorkerReport(mesh, t.id);
        expect(first).not.toBeNull();
        expect(first.attemptId).toBe('att-1');
        expect(findPriorWorkerReport(mesh, t.id, 'att-1')?.attemptId).toBe('att-1');
        expect(findPriorWorkerReport(mesh, t.id, 'att-2')).toBeNull();
        expect(WORKER_REPORT_EVENT_KIND).toBe('worker_tool_report');
    });
});

describe('review routing (stage-aware)', () => {
    function fixture() {
        const workspace = mkdtempSync(join(tmpdir(), 'stage-review-')); dirs.push(workspace);
        execFileSync('git', ['init'], { cwd: workspace, stdio: 'pipe' }); writeFileSync(join(workspace, 'f.ts'), 'export {};');
        const ownedPaths = normalizeOwnedPaths(['f.ts']).declaration;
        const scope = attestLocalOwnership({ workspace, paths: ownedPaths, phase: 'source', repoIdentity: 'repo', machineId: 'machine', nodeId: 'author' });
        const parent = {
            id: 'parent', status: 'assigned', assignedProviderType: 'claude-cli', assignedSessionId: 'sess-impl', assignedNodeId: 'author',
            ownedPaths, ownershipScope: scope, stagePlan: { review: true, maxRevisions: 2, independence: 'fresh_session_ok' },
            stageState: { phase: 'awaiting_review' },
        } as unknown as MeshWorkQueueEntry;
        return { workspace, parent };
    }
    const child = (independence: 'different_provider' | 'fresh_session', extra: object = {}) => ({ readonly: true, review: { sourceTaskId: 'parent', independence }, ...extra }) as any;

    it('a parked parent is available input and never blocks its own review', () => {
        const { workspace, parent } = fixture();
        const ctx = { workspace, machineId: 'machine' };
        expect(reviewRoutingRefusal(child('different_provider'), parent, 'codex-cli', ctx, [parent])).toBeUndefined();
        // a DIFFERENT active writer on the same node still blocks
        const other = { id: 'other', status: 'assigned', assignedNodeId: 'author' } as MeshWorkQueueEntry;
        expect(reviewRoutingRefusal(child('different_provider'), parent, 'codex-cli', ctx, [parent, other])).toBe('review_input_busy');
        // a non-stage assigned source is still unavailable (existing behavior)
        const plain = { ...parent, stagePlan: undefined, stageState: undefined } as MeshWorkQueueEntry;
        expect(reviewRoutingRefusal(child('different_provider'), plain, 'codex-cli', ctx, [])).toBe('review_input_unavailable');
        // an implementing stage parent is not reviewable yet
        const implementing = { ...parent, stageState: { phase: 'implementing' } } as unknown as MeshWorkQueueEntry;
        expect(reviewRoutingRefusal(child('different_provider'), implementing, 'codex-cli', ctx, [])).toBe('review_input_unavailable');
    });

    it('independence: different provider by default; fresh_session allows same provider but never the implementer session', () => {
        const { workspace, parent } = fixture();
        const ctx = { workspace, machineId: 'machine' };
        expect(reviewRoutingRefusal(child('different_provider'), parent, 'claude-cli', ctx, [parent], 'sess-new')).toBe('review_independence_required');
        expect(reviewRoutingRefusal(child('fresh_session'), parent, 'claude-cli', ctx, [parent], 'sess-new')).toBeUndefined();
        expect(reviewRoutingRefusal(child('fresh_session'), parent, 'claude-cli', ctx, [parent], 'sess-impl')).toBe('review_independence_required');
        // legacy row: differentProvider:true without independence
        expect(reviewRoutingRefusal({ readonly: true, review: { sourceTaskId: 'parent', differentProvider: true } } as any, parent, 'claude-cli', ctx, [parent])).toBe('review_independence_required');
    });

    it('a prepared reviewer workspace skips input availability and busy checks', () => {
        const { parent } = fixture();
        const task = child('different_provider', { reviewerWorkspace: { path: '/opt/light/ws', headSha: 'abc' } });
        expect(reviewRoutingRefusal(task, { ...parent, status: 'completed' } as MeshWorkQueueEntry, 'codex-cli', { workspace: '/nowhere', machineId: 'x' }, [{ id: 'w', status: 'assigned', assignedNodeId: 'author' } as MeshWorkQueueEntry])).toBeUndefined();
        expect(reviewRoutingRefusal(task, parent, 'claude-cli', undefined, [])).toBe('review_independence_required');
    });
});

import { SESSION_COMPLETION_ACCEPTED_EVENT } from '../../src/mesh/mesh-session-lifetime.js';
import { createProductionStagePorts } from '../../src/mesh/stage-ports-default.js';
describe('implementer finished after final release', () => {
    it('records the accepted-completion audit row the reaper reads', () => {
        const mesh = newMesh();
        const t = enqueueTask(mesh, 'fix', stagey); assigned(mesh, t.id, { attemptId: 'att-9' });
        seedMeshAttempt({ meshId: mesh, taskId: t.id, sessionId: 'sess-impl', attemptId: 'att-9', attemptNo: 0, stage: 'completed' });
        const ports = createProductionStagePorts({} as never);
        ports.events.implementerFinished!(getQueueEntryById(mesh, t.id)!);
        const rows = store().turnStore().listWorkerEventsForTask(mesh, t.id, SESSION_COMPLETION_ACCEPTED_EVENT);
        expect(rows.map(r => r.attemptId)).toEqual(['att-9']);
    });
});

import { computeStageReviewStatsForMesh, readStageStatsRows } from '../../src/mesh/stage-stats.js';
describe('review stats wiring', () => {
    it('derives mesh and per-mission stats from the slim store read; absent when no stage task exists', () => {
        const mesh = newMesh();
        enqueueTask(mesh, 'plain', { ...medium, difficulty: 'easy', missionId: 'mi' });
        expect(computeStageReviewStatsForMesh(mesh)).toBeUndefined();
        const parent = enqueueTask(mesh, 'fix', { ...stagey, missionId: 'mi' }); assigned(mesh, parent.id);
        const e = store().findQueueEntryById(mesh, parent.id)!; e.stageState!.round = 2; e.stageState!.lastVerdict = 'approve'; e.stageState!.released = true; e.status = 'completed'; store().updateQueueEntry(e);
        enqueueTask(mesh, 'review', { difficulty: 'medium', missionId: 'mi', stageChild: { parentTaskId: parent.id, round: 1, review: { sourceTaskId: parent.id, independence: 'different_provider' } } } as any);
        expect(readStageStatsRows(mesh).map(r => r.id)).toContain(parent.id);
        const stats = computeStageReviewStatsForMesh(mesh)!;
        expect(stats.stageTasks).toBe(1);
        expect(stats.coordinatorRowsByMission).toEqual({ mi: 2 }); // plain + stage parent; the review child is daemon-created
        expect(stats.allRowsByMission).toEqual({ mi: 3 });
        expect(stats.roundsDistribution).toEqual({ '2': 1 });
        expect(computeStageReviewStatsForMesh(mesh, 'other')!.stageTasks).toBe(0);
    });
});
