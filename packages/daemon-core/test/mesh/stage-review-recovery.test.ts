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
        for (const patch of [{ v: 2 }, { difficulty: 'easy' }, { force: true }, { machineId: 'spoof' }, { ownershipScope: {} }, { expectedParentRevision: -1 }]) expect(() => decodeStageReviewRecovery({ ...h.request(), ...patch })).toThrow('invalid_stage_review_recovery');
    });
});
