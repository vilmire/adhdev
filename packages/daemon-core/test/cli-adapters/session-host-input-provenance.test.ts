/**
 * SUBMIT-UNCONFIRMED-RECLAIM — input provenance is the SESSION HOST's account
 * (review R7, independent Codex probes, ported).
 *
 * The real SessionHostServer request handlers + the real hosted transport +
 * the real FsmDriver over the native VT; only the IPC socket and the PTY
 * process are modelled. The host lets an UNATTACHED client force-acquire write
 * ownership and send input (R7-1), and acquireWrite makes a read-only viewer
 * writable in the host registry (R7-2). Neither shows up in a client list
 * cached on the daemon side; the host's `session_input` announcements do.
 */
import { it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const h = vi.hoisted(() => ({ server: null as any, listeners: new Set<(e: any) => void>(), disconnect: null as null | (() => void) }));
vi.mock('@adhdev/session-host-core', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        SessionHostClient: class {
            async connect() { /* modelled socket */ }
            async close() { /* modelled socket */ }
            onDisconnect(fn: any) { h.disconnect = fn; return () => { h.disconnect = null; }; }
            onEvent(fn: any) { h.listeners.add(fn); return () => h.listeners.delete(fn); }
            request(req: any) { return h.server.handleRequest(req); }
        },
    };
});

import { SessionHostServer } from '../../../session-host-daemon/src/server.js';
import { SessionHostPtyTransportFactory } from '../../src/cli-adapters/session-host-transport.js';
import { FsmDriver } from '../../src/providers/spec/fsm-driver.js';
import { confirmLocalConsumption } from '../../src/boot/stages/mesh-runtime.js';
import '../../src/boot/stages/loops.js';

const tmpDirs: string[] = [];
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    h.listeners.clear();
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

async function setup() {
    vi.useFakeTimers();
    const server = new SessionHostServer({ appName: 'r7-isolated', storageRootDir: tmp('r7-host-records-') }) as any;
    h.server = server;
    server.emitEvent = (e: any) => { for (const fn of h.listeners) fn(e); };
    const record = server.registry.createSession({ sessionId: 'r7-test', providerType: 'test', category: 'cli', workspace: os.tmpdir(), launchCommand: { command: '/bin/true', args: [] }, clientId: 'daemon', clientType: 'daemon' });
    server.registry.restoreSession({ ...record, lifecycle: 'running' });
    const writes: string[] = [];
    server.runtimes.set('r7-test', { write: (s: string) => writes.push(s) });
    const transport = new SessionHostPtyTransportFactory({ clientId: 'daemon', runtimeId: 'r7-test', providerType: 'test', workspace: os.tmpdir(), attachExisting: true })
        .spawn('/bin/true', [], { cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 } as any);
    await transport.ready;
    expect(transport.otherWritableClients?.()).toBe(false);
    return { server, transport, writes };
}

