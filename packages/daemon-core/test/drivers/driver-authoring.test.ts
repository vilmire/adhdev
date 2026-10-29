import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { computeDriverTreeDigest } from '../../src/drivers/installed-driver.js';
import { mintWorkerTaskToken, revokeWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
import { drainWorkerMailboxForTask } from '../../src/mesh/worker-mailbox.js';
import { isWorkerMcpDaemonVerb } from '../../src/standalone-mcp-auth.js';
import { decodeDriverBundle, digestDriverFiles, encodeDriverBundle, readDriverPackageDir, verifyDriverFiles } from '../../src/drivers/driver-package.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { __resetTranscriptProjectionForTests, configureTranscriptProjection } from '../../src/seqscribe/transcript-publisher.js';
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const worker = { meshId: 'authoring-mesh', taskId: 'authoring-task', sessionId: 'authoring-session', attemptId: 'authoring-attempt' };

interface Machine { dir: string; ws: string; router: DaemonCommandRouter; token: string; run: (verb: string, args?: Record<string, unknown>, source?: string) => Promise<any>; stop: () => Promise<void> }
async function boot(): Promise<Machine> {
    await resetMeshRuntimeStore();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'driver-authoring-'))); // the loader compares realpaths (macOS /var -> /private/var)
    vi.stubEnv('ADHDEV_CONFIG_DIR', dir);
    const ws = realpathSync(mkdirSync(join(dir, 'workspace'), { recursive: true }) ?? join(dir, 'workspace'));
    const svc = createAssistantServices({ configDir: dir }); setAssistantServicesForTests(svc);
    const loader = new ProviderLoader({ userDir: join(dir, 'providers'), disableUpstream: true, logFn: () => {} });
    loader.loadAll();
    const deps = { commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn() }, cliManager: {}, cdpManagers: new Map(), providerLoader: loader,
        instanceManager: { getInstance: () => undefined, listInstanceIds: () => [], collectAllStates: () => [] },
        detectedIdes: { value: [] }, sessionRegistry: { get: (id: string) => id === worker.sessionId ? { workspace: ws, providerType: 'test' } : undefined },
        statusInstanceId: 'authoring-test', bus: { emit: () => {}, on: () => () => {} } } as unknown as CommandRouterDeps;
    const router = new DaemonCommandRouter(deps);
    vi.spyOn(router as any, 'getMeshForCommand').mockImplementation(async () => ({ mesh: { policy: { drivers: {} } }, source: 'local_config', inline: false }));
    // A live worker assignment, so the real artifact authority (register/fetch) accepts this worker.
    __resetTranscriptProjectionForTests();
    configureTranscriptProjection({ daemonId: () => 'authoring-test', writerId: () => 'w', epoch: 'e', appendChatFrame: async () => {} });
    const now = new Date().toISOString();
    MeshRuntimeStore.getInstance().insertQueueEntry({ id: worker.taskId, meshId: worker.meshId, targetNodeId: 'node-1', status: 'assigned',
        assignedSessionId: worker.sessionId, message: 'authoring', workspace: ws, createdAt: now, updatedAt: now } as any);
    seedMeshAttempt({ meshId: worker.meshId, taskId: worker.taskId, sessionId: worker.sessionId, nodeId: 'node-1', attemptId: worker.attemptId, attemptNo: 0, stage: 'generating' });
    const token = mintWorkerTaskToken({ ...worker, nodeId: 'node-1' }).token;
    return { dir, ws, router, token, run: (verb, args = {}, source = 'ipc') => router.execute(verb, args, source),
        stop: async () => { await router.closeDrivers(); router.meshNodeStatePusher.stop(); router.localMeshNodeGitWatch.stop();
            revokeWorkerTaskToken(token); drainWorkerMailboxForTask(worker.meshId, worker.taskId); setAssistantServicesForTests(null); await cleanupTempDir(dir); } };
}
const scaffoldArgs = (token: string) => ({ token, type: 'fake-tool', name: 'Fake Tool', command: process.execPath, args: ['./bin/server.mjs'],
    actions: [{ id: 'echo', tool: 'echo', risk: 'read' }] });
function addServer(m: Machine, dir = 'drivers/fake-tool') { mkdirSync(join(m.ws, dir, 'bin'), { recursive: true }); copyFileSync(FAKE, join(m.ws, dir, 'bin', 'server.mjs')); }

