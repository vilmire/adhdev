/**
 * `session.<safeSessionId>.chat` topic addressing — browser-worker mirror of
 * `oss/packages/daemon-core/src/seqscribe/topics.ts`'s
 * `safeSessionId`/`sessionChatTopic`/`sessionChatPolicy` (design 2026-09-28
 * message-keyed storage §4.1, §5.4).
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

/**
 * Mirrors `topics.ts#sessionChatTopic` — the keyed per-session chat topic
 * (design 2026-09-28 message-keyed storage §4.1). The whole-snapshot topic
 * it replaced was removed in the same change (§6).
 */
export function sessionChatTopic(sessionId: string): string {
    return `session.${safeSessionId(sessionId)}.chat`;
}

/** Mirrors `topics.ts#ADHDEV_AUTHORITY_ID` (`authority.ts`). */
export const ADHDEV_AUTHORITY_ID = 'adhdev-coordinator';

/** Mirrors `topics.ts#CHAT_TOMBSTONE_KIND` (the policy's `keyed.tombstoneKind`). */
export const CHAT_TOMBSTONE_KIND = 'chat.del.v2';

/**
 * Mirrors `topics.ts#sessionChatPolicy` — byte-identical, same key order
 * (`check:topic-sanitizer-parity` diffs the two bodies).
 *
 * ★ `finalityAuthority` MUST STAY — do not delete it "because the browser
 * cannot sign". It is not a capability claim; it is an input to
 * `topicSchemaHash` (seqscribe SPEC §14 / host-guide §6). Dropping it here
 * while the daemon keeps it forks the hash, and every daemon peer then rejects
 * this topic with `ERR_SCHEMA_MISMATCH`.
 *
 * What the browser lacks is the SIGNING key, not the field. seqscribe's gate
 * only requires that an `AuthorityHooks.verifyFinality` *exists* — so the
 * browser supplies the non-signing `browserRejectAuthority` and this policy
 * stays byte-identical to the daemon's.
 *
 * `keyed`, like `retention` and `replication`, is a LOCAL storage policy and
 * is not part of `topicSchemaHash`; it is still mirrored exactly so both ends
 * describe the topic the same way (`topics.ts#sessionChatPolicy`). The browser
 * never appends to this topic and never accumulates durable rows of its own —
 * it only folds the `tail` SUB it receives (`transcript-session-subscription.ts`).
 */
export function sessionChatPolicy(): TopicPolicy {
    return {
        kind: 'append',
        keyed: { tombstoneKind: CHAT_TOMBSTONE_KIND },
        retention: { mode: 'full' },
        replication: 'subscribe-only',
        access: 'content',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
    };
}
