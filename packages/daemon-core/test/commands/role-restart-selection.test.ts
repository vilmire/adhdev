import { chmodSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { cliAgentHandlers } from '../../src/commands/med-family/cli-agent.js';
import { sessionHostHandlers } from '../../src/commands/low-family/session-host.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { resolveRoleLaunch, roleLaunchProvenance } from '../../src/launch-defaults/consumer.js';
import { validateLaunchDefault } from '../../src/launch-defaults/validate.js';
import { createLaunchValidationPorts } from '../../src/launch-defaults/ports.js';
import * as cliDetector from '../../src/detection/cli-detector.js';
import type { PtySpawnOptions } from '../../src/cli-adapters/pty-transport.js';

let dir: string, prior: string | undefined, loader: FixtureLoader, manager: DaemonCliManager;
let registry: SessionRegistry, instances: ProviderInstanceManager;
let spawns: { args: string[]; options: PtySpawnOptions }[];
class FixtureLoader extends ProviderLoader {
    enabled = true;
    constructor(root: string, private config: any) { super({ userDir: root, disableUpstream: true }); }
    protected override readConfig() { return this.config; }
    protected override writeConfig(config: any) { this.config = config; }
    override isMachineProviderEnabled() { return this.enabled; }
}
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-restart-')); prior = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = dir;
    const executable = join(dir, 'fixture-cli'); writeFileSync(executable, '#!/bin/sh\necho 1.4.0\n'); chmodSync(executable, 0o755);
    const providerDir = join(dir, 'cli', 'claude-cli'); mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, 'provider.json'), JSON.stringify({ type: 'claude-cli', name: 'fixture', category: 'cli',
        spawn: { command: executable }, modelLaunchArgs: ['--model', '{{model}}'], modelOptions: ['opus'],
        thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['high'],
        resume: { supported: true, newSessionArgs: ['--session-id', '{{sessionId}}'], resumeSessionArgs: ['--resume', '{{sessionId}}'], sessionIdFormat: 'uuid' },
        meshCoordinator: { supported: true, mcpConfig: { mode: 'auto_import', path: '.mcp.json', format: 'claude_mcp_json' } } }));
    writeFileSync(join(providerDir, 'spec.json'), JSON.stringify({ $schema: 'adhdev:cli/spec@4', id: 'claude-cli', name: 'fixture', binary: executable,
        send_message: { submit_key: '\r' }, sections: {}, states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }], transitions: [] }));
    loader = new FixtureLoader(dir, { machineProviders: { 'claude-cli': { enabled: true, executable,
        lastDetection: { ok: true, path: executable } } } }); loader.loadAll();
    registry = new SessionRegistry(); instances = new ProviderInstanceManager(); spawns = [];
    manager = new DaemonCliManager({ getP2p: () => null, getInstanceManager: () => instances, getSessionRegistry: () => registry,
        createPtyTransportFactory: () => ({ spawn: (_command, args, options) => {
            spawns.push({ args, options });
            return { pid: 123, ready: Promise.resolve(), write: () => {}, resize: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} };
        } }) }, loader);
});
afterEach(async () => {
    for (const key of [...manager.adapters.keys()]) await manager.stopSession(key);
    vi.restoreAllMocks(); if (prior === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
});
async function startRole(role: 'assistant' | 'coordinator') {
    writeFileSync(join(dir, 'launch-defaults.json'), JSON.stringify({ version: 1, revision: 1, history: [],
        [role]: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high', revision: 1, setBy: 'owner', setAt: 1 } }));
    const r = resolveRoleLaunch({ deps: { providerLoader: loader } } as any, role, {});
    if (!r.ok) throw new Error(r.reason);
    const home = join(dir, 'private-home'); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.mcp.json'), '{"original":"private MCP binding"}');
    const result = await manager.startSession('claude-cli', dir, ['--verbose'], 'opus', {
        settingsOverride: role === 'assistant' ? { assistant: true } : { meshCoordinatorFor: 'mesh' },
        extraEnv: { HOME: home, ADHDEV_INLINE_MESH: '{"id":"original"}' }, initialThinkingLevel: 'high',
        launchProvenance: roleLaunchProvenance(role, r) });
    return { ...result, record: registry.get(result.runtimeSessionId)!.launch! };
}
function hostedDeps(id: string, record: any, meta: any = {}) {
    const hosted = { sessionId: id, providerType: 'claude-cli', workspace: dir, meta: { launchRecord: record, ...meta } };
    const restartSession = vi.fn(async () => hosted);
    return { providerLoader: loader, instanceManager: instances, sessionRegistry: registry, cdpManagers: new Map(), cliManager: manager,
        sessionHostControl: { listSessions: async () => [hosted], restartSession } } as any;
}
describe('role restarts replay recorded launch selection', () => {
    it.each(['assistant', 'coordinator'] as const)('real CLI %s restart preserves one axis/session flag and private HOME/inline MCP environment', async role => {
        const { runtimeSessionId: id, record } = await startRole(role);
        writeFileSync(join(dir, 'launch-defaults.json'), 'invalid newer defaults must not be read');
        expect(await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: id, cliArgs: ['--model', 'replacement'], initialModel: 'new' })).toMatchObject({ success: true });
        expect(spawns).toHaveLength(2);
        expect(spawns[1].args).toEqual(spawns[0].args);
        expect(spawns[1].args.join(' ').match(/--session-id/g)).toHaveLength(1);
        expect(spawns[1].args.join(' ').match(/--effort/g)).toHaveLength(1);
        // Script fixture is shell wrapped; inspect the argv at the real registration boundary too.
        const replay = manager.roleRestartInputs.get(id)!;
        expect(replay.options.restartBinding!.cliArgs!.filter(a => a === '--session-id')).toHaveLength(1);
        expect(replay.options.restartBinding!.cliArgs!.filter(a => a === '--effort')).toHaveLength(1);
        expect(replay.options.restartBinding!.cliArgs!.filter(a => a === '--model')).toHaveLength(1);
        expect(spawns[1].options.env).toMatchObject({ HOME: join(dir, 'private-home'), ADHDEV_INLINE_MESH: '{"id":"original"}' });
        expect(readFileSync(join(dir, 'private-home', '.mcp.json'), 'utf8')).toBe('{"original":"private MCP binding"}');
        expect(registry.get(id)!.launch).toMatchObject({ roleLaunch: record.roleLaunch, model: record.model, thinkingLevel: record.thinkingLevel });
    });
    it.each(['assistant', 'coordinator'] as const)('real CLI %s refuses an unavailable recorded provider before stopping', async role => {
        const { runtimeSessionId: id } = await startRole(role); loader.enabled = false;
        expect(await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: id })).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(manager.adapters.has(id)).toBe(true); expect(spawns).toHaveLength(1);
    });
    it('real CLI refuses a role without a recorded selection before stopping', async () => {
        const { runtimeSessionId: id } = await startRole('assistant');
        vi.spyOn(registry, 'get').mockReturnValue({} as any);
        expect(await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: id })).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(manager.adapters.has(id)).toBe(true); expect(spawns).toHaveLength(1);
    });
    it.each(['assistant', 'coordinator'] as const)('hosted %s restart validates with listSessions and replays its own record', async role => {
        const { runtimeSessionId: id, record } = await startRole(role);
        const deps = hostedDeps(id, record); const restore = vi.spyOn(manager, 'restoreHostedSessions');
        writeFileSync(join(dir, 'launch-defaults.json'), 'new defaults irrelevant');
        expect(await sessionHostHandlers.session_host_restart_session({ deps } as any, { sessionId: id })).toMatchObject({ success: true });
        expect(deps.sessionHostControl.restartSession).toHaveBeenCalledWith(id);
        expect(restore).toHaveBeenCalledWith([expect.objectContaining({ launchRecord: record })]);
    });
    it.each(['assistant', 'coordinator'] as const)('hosted %s without roleLaunch still validates and fails closed', async role => {
        const { runtimeSessionId: id, record } = await startRole(role); delete record.roleLaunch; loader.enabled = false;
        await manager.stopSession(id);
        const deps = hostedDeps(id, record, role === 'assistant' ? { assistant: true } : { meshCoordinatorFor: 'mesh' });
        expect(await sessionHostHandlers.session_host_restart_session({ deps } as any, { sessionId: id })).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(deps.sessionHostControl.restartSession).not.toHaveBeenCalled();
    });
    it.each(['assistant', 'coordinator'] as const)('hosted %s without any launch record is refused', async role => {
        const { runtimeSessionId: id } = await startRole(role); await manager.stopSession(id);
        const deps = hostedDeps(id, undefined, role === 'assistant' ? { assistant: true } : { meshCoordinatorFor: 'mesh' });
        expect(await sessionHostHandlers.session_host_restart_session({ deps } as any, { sessionId: id })).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(deps.sessionHostControl.restartSession).not.toHaveBeenCalled();
    });
    it('CLI restart command uses the validated hosted path', async () => {
        const { runtimeSessionId: id, record } = await startRole('assistant'); const deps = hostedDeps(id, record);
        const raw = vi.spyOn(manager, 'restartSession');
        expect(await cliAgentHandlers.restart_session({ deps } as any, { targetSessionId: id, cliType: 'codex-cli' })).toMatchObject({ success: true, restarted: true });
        expect(raw).not.toHaveBeenCalled(); expect(deps.sessionHostControl.restartSession).toHaveBeenCalledWith(id);
    });
    it.each(['model', 'thinkingLevel'] as const)('role launch fails when the detected version cannot apply %s', async axis => {
        // This case exercises a detected version's manifest, not shell-probe availability.
        // Detection may legitimately return an installed CLI without a version; in that
        // case the version-only resolve mock below would leave both axes supported.
        vi.spyOn(cliDetector, 'detectCLI').mockResolvedValue({ id: 'claude-cli', displayName: 'fixture',
            icon: '', command: join(dir, 'fixture-cli'), installed: true, version: '1.4.0' });
        const base = loader.resolve('claude-cli')!; const resolve = loader.resolve.bind(loader);
        vi.spyOn(loader, 'resolve').mockImplementation((type, opts) => opts?.version
            ? { ...base, ...(axis === 'model' ? { modelLaunchArgs: undefined } : { thinkingLaunchArgs: undefined }) } : resolve(type, opts));
        await expect(startRole('assistant')).rejects.toThrow(axis === 'model' ? 'model_unsupported' : 'thinking_unsupported');
        expect(loader.resolve).toHaveBeenCalledWith('claude-cli', { version: '1.4.0' });
        expect(spawns).toHaveLength(0);
    });
    it.each([['CLI', 'model'], ['CLI', 'thinkingLevel'], ['hosted', 'model'], ['hosted', 'thinkingLevel']] as const)('%s restart validates the detected version %s before any stop/restart effect', async (path, axis) => {
        const { runtimeSessionId: id, record } = await startRole('assistant');
        const deps = hostedDeps(id, record); const base = loader.resolve('claude-cli')!; const resolve = loader.resolve.bind(loader);
        vi.spyOn(loader, 'resolve').mockImplementation((type, opts) => opts?.version
            ? { ...base, ...(axis === 'model' ? { modelLaunchArgs: undefined } : { thinkingLaunchArgs: undefined }) } : resolve(type, opts));
        const result = path === 'CLI' ? await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: id })
            : await sessionHostHandlers.session_host_restart_session({ deps } as any, { sessionId: id });
        expect(result).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(manager.adapters.has(id)).toBe(true); expect(spawns).toHaveLength(1);
        expect(deps.sessionHostControl.restartSession).not.toHaveBeenCalled();
    });
    it('real CLI refuses a missing private replay plan before stopping', async () => {
        const { runtimeSessionId: id } = await startRole('assistant'); manager.roleRestartInputs.delete(id);
        expect(await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: id })).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(manager.adapters.has(id)).toBe(true); expect(spawns).toHaveLength(1);
    });
    it('default validation uses the resolved version manifest rather than getMeta', () => {
        const base = loader.resolve('claude-cli')!;
        vi.spyOn(loader, 'resolve').mockReturnValue({ ...base, modelLaunchArgs: undefined });
        expect(validateLaunchDefault('assistant', { provider: 'claude-cli', model: 'opus' }, createLaunchValidationPorts({ deps: { providerLoader: loader } }))).toMatchObject({ ok: false, issue: { reason: 'model_unsupported' } });
    });
});
