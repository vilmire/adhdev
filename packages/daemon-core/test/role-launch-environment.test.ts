import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionHostClient } from '@adhdev/session-host-core';
import { sanitizeSpawnEnv } from '../../session-host-core/src/spawn-env.js';
import { buildPayloadFromRecord } from '../../session-host-daemon/src/session-lifecycle.js';
import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';
import { buildSpecAdapterOpts } from '../src/providers/spec/fsm-driver-launch.js';
import { TerminalAdapter } from '../src/providers/spec/adapter.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('hosted launch environment replay', () => {
    it('the real spec adapter and host transport persist only launch overrides, not inherited secrets', async () => {
        vi.stubEnv('ROTATING_API_TOKEN', 'old-secret');
        const record: any = { sessionId: 'role', runtimeKey: 'role', providerType: 'claude-cli', workspace: '/tmp', meta: {}, attachedClients: [] };
        vi.spyOn(SessionHostClient.prototype, 'connect').mockResolvedValue();
        vi.spyOn(SessionHostClient.prototype, 'onEvent').mockReturnValue(() => {});
        const request = vi.spyOn(SessionHostClient.prototype, 'request').mockImplementation(async (message: any) => {
            if (message.type === 'create_session') Object.assign(record, message.payload);
            return { success: true, result: record } as any;
        });
        const factory = new SessionHostPtyTransportFactory({ clientId: 'test', runtimeId: 'role', providerType: 'claude-cli', workspace: '/tmp' });
        const opts = buildSpecAdapterOpts({ id: 'fixture', binary: '/bin/echo', env: { PROVIDER_FLAG: 'declared' } } as any, {
            workingDir: '/tmp', extraEnv: { HOME: '/private/role', ADHDEV_INLINE_MESH: '{"id":"mesh"}' }, transportFactory: factory,
        } as any);
        const spawn = vi.spyOn(factory, 'spawn');
        const adapter = new TerminalAdapter(opts, {}); adapter.start();
        await spawn.mock.results[0].value.ready;
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_session' }));
        expect(record.launchCommand).toMatchObject({ envMode: 'launch_overrides', env: {
            HOME: '/private/role', ADHDEV_INLINE_MESH: '{"id":"mesh"}', PROVIDER_FLAG: 'declared', TERMINAL_CWD: '/tmp' } });
        expect(record.launchCommand.env).not.toHaveProperty('ROTATING_API_TOKEN');
        vi.stubEnv('ROTATING_API_TOKEN', 'rotated-secret');
        const payload = buildPayloadFromRecord(record);
        expect(sanitizeSpawnEnv(process.env, payload.launchCommand.env)).toMatchObject({ ROTATING_API_TOKEN: 'rotated-secret', HOME: '/private/role' });
    });
    it('legacy full-environment records retain private role bindings while rotated current secrets win', () => {
        const payload = buildPayloadFromRecord({ sessionId: 'legacy', meta: {}, launchCommand: {
            command: '/bin/echo', args: ['original'], env: { HOME: '/private/role', ADHDEV_INLINE_MESH: 'original', ROTATING_API_TOKEN: 'old-secret' },
        } } as any);
        expect(payload.launchCommand).toMatchObject({ args: ['original'], envMode: 'launch_overrides' });
        expect(payload.launchCommand.env).not.toHaveProperty('ROTATING_API_TOKEN');
        expect(sanitizeSpawnEnv({ ROTATING_API_TOKEN: 'rotated-secret' }, payload.launchCommand.env)).toMatchObject({ ROTATING_API_TOKEN: 'rotated-secret', HOME: '/private/role', ADHDEV_INLINE_MESH: 'original' });
    });
    it('intentional launch-specific overrides survive replay', () => {
        const payload = buildPayloadFromRecord({ sessionId: 'explicit', meta: {}, launchCommand: {
            command: '/bin/echo', args: [], envMode: 'launch_overrides', env: { CUSTOM_LAUNCH_BINDING: 'original' },
        } } as any);
        expect(sanitizeSpawnEnv({ CUSTOM_LAUNCH_BINDING: 'parent' }, payload.launchCommand.env).CUSTOM_LAUNCH_BINDING).toBe('original');
    });
});
