/**
 * Standalone daemon ⇄ daemon seqscribe replication over WebSocket (design
 * `docs/design/2026-10-07-standalone-multi-machine-mesh.md` §4.5) — the
 * standalone counterpart of the mesh half of `packages/daemon-cloud`'s
 * `SeqscribeDataChannelRouter`.
 *
 * Two roles, one peer map per role:
 *  - MEMBER (`attachHostLink`): the member owns redial. It dials the host's
 *    `/ws/mesh-seqscribe` through a `dial` callback supplied by the wiring
 *    layer (open the socket + complete the §4.4 HMAC handshake), and
 *    `manageReconnect` re-dials with jittered backoff whenever the session
 *    closes.
 *  - HOST (`acceptMemberSocket`): the host never dials a member. It adopts
 *    the already-authenticated socket the standalone upgrade route hands it.
 *    A newer socket for the same member replaces the previous one.
 *
 * Peer ids are `canonicalDaemonId(...)` on both sides, so the id the host
 * attaches a member under is the same id `resolveTranscriptPeer(ownerDaemonId)`
 * is asked for (cloud parity: mesh peer ids ARE daemon ids).
 *
 * ── Grants (copied from the cloud mesh-peer rule) ───────────────────────────
 * Every topic the node defines; `serve` for `subscribe-only` topics (the
 * library refuses `full` there, and that refusal would sink the whole grant
 * call), `full` for everything else. No per-session interest narrowing for a
 * mesh peer: a paired daemon is a full replication partner, exactly as in the
 * cloud. Every session uses `peerClass: 'content'` — `session.<id>.chat` and
 * `mesh.<id>.handoff` are content topics, and seqscribe throws when a
 * `metadata` peer is granted one (SPEC §14 attach).
 *
 * P15 grants are a FULL replacement, so the map is re-derived from
 * `node.topics` every time and re-advertised to every live peer on each
 * runtime topic activation (`onTopicActivated`) — the same shape the
 * standalone dashboard lane and the cloud router use.
 *
 * ── Why the host defers its attach until the member's first frame ──────────
 * The handshake helper detaches its listeners when it resolves, and the `ws`
 * library may emit several queued messages in one synchronous burst. If the
 * host attached (and so sent its seqscribe HELLO) right after `mesh_ok`, the
 * HELLO could arrive at the member in the same burst as `mesh_ok` — before the
 * member's continuation attached its own channel — and be dropped. HELLO's
 * retry interval equals the HELLO timeout (5 s), so one lost HELLO is one
 * failed session and one redial, and the race repeats on every redial.
 *
 * So the host waits for the member's first frame (its HELLO: a seqscribe
 * session sends HELLO at construction) before attaching. By then the member's
 * channel is necessarily listening, and the host's HELLO cannot be lost. The
 * member never has to receive anything it is not yet listening for, and the
 * frames the host buffered while waiting are replayed in order.
 *
 * ── Finality / secrets ─────────────────────────────────────────────────────
 * No fleet secret is shared between standalone machines (design §8 risk 1):
 * each machine's local authority signs with its own key, but
 * `topicSchemaHash` hashes only the authority ID, so topic definitions agree
 * and replication of un-finalized entries works. Nothing in this module reads
 * or logs a secret — authentication is entirely the wiring layer's handshake.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Daemon ⇄ daemon over the user's own network. Nothing here reaches a server.
 */

import {
    manageReconnect,
    webSocketChannel,
    type PeerHandle,
    type PeerHandleExt,
    type PeerLifecycleEvent,
    type ReconnectHandle,
    type WebSocketLike,
} from 'seqscribe';
import { canonicalDaemonId } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { onTopicActivated } from './mesh-publisher.js';
import type { SeqscribeNodeHandle } from './node.js';
import { MESH_SEQSCRIBE_WS_PATH } from '../shared/mesh-host-endpoints.js';

/** Upgrade path of the daemon⇄daemon replication socket on the standalone HTTP server (alias of shared MESH_SEQSCRIBE_WS_PATH). */
export const STANDALONE_MESH_SEQSCRIBE_WS_PATH = MESH_SEQSCRIBE_WS_PATH;

/** Peer class of every mesh replication session (content topics are granted). */
export const STANDALONE_MESH_SEQSCRIBE_PEER_CLASS = 'content' as const;

/**
 * Member-side redial backoff. Wider than the library default (500 ms → 30 s):
 * a host that is offline for hours should cost one dial a minute, not two.
 */
