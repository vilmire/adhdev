/**
 * Router post-execute: every command, whatever its source, is logged with its
 * real source and emits exactly one `command_executed` carrying the dashboard
 * invalidations. Before the registry only the hosts' WS/P2P/standalone paths
 * invalidated — commands arriving over local IPC or from the mesh runtime
 * never flushed the dashboard, and their command-log lines read `unknown`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import type { EventOf } from '../../src/sessions/lifecycle-events.js';
import { getRecentCommands } from '../../src/logging/command-log.js';

const ORIGINAL_CONFIG_DIR = process.env.ADHDEV_CONFIG_DIR;
const created: string[] = [];

afterEach(() => {
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function useTempConfigDir(): void {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-router-post-execute-'));
    created.push(dir);
    process.env.ADHDEV_CONFIG_DIR = dir;
}

function createRouter() {
    const bus = createSessionLifecycleBus();
    const executed: EventOf<'command_executed'>[] = [];
    bus.on('command_executed', (event) => { executed.push(event); });
    const handleSpec = vi.fn(async (spec: { name: string }, args: Record<string, unknown>) => ({ success: true, ran: spec.name, args }));
    const cliManager = {
        launchCli: vi.fn(async () => ({ success: true, sessionId: 'sess-new' })),
        stopCli: vi.fn(async (args: Record<string, unknown>) => ({ success: true, stopped: true, args })),
    };
    const router = new DaemonCommandRouter({
        commandHandler: {
            handleSpec,
            rejectUnknown: vi.fn(async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` })),
        } as any,
        cliManager: cliManager as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
        detectedIdes: { value: [] },
        sessionRegistry: { get: () => undefined } as any,
        bus,
    });
    return { router, executed, handleSpec, cliManager };
}

describe('router post-execute invalidation', () => {
    it('emits command_executed with the spec invalidations for an ipc-sourced command', async () => {
        useTempConfigDir();
        const { router, executed } = createRouter();

        await router.execute('set_conversation_prefs', { targetSessionId: 'sess-1', hidden: true }, 'ipc');

        expect(executed).toHaveLength(1);
        expect(executed[0]).toMatchObject({
            kind: 'command_executed',
            command: 'set_conversation_prefs',
            source: 'ipc',
            sessionId: 'sess-1',
            fastFlush: false,
            postChat: false,
        });
        expect([...executed[0].invalidates]).toEqual(['daemon.metadata']);
        expect(executed[0].interactionId).toMatch(/\S/);
    });

    it('emits command_executed for a mesh-sourced launch_cli, with fastFlush on success, and logs src mesh', async () => {
        useTempConfigDir();
        const { router, executed, cliManager } = createRouter();

        const result = await router.execute('launch_cli', { cliType: 'claude-cli', dir: '/tmp/ws' }, 'mesh');

        expect(result).toMatchObject({ success: true, sessionId: 'sess-new' });
        expect(cliManager.launchCli).toHaveBeenCalledTimes(1);
        expect(executed).toHaveLength(1);
        expect(executed[0]).toMatchObject({ command: 'launch_cli', source: 'mesh', success: true, fastFlush: true });
        expect([...executed[0].invalidates]).toEqual(['daemon.metadata']);
        const logged = getRecentCommands(10).filter((entry) => entry.cmd === 'launch_cli');
        expect(logged.map((entry) => entry.source)).toEqual(['mesh']);
    });

    it('fastFlush is false when the fastFlush command fails', async () => {
        useTempConfigDir();
        const { router, executed, cliManager } = createRouter();
        cliManager.launchCli.mockResolvedValueOnce({ success: false, error: 'boom' } as any);

        await router.execute('launch_cli', { cliType: 'claude-cli', dir: '/tmp/ws' }, 'ws');

        expect(executed[0]).toMatchObject({ success: false, fastFlush: false });
    });

    it('an unknown command still emits, with the prefix-rule invalidations', async () => {
        useTempConfigDir();
        const { router, executed } = createRouter();

        const result = await router.execute('workspace_not_a_command', {}, 'ipc');

        expect(result).toMatchObject({ success: false, error: 'Unknown command: workspace_not_a_command' });
        expect(executed).toHaveLength(1);
        expect([...executed[0].invalidates]).toEqual(['daemon.metadata']);
    });

    it('logs internal and unknown sources as such (no source collapses silently)', async () => {
        useTempConfigDir();
        const { router } = createRouter();

        await router.execute('stop_cli', { cliType: 'claude-cli', targetSessionId: 'sess-1' });
        await router.execute('stop_cli', { cliType: 'claude-cli', targetSessionId: 'sess-2' }, 'from-somewhere-else');

        const sources = getRecentCommands(10).filter((entry) => entry.cmd === 'stop_cli').map((entry) => entry.source);
        expect(sources).toEqual(['internal', 'unknown']);
    });

    it('applies the sessionId alias for aliasSessionId specs on every source', async () => {
        useTempConfigDir();
        const { router, cliManager, executed } = createRouter();

        await router.execute('stop_cli', { cliType: 'claude-cli', sessionId: ' sess-alias ' }, 'p2p');

        expect(cliManager.stopCli).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'sess-alias' }));
        expect(executed[0].sessionId).toBe('sess-alias');
    });

    it('does not alias for a spec without aliasSessionId', async () => {
        useTempConfigDir();
        const { router, handleSpec } = createRouter();

        await router.execute('list_chats', { sessionId: 'sess-x' }, 'p2p');

        const args = handleSpec.mock.calls[0][1];
        expect(args.targetSessionId).toBeUndefined();
    });
});

describe('router interaction context', () => {
    it('remembers the command interaction id per target session', async () => {
        useTempConfigDir();
        const { router } = createRouter();

        await router.execute('stop_cli', { cliType: 'claude-cli', targetSessionId: 'sess-1', _interactionId: 'int-42' }, 'ws');

        expect(router.interactionContext.get('sess-1')).toBe('int-42');
    });
});
