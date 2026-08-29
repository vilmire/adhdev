/**
 * Transcript parity comparator — design §5.3/§5.4, §8 unit 2.
 *
 * Same recurrence discipline `mesh-parity.ts` established for Phase 2's
 * `mesh.<id>.events` shadow, applied to the transcript producer/replica pair:
 *
 *   missing_complete_revision — first observation goes to a pending set (a
 *                                repair opportunity); reported AGAIN on a later
 *                                sweep is a real failure and counts as
 *                                persistent immediately (design §5.4).
 *   field_mismatch / extra_message / wrong_session / wrong_owner /
 *   digest_mismatch — count as persistent on FIRST observation. None of these
 *                                are repairable the way a late mirror repairs
 *                                a missing shadow record — a divergent replica
 *                                is evidence of a real encode/identity bug, not
 *                                a timing gap.
 *
 * ★ Comparison unit (design §5.3): "비교 단위는 (rawSessionId, producerEpoch,
 * normalizedSnapshotSha256)의 latest committed revision이다" — the CALLER picks
 * one `expected` (from the just-collected `TranscriptObservation`, stamped and
 * encoded) and one `actual` (the subscriber assembler's latest verified
 * complete snapshot) per comparison; this module never fetches either side
 * itself. Wiring `actual` to a LIVE subscriber replica is `§8 unit 3` (`the
 * daemon replica store does not exist yet in this unit — see
 * transcript-publisher.ts's header for the same boundary applied to
 * publishing).
 *
 * ★ §6.1 content boundary: mismatch log lines and the `TranscriptParityMismatch`
 * record carry identifiers, mismatch class, and field NAMES only — never a
 * message/title/modal value. `redactSessionId` truncates the session id the
 * same way `mesh-parity.ts#shortId` truncates ledger entry ids.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { ReplicatedTranscriptSnapshotV1 } from './transcript-projection.js';
import { hashTranscriptSnapshot } from './transcript-projection.js';

export type TranscriptParityMismatchKind =
    | 'missing_complete_revision'
    | 'field_mismatch'
    | 'extra_message'
    | 'wrong_session'
    | 'wrong_owner'
    | 'digest_mismatch';

export interface TranscriptParityMismatch {
    kind: TranscriptParityMismatchKind;
    /** Redacted — never the raw session id (§6.1). */
    session: string;
    /** Names (never values) of the fields that disagree. Only for `field_mismatch`. */
    fields?: string[];
}

/** Aggregate counters. Integers only — this feeds the stats bucket (stats.ts). */
export interface TranscriptParityCounters {
    compared: number;
    missingCompleteRevision: number;
    fieldMismatch: number;
    extraMessage: number;
    wrongSession: number;
    wrongOwner: number;
    digestMismatch: number;
    /** Sum of the six mismatch classes. */
    mismatches: number;
    /** Mismatches that SURVIVED a repair attempt — see the header's recurrence rule. */
    persistentMismatches: number;
    /** Comparisons run since process start. */
    runs: number;
}

const counters: TranscriptParityCounters = {
    compared: 0,
    missingCompleteRevision: 0,
    fieldMismatch: 0,
    extraMessage: 0,
    wrongSession: 0,
    wrongOwner: 0,
    digestMismatch: 0,
    mismatches: 0,
    persistentMismatches: 0,
    runs: 0,
};

/**
 * Session keys reported `missing_complete_revision` by a PREVIOUS sweep and
 * not yet seen repaired. Same one-sweep-grace mechanism as
 * `mesh-parity.ts#pendingMissing`, keyed by the redacted-safe raw session key
 * the caller passes (a stable per-session string, e.g.
 * `${ownerDaemonId}:${rawSessionId}` — this module never parses it).
 */
const pendingMissing = new Set<string>();

export function redactSessionId(id: string): string {
    return id.length <= 8 ? id : `${id.slice(0, 8)}…(${id.length})`;
}

/**
 * Compare the ordered, closed-allow-list message fields a divergence in
 * content/identity would actually change. Returns field NAMES only.
 */
function diffMessages(expected: ReplicatedTranscriptSnapshotV1, actual: ReplicatedTranscriptSnapshotV1): string[] {
    const fields: string[] = [];
    const len = Math.min(expected.messages.length, actual.messages.length);
    for (let i = 0; i < len; i++) {
        const e = expected.messages[i]!;
        const a = actual.messages[i]!;
        if (e.role !== a.role) fields.push(`messages[${i}].role`);
        if (e.kind !== a.kind) fields.push(`messages[${i}].kind`);
        if (e.content !== a.content) fields.push(`messages[${i}].content`);
        if (e.bubbleState !== a.bubbleState) fields.push(`messages[${i}].bubbleState`);
        if (e.turnKey !== a.turnKey) fields.push(`messages[${i}].turnKey`);
    }
    return fields;
}

/**
 * Content digest with producer identity/revision/observedAt zeroed out —
 * the same exclusion `transcript-observation.ts#hashTranscriptObservation`
 * applies, for the same reason: `wrong_owner` above already tolerates
 * `daemonIdsEquivalent` variance (e.g. `mach_x` vs `daemon_mach_x` for the
 * SAME machine), so hashing the raw `producerDaemonId` string in here would
 * report a false `digest_mismatch` on every legitimately-equivalent pair that
 * survived the wrong_owner check, and revision/observedAt differ across two
 * independently-collected sides BY CONSTRUCTION.
 */
