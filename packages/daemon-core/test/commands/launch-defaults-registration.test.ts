import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as meshFs from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonCommandRouter, getDaemonCommandRegistry, type CommandRouterDeps } from '../../src/commands/router.js';
import { ProviderRegistry } from '../../src/providers/provider-registry.js';
import type { ProviderLoader } from '../../src/providers/provider-loader.js';
import type { ProviderModule } from '../../src/providers/contracts.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { saveMeshConfigDurable, withStrictMeshConfigWriteLock } from '../../src/config/mesh-config-store.js';
import { getLaunchDefaultsCommandPorts } from '../../src/launch-defaults/ports.js';
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js';
import { isLaunchDefaultRole } from '../../../mesh-shared/src/index.js';

// Fault injection only at the physical host persistence boundary. Registry,
// router, host/authority adapters, provider planners and defaults core are real.
vi.mock('fs', async original => {
    const actual = await original<typeof import('fs')>();
    return { ...actual, mkdirSync: vi.fn(actual.mkdirSync),
        fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
const native = await vi.importActual<typeof import('fs')>('fs');
const SELF = 'daemon_mach_launch_defaults_self';
class FixtureProviders extends ProviderRegistry {
    enabled = true;
    detected = true;
    constructor() {
        super();
        for (const type of ['claude-cli', 'codex-cli']) {
            const provider: ProviderModule = { type, name: type, category: 'cli', aliases: [type.split('-')[0]],
                modelLaunchArgs: ['--model', '{{model}}'], modelOptions: ['opus', 'gpt'],
                thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'],
                meshCoordinator: { supported: true,
                    mcpConfig: { mode: 'auto_import', path: '.mcp.json', format: 'claude_mcp_json', serverName: 'adhdev-mesh' },
                    systemPromptInjection: { mode: 'cli_arg', flag: '--append-system-prompt' } },
            };
            this.providers.set(type, provider);
        }
        this.providers.set('codex', { type: 'codex', name: 'Extension', category: 'extension' });
    }
    protected log(_message: string) {}
    protected readConfig() {
        return { machineProviders: Object.fromEntries(['claude-cli', 'codex-cli'].map(type =>
            [type, { enabled: this.enabled, lastDetection: { ok: this.detected, path: '/fixture/cli', at: 1 } }])) };
    }
}
let dir: string;
let previousConfigDir: string | undefined;
let router: DaemonCommandRouter;
let deps: CommandRouterDeps;
let providers: FixtureProviders;
let services: ReturnType<typeof createAssistantServices>;
let assistant: AssistantRegistry;
let live: Map<string, { type: string }>;
let events: unknown[];
const globalPath = () => join(dir, 'launch-defaults.json');
const meshPath = () => join(dir, 'meshes.json');
const globalBytes = () => fs.readFileSync(globalPath());
const meshBytes = () => fs.readFileSync(meshPath());
function meshes() { return JSON.parse(fs.readFileSync(meshPath(), 'utf8')); }
function writeHost() {
    fs.writeFileSync(meshPath(), JSON.stringify({ extraRoot: { preserved: true }, meshes: [{
        id: 'host-project', name: 'Host', repoIdentity: 'github.com/test/host', defaultBranch: 'main',
        policyStorage: 2, policy: { requireApprovalForPush: true },
        coordinator: { providerType: 'codex-cli', systemPromptAppend: 'Original' },
        meshHost: { role: 'host', hostDaemonId: SELF },
        nodes: [{ id: 'node_self', daemonId: SELF, workspace: join(dir, 'repo'),
            policy: { slots: [{ provider: 'codex-cli', model: 'gpt' }] } }],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }] }));
}
const projectArgs = (patch: Record<string, unknown> = {}) => ({ action: 'set', role: 'coordinator',
    project: 'host-project', provider: 'codex-cli', expectedRevision: 0, ...patch });
const ownerSet = (patch: Record<string, unknown> = {}) => router.execute('launch_defaults_set', {
    action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0, ...patch,
}, 'p2p');
beforeEach(async () => {
    await resetMeshRuntimeStore();
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    dir = fs.mkdtempSync(join(tmpdir(), 'launch-defaults-registration-'));
    process.env.ADHDEV_CONFIG_DIR = dir;
    vi.mocked(meshFs.mkdirSync).mockImplementation(native.mkdirSync);
    vi.mocked(meshFs.fsyncSync).mockImplementation(native.fsyncSync);
    vi.mocked(meshFs.renameSync).mockImplementation(native.renameSync);
    providers = new FixtureProviders();
    services = createAssistantServices({ configDir: dir });
    setAssistantServicesForTests(services);
    assistant = new AssistantRegistry({ configDir: dir });
    setAssistantRegistryForTests(assistant);
    live = new Map();
    events = [];
    deps = {
        commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn(async () => ({ success: false, error: 'unknown' })) },
        cliManager: {}, cdpManagers: new Map(), providerLoader: providers as unknown as ProviderLoader,
        instanceManager: { getInstance: (id: string) => live.get(id), listInstanceIds: () => [], collectAllStates: () => [] },
        detectedIdes: { value: [] }, sessionRegistry: {}, statusInstanceId: SELF,
        bus: { emit: (event: unknown) => events.push(event), on: () => () => {} },
    } as unknown as CommandRouterDeps;
    router = new DaemonCommandRouter(deps);
});
afterEach(async () => {
    router?.meshNodeStatePusher.stop();
    router?.localMeshNodeGitWatch.stop();
    setAssistantServicesForTests(null);
    setAssistantRegistryForTests(null);
    vi.restoreAllMocks();
    await cleanupTempDir(dir);
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
});

describe('actual command registration and source authorization', () => {
    it('exports the shared contract and registers all four high-family verbs', () => {
        expect(isLaunchDefaultRole('coordinator')).toBe(true);
        for (const verb of ['launch_defaults_get', 'launch_defaults_set', 'assistant_launch_defaults', 'assistant_launch_defaults_set']) {
            expect(getDaemonCommandRegistry().get(verb)).toMatchObject({ name: verb, family: 'high', stripTransportMetadata: true });
        }
        expect(getDaemonCommandRegistry().get('launch_defaults_get')?.meshSender).toBe('authenticated_peer');
    });
    it('routes explicit owner setup into the real store and reads applied provenance', async () => {
        expect(await router.execute('launch_defaults_get', {}, 'p2p')).toMatchObject({ success: true, documentRevision: 0, roles: {
            assistant: { stored: null, effective: { ok: false, code: 'launch_default_required' } },
            coordinator: { stored: null, effective: { ok: false, code: 'launch_default_required' } } } });
        expect(fs.existsSync(globalPath())).toBe(false);
        expect(await ownerSet({ model: 'opus', thinkingLevel: 'high' })).toMatchObject({ success: true, result: 'applied', revision: 1, durable: true });
        const before = globalBytes();
        expect(await router.execute('launch_defaults_get', { role: 'assistant' }, 'p2p')).toMatchObject({ success: true, roles: { assistant: {
            effective: { selection: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' },
                applied: { provider: { source: 'stored_default', defaultRef: { scope: 'global', revision: 1 } } } },
        } } });
        expect(globalBytes()).toEqual(before);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'command_executed', command: 'launch_defaults_set', success: true,
            invalidates: new Set(['daemon.metadata']) }));
    });
    it.each(['ipc', 'mesh', 'internal', 'ext', 'api'] as const)('rejects owner writes from %s before touching defaults', async source => {
        expect(await router.execute('launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli',
            expectedRevision: 0, _commandSource: 'p2p' }, source)).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        expect(fs.existsSync(globalPath())).toBe(false);
    });
    it.each(['p2p', 'ws', 'mesh', 'internal'] as const)('rejects assistant writes from %s', async source => {
        expect(await router.execute('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 }, source))
            .toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        expect(fs.existsSync(globalPath())).toBe(false);
    });
    it('authorizes mesh readers before stripping transport metadata', async () => {
        expect(await router.execute('launch_defaults_get', {}, 'mesh')).toMatchObject({ code: 'mesh_sender_unknown' });
        expect(await router.execute('launch_defaults_get', { _meshSenderDaemonId: 'daemon_mach_authenticated_peer' }, 'mesh'))
            .toMatchObject({ success: true, documentRevision: 0 });
    });
    it('strips reserved router metadata, never domain authority or inline configuration', async () => {
        expect(await ownerSet({ _interactionId: 'trace-1' })).toMatchObject({ result: 'applied' });
        const before = globalBytes();
        expect(await ownerSet({ expectedRevision: 1, origin: 'owner' })).toMatchObject({ code: 'invalid_args' });
        expect(await ownerSet({ expectedRevision: 1, inlineMesh: { coordinatorLaunch: { provider: 'codex-cli' } } }))
            .toMatchObject({ code: 'invalid_args' });
        expect(globalBytes()).toEqual(before);
    });
    it('shares the same daemon store instance and performs real document CAS including clears', async () => {
        expect(getLaunchDefaultsCommandPorts({ deps })).toBe(getLaunchDefaultsCommandPorts({ deps }));
        await ownerSet();
        expect(await ownerSet()).toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
        expect(await router.execute('launch_defaults_set', { action: 'clear', role: 'assistant', expectedRevision: 1 }, 'ws'))
            .toMatchObject({ result: 'applied', entry: null, revision: 2 });
        const before = globalBytes();
        expect(await ownerSet({ expectedRevision: 1 })).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(await router.execute('launch_defaults_get', { role: 'assistant' }, 'standalone'))
            .toMatchObject({ success: true, roles: { assistant: { stored: null, effective: { ok: false, code: 'launch_default_required' } } } });
        expect(globalBytes()).toEqual(before);
    });
    it('scopes provider aliases to CLI and computes machine availability without probing/writing config', async () => {
        expect(await ownerSet({ provider: 'codex' })).toMatchObject({ result: 'applied', entry: { provider: 'codex-cli' } });
        providers.enabled = false;
        const before = globalBytes();
        expect(await router.execute('launch_defaults_get', { role: 'assistant' }, 'ipc')).toMatchObject({ success: true, roles: { assistant: {
            stored: { provider: 'codex-cli' }, effective: { ok: false, code: 'launch_default_unavailable', reason: 'provider_disabled' } } } });
        providers.enabled = true; providers.detected = false;
        expect(await ownerSet({ expectedRevision: 1 })).toMatchObject({ code: 'launch_default_invalid', reason: 'provider_not_detected' });
        expect(globalBytes()).toEqual(before);
        expect(fs.existsSync(join(dir, 'config.json'))).toBe(false);
    });
});

