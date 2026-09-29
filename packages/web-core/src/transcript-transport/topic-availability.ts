/**
 * "A transcript topic just became SUB-able" — the daemon → dashboard push that
 * replaces guessing (design 2026-09-28 §5.4, first-paint latency fix).
 *
 * ── Why the browser needs to be told ────────────────────────────────────────
 * A seqscribe SUB for a topic the daemon does not grant yet is refused ONCE
 * (`SUB_ERR ERR_ACL_DENIED`) and the library neither retries it nor surfaces
 * the refusal to the subscription's callbacks; the daemon's grant
 * re-advertisement (P15 HELLO) is not observable through the browser node's
 * public API either. A pane whose SUB raced the topic's definition therefore
 * stayed blank until a timer happened to re-SUB (the old 3 s → 60 s backoff —
 * measured ~10 s live). The daemon knows the exact moment a topic becomes
 * grantable, so it says so:
 *
 *   - standalone: a `/ws` JSON frame, broadcast when a session's `.chat` topic
 *     is defined (daemon-core `StandaloneTranscriptLane.onTopicsAvailable`);
 *   - cloud: a P2P `data`-channel frame to ONE peer, sent when that peer's
 *     grant map newly includes a chat topic (topic defined, or the peer's
 *     session interest widened — daemon-cloud `SeqscribeDataChannelRouter`).
 *
 * Both carry `{ type: 'transcript_topics_available', topics: string[] }` with
 * only the NEWLY grantable topics. The grant is already in place when the
 * frame is sent, so a SUB issued on receipt is accepted.
 *
 * The retry timers stay, but only as a last resort (a lost frame, an older
 * daemon that never sends it).
 *
 * Dependency-light on purpose (topic addressing only) so both the OSS
 * standalone lane and the proprietary web-cloud manager share one parser and
 * one selection rule.
 */
import { sessionChatTopic } from './topic-addressing.js';

/** Frame `type`. Mirrors daemon-core `TRANSCRIPT_TOPICS_AVAILABLE_TYPE` and mesh-shared's P2P frame. */
export const TRANSCRIPT_TOPICS_AVAILABLE_TYPE = 'transcript_topics_available';

/**
 * Upper bound on topics accepted from one frame — matches the daemon's
 * declared-interest cap. A longer frame is malformed, not truncated.
 */
export const MAX_TRANSCRIPT_TOPICS_AVAILABLE = 256;

/**
 * Parse a `transcript_topics_available` frame; null when it is not one or is
 * malformed (non-array, over the cap, a non-string entry).
 */
export function parseTranscriptTopicsAvailable(frame: unknown): string[] | null {
    if (!frame || typeof frame !== 'object') return null;
    const record = frame as { type?: unknown; topics?: unknown };
    if (record.type !== TRANSCRIPT_TOPICS_AVAILABLE_TYPE) return null;
    if (!Array.isArray(record.topics) || record.topics.length > MAX_TRANSCRIPT_TOPICS_AVAILABLE) return null;
    const topics: string[] = [];
    for (const topic of record.topics) {
        if (typeof topic !== 'string') return null;
        if (topic.length > 0) topics.push(topic);
    }
    return topics;
}

/**
 * Which activated sessions to re-SUB now that `topics` became grantable: the
 * ones that have NOT delivered a verified view on the current host and whose
 * chat topic (`sessionChatTopic`, the daemon's own addressing) is among them.
 * Delivered sessions are live already and are never touched.
 */
export function sessionsToResubscribeOnAvailable(
    activeSessionIds: readonly string[],
    delivered: { has(sessionId: string): boolean } | undefined,
    topics: readonly string[],
): string[] {
    if (topics.length === 0 || activeSessionIds.length === 0) return [];
    const available = new Set(topics);
    return activeSessionIds.filter((sessionId) => !delivered?.has(sessionId) && available.has(sessionChatTopic(sessionId)));
}