it('R7-1: an unattached local writer that takes ownership and writes is detected — by owner and by the host\'s input announcements', async () => {
    const { server, transport, writes } = await setup();
    try {
        const before = transport.inputProvenance?.();
        expect(before).toMatchObject({ foreign: 0, ownerAway: 0, gaps: 0, complete: true });
        expect((await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', ownerType: 'user', force: true } })).success).toBe(true);
        expect((await server.handleRequest({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', data: 'human draft' } })).success).toBe(true);
        expect(writes).toEqual(['human draft']);
        expect(server.registry.getSession('r7-test').attachedClients.map((c: any) => c.clientId)).toEqual(['daemon']);
        expect(transport.getMetadata?.()?.writeOwner?.clientId).toBe('unattached-local-terminal');
        expect(transport.otherWritableClients?.()).toBe(true);
        expect(transport.inputProvenance?.()).toMatchObject({ foreign: 1, ownerAway: 1, gaps: 0, complete: true });
    } finally { await (transport as any).closeClient(false); }
});

it('R7-2: a read-only attached client promoted to writable is detected after the owner event (cache mirrors the host registry)', async () => {
    const { server, transport, writes } = await setup();
    try {
        expect((await server.handleRequest({ type: 'attach_session', payload: { sessionId: 'r7-test', clientId: 'viewer', clientType: 'local-terminal', readOnly: true } })).success).toBe(true);
        expect(transport.otherWritableClients?.()).toBe(false);
        expect((await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'viewer', ownerType: 'user', force: true } })).success).toBe(true);
        expect((await server.handleRequest({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'viewer', data: 'human draft' } })).success).toBe(true);
        expect(writes).toEqual(['human draft']);
        expect(server.registry.getSession('r7-test').attachedClients.find((c: any) => c.clientId === 'viewer').readOnly).toBe(false);
        // The reviewer's probe recorded the stale cache (true); it now mirrors the host.
        expect(transport.getMetadata?.()?.attachedClients?.find((c: any) => c.clientId === 'viewer')?.readOnly).toBe(false);
        expect(transport.otherWritableClients?.()).toBe(true);
        await server.handleRequest({ type: 'release_write', payload: { sessionId: 'r7-test', clientId: 'viewer' } });
        // Released but still attached and writable in the host: still counts.
        expect(transport.otherWritableClients?.()).toBe(true);
        expect(transport.inputProvenance?.()).toMatchObject({ foreign: 1, ownerAway: 1 });
    } finally { await (transport as any).closeClient(false); }
});

it('the host announces every accepted input in order, before the bytes reach the PTY, and our own inputs are not foreign', async () => {
    const { server, transport } = await setup();
    const order: string[] = [];
    h.listeners.add((e: any) => { if (e.type === 'session_input') order.push(`announce:${e.seq}:${e.clientId}`); });
    server.runtimes.set('r7-test', { write: (s: string) => order.push(`pty:${s}`) });
    try {
        await transport.write('ours');
        expect(order).toEqual(['announce:1:daemon', 'pty:ours']);
        expect(transport.inputProvenance?.()).toMatchObject({ foreign: 0, ownerAway: 0, gaps: 0, complete: true });
        expect(server.registry.getSession('r7-test').inputSeq).toBe(1);
    } finally { await (transport as any).closeClient(false); }
});

it('an older host (records without inputSeq, no announcements) leaves provenance unknown', async () => {
    const { server, transport } = await setup();
    try {
        // Simulate the old host: records without inputSeq, and the new request types unknown.
        const old = new SessionHostPtyTransportFactory({ clientId: 'daemon-2', runtimeId: 'r7-old', providerType: 'test', workspace: os.tmpdir(), attachExisting: true });
        const rec = server.registry.createSession({ sessionId: 'r7-old', providerType: 'test', category: 'cli', workspace: os.tmpdir(), launchCommand: { command: '/bin/true', args: [] }, clientId: 'daemon-2', clientType: 'daemon' });
        const { inputSeq: _drop, ...legacy } = rec;
        const realHandle = server.handleRequest.bind(server);
        h.server = { handleRequest: async (req: any) => {
            if (req.type === 'get_input_state' || req.type === 'send_input_if_seq') return { success: false, error: `Unknown request type: ${req.type}` };
            const res = await realHandle(req);
            if (res?.result && typeof res.result === 'object' && 'inputSeq' in res.result) { const { inputSeq: _x, ...rest } = res.result; return { ...res, result: rest }; }
            return res;
        } };
        server.registry.restoreSession({ ...legacy, lifecycle: 'running' } as any);
        server.runtimes.set('r7-old', { write: () => {} });
        const t = old.spawn('/bin/true', [], { cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 } as any);
        await t.ready;
        expect(t.inputProvenance?.()).toBeNull();
        await (t as any).closeClient(false);
    } finally { h.server = server; await (transport as any).closeClient(false); }
});

const inputRow = (s: string) => '\x1b[999;1H\x1b[1A\r\x1b[2K> ' + s;
const footer = (s: string) => '\x1b[999;1H\x1b[2K' + s + '\x1b[1A\x1b[999C';
for (const writerCase of ['unattached', 'promoted-viewer'] as const) {
    it(`R7 end-to-end (real server + hosted transport + driver) never deletes the first foreign chip: ${writerCase}`, async () => {
        const { server, transport, writes } = await setup();
        const specPath = path.join(tmp('r7-spec-'), 'spec.json');
        fs.writeFileSync(specPath, JSON.stringify({
            $schema: 'adhdev:cli/spec@4', id: 'test.r7-host', name: 'r7', binary: '/bin/true',
            send_message: { submit_key: '\r', delay_ms_before_submit: 50, echo_confirm: 'tail', max_submit_resends: 3, posix_bracketed_paste_text: true },
            sections: { footer: { from_bottom: 1 } },
            states: [{ id: 'starting', label: 'Start', initial: true, status: 'idle' }, { id: 'idle', label: 'Idle', status: 'idle' }, { id: 'generating', label: 'Working', status: 'generating' }],
            transitions: [{ label: 'ready', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } }, { label: 'working', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'Thinking' } }],
        }));
        const driver = new FsmDriver({ specPath, workingDir: os.tmpdir(), hotReload: false, transportFactory: { spawn: () => transport } });
        let composer = '';
        const emit = (data: string) => server.emitEvent({ type: 'session_output', sessionId: 'r7-test', seq: 1, data });
        server.runtimes.set('r7-test', { write: (data: string) => {
            writes.push(data);
            if (data === 'LOCAL HUMAN PASTE') { composer = '[Pasted text #99 +40 lines]'; emit(inputRow(composer)); }
            else if (data === '\x7f') { composer = ''; emit(inputRow(composer)); }
        } });
        try {
            driver.start(); emit('\x1b[?1049h' + inputRow('') + footer('? for shortcuts')); await vi.advanceTimersByTimeAsync(300);
            if (writerCase === 'promoted-viewer') await server.handleRequest({ type: 'attach_session', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', clientType: 'local-terminal', readOnly: true } });
            driver.observeSubmitUnconfirmed('task:first:n0', () => true);
            expect(driver.sendMessageWithDisposition('TASK ' + 'body '.repeat(100), false, 'task:first:n0').status).toBe('delivered');
            await vi.advanceTimersByTimeAsync(1);
            expect((await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', ownerType: 'user', force: true } })).success).toBe(true);
            expect((await server.handleRequest({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', data: 'LOCAL HUMAN PASTE' } })).success).toBe(true);
            expect(composer).toBe('[Pasted text #99 +40 lines]');
            if (writerCase === 'promoted-viewer') await server.handleRequest({ type: 'release_write', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal' } });
            await vi.advanceTimersByTimeAsync(15_000);
            expect(writes.filter((s) => s === '\x7f')).toHaveLength(0);
            expect(composer).toBe('[Pasted text #99 +40 lines]');
        } finally { driver.shutdown(); await (transport as any).closeClient(false); }
    });
}

// ── review R8 (independent Codex race probes, ported) ──────────────────────

function hostSpec(): string {
    const specPath = path.join(tmp('r8-spec-'), 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
        $schema: 'adhdev:cli/spec@4', id: 'test.r8-host', name: 'r8', binary: '/bin/true',
        send_message: { submit_key: '\r', delay_ms_before_submit: 50, echo_confirm: 'tail', max_submit_resends: 3, posix_bracketed_paste_text: true },
        sections: { footer: { from_bottom: 1 } },
        states: [{ id: 'starting', label: 'Start', initial: true, status: 'idle' }, { id: 'idle', label: 'Idle', status: 'idle' }, { id: 'generating', label: 'Working', status: 'generating' }],
        transitions: [{ label: 'ready', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } }, { label: 'working', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'Thinking' } }],
    }));
    return specPath;
}

it('R8-1 del-admission-race: foreign input accepted after our ownership check but before our queued DEL reaches the host is never deleted', async () => {
    const { server, transport, writes } = await setup();
    const driver = new FsmDriver({ specPath: hostSpec(), workingDir: os.tmpdir(), hotReload: false, transportFactory: { spawn: () => transport } });
    let composer = '';
    const emit = (data: string) => server.emitEvent({ type: 'session_output', sessionId: 'r7-test', seq: 1, data });
    let composerHadUserTail = false;
    server.runtimes.set('r7-test', { write: (data: string) => {
        writes.push(data);
        if (data.startsWith('\x1b[200~')) { composer = '[Pasted text #1 +40 lines]'; emit(inputRow(composer)); }
        else if (data === 'FOREIGN TAIL') { composer += 'X'; composerHadUserTail = true; emit(inputRow(composer)); }
        else if (data === '\x7f') { composer = Array.from(composer).slice(0, -1).join(''); emit(inputRow(composer)); }
    } });
    const realHandle = server.handleRequest.bind(server);
    let injected = false;
    h.server = { handleRequest: async (req: any) => {
        // The DEL now travels as send_input_if_seq; the reviewer hooked plain send_input.
        if (!injected && (req.type === 'send_input' || req.type === 'send_input_if_seq') && req.payload.data === '\x7f') {
            injected = true;
            // Accepted after the machine judged, before its DEL reaches the host.
            await realHandle({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'local-user', ownerType: 'user', force: true } });
            await realHandle({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'local-user', data: 'FOREIGN TAIL' } });
        }
        return realHandle(req);
    } };
    try {
        driver.start(); emit('\x1b[?1049h' + inputRow('') + footer('? for shortcuts')); await vi.advanceTimersByTimeAsync(300);
        driver.observeSubmitUnconfirmed('task:first:n0', () => true, async () => 'not_consumed');
        expect(driver.sendMessageWithDisposition('TASK ' + 'body '.repeat(100), false, 'task:first:n0').status).toBe('delivered');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(injected).toBe(true); // the race really was exercised
        expect(writes.filter((s) => s === '\x7f')).toHaveLength(0);
        expect(composerHadUserTail).toBe(true);
        expect(composer.endsWith('X')).toBe(true);
    } finally { h.server = server; driver.shutdown(); await (transport as any).closeClient(false); }
});

it('R8-1 (host): send_input_if_seq writes only at the exact accounted (epoch, seq), never force-takes ownership, and an unknown-to-old-host request writes nothing', async () => {
    const { server, writes } = await setup();
    const st = (await server.handleRequest({ type: 'get_input_state', payload: { sessionId: 'r7-test' } })).result;
    const ok = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 'r7-test', clientId: 'daemon', data: 'a', expectedInputSeq: st.inputSeq, expectedInputEpoch: st.inputEpoch } });
    expect(ok.success).toBe(true);
    const stale = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 'r7-test', clientId: 'daemon', data: 'b', expectedInputSeq: st.inputSeq, expectedInputEpoch: st.inputEpoch } });
    expect(stale).toMatchObject({ success: false, error: 'input_seq_mismatch' });
    await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'other', ownerType: 'user', force: true } });
    const now = (await server.handleRequest({ type: 'get_input_state', payload: { sessionId: 'r7-test' } })).result;
    const owned = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 'r7-test', clientId: 'daemon', data: 'c', expectedInputSeq: now.inputSeq, expectedInputEpoch: now.inputEpoch } });
    expect(owned.success).toBe(false);
    expect(server.registry.getSession('r7-test').writeOwner.clientId).toBe('other');
    expect(writes).toEqual(['a']);
});

