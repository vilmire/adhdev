import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { Channel, PeerHandle, PeerHandleExt, PeerLifecycleEvent, Row, WebSocketLike } from 'seqscribe';
import { announceTopicActivated } from '../../src/seqscribe/mesh-publisher.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    STANDALONE_MESH_SEQSCRIBE_PEER_CLASS,
    StandaloneMeshSeqscribe,
    deriveMeshPeerGrants,
} from '../../src/seqscribe/standalone-mesh-seqscribe.js';
import { loadStoredLocalAuthoritySecret } from '../../src/seqscribe/local-authority.js';
import { ensureSessionChatTopic } from '../../src/seqscribe/transcript-activation.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import {
    meshEventsPolicy,
    meshEventsTopic,
    meshHandoffPolicy,
    meshHandoffTopic,
    sessionChatPolicy,
    sessionChatTopic,
} from '../../src/seqscribe/topics.js';

/**
 * Standalone daemon⇄daemon seqscribe replication (design
 * 2026-10-07-standalone-multi-machine-mesh §4.5).
 *
 * The unit half drives `StandaloneMeshSeqscribe` against a fake node whose
 * `attach` records calls and returns a scripted `PeerHandleExt`; the
 * integration half runs two REAL seqscribe nodes — each with its OWN
 * machine-local authority secret, no shared fleet secret (§8 risk 1) — over a
 * real `ws` socket on 127.0.0.1.
 *
 * The §4.4 HMAC handshake is NOT exercised here: `attachHostLink`'s `dial`
 * and `acceptMemberSocket`'s socket are documented as already authenticated
 * (the handshake module and the upgrade route have their own tests).
 */

const MESH_ID = 'standalone-mesh-1';
const HOST_ID = 'standalone_mach_host0001';
const MEMBER_ID = 'standalone_mach_member01';
const HOST_PEER = 'daemon_mach_host0001';
const MEMBER_PEER = 'daemon_mach_member01';

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
        try {
            await fn();
        } catch {
            // best effort
        }
    }
});

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakePeer extends PeerHandleExt {
    readonly grantsSeen: Array<Record<string, string>>;
    detached: boolean;
    emit(event: PeerLifecycleEvent): void;
}

function fakePeer(peerId: string): FakePeer {
    const lifecycle: Array<(e: PeerLifecycleEvent) => void> = [];
    let state: 'attached' | 'ready' | 'closed' = 'attached';
    const peer: FakePeer = {
        peerId,
        grantsSeen: [],
        detached: false,
        state: () => state,
        onStateChange: () => () => {},
        detach() {
            peer.detached = true;
            peer.emit({ peerId, event: 'closed', reason: 'detach' } as PeerLifecycleEvent);
        },
        closeReason: () => null,
        onLifecycle(cb) {
            lifecycle.push(cb);
            return () => {};
        },
        updateGrants(grants) {
            peer.grantsSeen.push({ ...grants });
        },
        emit(event) {
            if (event.event === 'closed') state = 'closed';
            else if (event.event === 'ready') state = 'ready';
            for (const cb of [...lifecycle]) cb(event);
        },
    };
    return peer;
}

interface AttachCall {
    readonly channel: Channel;
    readonly opts: { peerId: string; peerClass: string; grants: Record<string, string> };
    readonly peer: FakePeer;
    readonly received: string[];
}

function fakeNode(topics: SeqscribeNodeHandle['topics']) {
    const calls: AttachCall[] = [];
    const closeHooks: Array<() => void> = [];
    const handle = {
        writerId: 'adhdev-fake',
        daemonId: HOST_ID,
        dbPath: ':memory:',
        topics,
        authorityEnabled: true,
        authorityIsLocal: true,
        finalityLoop: null,
        onClose(fn: () => void) {
            closeHooks.push(fn);
        },
        async close() {
            for (const fn of closeHooks.splice(0)) fn();
        },
        node: {
            attach(channel: Channel, opts: AttachCall['opts']) {
                const peer = fakePeer(opts.peerId);
                const received: string[] = [];
                // A real Session registers its message callback at construction.
                channel.onMessage((m) => received.push(m));
                channel.onClose(() => peer.emit({ peerId: opts.peerId, event: 'closed', reason: 'transport' } as PeerLifecycleEvent));
                calls.push({ channel, opts: { ...opts, grants: { ...opts.grants } }, peer, received });
                return peer;
            },
        },
    } as unknown as SeqscribeNodeHandle;
    return { handle, calls };
}

