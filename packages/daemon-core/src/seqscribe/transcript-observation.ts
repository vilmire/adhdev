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
 * Canonical content hash over the observation ONLY — never over the stamped
 * candidate. This is what makes design §3.4's rule implementable: "snapshot
 * hash가 직전 complete hash와 같으면 append하지 않는다" ("if the snapshot hash
 * matches the previous complete hash, do not append") is about CONTENT being
 * unchanged, not about the revision counter or observedAt timestamp being
 * unchanged — those always differ across two calls by construction, so hashing
 * them in would make every observation "new" and defeat the dedup entirely.
 */
export function hashTranscriptObservation(observation: TranscriptObservation): string {
    return sha256HexUtf8(jcs(observation as unknown as JsonValue));
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