it('R8-2: a restored record with a lower inputSeq invalidates complete provenance', async () => {
    const { server, transport } = await setup();
    try {
        await transport.write('own');
        const before = transport.inputProvenance?.();
        expect(before).toMatchObject({ complete: true, gaps: 0 });
        const current = server.registry.getSession('r7-test');
        server.registry.restoreSession({ ...current, inputSeq: 0 });
        (transport as any).updateMetadata(server.registry.getSession('r7-test'));
        const after = transport.inputProvenance?.();
        expect(after === null || !after.complete || after.gaps !== before!.gaps).toBe(true);
    } finally { await (transport as any).closeClient(false); }
});

it('R8-3: disconnect invalidates complete provenance before a reconnect record arrives', async () => {
    const { transport } = await setup();
    try {
        const before = transport.inputProvenance?.();
        expect(before?.complete).toBe(true);
        h.disconnect?.();
        expect(transport.inputProvenance?.()?.complete).toBe(false);
        for (let i = 0; i < 30 && (transport as any).reconnecting; i++) await Promise.resolve();
        // Re-established after the reconnect, but never as the same key.
        const after = transport.inputProvenance?.();
        expect(after?.complete).toBe(true);
        expect(after?.gaps).not.toBe(before?.gaps);
    } finally { await (transport as any).closeClient(false); }
});