interface FakeSocket extends WebSocketLike {
    closed: boolean;
    readonly sent: string[];
    receive(data: string): void;
}

function fakeSocket(): FakeSocket {
    const listeners = { message: [] as Array<(ev: { data: unknown }) => void>, close: [] as Array<() => void>, open: [] as Array<() => void> };
    const sock: FakeSocket = {
        closed: false,
        sent: [],
        get readyState() {
            return sock.closed ? 3 : 1;
        },
        send(data: string) {
            sock.sent.push(data);
        },
        close() {
            if (sock.closed) return;
            sock.closed = true;
            for (const cb of [...listeners.close]) cb();
        },
        addEventListener(type: 'message' | 'close' | 'open', cb: any) {
            listeners[type].push(cb);
        },
        receive(data: string) {
            for (const cb of [...listeners.message]) cb({ data });
        },
    } as FakeSocket;
    return sock;
}

const TOPICS = (): SeqscribeNodeHandle['topics'] => [
    { topic: meshEventsTopic(MESH_ID), policy: meshEventsPolicy() },
    { topic: meshHandoffTopic(MESH_ID), policy: meshHandoffPolicy() },
    { topic: sessionChatTopic('sess-1'), policy: sessionChatPolicy() },
    { topic: 'config.settings', policy: { kind: 'register', retention: { mode: 'full' }, replication: 'full-sync', access: 'metadata' } },
] as SeqscribeNodeHandle['topics'];

function newMesh(node: SeqscribeNodeHandle, localDaemonId: string, extra: { firstFrameTimeoutMs?: number } = {}) {
    const mesh = new StandaloneMeshSeqscribe(node, {
        localDaemonId,
        backoff: { minMs: 5, maxMs: 20 },
        ...extra,
    });
    cleanups.push(() => mesh.close());
    return mesh;
}

// ─── Unit ───────────────────────────────────────────────────────────────────

describe('deriveMeshPeerGrants', () => {
    it('grants every node topic: serve for subscribe-only, full for everything else', () => {
        expect(deriveMeshPeerGrants(TOPICS())).toEqual({
            [meshEventsTopic(MESH_ID)]: 'full',
            [meshHandoffTopic(MESH_ID)]: 'full',
            [sessionChatTopic('sess-1')]: 'serve',
            'config.settings': 'full',
        });
    });

    it('returns a fresh map each call (no shared mutable state)', () => {
        const topics = TOPICS();
        const a = deriveMeshPeerGrants(topics);
        a['injected'] = 'full';
        expect(deriveMeshPeerGrants(topics)).not.toHaveProperty('injected');
    });
});