function contentDigest(snapshot: ReplicatedTranscriptSnapshotV1): string {
    return hashTranscriptSnapshot({
        ...snapshot,
        producerDaemonId: '',
        producerWriterId: '',
        producerEpoch: '',
        revision: 0,
        observedAt: '',
    });
}

function diffScalars(expected: ReplicatedTranscriptSnapshotV1, actual: ReplicatedTranscriptSnapshotV1): string[] {
    const fields: string[] = [];
    if (expected.status !== actual.status) fields.push('status');
    if (expected.providerObservedStatus !== actual.providerObservedStatus) fields.push('providerObservedStatus');
    if (expected.title !== actual.title) fields.push('title');
    if (expected.providerType !== actual.providerType) fields.push('providerType');
    if (expected.coverage.mode !== actual.coverage.mode) fields.push('coverage.mode');
    if (expected.coverage.totalMessageCount !== actual.coverage.totalMessageCount) fields.push('coverage.totalMessageCount');
    if (expected.coverage.returnedMessageCount !== actual.coverage.returnedMessageCount) fields.push('coverage.returnedMessageCount');
    return fields;
}

export type TranscriptParityActual =
    | { readonly status: 'missing' }
    | { readonly status: 'found'; readonly snapshot: ReplicatedTranscriptSnapshotV1 };

/**
 * Compare ONE (sessionKey, expected) pair against the caller-supplied actual
 * side. Never throws — parity is diagnostics, matching `runMeshParityCheck`.
 */
export function compareTranscriptRevision(
    sessionKey: string,
    expected: ReplicatedTranscriptSnapshotV1,
    actual: TranscriptParityActual,
): TranscriptParityMismatch[] {
    counters.runs++;
    counters.compared++;
    const redacted = redactSessionId(sessionKey);
    const mismatches: TranscriptParityMismatch[] = [];

    if (actual.status === 'missing') {
        mismatches.push({ kind: 'missing_complete_revision', session: redacted });
        counters.missingCompleteRevision++;
        if (pendingMissing.has(sessionKey)) {
            counters.persistentMismatches++;
            LOG.warn('Seqscribe', `transcript parity mismatch PERSISTED session=${redacted} kind=missing_complete_revision`);
        }
        pendingMissing.add(sessionKey);
    } else {
        // A later sweep that finds a complete revision is positive evidence the
        // earlier miss was repaired — same replace-not-merge rule as
        // mesh-parity.ts.
        pendingMissing.delete(sessionKey);

        if (expected.sessionId !== actual.snapshot.sessionId) {
            mismatches.push({ kind: 'wrong_session', session: redacted });
            counters.wrongSession++;
            counters.persistentMismatches++;
        } else if (!daemonIdsEquivalent(expected.producerDaemonId, actual.snapshot.producerDaemonId)) {
            mismatches.push({ kind: 'wrong_owner', session: redacted });
            counters.wrongOwner++;
            counters.persistentMismatches++;
        } else if (expected.messages.length !== actual.snapshot.messages.length) {
            mismatches.push({ kind: 'extra_message', session: redacted });
            counters.extraMessage++;
            counters.persistentMismatches++;
        } else {
            const fields = [...diffScalars(expected, actual.snapshot), ...diffMessages(expected, actual.snapshot)];
            if (fields.length > 0) {
                mismatches.push({ kind: 'field_mismatch', session: redacted, fields });
                counters.fieldMismatch++;
                counters.persistentMismatches++;
            } else if (contentDigest(expected) !== contentDigest(actual.snapshot)) {
                // Every field this module knows to compare matched, yet the
                // canonical hash still differs — a field the allow-list carries
                // but this comparator does not yet diff explicitly. Never
                // silently treat that as parity; report it so the gap gets a
                // named field once someone chases it down.
                mismatches.push({ kind: 'digest_mismatch', session: redacted });
                counters.digestMismatch++;
                counters.persistentMismatches++;
            }
        }
    }

    counters.mismatches += mismatches.length;
    if (mismatches.length > 0) {
        for (const m of mismatches) {
            LOG.info(
                'Seqscribe',
                `transcript parity mismatch kind=${m.kind} session=${m.session}` +
                    (m.fields?.length ? ` fields=${m.fields.join(',')}` : ''),
            );
        }
    }
    return mismatches;
}

/** Snapshot of the parity counters. */
export function transcriptParityCounters(): TranscriptParityCounters {
    return { ...counters };
}

/** Reset counters. TESTS ONLY. */
export function __resetTranscriptParityForTests(): void {
    counters.compared = 0;
    counters.missingCompleteRevision = 0;
    counters.fieldMismatch = 0;
    counters.extraMessage = 0;
    counters.wrongSession = 0;
    counters.wrongOwner = 0;
    counters.digestMismatch = 0;
    counters.mismatches = 0;
    counters.persistentMismatches = 0;
    counters.runs = 0;
    pendingMissing.clear();
}