for (const mode of ['gap', 'duplicate'] as const) {
    it(`a ${mode} announcement changes the provenance key`, async () => {
        const { transport } = await setup();
        try {
            await transport.write('a');
            const before = transport.inputProvenance?.()!;
            const epoch = (transport as any).input.epoch;
            (transport as any).handleEvent({ type: 'session_input', sessionId: 'r7-test', seq: mode === 'gap' ? 3 : 1, epoch, clientId: 'daemon' });
            expect(transport.inputProvenance?.()?.gaps).toBe(before.gaps + 1);
        } finally { await (transport as any).closeClient(false); }
    });
}

it('an own announcement delayed after the ACK keeps provenance incomplete until delivered', async () => {
    const { server, transport } = await setup();
    const events: any[] = [];
    const emit = server.emitEvent.bind(server);
    server.emitEvent = (e: any) => (e.type === 'session_input' ? events.push(e) : emit(e));
    try {
        await transport.write('a');
        expect(transport.inputProvenance?.()?.complete).toBe(false);
        for (const e of events) emit(e);
        expect(transport.inputProvenance?.()).toMatchObject({ foreign: 0, gaps: 0, complete: true });
    } finally { await (transport as any).closeClient(false); }
});

it('two writers in one tick are counted in order, including an unattached foreign writer; announcements carry no input data', async () => {
    const { server, transport } = await setup();
    await server.handleRequest({ type: 'release_write', payload: { sessionId: 'r7-test', clientId: 'daemon' } });
    try {
        const seen: any[] = [];
        h.listeners.add((e) => { if (e.type === 'session_input') seen.push(e); });
        const responses = await Promise.all(['daemon', 'foreign'].map((clientId) => server.handleRequest({ type: 'send_input', payload: { sessionId: 'r7-test', clientId, data: 'payload not in announcement' } })));
        expect(responses.every((r: any) => r.success)).toBe(true);
        expect(seen.map((e) => [e.seq, e.clientId])).toEqual([[1, 'daemon'], [2, 'foreign']]);
        expect(transport.inputProvenance?.()).toMatchObject({ foreign: 1, gaps: 0, complete: true });
        expect(seen.every((e) => Object.keys(e).sort().join(',') === 'clientId,epoch,seq,sessionId,type')).toBe(true);
    } finally { await (transport as any).closeClient(false); }
});

