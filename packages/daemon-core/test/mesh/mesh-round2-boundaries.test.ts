// Adapted from independent76824f34's actual queue/host-handler probes.
// Source completion is seeded only after the real report validator; no native pipeline proof.
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '', mesh: undefined as any, trigger: vi.fn(async () => ({})) }));
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.dir, getMachineId: () => 'review-machine', loadConfig: () => ({ machineId: 'review-machine' }) }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: () => state.mesh, getMeshByRepo: () => undefined, listMeshes: () => [] }));
vi.mock('../../src/mesh/mesh-queue-assignment.js', async original => ({ ...await original<any>(), triggerMeshQueue: state.trigger }));
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, enqueueTaskBatch, getQueueEntryById, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { evaluateTaskOwnedPathsAdmission } from '../../src/mesh/mesh-runtime-store-claim.js';
import { taskDependenciesSatisfied } from '../../src/mesh/mesh-task-predicates.js';
import { checkReportAgainstTaskMode } from '../../src/mesh/worker-report.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';
const meshId = 'review-mesh';
let workspace: string;
const claim = { providerType: 'codex-cli', assignedModel: 'gpt-5.4', allowedTaskDifficulties: ['medium', 'difficult'] as const };
const context = () => ({ deps: { statusInstanceId: 'daemon-host' }, components: () => ({}) }) as any;
const proof = () => ({ workspace, machineId: 'review-machine' });
const row = (id: string) => getQueueEntryById(meshId, id)!;
const task = (message = 'Task', targetNodeId = 'node', ownedPaths: string[] | undefined = ['file.ts']) =>
    enqueueTask(meshId, message, { difficulty: 'medium', targetNodeId, ownedPaths });
const revise = (id: string, patch: object, expectedRevision = 0): Promise<any> => meshStoreIpcHandlers.queue_revise(context(), {
    v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: id, expectedRevision, patch,
});
const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
function otherWorktree(): string {
    git('add', 'file.ts');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
    const other = join(state.dir, 'other-worktree');
    git('worktree', 'add', '-b', 'other', other);
    state.mesh.nodes.push({ id: 'other', daemonId: 'daemon-host', workspace: other });
    return other;
}
async function source() {
    const s = task('Source packet');
    expect(await revise(s.id, { phase: 'source' })).toMatchObject({ success: true });
    return row(s.id);
}
function completeSource(s: MeshWorkQueueEntry) {
    const store = MeshRuntimeStore.getInstance();
    const assigned = store.claimNextQueueTask(meshId, 'node', 'source-author', [], { ...claim, physicalContext: proof() })!;
    expect(assigned.id).toBe(s.id);
    expect(checkReportAgainstTaskMode({ meshId, taskId: s.id } as any, {
        outcome: 'completed', summary: 'Source packet only', branchState: 'not_mergeable', touchedFiles: ['file.ts'],
    } as any)).toBeNull();
    assigned.status = 'completed'; store.updateQueueEntry(assigned);
}
/** Only fixture seeding bypasses the new persistence guard, to model old disk graphs. */
function persistLegacy(entry: MeshWorkQueueEntry) {
    MeshRuntimeStore.getInstance().db.prepare('UPDATE mesh_queue SET status = ?, payload = ? WHERE mesh_id = ? AND id = ?')
        .run(entry.status, JSON.stringify(entry), meshId, entry.id);
}
beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'product-a-round2-')); __resetMeshRuntimeStoreForTests();
    state.trigger.mockClear(); workspace = join(state.dir, 'workspace'); mkdirSync(workspace);
    git('init', '-q', '-b', 'main'); writeFileSync(join(workspace, 'file.ts'), 'export {};');
    state.mesh = { id: meshId, repoIdentity: 'repo', meshHost: { role: 'host', hostDaemonId: 'daemon-host' }, nodes: [{ id: 'node', daemonId: 'daemon-host', workspace }] };
});
afterEach(() => { __resetMeshRuntimeStoreForTests(); rmSync(state.dir, { recursive: true, force: true }); });