describe('actual assistant authority with no fake Inbox', () => {
    it('uses the real delivered human input log to apply an assistant write', async () => {
        services.inputLog.append('human-session', 'human');
        expect(await router.execute('assistant_launch_defaults_set', { action: 'set', role: 'coordinator', provider: 'codex-cli',
            expectedRevision: 0, assistantSessionId: 'human-session' }, 'ipc')).toMatchObject({ result: 'applied', entry: { setBy: 'assistant' } });
        expect(JSON.parse(globalBytes().toString()).history[0]).toMatchObject({ by: 'assistant', origin: 'human' });
    });
    it.each(['unlogged', 'relayed'])('stages %s writes in the real Inbox until durable owner setup', async mode => {
        if (mode === 'relayed') services.inputLog.append('session', 'relay');
        const staged = await router.execute('assistant_launch_defaults_set', { action: 'set', role: 'coordinator', provider: 'codex-cli',
            expectedRevision: 0, assistantSessionId: 'session' }, 'standalone');
        expect(staged).toMatchObject({ success: true, result: 'staged', role: 'coordinator', expectedRevision: 0,
            previous: null, selection: { provider: 'codex-cli' } });
        const id = staged.stagedId as string;
        const proposal = services.launchDefaults!.read(id);
        expect(proposal).toEqual({ version: 1, id, generation: expect.any(String), createdAt: expect.any(String),
            kind: 'launch_defaults', role: 'coordinator', selection: { provider: 'codex-cli' }, previous: null,
            expectedRevision: 0, documentRevision: 0, origin: 'relay', callerSessionId: 'session' });
        expect(JSON.parse(fs.readFileSync(join(dir, 'assistant', 'staged', `${id}.json`), 'utf8'))).toEqual(proposal);
        expect(await router.execute('assistant_staged_resolve', { action: 'list' }, 'p2p'))
            .toMatchObject({ success: true, launchDefaults: [proposal] });
        expect(fs.existsSync(globalPath())).toBe(false);
        expect(await router.execute('assistant_staged_resolve', { id, decision: 'apply' }, 'p2p'))
            .toMatchObject({ success: true, result: 'applied', durable: true, revision: 1,
                entry: { provider: 'codex-cli', revision: 1, setBy: 'owner' } });
        expect(services.launchDefaults!.read(id)).toBeNull();
        expect(JSON.parse(globalBytes().toString()).history[0]).toMatchObject({ by: 'owner', origin: 'owner', role: 'coordinator' });
        expect(await router.execute('launch_defaults_get', { role: 'coordinator' }, 'p2p'))
            .toMatchObject({ success: true, documentRevision: 1, roles: { coordinator: { effective: {
                selection: { provider: 'codex-cli' }, documentRevision: 1,
                applied: { provider: { source: 'stored_default', defaultRef: { role: 'coordinator', scope: 'global', revision: 1 } } },
            } } } });
    });
    it('denies actual review turns for both assistant verbs', async () => {
        services.inputLog.append('review-session', 'review');
        expect(await router.execute('assistant_launch_defaults', { assistantSessionId: 'review-session' }, 'ipc'))
            .toMatchObject({ code: 'review_turn_tool_denied' });
        expect(await router.execute('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli',
            expectedRevision: 0, assistantSessionId: 'review-session' }, 'ipc')).toMatchObject({ code: 'review_turn_tool_denied' });
        expect(fs.existsSync(globalPath())).toBe(false);
    });
    it('uses the exact live assistant type for tool-lock downgrade protection, never sticky provider history', async () => {
        assistant.bindSession({ sessionId: 'active', cliType: 'codex-cli', workspace: dir, at: 1 });
        live.set('active', { type: 'claude-cli' });
        services.inputLog.append('human-session', 'human');
        const staged = await router.execute('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'codex-cli',
            expectedRevision: 0, assistantSessionId: 'human-session' }, 'ipc');
        expect(staged).toMatchObject({ success: true, result: 'staged', role: 'assistant', expectedRevision: 0,
            previous: null, selection: { provider: 'codex-cli' } });
        const id = staged.stagedId as string;
        const proposal = services.launchDefaults!.read(id);
        expect(proposal).toMatchObject({ id, kind: 'launch_defaults', role: 'assistant', origin: 'human', callerSessionId: 'human-session',
            selection: { provider: 'codex-cli' }, previous: null, expectedRevision: 0, documentRevision: 0 });
        expect(await router.execute('assistant_staged_resolve', { action: 'list' }, 'p2p'))
            .toMatchObject({ success: true, launchDefaults: [proposal] });
        expect(fs.existsSync(globalPath())).toBe(false);
        expect(await ownerSet({ provider: 'codex-cli' })).toMatchObject({ result: 'applied' });
        const before = globalBytes();
        expect(await router.execute('assistant_staged_resolve', { id, decision: 'apply' }, 'p2p'))
            .toMatchObject({ success: false, code: 'revision_conflict', actualRevision: 1, committed: false });
        expect(services.launchDefaults!.read(id)).toEqual(proposal);
        expect(globalBytes()).toEqual(before);
        expect(live.get('active')).toEqual({ type: 'claude-cli' });
    });
    it('fails loudly if the active assistant restriction cannot be verified', async () => {
        assistant.bindSession({ sessionId: 'active', cliType: 'claude-cli', workspace: dir, at: 1 });
        live.set('active', { type: 'missing-provider' });
        services.inputLog.append('human-session', 'human');
        expect(await router.execute('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'codex-cli',
            expectedRevision: 0, assistantSessionId: 'human-session' }, 'ipc'))
            .toMatchObject({ code: 'launch_default_unavailable', reason: 'catalog_unavailable' });
        expect(fs.existsSync(globalPath())).toBe(false);
    });
});

