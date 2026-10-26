import { afterEach, expect, it, vi } from 'vitest';
import { SessionHostClient } from '@adhdev/session-host-core';
import { listHostedCliRuntimes } from '../../src/session-host/runtime-support.js';
afterEach(() => vi.restoreAllMocks());
it('uses a dedicated census socket and fetches full arguments only for restoration', async () => {
    const record: any = { sessionId: 'one', runtimeKey: 'key', startedAt: 1, category: 'cli', providerType: 'codex-cli', workspace: '/tmp/repo', lifecycle: 'running', lastActivityAt: 1,
        meta: { cliArgs: [], cliArgsOmitted: true } };
    const shared = vi.spyOn(SessionHostClient, 'findConnectedClient').mockReturnValue({ request: () => { throw new Error('shared output connection is blocked'); } } as any);
    const requests = vi.spyOn(SessionHostClient.prototype, 'request').mockImplementation(async request => ({ success: true,
        result: request.type === 'list_sessions' ? [{ ...record }] : { ...record, meta: { cliArgs: ['--model', 'test-model'] } } }));
    const ep = { kind: 'unix' as const, path: '/tmp/rc32-census.sock' };
    expect((await listHostedCliRuntimes(ep))[0].cliArgs).toEqual([]);
    expect(shared).not.toHaveBeenCalled();
    expect(requests).toHaveBeenCalledTimes(1);
    expect((await listHostedCliRuntimes(ep, { includeLaunchDetails: true }))[0].cliArgs).toEqual(['--model', 'test-model']);
    expect(requests).toHaveBeenLastCalledWith({ type: 'get_session', payload: { sessionId: 'one' } });
});