it('rejects new ordinary dependents of validated completed/not_mergeable source atomically', async () => {
    const s = await source(); completeSource(s);
    const before = MeshRuntimeStore.getInstance().getQueueEntries(meshId);
    expect(() => enqueueTask(meshId, 'Ordinary feature', { difficulty: 'medium', dependsOn: [s.id] })).toThrow(/integration_dependents/);
    expect(MeshRuntimeStore.getInstance().getQueueEntries(meshId)).toEqual(before);
});
it('rejects dependent-side host pending CAS with no edge, revision, audit or trigger mutation', async () => {
    const s = await source(); const dependent = task('Ordinary dependent');
    state.trigger.mockClear();
    expect(await revise(dependent.id, { dependsOn: [s.id] })).toMatchObject({ success: false, error: expect.stringContaining('integration_dependents') });
    expect(row(dependent.id)).toEqual(dependent); expect(state.trigger).not.toHaveBeenCalled();
});
it('rolls back an entire batch when its last ordinary edge would consume source', async () => {
    const s = await source(); const store = MeshRuntimeStore.getInstance(); const before = store.getQueueEntries(meshId);
    expect(() => enqueueTaskBatch(meshId, [
        { ref: 'valid', message: 'Valid ordinary', difficulty: 'medium' },
        { message: 'Invalid consumer', difficulty: 'medium', dependsOn: [s.id] },
    ])).toThrow(/integration_dependents/);
    expect(store.getQueueEntries(meshId)).toEqual(before);
});
it('rejects the inverse graph ordering and the losing source/dependent revision race', async () => {
    const s = task('Future source'); const d = task('Dependent');
    const results = await Promise.all([revise(s.id, { phase: 'source' }), revise(d.id, { dependsOn: [s.id] })]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(row(d.id)).toEqual(d);
    const s2 = task('Source second'); const d2 = task('Dependent first');
    expect(await revise(d2.id, { dependsOn: [s2.id] })).toMatchObject({ success: true });
    const before = row(s2.id);
    expect(await revise(s2.id, { phase: 'source' })).toMatchObject({ success: false }); expect(row(s2.id)).toEqual(before);
});
it('rejects phase changes at either end and low-level edge writes before mutation', async () => {
    const s = await source(); const integration = task('Integration');
    expect(await revise(integration.id, { phase: 'integration', dependsOn: [s.id] })).toMatchObject({ success: true });
    const before = row(integration.id);
    expect(await revise(integration.id, { phase: 'source' }, before.revision)).toMatchObject({ success: false });
    expect(row(integration.id)).toEqual(before);
    const ordinary = task('Ordinary'); const store = MeshRuntimeStore.getInstance();
    expect(() => store.updateQueueEntry({ ...ordinary, dependsOn: [s.id] })).toThrow(/integration_dependents/);
    expect(row(ordinary.id)).toEqual(ordinary);
    const sibling = task('Ordinary sibling');
    store.updateQueueEntry({ ...ordinary, dependsOn: [sibling.id] });
    expect(() => store.updateQueueEntry({ ...sibling, dependsOn: [ordinary.id] })).toThrow(/dependency_cycle/);
    expect(row(sibling.id)).toEqual(sibling);
    expect(() => store.replaceQueue(meshId, store.getQueueEntries(meshId).map(t => t.id === integration.id ? { ...t, phase: undefined } : t))).toThrow(/integration_dependents/);
    expect(row(integration.id)).toEqual(before);
});
it('holds direct and transitive recovered legacy graph consumers after restart', async () => {
    const s = await source(); completeSource(s);
    const d = task('Old unsafe edge', 'feature');
    const downstream = task('Downstream', 'downstream'); const direct = task('Direct', 'direct');
    persistLegacy({ ...d, dependsOn: [s.id], status: 'completed' });
    persistLegacy({ ...downstream, dependsOn: [d.id] }); persistLegacy({ ...direct, dependsOn: [s.id] });
    __resetMeshRuntimeStoreForTests(); const store = MeshRuntimeStore.getInstance();
    for (const [node, id] of [['direct', direct.id], ['downstream', downstream.id]]) {
        const graph = new Map(store.getQueueEntries(meshId).map(t => [t.id, t]));
        expect(taskDependenciesSatisfied(row(id), new Map([...graph].map(([id, t]) => [id, t.status])), graph)).toBe(false);
        expect(store.claimNextQueueTask(meshId, node, node, [], claim)).toBeNull();
    }
});
it('CONTROL releases a legitimate integration anchor then ordinary dependent, plus completed ordinary workflows', async () => {
    const s = await source(); completeSource(s);
    const integration = task('Integration');
    expect(await revise(integration.id, { phase: 'integration', dependsOn: [s.id] })).toMatchObject({ success: true });
    const d = enqueueTask(meshId, 'Final feature', { difficulty: 'medium', targetNodeId: 'feature', dependsOn: [integration.id] });
    const store = MeshRuntimeStore.getInstance(); expect(store.claimNextQueueTask(meshId, 'feature', 'feature', [], claim)).toBeNull();
    const anchor = store.claimNextQueueTask(meshId, 'node', 'integrator', [], { ...claim, physicalContext: proof() })!;
    expect(anchor.id).toBe(integration.id); anchor.status = 'completed'; store.updateQueueEntry(anchor);
    const feature = store.claimNextQueueTask(meshId, 'feature', 'feature', [], claim)!; expect(feature.id).toBe(d.id);
    feature.status = 'completed'; store.updateQueueEntry(feature);
    const ordinary = enqueueTask(meshId, 'Ordinary followup', { difficulty: 'medium', targetNodeId: 'followup', dependsOn: [d.id] });
    expect(store.claimNextQueueTask(meshId, 'followup', 'followup', [], claim)?.id).toBe(ordinary.id);
});

for (const phase of ['source', 'integration'] as const) {
    for (const ordering of ['legacy-first', 'attested-first'] as const) {
        it(`${phase} fences alias-node legacy writer in ${ordering} order through ingress and claim`, async () => {
            const alias = join(state.dir, 'alias'); symlinkSync(workspace, alias);
            state.mesh.nodes.push({ id: 'legacy-alias', daemonId: 'daemon-host', workspace: alias });
            const store = MeshRuntimeStore.getInstance(); const scoped = task('Scoped');
            if (ordering === 'attested-first') expect(await revise(scoped.id, { phase })).toMatchObject({ success: true });
            const legacy = task('Legacy', 'legacy-alias', ['legacy.ts']);
            expect(store.claimNextQueueTask(meshId, 'legacy-alias', 'legacy', [], { ...claim, physicalContext: { workspace: alias, machineId: 'review-machine' } })?.id).toBe(legacy.id);
            if (ordering === 'legacy-first') {
                const before = row(scoped.id);
                expect(await revise(scoped.id, { phase })).toMatchObject({ success: false }); expect(row(scoped.id)).toEqual(before);
            }
            expect(store.claimNextQueueTask(meshId, 'node', 'second', [], { ...claim, physicalContext: proof() })).toBeNull();
            expect(row(legacy.id).status).toBe('assigned');
        });
    }
}
it('integration is fenced beside a legacy writer in a real separate worktree, including recovery', async () => {
    const other = otherWorktree(); const integration = task('Integration');
    expect(await revise(integration.id, { phase: 'integration' })).toMatchObject({ success: true });
    const legacy = task('Legacy', 'other', ['legacy.ts']); const store = MeshRuntimeStore.getInstance();
    expect(store.claimNextQueueTask(meshId, 'other', 'legacy', [], { ...claim, physicalContext: { workspace: other, machineId: 'review-machine' } })?.id).toBe(legacy.id);
    __resetMeshRuntimeStoreForTests();
    expect(MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, 'node', 'integrator', [], { ...claim, physicalContext: proof() })).toBeNull();
    expect(row(legacy.id).status).toBe('assigned');
});
it('unknown legacy context and absent logical declarations remain fences despite caller workspace strings', async () => {
    const s = await source(); const legacy = enqueueTask(meshId, 'Unknown legacy', { difficulty: 'medium', targetNodeId: 'unknown' });
    const store = MeshRuntimeStore.getInstance();
    expect(store.claimNextQueueTask(meshId, 'unknown', 'legacy', [], { ...claim, physicalContext: { workspace: '/invented/independent', machineId: 'fake' } })?.id).toBe(legacy.id);
    expect(evaluateTaskOwnedPathsAdmission(store, meshId, row(s.id)).allowed).toBe(false);
    expect(store.claimNextQueueTask(meshId, 'node', 'second', [], { ...claim, physicalContext: proof() })).toBeNull();
    expect(row(legacy.id).ownershipScope).toBeUndefined();
});
it('pending launch reservations fence both ingress and claims, exclude self and expire normally', async () => {
    const s = await source(); const legacy = task('Reserved legacy', 'other', ['legacy.ts']); const store = MeshRuntimeStore.getInstance();
    const reserved = { ...legacy, autoLaunch: { status: 'started' as const, nodeId: 'other', providerType: 'codex-cli', updatedAt: new Date().toISOString() } };
    store.updateQueueEntry(reserved);
    expect(evaluateTaskOwnedPathsAdmission(store, meshId, row(legacy.id)).allowed).toBe(true);
    expect(evaluateTaskOwnedPathsAdmission(store, meshId, row(s.id)).allowed).toBe(false);
    expect(store.claimNextQueueTask(meshId, 'node', 'source', [], { ...claim, physicalContext: proof() })).toBeNull();
    const pending = task('Pending integration'); expect(await revise(pending.id, { phase: 'integration' })).toMatchObject({ success: false });
    reserved.autoLaunch.updatedAt = new Date(Date.now() - 120_000).toISOString(); store.updateQueueEntry(reserved);
    expect(store.claimNextQueueTask(meshId, 'node', 'source', [], { ...claim, physicalContext: proof() })?.id).toBe(s.id);
});
it('CONTROL two proven disjoint source worktrees retain concurrency and integration exclusion', async () => {
    otherWorktree(); const first = await source(); const second = task('Second source', 'other');
    expect(await revise(second.id, { phase: 'source' })).toMatchObject({ success: true });
    const store = MeshRuntimeStore.getInstance();
    expect(store.claimNextQueueTask(meshId, 'node', 'first', [], { ...claim, physicalContext: proof() })?.id).toBe(first.id);
    expect(store.claimNextQueueTask(meshId, 'other', 'second', [], { ...claim, physicalContext: { workspace: state.mesh.nodes[1].workspace, machineId: 'review-machine' } })?.id).toBe(second.id);
    const integration = task('Integration'); const before = row(integration.id);
    expect(await revise(integration.id, { phase: 'integration' })).toMatchObject({ success: false }); expect(row(integration.id)).toEqual(before);
});