export const STANDALONE_MESH_SEQSCRIBE_BACKOFF = Object.freeze({ minMs: 1_000, maxMs: 60_000, factor: 2 });

/**
 * How long the host waits for an accepted member socket's first frame before
 * giving up on it. A live member sends its HELLO the moment it attaches, so
 * this only ever fires for a member that authenticated and then went silent.
 */
export const STANDALONE_MESH_FIRST_FRAME_TIMEOUT_MS = 15_000;

export type MeshPeerGrant = 'full' | 'serve';

/**
 * The grant map a paired mesh peer is advertised: every topic the node
 * defines, `serve` when the topic is `subscribe-only`, `full` otherwise.
 * Re-derived from scratch on every call (never mutated in place).
 */
export function deriveMeshPeerGrants(topics: SeqscribeNodeHandle['topics']): Record<string, MeshPeerGrant> {
    const grants: Record<string, MeshPeerGrant> = {};
    for (const { topic, policy } of topics) {
        grants[topic] = policy.replication === 'subscribe-only' ? 'serve' : 'full';
    }
    return grants;
}

export interface StandaloneMeshSeqscribeOptions {
    /** This daemon's id — used to refuse a self-link and for log correlation. */
    readonly localDaemonId: string;
    /** Member-side redial backoff override (tests). */
    readonly backoff?: { minMs?: number; maxMs?: number; factor?: number };
    /** Host-side first-frame wait override (tests). */
    readonly firstFrameTimeoutMs?: number;
}

/** A member-side link to one host (one redial loop per host daemon). */
interface HostLink {
    readonly peerId: string;
    readonly meshIds: Set<string>;
    reconnect: ReconnectHandle | null;
    stopped: boolean;
}

/** A host-side member session (or one still waiting for the member's first frame). */
interface MemberSession {
    readonly peerId: string;
    readonly meshIds: Set<string>;
    readonly socket: WebSocketLike;
    peer: PeerHandleExt | null;
    firstFrameTimer: ReturnType<typeof setTimeout> | null;
    ended: boolean;
}

/**
 * Owns every daemon⇄daemon replication session of one standalone node.
 *
 * Construct once after `bootSeqscribeNode`. `close()` runs automatically
 * inside the node's own `close()` (registered via `node.onClose`), so peers
 * are always detached before the node goes down.
 */
export class StandaloneMeshSeqscribe {
    private readonly links = new Map<string, HostLink>();
    private readonly members = new Map<string, MemberSession>();
    private readonly unsubscribeTopicActivation: () => void;
    private readonly localPeerId: string | undefined;
    private readonly backoff: { minMs?: number; maxMs?: number; factor?: number };
    private readonly firstFrameTimeoutMs: number;
    private closed = false;

    constructor(
        private readonly node: SeqscribeNodeHandle,
        opts: StandaloneMeshSeqscribeOptions,
    ) {
        this.localPeerId = canonicalDaemonId(opts.localDaemonId);
        this.backoff = { ...STANDALONE_MESH_SEQSCRIBE_BACKOFF, ...(opts.backoff ?? {}) };
        this.firstFrameTimeoutMs = Math.max(1, opts.firstFrameTimeoutMs ?? STANDALONE_MESH_FIRST_FRAME_TIMEOUT_MS);
        // A topic defined at runtime (a session's chat topic, a newly joined
        // mesh's events/handoff) must become replicable on sessions that are
        // already up — the library copies grants at attach.
        this.unsubscribeTopicActivation = onTopicActivated(node, (topic) => this.readvertiseAll(topic));
        node.onClose(() => this.close());
    }

    /** The grant map every mesh peer is advertised right now. */
    grants(): Record<string, MeshPeerGrant> {
        return deriveMeshPeerGrants(this.node.topics);
    }