describe('StandaloneMeshSeqscribe — member side (attachHostLink)', () => {
    it('dials the host and attaches a content peer under the canonical host id with the derived grants', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, MEMBER_ID);
        const socket = fakeSocket();
        const dial = vi.fn(async () => socket);

        expect(mesh.attachHostLink(MESH_ID, HOST_ID, dial)).toBe(true);
        await waitFor(() => calls.length === 1, 'attach');

        expect(dial).toHaveBeenCalledTimes(1);
        expect(calls[0]!.opts.peerId).toBe(HOST_PEER);
        expect(calls[0]!.opts.peerClass).toBe(STANDALONE_MESH_SEQSCRIBE_PEER_CLASS);
        expect(calls[0]!.opts.grants).toEqual(deriveMeshPeerGrants(TOPICS()));
        expect(mesh.peerIds()).toEqual([HOST_PEER]);
        // Any id form of the same machine resolves the same handle.
        expect(mesh.resolveTranscriptPeer('mach_host0001')).toBe(calls[0]!.peer);
        expect(mesh.resolveTranscriptPeer(HOST_ID)).toBe(calls[0]!.peer);
        expect(mesh.resolveTranscriptPeer(MEMBER_ID)).toBeNull();
    });

    it('retries a failed dial with backoff, and redials after the session closes', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, MEMBER_ID);
        let n = 0;
        const dial = vi.fn(async () => {
            n += 1;
            if (n === 1) throw new Error('ECONNREFUSED');
            return fakeSocket();
        });
        mesh.attachHostLink(MESH_ID, HOST_ID, dial);
        await waitFor(() => calls.length === 1, 'attach after retry');
        expect(dial).toHaveBeenCalledTimes(2);

        calls[0]!.peer.emit({ peerId: HOST_PEER, event: 'closed', reason: 'transport' } as PeerLifecycleEvent);
        expect(mesh.resolveTranscriptPeer(HOST_ID)).toBeNull();
        await waitFor(() => calls.length === 2, 'redial');
        expect(mesh.resolveTranscriptPeer(HOST_ID)).toBe(calls[1]!.peer);
    });

    it('refuses a link to itself or to an empty id', () => {
        const { handle } = fakeNode(TOPICS());
        const mesh = newMesh(handle, MEMBER_ID);
        const dial = vi.fn(async () => fakeSocket());
        expect(mesh.attachHostLink(MESH_ID, 'mach_member01', dial)).toBe(false);
        expect(mesh.attachHostLink(MESH_ID, '', dial)).toBe(false);
        expect(dial).not.toHaveBeenCalled();
        expect(mesh.peerIds()).toEqual([]);
    });

    it('reuses one link for a second mesh hosted by the same daemon; detachMesh ends it only with the last mesh', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, MEMBER_ID);
        const dial = vi.fn(async () => fakeSocket());
        mesh.attachHostLink(MESH_ID, HOST_ID, dial);
        await waitFor(() => calls.length === 1, 'attach');
        expect(mesh.attachHostLink('other-mesh', HOST_ID, dial)).toBe(true);
        await tick();
        expect(dial).toHaveBeenCalledTimes(1);

        mesh.detachMesh(MESH_ID, HOST_ID);
        expect(calls[0]!.peer.detached).toBe(false);
        mesh.detachMesh('other-mesh', HOST_ID);
        expect(calls[0]!.peer.detached).toBe(true);
        expect(mesh.peerIds()).toEqual([]);
    });

    it('a second call for the SAME mesh replaces the loop (re-pair) and ends the previous session', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, MEMBER_ID);
        mesh.attachHostLink(MESH_ID, HOST_ID, async () => fakeSocket());
        await waitFor(() => calls.length === 1, 'first attach');
        mesh.attachHostLink(MESH_ID, HOST_ID, async () => fakeSocket());
        await waitFor(() => calls.length === 2, 'second attach');
        expect(calls[0]!.peer.detached).toBe(true);
        expect(mesh.resolveTranscriptPeer(HOST_ID)).toBe(calls[1]!.peer);
        // The stopped loop must not redial after its session closed.
        await new Promise((r) => setTimeout(r, 60));
        expect(calls).toHaveLength(2);
    });

    it('a socket that arrives after the link was detached is closed, never attached', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, MEMBER_ID);
        let resolveDial!: (s: WebSocketLike) => void;
        const socket = fakeSocket();
        mesh.attachHostLink(MESH_ID, HOST_ID, () => new Promise((r) => { resolveDial = r; }));
        await tick();
        mesh.detach(HOST_ID);
        resolveDial(socket);
        await tick();
        await tick();
        expect(calls).toHaveLength(0);
        expect(socket.closed).toBe(true);
    });
});

