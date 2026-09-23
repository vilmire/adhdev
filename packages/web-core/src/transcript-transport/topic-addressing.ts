/**
 * `session.<safeSessionId>.transcript` topic addressing — browser-worker
 * mirror of `oss/packages/daemon-core/src/seqscribe/topics.ts`'s
 * `safeSessionId`/`sessionTranscriptTopic`/`sessionTranscriptPolicy` (design
 * §3.1, §3.5).
 *
 * ── Why this is a DUPLICATE, not an import ──────────────────────────────────
 * `topics.ts` is not portable: it imports `authority.ts`, which imports
 * `../logging/logger.ts`, which imports Node's `fs`/`path` — pulling any of
 * that into a browser Worker bundle either fails to resolve or ships dead
 * Node-only code to the client. `check:vendor`/`check:boundaries` do not cover
 * cross-package duplication like this, so the two copies are kept honest by
 * the "known-answer" test vectors below, hand-copied from the SAME inputs
 * `topics.ts` documents (`A:B`, `a.b`, long-prefix collision cases, the
 * `ADHDEV_AUTHORITY_ID` constant). If daemon-core's sanitizer or policy ever
 * changes, this file's test MUST be updated in the same commit — that is the
 * enforcement mechanism here, not a build-time link.
 *
 * `safeSessionId` is deliberately NOT injective (§3.5) — the fail-closed
 * two-end raw-id claim on the DAEMON side is what actually defends against a
 * collision; this file only has to compute the SAME topic string the daemon
 * defined, so it can subscribe to it.
 */
import type { TopicPolicy } from 'seqscribe';

const TOPIC_SEGMENT_UNSAFE = /[^a-z0-9_-]+/g;

function sanitizeSegment(raw: string, fallback: string): string {
    const cleaned = raw.toLowerCase().replace(TOPIC_SEGMENT_UNSAFE, '_').replace(/^_+|_+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

/** Mirrors `topics.ts#safeSessionId` — see this file's header. */
export function safeSessionId(sessionId: string): string {
    return sanitizeSegment(sessionId, 'unknown_session');
}

/** Mirrors `topics.ts#sessionTranscriptTopic`. */
export function sessionTranscriptTopic(sessionId: string): string {
    return `session.${safeSessionId(sessionId)}.transcript`;
}

/** Mirrors `topics.ts#ADHDEV_AUTHORITY_ID` (`authority.ts`). */
export const ADHDEV_AUTHORITY_ID = 'adhdev-coordinator';

/** Mirrors `topics.ts#SESSION_TRANSCRIPT_RING`. */
export const SESSION_TRANSCRIPT_RING = 500;

/**
 * Mirrors `topics.ts#sessionTranscriptPolicy`.
 *
 * ★ `finalityAuthority` MUST STAY — do not delete it "because the browser
 * cannot sign". It is not a capability claim; it is an input to
 * `topicSchemaHash` (seqscribe SPEC §14 / host-guide §6). Dropping it here
 * while the daemon keeps it forks the hash, and every daemon peer then rejects
 * this topic with `ERR_SCHEMA_MISMATCH`. Removing it fleet-wide is separately
 * forbidden by the Phase 3 design doc.
 *
 * What the browser lacks is the SIGNING key, not the field. seqscribe's gate
 * (`vendor/seqscribe/src/topics.ts:53-54`) only requires that an
 * `AuthorityHooks.verifyFinality` *exists* — so the browser supplies the
 * non-signing `browserRejectAuthority` and this policy stays byte-identical to
 * the daemon's.
 *
 * ★ G2b (landed 2026-09-24): retention is now `{mode:'full'}`, matching
 * daemon-core exactly. The earlier revert's blocker (`subs.ts`'s
 * `view:'tail'` throwing `ERR_UNKNOWN_VIEW` for any non-ring topic) is
 * resolved upstream — `tail` now also serves `full` + `subscribe-only`
 * topics, which is what both this file's own live delivery path
 * (`transcript-session-subscription.ts`) and the daemon's use. This file's
 * whole enforcement mechanism is "stay byte-identical to the daemon's
 * policy, checked by a structural-equality test" (`browser-reject-
 * authority.test.ts`) — see `topics.ts#sessionTranscriptPolicy` for the full
 * account, including why a browser-side hard cap is not needed (only the
 * daemon-side `writer-gc.ts` prunes; the browser never accumulates durable
 * rows of its own).
 */
export function sessionTranscriptPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'subscribe-only',
        access: 'content',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
    };
}
