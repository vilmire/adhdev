import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LaunchDefaultsProposal } from '@adhdev/mesh-shared';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { ProviderRegistry } from '../../src/providers/provider-registry.js';
import type { ProviderLoader } from '../../src/providers/provider-loader.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { AssistantLaunchDefaultStaging } from '../../src/assistant/launch-default-staging.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { getLaunchDefaultsCommandPorts } from '../../src/launch-defaults/ports.js';
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js';

vi.mock('node:fs', async original => {
    const actual = await original<typeof import('node:fs')>();
    return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
const native = await vi.importActual<typeof import('node:fs')>('node:fs');
const SELF = 'daemon_mach_defaults_inbox';
class Providers extends ProviderRegistry {
    detected = true;
    constructor() {
        super();
        for (const type of ['claude-cli', 'codex-cli']) this.providers.set(type, {
            type, name: type, category: 'cli', aliases: [type.split('-')[0]],
            modelLaunchArgs: ['--model', '{{model}}'], modelOptions: ['opus', 'gpt'],
            thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'],
            meshCoordinator: { supported: true,
                mcpConfig: { mode: 'auto_import', path: '.mcp.json', format: 'claude_mcp_json', serverName: 'adhdev-mesh' },
                systemPromptInjection: { mode: 'cli_arg', flag: '--append-system-prompt' } },
        });
    }
    protected log(_message: string) {}
    protected readConfig() {
        return { machineProviders: Object.fromEntries(['claude-cli', 'codex-cli'].map(type =>
            [type, { enabled: true, lastDetection: { ok: this.detected, path: '/fixture/cli', at: 1 } }])) };
    }
}
let dir: string;
let oldConfigDir: string | undefined;
let router: DaemonCommandRouter;
let deps: CommandRouterDeps;
let providers: Providers;
let services: ReturnType<typeof createAssistantServices>;
let registry: AssistantRegistry;
let live: Map<string, { type: string }>;
const bytes = () => fs.readFileSync(join(dir, 'launch-defaults.json'));
const stagedPath = (id: string) => join(dir, 'assistant', 'staged', `${id}.json`);
const inbox = () => services.launchDefaults!;
const list = () => router.execute('assistant_staged_resolve', { action: 'list' }, 'p2p');
const resolve = (id: string, decision = 'apply', extra: Record<string, unknown> = {}) =>
    router.execute('assistant_staged_resolve', { id, decision, ...extra }, 'p2p');
const ownerSet = (patch: Record<string, unknown> = {}) => router.execute('launch_defaults_set', {
    action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0, ...patch,
}, 'p2p');
const toolSet = (patch: Record<string, unknown> = {}) => router.execute('assistant_launch_defaults_set', {
    action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 1, assistantSessionId: 'assistant-1', ...patch,
}, 'ipc');
function proposal(patch: Partial<LaunchDefaultsProposal> = {}): LaunchDefaultsProposal {
    return { kind: 'launch_defaults', role: 'assistant', selection: { provider: 'claude-cli', model: 'opus' },
        previous: null, origin: 'relay', expectedRevision: 1, ...patch };
}
function host() {
    fs.writeFileSync(join(dir, 'meshes.json'), JSON.stringify({ preserved: true, meshes: [{
        id: 'host-project', name: 'Host', repoIdentity: 'github.com/test/host', policyStorage: 2, policy: {},
        coordinator: { providerType: 'claude-cli', systemPromptAppend: 'keep' },
        meshHost: { role: 'host', hostDaemonId: SELF }, nodes: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }] }));
}
beforeEach(async () => {
    await resetMeshRuntimeStore();
    oldConfigDir = process.env.ADHDEV_CONFIG_DIR;
    dir = fs.mkdtempSync(join(tmpdir(), 'launch-defaults-inbox-'));
    process.env.ADHDEV_CONFIG_DIR = dir;
    vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);
    vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
    providers = new Providers();
    services = createAssistantServices({ configDir: dir });
    setAssistantServicesForTests(services);
    registry = new AssistantRegistry({ configDir: dir });
    setAssistantRegistryForTests(registry);
    live = new Map();
    deps = { commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn() }, cliManager: {}, cdpManagers: new Map(),
        providerLoader: providers as unknown as ProviderLoader,
        instanceManager: { getInstance: (id: string) => live.get(id), listInstanceIds: () => [], collectAllStates: () => [] },
        detectedIdes: { value: [] }, sessionRegistry: {}, statusInstanceId: SELF,
        bus: { emit: () => {}, on: () => () => {} },
    } as unknown as CommandRouterDeps;
    router = new DaemonCommandRouter(deps);
    expect(await ownerSet()).toMatchObject({ result: 'applied', durable: true });
});
afterEach(async () => {
    router?.meshNodeStatePusher.stop(); router?.localMeshNodeGitWatch.stop();
    setAssistantServicesForTests(null); setAssistantRegistryForTests(null);
    vi.restoreAllMocks();
    await cleanupTempDir(dir);
    if (oldConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = oldConfigDir;
});

describe('actual persisted launch-default Inbox', () => {
    it('uses the existing Inbox and lists records across service recreation without changing defaults', async () => {
        const before = bytes();
        const id = inbox().write(proposal());
        expect(inbox().dir).toBe(services.notes.dir);
        const recreated = createAssistantServices({ configDir: dir });
        setAssistantServicesForTests(recreated);
        expect(await list()).toMatchObject({ success: true, memory: [], skills: [], notes: [], launchDefaults: [{ id,
            kind: 'launch_defaults', documentRevision: 1, expectedRevision: 1, selection: { model: 'opus' } }] });
        expect(bytes()).toEqual(before);
        if (process.platform !== 'win32') expect(fs.statSync(stagedPath(id)).mode & 0o777).toBe(0o600);
        const write = vi.spyOn(recreated.launchDefaults!, 'write');
        const next = await toolSet({ model: 'opus' });
        expect(next).toMatchObject({ result: 'staged' });
        expect(write).toHaveBeenCalledOnce();
        expect(recreated.launchDefaults!.read(next.stagedId as string)).not.toBeNull();
    });
    it('applies the immutable triple as owner through real store/CAS, removes it durably and refuses replay', async () => {
        const id = (await toolSet({ provider: 'codex-cli', model: 'gpt', thinkingLevel: 'high' })).stagedId as string;
        expect(await resolve(id)).toMatchObject({ success: true, result: 'applied', durable: true, revision: 2,
            previous: { provider: 'claude-cli' }, entry: { provider: 'codex-cli', model: 'gpt', thinkingLevel: 'high', setBy: 'owner' } });
        expect(inbox().list()).toEqual([]);
        expect(fs.existsSync(stagedPath(id))).toBe(false);
        expect(await resolve(id)).toMatchObject({ success: false, code: 'staged_not_found' });
        expect(JSON.parse(bytes().toString()).history.at(-1)).toMatchObject({ by: 'owner', origin: 'owner' });
    });
    it.each(['discard', 'reject'])('rejects with %s without writing defaults', async decision => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string; const before = bytes();
        expect(await resolve(id, decision)).toEqual({ success: true, result: 'discarded' });
        expect(inbox().read(id)).toBeNull(); expect(bytes()).toEqual(before);
    });
    it('applies clear with document CAS and leaves no fallback default', async () => {
        const id = inbox().write(proposal({ selection: null }));
        expect(await resolve(id)).toMatchObject({ result: 'applied', revision: 2, entry: null, durable: true });
        expect(await router.execute('launch_defaults_get', { role: 'assistant' }, 'p2p'))
            .toMatchObject({ code: 'launch_default_required' });
    });
    it('retains the exact proposal on stale document revision including clear ABA', async () => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string;
        await router.execute('launch_defaults_set', { action: 'clear', role: 'coordinator', expectedRevision: 1 }, 'p2p');
        const before = bytes(); const pending = fs.readFileSync(stagedPath(id));
        expect(await resolve(id)).toMatchObject({ code: 'revision_conflict', actualRevision: 2, committed: false });
        expect(bytes()).toEqual(before); expect(fs.readFileSync(stagedPath(id))).toEqual(pending);
    });
    it('revalidates current machine availability and retains an unavailable proposal', async () => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string; const before = bytes(); providers.detected = false;
        expect(await resolve(id)).toMatchObject({ success: false, code: 'launch_default_invalid', reason: 'provider_not_detected' });
        expect(inbox().read(id)).not.toBeNull(); expect(bytes()).toEqual(before);
    });
    it('preserves corrupt default evidence and the proposal', async () => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string; fs.writeFileSync(join(dir, 'launch-defaults.json'), '{corrupt');
        expect(await resolve(id)).toMatchObject({ code: 'launch_default_unavailable' });
        expect(bytes().toString()).toBe('{corrupt'); expect(inbox().read(id)).not.toBeNull();
    });
    it('fails closed when the actual injected service has no Inbox', async () => {
        const id = inbox().write(proposal()); delete services.launchDefaults;
        expect(await resolve(id)).toMatchObject({ code: 'staging_unavailable' });
    });
    it.each(['ipc', 'mesh', 'internal', 'ext', 'api'] as const)('denies owner resolve from %s before any default or proposal changes', async source => {
        const id = inbox().write(proposal()); const before = bytes(); const pending = fs.readFileSync(stagedPath(id));
        expect(await router.execute('assistant_staged_resolve', { id, decision: 'apply' }, source))
            .toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        expect(bytes()).toEqual(before); expect(fs.readFileSync(stagedPath(id))).toEqual(pending);
    });
    it.each(['authorization', 'consent', 'modal', 'expectedModalIdentity', 'generation', 'role', 'project', 'selection', 'origin'])
        ('refuses foreign approval/scope field %s instead of reusing it as Inbox consent', async key => {
            const id = (await toolSet({ model: 'opus' })).stagedId as string; const before = bytes();
            expect(await resolve(id, 'apply', { [key]: 'different-scope-or-generation' })).toMatchObject({ code: 'invalid_args' });
            expect(bytes()).toEqual(before); expect(inbox().read(id)).not.toBeNull();
        });
});

