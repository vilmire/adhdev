// Read-only stage evidence is separate from source write ownership, including exact gitlinks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const testTmpDir = path.join(fs.realpathSync.native(tmpdir()), `adhdev-review-recovery-${randomUUID().slice(0, 8)}`);
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
import { initialStageState } from '../../src/mesh/stage-state.js';
import { recoverPendingStageReview, decodeStageReviewRecovery, type StageReviewRecoveryRequest } from '../../src/mesh/stage-review-recovery.js';
import { reviewRoutingRefusal } from '../../src/mesh/mesh-task-routing-contract.js';
import { meshQueueHandlers } from '../../src/commands/med-family/mesh-queue.js';
import { createProductionStagePorts, installStagePipeline, setStageArtifactRegistrar } from '../../src/mesh/stage-ports-default.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { beginTaskDispatchInFlight, __resetTaskDispatchInFlightForTests } from '../../src/mesh/mesh-task-inflight.js';
import type { StageRuntimePorts } from '../../src/mesh/stage-ports.js';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import { attestLocalOwnership } from '../../src/mesh/mesh-physical-ownership.js';
import { currentStageReviewScope } from '../../src/mesh/stage-review-input.js';
import { artifactHandlers } from '../../src/commands/med-family/artifacts.js';
import { mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
const dirs: string[] = [];
let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined; __resetTaskDispatchInFlightForTests();
    meshConfigMocks.getMesh.mockReset(); meshConfigMocks.listMeshes.mockReturnValue([]);
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function setup() {
    const ws = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'review-recovery-')); dirs.push(ws);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: ws, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-q'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base');
    const head = git('rev-parse', 'HEAD'); currentMesh = `mesh_recover_${randomUUID()}`;
    bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
    meshConfigMocks.getMesh.mockReturnValue({ id: currentMesh, repoIdentity: 'fixture/repo', meshHost: { role: 'host', hostDaemonId: 'test-machine' }, nodes: [{ id: 'node_a', daemonId: 'test-machine', workspace: ws }] });
    const store = MeshRuntimeStore.getInstance();
    const p0 = enqueueTask(currentMesh, 'implement', { taskMode: 'code_change', difficulty: 'difficult', review: true, missionId: 'mission', ownedPaths: ['oss'] });
    const c0 = enqueueTask(currentMesh, 'review', { difficulty: 'difficult', missionId: 'mission', inputArtifactIds: ['art_report'], inheritArtifacts: false, stageChild: { parentTaskId: p0.id, round: 1, review: { sourceTaskId: p0.id, independence: 'different_provider' } } });
    const state = initialStageState(new Date().toISOString());
    Object.assign(state, { phase: 'awaiting_review', round: 1, baseSha: head, stageHeads: [{ round: 1, rootSha: head }], reviewTaskIds: [c0.id], workerArtifactIds: ['art_report'], reviewFingerprint: 'old-fingerprint', selfCheck: 'passed' });
    store.updateQueueEntry({ ...p0, status: 'assigned', assignedNodeId: 'node_a', assignedSessionId: 'implementer', assignedProviderType: 'codex-cli', stageState: state });
    const parent = () => store.findQueueEntryById(currentMesh!, p0.id)!;
    const child = () => store.findQueueEntryById(currentMesh!, c0.id)!;
    const decision = { question: 'Allow this review only at medium?', options: [{ id: 'a', label: 'This review only: medium' }], answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date().toISOString() }, answerRevision: 1 } as any;
    store.missionItems().insertItem({ id: 'approval', meshId: currentMesh, missionId: 'mission', kind: 'decision', state: 'answered', text: 'Task-specific approval', refs: [{ kind: 'task', value: c0.id }], decision });
    let n = 0;
    const register = (id: string, taskId: string, content: string, role = 'worker') => {
        fs.writeFileSync(path.join(ws, `${id}.md`), content);
        store.db.prepare(`INSERT INTO session_artifacts (artifact_id,session_id,task_id,mesh_id,producer_role,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, role === 'pipeline' ? `stage:${taskId}` : 'implementer', taskId, currentMesh, role, ws, `${id}.md`, 'markdown', 'text/markdown', 'Evidence', Buffer.byteLength(content), createHash('sha256').update(content).digest('hex'), 1, 1);
        return id;
    };
    register('art_report', p0.id, 'existing report');
    const fp = { value: 'fresh-fingerprint' as string | null };
    const ports = { git: { diff: async () => 'continuation diff', fingerprint: async () => fp.value }, artifacts: { register: (i: any) => ({ ok: true as const, artifactId: register(`art_diff_${++n}`, i.taskId, i.content, 'pipeline') }) } } as Pick<StageRuntimePorts, 'git' | 'artifacts'>;
    const host = { actor: 'test-machine', repoIdentity: 'fixture/repo', machineId: 'test-machine', nodeId: 'node_a', workspace: ws };
    const request = (): StageReviewRecoveryRequest => ({ v: 1, meshId: currentMesh!, parentTaskId: p0.id, reviewTaskId: c0.id, expectedParentRevision: parent().revision ?? 0, expectedReviewRevision: child().revision ?? 0, expectedStageHeadSha: head, expectedHeadSha: head, expectedWorkspace: fs.realpathSync.native(ws), ownerDecisionId: 'approval', ownerAnswerRevision: 1, ownerOptionId: 'a', difficulty: 'medium', reviewerProvider: 'antigravity-cli', inputArtifactIds: [], dryRun: true });
    const apply = async (r = request()) => {
        const preview = await recoverPendingStageReview(r, host, ports);
        return recoverPendingStageReview({ ...r, dryRun: false, expectedFingerprint: 'fresh-fingerprint', expectedArtifactDigest: preview.artifactDigest }, host, ports);
    };
    const snapshot = () => JSON.stringify([parent(), child()]);
    return { ws, git, head, store, parent, child, decision, register, fp, ports, host, request, apply, snapshot };
}

describe('owner/CAS pending review recovery', () => {
    it('matches normalized source node identity and refuses missing or foreign assignments without writes', async () => {
        const h = setup(); const original = h.parent();
        for (const assignedNodeId of [undefined, '', 'node_foreign']) {
            h.store.updateQueueEntry({ ...original, assignedNodeId });
            const before = h.snapshot();
            await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_source_node_mismatch');
            expect(h.snapshot()).toBe(before);
        }
        h.store.updateQueueEntry(original);
        await expect(recoverPendingStageReview(h.request(), { ...h.host, nodeId: ' node_a ' }, h.ports)).resolves.toMatchObject({ dryRun: true });
    });
    it('dry-run is read-only; apply preserves ids/round/claim/history and changes task-scoped difficulty/grants only', async () => {
        const h = setup(); const before = h.snapshot(); const p = h.parent(); const c = h.child();
        expect(await recoverPendingStageReview(h.request(), h.host, h.ports)).toMatchObject({ fingerprint: 'fresh-fingerprint', dryRun: true, reviewRevision: 0 });
        expect(h.snapshot()).toBe(before);
        await h.apply();
        expect(h.parent()).toMatchObject({ id: p.id, status: 'assigned', assignedSessionId: p.assignedSessionId, assignedNodeId: p.assignedNodeId, difficulty: 'difficult' });
        expect(h.child()).toMatchObject({ id: c.id, status: 'pending', stageRound: 1, parentTaskId: p.id, difficulty: 'medium', targetNodeId: 'node_a', review: c.review });
        expect(h.parent().stageState!.reviewTaskIds).toEqual([c.id]);
        expect(h.parent().stageState!.reviewFingerprint).toBe('fresh-fingerprint');
        expect(h.parent().stageReviewRecoveries![0]).toMatchObject({ ownerDecisionId: 'approval', previousFingerprint: 'old-fingerprint', previousChild: { difficulty: 'difficult' } });
        expect(reviewRoutingRefusal(h.child(), h.parent(), 'antigravity-cli', { workspace: h.ws, machineId: 'test-machine' }, [h.parent()])).toBeUndefined();
        await expect(h.apply({ ...h.request(), expectedParentRevision: p.revision ?? 0, expectedReviewRevision: c.revision ?? 0 })).rejects.toThrow('stale_review_recovery_cas');
    });
    it('refuses non-owner answers, wrong task/mission/revision and ambiguous approval scope', async () => {
        const h = setup();
        for (const patch of [{ decision: { ...h.decision, answer: { ...h.decision.answer, by: 'coordinator' } } }, { decision: { ...h.decision, answer: { ...h.decision.answer, via: 'assistant' } } }, { decision: { ...h.decision, answerRevision: 2 } }, { decision: { ...h.decision, answer: { ...h.decision.answer, optionId: 'b' } } }, { refs: [{ kind: 'task', value: 'another' }] }, { refs: [{ kind: 'task', value: h.child().id }, { kind: 'task', value: 'another' }] }, { missionId: 'other' }]) {
            h.store.missionItems().updateItem(h.request().meshId, 'approval', { missionId: 'mission', refs: [{ kind: 'task', value: h.child().id }], decision: h.decision, ...patch } as any);
            await expect(h.apply()).rejects.toThrow('owner_authorization_required');
        }
        expect(h.child().difficulty).toBe('difficult');
    });
    it('refuses started/reserved/consumed reviewers and active source attempts', async () => {
        const h = setup(); const original = h.child();
        for (const patch of [{ assignedSessionId: 'reviewer' }, { attemptId: 'attempt' }, { autoLaunch: { status: 'started' } }, { dispatchTimestamp: 'now' }]) {
            h.store.updateQueueEntry({ ...original, ...patch } as any); await expect(h.apply()).rejects.toThrow('review_already_started');
        }
        h.store.updateQueueEntry(original); beginTaskDispatchInFlight(h.request().meshId, h.parent().id);
        await expect(h.apply()).rejects.toThrow('review_source_attempt_active'); __resetTaskDispatchInFlightForTests();
        seedMeshAttempt({ meshId: h.request().meshId, taskId: h.child().id, sessionId: 'reviewer', attemptId: 'old-consumed', attemptNo: 0, stage: 'completed' });
        await expect(h.apply()).rejects.toThrow('review_already_started');
    });
    it('refuses wrong cwd, changed head, unauthorized/hash-invalid artifacts, changed fingerprint and conflicting writer', async () => {
        const h = setup(); const before = h.snapshot();
        await expect(h.apply({ ...h.request(), expectedWorkspace: path.dirname(h.ws) })).rejects.toThrow('workspace_mismatch');
        await expect(h.apply({ ...h.request(), inputArtifactIds: ['missing'] })).rejects.toThrow('artifact_unauthorized');
        h.store.db.prepare('UPDATE session_artifacts SET mesh_id = ? WHERE artifact_id = ?').run('foreign', 'art_report');
        await expect(h.apply()).rejects.toThrow('artifact_unauthorized');
        h.store.db.prepare('UPDATE session_artifacts SET mesh_id = ? WHERE artifact_id = ?').run(h.request().meshId, 'art_report');
        fs.writeFileSync(path.join(h.ws, 'art_report.md'), 'tampered'); await expect(h.apply()).rejects.toThrow('artifact_hash');
        fs.writeFileSync(path.join(h.ws, 'art_report.md'), 'existing report');
        h.fp.value = 'changed'; await expect(h.apply()).rejects.toThrow('fingerprint_changed'); h.fp.value = 'fresh-fingerprint';
        h.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'changed');
        await expect(h.apply()).rejects.toThrow('head_changed'); expect(h.snapshot()).toBe(before);
    });
    it('refuses competing writer and CAS/owner-answer races without partially repairing rows', async () => {
        const h = setup(); const request = h.request();
        h.ports.git.fingerprint = async () => { const c = h.child(); c.message = 'concurrent'; h.store.updateQueueEntry(c); return 'fresh-fingerprint'; };
        await expect(h.apply(request)).rejects.toThrow('stale_review_recovery_cas');
        expect(h.child().difficulty).toBe('difficult'); expect(h.parent().stageReviewRecoveries).toBeUndefined();
        h.ports.git.fingerprint = async () => 'fresh-fingerprint';
        const writer = enqueueTask(h.request().meshId, 'writer', { taskMode: 'code_change', difficulty: 'medium' });
        h.store.updateQueueEntry({ ...writer, status: 'assigned', assignedNodeId: 'node_a' });
        await expect(h.apply()).rejects.toThrow('review_input_busy');
    });
    it('refuses owner-answer changes during preflight without writing queue rows', async () => {
        const h = setup(); const before = h.snapshot();
        h.ports.git.fingerprint = async () => {
            h.store.missionItems().updateItem(h.request().meshId, 'approval', { state: 'open' });
            return 'fresh-fingerprint';
        };
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('owner_authorization_required');
        expect(h.snapshot()).toBe(before);
    });
    it('refuses races during artifact registration and fingerprint changes after dry-run', async () => {
        const h = setup(); const before = h.snapshot(); const register = h.ports.artifacts.register;
        h.ports.artifacts.register = input => { const id = register(input); h.fp.value = 'changed-during-artifact-io'; return id; };
        await expect(h.apply()).rejects.toThrow('fingerprint_changed');
        expect(h.snapshot()).toBe(before); expect(h.parent().stageReviewRecoveries).toBeUndefined();
    });
    it('binds artifact hashes and provenance across dry-run/apply even when source fingerprint stays unchanged', async () => {
        const h = setup(); const r = h.request(); const before = h.snapshot();
        const preview = await recoverPendingStageReview(r, h.host, h.ports);
        fs.writeFileSync(path.join(h.ws, 'art_report.md'), 'changed evidence');
        h.store.db.prepare('UPDATE session_artifacts SET sha256 = ?, size_bytes = ? WHERE artifact_id = ?')
            .run(createHash('sha256').update('changed evidence').digest('hex'), Buffer.byteLength('changed evidence'), 'art_report');
        await expect(recoverPendingStageReview({ ...r, dryRun: false, expectedFingerprint: preview.fingerprint, expectedArtifactDigest: preview.artifactDigest }, h.host, h.ports)).rejects.toThrow('artifact_digest_changed');
        expect(h.snapshot()).toBe(before);
    });
    it('verifies generated diff hash rather than trusting a registrar receipt', async () => {
        const h = setup(); const before = h.snapshot(); const register = h.ports.artifacts.register;
        h.ports.artifacts.register = input => register({ ...input, content: 'wrong diff bytes' });
        await expect(h.apply()).rejects.toThrow('diff_hash_mismatch'); expect(h.snapshot()).toBe(before);
    });
    it('rebinds only a completed same-session continuation, preserving old head and self-check history', async () => {
        const h = setup(); const continuation = enqueueTask(h.request().meshId, 'continuation', { taskMode: 'code_change', difficulty: 'difficult', missionId: 'mission' });
        h.store.updateQueueEntry({ ...continuation, status: 'completed', assignedSessionId: 'implementer', assignedNodeId: 'node_a' }); h.register('art_continuation', continuation.id, 'new tests');
        h.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'continuation');
        const next = h.git('rev-parse', 'HEAD');
        await h.apply({ ...h.request(), expectedHeadSha: next, continuationTaskId: continuation.id, inputArtifactIds: ['art_continuation'] });
        expect(h.parent().stageState!.stageHeads.map(x => x.rootSha)).toEqual([h.head, next]);
        expect(h.parent().stageState!.round).toBe(1); expect(h.parent().stageState!.selfCheck).toBe('unavailable'); expect(h.child().inputArtifactIds).toContain('art_continuation');
    });
    it('registered owner command refuses unauthorized ingress and runs isolated dry-run/apply through the runtime', async () => {
        const h = setup();
        expect(await meshQueueHandlers.stage_recover_mesh_review({ requireMeshHostMutationOwner: async () => ({ success: false, error: 'not_owner' }) } as any, h.request())).toMatchObject({ error: 'not_owner' });
        const handle = installStagePipeline({ statusInstanceId: 'test-machine' } as any, h.ports as StageRuntimePorts);
        const ctx = { deps: { statusInstanceId: 'test-machine' }, requireMeshHostMutationOwner: async () => null } as any;
        try {
            const preview = await meshQueueHandlers.stage_recover_mesh_review(ctx, h.request());
            expect(preview).toMatchObject({ success: true, dryRun: true });
            expect(await meshQueueHandlers.stage_recover_mesh_review(ctx, { ...h.request(), dryRun: false, expectedFingerprint: 'fresh-fingerprint', expectedArtifactDigest: (preview as any).artifactDigest })).toMatchObject({ success: true, dryRun: false });
            expect(h.child().difficulty).toBe('medium');
        } finally { handle.dispose(); }
    });
    it('rejects context spoofing, unknown versions, force and arbitrary difficulty', () => {
        const h = setup();
        for (const patch of [{ v: 2 }, { v: 3 }, { difficulty: 'easy' }, { force: true }, { machineId: 'spoof' }, { ownershipScope: {} }, { expectedParentRevision: -1 }]) expect(() => decodeStageReviewRecovery({ ...h.request(), ...patch })).toThrow('invalid_stage_review_recovery');
    });
});

function setupTerminalBlocked() {
    const ws = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'review-terminal-resume-')); dirs.push(ws);
    const subOrigin = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'review-terminal-sub-')); dirs.push(subOrigin);
    const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
    gitAt(subOrigin, 'init', '-q');
    fs.writeFileSync(path.join(subOrigin, 'runtime.ts'), 'export const r5 = true;\n');
    gitAt(subOrigin, 'add', '.');
    gitAt(subOrigin, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'oss r5');
    const ossSha = gitAt(subOrigin, 'rev-parse', 'HEAD');
    const git = (...args: string[]) => gitAt(ws, ...args);
    git('init', '-q');
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'oss');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'old stage head');
    const oldHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(ws, 'vendor.js'), '// vendor r5\n');
    git('add', 'vendor.js');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'integrate R5 history recovery and vendor bundle');
    const currentHead = git('rev-parse', 'HEAD');
    expect(gitAt(path.join(ws, 'oss'), 'rev-parse', 'HEAD')).toBe(ossSha);

    currentMesh = `mesh_terminal_recover_${randomUUID()}`;
    bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
    meshConfigMocks.getMesh.mockReturnValue({
        id: currentMesh, repoIdentity: 'fixture/repo',
        meshHost: { role: 'host', hostDaemonId: 'test-machine' },
        nodes: [
            { id: 'node_11111111111111111111111111111111', daemonId: 'test-machine', workspace: ws },
            { id: 'node_22222222222222222222222222222222', daemonId: 'test-machine', workspace: path.join(ws, 'other') },
        ],
    });
    const store = MeshRuntimeStore.getInstance();
    const p0 = enqueueTask(currentMesh, 'implement #13', {
        id: '00000000-0000-4000-8000-000000000001',
        taskMode: 'code_change', difficulty: 'difficult', review: true, missionId: 'mission_13', ownedPaths: ['oss'],
    });
    const completedChildIds = [
        '00000000-0000-4000-8000-000000000011',
        '00000000-0000-4000-8000-000000000012',
        '00000000-0000-4000-8000-000000000013',
        '00000000-0000-4000-8000-000000000014',
        '00000000-0000-4000-8000-000000000015',
    ];
    for (let i = 0; i < completedChildIds.length; i++) {
        const c = enqueueTask(currentMesh, `review round ${i + 1}`, {
            id: completedChildIds[i], difficulty: 'difficult', missionId: 'mission_13',
            inputArtifactIds: ['art_verdict_' + (i + 1)], inheritArtifacts: false,
            stageChild: { parentTaskId: p0.id, round: i + 1, review: { sourceTaskId: p0.id, independence: 'different_provider' } },
        });
        store.updateQueueEntry({
            ...c, status: 'completed',
            assignedNodeId: 'node_11111111111111111111111111111111',
            targetNodeId: 'node_11111111111111111111111111111111',
            assignedProviderType: 'codex-cli',
            assignedSessionId: `reviewer-session-${i + 1}`,
        });
    }
    let n = 0;
    const register = (id: string, taskId: string, content: string, role = 'worker', sessionId = 'fixture-implementer') => {
        fs.writeFileSync(path.join(ws, `${id}.md`), content);
        store.db.prepare(`INSERT INTO session_artifacts (artifact_id,session_id,task_id,mesh_id,producer_role,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, role === 'pipeline' ? `stage:${taskId}` : sessionId, taskId, currentMesh, role, ws, `${id}.md`, 'markdown', 'text/markdown', 'Evidence', Buffer.byteLength(content), createHash('sha256').update(content).digest('hex'), 1, 1);
        return id;
    };
    for (let i = 1; i <= 5; i++) register(`art_verdict_${i}`, p0.id, `verdict r${i}`, 'pipeline');
    register('art_old_diff', p0.id, 'old diff', 'pipeline');
    register('art_old_self_check', p0.id, 'old failed self-check', 'pipeline');
    register('art_175_pass', p0.id, '175 scoped PASS evidence', 'worker', 'fixture-implementer');

    // Continuation task fbb189f7 ran in its own same-mission session and produced art_cont_fixture
    const continuation = enqueueTask(currentMesh, 'finish root integration', {
        id: '00000000-0000-4000-8000-000000000002',
        taskMode: 'code_change', difficulty: 'medium', missionId: 'mission_13',
    });
    store.updateQueueEntry({
        ...continuation, status: 'completed',
        assignedNodeId: 'node_11111111111111111111111111111111',
        assignedSessionId: 'fixture-continuation',
        assignedProviderType: 'claude-cli',
    });
    register('art_cont_fixture', continuation.id, 'fixture integration receipt', 'worker', 'fixture-continuation');

    // Audit evidence of the parent's implementer attempt in turn_attempts (even after requeueForRevision cleared parent.assigned*)
    seedMeshAttempt({
        meshId: currentMesh, taskId: p0.id, sessionId: 'fixture-implementer',
        nodeId: 'node_11111111111111111111111111111111', providerType: 'claude-cli',
        attemptId: `mesh_queue:${currentMesh}:${p0.id}:0`, attemptNo: 0, stage: 'completed',
    });

    const state = initialStageState(new Date(Date.now() - 5 * 3600_000).toISOString());
    Object.assign(state, {
        phase: 'done', round: 5, released: true, blockedReason: 'stage_pipeline_ceiling',
        baseSha: oldHead,
        stageHeads: [1, 2, 3, 4, 5].map(r => ({ round: r, rootSha: oldHead })),
        reviewTaskIds: [...completedChildIds],
        workerArtifactIds: ['art_175_pass'],
        artifacts: {
            diff: ['art_old_diff'],
            selfCheck: ['art_old_self_check'],
            verdict: ['art_verdict_1', 'art_verdict_2', 'art_verdict_3', 'art_verdict_4', 'art_verdict_5'],
        },
        lastVerdict: 'changes_requested',
        openFindingIds: ['R5-01', 'R5-02'],
        openFindings: [{ id: 'R5-01', severity: 'major', claim: 'c1' }, { id: 'R5-02', severity: 'major', claim: 'c2' }],
        selfCheck: 'failed',
        reviewFingerprint: 'old-r5-fingerprint',
    });
    // Terminal parent, retargeted for recovery with its assignment cleared.
    store.updateQueueEntry({
        ...p0, status: 'blocked',
        targetNodeId: 'node_22222222222222222222222222222222',
        assignedNodeId: undefined, assignedSessionId: undefined, assignedProviderType: undefined,
        hold: { reason: 'node_health_not_launchable', since: '2026-11-21T09:48:26.321Z', blockingTaskIds: [], detail: {} } as any,
        autoLaunch: { status: 'skipped', reason: 'node_health_not_launchable', nodeId: 'node_22222222222222222222222222222222', updatedAt: '2026-11-21T09:48:26.322Z' },
        stageState: state,
    });
    const decision = {
        question: 'Approve terminal-blocked review resume for parent 3e2 at d919/a08d?',
        options: [{ id: 'a', label: 'Approve minimal terminal-blocked review resume' }],
        answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date().toISOString() },
        answerRevision: 1,
    } as any;
    store.missionItems().insertItem({
        id: 'mi_owner_fixture', meshId: currentMesh, missionId: 'mission_13',
        kind: 'decision', state: 'answered', text: 'Owner approval for terminal-blocked review resume',
        refs: [{ kind: 'task', value: p0.id }], decision,
    });
    const fp = { value: 'fp2\nfresh-d919-fingerprint' as string | null };
    const ports = {
        git: { diff: async () => 'r5 continuation diff', fingerprint: async () => fp.value },
        artifacts: { register: (i: any) => ({ ok: true as const, artifactId: register(`art_diff_r6_${++n}`, i.taskId, i.content, 'pipeline') }) },
    } as Pick<StageRuntimePorts, 'git' | 'artifacts'>;
    const host = {
        actor: 'test-machine', repoIdentity: 'fixture/repo', machineId: 'test-machine',
        nodeId: 'node_11111111111111111111111111111111', workspace: ws,
    };
    const parent = () => store.findQueueEntryById(currentMesh!, p0.id)!;
    const children = () => parent().stageState!.reviewTaskIds.map(id => store.findQueueEntryById(currentMesh!, id)!);
    const request = (): StageReviewRecoveryRequest => ({
        v: 2, meshId: currentMesh!, parentTaskId: p0.id,
        expectedParentRevision: parent().revision ?? 0,
        expectedStageHeadSha: oldHead, expectedHeadSha: currentHead,
        expectedWorkspace: fs.realpathSync.native(ws),
        ownerDecisionId: 'mi_owner_fixture', ownerAnswerRevision: 1, ownerOptionId: 'a',
        difficulty: 'medium', reviewerProvider: 'antigravity-cli',
        continuationTaskId: continuation.id,
        inputArtifactIds: ['art_cont_fixture', 'art_175_pass'],
        dryRun: true,
    });
    const apply = async (r = request()) => {
        const preview = await recoverPendingStageReview(r, host, ports);
        return recoverPendingStageReview({
            ...r, dryRun: false,
            expectedFingerprint: preview.fingerprint,
            expectedArtifactDigest: preview.artifactDigest,
        }, host, ports);
    };
    const snapshot = () => JSON.stringify(store.getQueueEntries(currentMesh!));
    return { ws, git, gitAt, oldHead, currentHead, ossSha, store, parent, children, completedChildIds, continuation, decision, register, fp, ports, host, request, apply, snapshot };
}

