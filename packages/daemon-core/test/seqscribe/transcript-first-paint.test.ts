import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { webSocketChannel, type PeerHandle, type Row, type Subscription, type WebSocketLike } from 'seqscribe';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { StandaloneTranscriptLane } from '../../src/seqscribe/standalone-transcript-lane.js';
import { sessionChatPolicy, sessionChatTopic } from '../../src/seqscribe/topics.js';
import { subscribeTranscriptProjection } from '../../src/seqscribe/transcript-bus-subscriber.js';
import { KeyedTranscriptFolder, parseChatSubRow, type KeyedChatRow } from '../../src/seqscribe/transcript-keyed-folder.js';
import { createLiveChatPublisher } from '../../src/seqscribe/transcript-keyed-publish-runtime.js';
import type { TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';
import { TranscriptProjectionService } from '../../src/seqscribe/transcript-publisher.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import { DAEMON, SESSION, observation, ordOf } from './keyed-chat-fixtures.js';

/**
 * First-paint latency of the keyed chat lane, daemon half, on REAL seqscribe
 * nodes (a daemon node + a "browser" node over an in-memory WebSocket pair,
 * exactly the shape `standalone-transcript-lane.test.ts` uses).
 *
 * The defect: a session's `session.<id>.chat` topic was defined only on its
 * first PTY-driven publish. A dashboard lane attached before that
 * (`transcriptTopics=0`) had its SUB refused once — seqscribe never retries a
 * refused SUB — and the pane stayed blank until the browser's re-SUB backoff
 * fired (~10 s live). An idle session after a daemon restart never publishes,
 * so its topic stayed undefined indefinitely.
 *
 * The fix pinned here:
 *   1. `registered` (launch / restore) defines the topic SYNCHRONOUSLY and
 *      seeds the first frame (`TranscriptProjectionService.warmSession`);
 *   2. the lane announces the newly SUB-able topic the same instant
 *      (`StandaloneTranscriptLane.onTopicsAvailable` — the `/ws`
 *      `transcript_topics_available` push), AFTER its grant is in place, so a
 *      SUB issued on the announcement is accepted.
 *
 * Latencies are wall-clock over in-memory sockets (ms scale); the
 * browser-side timer behaviour (push vs retry backoff) is measured with fake
 * timers in web-standalone's `standalone-transcript-lane-first-paint.test.ts`.
 */

const FLEET_SECRET = 'first-paint-test-secret';
const TOPIC = sessionChatTopic(SESSION);

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
        try { fn(); } catch { /* noop */ }
    }
    for (const handle of handles.splice(0)) await handle.close().catch(() => {});
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-first-paint-${name}-`));
    tmpDirs.push(dir);
    return dir;
}

function openNode(dir: string): SeqscribeNodeHandle {
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: FLEET_SECRET },
        storedFleetSecret: null,
        meshIds: [],
    });
    handles.push(handle);
    return handle;
}

interface FakeSocket extends WebSocketLike {
    closed: boolean;
}

function socketPair(): [FakeSocket, FakeSocket] {
    type Listeners = { message: Array<(ev: { data: unknown }) => void>; close: Array<() => void>; open: Array<() => void> };
    type Sock = FakeSocket & { listeners: Listeners; other?: Sock };
    const make = (): Sock => {
        const listeners: Listeners = { message: [], close: [], open: [] };
        const sock = {
            listeners,
            closed: false,
            get readyState() {
                return sock.closed ? 3 : 1;
            },
            send(data: string) {
                if (sock.closed) return;
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
        } as Sock;
        return sock;
    };
    const a = make();
    const b = make();
    a.other = b;
    b.other = a;
    return [a, b];
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`timed out waiting for ${label}`);
}

/** The browser half: web-core's worker SUB + keyed folder, reduced to "first verified view". */
function browserSubscription(browser: SeqscribeNodeHandle, peer: PeerHandle) {
    browser.node.defineTopic(TOPIC, sessionChatPolicy());
    const views: Array<{ at: number; messages: number }> = [];
    const folder = new KeyedTranscriptFolder({
        expectedSessionId: SESSION,
        expectedOwnerDaemonId: DAEMON,
        onFrame: () => {
            views.push({ at: Date.now(), messages: folder.view()?.messages.length ?? 0 });
        },
    });
    const parse = (rows: readonly Row[]): KeyedChatRow[] =>
        rows.map((row) => parseChatSubRow(row)).filter((row): row is KeyedChatRow => row !== null);
    let sub: Subscription | null = null;
    const open = (): void => {
        sub?.close();
        sub = browser.node.subscribe(peer, { view: 'tail', params: { topic: TOPIC } });
        sub.onSnapshot((rows) => { folder.ingestSnapshot(parse(rows)); });
        sub.onDelta(({ upserts }) => { folder.ingestRows(parse(upserts)); });
    };
    return { open, views, close: () => sub?.close() };
}

function projection(node: SeqscribeNodeHandle, collect: () => TranscriptObservation | null) {
    const chat = createLiveChatPublisher(node, new TranscriptTopicClaimRegistry(), DAEMON);
    const service = new TranscriptProjectionService({
        daemonId: () => DAEMON,
        writerId: () => node.writerId,
        appendChatFrame: (sessionId, frame, obs) => chat.appendChatFrame(sessionId, frame, obs),
        readPersistedChat: (sessionId) => chat.readPersistedChat(sessionId),
        activateSession: (sessionId) => chat.activateSession(sessionId),
        collectObservation: async () => {
            const obs = collect();
            if (!obs) return null;
            service.observe(SESSION, obs);
            return null;
        },
    });
    cleanups.push(() => service.dispose());
    return service;
}

function registerSession(registry: SessionRegistry, origin: 'launch' | 'restore'): void {
    registry.register(
        { sessionId: SESSION, parentSessionId: null, providerType: 'claude-cli', transport: 'pty' },
        origin,
    );
}

async function attachBrowser(daemon: SeqscribeNodeHandle, lane: StandaloneTranscriptLane) {
    const browser = openNode(freshDir('browser'));
    const [serverSock, browserSock] = socketPair();
    expect(lane.accept(serverSock)).not.toBeNull();
    const peer = browser.node.attach(webSocketChannel(browserSock), { peerId: 'daemon', peerClass: 'content', grants: {} });
    await waitFor(() => peer.state() === 'ready', 'browser peer ready');
    return { browser, peer };
}

describe('keyed chat first paint — daemon side', () => {
    it('BEFORE (control): with no warm-up, registering a session defines nothing — the lane stays at transcriptTopics=0', () => {
        const daemon = openNode(freshDir('control'));
        const lane = new StandaloneTranscriptLane(daemon);
        cleanups.push(() => lane.close());
        const bus = createSessionLifecycleBus();
        const registry = new SessionRegistry(bus);
        registerSession(registry, 'launch');
        expect(lane.grants()).toEqual({});
        expect(daemon.topics.some((t) => t.topic === TOPIC)).toBe(false);
    });

    it('a session launched while a lane is attached: topic defined + announced synchronously; a SUB on the announcement paints the first view', async () => {
        const daemon = openNode(freshDir('launch'));
        const lane = new StandaloneTranscriptLane(daemon);
        cleanups.push(() => lane.close());
        const service = projection(daemon, () => observation([{ id: 'd.first.1', ord: ordOf(0), text: 'hello' }]));
        const bus = createSessionLifecycleBus();
        cleanups.push(subscribeTranscriptProjection(bus, service));
        const registry = new SessionRegistry(bus);

        // Lane attached first — the live repro (`transcriptTopics=0`).
        const { browser, peer } = await attachBrowser(daemon, lane);
        expect(lane.grants()).toEqual({});
        const sub = browserSubscription(browser, peer);
        cleanups.push(sub.close);
        // The browser's SUB races ahead of the definition and is refused.
        sub.open();
        await new Promise((r) => setTimeout(r, 50));
        expect(sub.views).toEqual([]);

        const announced: Array<{ at: number; topics: readonly string[] }> = [];
        cleanups.push(lane.onTopicsAvailable((topics) => {
            announced.push({ at: Date.now(), topics });
            // What the dashboard does on the `/ws` frame: re-SUB now.
            sub.open();
        }));

        const registeredAt = Date.now();
        registerSession(registry, 'launch');
        // Synchronous: defined, granted and announced inside `register()`.
        expect(lane.grants()).toEqual({ [TOPIC]: 'serve' });
        expect(announced.map((a) => a.topics)).toEqual([[TOPIC]]);

        await waitFor(() => sub.views.length > 0, 'first verified view');
        const firstViewMs = sub.views[0]!.at - registeredAt;
        console.info(`[first-paint] launched session: register → first verified view ${firstViewMs} ms (announce ${announced[0]!.at - registeredAt} ms)`);
        expect(sub.views[0]!.messages).toBe(1);
        expect(firstViewMs).toBeLessThan(1_000);
        expect(service.getCounters().published).toBe(1);
    });

    it('daemon restart with an IDLE session: restore defines the topic from disk with no publish at all; the SNAP paints the committed transcript', async () => {
        const dir = freshDir('restart');
        const bubbles = [0, 1, 2].map((i) => ({ id: `d.idle.${i}`, ord: ordOf(i), text: `idle bubble ${i}` }));

        // Process 1 — publishes, then the daemon goes down.
        {
            const node = openNode(dir);
            const service = projection(node, () => null);
            service.observe(SESSION, observation(bubbles));
            await waitFor(() => service.getCounters().published === 1, 'process-1 publish');
            service.dispose();
            handles.splice(handles.indexOf(node), 1);
            await node.close();
        }

        // Process 2 — the session is idle: its collector never has anything new.
        const daemon = openNode(dir);
        expect(daemon.topics.some((t) => t.topic === TOPIC)).toBe(false);
        const lane = new StandaloneTranscriptLane(daemon);
        cleanups.push(() => lane.close());
        const service = projection(daemon, () => null);
        const bus = createSessionLifecycleBus();
        cleanups.push(subscribeTranscriptProjection(bus, service));
        const registry = new SessionRegistry(bus);

        const { browser, peer } = await attachBrowser(daemon, lane);
        const sub = browserSubscription(browser, peer);
        cleanups.push(sub.close);
        sub.open(); // refused: nothing defined yet after the restart
        await new Promise((r) => setTimeout(r, 50));
        expect(sub.views).toEqual([]);
        cleanups.push(lane.onTopicsAvailable(() => sub.open()));

        const restoredAt = Date.now();
        registerSession(registry, 'restore');
        expect(lane.grants()).toEqual({ [TOPIC]: 'serve' });

        await waitFor(() => sub.views.length > 0, 'restored first view');
        const firstViewMs = sub.views[0]!.at - restoredAt;
        console.info(`[first-paint] idle session after restart: restore → first verified view ${firstViewMs} ms`);
        expect(sub.views[0]!.messages).toBe(3);
        expect(firstViewMs).toBeLessThan(1_000);
        // Served from disk: the restarted daemon published nothing.
        await new Promise((r) => setTimeout(r, 20));
        expect(service.getCounters().published).toBe(0);
    });

    it('sessions registered BEFORE the projection armed are warmed once on arm; re-registers do not re-seed', async () => {
        const daemon = openNode(freshDir('existing'));
        let pulls = 0;
        const service = projection(daemon, () => {
            pulls += 1;
            return observation([]);
        });
        const bus = createSessionLifecycleBus();
        const registry = new SessionRegistry(bus);
        registerSession(registry, 'restore');
        expect(daemon.topics.some((t) => t.topic === TOPIC)).toBe(false);

        cleanups.push(subscribeTranscriptProjection(bus, service, {
            existingSessionIds: registry.list().map((s) => s.sessionId),
        }));
        expect(daemon.topics.some((t) => t.topic === TOPIC)).toBe(true);
        await waitFor(() => service.getCounters().published === 1, 'seed frame (empty session → meta + commit)');

        registerSession(registry, 'restore'); // meta refresh upsert
        await new Promise((r) => setTimeout(r, 20));
        expect(pulls).toBe(1);

        // terminated → forgotten; a new registration of the id warms again.
        registry.terminate(SESSION, 'stop_requested');
        registerSession(registry, 'launch');
        await waitFor(() => pulls === 2, 'second warm after re-launch');
    });
});