    /**
     * MEMBER side: keep a replication session to `hostDaemonId` alive.
     *
     * `dial` must resolve with an OPEN socket that already passed the §4.4
     * handshake for `meshId`, with no handshake listeners left on it; it may
     * reject (host offline, handshake refused) — the failure is logged and
     * retried with backoff.
     *
     * One loop per host daemon: a second call for the SAME mesh replaces the
     * loop (a re-pair brings a new dial/secret); a call for a DIFFERENT mesh
     * hosted by the same daemon only records the mesh — the existing session
     * already replicates every topic, and two sessions to one peer id would
     * just duplicate traffic. Returns false when the call was refused.
     */
    attachHostLink(meshId: string, hostDaemonId: string, dial: () => Promise<WebSocketLike>): boolean {
        const peerId = this.admissiblePeerId(hostDaemonId, 'host link');
        if (peerId === null) return false;

        const existing = this.links.get(peerId);
        if (existing && !existing.meshIds.has(meshId)) {
            existing.meshIds.add(meshId);
            LOG.info(
                'Seqscribe',
                `mesh replication link reused peer=${maskDaemonId(peerId)} meshes=${existing.meshIds.size}`,
            );
            return true;
        }
        const meshIds = new Set(existing?.meshIds ?? []);
        meshIds.add(meshId);
        if (existing) this.stopLink(existing);

        const link: HostLink = { peerId, meshIds, reconnect: null, stopped: false };
        this.links.set(peerId, link);
        // `manageReconnect` dials synchronously from inside this call (before
        // it returns), so the dial closure must read `link`, not the handle.
        link.reconnect = manageReconnect(this.node.node, {
            peerId,
            peerClass: STANDALONE_MESH_SEQSCRIBE_PEER_CLASS,
            // A thunk: re-read at every redial until the first updateGrants,
            // after which the library keeps the last map pushed to it — and
            // readvertiseAll always pushes a freshly derived one.
            grants: () => this.grants(),
            dial: async () => {
                const socket = await dial();
                if (link.stopped || this.closed) {
                    safeClose(socket);
                    throw new Error('mesh replication link stopped during dial');
                }
                return webSocketChannel(socket);
            },
            backoff: this.backoff,
            onEvent: (event) => this.logLifecycle('host', peerId, event),
            onError: (error) => {
                if (link.stopped) return;
                LOG.warn(
                    'Seqscribe',
                    `mesh replication dial failed peer=${maskDaemonId(peerId)}: ${errorMessage(error)}`,
                );
            },
            // The endpoint passed a mutual HMAC handshake, so it IS a paired
            // daemon — repeated HELLO timeouts are a transport fault, not a
            // misclassified peer. Keep the backoff loop rather than stopping
            // replication for good (the cloud dashboard-peer lesson).
            onPeerUnresponsive: ({ consecutiveHelloTimeouts }) => {
                LOG.warn(
                    'Seqscribe',
                    `mesh replication peer unresponsive peer=${maskDaemonId(peerId)} helloTimeouts=${consecutiveHelloTimeouts} — keeping redial`,
                );
                return undefined;
            },
        });
        if (link.stopped) link.reconnect.stop();
        LOG.info(
            'Seqscribe',
            `mesh replication link started peer=${maskDaemonId(peerId)} topics=${Object.keys(this.grants()).length}`,
        );
        return true;
    }

    /**
     * HOST side: adopt an authenticated member socket as that member's
     * replication session, replacing any previous one for the same member.
     *
     * The caller MUST have completed the §4.4 handshake that proved
     * `memberDaemonId` for `meshId`. Returns false (and closes the socket)
     * when refused.
     */
    acceptMemberSocket(meshId: string, memberDaemonId: string, socket: WebSocketLike): boolean {
        const peerId = this.admissiblePeerId(memberDaemonId, 'member socket');
        if (peerId === null) {
            safeClose(socket);
            return false;
        }
        const previous = this.members.get(peerId);
        const meshIds = new Set(previous?.meshIds ?? []);
        meshIds.add(meshId);
        if (previous) {
            LOG.info('Seqscribe', `mesh replication member replaced peer=${maskDaemonId(peerId)}`);
            this.endMember(previous);
        }

        const session: MemberSession = { peerId, meshIds, socket, peer: null, firstFrameTimer: null, ended: false };
        this.members.set(peerId, session);
        const deferred = new FirstFrameDeferredSocket(socket, () => this.attachMember(session, deferred));
        socket.addEventListener('close', () => {
            if (session.peer === null) this.dropMember(session, 'closed before first frame');
        });
        session.firstFrameTimer = setTimeout(() => {
            session.firstFrameTimer = null;
            if (session.peer === null) this.dropMember(session, 'no first frame');
        }, this.firstFrameTimeoutMs);
        (session.firstFrameTimer as { unref?: () => void }).unref?.();
        return true;
    }

    /**
     * The live `PeerHandle` for a paired daemon, whichever role this side
     * plays: the member's current session to its host, or the host's session
     * with that member. Null when unknown, mid-redial, or not attached yet.
     */
    resolveTranscriptPeer(daemonId: string): PeerHandle | null {
        const peerId = canonicalDaemonId(daemonId);
        if (!peerId) return null;
        const linked = this.links.get(peerId)?.reconnect?.current() ?? null;
        if (linked && linked.state() !== 'closed') return linked;
        const accepted = this.members.get(peerId)?.peer ?? null;
        if (accepted && accepted.state() !== 'closed') return accepted;
        return null;
    }