describe('owner/CAS terminal-blocked review resume (v2)', () => {
    it('resumes terminal blocked review at attested head: dry-run mutates 0, apply preserves 5 completed children/verdicts/heads/self-check, creates 1 round-6 child, and re-apply returns the same child', async () => {
        const h = setupTerminalBlocked();
        const before = h.snapshot();
        const priorChildrenBefore = JSON.stringify(h.completedChildIds.map(id => h.store.findQueueEntryById(h.request().meshId, id)));
        const preview = await recoverPendingStageReview(h.request(), h.host, h.ports);
        expect(preview).toMatchObject({
            success: true, v: 2, dryRun: true, round: 6,
            previousHeadSha: h.oldHead, headSha: h.currentHead,
            fingerprint: 'fp2\nfresh-d919-fingerprint',
            sourceProvenance: {
                nodeId: 'node_11111111111111111111111111111111',
                sessionId: 'fixture-implementer',
                providerType: 'claude-cli',
                via: 'turn_attempt',
            },
            preservedCompletedChildIds: h.completedChildIds,
        });
        expect(h.snapshot()).toBe(before);

        const preRev = h.parent().revision!;
        const applied = await recoverPendingStageReview({
            ...h.request(), dryRun: false,
            expectedFingerprint: preview.fingerprint,
            expectedArtifactDigest: preview.artifactDigest,
        }, h.host, h.ports) as any;
        expect(applied).toMatchObject({
            success: true, v: 2, dryRun: false, round: 6, idempotentReplay: false,
            parentRevision: preRev + 1,
        });
        expect(typeof applied.reviewTaskId).toBe('string');

        // All 5 prior completed children, their verdicts, old stageHeads, and old selfCheck artifacts are preserved unchanged
        expect(JSON.stringify(h.completedChildIds.map(id => h.store.findQueueEntryById(h.request().meshId, id)))).toBe(priorChildrenBefore);
        const p = h.parent();
        expect(p).toMatchObject({
            status: 'assigned',
            assignedNodeId: 'node_11111111111111111111111111111111',
            assignedSessionId: 'fixture-implementer',
            assignedProviderType: 'claude-cli',
            targetNodeId: 'node_11111111111111111111111111111111',
        });
        expect(p.hold).toBeUndefined();
        expect(p.autoLaunch).toBeUndefined();
        expect(p.stageState!.phase).toBe('awaiting_review');
        expect(p.stageState!.released).toBe(false);
        expect(p.stageState!.blockedReason).toBeUndefined();
        expect(p.stageState!.round).toBe(6);
        expect(p.stageState!.selfCheck).toBe('unavailable');
        expect(p.stageState!.artifacts.selfCheck).toEqual(['art_old_self_check']);
        expect(p.stageState!.artifacts.verdict).toEqual(['art_verdict_1', 'art_verdict_2', 'art_verdict_3', 'art_verdict_4', 'art_verdict_5']);
        expect(p.stageState!.stageHeads).toHaveLength(6);
        expect(p.stageState!.stageHeads.slice(0, 5).every(x => x.rootSha === h.oldHead)).toBe(true);
        expect(p.stageState!.stageHeads[5]).toEqual({ round: 6, rootSha: h.currentHead });
        expect(p.stageState!.reviewTaskIds).toEqual([...h.completedChildIds, applied.reviewTaskId]);

        const newChild = h.store.findQueueEntryById(h.request().meshId, applied.reviewTaskId)!;
        expect(newChild).toMatchObject({
            status: 'pending', readonly: true, taskMode: 'validation',
            origin: 'stage', parentTaskId: p.id, stageRole: 'review', stageRound: 6,
            difficulty: 'medium', targetNodeId: 'node_11111111111111111111111111111111',
            review: { sourceTaskId: p.id, independence: 'different_provider' },
            routingPreferences: { nodeIds: ['node_11111111111111111111111111111111'], providers: ['antigravity-cli'] },
        });
        expect(newChild.inputArtifactIds).toContain('art_cont_fixture');
        expect(newChild.inputArtifactIds).toContain('art_175_pass');
        expect(reviewRoutingRefusal(newChild, p, 'antigravity-cli', { workspace: h.ws, machineId: 'test-machine', repoIdentity: 'fixture/repo' }, [p])).toBeUndefined();
        expect(reviewRoutingRefusal(newChild, p, 'claude-cli', { workspace: h.ws, machineId: 'test-machine', repoIdentity: 'fixture/repo' }, [p])).toBe('review_independence_required');

        // Idempotent re-apply (with original expectedParentRevision OR post-apply revision) returns the exact same child without creating another
        const afterFirstApplySnapshot = h.snapshot();
        const replay1 = await recoverPendingStageReview({
            ...h.request(), expectedParentRevision: preRev, dryRun: false,
            expectedFingerprint: preview.fingerprint,
            expectedArtifactDigest: preview.artifactDigest,
        }, h.host, h.ports) as any;
        expect(replay1).toMatchObject({
            success: true, v: 2, dryRun: false, idempotentReplay: true,
            reviewTaskId: applied.reviewTaskId, round: 6,
        });
        expect(h.snapshot()).toBe(afterFirstApplySnapshot);

        const replay2 = await recoverPendingStageReview({
            ...h.request(), expectedParentRevision: p.revision!, dryRun: false,
            expectedFingerprint: preview.fingerprint,
            expectedArtifactDigest: preview.artifactDigest,
        }, h.host, h.ports) as any;
        expect(replay2).toMatchObject({
            success: true, v: 2, dryRun: false, idempotentReplay: true,
            reviewTaskId: applied.reviewTaskId, round: 6,
        });
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(6);
    });

    it('refuses unknown source provenance without borrowing reviewer child provider or accepting caller anchor strings', async () => {
        const h = setupTerminalBlocked();
        // Reject caller-supplied source anchor strings at decode boundary
        for (const extra of [{ sourceProvider: 'claude-cli' }, { assignedProviderType: 'claude-cli' }, { sourceSessionId: 'fixture-implementer' }, { sourceNodeId: h.host.nodeId }]) {
            expect(() => decodeStageReviewRecovery({ ...h.request(), ...extra } as any)).toThrow('invalid_stage_review_recovery');
        }
        // Remove parent turn_attempts and verify that completed review children (codex-cli) are never used as implementer provenance
        h.store.db.prepare('DELETE FROM turn_attempts WHERE mesh_id = ? AND task_id = ?').run(h.request().meshId, h.parent().id);
        const before = h.snapshot();
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_unknown_source_provenance');
        expect(h.snapshot()).toBe(before);

        // Provenance from mesh_local_records (task_dispatched) is accepted when consistent
        h.store.db.prepare(
            'INSERT INTO mesh_local_records (event_id, mesh_id, kind, node_id, session_id, provider_type, task_id, at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
            'evt_dispatch_3e2', h.request().meshId, 'task_dispatched',
            'node_11111111111111111111111111111111', 'fixture-implementer', 'claude-cli',
            h.parent().id, Date.now(), JSON.stringify({ taskId: h.parent().id }),
        );
        await expect(recoverPendingStageReview({ ...h.request(), reviewerProvider: 'claude-cli' }, h.host, h.ports)).rejects.toThrow('review_independence_required');
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).resolves.toMatchObject({
            dryRun: true,
            sourceProvenance: { providerType: 'claude-cli', sessionId: 'fixture-implementer', via: 'local_record' },
        });
    });

    it('refuses stale CAS, non-owner decision, non-completed children, wrong head/submodule/artifact, and open writer', async () => {
        const h = setupTerminalBlocked();
        const before = h.snapshot();

        // Stale parent CAS
        await expect(recoverPendingStageReview({ ...h.request(), expectedParentRevision: (h.parent().revision ?? 0) + 1 }, h.host, h.ports)).rejects.toThrow('stale_review_recovery_cas');
        // Stage head mismatch
        await expect(recoverPendingStageReview({ ...h.request(), expectedStageHeadSha: 'a'.repeat(40) }, h.host, h.ports)).rejects.toThrow('review_stage_head_mismatch');
        // Actual checkout head mismatch
        await expect(recoverPendingStageReview({ ...h.request(), expectedHeadSha: h.oldHead }, h.host, h.ports)).rejects.toThrow('review_input_head_changed');
        // Owner decision scoped to wrong task or non-owner answer
        h.store.missionItems().updateItem(h.request().meshId, 'mi_owner_fixture', { refs: [{ kind: 'task', value: h.completedChildIds[4] }] } as any);
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_owner_authorization_required');
        h.store.missionItems().updateItem(h.request().meshId, 'mi_owner_fixture', { refs: [{ kind: 'task', value: h.parent().id }], decision: { ...h.decision, answerRevision: 9 } } as any);
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_owner_authorization_required');
        h.store.missionItems().updateItem(h.request().meshId, 'mi_owner_fixture', { refs: [{ kind: 'task', value: h.parent().id }], decision: h.decision } as any);

        // Non-completed child in history is refused by v2 (must use v1 if pending)
        const c5 = h.store.findQueueEntryById(h.request().meshId, h.completedChildIds[4])!;
        h.store.updateQueueEntry({ ...c5, status: 'pending' });
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('terminal_blocked_stage_review_required');
        h.store.updateQueueEntry(c5);

        // Missing or mismatched continuation task / artifact
        await expect(recoverPendingStageReview({ ...h.request(), continuationTaskId: undefined }, h.host, h.ports)).rejects.toThrow('review_continuation_required');
        await expect(recoverPendingStageReview({ ...h.request(), inputArtifactIds: ['art_175_pass'] }, h.host, h.ports)).rejects.toThrow('review_continuation_evidence_mismatch');

        // Submodule dirty / SHA mismatch is refused fail-closed
        fs.writeFileSync(path.join(h.ws, 'oss', 'runtime.ts'), 'dirty\n');
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_input_dirty');
        h.gitAt(path.join(h.ws, 'oss'), 'checkout', '--', 'runtime.ts');

        // Open writer on the same node is refused
        const writer = enqueueTask(h.request().meshId, 'competing writer', { taskMode: 'code_change', difficulty: 'medium' });
        h.store.updateQueueEntry({ ...writer, status: 'assigned', assignedNodeId: h.host.nodeId });
        await expect(recoverPendingStageReview({ ...h.request(), expectedParentRevision: h.parent().revision ?? 0 }, h.host, h.ports)).rejects.toThrow('review_input_busy');
        h.store.updateQueueEntry({ ...writer, status: 'completed' });

        // Verify original parent + 5 completed children were not mutated by any failed check
        expect(h.parent().status).toBe('blocked');
        expect(h.parent().stageState!.reviewTaskIds).toEqual(h.completedChildIds);
        void before;
    });

    it('registered stage_recover_mesh_review command resolves source node from audit provenance when parent.assignedNodeId was cleared', async () => {
        const h = setupTerminalBlocked();
        const handle = installStagePipeline({ statusInstanceId: 'test-machine' } as any, h.ports as StageRuntimePorts);
        const ctx = { deps: { statusInstanceId: 'test-machine' }, requireMeshHostMutationOwner: async () => null } as any;
        try {
            const preview = await meshQueueHandlers.stage_recover_mesh_review(ctx, h.request()) as any;
            expect(preview).toMatchObject({ success: true, v: 2, dryRun: true, round: 6 });
            const applied = await meshQueueHandlers.stage_recover_mesh_review(ctx, {
                ...h.request(), dryRun: false,
                expectedFingerprint: preview.fingerprint,
                expectedArtifactDigest: preview.artifactDigest,
            }) as any;
            expect(applied).toMatchObject({ success: true, v: 2, dryRun: false, round: 6 });
            expect(h.parent().stageState!.reviewTaskIds).toEqual([...h.completedChildIds, applied.reviewTaskId]);
        } finally { handle.dispose(); }
    });
});