describe('StandaloneMeshSeqscribe — host side (acceptMemberSocket)', () => {
    it('defers attach until the member\'s first frame, then replays that frame into the session', () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, HOST_ID);
        const socket = fakeSocket();

        expect(mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, socket)).toBe(true);
        // Nothing attached yet, so the host cannot have sent its HELLO.
        expect(calls).toHaveLength(0);
        expect(socket.sent).toEqual([]);
        expect(mesh.peerIds()).toEqual([MEMBER_PEER]);
        expect(mesh.resolveTranscriptPeer(MEMBER_ID)).toBeNull();

        socket.receive('{"t":"HELLO","member":1}');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.opts.peerId).toBe(MEMBER_PEER);
        expect(calls[0]!.opts.peerClass).toBe('content');
        expect(calls[0]!.opts.grants).toEqual(deriveMeshPeerGrants(TOPICS()));
        expect(calls[0]!.received).toEqual(['{"t":"HELLO","member":1}']);

        socket.receive('{"t":"NEXT"}');
        expect(calls[0]!.received).toEqual(['{"t":"HELLO","member":1}', '{"t":"NEXT"}']);
        calls[0]!.channel.send('{"t":"HELLO","host":1}');
        expect(socket.sent).toEqual(['{"t":"HELLO","host":1}']);
        expect(mesh.resolveTranscriptPeer('mach_member01')).toBe(calls[0]!.peer);
    });

    it('a newer socket for the same member replaces the previous session and closes its socket', () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, HOST_ID);
        const first = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, first);
        first.receive('hello-1');
        const second = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, 'mach_member01', second);

        expect(calls[0]!.peer.detached).toBe(true);
        expect(first.closed).toBe(true);
        expect(mesh.peerIds()).toEqual([MEMBER_PEER]);
        second.receive('hello-2');
        expect(calls).toHaveLength(2);
        expect(mesh.resolveTranscriptPeer(MEMBER_ID)).toBe(calls[1]!.peer);
        // The old session's close event must not evict the replacement.
        expect(mesh.peerIds()).toEqual([MEMBER_PEER]);
    });

    it('a pending (pre-first-frame) socket replaced by a newer one is closed and never attached', () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, HOST_ID);
        const first = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, first);
        const second = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, second);
        expect(first.closed).toBe(true);
        first.receive('late');
        expect(calls).toHaveLength(0);
        second.receive('hello');
        expect(calls).toHaveLength(1);
    });

    it('drops a member that never sends a first frame', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, HOST_ID, { firstFrameTimeoutMs: 20 });
        const socket = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, socket);
        await waitFor(() => socket.closed, 'socket closed');
        expect(calls).toHaveLength(0);
        expect(mesh.peerIds()).toEqual([]);
    });

    it('drops the entry when the member socket closes, and refuses a self/empty id', () => {
        const { handle } = fakeNode(TOPICS());
        const mesh = newMesh(handle, HOST_ID);
        const socket = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, socket);
        socket.receive('hello');
        socket.close();
        expect(mesh.peerIds()).toEqual([]);
        expect(mesh.resolveTranscriptPeer(MEMBER_ID)).toBeNull();

        const self = fakeSocket();
        expect(mesh.acceptMemberSocket(MESH_ID, 'mach_host0001', self)).toBe(false);
        expect(self.closed).toBe(true);
        const empty = fakeSocket();
        expect(mesh.acceptMemberSocket(MESH_ID, '', empty)).toBe(false);
        expect(empty.closed).toBe(true);
    });
});