it('R9-1 queued-del-seq: a human X announced while the guarded DEL waits on the transport queue is not adopted as the expected seq, so the DEL never deletes it', async () => {
    const { server, transport, writes } = await setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const realHandle = server.handleRequest.bind(server);
    h.server = { handleRequest: async (req: any) => {
        if (!held && req.type === 'update_session_meta') { held = true; await gate; }
        return realHandle(req);
    } };
    try {
        expect(transport.inputProvenance?.()).toMatchObject({ complete: true, foreign: 0, gaps: 0 });
        const decided = (transport as any).input.lastEventSeq;
        expect(typeof decided).toBe('number');
        (transport as any).updateMeta({ hold: true });
        for (let i = 0; i < 50 && !held; i++) await Promise.resolve();
        expect(held).toBe(true);
        const verdict = (transport as any).writeIfInputUnchanged('\x7f') as Promise<boolean>;
        expect((await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'local-user', ownerType: 'user', force: true } })).success).toBe(true);
        expect((await server.handleRequest({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'local-user', data: 'X' } })).success).toBe(true);
        await server.handleRequest({ type: 'release_write', payload: { sessionId: 'r7-test', clientId: 'local-user' } });
        await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'daemon', ownerType: 'user', force: true } });
        expect((transport as any).input.lastEventSeq).not.toBe(decided);
        expect(transport.inputProvenance?.()?.foreign).toBe(1);
        release();
        expect(await verdict).toBe(false);
        expect(writes.filter((s) => s === '\x7f')).toHaveLength(0);
        expect(writes).toContain('X');
    } finally { h.server = server; await (transport as any).closeClient(false); }
});