for (const phase of ['source', 'integration'] as const) {
    it(`active attested ${phase} blocks the inverse legacy claim order`, async () => {
        const store = MeshRuntimeStore.getInstance(); const scoped = task('Scoped');
        expect(await revise(scoped.id, { phase })).toMatchObject({ success: true });
        expect(store.claimNextQueueTask(meshId, 'node', 'scoped', [], { ...claim, physicalContext: proof() })?.id).toBe(scoped.id);
        const legacy = task('Legacy second', 'unknown-alias', ['legacy.ts']);
        expect(store.claimNextQueueTask(meshId, 'unknown-alias', 'legacy', [], { ...claim, physicalContext: { workspace: '/invented', machineId: 'fake' } })).toBeNull();
        expect(row(legacy.id).status).toBe('pending'); expect(row(scoped.id).status).toBe('assigned');
    });
}

for (const status of ['assigned', 'reserved'] as const) {
    it(`unknown ${status} writer without paths blocks an input review lease`, async () => {
        const s = await source(); completeSource(s); const store = MeshRuntimeStore.getInstance();
        const legacy = enqueueTask(meshId, 'Unknown writer', { difficulty: 'medium', targetNodeId: 'unknown' });
        if (status === 'assigned') {
            expect(store.claimNextQueueTask(meshId, 'unknown', 'legacy', [], claim)?.id).toBe(legacy.id);
        } else {
            store.updateQueueEntry({ ...legacy, autoLaunch: { status: 'started', nodeId: 'unknown', providerType: 'codex-cli', updatedAt: new Date().toISOString() } });
        }
        const review = enqueueTask(meshId, 'Review input', { difficulty: 'medium', readonly: true, targetNodeId: 'node' });
        expect(await revise(review.id, { review: { sourceTaskId: s.id, differentProvider: true } })).toMatchObject({ success: true });
        expect(store.claimNextQueueTask(meshId, 'node', 'reviewer', [], { ...claim, providerType: 'claude-cli', physicalContext: proof() })).toBeNull();
        expect(row(review.id).hold?.reason).toBe('review_input_busy');
    });
}