    /** End every session with `daemonId`, in both roles. Idempotent. */
    detach(daemonId: string): void {
        const peerId = canonicalDaemonId(daemonId);
        if (!peerId) return;
        const link = this.links.get(peerId);
        if (link) {
            this.links.delete(peerId);
            this.stopLink(link);
        }
        const member = this.members.get(peerId);
        if (member) this.dropMember(member, 'detach');
    }

    /**
     * Forget `meshId` for `daemonId` (pairing revoked for one mesh); the
     * sessions end only when no mesh is left that pairs the two daemons.
     */
    detachMesh(meshId: string, daemonId: string): void {
        const peerId = canonicalDaemonId(daemonId);
        if (!peerId) return;
        const link = this.links.get(peerId);
        if (link) {
            link.meshIds.delete(meshId);
            if (link.meshIds.size === 0) {
                this.links.delete(peerId);
                this.stopLink(link);
            }
        }
        const member = this.members.get(peerId);
        if (member) {
            member.meshIds.delete(meshId);
            if (member.meshIds.size === 0) this.dropMember(member, 'mesh detached');
        }
    }

    /** Every paired daemon with a link or an accepted session (canonical ids). */
    peerIds(): string[] {
        return [...new Set([...this.links.keys(), ...this.members.keys()])];
    }

    /** Stop every link, end every member session, stop listening. Idempotent. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribeTopicActivation();
        for (const link of this.links.values()) this.stopLink(link);
        this.links.clear();
        for (const member of [...this.members.values()]) this.dropMember(member, 'close');
        this.members.clear();
    }

    private admissiblePeerId(daemonId: string, what: string): string | null {
        if (this.closed) {
            LOG.warn('Seqscribe', `mesh replication ${what} refused: closed`);
            return null;
        }
        const peerId = canonicalDaemonId(daemonId);
        if (!peerId) {
            LOG.warn('Seqscribe', `mesh replication ${what} refused: empty daemon id`);
            return null;
        }
        if (peerId === this.localPeerId) {
            LOG.warn('Seqscribe', `mesh replication ${what} refused: peer is this daemon`);
            return null;
        }
        return peerId;
    }

    /** Runs inside the member's first-frame dispatch. */
    private attachMember(session: MemberSession, deferred: FirstFrameDeferredSocket): void {
        if (session.ended || this.closed || this.members.get(session.peerId) !== session) {
            safeClose(session.socket);
            return;
        }
        if (session.firstFrameTimer !== null) {
            clearTimeout(session.firstFrameTimer);
            session.firstFrameTimer = null;
        }
        let peer: PeerHandleExt;
        try {
            peer = this.node.node.attach(webSocketChannel(deferred), {
                peerId: session.peerId,
                peerClass: STANDALONE_MESH_SEQSCRIBE_PEER_CLASS,
                grants: this.grants(),
            });
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `mesh replication member attach refused peer=${maskDaemonId(session.peerId)}: ${errorMessage(error)}`,
            );
            this.dropMember(session, 'attach refused');
            return;
        }
        session.peer = peer;
        peer.onLifecycle((event) => {
            this.logLifecycle('member', session.peerId, event);
            if (event.event !== 'closed') return;
            // Only the entry this handle owns — a replacement may already sit there.
            if (this.members.get(session.peerId) === session) this.members.delete(session.peerId);
            session.ended = true;
        });
        // The session now listens: hand it the frames that arrived so far.
        deferred.release();
    }

    private stopLink(link: HostLink): void {
        link.stopped = true;
        try {
            link.reconnect?.stop();
        } catch {
            // session already gone
        }
    }

    private endMember(session: MemberSession): void {
        session.ended = true;
        if (session.firstFrameTimer !== null) {
            clearTimeout(session.firstFrameTimer);
            session.firstFrameTimer = null;
        }
        try {
            session.peer?.detach();
        } catch {
            // session already gone
        }
        safeClose(session.socket);
    }

    private dropMember(session: MemberSession, reason: string): void {
        if (this.members.get(session.peerId) === session) this.members.delete(session.peerId);
        if (session.ended) return;
        LOG.info('Seqscribe', `mesh replication member dropped peer=${maskDaemonId(session.peerId)} reason=${reason}`);
        this.endMember(session);
    }

    /** Never throws — runs inside a ledger append / session registration. */
    private readvertiseAll(topic: string): void {
        if (this.closed || (this.links.size === 0 && this.members.size === 0)) return;
        const grants = this.grants();
        let updated = 0;
        for (const link of this.links.values()) {
            try {
                link.reconnect?.updateGrants(grants);
                updated += 1;
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `mesh replication grant re-advertisement failed peer=${maskDaemonId(link.peerId)} topic=${topic}: ${errorMessage(error)}`,
                );
            }
        }
        for (const member of this.members.values()) {
            // A member still waiting for its first frame attaches with a fresh map anyway.
            if (!member.peer || member.peer.state() === 'closed') continue;
            try {
                member.peer.updateGrants(grants);
                updated += 1;
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `mesh replication grant re-advertisement failed peer=${maskDaemonId(member.peerId)} topic=${topic}: ${errorMessage(error)}`,
                );
            }
        }
        LOG.debug('Seqscribe', `mesh replication grants re-advertised topic=${topic} peers=${updated}`);
    }

    private logLifecycle(role: 'host' | 'member', peerId: string, event: PeerLifecycleEvent): void {
        const base = `mesh peer ${event.event} role=${role} peer=${maskDaemonId(peerId)} writer=${maskDaemonId(this.node.writerId)}`;
        if (event.event !== 'closed') {
            LOG.info('Seqscribe', base);
            return;
        }
        const reason = event.reason ?? 'unknown';
        const line = `${base} reason=${reason}`;
        if (reason === 'hello_timeout' || reason === 'protocol') LOG.warn('Seqscribe', line);
        else LOG.info('Seqscribe', line);
    }
}

