import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionHostClient } from '@adhdev/session-host-core';
import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';

const record = () => ({ sessionId: 'retained', osPid: 42, runtimeKey: 'same-incarnation', startedAt: 123,
    lifecycle: 'running', meta: { assistant: true, binding: 'original' },
    writeOwner: { clientId: 'daemon', ownerType: 'agent' }, attachedClients: [] });
let request: ReturnType<typeof vi.spyOn>;
let runtime: any;
const spawn = () => runtime = new SessionHostPtyTransportFactory({ clientId: 'daemon', runtimeId: 'retained',
    providerType: 'claude-cli', workspace: '/tmp/fixture', attachExisting: true,
}).spawn('/bin/sh', [], { cwd: '/tmp/fixture', env: {}, cols: 80, rows: 24 });
beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(SessionHostClient.prototype, 'connect').mockResolvedValue();
    request = vi.spyOn(SessionHostClient.prototype, 'request').mockImplementation(async req => {
        if (req.type === 'list_sessions') throw new Error('legacy inventory contains megabyte prompts; activeOnly ignored');
        if (req.type === 'get_input_state') return { success: true, result: { inputSeq: 7, inputEpoch: 'original-epoch' } } as any;
        if (req.type === 'get_snapshot') return { success: true, result: { text: '' } } as any;
        return { success: true, result: record() } as any;
    });
});
afterEach(async () => { await runtime?.closeClient(); runtime = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

it('attaches and verifies the original incarnation with targeted reads on a legacy host ignoring activeOnly', async () => {
    const transport = spawn();
    await transport.ready;
    expect(await transport.verifyMeta({ binding: 'original' })).toBe(true);
    expect(request.mock.calls.filter(([req]) => req.type === 'get_session')).toHaveLength(2);
    expect(request.mock.calls.every(([req]) => req.type !== 'list_sessions' && req.type !== 'create_session')).toBe(true);
    expect(transport.getMetadata()).toMatchObject({ runtimeId: 'retained', runtimeKey: 'same-incarnation', startedAt: 123 });
    expect(transport.inputProvenance()).toMatchObject({ complete: true, foreign: 0 });
    request.mockResolvedValueOnce({ success: true, result: { ...record(), runtimeKey: 'replaced' } });
    expect(await transport.verifyMeta({ binding: 'original' })).toBe(false);
});

it.each(['get_session', 'attach_session', 'get_snapshot', 'acquire_write'])('defers a living session when %s temporarily times out, then recovers without duplicate spawn or exit', async type => {
    const normal = request.getMockImplementation()!;
    let failed = false;
    request.mockImplementation(async req => {
        if (req.type === type && !failed) { failed = true; throw Object.assign(new Error('temporary IPC timeout'), { code: 'SESSION_HOST_REQUEST_TIMEOUT' }); }
        return normal(req);
    });
    const transport = spawn();
    const exits = vi.fn(); transport.onExit(exits);
    let ready = false; void transport.ready.then(() => { ready = true; }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toBe(true);
    expect(ready).toBe(false);
    expect(exits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    await transport.ready;
    expect(ready).toBe(true);
    expect(exits).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([req]) => req.type === 'create_session')).toBe(false);
    expect(transport.getMetadata()).toMatchObject({ runtimeId: 'retained', runtimeKey: 'same-incarnation' });
    expect(transport.inputProvenance()?.complete).toBe(true);
});

it('supports a host without get_session by attaching directly, without a full inventory fallback', async () => {
    request.mockResolvedValueOnce({ success: false, error: 'Unknown request type: get_session' });
    const transport = spawn(); await transport.ready;
    expect(transport.pid).toBe(42);
    expect(request.mock.calls.some(([req]) => req.type === 'list_sessions')).toBe(false);
});

it('ends an authoritatively absent runtime rather than retrying forever', async () => {
    request.mockResolvedValueOnce({ success: false, error: 'session_absent' });
    const transport = spawn(); const exits = vi.fn(); transport.onExit(exits);
    await expect(transport.ready).rejects.toThrow('session_absent');
    expect(exits).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
});

it('preserves authoritative real-death termination instead of inventing an unknown exit', async () => {
    const termination = { exitCode: 9, signal: null, reason: 'failed', lifecycle: 'failed', terminatedAt: 456 };
    request.mockResolvedValue({ success: true, result: { ...record(), lifecycle: 'failed', termination } });
    const transport = spawn(); const exits = vi.fn(); transport.onExit(exits);
    await transport.ready;
    expect(exits).toHaveBeenCalledExactlyOnceWith({ exitCode: 9, signal: null, termination });
});

it('can detach while reattachment is deferred without leaving retries or a replacement writer', async () => {
    request.mockRejectedValue(new Error('host temporarily unreachable'));
    const transport = spawn(); const exits = vi.fn(); transport.onExit(exits);
    await vi.advanceTimersByTimeAsync(0);
    transport.detach();
    await vi.advanceTimersByTimeAsync(1000);
    await transport.ready;
    expect(request).toHaveBeenCalledTimes(1);
    expect(exits).not.toHaveBeenCalled();
});

it('never adopts a different incarnation while retrying the original living writer', async () => {
    const normal = request.getMockImplementation()!;
    let changed = false;
    request.mockImplementation(async req => {
        if (req.type === 'get_snapshot') { changed = true; throw new Error('temporary timeout'); }
        if (req.type === 'get_session' && changed) return { success: true, result: { ...record(), runtimeKey: 'different-process' } };
        return normal(req);
    });
    const transport = spawn(); const exits = vi.fn(); transport.onExit(exits);
    const outcome = transport.ready.then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(60);
    expect((await outcome)?.message).toContain('incarnation changed');
    expect(exits).toHaveBeenCalledTimes(1);
    expect(transport.getMetadata()?.runtimeKey).toBe('same-incarnation');
    expect(request.mock.calls.filter(([req]) => req.type === 'attach_session')).toHaveLength(1);
});
