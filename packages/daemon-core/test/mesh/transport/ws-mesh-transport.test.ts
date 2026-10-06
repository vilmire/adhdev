// WsMeshTransport over real `ws` sockets on 127.0.0.1 (design §4.2): a host
// transport behind a WebSocketServer that runs the responder handshake and then
// acceptPeerSocket(), and a member transport that dials it with addHostLink().
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import {
    WsMeshTransport,
    WS_MESH_CLOSE_REPLACED,
    meshWsUrlForHostAddress,
    type WsMeshTransportOptions,
} from '../../../src/mesh/transport/ws-mesh-transport.js';
import { performMeshHandshake } from '../../../src/mesh/transport/mesh-peer-handshake.js';
import { mintPeerSecret } from '../../../src/mesh/transport/mesh-peer-secrets.js';
import { P2pRelayFailureError } from '../../../src/mesh/p2p-relay-failure.js';
import type { Peer } from '../../../src/mesh/transport/mesh-rpc-protocol.js';

const HOST = 'daemon_mach_wshost01';
const MEMBER = 'daemon_mach_wsmember01';
const MESH = 'mesh_ws_transport_test';
const FAST_RETRY = (): number => 50;

/** Records the structured [MeshCommand] events so tests can assert on ordering. */
class RecordingTransport extends WsMeshTransport {
    events: Array<{ event: string; fields: Record<string, unknown>; at: number }> = [];
    protected logEvent(event: string, fields: Record<string, unknown>): void {
        this.events.push({ event, fields, at: Date.now() });
    }
    peerForTest(daemonId: string): Peer | undefined {
        return (this as unknown as { peers: Map<string, Peer> }).peers.get(daemonId);
    }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    while (cleanups.length) {
        const fn = cleanups.pop()!;
        try { await fn(); } catch { /* best-effort teardown */ }
    }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function settledState<T>(promise: Promise<T>): { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } {
    const box: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { state: 'pending' };
    promise.then((value) => { box.state = 'resolved'; box.value = value; }, (error) => { box.state = 'rejected'; box.error = error; });
    return box;
}

async function expectMeshFailure(promise: Promise<unknown>, meshCode: string): Promise<P2pRelayFailureError> {
    try {
        await promise;
    } catch (err) {
        expect(err).toBeInstanceOf(P2pRelayFailureError);
        expect((err as P2pRelayFailureError).meshCode).toBe(meshCode);
        return err as P2pRelayFailureError;
    }
    throw new Error(`expected a ${meshCode} rejection, but the request resolved`);
}

interface HostHarness {
    host: RecordingTransport;
    url: string;
    /** Server-side sockets in accept order. */
    accepted: WebSocket[];
    /** Server-side sockets whose handshake failed. */
    rejected: WebSocket[];
}

async function startHost(options: WsMeshTransportOptions = {}, secret = mintPeerSecret()): Promise<HostHarness & { secret: string }> {
    const host = new RecordingTransport({ localDaemonId: HOST, ...options });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws/mesh' });
    await once(wss, 'listening');
    const accepted: WebSocket[] = [];
    const rejected: WebSocket[] = [];
    wss.on('connection', (ws) => {
        performMeshHandshake(ws, 'responder', {
            localDaemonId: HOST,
            resolveSecret: (meshId, daemonId) => (meshId === MESH && daemonId === MEMBER ? secret : null),
        }, 2_000).then((result) => {
            accepted.push(ws);
            host.acceptPeerSocket(ws, result);
        }, () => { rejected.push(ws); });
    });
    const port = (wss.address() as { port: number }).port;
    cleanups.push(async () => {
        host.close();
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    return { host, url: `ws://127.0.0.1:${port}/ws/mesh`, accepted, rejected, secret };
}

function startMember(options: WsMeshTransportOptions = {}): RecordingTransport {
    const member = new RecordingTransport({ localDaemonId: MEMBER, retryDelayMs: FAST_RETRY, ...options });
    cleanups.push(() => member.close());
    return member;
}

async function connectedPair(hostOptions: WsMeshTransportOptions = {}, memberOptions: WsMeshTransportOptions = {}) {
    const harness = await startHost(hostOptions);
    const member = startMember(memberOptions);
    member.addHostLink({ meshId: MESH, hostDaemonId: HOST, url: harness.url, secret: harness.secret });
    await waitFor(() => member.getPeerConnectionStatus(HOST)?.state === 'connected'
        && harness.host.getPeerConnectionStatus(MEMBER)?.state === 'connected', 5_000, 'link open');
    return { ...harness, member };
}

/** A raw member socket that completes the initiator handshake by hand. */
async function rawMember(url: string, secret: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    ws.on('error', () => { /* test socket */ });
    await performMeshHandshake(ws, 'initiator', { meshId: MESH, daemonId: MEMBER, serverDaemonIdExpected: HOST, secret }, 2_000);
    cleanups.push(() => ws.terminate());
    return ws;
}

async function freePortUrl(): Promise<string> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    const port = (wss.address() as { port: number }).port;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    return `ws://127.0.0.1:${port}/ws/mesh`;
}

describe('WsMeshTransport', () => {
    it('round-trips requests in both directions, flushing a request queued before the link opened', async () => {
        const harness = await startHost();
        const member = startMember();
        const opened: string[] = [];
        harness.host.onPeerLifecycle({ onPeerOpen: (id) => opened.push(`host:${id}`), onPeerClosed: () => {} });
        member.onPeerLifecycle({ onPeerOpen: (id) => opened.push(`member:${id}`), onPeerClosed: () => {} });
        harness.host.onCommand(async (sender, command, args) => ({ at: 'host', sender, command, echo: args.x }));
        member.onCommand(async (sender, command, args) => ({ at: 'member', sender, command, echo: args.x }));

        member.addHostLink({ meshId: MESH, hostDaemonId: HOST, url: harness.url, secret: harness.secret });
        // Issued before the dial completes: it must queue, then flush on open.
        const early = member.sendCommand(HOST, 'echo_cmd', { x: 1 });
        await expect(early).resolves.toEqual({ at: 'host', sender: MEMBER, command: 'echo_cmd', echo: 1 });
        expect(member.events.some((e) => e.event === 'queued')).toBe(true);

        // The host addresses the member by any id form.
        await expect(harness.host.sendCommand('standalone_mach_wsmember01', 'echo_cmd', { x: 2 }))
            .resolves.toEqual({ at: 'member', sender: HOST, command: 'echo_cmd', echo: 2 });

        expect(opened.sort()).toEqual([`host:${MEMBER}`, `member:${HOST}`]);
        expect(member.getPeerConnectionStatus(HOST)).toMatchObject({
            state: 'connected', transport: 'direct', directPeerTruthSatisfied: true, authority: 'live_peer',
        });
        expect(harness.host.listPeers()).toEqual([{ daemonId: MEMBER, state: 'connected', role: 'responder', meshIds: [MESH] }]);
        expect(member.listPeers()).toEqual([{ daemonId: HOST, state: 'connected', role: 'initiator', meshIds: [MESH] }]);
    });

    it('chunks and reassembles a 1.5 MB request and response', async () => {
        const { host, member } = await connectedPair();
        host.onCommand(async (_sender, _command, args) => ({ blob: args.blob, len: String(args.blob).length }));
        const blob = 'a'.repeat(750_000) + '한'.repeat(250_000) + 'z'.repeat(500_000);
        const result = await member.sendCommand(HOST, 'big_cmd', { blob }) as { blob: string; len: number };
        expect(result.len).toBe(blob.length);
        expect(result.blob === blob).toBe(true);
        expect(member.events.some((e) => e.event === 'chunked_send')).toBe(true);
        expect(host.events.some((e) => e.event === 'chunked_send')).toBe(true);
    });

    it('surfaces a handler throw as HANDLER_ERROR with the handler message', async () => {
        const { host, member } = await connectedPair();
        host.onCommand(async () => { throw new Error('boom-xyz handler failed'); });
        const err = await expectMeshFailure(member.sendCommand(HOST, 'explode'), 'HANDLER_ERROR');
        expect(err.message).toBe('boom-xyz handler failed');
    });

    it('rejects with REQUEST_TIMEOUT when the result deadline passes', async () => {
        const { host, member } = await connectedPair();
        host.onCommand(() => new Promise(() => { /* never settles */ }));
        const started = Date.now();
        const err = await expectMeshFailure(member.sendCommand(HOST, 'stall', {}, 300), 'REQUEST_TIMEOUT');
        expect(err.code).toBe('p2p_timeout');
        expect(Date.now() - started).toBeLessThan(2_000);
        // A timeout rejects only that request; the peer stays connected.
        expect(member.getPeerConnectionStatus(HOST)?.state).toBe('connected');
    });

    it('receives the ack before a slow handler returns and marks the peer ack-capable', async () => {
        const { host, member } = await connectedPair();
        host.onCommand(() => new Promise((resolve) => setTimeout(() => resolve('done'), 600)));
        const started = Date.now();
        await expect(member.sendCommand(HOST, 'slow_cmd')).resolves.toBe('done');
        const ack = member.events.find((e) => e.event === 'ack_received' && e.fields.command === 'slow_cmd');
        const res = member.events.find((e) => e.event === 'response_received' && e.fields.command === 'slow_cmd');
        expect(ack).toBeDefined();
        expect(res).toBeDefined();
        expect(ack!.at - started).toBeLessThan(400);
        expect(res!.at - ack!.at).toBeGreaterThanOrEqual(300);
        expect(member.peerForTest(HOST)?.supportsAck).toBe(true);
    });

    it('redials after the host closes the socket and serves a new request', async () => {
        const harness = await connectedPair();
        const { host, member, accepted } = harness;
        host.onCommand(async () => 'pong');
        const closed: string[] = [];
        const opened: string[] = [];
        member.onPeerLifecycle({ onPeerOpen: (id) => opened.push(id), onPeerClosed: (id) => closed.push(id) });
        expect(opened).toEqual([HOST]); // replayed for the late subscriber

        accepted[0].close(1012, 'host restart');
        await waitFor(() => closed.length === 1, 5_000, 'member sees the drop');
        await waitFor(() => opened.length === 2 && accepted.length === 2, 5_000, 'member redials');
        await expect(member.sendCommand(HOST, 'ping')).resolves.toBe('pong');

        // A second drop after the reconnect opened: the backoff ladder must restart at
        // attempt 2 again (one failure since the last opened connection), not climb to 3.
        accepted[1].close(1012, 'host restart again');
        await waitFor(() => closed.length === 2, 5_000, 'second drop');
        await waitFor(() => opened.length === 3 && accepted.length === 3, 5_000, 'second redial');
        await expect(member.sendCommand(HOST, 'ping')).resolves.toBe('pong');
        const dials = member.events.filter((e) => e.event === 'connect_begin');
        expect(dials.map((e) => e.fields.attempt)).toEqual([1, 2, 2]);
    });

    it('stops redialing once the host link is removed', async () => {
        const harness = await connectedPair();
        const { member, accepted } = harness;
        expect(member.removeHostLink(HOST)).toBe(true);
        await waitFor(() => member.getPeerConnectionStatus(HOST)?.authority !== 'live_peer', 2_000, 'peer torn down');
        await new Promise((r) => setTimeout(r, 300));
        expect(accepted.length).toBe(1);
        await expectMeshFailure(member.sendCommand(HOST, 'ping', {}, undefined, 200), 'PEER_NOT_CONNECTED');
    });

    it('gives a probe request PEER_NOT_CONNECTED within its budget while a full-wait request stays queued', async () => {
        const member = startMember();
        const url = await freePortUrl();
        member.addHostLink({ meshId: MESH, hostDaemonId: HOST, url, secret: mintPeerSecret() });

        const full = settledState(member.sendCommand(HOST, 'targeted_cmd'));
        const started = Date.now();
        const err = await expectMeshFailure(member.sendCommand(HOST, 'get_status_metadata', {}, undefined, 300), 'PEER_NOT_CONNECTED');
        expect(err.code).toBe('p2p_not_connected');
        expect(err.recoverable).toBe(true);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(1_500);

        await waitFor(() => member.events.filter((e) => e.event === 'dial_failed').length >= 2, 3_000, 'redial attempts');
        expect(full.state).toBe('pending');
        const status = member.getPeerConnectionStatus(HOST);
        expect(status?.state).toBe('connecting');
        expect(status?.directPeerTruthSatisfied).toBe(false);
        expect(status?.lastFailureCode).toBe('DIAL_FAILED');

        member.close();
        await waitFor(() => full.state !== 'pending', 1_000, 'full-wait request settles');
        expect(full.state).toBe('rejected');
        expect((full.error as P2pRelayFailureError).meshCode).toBe('MANAGER_SHUTDOWN');
        await expectMeshFailure(member.sendCommand(HOST, 'after_close'), 'MANAGER_SHUTDOWN');
    });

    it('refuses a request addressed to itself in any id form', async () => {
        const member = startMember();
        for (const self of [MEMBER, 'mach_wsmember01', 'standalone_mach_wsmember01']) {
            const err = await expectMeshFailure(member.sendCommand(self, 'loop'), 'SELF_DIAL');
            expect(err.message).toContain('own id');
        }
        expect(member.listPeers()).toEqual([]);
        expect(() => member.addHostLink({ meshId: MESH, hostDaemonId: 'mach_wsmember01', url: 'ws://127.0.0.1:1/ws/mesh', secret: 's' }))
            .toThrow(/this daemon/);
    });

    it('never opens a link with the wrong secret and leaks no request to the host', async () => {
        const harness = await startHost();
        let handled = 0;
        harness.host.onCommand(async () => { handled += 1; return 'should-not-run'; });
        const member = startMember();
        member.addHostLink({ meshId: MESH, hostDaemonId: HOST, url: harness.url, secret: mintPeerSecret() });

        await waitFor(() => harness.rejected.length >= 2, 5_000, 'repeated handshake rejections');
        const status = member.getPeerConnectionStatus(HOST);
        expect(['failed', 'connecting']).toContain(status?.state);
        expect(status?.directPeerTruthSatisfied).toBe(false);
        await waitFor(() => !!member.getPeerConnectionStatus(HOST)?.lastFailureCode?.startsWith('HANDSHAKE_'), 2_000, 'handshake failure code');

        await expectMeshFailure(member.sendCommand(HOST, 'get_status_metadata', {}, undefined, 300), 'PEER_NOT_CONNECTED');
        expect(handled).toBe(0);
        expect(harness.accepted).toEqual([]);
        expect(harness.host.listPeers()).toEqual([]);
        // Nothing about the secret reaches the structured log.
        expect(JSON.stringify(member.events)).not.toContain(harness.secret);
    });

    it('replaces the socket when the same member is accepted again', async () => {
        const harness = await startHost();
        const { host, url, secret } = harness;
        const opened: string[] = [];
        const closed: string[] = [];
        host.onPeerLifecycle({ onPeerOpen: (id) => opened.push(id), onPeerClosed: (id) => closed.push(id) });

        const first = await rawMember(url, secret);
        const firstClosed = once(first, 'close');
        await waitFor(() => host.listPeers().length === 1 && host.listPeers()[0].state === 'connected', 2_000, 'first accept');
        const second = await rawMember(url, secret);
        const [code] = await firstClosed as [number];
        expect(code).toBe(WS_MESH_CLOSE_REPLACED);
        await waitFor(() => opened.length === 2, 2_000, 'replacement open');
        expect(closed).toEqual([MEMBER]);
        expect(host.listPeers()).toEqual([{ daemonId: MEMBER, state: 'connected', role: 'responder', meshIds: [MESH] }]);

        // A host request now rides the replacement socket; answer it by hand.
        second.on('message', (raw) => {
            const frame = JSON.parse(raw.toString());
            if (frame.kind === 'rpc_req') {
                second.send(JSON.stringify({ v: 1, kind: 'rpc_ack', id: frame.id }));
                second.send(JSON.stringify({ v: 1, kind: 'rpc_res', id: frame.id, ok: true, result: { via: 'second' } }));
            }
        });
        await expect(host.sendCommand(MEMBER, 'which_socket')).resolves.toEqual({ via: 'second' });
    });

    it('terminates a socket that stops answering pings and fails its peer', async () => {
        const harness = await startHost({ pingIntervalMs: 80, maxMissedPongs: 2 });
        const { host, url, secret } = harness;
        const closed: string[] = [];
        host.onPeerLifecycle({ onPeerOpen: () => {}, onPeerClosed: (id) => closed.push(id) });
        const silent = await rawMember(url, secret);
        // Suppress the automatic pong so the host sees a dead peer.
        (silent as unknown as { pong: () => void }).pong = () => {};
        await waitFor(() => host.listPeers().length === 1, 2_000, 'accept');
        await waitFor(() => closed.length === 1, 3_000, 'liveness teardown');
        expect(host.getPeerConnectionStatus(MEMBER)?.lastFailureCode).toBe('PEER_UNRESPONSIVE');
        expect(host.events.some((e) => e.event === 'liveness_lost')).toBe(true);
    });

    it('builds the mesh URL from a stored host address', () => {
        expect(meshWsUrlForHostAddress('192.168.0.10:3847')).toBe('ws://192.168.0.10:3847/ws/mesh');
        expect(meshWsUrlForHostAddress('[fd7a::1]:3847')).toBe('ws://[fd7a::1]:3847/ws/mesh');
        expect(meshWsUrlForHostAddress('ws://h:1/x')).toBe('ws://h:1/ws/mesh');
        expect(meshWsUrlForHostAddress('host.ts.net:3847', '/ws/mesh-seqscribe')).toBe('ws://host.ts.net:3847/ws/mesh-seqscribe');
    });
});
