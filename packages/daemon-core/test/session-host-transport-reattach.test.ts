import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionHostClient } from '@adhdev/session-host-core';
import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';

const record = () => ({ sessionId: 'retained', osPid: 42, runtimeKey: 'same-incarnation', startedAt: 123,
    lifecycle: 'running', meta: { assistant: true, binding: 'original' },
    writeOwner: { clientId: 'daemon', ownerType: 'agent' }, attachedClients: [] });
let request: ReturnType<typeof vi.spyOn>;
let runtime: any;
const spawn = (ensureReady?: () => Promise<void>) => runtime = new SessionHostPtyTransportFactory({ clientId: 'daemon', runtimeId: 'retained',
    providerType: 'claude-cli', workspace: '/tmp/fixture', attachExisting: true, ensureReady,
}).spawn('/bin/sh', [], { cwd: '/tmp/fixture', env: {}, cols: 80, rows: 24 });
beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(SessionHostClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(SessionHostClient.prototype, 'close').mockResolvedValue();
    vi.spyOn(SessionHostClient.prototype, 'isConnected').mockReturnValue(true);
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

it.each(['get_session', 'attach_session_if_incarnation', 'get_snapshot', 'acquire_write'])('defers a living session when %s temporarily times out, then recovers without duplicate spawn or exit', async type => {
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
    expect(request.mock.calls.filter(([req]) => req.type === 'attach_session_if_incarnation')).toHaveLength(1);
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

it.each(['ensureReady', 'connect', 'get_session', 'attach_session_if_incarnation', 'get_input_state', 'acquire_write', 'get_snapshot'])(
    'fences detach during %s and closes late resources without later RPCs or metadata', async boundary => {
        const gate = deferred();
        let reached = false;
        const normal = request.getMockImplementation()!;
        const connect = vi.mocked(SessionHostClient.prototype.connect);
        if (boundary === 'connect') connect.mockImplementation(async () => { reached = true; await gate.promise; });
        request.mockImplementation(async req => {
            if (req.type === boundary) { reached = true; await gate.promise; }
            return normal(req);
        });
        const transport = spawn(boundary === 'ensureReady' ? async () => { reached = true; await gate.promise; } : undefined);
        const exits = vi.fn(); const output = vi.fn(); transport.onExit(exits); transport.onData(output);
        await vi.advanceTimersByTimeAsync(0);
        expect(reached).toBe(true);
        const before = request.mock.calls.length;
        const metadata = transport.getMetadata();
        transport.detach(); transport.detach();
        await transport.ready; // cancellation does not wait for the host/readiness gate
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await transport.ready;
        expect(request.mock.calls.slice(before).map(([req]) => req.type)).toEqual(
            ['acquire_write', 'get_snapshot'].includes(boundary) ? ['release_write', 'detach_session']
                : ['attach_session_if_incarnation', 'get_input_state'].includes(boundary) ? ['detach_session'] : []);
        expect(transport.getMetadata()).toEqual(metadata);
        // A detached transport can never certify input continuity.
        expect(transport.inputProvenance()?.complete ?? false).toBe(false);
        expect(output).not.toHaveBeenCalled(); expect(exits).not.toHaveBeenCalled();
        expect(SessionHostClient.prototype.close).toHaveBeenCalled();
        if (boundary === 'ensureReady') expect(connect).not.toHaveBeenCalled();
        if (boundary === 'connect') expect(SessionHostClient.prototype.close).toHaveBeenCalledTimes(1);
        const count = request.mock.calls.length;
        await expect(transport.write('after detach')).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(1000);
        expect(request.mock.calls).toHaveLength(count);
    });

it.each(['runtimeKey', 'startedAt', 'sessionId'])(
    'refuses established reconnect when %s changes before attaching or accepting output', async field => {
        let disconnect!: () => void;
        vi.spyOn(SessionHostClient.prototype, 'onDisconnect').mockImplementation(fn => { disconnect = fn as any; return vi.fn(); });
        let event!: (value: any) => void;
        vi.spyOn(SessionHostClient.prototype, 'onEvent').mockImplementation(fn => { event = fn; return vi.fn(); });
        const transport = spawn(); await transport.ready;
        const exits = vi.fn(); const output = vi.fn(); transport.onExit(exits); transport.onData(output);
        const original = transport.getMetadata(); request.mockClear();
        request.mockResolvedValue({ success: true, result: { ...record(), [field]: field === 'startedAt' ? 456 : 'replacement' } });
        disconnect();
        event({ type: 'session_output', sessionId: 'retained', data: 'replacement output' });
        const write = transport.write('must not reach replacement').catch(() => {});
        await vi.advanceTimersByTimeAsync(1000); await write;
        expect(request.mock.calls.map(([req]) => req.type)).toEqual(['get_session']);
        expect(transport.getMetadata()).toEqual(original);
        expect(output).not.toHaveBeenCalled(); expect(exits).toHaveBeenCalledTimes(1);
        expect(transport.inputProvenance()?.complete).toBe(false);
    });

it('clears automatic replay before same-incarnation reconnect and gates queued writes', async () => {
    const transport = spawn(); await transport.ready;
    const gate = deferred(); const normal = request.getMockImplementation()!;
    request.mockClear();
    request.mockImplementation(async req => { if (req.type === 'get_session') await gate.promise; return normal(req); });
    const reconnect = runtime.reconnectAndReattach();
    const write = transport.write('after validation');
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(([req]) => req.type)).toEqual(['get_session']);
    expect(SessionHostClient.prototype.close).toHaveBeenCalled();
    gate.resolve(); await reconnect; await write;
    expect(request.mock.calls.map(([req]) => req.type)).toEqual(['get_session', 'attach_session_if_incarnation', 'get_input_state', 'send_input']);
    expect(transport.getMetadata()?.runtimeKey).toBe('same-incarnation');
});

it.each(['connect', 'get_session', 'attach_session_if_incarnation', 'get_input_state'])(
    'cancels established reconnect detached during %s', async boundary => {
        const transport = spawn(); await transport.ready;
        const gate = deferred(); const normal = request.getMockImplementation()!;
        request.mockClear();
        if (boundary === 'connect') vi.mocked(SessionHostClient.prototype.connect).mockImplementation(async () => { await gate.promise; });
        request.mockImplementation(async req => { if (req.type === boundary) await gate.promise; return normal(req); });
        const reconnect = runtime.reconnectAndReattach();
        await vi.advanceTimersByTimeAsync(0);
        const count = request.mock.calls.length; const metadata = transport.getMetadata();
        transport.detach(); transport.detach();
        gate.resolve(); await reconnect; await vi.advanceTimersByTimeAsync(1000);
        expect(request.mock.calls.slice(count).map(([req]) => req.type)).toEqual(
            ['attach_session_if_incarnation', 'get_input_state'].includes(boundary) ? ['release_write', 'detach_session'] : []);
        expect(transport.getMetadata()).toEqual(metadata);
        expect(transport.inputProvenance()?.complete).toBe(false);
    });

it.each(['attach_session_if_incarnation', 'acquire_write'])('releases a late %s grant exactly once before closing the fake socket', async boundary => {
    const gate = deferred();
    const normal = request.getMockImplementation()!;
    let attached = false; let owner = false; let connected = true;
    request.mockImplementation(async req => {
        expect(connected).toBe(true);
        if (req.type === boundary) await gate.promise;
        if (req.type === 'attach_session_if_incarnation') attached = true;
        if (req.type === 'acquire_write') owner = true;
        if (req.type === 'release_write') owner = false;
        if (req.type === 'detach_session') attached = false;
        return normal(req);
    });
    vi.mocked(SessionHostClient.prototype.close).mockImplementation(async () => {
        expect(attached).toBe(false); expect(owner).toBe(false); connected = false;
    });
    const transport = spawn(); await vi.advanceTimersByTimeAsync(0);
    transport.detach(); transport.detach();
    expect(connected).toBe(true); // drain the outstanding grant before socket teardown
    gate.resolve(); await transport.ready; await runtime.closeClient();
    expect(connected).toBe(false); expect(attached).toBe(false); expect(owner).toBe(false);
    expect(SessionHostClient.prototype.close).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([req]) => req.type === 'detach_session')).toHaveLength(1);
    expect(request.mock.calls.filter(([req]) => req.type === 'release_write')).toHaveLength(boundary === 'acquire_write' ? 1 : 0);
});

