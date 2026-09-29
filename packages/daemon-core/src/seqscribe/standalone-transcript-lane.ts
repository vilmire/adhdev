/**
 * Standalone transcript lane — the localhost-WebSocket counterpart of
 * `packages/daemon-cloud`'s `SeqscribeDataChannelRouter` (wiring-unification
 * G6 prerequisite, design `docs/design/2026-09-23-wiring-unification.md` §7e).
 *
 * The standalone daemon already runs the same seqscribe node, defines the same
 * `session.<safeSessionId>.chat` topics (`transcript-activation.ts`) and
 * holds a machine-local finality authority (`local-authority.ts`). What it
 * lacked was a transport that serves those topics to its own dashboard. This
 * lane is now the standalone dashboard's ONLY chat delivery path.
 *
 * This module is that transport's daemon half: it takes an ALREADY
 * AUTHENTICATED socket (the standalone HTTP server's `/ws/seqscribe` upgrade
 * runs the same Origin + token/password gate as `/ws` before it ever calls
 * `accept`) and attaches it to the node as one `content` peer.
 *
 * ── What was deliberately NOT carried over from the cloud router ───────────
 *  - ICE / redial / zombie-peer recovery: the BROWSER dials this lane, over a
 *    loopback socket. A closed lane is simply gone; the dashboard reopens it
 *    with backoff and a fresh transcript worker (the worker never resumes
 *    across a gap it cannot verify — web-core `transcript-worker-host.ts`).
 *  - `isBrowserSeqscribeAdmissible`'s share-viewer exclusion: standalone has
 *    no share principals. Every socket that reaches `accept` passed the one
 *    standalone auth gate, which is also what authorizes `/ws`.
 *  - The responder proof (`seqscribe_session_interest` before dialing): it
 *    exists in the cloud because the DAEMON dials and must not dial a browser
 *    build that has no seqscribe responder. Here the browser opens the socket,
 *    which is its own proof.
 *  - Per-session interest narrowing (design §9 item 4): see
 *    `deriveStandaloneTranscriptGrants` — the principal holding this socket
 *    already reads every session's chat over `/ws` (`read_chat`,
 *    `chat_history`), so narrowing the replica lane below that would not
 *    reduce what the principal can read. The grant map is still
 *    least-privilege in the dimension that matters here: transcript topics
 *    ONLY (never `mesh.*`, `assistant.journal`,
 *    `config.settings`), and `serve` ONLY (the peer can SUB; it can never
 *    write, because nothing is granted `full`).
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Daemon ⇄ local browser only. Nothing here reaches any server.
 */

import { webSocketChannel, type PeerHandleExt, type WebSocketLike } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import { onTopicActivated } from './mesh-publisher.js';
import type { SeqscribeNodeHandle } from './node.js';
import { sessionSegmentFromChatTopic } from './topics.js';

/** Upgrade path of the replica lane on the standalone HTTP server (next to `/ws`). */
export const STANDALONE_SEQSCRIBE_WS_PATH = '/ws/seqscribe';

/**
 * The only admissible peer class: `session.<id>.chat` is
 * `access: 'content'`, and seqscribe throws when a `metadata` peer is granted
 * a content topic (SPEC §14 attach) — same constraint as the cloud router's
 * `SEQSCRIBE_PEER_CLASS`.
 */
export const STANDALONE_SEQSCRIBE_PEER_CLASS = 'content' as const;

/**
 * Concurrent lanes kept alive. Mirrors the `/ws` client cap (10) in spirit: a
 * reload storm must not accumulate sessions. The oldest lane is evicted — its
 * tab reconnects with backoff, exactly as after any other lane close.
 */
export const MAX_STANDALONE_SEQSCRIBE_LANES = 8;