describe('real host project persistence and strict CAS', () => {
    beforeEach(async () => {
        writeHost();
        expect(await ownerSet({ role: 'coordinator', model: 'opus', thinkingLevel: 'high' })).toMatchObject({ result: 'applied' });
    });
    it('writes only the host sibling override, with whole-triple provenance and no global change', async () => {
        const before = meshes();
        const globalBefore = globalBytes();
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p'))
            .toMatchObject({ result: 'applied', scope: 'project', revision: 1, durable: true });
        const after = meshes();
        expect(after.meshes[0].coordinatorLaunch).toEqual({ version: 1, revision: 1, entry: {
            provider: 'codex-cli', revision: 1, setBy: 'owner', setAt: expect.any(Number),
        } });
        delete after.meshes[0].coordinatorLaunch;
        expect(after).toEqual(before);
        expect(globalBytes()).toEqual(globalBefore);
        if (process.platform !== 'win32') expect(fs.statSync(meshPath()).mode & 0o777).toBe(0o600);
        const hostBeforeRead = meshBytes();
        expect(await router.execute('launch_defaults_get', { role: 'coordinator', project: 'host-project' }, 'p2p'))
            .toMatchObject({ roles: { coordinator: { effective: { selection: { provider: 'codex-cli' }, applied: {
                provider: { source: 'project_default', defaultRef: { projectId: 'host-project', revision: 1 } },
                model: { value: null, source: 'provider_default' }, thinkingLevel: { value: null, source: 'provider_default' },
            } } } } });
        expect(meshBytes()).toEqual(hostBeforeRead);
    });
    it('retains project revision on clear and refuses stale edits', async () => {
        await router.execute('launch_defaults_set', projectArgs(), 'p2p');
        expect(await router.execute('launch_defaults_set', { action: 'clear', role: 'coordinator', project: 'host-project', expectedRevision: 1 }, 'p2p'))
            .toMatchObject({ result: 'applied', entry: null, revision: 2 });
        expect(meshes().meshes[0].coordinatorLaunch).toEqual({ version: 1, revision: 2, entry: null });
        expect(await router.execute('launch_defaults_set', projectArgs({ expectedRevision: 1 }), 'p2p'))
            .toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(await router.execute('launch_defaults_get', { role: 'coordinator', project: 'host-project' }, 'p2p'))
            .toMatchObject({ roles: { coordinator: { effective: { selection: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' } } } } });
    });
    it.each(['fresh', 'abandoned'])('fails closed on a %s shared lock, preserving all evidence', async kind => {
        const lock = `${meshPath()}.lock`;
        fs.mkdirSync(lock);
        if (kind === 'abandoned') fs.utimesSync(lock, new Date(0), new Date(0));
        const before = meshBytes();
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ code: 'store_busy', committed: false,
            reason: `write_lock_held: ${lock}` });
        expect(meshBytes()).toEqual(before);
        expect(fs.existsSync(lock)).toBe(true);
        fs.rmdirSync(lock);
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ result: 'applied' });
    });
    it('waits briefly for a shared lock that another mesh writer releases', async () => {
        let contended = 0;
        vi.mocked(meshFs.mkdirSync).mockImplementation((...args) => {
            if (String(args[0]) === `${meshPath()}.lock` && contended < 2) {
                contended++;
                throw Object.assign(new Error('EEXIST: lock held'), { code: 'EEXIST' });
            }
            return native.mkdirSync(...args);
        });
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ result: 'applied', revision: 1 });
        expect(contended).toBe(2);
        expect(fs.existsSync(`${meshPath()}.lock`)).toBe(false);
    });
    it('rereads the CAS token after acquiring the actual host lock', async () => {
        let advanced = false;
        vi.mocked(meshFs.mkdirSync).mockImplementation((...args) => {
            if (!advanced && String(args[0]) === `${meshPath()}.lock`) {
                advanced = true;
                const changed = meshes();
                changed.meshes[0].coordinatorLaunch = { version: 1, revision: 1, entry: null };
                fs.writeFileSync(meshPath(), JSON.stringify(changed));
            }
            return native.mkdirSync(...args);
        });
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
        expect(meshes().meshes[0].coordinatorLaunch).toEqual({ version: 1, revision: 1, entry: null });
    });
    it('refuses a failed lock acquisition without executing an unlocked replacement', async () => {
        vi.mocked(meshFs.mkdirSync).mockImplementation((...args) => {
            if (String(args[0]) === `${meshPath()}.lock`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return native.mkdirSync(...args);
        });
        const before = meshBytes();
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p'))
            .toMatchObject({ code: 'project_storage_unavailable', committed: false });
        expect(meshBytes()).toEqual(before);
    });
    it('revalidates machine availability inside the actual host lock', async () => {
        vi.mocked(meshFs.mkdirSync).mockImplementation((...args) => {
            if (String(args[0]) === `${meshPath()}.lock`) providers.enabled = false;
            return native.mkdirSync(...args);
        });
        const before = meshBytes();
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p'))
            .toMatchObject({ code: 'launch_default_invalid', reason: 'provider_disabled' });
        expect(meshBytes()).toEqual(before);
    });
    it.each(['member', 'foreign host', 'unknown host'])('refuses %s records without modifying host/global data', async kind => {
        const config = meshes();
        config.meshes[0].meshHost = kind === 'member' ? { role: 'member', hostDaemonId: 'daemon_mach_other' }
            : kind === 'foreign host' ? { role: 'host', hostDaemonId: 'daemon_mach_other' } : { role: 'host', hostNodeId: 'unknown' };
        fs.writeFileSync(meshPath(), JSON.stringify(config));
        const before = meshBytes();
        const globalBefore = globalBytes();
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ code: 'project_not_hosted' });
        expect(meshBytes()).toEqual(before);
        expect(globalBytes()).toEqual(globalBefore);
    });
    it('uses only host disk truth, preserving corruption and ignoring inline/repo defaults', async () => {
        fs.mkdirSync(join(dir, 'repo', '.adhdev'), { recursive: true });
        fs.writeFileSync(join(dir, 'repo', '.adhdev', 'mesh.json'), JSON.stringify({ coordinatorLaunch: { provider: 'unknown-cli' } }));
        router.inlineMeshCache.set('host-project', { ...meshes().meshes[0], coordinatorLaunch: { provider: 'unknown-cli' } });
        expect(await router.execute('launch_defaults_get', { role: 'coordinator', project: 'host-project' }, 'p2p'))
            .toMatchObject({ roles: { coordinator: { effective: { selection: { provider: 'claude-cli', model: 'opus' } } } } });
        fs.writeFileSync(meshPath(), '{corrupt host evidence');
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ code: 'project_storage_unavailable' });
        expect(meshBytes().toString()).toBe('{corrupt host evidence');
    });
    it('does not run unrelated config migrations during a project-default read', async () => {
        const config = meshes();
        config.magiKindPanels = { historical: true };
        config.meshes[0].coordinator.systemPromptOverride = 'Historical value';
        fs.writeFileSync(meshPath(), JSON.stringify(config));
        const before = meshBytes();
        expect(await router.execute('launch_defaults_get', { role: 'coordinator', project: 'host-project' }, 'p2p'))
            .toMatchObject({ success: true });
        expect(meshBytes()).toEqual(before);
    });
    it('rejects malformed host sibling data and ambiguous project names', async () => {
        const config = meshes();
        config.meshes[0].coordinatorLaunch = { provider: 'codex-cli' };
        fs.writeFileSync(meshPath(), JSON.stringify(config));
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ code: 'project_storage_unavailable' });
        delete config.meshes[0].coordinatorLaunch;
        config.meshes.push({ ...config.meshes[0], id: 'another-project' });
        fs.writeFileSync(meshPath(), JSON.stringify(config));
        expect(await router.execute('launch_defaults_set', projectArgs({ project: 'Host' }), 'p2p')).toMatchObject({ code: 'project_ambiguous' });
    });
    it('preserves coordinatorLaunch through the actual update_mesh coordinator replacement', async () => {
        await router.execute('launch_defaults_set', projectArgs(), 'p2p');
        const override = meshes().meshes[0].coordinatorLaunch;
        expect(await router.execute('update_mesh', { meshId: 'host-project', coordinator: { systemPromptAppend: 'Updated' } }, 'p2p'))
            .toMatchObject({ success: true });
        expect(meshes().meshes[0].coordinatorLaunch).toEqual(override);
        expect(meshes().meshes[0].coordinator.systemPromptAppend).toBe('Updated');
    });
    it.each(['fsync', 'rename'])('preserves bytes and CAS on pre-replacement %s failure', async boundary => {
        const before = meshBytes();
        const fail = () => { throw new Error('injected IO failure'); };
        if (boundary === 'fsync') vi.mocked(meshFs.fsyncSync).mockImplementationOnce(fail);
        else vi.mocked(meshFs.renameSync).mockImplementationOnce(fail);
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p'))
            .toMatchObject({ code: 'persistence_failed', reason: 'atomic_replace_failed', committed: false });
        expect(meshBytes()).toEqual(before);
        expect(fs.readdirSync(dir).filter(name => name.includes('.tmp-') || name.endsWith('.lock'))).toEqual([]);
    });
    it('reports committed-but-not-durable replacement and forces re-read before retry', async () => {
        vi.mocked(meshFs.fsyncSync).mockImplementation(fd => {
            if (native.fstatSync(fd).isDirectory()) throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
            native.fsyncSync(fd);
        });
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p'))
            .toMatchObject({ success: false, code: 'persistence_failed', reason: 'durability_unconfirmed', committed: true });
        expect(meshes().meshes[0].coordinatorLaunch.revision).toBe(1);
        expect(await router.execute('launch_defaults_set', projectArgs(), 'p2p')).toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
    });
    it('refuses durable mesh saves outside a strict transaction', () => {
        const before = meshBytes();
        expect(saveMeshConfigDurable(meshes())).toEqual({ ok: false, reason: 'strict_write_lock_required', committed: false });
        expect(meshBytes()).toEqual(before);
        expect(withStrictMeshConfigWriteLock(() => saveMeshConfigDurable(meshes()))).toEqual({ ok: true, durable: true });
    });
});
