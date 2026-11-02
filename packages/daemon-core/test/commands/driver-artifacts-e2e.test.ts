/**
 * Driver results -> shareable artifacts, through the real command handlers:
 * credentialed worker -> DriverService -> stdio MCP server -> artifact store.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { computeDriverTreeDigest } from '../../src/drivers/installed-driver.js';
import type { InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { closeDriverService, driverHandlers, getDriverService } from '../../src/commands/med-family/drivers.js';
import { artifactHandlers, setArtifactCommandRuntimeForDeps, type ArtifactCommandContext } from '../../src/commands/med-family/artifacts.js';
import type { CommandRouterDeps } from '../../src/commands/router.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { resolveInheritedArtifactIds } from '../../src/mesh/mesh-input-artifacts.js';
import { validateWorkerCompletionReport } from '../../src/mesh/worker-report-validation.js';
import { drainWorkerMailboxForTask } from '../../src/mesh/worker-mailbox.js';
import { __resetWorkerTaskTokensForTest, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { __resetTranscriptProjectionForTests, configureTranscriptProjection } from '../../src/seqscribe/transcript-publisher.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { cleanupTempDir } from '../helpers/temp-cleanup.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('e2e-png-body')]);
const MESH = 'mesh-driver-art', MISSION = 'mission-driver-art', NODE = 'node-1';
let dir: string, ws: string, packageDir: string;
let manifest: InstalledDriverManifest;
let deps: CommandRouterDeps, ctx: ArtifactCommandContext;
let sessionRegistry: SessionRegistry, store: ArtifactStore, meshStore: MeshRuntimeStore;
let frames: number;
let svc: ReturnType<typeof createAssistantServices>;
const worker = (n = 1) => ({ taskId: `task-${n}`, sessionId: `session-${n}` });
const git = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8', windowsHide: true });

function startWorker(n: number, missionId = MISSION, registerSession = true) {
    const { taskId, sessionId } = worker(n);
    if (registerSession) sessionRegistry.register({ sessionId, parentSessionId: null, providerType: 'codex-cli', transport: 'pty', workspace: ws });
    const nowIso = new Date().toISOString();
    meshStore.insertQueueEntry({ id: taskId, meshId: MESH, targetNodeId: NODE, status: 'assigned', assignedSessionId: sessionId,
        message: 'driver artifact task', workspace: ws, missionId, createdAt: nowIso, updatedAt: nowIso } as any);
    seedMeshAttempt({ meshId: MESH, taskId, sessionId, nodeId: NODE, attemptId: `attempt-${n}`, attemptNo: 0, stage: 'generating' });
    return mintWorkerTaskToken({ meshId: MESH, taskId, sessionId, nodeId: NODE, attemptId: `attempt-${n}` }).token;
}
const invoke = (token: string, action: string, args: Record<string, unknown> = {}) =>
    driverHandlers.driver_invoke!(ctx as any, { token, type: 'browser', action, args }) as Promise<any>;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'driver-art-e2e-')); vi.stubEnv('ADHDEV_CONFIG_DIR', dir);
    ws = join(dir, 'workspace'); mkdirSync(ws);
    git('init', '-q'); writeFileSync(join(ws, 'README.md'), 'x'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    packageDir = join(dir, 'providers', 'driver', 'browser'); mkdirSync(packageDir, { recursive: true });
    manifest = { type: 'browser', name: 'Browser', category: 'driver', providerVersion: '1.0.0', _sourceTrust: 'trusted',
        runtime: { kind: 'mcp-stdio', command: process.execPath,
            args: [fileURLToPath(new URL('../drivers/fixtures/fake-mcp-server.mjs', import.meta.url))], startupTimeoutMs: 5000, idleStopMs: 10_000 },
        actions: [{ id: 'shot', tool: 'image', risk: 'read' }, { id: 'logs', tool: 'bigtext', risk: 'read' }, { id: 'wipe', tool: 'image', risk: 'destructive' }] };
    const { _sourceTrust, ...raw } = manifest; writeFileSync(join(packageDir, 'provider.v1.json'), JSON.stringify(raw));
    svc = createAssistantServices({ configDir: dir }); setAssistantServicesForTests(svc);
    MeshRuntimeStore.resetForTests(); __resetWorkerTaskTokensForTest(); __resetTranscriptProjectionForTests();
    frames = 0;
    configureTranscriptProjection({ daemonId: () => 'd', writerId: () => 'w', epoch: 'e', appendChatFrame: async () => { frames++; } });
    meshStore = MeshRuntimeStore.getInstance(); store = new ArtifactStore(meshStore.db); sessionRegistry = new SessionRegistry();
    deps = { commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn() }, cliManager: {}, cdpManagers: new Map(),
        providerLoader: { getMeta: () => manifest, getByCategory: () => [manifest], findProviderDir: () => packageDir },
        instanceManager: { getInstance: () => undefined, listInstanceIds: () => [], collectAllStates: () => [] },
        detectedIdes: { value: [] }, sessionRegistry, statusInstanceId: 'driver-art-daemon', bus: { emit: () => {}, on: () => () => {} } } as unknown as CommandRouterDeps;
    setArtifactCommandRuntimeForDeps(deps, { artifactStore: store, meshRuntimeStore: meshStore });
    ctx = { deps, getMeshForCommand: async () => ({ mesh: { policy: { drivers: {} } }, source: 'local_config', inline: false }) as any, getCachedInlineMesh: () => undefined };
    // The destructive action makes the driver non-low-risk: approve its exact digest like an owner would.
    svc.driverActivations!.approve(manifest, computeDriverTreeDigest(packageDir));
});
afterEach(async () => {
    await closeDriverService(deps); __resetWorkerTaskTokensForTest(); __resetTranscriptProjectionForTests();
    drainWorkerMailboxForTask(MESH, worker(1).taskId); drainWorkerMailboxForTask(MESH, worker(2).taskId);
    setAssistantServicesForTests(null); await cleanupTempDir(dir); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('screenshot -> shareable artifact', () => {
    it('registers the image, keeps base64 and git clean, and is shareable through report_completion, inheritance and artifact_list', async () => {
        const token = startWorker(1);
        const res = await invoke(token, 'shot', { data: PNG.toString('base64'), mime: 'image/png' });
        expect(res).toMatchObject({ success: true, status: 'completed', artifacts: [{ type: 'image', artifactId: expect.stringMatching(/^art_/), digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }] });
        expect(res.artifactError).toBeUndefined();
        expect(JSON.stringify(res)).not.toContain(PNG.toString('base64'));
        const id = res.artifacts[0].artifactId;
        expect(res.output.content[1]).toMatchObject({ type: 'image', artifactId: id, mime: 'image/png', sizeBytes: PNG.length });

        // Daemon-owned identity and location; checkout untouched.
        const record = store.getById(id)!;
        expect(record).toMatchObject({ sessionId: 'session-1', taskId: 'task-1', meshId: MESH, missionId: MISSION, producerRole: 'worker', kind: 'image', mime: 'image/png', title: 'browser.shot' });
        expect(record.relPath).toMatch(/^\.adhdev\/driver-results\/[0-9a-f-]{36}\/image-1\.png$/);
        expect(readFileSync(join(ws, record.relPath)).equals(PNG)).toBe(true);
        expect(git('status', '--porcelain', '-uall')).toBe('');
        expect(frames).toBeGreaterThan(0);

        // artifact_list by the same credentialed worker.
        const listed: any = await artifactHandlers.artifact_list!(ctx as any, { token });
        expect(listed.success).toBe(true);
        expect(listed.artifacts.map((a: any) => a.artifactId)).toContain(id);

        // Fetching returns the exact bytes (hash matches the digest the driver result carried).
        const fetched: any = await artifactHandlers.artifact_fetch!(ctx as any, { token, artifactId: id });
        expect(fetched, JSON.stringify(fetched)).toMatchObject({ success: true });
        expect(`sha256:${fetched.sha256}`).toBe(res.artifacts[0].digest);

        // report_completion accepts the id; the task finishes; a same-mission follow-up inherits it.
        expect(validateWorkerCompletionReport({ outcome: 'completed', summary: 's', touchedFiles: [], artifactIds: [id] }).errors).toEqual([]);
        meshStore.updateQueueEntry({ ...meshStore.findQueueEntryById(MESH, 'task-1')!, status: 'completed' } as any);
        const next = enqueueTask(MESH, 'follow-up', { taskMode: 'code_change', difficulty: 'medium', missionId: MISSION } as any);
        expect(next.inputArtifactIds).toContain(id);
        expect(resolveInheritedArtifactIds(MESH, MISSION)).toContain(id);
    });

    it('a screenshot above the old 1 MiB wire cap still arrives (up to the 4 MiB artifact limit)', async () => {
        const token = startWorker(1);
        const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 7)]);
        const res = await invoke(token, 'shot', { data: big.toString('base64'), mime: 'image/png' });
        expect(res).toMatchObject({ success: true, artifacts: [{ type: 'image' }] });
        expect(store.getById(res.artifacts[0].artifactId)!.sizeBytes).toBe(big.length);
        expect(JSON.stringify(res).length).toBeLessThan(2000);
    });

    it('a mime/bytes mismatch is refused without failing the call', async () => {
        const token = startWorker(1);
        const res = await invoke(token, 'shot', { data: PNG.toString('base64'), mime: 'image/jpeg' });
        expect(res).toMatchObject({ success: true, artifactError: { code: 'mime_mismatch' } });
        expect(res.artifacts).toBeUndefined();
        expect(JSON.stringify(res)).not.toContain(PNG.toString('base64'));
        expect(store.listBySession('session-1')).toEqual([]);
        expect(existsSync(join(ws, '.adhdev', 'driver-results'))).toBe(false);
    });
});

describe('large results', () => {
    it('keeps the full text as an artifact and returns a preview', async () => {
        const token = startWorker(1);
        const res = await invoke(token, 'logs', { chars: 200_000 });
        expect(res).toMatchObject({ success: true, output: { truncated: true, artifactId: expect.stringMatching(/^art_/) }, artifacts: [{ type: 'text' }] });
        const fetched: any = await artifactHandlers.artifact_fetch!(ctx as any, { token, artifactId: res.artifacts[0].artifactId });
        expect(fetched.success).toBe(true);
        expect(String(fetched.content)).toContain('log line 000000');
        expect(String(fetched.content)).toContain('log line 009999');
    });
    it('over 4 MiB: refused with a code, the call still returns a bounded result', async () => {
        const token = startWorker(1);
        const res = await invoke(token, 'logs', { chars: 5_500_000 });
        expect(res, JSON.stringify(res).slice(0, 400)).toMatchObject({ success: true, artifactError: { code: 'artifact_too_large' }, output: { truncated: true } });
        expect(res.artifacts).toBeUndefined();
        expect(JSON.stringify(res).length).toBeLessThan(70_000);
    });
    it('the artifact store can refuse content (secret pattern): artifactError, not a failed call', async () => {
        const token = startWorker(1);
        const res = await invoke(token, 'logs', { chars: 100_000, suffix: '\nAPI_KEY="sk-abcdefghijklmnopqrstuvwxyz0123456789"\n' });
        expect(res).toMatchObject({ success: true, artifactError: { code: 'secret_file_refused' }, output: { truncated: true } });
        expect(res.artifacts).toBeUndefined();
        expect(store.listBySession('session-1')).toEqual([]);
        expect(git('status', '--porcelain', '-uall')).toBe('');
    });
});

describe('owner-resolved staged actions', () => {
    it('registers against the requesting worker identity and relays the ids', async () => {
        const token = startWorker(1);
        const staged = await invoke(token, 'wipe', { data: PNG.toString('base64'), mime: 'image/png' });
        expect(staged).toMatchObject({ code: 'owner_approval_required', stagedId: expect.any(String) });
        const resolved: any = await getDriverService(ctx as any).resolveAction(staged.stagedId, 'apply', 'standalone');
        expect(resolved).toMatchObject({ success: true, artifacts: [{ type: 'image' }] });
        const id = resolved.artifacts[0].artifactId;
        expect(store.getById(id)).toMatchObject({ sessionId: 'session-1', taskId: 'task-1', meshId: MESH, missionId: MISSION, producerRole: 'worker' });
        expect(JSON.stringify(resolved)).not.toContain(PNG.toString('base64'));
        const mail = JSON.stringify(drainWorkerMailboxForTask(MESH, 'task-1'));
        expect(mail).toContain(id);
        expect(git('status', '--porcelain', '-uall')).toBe('');
    });
    it('when the requester workspace is no longer known, the result returns inline with a note and no base64', async () => {
        // A credentialed worker whose task/session this daemon does not hold (remote worker, or long gone).
        const token = mintWorkerTaskToken({ meshId: MESH, taskId: 'task-remote', sessionId: 'session-remote', nodeId: 'node-elsewhere', attemptId: 'a' }).token;
        const staged = await invoke(token, 'wipe', { data: PNG.toString('base64'), mime: 'image/png' });
        const resolved: any = await getDriverService(ctx as any).resolveAction(staged.stagedId, 'apply', 'standalone');
        expect(resolved).toMatchObject({ success: true, artifactError: { code: 'artifact_unavailable' } });
        expect(resolved.artifacts).toBeUndefined();
        expect(resolved.output.content[1]).toMatchObject({ type: 'image', omitted: true, code: 'artifact_unavailable' });
        expect(JSON.stringify(resolved)).not.toContain(PNG.toString('base64'));
    });
});
