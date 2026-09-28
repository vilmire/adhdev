/**
 * `TranscriptObservation` — the single-collection choke point (design §5.2,
 * §8 unit 2: "single observation publisher").
 *
 * `TranscriptObservation` is `TranscriptSnapshotCandidate` (transcript-
 * projection.ts, §8 unit 1) MINUS the fields the PUBLISHER stamps at publish
 * time rather than the fields read_chat's last mile observes:
 *
 *   - `producerDaemonId` / `producerWriterId` / `producerEpoch` / `revision` —
 *     producer/session identity and the monotonic counter, owned by
 *     `TranscriptProjectionService` (transcript-publisher.ts), never by the
 *     read_chat call that happened to trigger a publish.
 *   - `observedAt` — stamped alongside identity, for the same reason: two
 *     `read_chat` calls one millisecond apart with byte-identical content
 *     must NOT mint two revisions (design §3.4's stable-hash-skips-append
 *     rule), so `observedAt` cannot be part of what the dedup hash compares.
 *
 * This is the ONE object both the legacy `SessionChatTailUpdate` selector and
 * the seqscribe encoder are meant to derive from (design §1.3, §5.2) — no
 * second `read_chat` call, no second normalization pass. Building one FROM the
 * real `ChatMessage[]`/`SessionTurnPresentation` shapes (which requires
 * `providers/contracts.ts#flattenContent` and `mesh/mesh-turn-presentation.ts`)
 * is `commands/transcript-observation-builder.ts` — NOT this file, because
 * `check:boundaries` forbids `seqscribe/** -> providers/**|mesh/**` value
 * imports and this module stays producer-neutral like the rest of `seqscribe/`
 * (see transcript-projection.ts's header for the same rule applied to
 * `TranscriptSnapshotCandidate`).
 */

import { jcs, sha256HexUtf8, type JsonValue } from 'seqscribe';
import { encodeTranscriptSnapshot } from './transcript-projection.js';
import type {
    TranscriptSnapshotCandidate,
    TranscriptSnapshotCandidateCoverage,
    TranscriptSnapshotCandidateMessage,
    TranscriptSnapshotCandidateModal,
    TranscriptSnapshotCandidatePrompt,
    TranscriptSnapshotCandidateProvenance,
    TranscriptSnapshotCandidateTerminalMarker,
    TranscriptSnapshotCandidateTurn,
} from './transcript-projection.js';
import type { TranscriptRevisionIdentity } from './transcript-revision-codec.js';

/**
 * Explicitly listed rather than `Omit<TranscriptSnapshotCandidate, ...>` on
 * purpose: `TranscriptSnapshotCandidate` carries a `[extra: string]: unknown`
 * index signature (deliberately, per its own header — candidates are loosely
 * typed upstream shapes), and `keyof` a type with an index signature collapses
 * to `string`. `Omit`/`Pick` over that would silently widen every named field
 * here to `unknown` instead of erroring — TS caught this immediately as
 * "missing properties" when the mapped-type version was tried, which is the
 * good outcome; a `Record<string, unknown>` shape would have compiled and
 * hidden it. See `check:type-scale`-adjacent precedent: explicit interfaces
 * over derived types whenever an index signature is in the source.
 */
export interface TranscriptObservation {
    readonly sessionId: string;
    readonly historySessionId?: unknown;
    readonly providerType: string;
    readonly providerSessionId?: unknown;

    readonly status: string;
    readonly providerObservedStatus?: unknown;
    readonly title?: unknown;
    readonly activeModal?: TranscriptSnapshotCandidateModal | null;
    readonly activeInteractivePrompt?: TranscriptSnapshotCandidatePrompt | null;
    readonly turn?: TranscriptSnapshotCandidateTurn | null;

    readonly provenance?: TranscriptSnapshotCandidateProvenance;
    readonly messages: readonly TranscriptSnapshotCandidateMessage[];
    readonly terminalMarkers?: readonly TranscriptSnapshotCandidateTerminalMarker[];
    readonly coverage: TranscriptSnapshotCandidateCoverage;

    readonly [extra: string]: unknown;
}

/** Merge a collected observation with publish-time identity into a full candidate. */
export function stampTranscriptObservation(
    observation: TranscriptObservation,
    identity: TranscriptRevisionIdentity,
    observedAt: string,
): TranscriptSnapshotCandidate {
    return {
        ...observation,
        producerDaemonId: identity.producerDaemonId,
        producerWriterId: identity.producerWriterId,
        producerEpoch: identity.producerEpoch,
        revision: identity.revision,
        observedAt,
    };
}

/**
 * Fixed identity/timestamp the dedup hash stamps onto every observation, so
 * the only thing that can move the hash is CONTENT.
 */
const DEDUP_HASH_IDENTITY: TranscriptRevisionIdentity = {
    sessionId: '',
    producerDaemonId: '',
    producerWriterId: '',
    producerEpoch: '',
    revision: 0,
};
const DEDUP_HASH_OBSERVED_AT = '';

/**
 * Canonical content hash for design §3.4's rule — "snapshot hash가 직전
 * complete hash와 같으면 append하지 않는다" ("if the snapshot hash matches the
 * previous complete hash, do not append"). That rule is about the CONTENT a
 * subscriber would receive being unchanged, not about the revision counter or
 * observedAt timestamp — those always differ across two calls by construction,
 * so they are stamped with fixed values here.
 *
 * ★ Hashed over the WIRE projection (`encodeTranscriptSnapshot`), never over
 * the raw observation. The observation carries producer-side fields the
 * allow-list encoder drops — `provenance.messageSource` is a whole object
 * whose `staleness.sourceMtimeAgeMs` is `Date.now() - mtime` and so changes
 * on EVERY read, plus per-message `meta` of which only `streaming` travels.
 * Hashing the raw observation made every PTY-throttled read (350 ms) look
 * "new": measured 2026-09-28 on a preview daemon, ~95% of one session's
 * revisions differed from their predecessor only in `revision`/`observedAt`
 * — 41,928 revisions in 27.7 h, ~55 KB each, 2.3 GB of sq_log. Hashing the
 * projection dedups exactly the revisions no reader could tell apart.
 */
export function hashTranscriptObservation(observation: TranscriptObservation): string {
    const projected = encodeTranscriptSnapshot(
        stampTranscriptObservation(observation, DEDUP_HASH_IDENTITY, DEDUP_HASH_OBSERVED_AT),
    );
    return sha256HexUtf8(jcs(projected as unknown as JsonValue));
}

/**
 * An observation with no messages and no title/modal/prompt/turn is the
 * "transient empty read" shape design §3.4 says must not silently replace a
 * previously-published non-empty revision — see the `verifiedClear` guard in
 * `TranscriptProjectionService.publishObservation`.
 */
export function isEmptyTranscriptObservation(observation: TranscriptObservation): boolean {
    return (
        observation.messages.length === 0 &&
        !observation.title &&
        !observation.activeModal &&
        !observation.activeInteractivePrompt
    );
}
