import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const state = vi.hoisted(() => ({ config: '', parent: undefined as any, child: undefined as any, mesh: undefined as any }));
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.config, loadConfig: () => ({}), getMachineId: () => 'host-test', getMachineNickname: () => null }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: () => state.mesh, getMeshByRepo: () => undefined, listMeshes: () => state.mesh ? [state.mesh] : [] }));

import { assertNotSecretContent } from '../../src/artifacts/artifact-path-guard.js';
import { assertStageDiffContent, STAGE_DIFF_SCAN_BYTES } from '../../src/mesh/stage-diff-content-guard.js';
import { validateStageDiffManifest } from '../../src/mesh/stage-diff-manifest.js';
import { validateCurrentDiff } from '../../src/mesh/stage-review-input.js';
import * as credentialScanner from '../../src/logging/credential-redactor.js';
import { gzipSync } from 'node:zlib';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createProductionStagePorts, defaultStageGit, setStageArtifactRegistrar } from '../../src/mesh/stage-ports-default.js';
import { diffDigest, readStageDiffPage, stageDiffArgs, STAGE_DIFF_MAX_BYTES, writeStageDiffManifest, type StageDiffScope } from '../../src/mesh/stage-diff-manifest.js';
import { attestStageReviewInput, currentStageReviewScope, stageReviewArtifactGrants } from '../../src/mesh/stage-review-input.js';
import { verifyAndReadArtifactBuffer } from '../../src/artifacts/artifact-store-read.js';
import { hashStageGit, registerStageDiff, singleStageDiff } from '../../src/mesh/stage-diff-stream.js';
import { StagePipelineRuntime } from '../../src/mesh/stage-pipeline-runtime.js';
import { setStagePorts } from '../../src/mesh/stage-ports-default.js';
import { decodeStageSourceGenerated, setStageGeneratedRecipe } from '../../src/mesh/stage-source-generated-provider.js';
import { validateStageSourceGeneratedRead } from '../../src/mesh/stage-review-input.js';
import { reviewRoutingRefusal } from '../../src/mesh/mesh-task-routing-contract.js';
import { prepareRecoveryDiff, type StageReviewRecoveryRequest } from '../../src/mesh/stage-review-recovery.js';
import { artifactHandlers } from '../../src/commands/med-family/artifacts.js';
import { mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';

vi.mock('../../src/mesh/mesh-work-queue-enqueue.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/mesh/mesh-work-queue-enqueue.js')>(),
    enqueueTask: (meshId: string, _message: string, opts: any) => {
        if (state.child) throw new Error('duplicate fixture enqueue');
        return state.child = { id: 'fixture-child', meshId, missionId: opts.missionId, origin: 'stage', stageRole: 'review',
            parentTaskId: opts.stageChild.parentTaskId, stageRound: opts.stageChild.round, review: opts.stageChild.review,
            reviewerWorkspace: opts.stageChild.reviewerWorkspace, inputArtifactIds: opts.inputArtifactIds, status: 'pending', readonly: true };
    },
}));

let db: Database.Database, store: ArtifactStore;
beforeEach(() => {
    state.config = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'stage-diff-production-')));
    state.parent = { id: 'parent', meshId: 'mesh-test' };
    db = new Database(join(state.config, 'artifacts.sqlite')); store = new ArtifactStore(db);
    // Narrow store facade only: no MeshRuntimeStore constructor, ledger path, disk DB, owner
    // decision or live claim. ArtifactStore uses real native SQLite and its real schema/admission.
    vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ get db() { return db; },
        findQueueEntryById: (_mesh: string, id: string) => id === 'parent' ? state.parent : state.child,
        getQueueEntries: () => [state.parent],
        transaction: (fn: () => unknown) => db.transaction(fn)(), updateQueueEntry: (entry: any) => { state.parent = entry; } } as any);
    setStageArtifactRegistrar(input => store.register(input).record.artifactId);
});
afterEach(() => { state.mesh = state.child = undefined; setStagePorts({ reviewerWorkspace: undefined }); setStageGeneratedRecipe(undefined); setStageArtifactRegistrar(null); vi.restoreAllMocks(); db.close(); fs.rmSync(state.config, { recursive: true, force: true }); });

const scope = (): StageDiffScope => ({ meshId: 'mesh-test', parentTaskId: 'parent', taskId: 'parent', round: 3, producerRole: 'pipeline', originDaemonId: 'host-test',
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), checkout: { path: '/fixture', identity: '1:2' }, gitlinks: { base: '', head: '' } });
const sources = (b: Buffer) => [{ repo: 'root' as const, baseSha: scope().baseSha, headSha: scope().headSha, gitArgs: stageDiffArgs(scope().baseSha, scope().headSha),
    stream: async function* () { yield b; } }];

