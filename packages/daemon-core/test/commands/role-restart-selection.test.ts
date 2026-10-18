import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { cliAgentHandlers } from '../../src/commands/med-family/cli-agent.js';
import { sessionHostHandlers } from '../../src/commands/low-family/session-host.js';
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js';
import { resolveRoleLaunch, roleLaunchProvenance } from '../../src/launch-defaults/consumer.js';
let dir: string, prior: string | undefined;
const provider: any = { type: 'claude-cli', category: 'cli', modelLaunchArgs: ['--model', '{{model}}'],
    thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['high'],
    meshCoordinator: { supported: true, mcpConfig: { mode: 'auto_import', path: '.mcp.json', format: 'claude_mcp_json' } } };
const loader: any = { resolveAlias: (t: string) => t, getMeta: () => provider,
    getAvailableProviderInfos: () => [{ type: 'claude-cli', enabled: true, installed: true }] };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'role-restart-')); prior = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = dir; });
afterEach(() => { vi.restoreAllMocks(); if (prior === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prior; rmSync(dir, { recursive: true, force: true }); });
function original(role: 'assistant' | 'coordinator') {
    writeFileSync(join(dir, 'launch-defaults.json'), JSON.stringify({ version: 1, revision: 1, history: [],
        [role]: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high', revision: 1, setBy: 'owner', setAt: 1 } }));
    const r = resolveRoleLaunch({ deps: { providerLoader: loader } } as any, role, {});
    if (!r.ok) throw new Error(r.reason);
    return buildSessionLaunchRecord({ sessionId: 'old', providerType: 'claude-cli', launchedBy: role === 'assistant' ? 'assistant' : 'mesh',
        launchedAt: 1, ...roleLaunchProvenance(role, r), model: { requested: 'opus', declaredSource: 'stored_default' }, thinkingLevel: { requested: 'high', declaredSource: 'stored_default' } });
}
describe('role restarts replay recorded launch selection', () => {
    it.each(['assistant', 'coordinator'] as const)('CLI %s restart never consumes a newer default or replacement args', async role => {
        const record = original(role), settings = role === 'assistant' ? { assistant: true } : { meshCoordinatorFor: 'mesh' };
        writeFileSync(join(dir, 'launch-defaults.json'), 'invalid newer defaults must not be read');
        const manager = new DaemonCliManager({ getP2p: () => null, getInstanceManager: () => ({ getInstance: () => ({ getState: () => ({ settings }) }) }) as any,
            getSessionRegistry: () => ({ get: () => ({ launch: record }) }) as any }, loader);
        vi.spyOn(manager, 'findAdapter').mockReturnValue({ key: 'old', adapter: { extraArgs: ['--model', 'opus', '--effort', 'high'] } as any });
        const stop = vi.spyOn(manager, 'stopSession').mockResolvedValue();
        const start = vi.spyOn(manager, 'startSession').mockResolvedValue({ runtimeSessionId: 'old' });
        expect(await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: 'old', cliArgs: ['--model', 'replacement'], initialModel: 'new' })).toMatchObject({ success: true });
        expect(stop).toHaveBeenCalledWith('old');
        expect(start).toHaveBeenCalledWith('claude-cli', dir, ['--model', 'opus', '--effort', 'high'], undefined,
            expect.objectContaining({ restartRecord: record, presetSessionKey: 'old', initialThinkingLevel: 'high' }));
        expect(record.roleLaunch?.documentRevision).toBe(1);
    });
    it('the CLI restart command uses hosted replay for roles, preserving the original private environment', async () => {
        const record = original('assistant');
        const hosted = { sessionId: 'old', providerType: 'claude-cli', workspace: dir,
            meta: { cliArgs: ['--model', 'opus'], launchRecord: record }, env: { HOME: '/original/private/home' } };
        const restartSession = vi.fn(async () => hosted), restartRaw = vi.fn(), restoreHostedSessions = vi.fn();
        const deps: any = { providerLoader: loader, sessionRegistry: { get: () => ({ launch: record }) },
            instanceManager: { getInstance: () => ({ getState: () => ({ settings: { assistant: true } }) }) }, cdpManagers: new Map(),
            sessionHostControl: { listSessions: async () => [hosted], restartSession },
            cliManager: { restartSession: restartRaw, restoreHostedSessions } };
        writeFileSync(join(dir, 'launch-defaults.json'), 'unreadable newer defaults');
        expect(await cliAgentHandlers.restart_session({ deps } as any, { targetSessionId: 'old', cliType: 'codex-cli', initialModel: 'new-default' })).toMatchObject({ success: true, restarted: true });
        expect(restartRaw).not.toHaveBeenCalled();
        expect(restartSession).toHaveBeenCalledWith('old');
        expect(restoreHostedSessions).toHaveBeenCalledWith([expect.objectContaining({ launchRecord: record })]);
    });
    it('refuses a role restart before stopping if the original selection is unavailable', async () => {
        const manager = new DaemonCliManager({ getP2p: () => null, getInstanceManager: () => ({ getInstance: () => ({ getState: () => ({ settings: { assistant: true } }) }) }) as any,
            getSessionRegistry: () => ({ get: () => ({}) }) as any }, loader);
        vi.spyOn(manager, 'findAdapter').mockReturnValue({ key: 'old', adapter: {} as any });
        const stop = vi.spyOn(manager, 'stopSession').mockResolvedValue();
        expect(await manager.restartSession({ cliType: 'claude-cli', dir, targetSessionId: 'old' })).toMatchObject({ success: false, code: 'restart_selection_unavailable' });
        expect(stop).not.toHaveBeenCalled();
    });
    it.each(['assistant', 'coordinator'] as const)('session-host %s restart keeps the spawn record instead of passing defaults', async role => {
        const record = original(role), argv = ['--model', 'opus', '--effort', 'high'];
        writeFileSync(join(dir, 'launch-defaults.json'), 'newer defaults are irrelevant to a restart');
        const restartSession = vi.fn(async (sessionId: string) => ({ sessionId, providerType: 'claude-cli', workspace: dir,
            meta: { cliArgs: argv, launchRecord: record } }));
        const restoreHostedSessions = vi.fn(async () => {});
        const result = await sessionHostHandlers.session_host_restart_session({ deps: { sessionHostControl: { restartSession }, cliManager: { restoreHostedSessions } } } as any, { sessionId: 'old' });
        expect(result).toMatchObject({ success: true });
        expect(restartSession).toHaveBeenCalledWith('old');
        expect(restoreHostedSessions).toHaveBeenCalledWith([expect.objectContaining({ cliArgs: argv, launchRecord: record })]);
    });
});