/**
 * A `WebSocketLike` view of an accepted socket that holds every inbound frame
 * until `release()`, and reports the first one through `onFirstFrame`.
 * `webSocketChannel` registers its message listener at construction but only
 * delivers once the session calls `onMessage`, so buffered frames are replayed
 * by an explicit `release()` after `node.attach` returns.
 */
class FirstFrameDeferredSocket implements WebSocketLike {
    private readonly messageListeners: Array<(ev: { data: unknown }) => void> = [];
    private buffered: unknown[] | null = [];
    private sawFirst = false;

    constructor(
        private readonly inner: WebSocketLike,
        private readonly onFirstFrame: () => void,
    ) {
        inner.addEventListener('message', (ev) => {
            if (this.buffered === null) {
                for (const cb of this.messageListeners) cb(ev);
                return;
            }
            this.buffered.push(ev.data);
            if (this.sawFirst) return;
            this.sawFirst = true;
            this.onFirstFrame();
        });
    }

    get readyState(): number | string | undefined {
        return this.inner.readyState;
    }

    isOpen(): boolean {
        if (typeof this.inner.isOpen === 'function') return this.inner.isOpen();
        return this.inner.readyState === 1 || this.inner.readyState === 'open';
    }

    send(data: string): void {
        this.inner.send(data);
    }

    close(): void {
        this.inner.close();
    }

    addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
    addEventListener(type: 'close', cb: () => void): void;
    addEventListener(type: 'open', cb: () => void): void;
    addEventListener(type: 'message' | 'close' | 'open', cb: ((ev: { data: unknown }) => void) | (() => void)): void {
        if (type === 'message') {
            this.messageListeners.push(cb as (ev: { data: unknown }) => void);
            return;
        }
        this.inner.addEventListener(type as 'close', cb as () => void);
    }

    /** Deliver the buffered frames in order, then pass frames straight through. */
    release(): void {
        const pending = this.buffered;
        this.buffered = null;
        if (!pending) return;
        for (const data of pending) {
            for (const cb of this.messageListeners) cb({ data });
        }
    }
}

/**
 * Log-safe daemon id: the id-class prefix plus 8 discriminating characters.
 * Same rule as `mesh/transport/mask-daemon-id.ts`, kept local because the
 * seqscribe layer must not value-import mesh internals (`check:boundaries`).
 */
function maskDaemonId(id: string | null | undefined): string {
    if (!id) return '(empty)';
    for (const prefix of ['standalone_mach_', 'daemon_mach_', 'mach_']) {
        if (id.startsWith(prefix)) {
            const rest = id.slice(prefix.length);
            return rest.length <= 8 ? id : `${prefix}${rest.slice(0, 8)}…`;
        }
    }
    return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function safeClose(socket: WebSocketLike): void {
    try {
        socket.close();
    } catch {
        // already closing
    }
}