it('production artifact port stamps origin, verifies every native SQL grant, and reads exact input bytes', async () => {
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' }), bytes = Buffer.from('한글🙂\ncomplete input\n');
    const result = await writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: sources(bytes), operationKey: 'diff-native' });
    const grants = stageReviewArtifactGrants({ db } as any, state.parent, [result.artifactId]);
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
        const record = store.get(grant.id)!;
        expect(record.originDaemonId).toBe('host-test'); expect(record.producerRole).toBe('pipeline'); expect(record.sessionId).toBe('stage:parent');
    }
    const page = readStageDiffPage(result.manifest, c => verifyAndReadArtifactBuffer(store.get(c.id)!).buffer, 1, 7);
    expect(Buffer.from(page.byteContentBase64, 'base64')).toEqual(bytes.subarray(1, 8));
    expect(ports.artifacts.register({ meshId: 'mesh-test', taskId: '..', kind: 'diff', title: 'escape', operationKey: 'diff-escape', ext: '.txt', content: 'must not escape' })).toMatchObject({ ok: false, code: 'review_diff_task_path' });
    expect(fs.existsSync(join(state.config, 'diff-escape.txt'))).toBe(false);
    const c = result.manifest.chunks[0];
    db.prepare('UPDATE session_artifacts SET origin_daemon_id = ? WHERE artifact_id = ?').run('foreign-host', c.id);
    expect(ports.artifacts.verifyRegistered!({ meshId: 'mesh-test', taskId: 'parent', artifactId: c.id, sha256: c.sha256, bytes: c.bytes })).toBe(false);
    expect(() => stageReviewArtifactGrants({ db } as any, state.parent, [result.artifactId])).toThrow('unauthorized_chunk');
});

it('production registration refuses secret-shaped bytes without masking the retained text chunk or committing a manifest', async () => {
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' }), bytes = Buffer.from('sk-live-1234567890abcdefghijklmnop\n');
    await expect(writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: sources(bytes), operationKey: 'diff-secret' })).rejects.toMatchObject({ code: 'secret_file_refused' });
    const recovery = join(state.config, 'stage-artifacts', 'parent', '.recovery');
    const file = join(recovery, fs.readdirSync(recovery).find(n => n.startsWith('diff-secret-staging-0.'))!);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(store.listBySession('stage:parent')).toHaveLength(0);
    expect(fs.existsSync(join(state.config, 'stage-artifacts', 'parent', 'diff-secret-manifest.json'))).toBe(false);
});

it('production files/SQL preserve chunk ids through an interrupted manifest register and a fresh port retry', async () => {
    let interrupted = true;
    setStageArtifactRegistrar(input => interrupted && input.path.endsWith('-manifest.json') ? null : store.register(input).record.artifactId);
    const bytes = Buffer.from('durable retry\n'), input = { scope: scope(), sources: sources(bytes), operationKey: 'diff-restart' };
    await expect(writeStageDiffManifest({ ...input, artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts })).rejects.toMatchObject({ code: 'artifact_storage_unavailable' });
    const prior = store.listBySession('stage:parent'); expect(prior).toHaveLength(1);
    interrupted = false;
    const first = await writeStageDiffManifest({ ...input, artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts });
    const again = await writeStageDiffManifest({ ...input, artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts });
    expect(first.artifactId).toBe(again.artifactId); expect(first.manifest.chunks[0].id).toBe(prior[0].artifactId);
    expect(first.manifest.sha256).toBe(diffDigest(bytes)); expect(store.listBySession('stage:parent')).toHaveLength(2);
});

it('production retention refuses growth before file publication and still reports complete input bytes/hash', async () => {
    const root = join(state.config, 'stage-artifacts'); fs.mkdirSync(root);
    const fd = fs.openSync(join(root, 'unregistered-retained.txt'), 'wx');
    try { fs.ftruncateSync(fd, STAGE_DIFF_MAX_BYTES); } finally { fs.closeSync(fd); }
    const bytes = Buffer.from('complete count while storage is full\n');
    await expect(writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts,
        scope: scope(), sources: sources(bytes), operationKey: 'diff-full' })).rejects.toMatchObject({ code: 'artifact_storage_budget_exceeded', details: {
        bytes: bytes.length, sha256: diffDigest(bytes), completeByteCount: true, journalUnavailable: true,
    } });
    expect(fs.existsSync(join(root, 'parent'))).toBe(false);
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