describe('assistant staging authority through registered dispatch', () => {
    it('fails closed when the current service loses Inbox authority after ports are cached', async () => {
        getLaunchDefaultsCommandPorts({ deps });
        delete services.launchDefaults;
        const before = bytes();
        expect(await toolSet()).toMatchObject({ code: 'staging_unavailable' });
        expect(bytes()).toEqual(before);
        expect(fs.existsSync(join(dir, 'assistant', 'staged'))).toBe(false);
    });
    it('stages explicit first setup without creating defaults until durable owner apply', async () => {
        fs.unlinkSync(join(dir, 'launch-defaults.json'));
        const staged = await toolSet({ expectedRevision: 0, model: 'opus' });
        expect(staged).toMatchObject({ success: true, result: 'staged', expectedRevision: 0 });
        expect(inbox().read(staged.stagedId as string)).toMatchObject({ documentRevision: 0, expectedRevision: 0 });
        expect(fs.existsSync(join(dir, 'launch-defaults.json'))).toBe(false);
        expect(await router.execute('launch_defaults_get', { role: 'assistant' }, 'p2p'))
            .toMatchObject({ code: 'launch_default_required' });
        expect(await resolve(staged.stagedId as string)).toMatchObject({ result: 'applied', revision: 1, durable: true });
    });
    it.each(['invalid', 'unreadable', 'missing'] as const)('refuses %s authority at the production staging snapshot', async status => {
        const ports = getLaunchDefaultsCommandPorts({ deps });
        const before = bytes(); const stored = ports.store.read();
        vi.spyOn(ports.store, 'read').mockReturnValueOnce(stored).mockReturnValueOnce({ status, reason: 'snapshot unavailable' });
        expect(await toolSet()).toMatchObject({ success: false, code: 'staging_failed' });
        expect(inbox().list()).toEqual([]); expect(bytes()).toEqual(before);
    });
    it('refuses a global generation change between validation and staging without inventing revision zero', async () => {
        const ports = getLaunchDefaultsCommandPorts({ deps }); const read = ports.store.read.bind(ports.store);
        let reads = 0;
        vi.spyOn(ports.store, 'read').mockImplementation(() => {
            if (++reads === 2) expect(ports.store.write({ role: 'coordinator', selection: null, expectedRevision: 1,
                by: 'owner', origin: 'owner' })).toMatchObject({ ok: true, durable: true });
            return read();
        });
        expect(await toolSet()).toMatchObject({ success: false, code: 'staging_failed' });
        expect(inbox().list()).toEqual([]); expect(JSON.parse(bytes().toString()).revision).toBe(2);
    });
    it.each(['unlogged', 'relay'])('persists actual %s proposal before reporting staged and waits for owner', async origin => {
        if (origin !== 'unlogged') {
            services.inputLog.begin('assistant-1');
            services.inputLog.append('assistant-1', 'human');
            services.inputLog.closeTurn('assistant-1');
            services.inputLog.append('assistant-1', 'relay');
        }
        const before = bytes(); const result = await toolSet({ model: 'opus' });
        expect(result).toMatchObject({ success: true, result: 'staged' });
        const id = result.stagedId as string;
        expect(inbox().read(id)).toMatchObject({ expectedRevision: 1, origin: 'relay', callerSessionId: 'assistant-1' });
        expect(bytes()).toEqual(before);
        expect(await resolve(id)).toMatchObject({ result: 'applied', durable: true });
    });
    it('applies a verified human write without staging', async () => {
        services.inputLog.begin('assistant-1'); services.inputLog.append('assistant-1', 'human');
        expect(await toolSet({ model: 'opus' })).toMatchObject({ result: 'applied', durable: true, entry: { setBy: 'assistant' } });
        expect(inbox().list()).toEqual([]);
    });
    it('always stages a human assistant provider tool-lock downgrade, then owner applies it', async () => {
        services.inputLog.begin('assistant-1'); services.inputLog.append('assistant-1', 'human');
        // The stored enforced provider is enough; no sticky assistant preference is used.
        const result = await toolSet({ provider: 'codex-cli', model: 'gpt' });
        expect(result).toMatchObject({ result: 'staged' });
        expect(inbox().read(result.stagedId as string)).toMatchObject({ origin: 'human', selection: { provider: 'codex-cli' } });
        expect(await resolve(result.stagedId as string)).toMatchObject({ result: 'applied', durable: true });
    });
    it('denies review calls before staging or writes, even with a forged origin', async () => {
        services.inputLog.begin('assistant-1'); services.inputLog.append('assistant-1', 'review');
        const before = bytes();
        expect(await toolSet()).toMatchObject({ code: 'review_turn_tool_denied' });
        expect(await toolSet({ origin: 'owner' })).toMatchObject({ code: 'invalid_args' });
        expect(inbox().list()).toEqual([]); expect(bytes()).toEqual(before);
    });
    it('denies an actual tainted review window instead of applying or staging through the tool', async () => {
        services.inputLog.begin('assistant-1');
        services.inputLog.append('assistant-1', 'relay'); services.inputLog.closeTurn('assistant-1');
        services.inputLog.append('assistant-1', 'review');
        expect(services.inputLog.writeContext('assistant-1').origin).toBe('review_tainted');
        const before = bytes();
        expect(await toolSet()).toMatchObject({ code: 'review_turn_tool_denied' });
        expect(inbox().list()).toEqual([]); expect(bytes()).toEqual(before);
    });
});