/**
 * `/ws` JSON frame type announcing transcript topics that just became
 * SUB-able (`{ type, topics: string[] }`). Mirrored by web-core's
 * `TRANSCRIPT_TOPICS_AVAILABLE_TYPE` and by the cloud P2P frame of the same
 * name (mesh-shared `P2PTranscriptTopicsAvailableMsg`).
 *
 * ★ Why a separate announcement is needed at all: a seqscribe SUB for a
 * topic the lane does not grant yet is refused ONCE (`SUB_ERR ERR_ACL_DENIED`)
 * and the library never retries it — the refusal is not even surfaced to the
 * subscriber's callbacks. The grant re-advertisement (P15 HELLO) is not
 * observable through the browser node's public API either. So without this
 * frame the browser can only guess when to re-SUB (the retry backoff), which
 * is what left a pane blank for ~10 s after its topic appeared.
 *
 * Content-free on a local socket: topic names only (sanitized session ids,
 * which the status payload already carries raw).
 */
export const TRANSCRIPT_TOPICS_AVAILABLE_TYPE = 'transcript_topics_available';

/**
 * `session.<segment>.chat` → segment, else null (the keyed chat topic, design
 * 2026-09-28 §5.8). The segment is what `safeSessionId` produced, so it never
 * contains a dot.
 */
export function transcriptTopicSessionSegment(topic: string): string | null {
    return sessionSegmentFromChatTopic(topic);
}

/**
 * The grant map one standalone dashboard lane is advertised: `serve` on every
 * DEFINED `subscribe-only` session chat topic, nothing else.
 *
 * Re-derived from `node.topics` every time (never mutated in place): seqscribe
 * P15 grants are a FULL replacement, and an incrementally assembled map is the
 * shape that drifts. `serve`, never `full`: the library rejects `full` on a
 * subscribe-only topic, and that rejection would take down the whole
 * `updateGrants` call.
 */
export function deriveStandaloneTranscriptGrants(
    topics: SeqscribeNodeHandle['topics'],
): Record<string, 'serve'> {
    const grants: Record<string, 'serve'> = {};
    for (const { topic, policy } of topics) {
        if (transcriptTopicSessionSegment(topic) === null) continue;
        if (policy.replication !== 'subscribe-only') continue;
        grants[topic] = 'serve';
    }
    return grants;
}

interface LaneEntry {
    readonly peer: PeerHandleExt;
    readonly socket: WebSocketLike;
}

export interface StandaloneTranscriptLaneOptions {
    /** Override of `MAX_STANDALONE_SEQSCRIBE_LANES` (tests). */
    readonly maxLanes?: number;
}

/**
 * Owns every live standalone dashboard replica lane for one node.
 *
 * Construct once per daemon runtime (after `bootSeqscribeNode`), `accept` each
 * authenticated upgrade, `close` on shutdown BEFORE the node closes.
 */
export class StandaloneTranscriptLane {
    private readonly lanes = new Map<string, LaneEntry>();
    private readonly availabilityListeners = new Set<(topics: readonly string[]) => void>();
    private readonly unsubscribeTopicActivation: () => void;
    private readonly maxLanes: number;
    private laneSeq = 0;
    private closed = false;

    constructor(
        private readonly seqscribe: SeqscribeNodeHandle,
        options: StandaloneTranscriptLaneOptions = {},
    ) {
        this.maxLanes = Math.max(1, options.maxLanes ?? MAX_STANDALONE_SEQSCRIBE_LANES);
        // A transcript topic is defined when its session registers (launch /
        // restore — `TranscriptProjectionService.warmSession`) or, at the latest,
        // on its first publish (`transcript-activation.ts`) — often after a
        // dashboard attached. Re-advertise so that session becomes SUB-able on
        // the live lane, THEN announce it: a listener (the standalone `/ws`
        // broadcast) tells the browser to re-SUB now, and the grant it needs is
        // already in place by the time that SUB can arrive.
        this.unsubscribeTopicActivation = onTopicActivated(seqscribe, (topic) => {
            if (transcriptTopicSessionSegment(topic) === null) return;
            this.readvertiseAll(topic);
            this.announceAvailable([topic]);
        });
    }

    /** Current grant map every lane is advertised (tests / diagnostics). */
    grants(): Record<string, 'serve'> {
        return deriveStandaloneTranscriptGrants(this.seqscribe.topics);
    }