it('legacy text compatibility requires a manifest for >4MiB or invalid UTF8, with complete byte/hash receipts', async () => {
    const workspace = join(state.config, 'checkout'); fs.mkdirSync(workspace);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=vilmire', '-c', 'user.email=vilmire@users.noreply.github.com', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); fs.writeFileSync(join(workspace, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'Fixture base');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(join(workspace, 'unicode.txt'), '한\n'.repeat(1_000_000)); git('add', '.'); git('commit', '-m', 'Fixture Unicode');
    const head = git('rev-parse', 'HEAD');
    const hash = await hashStageGit(workspace, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}..${head}`]);
    await expect(singleStageDiff(workspace, base, head)).rejects.toMatchObject({ code: 'review_diff_requires_manifest', details: { sha256: hash, completeByteCount: true, limitBytes: 4 * 1024 * 1024 } });
    fs.writeFileSync(join(workspace, 'invalid.txt'), Buffer.from([0xff, 0x0a])); git('add', '.'); git('commit', '-m', 'Fixture invalid UTF8');
    await expect(singleStageDiff(workspace, head, git('rev-parse', 'HEAD'))).rejects.toMatchObject({ code: 'review_diff_requires_manifest', details: { completeByteCount: true } });
});

it('production checkout/grant/claim-refusal/verdict gates reject round, missing-grant, origin and HEAD drift', async () => {
    const workspace = join(state.config, 'checkout'); fs.mkdirSync(workspace);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=vilmire', '-c', 'user.email=vilmire@users.noreply.github.com', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); fs.writeFileSync(join(workspace, 'text.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'Fixture base');
    const base = git('rev-parse', 'HEAD'); fs.writeFileSync(join(workspace, 'text.txt'), '한글🙂\n'); git('commit', '-am', 'Fixture head');
    const head = git('rev-parse', 'HEAD'), ports = createProductionStagePorts({ statusInstanceId: 'host-test' });
    const result = await registerStageDiff({ git: defaultStageGit, artifacts: ports.artifacts, workspace, base, head, meshId: 'mesh-test', taskId: 'parent',
        round: 3, originDaemonId: 'host-test', operationKey: 'diff-checkout' });
    Object.assign(state.parent, { status: 'assigned', assignedProviderType: 'codex-cli', assignedSessionId: 'fixture-implementer',
        stagePlan: { review: true }, stageState: { phase: 'awaiting_review', round: 3, baseSha: base, stageHeads: [{ round: 3, rootSha: head }],
            artifacts: { diff: [result.artifactId], selfCheck: [], verdict: [] }, reviewTaskIds: ['fixture-review'] } });
    const grants = stageReviewArtifactGrants({ db } as any, state.parent, [result.artifactId]);
    const proof = attestStageReviewInput(state.parent, { repoIdentity: 'fixture/repo', machineId: 'host-test', nodeId: 'fixture-node', workspace }, grants);
    proof.childTaskId = 'fixture-review'; state.parent.stageReviewInput = proof;
    const child: any = { id: 'fixture-review', parentTaskId: 'parent', origin: 'stage', stageRole: 'review', stageRound: 3, readonly: true,
        review: { sourceTaskId: 'parent', independence: 'different_provider' }, inputArtifactIds: grants.map(g => g.id) };
    const context = { workspace, machineId: 'host-test', repoIdentity: 'fixture/repo' };
    expect(currentStageReviewScope(state.parent, child)).toBeDefined();
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(true);
    expect(reviewRoutingRefusal(child, state.parent, 'fixture-review-provider', context, [], 'fixture-review-session', { db } as any)).toBeUndefined();
    state.parent.stageState.round = 4;
    expect(currentStageReviewScope(state.parent, child)).toBeUndefined();
    state.parent.stageState.round = 3;
    expect(currentStageReviewScope(state.parent, { ...child, inputArtifactIds: [result.artifactId] })).toBeUndefined();
    const c = result.manifest.chunks[0];
    db.prepare('UPDATE session_artifacts SET origin_daemon_id = ? WHERE artifact_id = ?').run('foreign', c.id);
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
    expect(reviewRoutingRefusal(child, state.parent, 'fixture-review-provider', context, [], 'fixture-review-session', { db } as any)).toBe('review_input_unavailable');
    db.prepare('UPDATE session_artifacts SET origin_daemon_id = ? WHERE artifact_id = ?').run('host-test', c.id);
    fs.writeFileSync(join(workspace, 'text.txt'), 'different head\n'); git('commit', '-am', 'Fixture changed head');
    expect(currentStageReviewScope(state.parent, child)).toBeUndefined();
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
});

it('production revision resend names every verified chunk instead of granting only the manifest', async () => {
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' }), bytes = Buffer.from('revision input\n');
    const result = await writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: sources(bytes), operationKey: 'diff-revise' });
    Object.assign(state.parent, { message: 'fixture task', status: 'assigned', difficulty: 'difficult', assignedSessionId: 'fixture-implementer',
        stageState: { round: 3, phase: 'revising', workerArtifactIds: [], artifacts: { diff: [result.artifactId], selfCheck: [], verdict: [] } } });
    ports.queue.requeueForRevision(state.parent, 'fixture revision', { inputArtifactIds: [result.artifactId], sameSessionId: 'fixture-implementer' });
    expect(state.parent.inputArtifactIds).toEqual([result.artifactId, ...result.manifest.chunks.map(c => c.id)]);
    expect(state.parent.difficulty).toBe('difficult'); expect(state.parent.targetSessionId).toBe('fixture-implementer');
});

it('recovery rebuilds full historical base even with diff=[] and zero continuation delta', async () => {
    const workspace = join(state.config, 'checkout'); fs.mkdirSync(workspace);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=vilmire', '-c', 'user.email=vilmire@users.noreply.github.com', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); fs.writeFileSync(join(workspace, 'text.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'Fixture base');
    const base = git('rev-parse', 'HEAD'); fs.writeFileSync(join(workspace, 'text.txt'), 'full review required\n'); git('commit', '-am', 'Fixture candidate');
    const head = git('rev-parse', 'HEAD'), ports = createProductionStagePorts({ statusInstanceId: 'host-test' });
    const request = { v: 2, meshId: 'mesh-test', parentTaskId: 'parent', expectedStageHeadSha: head, expectedHeadSha: head } as StageReviewRecoveryRequest;
    const host = { actor: 'host-test', repoIdentity: 'fixture/repo', machineId: 'host-test', nodeId: 'fixture-node', workspace };
    state.parent.stageState = { baseSha: base, round: 3, artifacts: { diff: [] } };
    const prepared = await prepareRecoveryDiff(ports, host, request, state.parent.stageState.baseSha, 3);
    const artifactId = await prepared.register();
    const manifest = JSON.parse(store.fetchArtifactContent(artifactId).content);
    expect(manifest.scope.baseSha).toBe(base); expect(manifest.scope.headSha).toBe(head); expect(manifest.bytes).toBeGreaterThan(0);
    expect(manifest.sha256).toBe(await hashStageGit(workspace, stageDiffArgs(base, head)));
    expect(manifest.sha256).not.toBe(diffDigest(Buffer.alloc(0)));
    await expect(prepareRecoveryDiff(ports, host, request, '', 3)).rejects.toThrow('full_stage_base_required');
    // This tests production recovery input construction only. Owner/CAS/child creation remains
    // behind the real recovery command and is not bypassed or asserted by this helper test.
});

// Harmless synthetic identifier: each physical artifact passes the existing guard;
// concatenation is forbidden. No real credential or original diff content is used.
it('aggregate guard refuses a split identifier before any chunk or manifest registration', async () => {
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' });
    const left = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 10, 0x20), Buffer.from('ADHDEV_MCP')]);
    const bytes = Buffer.concat([left, Buffer.from('_SESSION_CREDENTIAL')]);
    await expect(writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: sources(bytes), operationKey: 'diff-aggregate-red' })).rejects.toMatchObject({ code: expect.stringMatching(/^(secret_file_refused|review_diff_scan_)/) });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

const aggregateCases: Array<[string, string, number]> = [
    ['identifier', 'ADHDEV_MCP_SESSION_CREDENTIAL', 10],
    ['literal', 'mcpSessionCredential: "synthetic123456"', 12],
    ['header', 'Authorization: Bearer demo7', 19],
    ['bearer', 'Bearer synthetic123456', 10],
    ['encoded JSON', Buffer.from(JSON.stringify({ label: 'ADHDEV_MCP_SESSION_CREDENTIAL' })).toString('base64'), 24],
    ['source-map', '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify({ sourcesContent: ['ADHDEV_MCP_SESSION_CREDENTIAL'] })).toString('base64'), 75],
    ['split escape', 'ADHDEV_MCP\\n_SESSION_CREDENTIAL', 12],
];
it.each(aggregateCases)('aggregate guard applies unchanged raw/artifact/decoded policy to split %s', async (_name, value, split) => {
    const left = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - split, 0x20), Buffer.from(value.slice(0, split))]);
    const right = Buffer.from(value.slice(split));
    expect(() => assertNotSecretContent(left, 'text')).not.toThrow();
    expect(() => assertNotSecretContent(right, 'text')).not.toThrow();
    expect(() => assertNotSecretContent(Buffer.concat([left, right]), 'text')).toThrow('secret_file_refused');
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' });
    await expect(writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: sources(Buffer.concat([left, right])), operationKey: 'diff-case' })).rejects.toMatchObject({ code: 'secret_file_refused' });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

it.each([-2, -1, 0, 1, 2])('aggregate guard covers positions around the physical boundary %i', async delta => {
    const value = Buffer.from('ADHDEV_MCP_SESSION_CREDENTIAL');
    const bytes = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 10 + delta, 0x20), value]);
    await expect(writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts,
        scope: scope(), sources: sources(bytes), operationKey: 'diff-edge' })).rejects.toMatchObject({ code: 'secret_file_refused' });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

it('aggregate guard blocks legacy hash-valid split manifests at grants, child-input and ACK validation', () => {
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' });
    const parts = [Buffer.from('ADHDEV_MCP'), Buffer.from('_SESSION_CREDENTIAL')];
    const chunks = parts.map((content, index) => {
        const r = ports.artifacts.register({ meshId: 'mesh-test', taskId: 'parent', kind: 'diff', title: 'legacy synthetic chunk', content, ext: '.txt', operationKey: `diff-legacy-${index}` });
        if (!r.ok) throw new Error('fixture registration failed');
        return { id: r.artifactId, index, offset: index ? parts[0].length : 0, bytes: content.length, sha256: diffDigest(content) };
    });
    const bytes = Buffer.concat(parts), manifest = { header: 'adhdev-stage-diff' as const, version: 1 as const, state: 'complete' as const, scope: scope(),
        chunks, bytes: bytes.length, sha256: diffDigest(bytes), sections: [{ repo: 'root' as const, baseSha: scope().baseSha, headSha: scope().headSha,
        gitArgs: stageDiffArgs(scope().baseSha, scope().headSha), offset: 0, bytes: bytes.length, sha256: diffDigest(bytes) }] };
    const r = ports.artifacts.register({ meshId: 'mesh-test', taskId: 'parent', kind: 'diff', title: 'legacy metadata', content: JSON.stringify(manifest), ext: '.json', operationKey: 'diff-legacy-manifest' });
    if (!r.ok) throw new Error('fixture manifest failed');
    // Seeded legacy SQL rows are deliberate; new writer cannot publish this bundle.
    expect(() => stageReviewArtifactGrants({ db } as any, state.parent, [r.artifactId])).toThrow('secret_file_refused');
    const grants = [r.artifactId, ...chunks.map(c => c.id)].map(id => { const a = store.get(id)!; return { id, file: join(a.workspaceRoot, a.relPath), size: a.sizeBytes, sha256: a.sha256 }; });
    state.parent.stageState = { round: 3, baseSha: scope().baseSha, stageHeads: [{ rootSha: scope().headSha }], artifacts: { diff: [r.artifactId] } };
    expect(() => validateCurrentDiff(state.parent, grants)).toThrow('secret_file_refused');
    expect(() => validateStageDiffManifest(manifest, scope(), c => parts[c.index])).toThrow('secret_file_refused');
});

it('aggregate guard retains interruption evidence with zero registration and revalidates identical retry after restart', async () => {
    const ports = createProductionStagePorts({ statusInstanceId: 'host-test' });
    const bytes = Buffer.from('한글🙂 complete harmless bytes\n');
    const broken = sources(bytes); broken[0].stream = async function* () { yield bytes; throw new Error('synthetic capture interruption'); };
    await expect(writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: broken, operationKey: 'diff-capture-crash' })).rejects.toMatchObject({ code: 'review_diff_producer_failed' });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
    const recovery = join(state.config, 'stage-artifacts', 'parent', '.recovery');
    expect(fs.readdirSync(recovery).some(n => n.startsWith('diff-capture-crash-staging-0.'))).toBe(true);
    const first = await writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts, scope: scope(), sources: sources(bytes), operationKey: 'diff-capture-crash' });
    const retry = await writeStageDiffManifest({ artifacts: ports.artifacts, scope: scope(), sources: sources(bytes), operationKey: 'diff-capture-crash' });
    expect(retry.artifactId).toBe(first.artifactId); expect(retry.manifest.sha256).toBe(diffDigest(bytes));
    expect(fs.readdirSync(recovery).some(n => n.startsWith('diff-capture-crash-staging-0.'))).toBe(true);
});

it('aggregate guard blocks scan budget, invalid UTF8, unsupported escapes/compression and excessive decode depth before registration', async () => {
    let nested = 'ADHDEV_MCP_SESSION_CREDENTIAL';
    for (let i = 0; i < 10; i++) nested = Buffer.from(nested).toString('base64');
    const cases = [Buffer.alloc(STAGE_DIFF_SCAN_BYTES + 1, 0x20), Buffer.from([0xff]), Buffer.from('\\u0041 benign'), gzipSync('synthetic benign'),
        Buffer.from(gzipSync('synthetic benign').toString('base64')), Buffer.from(nested), Buffer.from(Buffer.from('\\u0041 benign').toString('base64')), Buffer.from('%5Cu0041 benign'), Buffer.concat([Buffer.alloc(6 * 1024 * 1024, 0x20), Buffer.from('%2525252541')])];
    for (const [index, bytes] of cases.entries()) {
        await expect(writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts, scope: scope(), sources: sources(bytes), operationKey: `diff-incomplete-${index}` })).rejects.toMatchObject({ code: expect.stringMatching(/^review_diff_scan_/) });
        expect(store.listBySession('stage:parent')).toHaveLength(0);
    }

});

it('aggregate guard preserves benign bytes/hash with UTF8 and stream splits across 4MiB', async () => {
    const bytes = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 2, 0x20), Buffer.from('한글🙂 harmless\n')]);
    const s = sources(bytes); s[0].stream = async function* () { for (let i = 0; i < bytes.length; i += 65521) yield bytes.subarray(i, i + 65521); };
    const result = await writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts, scope: scope(), sources: s, operationKey: 'diff-utf8' });
    expect(result.manifest.sha256).toBe(diffDigest(bytes));
    expect(Buffer.concat(result.manifest.chunks.map(c => verifyAndReadArtifactBuffer(store.get(c.id)!).buffer))).toEqual(bytes);
});

it('aggregate guard interrupts a stalled scanner callback and publishes zero records', async () => {
    vi.spyOn(credentialScanner, 'inspectCredentialContent').mockImplementation(() => { for (;;) { /* injected scanner stall */ } });
    await expect(writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts,
        scope: scope(), sources: sources(Buffer.from('benign stalled scan')), operationKey: 'diff-stalled' })).rejects.toMatchObject({ code: 'review_diff_scan_timeout' });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

it('aggregate guard scans full decoded match spans beyond the legacy 64KiB slice and overlap', async () => {
    const decoded = 'Authorization:' + ' '.repeat(70_000) + 'Bearer demo7';
    const bytes = Buffer.from(Buffer.from(decoded).toString('base64'));
    await expect(writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts,
        scope: scope(), sources: sources(bytes), operationKey: 'diff-span' })).rejects.toMatchObject({ code: 'secret_file_refused' });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

it('aggregate guard rejects an absent scan-completion result before publication', async () => {
    vi.spyOn(credentialScanner, 'inspectCredentialContent').mockReturnValue({} as any);
    await expect(writeStageDiffManifest({ artifacts: createProductionStagePorts({ statusInstanceId: 'host-test' }).artifacts,
        scope: scope(), sources: sources(Buffer.from('benign missing scan receipt')), operationKey: 'diff-no-scan' })).rejects.toMatchObject({ code: 'review_diff_scan_incomplete' });
    expect(store.listBySession('stage:parent')).toHaveLength(0);
});

it('resumes a zero-child handoff with large generated evidence and binds the detached review grants', async () => {
    const root = join(state.config, 'root'), upstream = join(state.config, 'oss-history');
    fs.mkdirSync(root);
    fs.mkdirSync(upstream);
    const git = (cwd: string, ...args: string[]) => execFileSync('git',
        ['-c', 'user.name=vilmire', '-c', 'user.email=vilmire@users.noreply.github.com', '-c', 'protocol.file.allow=always', ...args],
        { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const generatedPath = 'packages/daemon-standalone/vendor/example.bin';
    const unchangedPath = 'packages/daemon-standalone/vendor/unchanged.bin';
    const unchanged = Buffer.from('independent generated output');
    const output = (seed: Buffer) => Buffer.alloc(17 * 1024 * 1024 + 3, seed[0]);
    fs.mkdirSync(join(upstream, 'packages/daemon-standalone/vendor'), { recursive: true });
    fs.writeFileSync(join(upstream, 'seed.txt'), 'a');
    fs.writeFileSync(join(upstream, unchangedPath), unchanged);
    fs.writeFileSync(join(upstream, generatedPath), output(Buffer.from('a')));
    git(upstream, 'init', '-b', 'main');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'Fixture OSS base');
    git(root, 'init', '-b', 'main');
    git(root, 'submodule', 'add', upstream, 'oss');
    git(root, 'commit', '-m', 'Fixture root base');
    const base = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(join(upstream, 'seed.txt'), 'b');
    fs.writeFileSync(join(upstream, generatedPath), output(Buffer.from('b')));
    git(upstream, 'commit', '-am', 'Fixture OSS head');
    git(join(root, 'oss'), 'fetch', 'origin');
    git(join(root, 'oss'), 'checkout', '--detach', 'origin/main');
    fs.writeFileSync(join(root, 'root.txt'), 'root source change\n');
    git(root, 'add', 'oss', 'root.txt');
    git(root, 'commit', '-m', 'Fixture root head');
    const head = git(root, 'rev-parse', 'HEAD');
    let inputGraphSalt = '';
    let producer = diffDigest('fixture deterministic byte expansion'), drift = false, partial = false;
    const matches = (repo: string, file: string) => repo === 'oss' && (file === generatedPath || file === unchangedPath);
    setStageGeneratedRecipe({
        matches,
        reproduce(objects, scope) {
            const commits = [scope.gitlinks.base, scope.gitlinks.head].map(s => s.split(' ')[2].split('\t')[0]);
            // Closed fixture recipe: hash its only two immutable input blobs and fixed configuration.
            const seeds = commits.map(commit => objects.blob('oss', git(upstream, 'rev-parse', commit + ':seed.txt'), 16));
            return { producerSha256: producer, configSha256: diffDigest('5242883'),
                inputGraphSha256: diffDigest(Buffer.concat([...seeds, Buffer.from(inputGraphSalt)])),
                outputs: new Map([['oss:' + generatedPath, { before: output(seeds[0]), after: output(drift ? Buffer.from('x') : seeds[1]) }],
                    ...(partial ? [] : [['oss:' + unchangedPath, { before: unchanged, after: unchanged }]] as const)]) };
        },
    });
    state.mesh = { id: 'mesh-test', repoIdentity: 'fixture/repo', nodes: [{ id: 'fixture-node', workspace: root, daemonId: 'host-test' }] };
    Object.assign(state.parent, { missionId: 'fixture-mission', status: 'assigned', message: 'Review fixture',
        assignedNodeId: 'fixture-node', assignedProviderType: 'implementer', assignedSessionId: 'implementer-session',
        stagePlan: { review: true, maxRevisions: 1 }, stageState: {
            phase: 'awaiting_review', round: 1, baseSha: base, startedAt: new Date().toISOString(), stageHeads: [{ round: 1, rootSha: head }], openFindingIds: [],
            artifacts: { diff: [], selfCheck: [], verdict: [] }, reviewTaskIds: [],
        },
    });
    const st = state.parent.stageState;
    const makePorts = () => createProductionStagePorts({ statusInstanceId: 'host-test' });
    const ports = makePorts();
    // Settlement is exercised with the real attempt ledger in the integration fixture.
    ports.queue.reviewWriterSettled = () => true;
    const runtime = new StagePipelineRuntime(ports);
    const optionalCheckout = vi.fn(async () => null);
    setStagePorts({ reviewerWorkspace: { prepare: optionalCheckout } });
    await runtime.tick();
    await runtime.idle();
    const id = st.artifacts.diff.at(-1)!;
    expect(id).toBeDefined();
    const manifest = decodeStageSourceGenerated(verifyAndReadArtifactBuffer(store.get(id)!).buffer)!;
    expect(manifest.inventory.map(c => [c.repo, c.path, c.kind])).toEqual([
        ['root', 'oss', 'source'], ['root', 'root.txt', 'source'], ['oss', generatedPath, 'generated'], ['oss', 'seed.txt', 'source'],
    ]);
    const evidence = manifest.inventory.find(c => c.kind === 'generated');
    expect(evidence).toMatchObject({ evidence: { output: { bytes: output(Buffer.from('b')).length }, previous: { bytes: output(Buffer.from('a')).length } } });
    expect(store.listBySession('stage:parent')).toHaveLength(2);
    const grants = stageReviewArtifactGrants({ db }, state.parent, [id]);
    expect(verifyAndReadArtifactBuffer(store.get(grants[1].id)!).buffer.toString()).toContain('+root source change');
    expect(optionalCheckout).not.toHaveBeenCalled();
    const child = state.child;
    const reviewer = child?.reviewerWorkspace.path;
    expect(reviewer).toMatch(join(state.config, 'stage-review-checkouts', 'review-'));
    expect(git(reviewer, 'rev-parse', 'HEAD')).toBe(head);
    expect(child.inputArtifactIds).toEqual(grants.map(grant => grant.id));
    expect(currentStageReviewScope(state.parent, child)?.worktree).toBe(reviewer);
    expect(currentStageReviewScope(state.parent, { ...child, reviewerWorkspace: undefined })).toBeUndefined();
    db.close();
    db = new Database(join(state.config, 'artifacts.sqlite'));
    store = new ArtifactStore(db);
    expect(makePorts().queue.reviewInputValid!(state.parent, child)).toBe(true);
    expect(() => validateStageSourceGeneratedRead({ db }, state.parent, child)).not.toThrow();
    const attempt = { attemptId: 'review-attempt', taskId: child.id, meshId: child.meshId, sessionId: 'reviewer-session' };
    Object.assign(child, { status: 'assigned', assignedSessionId: attempt.sessionId, assignedNodeId: 'fixture-node', attemptId: attempt.attemptId });
    Object.assign(MeshRuntimeStore.getInstance(), {
        findAssignedBySession: () => child,
        turnStore: () => ({ findLatestAttemptForTask: () => attempt, getAttempt: () => attempt }),
    });
    let workerWorkspace = reviewer;
    const commandContext = {
        deps: { statusInstanceId: 'host-test', sessionRegistry: { get: () => ({ workspace: workerWorkspace }) } },
        getMeshForCommand: async () => state.mesh,
    } as any;
    const { token } = mintWorkerTaskToken({ ...attempt, nodeId: 'fixture-node' });
    const read = (artifactId: string) => artifactHandlers.artifact_read(commandContext, { token, artifactId });
    const manifestRead = await read(id);
    expect(manifestRead, JSON.stringify(manifestRead.success ? {} : manifestRead)).toMatchObject({ success: true, artifactId: id });
    expect(await read(grants[1].id)).toMatchObject({ success: true, content: expect.stringContaining('+root source change') });
    child.inputArtifactIds = [id];
    expect(await read(grants[1].id)).toMatchObject({ success: false });
    child.inputArtifactIds = grants.map(grant => grant.id);
    const checkout = child.reviewerWorkspace;
    delete child.reviewerWorkspace;
    expect(await read(grants[1].id)).toMatchObject({ success: false });
    child.reviewerWorkspace = checkout;
    expect(await read('ungranted')).toMatchObject({ success: false });
    workerWorkspace = root;
    expect(await read(id)).toMatchObject({ success: false });
    const alias = join(state.config, 'checkout-alias');
    fs.symlinkSync(reviewer, alias, 'junction');
    workerWorkspace = alias;
    expect(await read(id)).toMatchObject({ success: false });
    workerWorkspace = reviewer;
    expect(await artifactHandlers.artifact_read(commandContext, { token, artifactId: id, meshId: 'foreign' })).toMatchObject({ success: false });
    child.stageRound = 2;
    expect(await read(id)).toMatchObject({ success: false });
    child.stageRound = 1;
    attempt.attemptId = 'replacement-attempt';
    expect(await read(id)).toMatchObject({ success: false });
    attempt.attemptId = 'review-attempt';
    git(reviewer, 'checkout', '--detach', base);
    expect(await read(id)).toMatchObject({ success: false });
    git(reviewer, 'checkout', '--detach', head);
    git(reviewer, 'checkout', '-b', 'unexpected-review-branch');
    expect(await read(id)).toMatchObject({ success: false });
    git(reviewer, 'checkout', '--detach', head);
    child.status = 'pending';
    const context = { workspace: reviewer, machineId: 'host-test', repoIdentity: 'fixture/repo' };
    expect(reviewRoutingRefusal(child, state.parent, 'reviewer', context, [], 'reviewer-session', { db })).toBeUndefined();
    expect(reviewRoutingRefusal(child, state.parent, 'reviewer', { ...context, workspace: root }, [], 'reviewer-session', { db })).toBe('review_input_unavailable');
    await runtime['runEffect'](state.parent, { kind: 'create_review_child', round: 1 });
    expect(st.reviewTaskIds).toEqual([child.id]);
    expect(ports.queue.reviewInputValid!(state.parent, { ...child, inputArtifactIds: [id] })).toBe(false);
    expect(ports.queue.reviewInputValid!(state.parent, { ...child, meshId: 'foreign' })).toBe(false);
    expect(ports.queue.reviewInputValid!(state.parent, { ...child, missionId: 'foreign' })).toBe(false);
    expect(ports.queue.reviewInputValid!(state.parent, { ...child, stageRound: 2 })).toBe(false);
    st.reviewTaskIds.push(child.id);
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
    st.reviewTaskIds.pop();
    drift = true;
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
    drift = false;
    partial = true;
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
    partial = false;
    producer = diffDigest('different producer');
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
    producer = diffDigest('fixture deterministic byte expansion');
    inputGraphSalt = 'changed inputs';
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
    inputGraphSalt = '';
    const privateDir = join(state.config, 'stage-artifacts', 'parent', '.recovery');
    const privateFile = join(privateDir, fs.readdirSync(privateDir).find(file => file.endsWith('.bin'))!);
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(true);
    fs.truncateSync(privateFile, 1);
    expect(() => validateStageSourceGeneratedRead({ db }, state.parent, child)).toThrow();
    expect(ports.queue.reviewInputValid!(state.parent, child)).toBe(false);
}, 90_000);