describe('host-only project proposal CAS', () => {
    it('applies the host sibling through strict ports and preserves coordinator and extension fields', async () => {
        host();
        const staged = await toolSet({ role: 'coordinator', project: 'host-project', expectedRevision: 0, provider: 'codex-cli' });
        expect(staged).toMatchObject({ result: 'staged' });
        const id = staged.stagedId as string;
        expect(inbox().read(id)).toMatchObject({ project: 'host-project', expectedRevision: 0, documentRevision: 1 });
        expect(await resolve(id)).toMatchObject({ result: 'applied', scope: 'project', projectId: 'host-project', revision: 1, durable: true });
        expect(JSON.parse(fs.readFileSync(join(dir, 'meshes.json'), 'utf8'))).toMatchObject({ preserved: true, meshes: [{
            coordinator: { providerType: 'claude-cli', systemPromptAppend: 'keep' },
            coordinatorLaunch: { version: 1, revision: 1, entry: { provider: 'codex-cli', setBy: 'owner' } },
        }] });
    });
    it('retains stale project proposals after another owner project write', async () => {
        host();
        const id = (await toolSet({ role: 'coordinator', project: 'host-project', expectedRevision: 0 })).stagedId as string;
        await ownerSet({ role: 'coordinator', project: 'host-project', provider: 'codex-cli' });
        const before = fs.readFileSync(join(dir, 'meshes.json'));
        expect(await resolve(id)).toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
        expect(inbox().read(id)).not.toBeNull(); expect(fs.readFileSync(join(dir, 'meshes.json'))).toEqual(before);
    });
    it('rejects changed global setup generation for a project proposal', async () => {
        host();
        const id = (await toolSet({ role: 'coordinator', project: 'host-project', expectedRevision: 0 })).stagedId as string;
        await ownerSet({ expectedRevision: 1, model: 'opus' });
        const before = fs.readFileSync(join(dir, 'meshes.json'));
        expect(await resolve(id)).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(inbox().read(id)).not.toBeNull(); expect(fs.readFileSync(join(dir, 'meshes.json'))).toEqual(before);
    });
    it('refuses changed host ownership at apply time', async () => {
        host();
        const id = inbox().write(proposal({ role: 'coordinator', project: 'host-project', expectedRevision: 0 }), { documentRevision: 1 });
        const config = JSON.parse(fs.readFileSync(join(dir, 'meshes.json'), 'utf8'));
        config.meshes[0].meshHost = { role: 'member', hostDaemonId: 'daemon_mach_other' };
        fs.writeFileSync(join(dir, 'meshes.json'), JSON.stringify(config));
        expect(await resolve(id)).toMatchObject({ code: 'project_not_hosted' });
        expect(inbox().read(id)).not.toBeNull();
    });
    it('applies a host clear retaining its token and refuses a stale proposal after clear', async () => {
        host();
        await ownerSet({ role: 'coordinator', project: 'host-project', provider: 'codex-cli' });
        const stale = inbox().write(proposal({ role: 'coordinator', project: 'host-project', expectedRevision: 1 }), { documentRevision: 1 });
        const clear = inbox().write(proposal({ role: 'coordinator', project: 'host-project', expectedRevision: 1, selection: null }), { documentRevision: 1 });
        expect(await resolve(clear)).toMatchObject({ result: 'applied', revision: 2, entry: null, durable: true });
        expect(JSON.parse(fs.readFileSync(join(dir, 'meshes.json'), 'utf8')).meshes[0].coordinatorLaunch)
            .toEqual({ version: 1, revision: 2, entry: null });
        expect(await resolve(stale)).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(inbox().read(stale)).not.toBeNull();
    });
    it('fails closed on the shared host write lock and retains the proposal', async () => {
        host();
        const id = inbox().write(proposal({ role: 'coordinator', project: 'host-project', expectedRevision: 0 }), { documentRevision: 1 });
        fs.mkdirSync(join(dir, 'meshes.json.lock'));
        const before = fs.readFileSync(join(dir, 'meshes.json'));
        expect(await resolve(id)).toMatchObject({ code: 'store_busy', committed: false });
        expect(fs.readFileSync(join(dir, 'meshes.json'))).toEqual(before);
        expect(inbox().read(id)).not.toBeNull();
    });
});

