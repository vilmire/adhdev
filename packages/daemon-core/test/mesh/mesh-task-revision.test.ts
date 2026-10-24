import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '', mesh: undefined as any, trigger: vi.fn(async () => ({})) }));
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.dir, getMachineId: () => 'revision-test', loadConfig: () => ({ machineId: 'revision-test' }) }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: () => state.mesh, getMeshByRepo: () => undefined, listMeshes: () => [] }));
vi.mock('../../src/mesh/mesh-queue-assignment.js', async importOriginal => ({ ...await importOriginal<any>(), triggerMeshQueue: state.trigger }));
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { checkReportAgainstTaskMode } from '../../src/mesh/worker-report.js';
import { resolveDispatchMessage } from '../../src/mesh/worker-handoff-dispatch.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, getQueueEntryById, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { revisePendingTask } from '../../src/mesh/mesh-task-revision.js';
const meshId = 'revision-mesh';
const claim = { providerType: 'codex-cli', assignedModel: 'gpt-5.4', allowedTaskDifficulties: ['medium', 'difficult'] as const };
let worktree: string;
beforeEach(() => {
    state.mesh = undefined; state.trigger.mockClear();
    state.dir = mkdtempSync(join(tmpdir(), 'rc28-revision-')); __resetMeshRuntimeStoreForTests(); worktree = join(state.dir, 'workspace'); mkdirSync(worktree);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: worktree, stdio: 'pipe' });
    writeFileSync(join(worktree, 'file.ts'), 'export {};');
});
afterEach(() => { __resetMeshRuntimeStoreForTests(); rmSync(state.dir, { recursive: true, force: true }); });
const context = () => ({ actor: 'authenticated-host', repoIdentity: 'repo', machineId: 'machine', nodeId: 'node', workspace: worktree });
function task(ownedPaths = ['file.ts']) { return enqueueTask(meshId, 'Original', { difficulty: 'medium', ownedPaths, targetNodeId: 'node', missionId: 'mission' }); }
describe('pending task revision CAS', () => {
    it('preserves identity, mission, dependents and old contract; rejects stale replay atomically', () => {
        const original = task(); const dependent = enqueueTask(meshId, 'Dependent', { difficulty: 'medium', dependsOn: [original.id] });
        const edited = revisePendingTask(meshId, original.id, 0, { message: 'Source only', phase: 'integration', ownedPaths: ['file.ts'] }, context());
        expect(edited).toMatchObject({ id: original.id, missionId: 'mission', revision: 1, message: 'Source only', phase: 'integration', revisionHistory: [{ before: { message: 'Original' } }] });
        expect(getQueueEntryById(meshId, dependent.id)?.dependsOn).toEqual([original.id]);
        expect(() => revisePendingTask(meshId, original.id, 0, { message: 'Stale' }, context())).toThrow(/stale_revision/);
        expect(getQueueEntryById(meshId, original.id)).toEqual(edited);
    });
    it('rejects invalid paths, unknown deps, cycles, expansion collisions with zero changes', () => {
        const original = task(['small.ts']);
        const dep = enqueueTask(meshId, 'Dependent', { difficulty: 'medium', dependsOn: [original.id] });
        for (const patch of [{ ownedPaths: ['../escape'] }, { dependsOn: ['absent'] }, { dependsOn: [dep.id] }]) {
            expect(() => revisePendingTask(meshId, original.id, 0, patch, context())).toThrow();
            expect(getQueueEntryById(meshId, original.id)).toEqual(original);
        }
        const holder = enqueueTask(meshId, 'Holder', { difficulty: 'medium', targetNodeId: 'other', ownedPaths: ['broad/**'] });
        MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, 'other', 'holder', [], claim);
        expect(() => revisePendingTask(meshId, original.id, 0, { ownedPaths: ['broad/new.ts'] }, context())).toThrow(/ownership_collision/);
        expect(getQueueEntryById(meshId, original.id)).toEqual(original);
        expect(getQueueEntryById(meshId, holder.id)?.status).toBe('assigned');
    });
    it('path-only replanning cannot release an unknown legacy physical writer', () => {
        const holder = enqueueTask(meshId, 'Holder', { difficulty: 'medium', targetNodeId: 'other', ownedPaths: ['broad/**'] });
        const store = MeshRuntimeStore.getInstance(); store.claimNextQueueTask(meshId, 'other', 'holder', [], claim);
        const original = task(['broad/new.ts']); store.claimNextQueueTask(meshId, 'node', 'worker', [], claim);
        expect(getQueueEntryById(meshId, original.id)?.hold?.reason).toBe('owned_paths_conflict');
        expect(() => revisePendingTask(meshId, original.id, 0, { ownedPaths: ['small.ts'], message: 'Narrow source' }, context())).toThrow(/ownership_collision/);
        expect(getQueueEntryById(meshId, original.id)?.requeueCount).toBeUndefined();
        expect(store.claimNextQueueTask(meshId, 'node', 'worker', [], claim)).toBeNull();
        expect(getQueueEntryById(meshId, holder.id)?.status).toBe('assigned');
    });
    it('rejects assigned edits and does not permit caller-supplied context or readonly escapes', () => {
        const original = task(); MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, 'node', 'worker', [], claim);
        expect(() => revisePendingTask(meshId, original.id, 0, { message: 'Edit active' }, context())).toThrow(/pending_required/);
        const pending = task();
        expect(() => revisePendingTask(meshId, pending.id, 0, { readonly: true } as any, context())).toThrow(/unsupported/);
        expect(() => revisePendingTask(meshId, pending.id, 0, { message: 'Edit' }, undefined as any)).toThrow(/host/);
    });
});


