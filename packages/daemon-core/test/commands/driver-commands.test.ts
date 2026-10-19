import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { computeDriverTreeDigest } from '../../src/drivers/installed-driver.js';
import type { InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { mintWorkerTaskToken, revokeWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js';
import { drainWorkerMailboxForTask } from '../../src/mesh/worker-mailbox.js';
import { isWorkerMcpDaemonVerb } from '../../src/standalone-mcp-auth.js';
import { parseStagedList } from '../../../web-core/src/components/dashboard/assistant-staged.js';
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js';

let dir: string, packageDir: string, token: string;
let router: DaemonCommandRouter;
let svc: ReturnType<typeof createAssistantServices>;
let manifest: InstalledDriverManifest;
let policy: Record<string, { actions: string[] }>;
let deps: CommandRouterDeps;
const worker = { meshId: 'driver-mesh', taskId: 'driver-task', sessionId: 'driver-session', attemptId: 'driver-attempt' };
const run = (verb: string, args: Record<string, unknown> = {}, source = 'ipc') => router.execute(verb, args, source);
const save = () => { const { _sourceTrust, ...raw } = manifest; writeFileSync(join(packageDir, 'provider.v1.json'), JSON.stringify(raw)); };
beforeEach(async () => {
    await resetMeshRuntimeStore();
    dir = mkdtempSync(join(tmpdir(), 'driver-command-')); vi.stubEnv('ADHDEV_CONFIG_DIR', dir);
    packageDir = join(dir, 'providers', 'driver', 'browser'); mkdirSync(packageDir, { recursive: true });
    manifest = { type: 'browser', name: 'Browser', category: 'driver', providerVersion: '1.0.0', _sourceTrust: 'trusted',
        runtime: { kind: 'mcp-stdio', command: process.execPath,
            args: [fileURLToPath(new URL('../drivers/fixtures/fake-mcp-server.mjs', import.meta.url))], startupTimeoutMs: 2000, idleStopMs: 10_000 },
        actions: [{ id: 'echo', tool: 'echo', risk: 'read' }] };
    save(); svc = createAssistantServices({ configDir: dir }); setAssistantServicesForTests(svc);
    deps = { commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn() }, cliManager: {}, cdpManagers: new Map(),
        providerLoader: { getMeta: (type: string) => type === manifest.type ? manifest : undefined,
            getByCategory: () => [manifest], findProviderDir: (type: string) => type === manifest.type ? packageDir : null },
        instanceManager: { getInstance: () => undefined, listInstanceIds: () => [], collectAllStates: () => [] },
        detectedIdes: { value: [] }, sessionRegistry: {}, statusInstanceId: 'driver-command-test',
        bus: { emit: () => {}, on: () => () => {} } } as unknown as CommandRouterDeps;
    router = new DaemonCommandRouter(deps); policy = { browser: { actions: ['echo', 'erase'] } };
    vi.spyOn(router as any, 'getMeshForCommand').mockImplementation(async () => ({ mesh: { policy: { drivers: policy } }, source: 'local_config', inline: false }));
    token = mintWorkerTaskToken(worker).token;
});
afterEach(async () => {
    await router?.closeDrivers(); router?.meshNodeStatePusher.stop(); router?.localMeshNodeGitWatch.stop();
    revokeWorkerTaskToken(token); drainWorkerMailboxForTask(worker.meshId, worker.taskId);
    setAssistantServicesForTests(null); await cleanupTempDir(dir); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
describe('driver command boundaries', () => {
    it.each(['driver_list', 'driver_describe', 'driver_invoke'])('%s refuses owner/remote/internal sources', async verb => {
        for (const source of ['ws', 'p2p', 'ext', 'api', 'project_attach', 'mesh', 'internal'])
            expect(await run(verb, { type: 'browser', action: 'echo', token, _commandSource: 'ipc' }, source)).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
    });
    it('toggle is owner-only and refuses ipc even with a forged source', async () => {
        expect(await run('driver_set_enabled', { type: 'browser', enabled: true, _commandSource: 'ws' })).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        for (const source of ['ws', 'p2p', 'standalone'])
            expect(await run('driver_set_enabled', { type: 'browser', enabled: false }, source)).toMatchObject({ success: true, state: 'installed' });
    });
    it('checks credentials before the registry and rejects revoked credentials', async () => {
        const spy = vi.spyOn(deps.providerLoader, 'getByCategory');
        expect(await run('driver_invoke', { type: 'browser', sessionId: worker.sessionId, meshId: worker.meshId })).toMatchObject({ code: 'worker_credential_required' });
        expect(spy).not.toHaveBeenCalled(); revokeWorkerTaskToken(token);
        expect(await run('driver_invoke', { token, type: 'browser', action: 'echo' })).toMatchObject({ code: 'worker_credential_required' });
    });
    it.each(['ipc', 'standalone'])('answers driver_list over %s without an instance', async source => {
        expect(await run('driver_list', {}, source)).toMatchObject({ success: true, drivers: [{ type: 'browser', state: 'ready' }] });
        expect(await run('driver_describe', { type: 'browser' }, source)).toMatchObject({ success: true, state: 'ready' });
        expect(svc.driverActivations!.isReady('browser', computeDriverTreeDigest(packageDir))).toBe(true);
    });
    it('admits three worker verbs through standalone authentication without the toggle', () => {
        for (const verb of ['driver_list', 'driver_describe', 'driver_invoke']) expect(isWorkerMcpDaemonVerb(verb)).toBe(true);
        expect(isWorkerMcpDaemonVerb('driver_set_enabled')).toBe(false);
    });
});
describe('real Worker → service → official SDK → stdio', () => {
    it('returns the tool result for an approved low-risk driver and a minted worker credential', async () => {
        expect(await run('driver_invoke', { token, type: 'browser', action: 'echo', args: { text: 'wire-result' } }))
            .toMatchObject({ success: true, status: 'completed', output: { content: [{ type: 'text', text: '{"text":"wire-result"}' }] } });
    });
    it('caller inlineMesh and claimed meshId cannot grant permission', async () => {
        policy = {};
        expect(await run('driver_invoke', { token, type: 'browser', action: 'echo', meshId: 'forged',
            inlineMesh: { policy: { drivers: { browser: { actions: ['echo'] } } } } })).toMatchObject({ code: 'driver_not_allowed_for_mesh' });
    });
    it('contains a real crash and keeps the instance failed without restart', async () => {
        manifest.actions[0].tool = 'crash'; save();
        expect(await run('driver_invoke', { token, type: 'browser', action: 'echo' })).toMatchObject({ code: 'driver_execution_failed' });
        expect(await run('driver_describe', { type: 'browser' })).toMatchObject({ state: 'failed' });
        expect(await run('driver_invoke', { token, type: 'browser', action: 'echo' })).toMatchObject({ code: 'driver_execution_failed' });
    });
    it('owner resolve executes fixed arguments once and deposits the result in the requesting worker mailbox', async () => {
        manifest.actions.push({ id: 'erase', tool: 'echo', risk: 'destructive' }); save();
        svc.driverActivations!.approve(manifest, computeDriverTreeDigest(packageDir));
        const staged = await run('driver_invoke', { token, type: 'browser', action: 'erase', args: { text: 'fixed' } });
        expect(staged).toMatchObject({ code: 'owner_approval_required' }); const id = staged.stagedId;
        expect(readFileSync(join(dir, 'assistant', 'staged', `${id}.json`), 'utf8')).not.toContain(token);
        const inbox = await run('assistant_staged_resolve', { action: 'list' }, 'ws');
        expect(inbox).toMatchObject({ driverActions: [{ id, kind: 'driver_action_request' }] });
        expect(parseStagedList(inbox)).toEqual([expect.objectContaining({ id, kind: 'driver_action_request',
            text: expect.stringContaining('fixed') })]);
        expect(await run('assistant_staged_resolve', { id, decision: 'apply', _commandSource: 'ws' })).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        expect(await run('assistant_staged_resolve', { id, decision: 'apply', args: { text: 'forged' } }, 'ws'))
            .toMatchObject({ success: true, output: { content: [{ text: '{"text":"fixed"}' }] }, delivery: { ok: true } });
        expect(await run('assistant_staged_resolve', { id, decision: 'apply' }, 'ws')).toMatchObject({ code: 'already_resolved' });
        const messages = drainWorkerMailboxForTask(worker.meshId, worker.taskId); expect(messages).toHaveLength(1);
        expect(JSON.parse(messages[0].text)).toMatchObject({ kind: 'driver_action_result', stagedId: id, success: true });
    });
    it('keeps the installed package immutable when a driver child writes into its cwd and resolves package-relative ./bin/... args', async () => {
        const binDir = join(packageDir, 'bin');
        mkdirSync(binDir, { recursive: true });
        copyFileSync(fileURLToPath(new URL('../drivers/fixtures/fake-mcp-server.mjs', import.meta.url)), join(binDir, 'server.mjs'));
        manifest.runtime.args = ['./bin/server.mjs'];
        manifest.actions = [
            { id: 'write-cwd', tool: 'write-cwd', risk: 'read' },
            { id: 'echo', tool: 'echo', risk: 'read' },
        ];
        policy.browser.actions = ['write-cwd', 'echo'];
        save();
        const initialDigest = computeDriverTreeDigest(packageDir);
        svc.driverActivations!.approve(manifest, initialDigest);

        const first = await run('driver_invoke', { token, type: 'browser', action: 'write-cwd', args: { filename: '.playwright-mcp-output.json' } });
        expect(first).toMatchObject({ success: true, status: 'completed' });
        const payload = JSON.parse((first as any).output.content[0].text);
        expect(payload.packageDir).toBe(packageDir);
        expect(realpathSync(payload.cwd)).not.toBe(realpathSync(packageDir));
        expect(realpathSync(payload.cwd)).toBe(realpathSync(payload.stateDir));
        expect(existsSync(join(payload.cwd, '.playwright-mcp-output.json'))).toBe(true);
        expect(existsSync(join(packageDir, '.playwright-mcp-output.json'))).toBe(false);
        expect(computeDriverTreeDigest(packageDir)).toBe(initialDigest);
        expect(svc.driverActivations!.isReady('browser', initialDigest)).toBe(true);
        expect(await run('driver_describe', { type: 'browser' })).toMatchObject({ success: true, state: 'running', treeDigest: initialDigest });
        expect(await run('driver_invoke', { token, type: 'browser', action: 'echo', args: { stillReady: true } }))
            .toMatchObject({ success: true, status: 'completed', output: { content: [{ text: '{"stillReady":true}' }] } });
    });
});