it('leaves a pinned reconnect waiting safely when an old host cannot read its incarnation', async () => {
    const transport = spawn(); await transport.ready;
    request.mockClear(); request.mockResolvedValue({ success: false, error: 'Unknown request type: get_session' });
    const reconnect = runtime.reconnectAndReattach();
    const write = transport.write('hold for validation').catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(request.mock.calls.every(([req]) => req.type === 'get_session')).toBe(true);
    expect(transport.getMetadata()?.runtimeKey).toBe('same-incarnation');
    transport.detach(); await reconnect; await write;
    expect(request.mock.calls.every(([req]) => req.type === 'get_session')).toBe(true);
});

it('does not replay the old subscription when connecting for incarnation validation', async () => {
    const transport = spawn(); await transport.ready;
    // Model the real client's replay map despite the offline request stub.
    runtime.client.attachedSessions.set('retained', { sessionId: 'retained', clientId: 'daemon', clientType: 'daemon' });
    vi.mocked(SessionHostClient.prototype.close).mockImplementation(async function (this: any) { this.attachedSessions.clear(); });
    vi.mocked(SessionHostClient.prototype.connect).mockImplementation(async function (this: any) {
        expect(this.attachedSessions.size).toBe(0);
    });
    await runtime.reconnectAndReattach();
    expect(transport.getMetadata()?.runtimeKey).toBe('same-incarnation');
});

