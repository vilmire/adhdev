import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAssistantTool } from '../../../mcp-server/src/tools/assistant-tools.js';
import { ASSISTANT_VERB, parseSessionLaunchRecord } from '@adhdev/mesh-shared';
import { assistantLaunchHandlers } from '../../src/commands/high-family/assistant-launch.js';
import { meshCoordinatorLaunchHandlers } from '../../src/commands/high-family/mesh-coordinator-launch.js';
import { getLaunchDefaultsCommandPorts } from '../../src/launch-defaults/ports.js';
import { resolveRoleLaunch, roleLaunchProvenance } from '../../src/launch-defaults/consumer.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests } from '../../src/assistant/assistant-project-ports.js';
import { coordinatorPorts } from '../../src/commands/high-family/assistant.js';
import { ensureCoordinator } from '../../src/assistant/coordinator-lifecycle.js';
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js';
import * as quota from '../../src/quota/refresh.js';
import * as coordinator from '../../src/commands/mesh-coordinator.js';
let dir: string, prior: string | undefined, registry: AssistantRegistry;
const OWNER = { namespace: 'role-test', endpoint: 'unix:/tmp/role-test.sock', managedBy: 'adhdev-cloud', clientId: 'daemon_role_test' };
const provider = (type: string, command = false): any => ({ type, category: 'cli',
    modelLaunchArgs: ['--model', '{{model}}'], thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'],
    meshCoordinator: { supported: true, mcpConfig: command
        ? { mode: 'manual', serverName: 'adhdev-mesh', instructions: 'setup', template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}' }
        : { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
        systemPromptInjection: { mode: 'cli_arg', flag: '--append-system-prompt' } } });
function context(command = false) {
    const providers = [provider('claude-cli'), provider('codex-cli', command)], installed = new Set(providers.map(p => p.type));
    const execute = vi.fn(async (_cmd: string, _args: any) => ({ success: true, sessionId: 'new-session' }));
    const c: any = { deps: { statusInstanceId: 'daemon_mach_here',
        providerLoader: { resolveAlias: (v: string) => v === 'claude' ? 'claude-cli' : v,
            getMeta: (t: string) => providers.find(p => p.type === t), resolve: (t: string) => providers.find(p => p.type === t),
            getAvailableProviderInfos: () => providers.map(p => ({ type: p.type, enabled: true, installed: installed.has(p.type) })) },
        instanceManager: { getInstance: () => undefined }, cliManager: { adapters: new Map(), hostedRestoreState: 'ready',
            deps: { getHostedBindingOwner: () => OWNER, listHostedCliRuntimes: async () => [] } } },
        components: () => ({ instanceManager: { getInstance: () => undefined }, cliManager: { adapters: new Map() } }), execute, inlineMeshCache: new Map() };
    return { c, execute, installed };
}
function save(role: string, selection: any, revision: number) {
    const path = join(dir, 'launch-defaults.json'), document = JSON.parse(readFileSync(path, 'utf8'));
    document.revision = revision; document[role] = { ...selection, revision, setBy: 'owner', setAt: 1 };
    writeFileSync(path, JSON.stringify(document));
}
const mesh = () => ({ id: 'mesh_one', name: 'M', nodes: [{ id: 'node_one', daemonId: 'daemon_mach_here', workspace: dir,
    policy: { providerPriority: ['codex-cli'] } }], policy: {} });
const launched = (execute: ReturnType<typeof vi.fn>) => execute.mock.calls.find(row => row[0] === 'launch_cli')?.[1] as any;
const launch = (role: string, c: any, args = {}) => role === 'assistant'
    ? assistantLaunchHandlers[ASSISTANT_VERB.launch](c, args)
    : meshCoordinatorLaunchHandlers.launch_mesh_coordinator(c, { meshId: 'mesh_one', ...args });
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-launch-defaults-')); prior = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = dir;
    writeFileSync(join(dir, 'launch-defaults.json'), JSON.stringify({ version: 1, revision: 1, history: [] }));
    save('assistant', { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' }, 1);
    save('coordinator', { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'low' }, 1);
    writeFileSync(join(dir, 'meshes.json'), JSON.stringify({ meshes: [mesh()] }));
    registry = new AssistantRegistry({ configDir: dir }); setAssistantRegistryForTests(registry);
    setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => [] }));
    setAssistantProjectPortsForTests(() => ({ selfDaemonId: () => 'daemon_mach_here', listMeshes: () => [], isHostedHere: () => true, relay: {} }) as any);
    vi.spyOn(quota, 'readQuotaCache').mockReturnValue(null);
});
afterEach(() => {
    vi.restoreAllMocks(); setAssistantRegistryForTests(null); setAssistantServicesForTests(null); setAssistantProjectPortsForTests(null);
    if (prior === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
});
describe('real role launch consumers', () => {
    it.each(['assistant', 'coordinator'])('%s uses the saved triple rather than sticky/worker priority', async role => {
        registry.bindSession({ sessionId: 'old', cliType: 'codex-cli', workspace: dir, hostOwner: OWNER, at: 1 });
        const { c, execute } = context(); expect(await launch(role, c)).toMatchObject({ success: true });
        expect(launched(execute)).toMatchObject({ cliType: 'claude-cli', initialModel: role === 'assistant' ? 'opus' : 'sonnet',
            roleLaunch: { documentRevision: 1, applied: { provider: { source: 'stored_default' }, model: { source: 'stored_default' },
                thinkingLevel: { source: 'stored_default' } }, defaultRef: { scope: 'global', revision: 1 } } });
    });
    it.each(['assistant', 'coordinator'])('%s explicit overrides record user provenance despite legacy source claims', async role => {
        const { c, execute } = context();
        expect(await launch(role, c, { cliType: 'codex-cli', ...(role === 'assistant'
            ? { model: 'gpt-custom', thinkingLevel: 'low' } : { initialModel: 'gpt-custom', initialThinkingLevel: 'low', modelSource: 'remembered' }) })).toMatchObject({ success: true });
        expect(launched(execute)).toMatchObject({ cliType: 'codex-cli', initialModel: 'gpt-custom', roleLaunch: {
            applied: { provider: { source: 'user' }, model: { source: 'user' }, thinkingLevel: { source: 'user' } } } });
    });
    it('coordinator cli_command branch uses saved defaults too', async () => {
        const { c, execute } = context(true); save('coordinator', { provider: 'codex-cli', model: 'gpt-custom' }, 2);
        vi.spyOn(coordinator, 'execUnderPty').mockResolvedValue({ exitCode: 0, timedOut: false, output: '', signal: null } as any);
        expect(await launch('coordinator', c)).toMatchObject({ success: true });
        expect(launched(execute)).toMatchObject({ cliType: 'codex-cli', roleLaunch: { documentRevision: 2, applied: { model: { source: 'stored_default' } } } });
    });
    it('host sibling project triple wins; untrusted inline defaults never supply it', async () => {
        writeFileSync(join(dir, 'meshes.json'), JSON.stringify({ meshes: [{ ...mesh(), coordinatorLaunch: { version: 1, revision: 5,
            entry: { provider: 'codex-cli', model: 'gpt-project', revision: 5, setBy: 'owner', setAt: 1 } } }] }));
        const { c, execute } = context();
        expect(await launch('coordinator', c, { inlineMesh: { ...mesh(), coordinatorLaunch: { provider: 'bad-cli' } } })).toMatchObject({ success: true });
        expect(launched(execute)).toMatchObject({ cliType: 'codex-cli', initialModel: 'gpt-project', roleLaunch: {
            applied: { provider: { source: 'project_default' }, model: { source: 'project_default' }, thinkingLevel: { source: 'provider_default' } },
            defaultRef: { scope: 'project', projectId: 'mesh_one', revision: 5 } } });
    });
    it('MCP/assistant coordinator precondition reaches the real consumer with no remembered CLI', async () => {
        const { c, execute } = context();
        const ports = coordinatorPorts({ coordinators: () => [], execute: async (cmd: string, args: any) =>
            cmd === 'launch_mesh_coordinator' ? launch('coordinator', c, args) : { success: true } } as any);
        const reply = await callAssistantTool({ command: async (verb, args) => {
            expect(verb).toBe(ASSISTANT_VERB.projectSend);
            expect(args).toMatchObject({ project: 'mesh_one', assistantSessionId: 'assistant-session' });
            expect(args).not.toHaveProperty('cliType');
            const ensured = await ensureCoordinator('mesh_one', ports);
            return { success: ensured.ok, ...ensured };
        } }, 'project_send', { project: 'mesh_one', message: 'work' }, 'assistant-session');
        expect(JSON.parse(reply.text)).toMatchObject({ success: true, launched: true });
        expect(launched(execute)).toMatchObject({ cliType: 'claude-cli', roleLaunch: { applied: { provider: { source: 'stored_default' } } } });
    });
    it.each(['assistant', 'coordinator'])('%s fails an uninstalled default before effects without substitution', async role => {
        const { c, execute, installed } = context(); installed.delete('claude-cli');
        expect(await launch(role, c)).toMatchObject({ success: false, code: 'launch_default_unavailable', reason: 'provider_not_detected', source: 'stored_default' });
        expect(execute).not.toHaveBeenCalled();
    });
    it.each(['assistant', 'coordinator'])('%s fails a quota-gated default instead of choosing a clear provider', async role => {
        vi.mocked(quota.readQuotaCache).mockReturnValue({ 'claude-cli': { status: 'error', updatedAt: Date.now(),
            metadata: { failureKind: 'quota-exhausted' }, session: null, weekly: null } } as any);
        const { c, execute } = context();
        expect(await launch(role, c)).toMatchObject({ success: false, code: 'launch_default_unavailable', reason: 'provider_quota_gated' });
        expect(execute).not.toHaveBeenCalled();
    });
    it('an existing live assistant is returned without default resolution or replacement', async () => {
        registry.bindSession({ sessionId: 'live', cliType: 'codex-cli', workspace: dir, at: 1 });
        const { c, execute } = context(); c.deps.instanceManager.getInstance = () => ({});
        expect(await launch('assistant', c)).toMatchObject({ launched: false, sessionId: 'live', cliType: 'codex-cli' });
        expect(execute).not.toHaveBeenCalled();
    });
    it('racing launches keep one snapshot each across async work and a defaults update', async () => {
        const { c, execute } = context();
        const ports = getLaunchDefaultsCommandPorts(c), original = ports.validation.getProvider;
        let markSnapshot!: () => void;
        const snapshotReady = new Promise<void>(done => { markSnapshot = done; });
        ports.validation.getProvider = type => { const facts = original(type); markSnapshot(); return facts; };
        const first = launch('coordinator', c); await snapshotReady;
        expect(ports.store.write({ role: 'coordinator', selection: { provider: 'codex-cli', model: 'gpt-new', thinkingLevel: 'low' },
            expectedRevision: 1, by: 'owner', origin: 'owner' }).ok).toBe(true);
        const second = launch('coordinator', c); await Promise.all([first, second]);
        expect(execute.mock.calls.filter(row => row[0] === 'launch_cli').map(row => row[1].roleLaunch)).toEqual(expect.arrayContaining([
            expect.objectContaining({ documentRevision: 1, selection: { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'low' } }),
            expect.objectContaining({ documentRevision: 2, selection: { provider: 'codex-cli', model: 'gpt-new', thinkingLevel: 'low' } }),
        ]));
    });
    it('concurrent assistant starts join one launch and never replace the newly bound session', async () => {
        const { c, execute } = context();
        const [a, b] = await Promise.all([launch('assistant', c), launch('assistant', c, { cliType: 'codex-cli' })]);
        expect(a).toMatchObject({ success: true, launched: true });
        expect(b).toMatchObject({ success: true, launched: false, sessionId: 'new-session' });
        expect(execute.mock.calls.filter(row => row[0] === 'launch_cli')).toHaveLength(1);
        expect(registry.read()?.cliType).toBe('claude-cli');
    });
    it('the existing writer lock prevents an update midway through selection validation', () => {
        const { c } = context(), ports = getLaunchDefaultsCommandPorts(c), get = ports.validation.getProvider, writes: any[] = [];
        ports.validation.getProvider = type => { writes.push(ports.store.write({ role: 'assistant', selection: null,
            expectedRevision: 1, by: 'owner', origin: 'owner' })); return get(type); };
        expect(resolveRoleLaunch(c, 'assistant', {})).toMatchObject({ ok: true, documentRevision: 1 });
        expect(writes).toEqual([expect.objectContaining({ ok: false, code: 'store_busy' })]);
    });
    it('session records round-trip the role axes and references through the shared wire parser', () => {
        const { c } = context(), resolved = resolveRoleLaunch(c, 'assistant', {});
        if (!resolved.ok) throw new Error(resolved.reason);
        const record = buildSessionLaunchRecord({ sessionId: 's', providerType: resolved.selection.provider, launchedBy: 'assistant', launchedAt: 1,
            ...roleLaunchProvenance('assistant', resolved), model: { requested: 'opus', declaredSource: 'stored_default' }, thinkingLevel: {} });
        expect(parseSessionLaunchRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    });
});
