/**
 * The `seqscribe_session_interest` wire contract (Phase 3 unit 3).
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 * A dashboard peer tells the daemon WHICH SESSIONS it wants replicated over
 * seqscribe. The daemon narrows that peer's grant map to exactly those
 * `session.<id>.transcript` topics (least privilege, design §9 item 4) and —
 * because sending this frame proves the sender speaks the protocol — admits it
 * for a seqscribe channel at all.
 *
 * ── Why this rides the P2P data lane, never the server ─────────────────────
 * The payload is a list of the user's own sessionIds. Sending it over the
 * server WS would open a NEW identifier path outside the two approved
 * content-boundary exceptions (approval-modal text for push actionability;
 * Beacon's topic-name keys for staleness UX) — and Beacon's default scope is
 * metadata-class topics, which `session.*.transcript` explicitly is not. The
 * existing P2P `data` channel already carries far richer per-session data
 * peer-to-peer, so the declaration adds no exposure there and needs no new
 * server endpoint.
 *
 * ── Why the ids are raw here ───────────────────────────────────────────────
 * The daemon sanitizes with `safeSessionId` on receipt — the SAME function
 * that builds the topic segment — so the comparison stays a topic-name
 * comparison on both ends rather than a raw-id comparison (the recurring
 * canon-identity defect class). Sanitizing on the browser side too would be
 * harmless but redundant; sanitizing ONLY on the browser side would be the
 * bug, since the daemon must not trust a client-normalized key.
 *
 * This module is deliberately dependency-free so both the OSS web packages and
 * the proprietary web-cloud assembly can share one definition of the frame
 * instead of hand-syncing two copies of the type string.
 */

/**
 * WebRTC data-channel label seqscribe frames travel on.
 *
 * Mirrors daemon-cloud's `SEQSCRIBE_DATA_CHANNEL_LABEL`. The browser must
 * accept a channel with THIS label in `ondatachannel`; accepting only `'data'`
 * is precisely what made every dialed dashboard peer time out on HELLO before
 * this unit (the `e6f341432` flap).
 */
export const SEQSCRIBE_DATA_CHANNEL_LABEL = 'seqscribe';

/** Frame `type` discriminator. Mirrors daemon-cloud's `SEQSCRIBE_SESSION_INTEREST_TYPE`. */
export const SEQSCRIBE_SESSION_INTEREST_TYPE = 'seqscribe_session_interest';

export interface SessionInterestFrame {
    readonly type: typeof SEQSCRIBE_SESSION_INTEREST_TYPE;
    /**
     * Raw session ids this peer wants replicated.
     *
     * ★ An EMPTY array is meaningful and is NOT the same as never sending the
     * frame. Empty = "I want no transcripts" → the daemon grants zero
     * transcript topics. Never sent = no declaration → the daemon leaves the
     * peer unfiltered AND never admits it for a seqscribe channel. A dashboard
     * that has opened no session should therefore still send the empty frame:
     * it is what establishes the channel, so the grant map can be narrowed
     * later without a reconnect.
     */
    readonly sessionIds: readonly string[];
}

export function sessionInterestFrame(sessionIds: readonly string[]): SessionInterestFrame {
    return { type: SEQSCRIBE_SESSION_INTEREST_TYPE, sessionIds };
}