it('does not reconnect solely to release resources when detached offline', async () => {
    const transport = spawn(); await transport.ready;
    request.mockClear(); vi.mocked(SessionHostClient.prototype.connect).mockClear();
    vi.mocked(SessionHostClient.prototype.isConnected).mockReturnValue(false);
    transport.detach(); await runtime.closeClient();
    expect(request).not.toHaveBeenCalled();
    expect(SessionHostClient.prototype.connect).not.toHaveBeenCalled();
    expect(SessionHostClient.prototype.close).toHaveBeenCalledTimes(1);
});

it('fences detach while the readiness fallback after a failed connect is pending', async () => {
    const gate = deferred();
    const ensureReady = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => gate.promise);
    vi.mocked(SessionHostClient.prototype.connect).mockRejectedValueOnce(new Error('temporary connect error'));
    const transport = spawn(ensureReady); await vi.advanceTimersByTimeAsync(0);
    expect(ensureReady).toHaveBeenCalledTimes(2);
    transport.detach(); gate.resolve(); await transport.ready; await runtime.closeClient();
    expect(request).not.toHaveBeenCalled();
    expect(SessionHostClient.prototype.connect).toHaveBeenCalledTimes(1);
});

it('fences detach while a retained session resume acknowledgement is pending', async () => {
    const gate = deferred(); const normal = request.getMockImplementation()!;
    request.mockImplementation(async req => {
        if (req.type === 'get_session') return { success: true, result: { ...record(), lifecycle: 'interrupted' } };
        if (req.type === 'resume_session') await gate.promise;
        return normal(req);
    });
    const transport = spawn(); await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(([req]) => req.type)).toEqual(['get_session', 'resume_session']);
    transport.detach(); gate.resolve(); await transport.ready; await runtime.closeClient();
    expect(request.mock.calls.map(([req]) => req.type)).toEqual(['get_session', 'resume_session']);
});

it('sends the original expected incarnation to reject replacement between the read and atomic attach', async () => {
    const transport = spawn(); await transport.ready;
    const normal = request.getMockImplementation()!;
    request.mockClear();
    request.mockImplementation(async req => {
        if (req.type === 'attach_session_if_incarnation') {
            expect(req.payload.expectedIncarnation).toEqual({ sessionId: 'retained', runtimeKey: 'same-incarnation', startedAt: 123 });
            // Model the host's atomic refusal after its process changed since get_session.
            return { success: false, error: 'Runtime not found for session: retained (incarnation changed)' };
        }
        return normal(req);
    });
    const exits = vi.fn(); transport.onExit(exits);
    const reconnect = runtime.reconnectAndReattach();
    const write = transport.write('must be rejected').catch(() => {});
    await reconnect; await write;
    expect(request.mock.calls.map(([req]) => req.type)).toEqual(['get_session', 'attach_session_if_incarnation']);
    expect(transport.getMetadata()?.runtimeKey).toBe('same-incarnation');
    expect(exits).toHaveBeenCalledTimes(1);
});

it('never downgrades a pinned attach to an unguarded legacy attach when the guard is unsupported', async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async req => req.type === 'attach_session_if_incarnation'
        ? { success: false, error: 'Unsupported session host request: attach_session_if_incarnation' } : normal(req));
    const transport = spawn(); const exits = vi.fn(); transport.onExit(exits);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls.filter(([req]) => req.type === 'attach_session_if_incarnation').length).toBeGreaterThan(1);
    expect(request.mock.calls.some(([req]) => req.type === 'attach_session' || req.type === 'acquire_write')).toBe(false);
    expect(exits).not.toHaveBeenCalled();
    transport.detach(); await transport.ready; await runtime.closeClient();
});

it.each(['release_write', 'detach_session'])('closes exactly once even if cleanup %s fails', async type => {
    const transport = spawn(); await transport.ready;
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async req => { if (req.type === type) throw new Error('cleanup refusal'); return normal(req); });
    transport.detach(); transport.detach(); await runtime.closeClient();
    expect(SessionHostClient.prototype.close).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([req]) => req.type === type)).toHaveLength(1);
});