    /**
     * Listen for transcript topics that just became SUB-able on every lane.
     * The listener receives only the NEWLY available topics (the grant map is
     * uniform across standalone lanes, so "new for one lane" is "new for all").
     * Returns the unsubscribe.
     */
    onTopicsAvailable(listener: (topics: readonly string[]) => void): () => void {
        this.availabilityListeners.add(listener);
        return () => {
            this.availabilityListeners.delete(listener);
        };
    }

    /** Live lane count (tests / diagnostics). */
    laneCount(): number {
        return this.lanes.size;
    }

    /**
     * Attach one authenticated socket as a seqscribe peer.
     *
     * The caller MUST have already enforced the standalone auth gate — this
     * method has no way to tell an authenticated socket from any other.
     * Returns the local peer id, or null when the lane refused (closed lane,
     * or the node rejected the attach); a refused socket is closed.
     */
    accept(socket: WebSocketLike): string | null {
        if (this.closed) {
            safeClose(socket);
            return null;
        }
        while (this.lanes.size >= this.maxLanes) {
            const oldest = this.lanes.keys().next().value;
            if (oldest === undefined) break;
            LOG.info('Seqscribe', `standalone replica lane evicted peer=${oldest} reason=lane_cap`);
            this.detach(oldest);
        }

        this.laneSeq += 1;
        const peerId = `standalone_dashboard_${this.laneSeq}`;
        let peer: PeerHandleExt;
        try {
            peer = this.seqscribe.node.attach(webSocketChannel(socket), {
                peerId,
                peerClass: STANDALONE_SEQSCRIBE_PEER_CLASS,
                grants: this.grants(),
            });
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `standalone replica lane attach refused peer=${peerId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            safeClose(socket);
            return null;
        }
        this.lanes.set(peerId, { peer, socket });
        peer.onLifecycle((event) => {
            if (event.event !== 'closed') return;
            // Only drop the entry this handle owns — an evicted-then-reused id
            // cannot happen (monotonic), but stay exact anyway.
            if (this.lanes.get(peerId)?.peer === peer) this.lanes.delete(peerId);
            LOG.info('Seqscribe', `standalone replica lane closed peer=${peerId} reason=${event.reason ?? 'unknown'}`);
        });
        LOG.info(
            'Seqscribe',
            `standalone replica lane attached peer=${peerId} transcriptTopics=${Object.keys(this.grants()).length}`,
        );
        return peerId;
    }

    /** Detach one lane (closes its socket). Idempotent. */
    detach(peerId: string): void {
        const entry = this.lanes.get(peerId);
        if (!entry) return;
        this.lanes.delete(peerId);
        try {
            entry.peer.detach();
        } catch {
            // session already gone
        }
        safeClose(entry.socket);
    }

    /** Detach every lane and stop listening for topic activation. Idempotent. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribeTopicActivation();
        this.availabilityListeners.clear();
        for (const peerId of [...this.lanes.keys()]) this.detach(peerId);
    }

    /** Never throws — runs inside a transcript publish / session registration. */
    private announceAvailable(topics: readonly string[]): void {
        if (this.closed || this.availabilityListeners.size === 0) return;
        for (const listener of [...this.availabilityListeners]) {
            try {
                listener(topics);
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `standalone transcript availability listener failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    /** Never throws — runs inside a transcript publish (via the activation announcement). */
    private readvertiseAll(topic: string): void {
        if (this.lanes.size === 0) return;
        const grants = this.grants();
        for (const [peerId, { peer }] of this.lanes) {
            try {
                peer.updateGrants(grants);
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `standalone replica lane grant re-advertisement failed peer=${peerId} topic=${topic}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }
}

export interface TranscriptTopicsAvailableFrame {
    readonly type: typeof TRANSCRIPT_TOPICS_AVAILABLE_TYPE;
    readonly topics: readonly string[];
}

export function transcriptTopicsAvailableFrame(topics: readonly string[]): TranscriptTopicsAvailableFrame {
    return { type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE, topics: [...topics] };
}

function safeClose(socket: WebSocketLike): void {
    try {
        socket.close();
    } catch {
        // already closing
    }
}