describe('StandaloneMeshSeqscribe — grants re-advertisement and teardown', () => {
    it('a runtime topic activation re-advertises the full fresh map to every link and every accepted member', async () => {
        const topics = TOPICS();
        const { handle, calls } = fakeNode(topics);
        const mesh = newMesh(handle, 'standalone_mach_middle01');
        mesh.attachHostLink(MESH_ID, HOST_ID, async () => fakeSocket());
        await waitFor(() => calls.length === 1, 'link attach');
        const memberSocket = fakeSocket();
        mesh.acceptMemberSocket('mesh-2', MEMBER_ID, memberSocket);
        memberSocket.receive('hello');
        expect(calls).toHaveLength(2);

        const newTopic = sessionChatTopic('sess-late');
        topics.push({ topic: newTopic, policy: sessionChatPolicy() } as SeqscribeNodeHandle['topics'][number]);
        announceTopicActivated(handle, newTopic);

        const expected = deriveMeshPeerGrants(topics);
        expect(expected[newTopic]).toBe('serve');
        for (const call of calls) {
            expect(call.peer.grantsSeen.at(-1)).toEqual(expected);
        }
    });

    it('a redial after updateGrants advertises the updated map', async () => {
        const topics = TOPICS();
        const { handle, calls } = fakeNode(topics);
        const mesh = newMesh(handle, MEMBER_ID);
        mesh.attachHostLink(MESH_ID, HOST_ID, async () => fakeSocket());
        await waitFor(() => calls.length === 1, 'attach');
        const newTopic = meshEventsTopic('mesh-late');
        topics.push({ topic: newTopic, policy: meshEventsPolicy() } as SeqscribeNodeHandle['topics'][number]);
        announceTopicActivated(handle, newTopic);

        calls[0]!.peer.emit({ peerId: HOST_PEER, event: 'closed', reason: 'transport' } as PeerLifecycleEvent);
        await waitFor(() => calls.length === 2, 'redial');
        expect(calls[1]!.opts.grants[newTopic]).toBe('full');
    });

    it('detach ends both roles for a peer; node close closes everything and later calls are refused', async () => {
        const { handle, calls } = fakeNode(TOPICS());
        const mesh = newMesh(handle, 'standalone_mach_middle01');
        mesh.attachHostLink(MESH_ID, HOST_ID, async () => fakeSocket());
        await waitFor(() => calls.length === 1, 'link attach');
        const memberSocket = fakeSocket();
        mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, memberSocket);
        memberSocket.receive('hello');

        mesh.detach(HOST_ID);
        expect(calls[0]!.peer.detached).toBe(true);
        expect(mesh.peerIds()).toEqual([MEMBER_PEER]);

        await handle.close();
        expect(calls[1]!.peer.detached).toBe(true);
        expect(memberSocket.closed).toBe(true);
        expect(mesh.peerIds()).toEqual([]);
        const late = fakeSocket();
        expect(mesh.acceptMemberSocket(MESH_ID, MEMBER_ID, late)).toBe(false);
        expect(late.closed).toBe(true);
        expect(mesh.attachHostLink(MESH_ID, HOST_ID, async () => fakeSocket())).toBe(false);
    });
});

// ─── Integration: two real nodes over ws on 127.0.0.1 ───────────────────────

function openRealNode(name: string, daemonId: string): { handle: SeqscribeNodeHandle; env: NodeJS.ProcessEnv } {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-mesh-seq-${name}-`));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // Each machine gets its OWN config dir → its own local authority secret.
    // No ADHDEV_SEQSCRIBE_FLEET_SECRET anywhere: §8 risk 1 is "no shared secret".
    const env: NodeJS.ProcessEnv = { ADHDEV_CONFIG_DIR: join(dir, 'config') };
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env,
        storedFleetSecret: null,
        meshIds: [MESH_ID],
        daemonId,
    });
    cleanups.push(() => handle.close());
    return { handle, env };
}

async function startHostServer(onSocket: (ws: WebSocket) => void): Promise<string> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws) => onSocket(ws));
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
    }));
    const address = wss.address();
    if (typeof address === 'string' || address === null) throw new Error('unexpected address');
    return `ws://127.0.0.1:${address.port}/ws/mesh-seqscribe`;
}

function dialOpen(url: string): () => Promise<WebSocketLike> {
    return () => new Promise<WebSocketLike>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('open', () => resolve(ws as unknown as WebSocketLike));
        ws.once('error', reject);
    });
}

function logRows(handle: SeqscribeNodeHandle, topic: string): number {
    return handle.node.stats().topics[topic]?.logRows ?? 0;
}