describe('proposal evidence, generations and persistence failures', () => {
    it.each(['role', 'project', 'selection', 'expectedRevision', 'generation', 'origin'])('refuses altered %s in a persisted proposal', async key => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string; const rec = JSON.parse(fs.readFileSync(stagedPath(id), 'utf8'));
        rec[key] = key === 'selection' ? { provider: 'codex-cli' } : key === 'expectedRevision' ? 2 : 'changed';
        fs.writeFileSync(stagedPath(id), JSON.stringify(rec)); const evidence = fs.readFileSync(stagedPath(id)); const before = bytes();
        expect(inbox().read(id)).toBeNull();
        expect(await resolve(id)).toMatchObject({ code: 'staged_not_found' });
        expect(fs.readFileSync(stagedPath(id))).toEqual(evidence); expect(bytes()).toEqual(before);
    });
    it('does not reuse one proposal generation for identical later proposals or accept path traversal', async () => {
        const first = (await toolSet({ model: 'opus' })).stagedId as string;
        const second = (await toolSet({ model: 'opus' })).stagedId as string;
        expect(first).not.toBe(second); expect(inbox().read('../launch-defaults')).toBeNull();
        expect(await resolve(first)).toMatchObject({ result: 'applied' });
        expect(await resolve(second)).toMatchObject({ code: 'revision_conflict' });
        expect(inbox().read(second)).not.toBeNull();
    });
    it('requires project/global generation binding and strict proposal schema before persistence', () => {
        expect(() => inbox().write(proposal({ role: 'coordinator', project: 'host-project' }))).toThrow('generation');
        expect(() => inbox().write({ ...proposal(), consent: 'owner' } as LaunchDefaultsProposal)).toThrow('Invalid');
        expect(() => inbox().write(proposal({ selection: { provider: '' } }))).toThrow('Invalid');
        expect(inbox().list()).toEqual([]);
    });
    it('serializes simultaneous owner resolutions with exactly one durable application', async () => {
        const id = inbox().write(proposal());
        const results = await Promise.all([resolve(id), resolve(id)]);
        expect(results.filter(r => r.result === 'applied')).toHaveLength(1);
        expect(results.filter(r => r.code === 'staged_busy')).toHaveLength(1);
        expect(JSON.parse(bytes().toString()).revision).toBe(2);
    });
    it('does not report staged success when durable Inbox persistence fails', async () => {
        const before = bytes();
        vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error('rename failed'); });
        expect(await toolSet()).toMatchObject({ success: false, code: 'staging_failed' });
        expect(inbox().list()).toEqual([]); expect(bytes()).toEqual(before);
    });
    it('does not claim staged success after an Inbox rename whose directory fsync fails', async () => {
        const before = bytes(); let renamed = false;
        vi.mocked(fs.renameSync).mockImplementation((...args) => { native.renameSync(...args); renamed = true; });
        vi.mocked(fs.fsyncSync).mockImplementation(fd => {
            if (renamed && native.fstatSync(fd).isDirectory()) throw new Error('directory sync failed');
            native.fsyncSync(fd);
        });
        expect(await toolSet()).toMatchObject({ code: 'staging_failed', success: false });
        // The renamed evidence may exist, but the assistant was never told staged success.
        expect(inbox().list()).toHaveLength(1); expect(bytes()).toEqual(before);
    });
    it('retains proposal and unchanged defaults when default rename fails before commit', async () => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string; const before = bytes();
        vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error('rename failed'); });
        expect(await resolve(id)).toMatchObject({ code: 'persistence_failed', committed: false });
        expect(inbox().read(id)).not.toBeNull(); expect(bytes()).toEqual(before);
    });
    it('never reports applied or deletes a proposal for committed-but-unconfirmed defaults', async () => {
        const id = (await toolSet({ model: 'opus' })).stagedId as string;
        vi.mocked(fs.fsyncSync).mockImplementation(fd => {
            if (native.fstatSync(fd).isDirectory()) throw Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' });
            native.fsyncSync(fd);
        });
        expect(await resolve(id)).toMatchObject({ success: false, code: 'persistence_failed', committed: true });
        expect(inbox().read(id)).not.toBeNull(); expect(JSON.parse(bytes().toString()).revision).toBe(2);
        vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);
        expect(await resolve(id)).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(inbox().read(id)).not.toBeNull();
    });
    it('fails closed for an abandoned proposal lock until operator recovery', async () => {
        const id = inbox().write(proposal()); const before = bytes();
        fs.mkdirSync(join(inbox().dir, `${id}.lock`));
        expect(await resolve(id)).toMatchObject({ code: 'staged_busy' });
        expect(bytes()).toEqual(before); expect(inbox().read(id)).not.toBeNull();
    });
    it('does not confuse other Inbox kinds with launch defaults', () => {
        fs.mkdirSync(inbox().dir, { recursive: true });
        fs.writeFileSync(join(inbox().dir, 'note-other.json'), '{"kind":"note"}');
        expect(new AssistantLaunchDefaultStaging({ configDir: dir }).list()).toEqual([]);
    });
});
