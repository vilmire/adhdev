import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { webSocketChannel, type PeerHandle, type Row, type Subscription, type WebSocketLike } from 'seqscribe';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    StandaloneTranscriptLane,
    deriveStandaloneTranscriptGrants,
    transcriptTopicSessionSegment,
} from '../../src/seqscribe/standalone-transcript-lane.js';
import { ensureSessionChatTopic } from '../../src/seqscribe/transcript-activation.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import { sessionChatPolicy, sessionChatTopic } from '../../src/seqscribe/topics.js';

/** A subscribe-only metadata ring that is NOT a transcript topic (fixture). */
const RING_TOPIC = 'test.status.ring';
function ringPolicy() {
    return { kind: 'append', retention: { mode: 'ring', size: 50 }, replication: 'subscribe-only', access: 'metadata' } as const;
}

/**
 * G6 prerequisite — the standalone dashboard replica lane, driven over a fake
 * WebSocket pair between two REAL seqscribe nodes.
 *
 * The daemon side is exactly what `daemon-standalone` wires: a node whose
 * transcript topic is defined through the production activation path
 * (`ensureSessionTranscriptTopic`), and a `StandaloneTranscriptLane.accept`
 * on the server half of the socket. The "browser" side mirrors the web-core
 * transcript worker: it attaches with `peerClass:'content'`, grants NOTHING
 * back, defines `sessionChatPolicy()` locally, and SUBs `view:'tail'`
 * (`transcript-session-subscription.ts`).
 *
 * The auth gate is NOT tested here — it lives in the HTTP upgrade router
 * (`daemon-standalone/src/standalone-seqscribe-upgrade.ts`), which has its own
 * test; `accept` is documented as "caller already authenticated".
 */

const FLEET_SECRET = 'standalone-lane-test-secret';
const SESSION_ID = 'sess-standalone-lane-1';
const TOPIC = sessionChatTopic(SESSION_ID);

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];
const lanes: StandaloneTranscriptLane[] = [];

afterEach(async () => {
    for (const lane of lanes.splice(0)) lane.close();
    for (const handle of handles.splice(0)) await handle.close().catch(() => {});
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-standalone-lane-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        // Supplied per call — never via process.env (other workers share this machine).
        env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: FLEET_SECRET },
        storedFleetSecret: null,
        meshIds: [],
    });
    handles.push(handle);
    return handle;
}

function newLane(node: SeqscribeNodeHandle, maxLanes?: number): StandaloneTranscriptLane {
    const lane = new StandaloneTranscriptLane(node, maxLanes === undefined ? {} : { maxLanes });
    lanes.push(lane);
    return lane;
}

interface FakeSocket extends WebSocketLike {
    closed: boolean;
    sent: number;
}

/**
 * A connected in-memory WebSocket pair with the `ws`/DOM EventTarget surface
 * `webSocketChannel` consumes (numeric `readyState`, `addEventListener`).
 * Delivery is deferred so a send never re-enters the peer session mid-handler.
 */
function socketPair(): [FakeSocket, FakeSocket] {
    type Listeners = { message: Array<(ev: { data: unknown }) => void>; close: Array<() => void>; open: Array<() => void> };
    const make = (): FakeSocket & { listeners: Listeners; other?: FakeSocket & { listeners: Listeners } } => {
        const listeners: Listeners = { message: [], close: [], open: [] };
        const sock: FakeSocket & { listeners: Listeners; other?: FakeSocket & { listeners: Listeners } } = {
            listeners,
            closed: false,
            sent: 0,
            get readyState() {
                return sock.closed ? 3 : 1;
            },
            send(data: string) {
                if (sock.closed) return;
                sock.sent += 1;
                const other = sock.other!;
                setTimeout(() => {
                    if (other.closed) return;
                    for (const cb of other.listeners.message) cb({ data });
                }, 0);
            },
            close() {
                if (sock.closed) return;
                sock.closed = true;
                for (const cb of listeners.close) cb();
                const other = sock.other!;
                setTimeout(() => other.close(), 0);
            },
            addEventListener(type: 'message' | 'close' | 'open', cb: any) {
                listeners[type].push(cb);
            },
        } as FakeSocket & { listeners: Listeners; other?: FakeSocket & { listeners: Listeners } };
        return sock;
    };
    const a = make();
    const b = make();
    a.other = b;
    b.other = a;
    return [a, b];
}