describe('StandaloneMeshSeqscribe — two real nodes over ws://127.0.0.1 (no shared fleet secret)', () => {
    it('replicates mesh events (metadata) and handoff (content, finality-bound) both ways and serves a member transcript to the host', async () => {
        const host = openRealNode('host', HOST_ID);
        const member = openRealNode('member', MEMBER_ID);

        // Precondition of the §8 risk-1 check: two different local authorities.
        expect(host.handle.authorityIsLocal).toBe(true);
        expect(member.handle.authorityIsLocal).toBe(true);
        const hostSecret = loadStoredLocalAuthoritySecret(host.env);
        const memberSecret = loadStoredLocalAuthoritySecret(member.env);
        expect(hostSecret).toBeTruthy();
        expect(memberSecret).toBeTruthy();
        expect(hostSecret === memberSecret).toBe(false);

        const hostMesh = newMesh(host.handle, HOST_ID);
        const memberMesh = newMesh(member.handle, MEMBER_ID);
        const url = await startHostServer((ws) => {
            hostMesh.acceptMemberSocket(MESH_ID, MEMBER_ID, ws as unknown as WebSocketLike);
        });
        expect(memberMesh.attachHostLink(MESH_ID, HOST_ID, dialOpen(url))).toBe(true);

        await waitFor(() => memberMesh.resolveTranscriptPeer(HOST_ID)?.state() === 'ready', 'member→host ready');
        await waitFor(() => hostMesh.resolveTranscriptPeer(MEMBER_ID)?.state() === 'ready', 'host→member ready');

        const events = meshEventsTopic(MESH_ID);
        const handoff = meshHandoffTopic(MESH_ID);
        await member.handle.node.log(events).append('mesh.event', { id: 'm-e1', kind: 'task_dispatched', taskId: 't1' });
        await member.handle.node.log(handoff).append('worker.handoff', { taskId: 't1', ref: 'r1' });
        await waitFor(() => logRows(host.handle, events) === 1, 'member event on host');
        await waitFor(() => logRows(host.handle, handoff) === 1, 'member handoff on host');

        await host.handle.node.log(events).append('mesh.event', { id: 'h-e1', kind: 'task_completed', taskId: 't1' });
        await waitFor(() => logRows(member.handle, events) === 2, 'host event on member');

        // A session transcript defined on the member AFTER the link is up: the
        // activation re-advertises grants, and the host SUBs it through
        // resolveTranscriptPeer — the host dashboard's read path.
        const claims = new TranscriptTopicClaimRegistry();
        expect(ensureSessionChatTopic(member.handle, claims, 'sess-remote', MEMBER_ID).ok).toBe(true);
        const chat = sessionChatTopic('sess-remote');
        await member.handle.node.log(chat).append('chat.meta.v2', { n: 1 }, { key: 'meta' });
        await new Promise((r) => setTimeout(r, 150));

        host.handle.node.defineTopic(chat, sessionChatPolicy());
        const peer = hostMesh.resolveTranscriptPeer(MEMBER_ID) as PeerHandle;
        const snaps: Row[][] = [];
        host.handle.node.subscribe(peer, { view: 'tail', params: { topic: chat } }).onSnapshot((rows) => snaps.push(rows));
        await waitFor(() => snaps.length > 0, 'transcript SNAP on host');
        expect(snaps[0]!.map((r) => r.kind)).toEqual(['chat.meta.v2']);
        expect(snaps[0]![0]!.writer).toBe(member.handle.writerId);
    }, 30_000);

    it('the member redials after the host drops the socket and replication resumes', async () => {
        const host = openRealNode('host-redial', HOST_ID);
        const member = openRealNode('member-redial', MEMBER_ID);
        const hostMesh = newMesh(host.handle, HOST_ID);
        const memberMesh = newMesh(member.handle, MEMBER_ID);
        const accepted: WebSocket[] = [];
        const url = await startHostServer((ws) => {
            accepted.push(ws);
            hostMesh.acceptMemberSocket(MESH_ID, MEMBER_ID, ws as unknown as WebSocketLike);
        });
        memberMesh.attachHostLink(MESH_ID, HOST_ID, dialOpen(url));
        await waitFor(() => hostMesh.resolveTranscriptPeer(MEMBER_ID)?.state() === 'ready', 'first session ready');

        accepted[0]!.terminate();
        await waitFor(() => accepted.length >= 2, 'member redialed');
        await waitFor(() => hostMesh.resolveTranscriptPeer(MEMBER_ID)?.state() === 'ready', 'second session ready');

        const events = meshEventsTopic(MESH_ID);
        await member.handle.node.log(events).append('mesh.event', { id: 'after-redial', kind: 'task_dispatched', taskId: 't2' });
        await waitFor(() => logRows(host.handle, events) === 1, 'event after redial on host');
    }, 30_000);
});
