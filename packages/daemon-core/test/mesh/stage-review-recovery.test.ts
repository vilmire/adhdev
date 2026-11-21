// Read-only stage evidence is separate from source write ownership, including exact gitlinks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const testTmpDir = path.join(tmpdir(), `adhdev-review-recovery-${randomUUID().slice(0, 8)}`);
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
import { installStagePipeline } from '../../src/mesh/stage-ports-default.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { beginTaskDispatchInFlight, __resetTaskDispatchInFlightForTests } from '../../src/mesh/mesh-task-inflight.js';
import type { StageRuntimePorts } from '../../src/mesh/stage-ports.js';
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
    const ws = fs.mkdtempSync(path.join(tmpdir(), 'review-recovery-')); dirs.push(ws);
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
    const ports = { git: { diff: async () => 'continuation diff', fingerprint: async () => fp.value }, artifacts: { register: (i: any) => register(`art_diff_${++n}`, i.taskId, i.content, 'pipeline') } } as Pick<StageRuntimePorts, 'git' | 'artifacts'>;
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
    const ws = fs.mkdtempSync(path.join(tmpdir(), 'review-terminal-resume-')); dirs.push(ws);
    const subOrigin = fs.mkdtempSync(path.join(tmpdir(), 'review-terminal-sub-')); dirs.push(subOrigin);
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
            { id: 'node_a9928da204ce4db1a41723f8a067414f', daemonId: 'test-machine', workspace: ws },
            { id: 'node_22cc62baf3754b35b5177910e415abf1', daemonId: 'test-machine', workspace: path.join(ws, 'other') },
        ],
    });
    const store = MeshRuntimeStore.getInstance();
    const p0 = enqueueTask(currentMesh, 'implement #13', {
        id: '3e2b83f3-b933-4c73-bd27-186c2720fb16',
        taskMode: 'code_change', difficulty: 'difficult', review: true, missionId: 'mission_13', ownedPaths: ['oss'],
    });
    const completedChildIds = [
        'ffce685b-da14-408b-9ef8-10995546a2b3',
        'e163a6c8-971b-40ca-8c59-ccc3e875e0f2',
        'df9fbe0b-102c-4a3d-a2e4-12283bd6af56',
        'b45503a5-d34a-4dca-bc2a-1a23bfa5c2cd',
        '139a82b8-29c9-4ea3-b873-3b6609ecaad5',
    ];
    for (let i = 0; i < completedChildIds.length; i++) {
        const c = enqueueTask(currentMesh, `review round ${i + 1}`, {
            id: completedChildIds[i], difficulty: 'difficult', missionId: 'mission_13',
            inputArtifactIds: ['art_verdict_' + (i + 1)], inheritArtifacts: false,
            stageChild: { parentTaskId: p0.id, round: i + 1, review: { sourceTaskId: p0.id, independence: 'different_provider' } },
        });
        store.updateQueueEntry({
            ...c, status: 'completed',
            assignedNodeId: 'node_a9928da204ce4db1a41723f8a067414f',
            targetNodeId: 'node_a9928da204ce4db1a41723f8a067414f',
            assignedProviderType: 'codex-cli',
            assignedSessionId: `reviewer-session-${i + 1}`,
        });
    }
    let n = 0;
    const register = (id: string, taskId: string, content: string, role = 'worker', sessionId = 'impl-session-3e2') => {
        fs.writeFileSync(path.join(ws, `${id}.md`), content);
        store.db.prepare(`INSERT INTO session_artifacts (artifact_id,session_id,task_id,mesh_id,producer_role,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, role === 'pipeline' ? `stage:${taskId}` : sessionId, taskId, currentMesh, role, ws, `${id}.md`, 'markdown', 'text/markdown', 'Evidence', Buffer.byteLength(content), createHash('sha256').update(content).digest('hex'), 1, 1);
        return id;
    };
    for (let i = 1; i <= 5; i++) register(`art_verdict_${i}`, p0.id, `verdict r${i}`, 'pipeline');
    register('art_old_diff', p0.id, 'old diff', 'pipeline');
    register('art_old_self_check', p0.id, 'old failed self-check', 'pipeline');
    register('art_175_pass', p0.id, '175 scoped PASS evidence', 'worker', 'impl-session-3e2');

    // Continuation task fbb189f7 ran in its own same-mission session and produced art_e4ec721b0297e1aa
    const continuation = enqueueTask(currentMesh, 'finish root integration', {
        id: 'fbb189f7-d149-4964-bbab-7e0dc812ac20',
        taskMode: 'code_change', difficulty: 'medium', missionId: 'mission_13',
    });
    store.updateQueueEntry({
        ...continuation, status: 'completed',
        assignedNodeId: 'node_a9928da204ce4db1a41723f8a067414f',
        assignedSessionId: 'continuation-session-fbb',
        assignedProviderType: 'claude-cli',
    });
    register('art_e4ec721b0297e1aa', continuation.id, 'root d919 / oss a08d integration receipt', 'worker', 'continuation-session-fbb');

    // Audit evidence of the parent's implementer attempt in turn_attempts (even after requeueForRevision cleared parent.assigned*)
    seedMeshAttempt({
        meshId: currentMesh, taskId: p0.id, sessionId: 'impl-session-3e2',
        nodeId: 'node_a9928da204ce4db1a41723f8a067414f', providerType: 'claude-cli',
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
    // Parent row mirrors live parent3e2: status blocked, target retargeted to recovery 22cc, assigned* cleared
    store.updateQueueEntry({
        ...p0, status: 'blocked',
        targetNodeId: 'node_22cc62baf3754b35b5177910e415abf1',
        assignedNodeId: undefined, assignedSessionId: undefined, assignedProviderType: undefined,
        hold: { reason: 'node_health_not_launchable', since: '2026-11-21T09:48:26.321Z', blockingTaskIds: [], detail: {} } as any,
        autoLaunch: { status: 'skipped', reason: 'node_health_not_launchable', nodeId: 'node_22cc62baf3754b35b5177910e415abf1', updatedAt: '2026-11-21T09:48:26.322Z' },
        stageState: state,
    });
    const decision = {
        question: 'Approve terminal-blocked review resume for parent 3e2 at d919/a08d?',
        options: [{ id: 'a', label: 'Approve minimal terminal-blocked review resume' }],
        answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date().toISOString() },
        answerRevision: 1,
    } as any;
    store.missionItems().insertItem({
        id: 'mi_cf4d2178ff17', meshId: currentMesh, missionId: 'mission_13',
        kind: 'decision', state: 'answered', text: 'Owner approval for terminal-blocked review resume',
        refs: [{ kind: 'task', value: p0.id }], decision,
    });
    const fp = { value: 'fp2\nfresh-d919-fingerprint' as string | null };
    const ports = {
        git: { diff: async () => 'r5 continuation diff', fingerprint: async () => fp.value },
        artifacts: { register: (i: any) => register(`art_diff_r6_${++n}`, i.taskId, i.content, 'pipeline') },
    } as Pick<StageRuntimePorts, 'git' | 'artifacts'>;
    const host = {
        actor: 'test-machine', repoIdentity: 'fixture/repo', machineId: 'test-machine',
        nodeId: 'node_a9928da204ce4db1a41723f8a067414f', workspace: ws,
    };
    const parent = () => store.findQueueEntryById(currentMesh!, p0.id)!;
    const children = () => parent().stageState!.reviewTaskIds.map(id => store.findQueueEntryById(currentMesh!, id)!);
    const request = (): StageReviewRecoveryRequest => ({
        v: 2, meshId: currentMesh!, parentTaskId: p0.id,
        expectedParentRevision: parent().revision ?? 0,
        expectedStageHeadSha: oldHead, expectedHeadSha: currentHead,
        expectedWorkspace: fs.realpathSync.native(ws),
        ownerDecisionId: 'mi_cf4d2178ff17', ownerAnswerRevision: 1, ownerOptionId: 'a',
        difficulty: 'medium', reviewerProvider: 'antigravity-cli',
        continuationTaskId: continuation.id,
        inputArtifactIds: ['art_e4ec721b0297e1aa', 'art_175_pass'],
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
                nodeId: 'node_a9928da204ce4db1a41723f8a067414f',
                sessionId: 'impl-session-3e2',
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
            assignedNodeId: 'node_a9928da204ce4db1a41723f8a067414f',
            assignedSessionId: 'impl-session-3e2',
            assignedProviderType: 'claude-cli',
            targetNodeId: 'node_a9928da204ce4db1a41723f8a067414f',
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
            difficulty: 'medium', targetNodeId: 'node_a9928da204ce4db1a41723f8a067414f',
            review: { sourceTaskId: p.id, independence: 'different_provider' },
            routingPreferences: { nodeIds: ['node_a9928da204ce4db1a41723f8a067414f'], providers: ['antigravity-cli'] },
        });
        expect(newChild.inputArtifactIds).toContain('art_e4ec721b0297e1aa');
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
        for (const extra of [{ sourceProvider: 'claude-cli' }, { assignedProviderType: 'claude-cli' }, { sourceSessionId: 'impl-session-3e2' }, { sourceNodeId: h.host.nodeId }]) {
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
            'node_a9928da204ce4db1a41723f8a067414f', 'impl-session-3e2', 'claude-cli',
            h.parent().id, Date.now(), JSON.stringify({ taskId: h.parent().id }),
        );
        await expect(recoverPendingStageReview({ ...h.request(), reviewerProvider: 'claude-cli' }, h.host, h.ports)).rejects.toThrow('review_independence_required');
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).resolves.toMatchObject({
            dryRun: true,
            sourceProvenance: { providerType: 'claude-cli', sessionId: 'impl-session-3e2', via: 'local_record' },
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
        h.store.missionItems().updateItem(h.request().meshId, 'mi_cf4d2178ff17', { refs: [{ kind: 'task', value: h.completedChildIds[4] }] } as any);
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_owner_authorization_required');
        h.store.missionItems().updateItem(h.request().meshId, 'mi_cf4d2178ff17', { refs: [{ kind: 'task', value: h.parent().id }], decision: { ...h.decision, answerRevision: 9 } } as any);
        await expect(recoverPendingStageReview(h.request(), h.host, h.ports)).rejects.toThrow('review_owner_authorization_required');
        h.store.missionItems().updateItem(h.request().meshId, 'mi_cf4d2178ff17', { refs: [{ kind: 'task', value: h.parent().id }], decision: h.decision } as any);

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