/** The browser half, shaped like `transcript-worker-entry.ts` + `transcript-session-subscription.ts`. */
function attachBrowser(browser: SeqscribeNodeHandle, socket: FakeSocket): PeerHandle {
    return browser.node.attach(webSocketChannel(socket), {
        peerId: 'daemon',
        peerClass: 'content',
        grants: {},
    });
}

function subscribeTail(browser: SeqscribeNodeHandle, peer: PeerHandle, topic: string) {
    const snaps: Row[][] = [];
    const deltas: Row[][] = [];
    const sub: Subscription = browser.node.subscribe(peer, { view: 'tail', params: { topic } });
    sub.onSnapshot((rows) => snaps.push(rows));
    sub.onDelta(({ upserts }) => deltas.push(upserts));
    return { sub, snaps, deltas };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function waitReady(peer: PeerHandle): Promise<void> {
    await waitFor(() => peer.state() === 'ready', 'peer ready');
}

function defineTranscript(daemon: SeqscribeNodeHandle, sessionId: string, claims = new TranscriptTopicClaimRegistry()) {
    const result = ensureSessionChatTopic(daemon, claims, sessionId, 'standalone_mach_test');
    expect(result.ok).toBe(true);
    return claims;
}

describe('deriveStandaloneTranscriptGrants', () => {
    it('grants serve on subscribe-only session transcript topics and nothing else', () => {
        const grants = deriveStandaloneTranscriptGrants([
            { topic: TOPIC, policy: sessionChatPolicy() },
            { topic: RING_TOPIC, policy: ringPolicy() },
            { topic: 'mesh.m1.events', policy: { kind: 'append', retention: { mode: 'full' }, replication: 'full-sync', access: 'content' } },
            // A full-sync topic that happens to look like a transcript must not be granted `serve`-as-`full` or at all.
            { topic: 'session.odd.chat', policy: { kind: 'append', retention: { mode: 'full' }, replication: 'full-sync', access: 'content' } },
            // The removed v1 whole-snapshot topic is never served (design 2026-09-28 §6).
            { topic: 'session.old.transcript', policy: { kind: 'append', retention: { mode: 'full' }, replication: 'subscribe-only', access: 'content' } },
        ] as SeqscribeNodeHandle['topics']);
        expect(grants).toEqual({ [TOPIC]: 'serve' });
    });

    it('parses the transcript session segment strictly', () => {
        expect(transcriptTopicSessionSegment(TOPIC)).not.toBeNull();
        expect(transcriptTopicSessionSegment('session..chat')).toBeNull();
        expect(transcriptTopicSessionSegment('session.a.b.chat')).toBeNull();
        expect(transcriptTopicSessionSegment('session.a.chatx')).toBeNull();
    });
});

describe('StandaloneTranscriptLane over a WebSocket pair (real nodes)', () => {
    it('SUB tail on a defined transcript topic delivers SNAP then DELTA rows', async () => {
        const daemon = openNode('daemon');
        const browser = openNode('browser');
        defineTranscript(daemon, SESSION_ID);
        await daemon.node.log(TOPIC).append('chat.meta.v2', { n: 1 }, { key: 'meta' });

        const lane = newLane(daemon);
        const [serverSock, browserSock] = socketPair();
        expect(lane.accept(serverSock)).toMatch(/^standalone_dashboard_/);
        expect(lane.grants()).toEqual({ [TOPIC]: 'serve' });

        const peer = attachBrowser(browser, browserSock);
        await waitReady(peer);
        browser.node.defineTopic(TOPIC, sessionChatPolicy());
        const { snaps, deltas } = subscribeTail(browser, peer, TOPIC);

        await waitFor(() => snaps.length > 0, 'SNAP');
        expect(snaps[0]!.map((r) => r.kind)).toEqual(['chat.meta.v2']);
        expect(snaps[0]![0]!.writer).toBe(daemon.writerId);

        await daemon.node.log(TOPIC).append('chat.commit.v2', { n: 2 }, { key: 'commit' });
        await waitFor(() => deltas.length > 0, 'DELTA');
        expect(deltas.flat().map((r) => r.kind)).toContain('chat.commit.v2');
    });

    it('a transcript topic activated AFTER the lane attached is re-advertised and becomes SUB-able', async () => {
        const daemon = openNode('daemon-late');
        const browser = openNode('browser-late');
        const lane = newLane(daemon);
        const [serverSock, browserSock] = socketPair();
        lane.accept(serverSock);
        expect(lane.grants()).toEqual({});

        const peer = attachBrowser(browser, browserSock);
        await waitReady(peer);

        // Production activation path — announces to the lane's listener.
        defineTranscript(daemon, SESSION_ID);
        expect(lane.grants()).toEqual({ [TOPIC]: 'serve' });
        await daemon.node.log(TOPIC).append('chat.meta.v2', { n: 1 }, { key: 'meta' });
        // Let the re-advertised HELLO land before the SUB goes out.
        await new Promise((r) => setTimeout(r, 150));

        browser.node.defineTopic(TOPIC, sessionChatPolicy());
        const { snaps } = subscribeTail(browser, peer, TOPIC);
        await waitFor(() => snaps.length > 0, 'SNAP after runtime activation');
        expect(snaps[0]!.map((r) => r.kind)).toEqual(['chat.meta.v2']);
    });

    it('a SUB sent before the topic existed stays dead; a fresh SUB after activation succeeds (why the dashboard re-SUBs)', async () => {
        const daemon = openNode('daemon-early-sub');
        const browser = openNode('browser-early-sub');
        const lane = newLane(daemon);
        const [serverSock, browserSock] = socketPair();
        lane.accept(serverSock);
        const peer = attachBrowser(browser, browserSock);
        await waitReady(peer);
        browser.node.defineTopic(TOPIC, sessionChatPolicy());
        const early = subscribeTail(browser, peer, TOPIC);
        await new Promise((r) => setTimeout(r, 150));

        defineTranscript(daemon, SESSION_ID);
        await daemon.node.log(TOPIC).append('chat.meta.v2', { n: 1 }, { key: 'meta' });
        await new Promise((r) => setTimeout(r, 400));
        // seqscribe answered the early SUB with SUB_ERR and does not retry it.
        expect(early.snaps).toEqual([]);

        // web-standalone's lane client closes + reopens the undelivered SUB.
        early.sub.close();
        const late = subscribeTail(browser, peer, TOPIC);
        await waitFor(() => late.snaps.length > 0, 'SNAP on re-SUB');
        expect(late.snaps[0]!.map((r) => r.kind)).toEqual(['chat.meta.v2']);
    });

    it('a subscribe-only topic outside the transcript grant is refused (no SNAP)', async () => {
        const daemon = openNode('daemon-deny');
        const browser = openNode('browser-deny');
        defineTranscript(daemon, SESSION_ID);
        // Another subscribe-only topic — the lane must still not serve it.
        daemon.node.defineTopic(RING_TOPIC, ringPolicy());
        daemon.topics.push({ topic: RING_TOPIC, policy: ringPolicy() });
        await daemon.node.log(RING_TOPIC).append('test.ring', { ok: true });

        const lane = newLane(daemon);
        const [serverSock, browserSock] = socketPair();
        lane.accept(serverSock);
        const peer = attachBrowser(browser, browserSock);
        await waitReady(peer);
        browser.node.defineTopic(RING_TOPIC, ringPolicy());
        const denied = subscribeTail(browser, peer, RING_TOPIC);
        await new Promise((r) => setTimeout(r, 400));
        expect(denied.snaps).toEqual([]);
    });

    it('close() detaches every lane and closes its socket; accept after close refuses', async () => {
        const daemon = openNode('daemon-close');
        const lane = newLane(daemon);
        const [serverSock] = socketPair();
        lane.accept(serverSock);
        expect(lane.laneCount()).toBe(1);
        lane.close();
        expect(lane.laneCount()).toBe(0);
        expect(serverSock.closed).toBe(true);

        const [lateSock] = socketPair();
        expect(lane.accept(lateSock)).toBeNull();
        expect(lateSock.closed).toBe(true);
    });

    it('evicts the oldest lane past the cap, and forgets a lane whose socket closed', async () => {
        const daemon = openNode('daemon-cap');
        const lane = newLane(daemon, 2);
        const [s1] = socketPair();
        const [s2] = socketPair();
        const [s3] = socketPair();
        lane.accept(s1);
        lane.accept(s2);
        lane.accept(s3);
        expect(lane.laneCount()).toBe(2);
        expect(s1.closed).toBe(true);

        s2.close();
        await waitFor(() => lane.laneCount() === 1, 'closed lane forgotten');
    });
});