describe('real queue claims across physical worktrees', () => {
    it('runs three source writers, warns on logical overlap, fences an alias and recovers claims', () => {
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
        git(worktree, 'add', 'file.ts'); git(worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
        const store = MeshRuntimeStore.getInstance();
        const sources = [worktree];
        for (const suffix of ['b', 'c']) { const other = join(state.dir, suffix); git(worktree, 'worktree', 'add', '-b', suffix, other); sources.push(other); }
        const tasks = sources.map((workspace, i) => {
            const nodeId = `node-${i}`;
            const entry = enqueueTask(meshId, `Source ${i}`, { difficulty: 'difficult', targetNodeId: nodeId, ownedPaths: ['file.ts'] });
            return revisePendingTask(meshId, entry.id, 0, { phase: 'source' }, { ...context(), nodeId, workspace });
        });
        tasks.forEach((entry, i) => expect(store.claimNextQueueTask(meshId, `node-${i}`, `writer-${i}`, [], { ...claim, physicalContext: { workspace: sources[i], machineId: 'machine' } })?.id).toBe(entry.id));
        expect(getQueueEntryById(meshId, tasks[1].id)?.logicalOverlapWarnings).toMatchObject([{ taskId: tasks[0].id, action: 'serialize_integration' }]);
        const dbPath = store.db.name;
        __resetMeshRuntimeStoreForTests();
        expect(MeshRuntimeStore.getInstance().db.name).toBe(dbPath);
        expect(MeshRuntimeStore.getInstance().getQueueEntries(meshId).filter(t => t.status === 'assigned')).toHaveLength(3);
        const alias = enqueueTask(meshId, 'Alias writer', { difficulty: 'medium', targetNodeId: 'alias-node', ownedPaths: ['different.ts'] });
        expect(() => revisePendingTask(meshId, alias.id, 0, { phase: 'source' }, { ...context(), nodeId: 'alias-node' })).toThrow(/ownership_collision/);
        expect(getQueueEntryById(meshId, tasks[0].id)?.status).toBe('assigned');
    });
});


describe('supported host revision API and source phase', () => {
    const ctx = () => ({ deps: { statusInstanceId: 'daemon-host' }, components: () => ({}) }) as any;
    const request = (id: string, extra = {}) => ({ v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: id, expectedRevision: 0, patch: { message: 'Revised through IPC' }, ...extra });
    it('fails closed for missing/member/foreign host and rejects caller-injected paths', async () => {
        const original = task();
        expect(await meshStoreIpcHandlers.queue_revise(ctx(), request(original.id))).toMatchObject({ success: false });
        state.mesh = { id: meshId, repoIdentity: 'repo', meshHost: { role: 'member', hostDaemonId: 'daemon-host' }, nodes: [] };
        expect(await meshStoreIpcHandlers.queue_revise(ctx(), request(original.id))).toMatchObject({ success: false });
        state.mesh.meshHost = { role: 'host', hostDaemonId: 'foreign' };
        expect(await meshStoreIpcHandlers.queue_revise(ctx(), request(original.id))).toMatchObject({ success: false });
        state.mesh.meshHost.hostDaemonId = 'daemon-host';
        expect(await meshStoreIpcHandlers.queue_revise(ctx(), request(original.id, { patch: { phase: 'source', workspace: worktree, machineId: 'spoof' } }))).toMatchObject({ success: false });
        expect(getQueueEntryById(meshId, original.id)).toEqual(original);
        expect(state.trigger).not.toHaveBeenCalled();
    });
    it('resolves physical context from registered local host and immediately reschedules once', async () => {
        const original = task();
        state.mesh = { id: meshId, repoIdentity: 'repo', meshHost: { role: 'host', hostDaemonId: 'daemon-host' }, nodes: [{ id: 'node', daemonId: 'daemon-host', workspace: worktree }] };
        const req = request(original.id, { patch: { phase: 'source' } });
        const result: any = await meshStoreIpcHandlers.queue_revise(ctx(), req);
        expect(result).toMatchObject({ success: true, task: { id: original.id, revision: 1, ownershipScope: { machineId: 'revision-test', worktree: realpathSync(worktree) } } });
        expect(state.trigger).toHaveBeenCalledTimes(1);
        expect(await meshStoreIpcHandlers.queue_revise(ctx(), req)).toMatchObject({ success: false, error: 'stale_revision' });
        expect(state.trigger).toHaveBeenCalledTimes(1);
        const report = { outcome: 'completed', summary: 'Source packet', touchedFiles: ['file.ts'] } as any;
        const identity = { meshId, taskId: original.id } as any;
        expect(checkReportAgainstTaskMode(identity, report)).toMatch(/not_mergeable/);
        expect(checkReportAgainstTaskMode(identity, { ...report, branchState: 'not_mergeable' })).toBeNull();
        expect(checkReportAgainstTaskMode(identity, { ...report, branchState: 'not_mergeable', touchedFiles: ['oss'] })).toMatch(/integration writes/);
        expect(resolveDispatchMessage(result.task, meshId, {})).toContain('Source-ready is not release-ready');
    });
    it('refuses source migration that would let feature dependents complete early', () => {
        const original = task(); enqueueTask(meshId, 'Final feature dependent', { difficulty: 'medium', dependsOn: [original.id] });
        expect(() => revisePendingTask(meshId, original.id, 0, { phase: 'source' }, context())).toThrow(/integration_dependents/);
        expect(getQueueEntryById(meshId, original.id)?.phase).toBeUndefined();
    });
    it('refuses an open pending attempt without retirement or redrive', () => {
        const original = task(); const store = MeshRuntimeStore.getInstance();
        const lookup = vi.spyOn(store.turnStore(), 'findLatestAttemptForTask').mockReturnValue({ terminal: false, scope: 'mesh_queue', attemptId: 'open' } as any);
        expect(() => revisePendingTask(meshId, original.id, 0, { message: 'Edit' }, context())).toThrow(/open_attempt/);
        lookup.mockRestore(); expect(getQueueEntryById(meshId, original.id)).toEqual(original);
    });
});


describe('actual claim reviewer and affinity controls', () => {
    it('holds self-review, admits independent available input, and refuses moved physical context', () => {
        const original = task();
        revisePendingTask(meshId, original.id, 0, { phase: 'source' }, context());
        const store = MeshRuntimeStore.getInstance();
        const proof = { workspace: worktree, machineId: 'machine' };
        const source = store.claimNextQueueTask(meshId, 'node', 'author', [], { ...claim, physicalContext: proof })!;
        source.status = 'completed'; store.updateQueueEntry(source);
        const reviewer = enqueueTask(meshId, 'Independent review', { difficulty: 'difficult', readonly: true });
        revisePendingTask(meshId, reviewer.id, 0, { review: { sourceTaskId: original.id, differentProvider: true }, routingPreferences: { providers: ['codex-cli'] } }, context());
        // Same author provider refuses even with read-only classification.
        expect(store.claimNextQueueTask(meshId, 'node', 'self-review', [], { ...claim, physicalContext: proof })).toBeNull();
        expect(getQueueEntryById(meshId, reviewer.id)?.hold?.reason).toBe('review_independence_required');
        expect(store.claimNextQueueTask(meshId, 'node', 'remote-review', [], { ...claim, providerType: 'claude-cli', physicalContext: { workspace: '/absent', machineId: 'elsewhere' } })).toBeNull();
        expect(getQueueEntryById(meshId, reviewer.id)?.hold?.reason).toBe('review_input_unavailable');
        expect(store.claimNextQueueTask(meshId, 'node', 'reviewer', [], { ...claim, providerType: 'claude-cli', physicalContext: proof })?.id).toBe(reviewer.id);
        const reviewerRow = getQueueEntryById(meshId, reviewer.id)!;
        const writer = task();
        expect(() => revisePendingTask(meshId, writer.id, 0, { phase: 'source' }, context())).toThrow(/ownership_collision/);
        reviewerRow.status = 'completed'; store.updateQueueEntry(reviewerRow);
        revisePendingTask(meshId, writer.id, 0, { phase: 'source' }, context());
        expect(store.claimNextQueueTask(meshId, 'node', 'moved-writer', [], { ...claim, physicalContext: { workspace: state.dir, machineId: 'machine' } })).toBeNull();
        expect(getQueueEntryById(meshId, writer.id)?.hold?.reason).toBe('physical_context_changed');
        expect(store.claimNextQueueTask(meshId, 'node', 'proper-writer', [], { ...claim, physicalContext: proof })?.id).toBe(writer.id);
    });
});