it('R9-2 recovery re-paste: human X that lands as the re-paste is admitted is left exactly as X — no second paste, no CR after it', async () => {
    const { server, transport, writes } = await setup();
    const driver = new FsmDriver({ specPath: hostSpec(), workingDir: os.tmpdir(), hotReload: false, transportFactory: { spawn: () => transport } });
    let composer = '';
    const emit = (data: string) => server.emitEvent({ type: 'session_output', sessionId: 'r7-test', seq: 1, data });
    server.runtimes.set('r7-test', { write: (data: string) => {
        writes.push(data);
        if (data.startsWith('\x1b[200~')) {
            const chip = `[Pasted text #${writes.filter((s) => s.startsWith('\x1b[200~')).length} +40 lines]`;
            composer = composer && composer !== '' ? composer + chip : chip;
            emit(inputRow(composer));
        } else if (data === 'X') { composer += 'X'; emit(inputRow(composer)); }
        else if (data === '\x7f') {
            composer = /\[Pasted text #\d+ \+40 lines\]$/.test(composer) ? composer.replace(/\[Pasted text #\d+ \+40 lines\]$/, '') : Array.from(composer).slice(0, -1).join('');
            emit(inputRow(composer));
        }
    } });
    const realHandle = server.handleRequest.bind(server);
    let injected = false;
    h.server = { handleRequest: async (req: any) => {
        const data = req.payload?.data;
        const isPaste = (req.type === 'send_input' || req.type === 'send_input_if_seq') && typeof data === 'string' && data.startsWith('\x1b[200~');
        if (!injected && isPaste && writes.some((s) => s.startsWith('\x1b[200~'))) {
            injected = true;
            await realHandle({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'local-user', ownerType: 'user', force: true } });
            await realHandle({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'local-user', data: 'X' } });
            await realHandle({ type: 'release_write', payload: { sessionId: 'r7-test', clientId: 'local-user' } });
            await realHandle({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'daemon', ownerType: 'user', force: true } });
        }
        return realHandle(req);
    } };
    const verdicts: string[] = [];
    try {
        driver.start(); emit('\x1b[?1049h' + inputRow('') + footer('? for shortcuts')); await vi.advanceTimersByTimeAsync(300);
        driver.observeSubmitUnconfirmed('task:first:n0', (verdict) => { verdicts.push(verdict); return true; }, async () => 'not_consumed');
        expect(driver.sendMessageWithDisposition('TASK ' + 'body '.repeat(100), false, 'task:first:n0').status).toBe('delivered');
        await vi.advanceTimersByTimeAsync(20_000);
        expect(injected).toBe(true);
        expect(writes.filter((s) => s.startsWith('\x1b[200~'))).toHaveLength(1);
        expect(composer).toBe('X');
        const at = writes.indexOf('X');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(writes.slice(at).filter((s) => s === '\r')).toHaveLength(0);
        expect(verdicts).toEqual([]);
    } finally { h.server = server; driver.shutdown(); await (transport as any).closeClient(false); }
});

