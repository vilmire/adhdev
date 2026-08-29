/**
 * transcript topic identity claim — fail-closed defense against safeSessionId
 * collisions (design §3.5, docs/design/2026-08-29-phase3-transcript-migration.md).
 *
 * `safeSessionId` (topics.ts) is a deliberately non-injective, non-reversible
 * sanitizer: two distinct raw session ids (`'A:B'`, `'a.b'`, `'a_b'`, ...) can
 * collapse onto the same topic segment. Phase 3 ships with that sanitizer
 * UNCHANGED — the owner decision (§9.1) rejected adding a SHA-256 collision
 * suffix. The safety net instead lives here: before either end of a transcript
 * topic (define, serve grant, publish, or SUB) proceeds, it must atomically
 * claim `(topic -> rawSessionId, ownerDaemonId)` in this process-local
 * registry. A second caller trying to claim the SAME topic for a DIFFERENT raw
 * session id is rejected outright — fail-closed, not "first one wins
 * silently". The caller must fall back to legacy `read_chat`/`chat_history`;
 * it must never proceed with a payload whose raw identity it cannot trust the
 * topic name to carry.
 *
 * ★ This registry only holds the LOCAL side of the handshake and is a pure,
 * in-memory primitive with no seqscribe/network dependency. The two-sided
 * activation handshake that exchanges these fields between daemon and peer,
 * and wires this registry into actual define/serve/publish/SUB calls, is a
 * later commit unit (§8 unit 3 — "dynamic transcript activation + daemon
 * replica store"). This unit only has to make the claim primitive itself
 * correct and testable in isolation.
 */

export interface TranscriptTopicClaim {
    readonly topic: string;
    readonly rawSessionId: string;
    readonly ownerDaemonId: string;
}

export type TranscriptTopicClaimRejectReason = 'raw_session_id_conflict';

export type TranscriptTopicClaimResult =
    | { readonly ok: true }
    | {
          readonly ok: false;
          readonly reason: TranscriptTopicClaimRejectReason;
          readonly existing: TranscriptTopicClaim;
      };

/**
 * Process-local `topic -> claim` table. One instance is meant to be shared by
 * both the publisher and subscriber sides of a single seqscribe node (daemon
 * process) — it is NOT persisted and NOT synced; it exists purely to make a
 * same-process collision fail loudly instead of silently mixing two sessions'
 * content under one topic name.
 */
export class TranscriptTopicClaimRegistry {
    private readonly claims = new Map<string, TranscriptTopicClaim>();

    /**
     * Attempt to (re)claim `next.topic` for `next.rawSessionId`/`ownerDaemonId`.
     *
     * - No prior claim: the topic is claimed, `{ ok: true }`.
     * - Prior claim with the SAME raw session id: idempotent re-claim — this is
     *   the normal reconnect/owner-refresh path (the owner daemon may change
     *   while the raw session id stays fixed, e.g. an owner handoff), so the
     *   stored claim's `ownerDaemonId` is updated and `{ ok: true }` returned.
     * - Prior claim with a DIFFERENT raw session id: fail-closed. The existing
     *   claim is left untouched and returned so the caller can log/diagnose it.
     */
    claim(next: TranscriptTopicClaim): TranscriptTopicClaimResult {
        const existing = this.claims.get(next.topic);
        if (existing && existing.rawSessionId !== next.rawSessionId) {
            return { ok: false, reason: 'raw_session_id_conflict', existing };
        }
        this.claims.set(next.topic, next);
        return { ok: true };
    }

    /** Current claim for `topic`, if any. */
    get(topic: string): TranscriptTopicClaim | undefined {
        return this.claims.get(topic);
    }

    /** Release a claim — daemon-side session teardown. */
    release(topic: string): void {
        this.claims.delete(topic);
    }

    /** Test/diagnostic helper — number of currently claimed topics. */
    get size(): number {
        return this.claims.size;
    }
}