let machines: Machine[] = [];
afterEach(async () => { for (const m of machines.splice(0)) await m.stop(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const make = async () => { const m = await boot(); machines.push(m); return m; };

describe('author -> install -> staged activation -> owner approve -> invoke', () => {
    it('runs the whole path with the fake MCP server and never self-activates', async () => {
        const m = await make();
        expect(await m.run('driver_scaffold', scaffoldArgs(m.token))).toMatchObject({ success: true, dir: 'drivers/fake-tool', report: { riskClass: 'low' } });
        expect(await m.run('driver_scaffold', scaffoldArgs(m.token))).toMatchObject({ success: false, code: 'already_exists' });
        // The wrapped server is not in the package yet: validate must say so.
        expect(await m.run('driver_validate', { token: m.token, dir: 'drivers/fake-tool' })).toMatchObject({ success: false, code: 'missing_reference' });
        addServer(m);
        const validated = await m.run('driver_validate', { token: m.token, dir: 'drivers/fake-tool' });
        expect(validated).toMatchObject({ success: true, report: { type: 'fake-tool', files: 3 } });

        const installed = await m.run('driver_install', { token: m.token, dir: 'drivers/fake-tool' });
        expect(installed).toMatchObject({ success: true, type: 'fake-tool', replaced: false, state: 'installed', treeDigest: validated.report.treeDigest });
        expect(installed.stagedId).toMatch(/^driver-activation-/);
        const dest = join(m.dir, 'external', 'adhdev-installed', 'driver', 'fake-tool');
        expect(computeDriverTreeDigest(dest)).toBe(validated.report.treeDigest);
        // Hot-loaded without a restart.
        expect(await m.run('driver_list')).toMatchObject({ drivers: [{ type: 'fake-tool', state: 'installed' }] });
        // Not active: the worker cannot invoke it, and a worker/ipc cannot resolve the request.
        expect(await m.run('driver_invoke', { token: m.token, type: 'fake-tool', action: 'echo', args: { text: 'x' } })).toMatchObject({ code: 'driver_not_approved' });
        expect(await m.run('assistant_staged_resolve', { id: installed.stagedId, decision: 'apply' }, 'ipc')).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        expect(JSON.parse(readFileSync(join(m.dir, 'assistant', 'staged', `${installed.stagedId}.json`), 'utf8'))).toMatchObject({ kind: 'driver_activation', trust: expect.not.stringMatching(/^trusted$/) });
        expect(existsSync(join(m.dir, 'drivers', 'activations.json'))).toBe(false);
        // Owner approval, then invoke.
        expect(await m.run('assistant_staged_resolve', { id: installed.stagedId, decision: 'apply' }, 'ws')).toMatchObject({ success: true, result: 'applied' });
        expect(await m.run('driver_invoke', { token: m.token, type: 'fake-tool', action: 'echo', args: { text: 'authored' } }))
            .toMatchObject({ success: true, output: { content: [{ text: '{"text":"authored"}' }] } });
    });

    it('re-install of changed bytes re-stages instead of keeping the old approval', async () => {
        const m = await make();
        await m.run('driver_scaffold', scaffoldArgs(m.token)); addServer(m);
        const first = await m.run('driver_install', { token: m.token, dir: 'drivers/fake-tool' });
        await m.run('assistant_staged_resolve', { id: first.stagedId, decision: 'apply' }, 'ws');
        writeFileSync(join(m.ws, 'drivers/fake-tool/guidance/usage.md'), '# changed\n');
        const second = await m.run('driver_install', { token: m.token, dir: 'drivers/fake-tool' });
        expect(second).toMatchObject({ success: true, replaced: true, state: 'installed' });
        expect(second.treeDigest).not.toBe(first.treeDigest); expect(second.stagedId).not.toBe(first.stagedId);
        expect(await m.run('driver_invoke', { token: m.token, type: 'fake-tool', action: 'echo', args: {} })).toMatchObject({ code: 'driver_not_approved' });
    });
});

describe('export / import round trip and artifact sharing', () => {
    it('exports a bundle, shares it as an artifact, installs it from the artifact, and imports it on another machine', async () => {
        const a = await make();
        await a.run('driver_scaffold', scaffoldArgs(a.token)); addServer(a);
        const exported = await a.run('driver_export', { token: a.token, dir: 'drivers/fake-tool' });
        expect(exported).toMatchObject({ success: true, path: 'driver-bundles/fake-tool.driver-bundle.json' });
        const bundleText = readFileSync(join(a.ws, exported.path), 'utf8');
        expect(JSON.parse(bundleText)).toMatchObject({ format: 'adhdev-driver-bundle', treeDigest: exported.treeDigest });
        // Share through the existing artifact registry, then install from the artifact id.
        const reg = await a.run('artifact_register', { token: a.token, path: exported.path });
        expect(reg.artifactId).toMatch(/^art_/);
        expect(await a.run('driver_install', { token: a.token, artifactId: reg.artifactId })).toMatchObject({ success: true, treeDigest: exported.treeDigest, state: 'installed' });
        await a.stop(); machines = machines.filter(x => x !== a);

        // "Another PC": fresh config dir, owner dashboard import over standalone.
        const b = await make();
        for (const source of ['ipc', 'ws', 'mesh', 'api']) expect(await b.run('driver_import', { bundle: bundleText }, source)).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        const imported = await b.run('driver_import', { bundle: bundleText }, 'standalone');
        expect(imported).toMatchObject({ success: true, type: 'fake-tool', treeDigest: exported.treeDigest, state: 'installed' });
        expect(await b.run('driver_invoke', { token: b.token, type: 'fake-tool', action: 'echo', args: {} })).toMatchObject({ code: 'driver_not_approved' });
        await b.run('assistant_staged_resolve', { id: imported.stagedId, decision: 'apply' }, 'ws');
        expect(await b.run('driver_invoke', { token: b.token, type: 'fake-tool', action: 'echo', args: { text: 'other-pc' } }))
            .toMatchObject({ success: true, output: { content: [{ text: '{"text":"other-pc"}' }] } });
    });

    it('rejects tampered bundles', async () => {
        const m = await make();
        await m.run('driver_scaffold', scaffoldArgs(m.token)); addServer(m);
        const bundle = JSON.parse(readFileSync(join(m.ws, (await m.run('driver_export', { token: m.token, dir: 'drivers/fake-tool' })).path), 'utf8'));
        const send = (b: unknown) => m.run('driver_import', { bundle: JSON.stringify(b) }, 'standalone');
        const swap = (path: string, text: string) => ({ ...bundle, files: bundle.files.map((f: any) => f.path === path ? { ...f, content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) } : f) });
        // Bytes changed, digest left alone.
        expect(await send(swap('bin/server.mjs', 'process.exit(0)'))).toMatchObject({ success: false, code: 'bundle_digest_mismatch' });
        // Declared digest forged.
        expect(await send({ ...bundle, treeDigest: `sha256:${'0'.repeat(64)}` })).toMatchObject({ code: 'bundle_digest_mismatch' });
        // Size lies, path escapes, absolute path, excluded dir, extra key, bad base64.
        expect(await send({ ...bundle, files: bundle.files.map((f: any, i: number) => i ? f : { ...f, size: f.size + 1 }) })).toMatchObject({ code: 'bundle_invalid' });
        for (const path of ['../evil.js', '/etc/passwd', 'a//b', 'node_modules/x.js', '.git/config'])
            expect(await send({ ...bundle, files: [...bundle.files, { path, size: 1, content: 'eA==' }] })).toMatchObject({ code: 'unsafe_path' });
        expect(await send({ ...bundle, extra: 1 })).toMatchObject({ code: 'bundle_invalid' });
        expect(await send({ ...bundle, files: [{ path: 'x', size: 1, content: '***' }] })).toMatchObject({ code: 'bundle_invalid' });
        expect(await m.run('driver_import', { bundle: 'not json' }, 'standalone')).toMatchObject({ code: 'bundle_invalid' });
        // A well-formed bundle whose manifest is not a valid driver manifest.
        const bad = Buffer.from(JSON.stringify({ type: 'fake-tool', category: 'cli' }));
        const files = [{ path: 'provider.v1.json', bytes: bad }];
        const forged = { format: 'adhdev-driver-bundle', version: 1, type: 'fake-tool', name: 'x', providerVersion: '1.0.0', treeDigest: digestDriverFiles('fake-tool', files),
            files: [{ path: 'provider.v1.json', size: bad.length, content: bad.toString('base64') }] };
        expect(await send(forged)).toMatchObject({ code: 'manifest_invalid' });
        // Nothing was installed by any of the above.
        expect(existsSync(join(m.dir, 'external'))).toBe(false);
        // The untouched bundle still installs.
        expect(await send(bundle)).toMatchObject({ success: true });
    });

    it('refuses a type that a trusted (user-layer) provider already owns instead of shadowing it', async () => {
        const m = await make();
        const userDir = join(m.dir, 'providers', 'driver', 'fake-tool'); mkdirSync(userDir, { recursive: true });
        writeFileSync(join(userDir, 'provider.v1.json'), JSON.stringify({ type: 'fake-tool', name: 'Mine', category: 'driver', providerVersion: '1.0.0',
            runtime: { kind: 'mcp-stdio', command: 'node' }, actions: [{ id: 'echo', tool: 'echo', risk: 'read' }] }));
        (m.router as any).deps.providerLoader.loadAll();
        await m.run('driver_scaffold', scaffoldArgs(m.token)); addServer(m);
        expect(await m.run('driver_install', { token: m.token, dir: 'drivers/fake-tool' })).toMatchObject({ success: false, code: 'type_conflict' });
        expect(existsSync(join(m.dir, 'external'))).toBe(false);
    });
});

describe('boundaries', () => {
    it('worker verbs need a worker credential and are admitted as worker MCP verbs; the owner verb is not', async () => {
        const m = await make();
        for (const verb of ['driver_scaffold', 'driver_validate', 'driver_export', 'driver_install']) {
            expect(isWorkerMcpDaemonVerb(verb)).toBe(true);
            expect(await m.run(verb, { dir: 'x' })).toMatchObject({ code: 'worker_credential_required' });
            expect(await m.run(verb, { dir: 'x', token: m.token }, 'p2p')).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        }
        expect(isWorkerMcpDaemonVerb('driver_import')).toBe(false);
    });

    it('confines workspace paths: traversal, absolute paths and symlinks out of the workspace', async () => {
        const m = await make();
        const outside = join(m.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'provider.v1.json'), '{}');
        symlinkSync(outside, join(m.ws, 'link'));
        for (const dir of ['../outside', outside, 'link', 'link/new'])
            expect(await m.run('driver_validate', { token: m.token, dir })).toMatchObject({ success: false, code: expect.stringMatching(/^(path_outside_workspace|invalid_path)$/) });
        expect(await m.run('driver_scaffold', { ...scaffoldArgs(m.token), dir: 'link/new' })).toMatchObject({ code: 'path_outside_workspace' });
        expect(existsSync(join(outside, 'new'))).toBe(false);
        // A symlink INSIDE a package is refused, not followed.
        await m.run('driver_scaffold', scaffoldArgs(m.token)); addServer(m);
        symlinkSync(join(m.dir, 'outside'), join(m.ws, 'drivers/fake-tool/escape'));
        expect(await m.run('driver_export', { token: m.token, dir: 'drivers/fake-tool' })).toMatchObject({ success: false, code: 'symlink_refused' });
        // Export output must be a .json file inside the workspace.
        expect(() => readDriverPackageDir(join(m.ws, 'link'))).toThrow(/invalid_directory/);
    });

    it('validates scaffold input and shows elevated risk for destructive actions', async () => {
        const m = await make();
        expect(await m.run('driver_scaffold', { ...scaffoldArgs(m.token), type: 'Bad Type' })).toMatchObject({ code: 'invalid_arguments' });
        expect(await m.run('driver_scaffold', { ...scaffoldArgs(m.token), actions: [] })).toMatchObject({ code: 'invalid_arguments' });
        expect(await m.run('driver_scaffold', { ...scaffoldArgs(m.token), actions: [{ id: 'Bad Id', tool: 't' }] })).toMatchObject({ code: 'manifest_invalid' });
        const ok = await m.run('driver_scaffold', { ...scaffoldArgs(m.token), actions: [{ id: 'wipe', tool: 'wipe', risk: 'destructive' }, { id: 'any', tool: 'any' }] });
        expect(ok).toMatchObject({ success: true, report: { riskClass: 'elevated', reasons: ['Destructive action: wipe'] } });
        expect(JSON.parse(readFileSync(join(m.ws, 'drivers/fake-tool/provider.v1.json'), 'utf8')).actions[1].risk).toBe('write');
    });

    it('enforces size limits and the digest equals the activation digest', async () => {
        const m = await make();
        await m.run('driver_scaffold', scaffoldArgs(m.token)); addServer(m);
        writeFileSync(join(m.ws, 'drivers/fake-tool/big.bin'), Buffer.alloc(1024 * 1024 + 1));
        expect(await m.run('driver_validate', { token: m.token, dir: 'drivers/fake-tool' })).toMatchObject({ code: 'file_too_large' });
        writeFileSync(join(m.ws, 'drivers/fake-tool/big.bin'), Buffer.alloc(1024 * 1024));
        writeFileSync(join(m.ws, 'drivers/fake-tool/big2.bin'), Buffer.alloc(1024 * 1024));
        writeFileSync(join(m.ws, 'drivers/fake-tool/big3.bin'), Buffer.alloc(1024 * 1024));
        expect(await m.run('driver_validate', { token: m.token, dir: 'drivers/fake-tool' })).toMatchObject({ code: 'package_too_large' });
        const pkg = verifyDriverFiles([{ path: 'provider.v1.json', bytes: Buffer.from(JSON.stringify({ type: 'a-b', name: 'n', category: 'driver', providerVersion: '1.0.0',
            runtime: { kind: 'mcp-stdio', command: 'x' }, actions: [{ id: 'a', tool: 't', risk: 'read' }] })) }]);
        expect(decodeDriverBundle(encodeDriverBundle(pkg)).report.treeDigest).toBe(pkg.report.treeDigest);
    });
});