it('R9-3 delayed-thinking-repaint: input consumed on Enter with a delayed screen/Thinking repaint is not cleared or pasted twice (production confirmLocalConsumption)', async () => {
    const { server, transport, writes } = await setup();
    const driver = new FsmDriver({ specPath: hostSpec(), workingDir: os.tmpdir(), hotReload: false, transportFactory: { spawn: () => transport } });
    let composer = '';
    const consumed: Array<{ text: string; at: number }> = [];
    const emit = (data: string) => server.emitEvent({ type: 'session_output', sessionId: 'r7-test', seq: 1, data });
    server.runtimes.set('r7-test', { write: (data: string) => {
        writes.push(data);
        if (data.startsWith('\x1b[200~')) {
            composer = `[Pasted text #${writes.filter((s) => s.startsWith('\x1b[200~')).length} +40 lines]`;
            emit(inputRow(composer));
        } else if (data === '\r') {
            if (composer) {
                consumed.push({ text: composer, at: Date.now() });
                composer = '';
                // Screen/Thinking repaint is delayed past the unsubmitted hold window.
                setTimeout(() => emit(inputRow('') + footer('Thinking')), 12_000);
            }
        } else if (data === '\x7f') {
            // Composer is already internally empty; a DEL triggers an empty-row repaint.
            composer = Array.from(composer).slice(0, -1).join('');
            emit(inputRow(composer));
        }
    } });
    const components = {
        instanceManager: { getInstance: () => ({ type: 'codex-cli' }) },
        commandHandler: {
            handle: vi.fn(async () => ({
                success: true,
                status: 'idle',
                transcriptAuthority: 'provider',
                coverage: 'full',
                providerSessionId: 'codex-session-r9-3',
                messageSource: { selected: 'native-history', providerType: 'codex-cli', identityStatus: 'safe', nativeSource: 'provider-native', nativeHistoryCoverage: 'full', coverage: { safeMapping: true }, staleness: { freshEnough: true } },
                messages: consumed.map((c) => ({ role: 'user', content: c.text, timestamp: c.at })),
                turnTerminalMarkers: [],
            })),
        },
    } as any;
    const verdicts: string[] = [];
    try {
        driver.start(); emit('\x1b[?1049h' + inputRow('') + footer('? for shortcuts')); await vi.advanceTimersByTimeAsync(300);
        driver.observeSubmitUnconfirmed('task:first:n0', (verdict) => { verdicts.push(verdict); return true; }, (sinceMs, opts) => confirmLocalConsumption(components, 'r7-test', sinceMs, opts));
        expect(driver.sendMessageWithDisposition('TASK ' + 'body '.repeat(100), false, 'task:first:n0').status).toBe('delivered');
        await vi.advanceTimersByTimeAsync(20_000);
        expect(consumed).toHaveLength(1);
        expect(writes.filter((s) => s.startsWith('\x1b[200~'))).toHaveLength(1);
        expect(writes.filter((s) => s === '\x7f')).toHaveLength(0);
        expect(verdicts).toEqual([]);
    } finally { driver.shutdown(); await (transport as any).closeClient(false); }
});

it('R10 delayed-repaint-stale-loading: real confirmLocalConsumption with stale/loading/empty read_chat and 120s delayed repaint consumes at most once (no second DEL or paste)', async () => {
    const { server, transport, writes } = await setup();
    const driver = new FsmDriver({ specPath: hostSpec(), workingDir: os.tmpdir(), hotReload: false, transportFactory: { spawn: () => transport } });
    let composer = '';
    const consumed: string[] = [];
    const emit = (data: string) => server.emitEvent({ type: 'session_output', sessionId: 'r7-test', seq: 1, data });
    server.runtimes.set('r7-test', { write: (data: string) => {
        writes.push(data);
        if (data.startsWith('\x1b[200~')) {
            composer = `[Pasted text #${writes.filter((s) => s.startsWith('\x1b[200~')).length} +40 lines]`;
            emit(inputRow(composer));
        } else if (data === '\r') {
            if (composer) {
                consumed.push(composer);
                composer = '';
                // Screen/Thinking repaint is delayed 120 s (past both hold windows).
                setTimeout(() => emit(inputRow('') + footer('Thinking')), 120_000);
            }
        } else if (data === '\x7f') {
            composer = Array.from(composer).slice(0, -1).join('');
            emit(inputRow(composer));
        }
    } });
    const components = {
        instanceManager: { getInstance: () => ({ type: 'codex-cli' }) },
        commandHandler: {
            handle: vi.fn(async () => ({
                success: true,
                messages: [],
                stale: true,
                unavailableReason: 'native_history_loading',
            })),
        },
    } as any;
    const verdicts: string[] = [];
    try {
        driver.start(); emit('\x1b[?1049h' + inputRow('') + footer('? for shortcuts')); await vi.advanceTimersByTimeAsync(300);
        driver.observeSubmitUnconfirmed('task:first:n0', (verdict) => { verdicts.push(verdict); return true; }, (sinceMs, opts) => confirmLocalConsumption(components, 'r7-test', sinceMs, opts));
        expect(driver.sendMessageWithDisposition('TASK ' + 'body '.repeat(100), false, 'task:first:n0').status).toBe('delivered');
        await vi.advanceTimersByTimeAsync(130_000);
        expect(consumed).toHaveLength(1);
        expect(writes.filter((s) => s.startsWith('\x1b[200~'))).toHaveLength(1);
        expect(writes.filter((s) => s === '\x7f')).toHaveLength(0);
        expect(verdicts).toEqual([]);
    } finally { driver.shutdown(); await (transport as any).closeClient(false); }
});

