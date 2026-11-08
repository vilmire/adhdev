// Read-only stage evidence is separate from source write ownership, including exact gitlinks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const testTmpDir = path.join(tmpdir(), `adhdev-stage-attest-${randomUUID().slice(0, 8)}`);
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

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { bindMeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js';
import { reviewRoutingRefusal } from '../../src/mesh/mesh-task-routing-contract.js';
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { currentStageReviewScope } from '../../src/mesh/stage-review-input.js';
import { findTaskOwnedPathsConflicts, readInFlightOwnershipMeshWide } from '../../src/mesh/mesh-runtime-store-claim.js';
import { attestLocalOwnership } from '../../src/mesh/mesh-physical-ownership.js';
import { setPathOwnershipGateForTests } from '../../src/mesh/mesh-path-ownership-gate.js';
import { StagePipelineRuntime } from '../../src/mesh/stage-pipeline-runtime.js';
import { stashStageReport } from '../../src/mesh/stage-report-stash.js';
import { initialStageState } from '../../src/mesh/stage-state.js';
import { createProductionStagePorts } from '../../src/mesh/stage-ports-default.js';

const dirs: string[] = [];
let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    meshConfigMocks.getMesh.mockReset(); meshConfigMocks.listMeshes.mockReturnValue([]);
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function setup(opts: { ownedPaths?: string[] | null } = {}) {
    const ws = fs.mkdtempSync(path.join(tmpdir(), 'stage-attest-')); dirs.push(ws);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: ws, stdio: 'pipe', windowsHide: true, encoding: 'utf8' }).trim();
    g('init', '-q');
    g('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    const head = g('rev-parse', 'HEAD');
    currentMesh = `mesh_attest_${randomUUID().slice(0, 8)}`;
    bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
    meshConfigMocks.getMesh.mockReturnValue({ id: currentMesh, repoIdentity: 'fixture/repo', nodes: [{ id: 'node_a', daemonId: 'test-machine', workspace: ws }] });
    const parent = enqueueTask(currentMesh, 'review immutable commits', { taskMode: 'code_change', difficulty: 'medium', review: true, ...(opts.ownedPaths === null ? {} : { ownedPaths: opts.ownedPaths ?? ['oss', 'packages/p/vendor/mcp-server'] }) } as any);
    const store = MeshRuntimeStore.getInstance();
    const initial = store.findQueueEntryById(currentMesh, parent.id)!;
    Object.assign(initial, { status: 'assigned', assignedNodeId: 'node_a', assignedSessionId: 'sess-impl', assignedProviderType: 'claude-cli' });
    Object.assign(initial.stageState!, { phase: 'awaiting_review', round: 1, baseSha: head, stageHeads: [{ round: 1, rootSha: head }] });
    store.updateQueueEntry(initial);
    const file = path.join(ws, 'evidence.md'); fs.writeFileSync(file, 'authorized worker evidence');
    store.db.prepare(`INSERT INTO session_artifacts (artifact_id,session_id,task_id,mesh_id,producer_role,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('art_evidence', 'sess-impl', parent.id, currentMesh, 'worker', ws, 'evidence.md', 'markdown', 'text/markdown', 'Evidence', fs.statSync(file).size, createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 1, 1);
    const source = () => store.findQueueEntryById(currentMesh!, parent.id)!;
    const live = source();
    const ports = createProductionStagePorts({ sessionRegistry: undefined, instanceManager: undefined, statusInstanceId: 'test-machine' } as any);
    return { ws, live, store, ports, source, file, g };
}
const spec = { round: 1, message: 'review', inputArtifactIds: ['art_evidence'], independence: 'different_provider' as const };
const ctx = (workspace: string) => ({ workspace, machineId: 'test-machine' });

describe('stage readonly input attestation', () => {
    it('runs normal production stage enqueue with worker, diff and self-check grants bound atomically', async () => {
        const { ws, ports, store, source, g } = setup();
        fs.appendFileSync(path.join(ws, '.git/info/exclude'), '\nevidence.md\nart_generated_*.md\n');
        meshConfigMocks.listMeshes.mockReturnValue([meshConfigMocks.getMesh()]);
        const parent = source();
        parent.stageState = initialStageState(new Date().toISOString());
        parent.stageState.workerArtifactIds = ['art_evidence'];
        store.updateQueueEntry(parent);
        const base = g('rev-parse', 'HEAD');
        g('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'continuation');
        ports.git = { ...ports.git, baseSha: async () => base, fingerprint: async () => 'stable-checkout' };
        ports.selfCheck = { run: async () => ({ status: 'passed', log: 'fixture' }) };
        let n = 0;
        ports.artifacts.register = input => {
            const id = `art_generated_${++n}`;
            const rel = `${id}.md`; fs.writeFileSync(path.join(ws, rel), input.content);
            store.db.prepare(`INSERT INTO session_artifacts (artifact_id,session_id,task_id,mesh_id,producer_role,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, `stage:${parent.id}`, parent.id, parent.meshId, 'pipeline', ws, rel, 'markdown', 'text/markdown', input.title, Buffer.byteLength(input.content), createHash('sha256').update(input.content).digest('hex'), 1, 1);
            return id;
        };
        const runtime = new StagePipelineRuntime(ports);
        await runtime.onImplCompleted(parent.meshId, parent.id, 'completed-attempt');
        const stored = source();
        expect(stored.stageState!.phase).toBe('awaiting_review');
        expect(stored.stageState!.reviewFingerprint).toBe('stable-checkout');
        expect(stored.stageState!.reviewTaskIds).toHaveLength(1);
        const child = store.findQueueEntryById(parent.meshId, stored.stageState!.reviewTaskIds[0])!;
        expect(child.inputArtifactIds).toEqual(['art_generated_1', 'art_generated_2', 'art_evidence']);
        expect(reviewRoutingRefusal(child, stored, 'codex-cli', ctx(ws), [stored])).toBeUndefined();
        await runtime.onImplCompleted(parent.meshId, parent.id, 'completed-attempt');
        expect(source().stageState!.reviewTaskIds).toEqual([child.id]);
        fs.writeFileSync(path.join(ws, 'evidence.md'), 'mutated during review');
        store.updateQueueEntry({ ...child, status: 'completed', assignedProviderType: 'codex-cli', assignedSessionId: 'reviewer' });
        stashStageReport(parent.meshId, child.id, { outcome: 'completed', summary: 'approve', at: Date.now(), review: { verdict: 'approve', findings: [], checked: ['evidence'], notChecked: [] } });
        await runtime.onChildTerminal(parent.meshId, child.id);
        expect(source().stageState!.blockedReason).toBe('reviewer_integrity_unverifiable');
    });
    it('pins the read-lease review child to the parent node so another checkout cannot claim it', () => {
        const { live, ports, source } = setup();
        const child = ports.queue.enqueueReviewChild(live, spec);
        expect(child.targetNodeId).toBe(live.assignedNodeId ?? live.targetNodeId);
        expect(child.targetNodeId).toBeTruthy();
        expect(source().stageState!.reviewTaskIds).toEqual([child.id]);
    });
    it('reviews exact oss declarations and clean zero-new-delta parent without writer ownership', () => {
        const { ws, live, ports, source } = setup();
        const child = ports.queue.enqueueReviewChild(live, spec);
        expect(source().ownershipScope).toBeUndefined();
        expect(() => attestLocalOwnership({ workspace: ws, repoIdentity: 'fixture/repo', machineId: 'test-machine', nodeId: 'node_a', phase: 'source', paths: live.ownedPaths! })).toThrow('source_phase_path_forbidden: oss');
        expect(source().stageReviewInput?.checkout.declaration).toEqual([]);
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [source()])).toBeUndefined();
        expect(reviewRoutingRefusal(child, { ...source(), stageReviewInput: undefined }, 'codex-cli', ctx(ws), [])).toBe('review_input_unavailable');
    });
    it('refuses wrong authenticated cwd/machine, missing or extra grants, wrong round and changed bytes', () => {
        const { ws, live, ports, source, file } = setup();
        const child = ports.queue.enqueueReviewChild(live, spec);
        for (const badCtx of [ctx(path.dirname(ws)), { ...ctx(ws), machineId: 'remote' }, { ...ctx(ws), repoIdentity: 'other-repo' }]) {
            expect(reviewRoutingRefusal(child, source(), 'codex-cli', badCtx, [])).toBe('review_input_unavailable');
        }
        for (const bad of [{ ...child, inputArtifactIds: [] }, { ...child, inputArtifactIds: [...spec.inputArtifactIds, 'art_other'] }, { ...child, stageRound: 2 }]) {
            expect(reviewRoutingRefusal(bad, source(), 'codex-cli', ctx(ws), [])).toBe('review_input_unavailable');
        }
        fs.writeFileSync(file, 'mutated bytes');
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [])).toBe('review_input_unavailable');
    });
    it('refuses missing inputs, unauthorized provenance and hash-invalid artifacts without a child', () => {
        const { live, ports, store, source } = setup();
        expect(() => ports.queue.enqueueReviewChild(live, { ...spec, inputArtifactIds: [] })).toThrow('artifacts_missing');
        expect(() => ports.queue.enqueueReviewChild(live, { ...spec, inputArtifactIds: ['art_absent'] })).toThrow('unauthorized');
        store.db.prepare('UPDATE session_artifacts SET task_id = ? WHERE artifact_id = ?').run('unrelated', 'art_evidence');
        expect(() => ports.queue.enqueueReviewChild(live, spec)).toThrow('unauthorized');
        store.db.prepare('UPDATE session_artifacts SET task_id = ?, sha256 = ? WHERE artifact_id = ?').run(live.id, '0'.repeat(64), 'art_evidence');
        expect(() => ports.queue.enqueueReviewChild(live, spec)).toThrow('artifact_hash');
        expect(source().stageState!.reviewTaskIds).toEqual([]);
    });
    it('withholds an implementer-cited artifact that changed after registration instead of refusing the review', () => {
        const { ws, ports, store, source, file } = setup();
        const diff = path.join(ws, 'diff.patch'); fs.writeFileSync(diff, 'pipeline diff');
        store.db.prepare(`INSERT INTO session_artifacts (artifact_id,session_id,task_id,mesh_id,producer_role,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('art_diff', 'stage:p', source().id, currentMesh, 'pipeline', ws, 'diff.patch', 'text', 'text/plain', 'Diff', fs.statSync(diff).size, createHash('sha256').update(fs.readFileSync(diff)).digest('hex'), 1, 1);
        const parent = source(); parent.stageState!.workerArtifactIds = ['art_evidence']; store.updateQueueEntry(parent);
        fs.writeFileSync(file, 'edited after registration');
        const child = ports.queue.enqueueReviewChild(source(), { ...spec, inputArtifactIds: ['art_diff', 'art_evidence'] });
        expect(child.inputArtifactIds).toEqual(['art_diff']);
        expect(child.message).toMatch(/art_evidence changed or disappeared/);
        expect(currentStageReviewScope(source(), store.findQueueEntryById(currentMesh!, child.id)!)).toBeTruthy();
    });
    it('still refuses when the changed artifact is not one the implementer only cited', () => {
        const { live, ports, file } = setup();
        fs.writeFileSync(file, 'edited after registration');
        expect(() => ports.queue.enqueueReviewChild(live, spec)).toThrow('artifact_hash');
    });
    it('refuses changed HEAD before creation and after enqueue', () => {
        const { live, ports, source, ws, g, store } = setup();
        g('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'changed');
        expect(() => ports.queue.enqueueReviewChild(live, spec)).toThrow('head_changed');
        const updated = source(); updated.stageState!.stageHeads[0].rootSha = g('rev-parse', 'HEAD'); store.updateQueueEntry(updated);
        const child = ports.queue.enqueueReviewChild(source(), spec);
        g('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'changed again');
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [])).toBe('review_input_unavailable');
    });
    it('CAS refuses a raced parent and repeat creation never duplicates a review', () => {
        const { live, ports, store, source } = setup();
        const changed = source(); changed.message = 'concurrent revision'; store.updateQueueEntry(changed);
        expect(() => ports.queue.enqueueReviewChild(live, spec)).toThrow('stage_review_stale_parent');
        const child = ports.queue.enqueueReviewChild(source(), spec);
        expect(ports.queue.enqueueReviewChild(source(), spec).id).toBe(child.id);
        expect(source().stageState!.reviewTaskIds).toEqual([child.id]);
        expect(source().stageState!.round).toBe(1);
    });
    it('keeps the original fingerprint on retry and refuses a started reviewer', () => {
        const { live, ports, store, source } = setup();
        const child = ports.queue.enqueueReviewChild(live, { ...spec, reviewFingerprint: 'original' });
        ports.queue.enqueueReviewChild(source(), { ...spec, reviewFingerprint: 'replacement' });
        expect(source().stageState!.reviewFingerprint).toBe('original');
        store.updateQueueEntry({ ...child, status: 'assigned', assignedSessionId: 'reviewer' });
        expect(() => ports.queue.enqueueReviewChild(source(), spec)).toThrow('already_started');
        expect(source().stageState!.reviewTaskIds).toEqual([child.id]);
    });
    it('attests actual gitlinks and refuses a changed submodule checkout', () => {
        const { live, ports, store, source, ws, g } = setup();
        const sub = fs.mkdtempSync(path.join(tmpdir(), 'stage-sub-')); dirs.push(sub);
        const sg = (...args: string[]) => execFileSync('git', args, { cwd: sub, windowsHide: true, stdio: 'pipe' });
        sg('init', '-q'); fs.writeFileSync(path.join(sub, 'f.ts'), 'export {};'); sg('add', 'f.ts'); sg('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'submodule');
        g('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'oss');
        g('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'gitlink');
        const updated = source(); updated.stageState!.stageHeads[0].rootSha = g('rev-parse', 'HEAD'); store.updateQueueEntry(updated);
        const child = ports.queue.enqueueReviewChild(source(), spec);
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [])).toBeUndefined();
        // Another checkout sharing the nested Git store must remain fenced by the read lease.
        const peer = path.join(path.dirname(sub), `${path.basename(sub)}-peer`); dirs.push(peer);
        execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', '--recurse-submodules', ws, peer], { windowsHide: true, stdio: 'pipe' });
        fs.rmSync(path.join(peer, '.git/modules/oss'), { recursive: true, force: true });
        fs.symlinkSync(path.join(ws, '.git/modules/oss'), path.join(peer, '.git/modules/oss'), 'dir');
        const paths = normalizeOwnedPaths(['oss/f.ts']).declaration;
        const ownershipScope = attestLocalOwnership({ workspace: peer, paths, phase: 'source', repoIdentity: 'fixture/repo', machineId: 'test-machine', nodeId: 'peer' });
        const lease = currentStageReviewScope(source(), child)!;
        const readers = readInFlightOwnershipMeshWide({ assignedRowsMeshWide: () => [{ payload: JSON.stringify({ ...child, status: 'assigned', reviewInputScope: lease }) }] }, live.meshId);
        expect(findTaskOwnedPathsConflicts({ id: 'peer-writer', ownedPaths: paths, ownershipScope }, readers)).toHaveLength(1);
        g('config', 'diff.ignoreSubmodules', 'all');
        fs.writeFileSync(path.join(ws, 'oss/f.ts'), 'dirty source');
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [])).toBe('review_input_unavailable');
        fs.writeFileSync(path.join(ws, 'oss/f.ts'), 'export {};');
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'changed submodule'], { cwd: path.join(ws, 'oss'), windowsHide: true, stdio: 'pipe' });
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [])).toBe('review_input_unavailable');
    });
    it('unrelated active writers remain fenced', () => {
        const { live, ports, store, source } = setup();
        const writer = enqueueTask(live.meshId, 'other writer', { taskMode: 'code_change', difficulty: 'medium' });
        store.updateQueueEntry({ ...writer, status: 'assigned', assignedNodeId: 'node_a' });
        expect(() => ports.queue.enqueueReviewChild(source(), spec)).toThrow('review_input_busy');
        expect(source().stageState!.reviewTaskIds).toEqual([]);
    });
});

describe('path-ownership gate off (default): a stage review does not depend on the implementer owned_paths', () => {
    it('implementer without owned_paths or ownershipScope: the review child gets its own checkout+head review input and claims', () => {
        const { ws, live, ports, source, store } = setup({ ownedPaths: null });
        expect(source().ownedPaths).toBeUndefined();
        expect(source().ownershipScope).toBeUndefined();
        const child = ports.queue.enqueueReviewChild(live, spec);
        expect(source().stageReviewInput?.headSha).toBe(source().stageState!.stageHeads.at(-1)!.rootSha);
        expect(reviewRoutingRefusal(child, source(), 'codex-cli', ctx(ws), [source()])).toBeUndefined();
        const refusal: any = {};
        const claimed = store.claimNextQueueTask(live.meshId, 'node_a', 'reviewer-sess', [], { providerType: 'codex-cli', physicalContext: { ...ctx(ws), repoIdentity: 'fixture/repo' }, outRefusal: refusal } as any);
        expect(refusal.reason).toBeUndefined();
        expect(claimed?.id).toBe(child.id);
        expect(claimed?.reviewInputScope?.worktree).toBe(fs.realpathSync.native(ws));
    });
    it('an unscoped writer in ANOTHER checkout does not make the review input busy; the same checkout still does', () => {
        const { live, ports, store, source } = setup({ ownedPaths: null });
        const other = enqueueTask(live.meshId, 'other checkout writer', { taskMode: 'code_change', difficulty: 'medium' });
        store.updateQueueEntry({ ...other, status: 'assigned', assignedNodeId: 'node_b' });
        expect(() => ports.queue.enqueueReviewChild(source(), spec)).not.toThrow();
    });
    it('mesh_wide keeps the legacy fence: that unscoped writer holds the review input busy', () => {
        const { live, ports, store, source } = setup({ ownedPaths: null });
        const other = enqueueTask(live.meshId, 'other checkout writer', { taskMode: 'code_change', difficulty: 'medium' });
        store.updateQueueEntry({ ...other, status: 'assigned', assignedNodeId: 'node_b' });
        setPathOwnershipGateForTests('mesh_wide');
        try { expect(() => ports.queue.enqueueReviewChild(source(), spec)).toThrow('review_input_busy'); }
        finally { setPathOwnershipGateForTests(undefined); }
    });
});