describe('owner recovery of inputs before the first review child', () => {
    function setupBeforeChild(mode: 'root' | 'oss' | 'unsigned' = 'root') {
        const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'review-before-child-')));
        dirs.push(ws);
        const git = (...args: string[]) => execFileSync('git', args, { cwd: ws, encoding: 'utf8', stdio: 'pipe' }).trim();
        git('init', '-q');
        if (mode !== 'root') {
            const upstream = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'review-before-child-oss-')));
            dirs.push(upstream);
            const ossGit = (...args: string[]) => execFileSync('git', args, { cwd: upstream, stdio: 'pipe' });
            ossGit('init', '-q');
            fs.writeFileSync(path.join(upstream, 'source.txt'), 'OSS source\n');
            ossGit('add', 'source.txt');
            ossGit('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'OSS base');
            git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'oss');
        }
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base');
        const base = git('rev-parse', 'HEAD');
        fs.writeFileSync(path.join(ws, 'feature.txt'), 'recoverable change\n');
        if (mode === 'unsigned') {
            const vendorDir = path.join(ws, 'packages', 'daemon-cloud', 'vendor', 'mcp-server');
            fs.mkdirSync(vendorDir, { recursive: true });
            fs.writeFileSync(path.join(vendorDir, 'index.js'), 'generated output\n');
        }
        git('add', '.');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'feature');
        const head = git('rev-parse', 'HEAD');
        const meshId = currentMesh = `mesh_before_child_${randomUUID()}`;
        const nodeId = 'node_11111111111111111111111111111111';
        const mesh = { id: meshId, repoIdentity: 'fixture/repo', meshHost: { role: 'host', hostDaemonId: 'test-machine' },
            nodes: [{ id: nodeId, daemonId: 'test-machine', workspace: ws }] };
        meshConfigMocks.getMesh.mockReturnValue(mesh);
        bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
        const store = MeshRuntimeStore.getInstance();
        const task = enqueueTask(meshId, 'implement', { taskMode: 'code_change', difficulty: 'difficult', review: true, missionId: 'mission' });
        const acceptedAt = Date.now() - 10_000;
        const impl = seedMeshAttempt({ meshId, taskId: task.id, stage: 'completed', nodeId, sessionId: 'impl',
            providerType: 'codex-cli', nowMs: acceptedAt });
        store.turnStore().upsertAttempt({ ...impl, ownerDaemonId: 'test-machine' }, acceptedAt);
        const at = new Date().toISOString();
        const ownershipScope = attestLocalOwnership({ workspace: ws, machineId: 'test-machine', nodeId,
            repoIdentity: mesh.repoIdentity, phase: 'source', paths: { paths: [] } });
        store.updateQueueEntry({ ...task, status: 'blocked', ownershipScope, attemptId: impl.attemptId,
            assignedNodeId: nodeId, assignedSessionId: 'impl', assignedProviderType: 'codex-cli',
            stageState: { ...initialStageState(at), round: 2, phase: 'done', released: true, baseSha: base,
                stageHeads: [{ round: 1, rootSha: head }], handledAttemptIds: [impl.attemptId], selfCheck: 'passed',
                blockedReason: 'review_unavailable', blockedDetail: 'review_input_artifacts_missing' } });
        const dir = path.join(testConfigDir, 'stage-artifacts', task.id);
        fs.mkdirSync(dir, { recursive: true });
        const retainedFile = path.join(dir, `self_check-${(acceptedAt + 100).toString(36)}.md`);
        const body = '# Self-check (passed)\n\nOriginal retained evidence.\n';
        fs.writeFileSync(retainedFile, body);
        store.missionItems().insertItem({ id: 'recover-owner-answer', meshId, missionId: 'mission', kind: 'decision',
            state: 'answered', text: 'Resume review', refs: [{ kind: 'task', value: task.id }],
            decision: { question: 'Resume review?', options: [{ id: 'a', label: 'Resume' }], answerRevision: 1,
                answer: { optionId: 'a', by: 'owner', via: 'dashboard', at } } });
        const components = { statusInstanceId: 'test-machine' } as any;
        const ports = createProductionStagePorts(components);
        setStageArtifactRegistrar(input => new ArtifactStore(MeshRuntimeStore.getInstance().db).register(input).record.artifactId);
        const handle = installStagePipeline(components, ports);
        const ctx = { deps: components, requireMeshHostMutationOwner: async () => null } as any;
        const parent = () => MeshRuntimeStore.getInstance().findQueueEntryById(meshId, task.id)!;
        const request: StageReviewRecoveryRequest = { v: 2, meshId, parentTaskId: task.id, expectedParentRevision: parent().revision!,
            expectedStageHeadSha: head, expectedHeadSha: head, expectedWorkspace: ws, ownerDecisionId: 'recover-owner-answer',
            ownerAnswerRevision: 1, ownerOptionId: 'a', difficulty: 'medium', reviewerProvider: 'claude-cli', inputArtifactIds: [], dryRun: true };
        const call = (patch: Partial<StageReviewRecoveryRequest> = {}) => meshQueueHandlers.stage_recover_mesh_review(ctx, { ...request, ...patch }) as Promise<any>;
        const dispose = () => { handle.dispose(); setStageArtifactRegistrar(null); };
        return { ws, git, mesh, nodeId, store, parent, request, call, retainedFile, body, dispose };
    }

    it.each(['root', 'oss'] as const)('reopens a %s parent with one independent child and readable inputs after SQLite reopen', async mode => {
        const h = setupBeforeChild(mode);
        try {
            const before = h.parent();
            const preview = await h.call();
            expect(preview, JSON.stringify(preview)).toMatchObject({ success: true, dryRun: true, round: 2, inputArtifactIds: [] });
            expect(h.parent()).toEqual(before);
            const payload = { dryRun: false, expectedFingerprint: preview.fingerprint, expectedArtifactDigest: preview.artifactDigest };
            const applied = await h.call(payload);
            expect(applied, JSON.stringify(applied)).toMatchObject({ success: true, dryRun: false, round: 2 });
            expect(await h.call(payload)).toMatchObject({ success: false });
            expect(fs.readFileSync(h.retainedFile, 'utf8')).toBe(h.body);
            __resetMeshRuntimeStoreForTests();
            const parent = h.parent();
            const store = MeshRuntimeStore.getInstance();
            expect(parent).toMatchObject({ status: 'assigned', stageState: { phase: 'awaiting_review', selfCheck: 'passed',
                released: false, reviewTaskIds: [applied.reviewTaskId] } });
            const child = store.findQueueEntryById(parent.meshId, applied.reviewTaskId)!;
            expect(child).toMatchObject({ readonly: true, status: 'pending', origin: 'stage', stageRole: 'review', stageRound: 2,
                review: { independence: 'different_provider', sourceTaskId: parent.id } });
            const reviewerWorkspace = child.reviewerWorkspace?.path ?? h.ws;
            if (mode === 'oss') expect(reviewerWorkspace).not.toBe(h.ws);
            expect(currentStageReviewScope(parent, child)?.worktree).toBe(reviewerWorkspace);
            expect(reviewRoutingRefusal(child, parent, 'codex-cli', undefined)).toBe('review_independence_required');
            const attempt = seedMeshAttempt({ meshId: parent.meshId, taskId: child.id, stage: 'consumed', nodeId: h.nodeId,
                sessionId: 'reviewer', providerType: 'claude-cli' });
            store.updateQueueEntry({ ...child, status: 'assigned', assignedSessionId: 'reviewer',
                assignedNodeId: h.nodeId, assignedProviderType: 'claude-cli', attemptId: attempt.attemptId });
            const { token } = mintWorkerTaskToken({ ...attempt, meshId: parent.meshId, taskId: child.id, nodeId: h.nodeId });
            const ctx = { deps: { statusInstanceId: 'test-machine', sessionRegistry: { get: () => ({ workspace: reviewerWorkspace }) } },
                getMeshForCommand: async () => h.mesh } as any;
            const read = (artifactId: string) => artifactHandlers.artifact_read(ctx, { token, artifactId });
            expect(await read(parent.stageState!.artifacts.selfCheck[0])).toMatchObject({ success: true, content: expect.stringContaining('Original retained evidence') });
            const diffId = parent.stageState!.artifacts.diff[0];
            if (mode === 'oss') {
                expect(await read(diffId)).toMatchObject({ success: true, content: expect.stringContaining('adhdev-stage-source-generated') });
                const chunkId = child.inputArtifactIds!.find(id => id !== diffId && id !== parent.stageState!.artifacts.selfCheck[0])!;
                expect(await read(chunkId)).toMatchObject({ success: true, content: expect.stringContaining('+recoverable change') });
            } else {
                expect(await read(diffId)).toMatchObject({ success: true, content: expect.stringContaining('+recoverable change') });
            }
            expect(await read('ungranted')).toMatchObject({ success: false });
            const foreign = mintWorkerTaskToken({ ...attempt, meshId: parent.meshId, taskId: child.id,
                nodeId: h.nodeId, sessionId: 'other-worker' });
            expect(await artifactHandlers.artifact_read(ctx, { token: foreign.token, artifactId: diffId })).toMatchObject({ success: false });
        } finally { h.dispose(); }
    });

    it('refuses generated output without the installed host attestation and leaves formal inputs absent', async () => {
        const h = setupBeforeChild('unsigned');
        try {
            const before = h.parent();
            expect(await h.call()).toMatchObject({ error: 'review_source_generated_producer_authority' });
            expect(h.parent()).toEqual(before);
            expect(new ArtifactStore(h.store.db).listBySession(`stage:${before.id}`)).toEqual([]);
        } finally { h.dispose(); }
    });

    it('fails closed for missing or changed evidence, stale attempts, dirty checkout, foreign scope, wrong round, and duplicate children', async () => {
        const h = setupBeforeChild();
        try {
            const original = h.parent();
            const preview = await h.call();
            expect(preview.success, JSON.stringify(preview)).toBe(true);
            expect(await h.call({ expectedWorkspace: path.dirname(h.ws) })).toMatchObject({ error: 'review_workspace_mismatch' });
            expect(await h.call({ expectedHeadSha: 'a'.repeat(40) })).toMatchObject({ success: false });
            h.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'head drift');
            expect(await h.call()).toMatchObject({ error: 'review_input_head_changed' });
            h.git('checkout', '--detach', h.request.expectedHeadSha);
            expect(await h.call({ inputArtifactIds: ['art_worker_markdown'] })).toMatchObject({ success: false });
            expect(await h.call({ expectedParentRevision: h.request.expectedParentRevision + 1 })).toMatchObject({ error: 'stale_review_recovery_cas' });
            fs.writeFileSync(path.join(h.ws, 'feature.txt'), 'dirty');
            expect(await h.call()).toMatchObject({ error: 'review_input_dirty' });
            fs.writeFileSync(path.join(h.ws, 'feature.txt'), 'recoverable change\n');
            fs.writeFileSync(h.retainedFile, h.body + 'changed');
            expect(await h.call({ dryRun: false, expectedFingerprint: preview.fingerprint, expectedArtifactDigest: preview.artifactDigest }))
                .toMatchObject({ error: 'review_artifact_digest_changed' });
            fs.renameSync(h.retainedFile, h.retainedFile + '.missing');
            expect(await h.call()).toMatchObject({ error: 'review_self_check_evidence_missing' });
            fs.renameSync(h.retainedFile + '.missing', h.retainedFile);
            const update = async (patch: Partial<typeof original>, error: string) => {
                h.store.updateQueueEntry({ ...original, ...patch });
                expect(await h.call({ expectedParentRevision: h.parent().revision })).toMatchObject({ error });
                h.store.updateQueueEntry(original);
            };
            await update({ stageState: { ...original.stageState!, round: 3 } }, 'terminal_blocked_stage_review_required');
            await update({ status: 'assigned' }, 'terminal_blocked_stage_review_required');
            await update({ attemptId: 'older-attempt' }, 'review_source_attempt_mismatch');
            await update({ assignedSessionId: 'other-worker' }, 'review_source_attempt_mismatch');
            await update({ ownershipScope: { ...original.ownershipScope!, repoIdentity: 'foreign/repo' } }, 'review_workspace_mismatch');
            enqueueTask(original.meshId, 'unexpected child', { difficulty: 'medium', stageChild: { parentTaskId: original.id, round: 2,
                review: { sourceTaskId: original.id, independence: 'different_provider' } } });
            expect(await h.call({ expectedParentRevision: h.parent().revision })).toMatchObject({ error: 'terminal_blocked_stage_review_required' });
            expect(h.parent().stageState!.reviewTaskIds).toEqual([]);
        } finally { h.dispose(); }
    });
});