it('R8-2 end-to-end: never deletes an equal-label foreign chip after a counter reset and reconnect (restored-runtime)', async () => {
    const { server, transport, writes } = await setup();
    const driver = new FsmDriver({ specPath: hostSpec(), workingDir: os.tmpdir(), hotReload: false, transportFactory: { spawn: () => transport } });
    let composer = '';
    const emit = (data: string) => server.emitEvent({ type: 'session_output', sessionId: 'r7-test', seq: 1, data });
    server.runtimes.set('r7-test', { write: (data: string) => {
        writes.push(data);
        if (data.startsWith('\x1b[200~') || data === 'LOCAL HUMAN PASTE') { composer = '[Pasted text #1 +40 lines]'; emit(inputRow(composer)); }
        else if (data === '\x7f') { composer = ''; emit(inputRow(composer)); }
    } });
    try {
        driver.start(); emit('\x1b[?1049h' + inputRow('') + footer('? for shortcuts')); await vi.advanceTimersByTimeAsync(300);
        driver.observeSubmitUnconfirmed('task:first:n0', () => true);
        expect(driver.sendMessageWithDisposition('TASK ' + 'body '.repeat(100), false, 'task:first:n0').status).toBe('delivered');
        await vi.advanceTimersByTimeAsync(1);
        const before = transport.inputProvenance?.();
        expect(before).toMatchObject({ foreign: 0, gaps: 0, complete: true });
        expect(server.registry.getSession('r7-test').inputSeq).toBe(1);
        // The stream is lost and a persisted record is restored in a new
        // input-counter lifetime; announcements during the outage are not delivered.
        const savedEmit = server.emitEvent.bind(server);
        server.emitEvent = () => {};
        server.registry.restoreSession({ ...server.registry.getSession('r7-test'), inputSeq: 0 });
        await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', ownerType: 'user', force: true } });
        await server.handleRequest({ type: 'send_input', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal', data: 'LOCAL HUMAN PASTE' } });
        await server.handleRequest({ type: 'release_write', payload: { sessionId: 'r7-test', clientId: 'unattached-local-terminal' } });
        // The restored counter caught up to the previous value, but seq 1 was FOREIGN in the new lifetime.
        expect(server.registry.getSession('r7-test').inputSeq).toBe(1);
        h.disconnect?.();
        for (let i = 0; i < 30 && (transport as any).reconnecting; i++) await Promise.resolve();
        expect((transport as any).reconnecting).toBe(false);
        server.emitEvent = savedEmit;
        // The reviewer's probe recorded stale trust here (equal to before); now it never matches.
        expect(transport.inputProvenance?.()).not.toEqual(before);
        emit(inputRow(composer)); // fresh chip, same label as the old lifetime
        await vi.advanceTimersByTimeAsync(15_000);
        expect(writes.filter((s) => s === '\x7f')).toHaveLength(0);
        expect(composer).toBe('[Pasted text #1 +40 lines]');
    } finally { driver.shutdown(); await (transport as any).closeClient(false); }
});
