/**
 * Keyed chat transcript parity — design 2026-09-28 (message-keyed storage) §5.5.
 *
 * Compares, per `(session, epoch, frame)`, the COMMITTED state two independent
 * paths produced:
 *
 *   expected — the frame the publisher just built from the legacy read_chat
 *              observation (live `(id, rev)` set, digest, and the observed
 *              bubbles as a reader should materialize them);
 *   actual   — the producer's own topic read back at that commit's watermark
 *              and folded by `KeyedTranscriptFolder`
 *              (transcript-parity-actual.ts).
 *
 * A difference is a real encode/storage/fold defect, not a timing gap: both
 * sides describe the same commit.
 *
 *   missing_complete_revision — no verifiable commit could be read back. The
 *                                one repairable class: first sighting goes to a
 *                                grace set, a second one for the same session
 *                                counts as persistent.
 *   wrong_session / wrong_owner / digest_mismatch / missing_message /
 *   extra_message / rev_regression / field_mismatch — persistent on FIRST
 *                                observation.
 *
 * ★ §6.1 content boundary: log lines and mismatch records carry identifiers,
 * mismatch class and field NAMES only — never a message/title/modal value.
 * `messageId`s are not content, but are truncated like session ids anyway.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { ChatCommitV2, ReplicatedTranscriptMessageV2, ReplicatedTranscriptViewV2 } from './transcript-keyed-codec.js';

export type TranscriptParityMismatchKind =
    | 'missing_complete_revision'
    | 'field_mismatch'
    | 'missing_message'
    | 'extra_message'
    | 'rev_regression'
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
    missingMessage: number;
    extraMessage: number;
    revRegression: number;
    wrongSession: number;
    wrongOwner: number;
    digestMismatch: number;
    /** Sum of every mismatch class. */
    mismatches: number;
    /** Mismatches counted persistent — see the header's recurrence rule. */
    persistentMismatches: number;
    /** Comparisons run since process start. */
    runs: number;
    /** Distinct session keys compared at least once since process start. */
    sessionsObserved: number;
    /**
     * Distinct session keys compared at least TWICE — the ones for which the
     * missing-commit recurrence rule could fire. If this is 0,
     * `persistentMismatches === 0` is UNDECIDED, not clean.
     */
    sessionsRepeated: number;
    /** Revisits of a session already in the missing-commit grace set. */
    pendingMissingRevisits: number;
    /** Session keys currently in the missing-commit grace set. */
    pendingMissingOpen: number;
    /**
     * `Date.now()` at module load — effectively process start. Every counter is
     * PROCESS-LOCAL; this dates the zero.
     */
    since: number;
}

function freshCounters(): TranscriptParityCounters {
    return {
        compared: 0,
        missingCompleteRevision: 0,
        fieldMismatch: 0,
        missingMessage: 0,
        extraMessage: 0,
        revRegression: 0,
        wrongSession: 0,
        wrongOwner: 0,
        digestMismatch: 0,
        mismatches: 0,
        persistentMismatches: 0,
        runs: 0,
        sessionsObserved: 0,
        sessionsRepeated: 0,
        pendingMissingRevisits: 0,
        pendingMissingOpen: 0,
        since: Date.now(),
    };
}

let counters: TranscriptParityCounters = freshCounters();
/** Comparisons per session key (keys only). Bounded by the sessions published. */
const observedSessions = new Map<string, number>();
/** Session keys whose last comparison found no verifiable commit. */
const pendingMissing = new Set<string>();

export function redactSessionId(id: string): string {
    return id.length <= 8 ? id : `${id.slice(0, 8)}…(${id.length})`;
}

/** The expected side: what the publisher committed, and the bubbles it observed. */
export interface TranscriptChatParityExpected {
    readonly sessionId: string;
    readonly producerDaemonId: string;
    /** Live `(messageId, rev)` after the frame. */
    readonly live: ReadonlyMap<string, number>;
    readonly digest: string;
    /** The observed bubbles (a subset of `live` when a window source retained some). */
    readonly messages: readonly ReplicatedTranscriptMessageV2[];
}

export type TranscriptParityActual =
    | { readonly status: 'missing' }
    | { readonly status: 'found'; readonly view: ReplicatedTranscriptViewV2; readonly commit: ChatCommitV2 };

const COMPARED_FIELDS = ['ord', 'role', 'kind', 'content', 'bubbleState', 'turnKey', 'toolName', 'expandable'] as const;

/**
 * Compare ONE commit's expected state against its read-back. Never throws —
 * parity is diagnostics.
 */
export function compareTranscriptChat(
    sessionKey: string,
    expected: TranscriptChatParityExpected,
    actual: TranscriptParityActual,
): TranscriptParityMismatch[] {
    counters.runs++;
    counters.compared++;
    const seen = (observedSessions.get(sessionKey) ?? 0) + 1;
    observedSessions.set(sessionKey, seen);
    if (seen === 1) counters.sessionsObserved++;
    else if (seen === 2) counters.sessionsRepeated++;
    if (pendingMissing.has(sessionKey)) counters.pendingMissingRevisits++;

    const redacted = redactSessionId(sessionKey);
    const mismatches: TranscriptParityMismatch[] = [];
    const persistent = (kind: TranscriptParityMismatchKind, fields?: string[]) => {
        mismatches.push({ kind, session: redacted, ...(fields ? { fields } : {}) });
        counters.persistentMismatches++;
    };

    if (actual.status === 'missing') {
        mismatches.push({ kind: 'missing_complete_revision', session: redacted });
        counters.missingCompleteRevision++;
        if (pendingMissing.has(sessionKey)) {
            counters.persistentMismatches++;
            LOG.warn('Seqscribe', `transcript parity mismatch PERSISTED session=${redacted} kind=missing_complete_revision`);
        }
        pendingMissing.add(sessionKey);
    } else {
        pendingMissing.delete(sessionKey);
        const view = actual.view;
        if (expected.sessionId !== view.sessionId) {
            counters.wrongSession++;
            persistent('wrong_session');
        } else if (!daemonIdsEquivalent(expected.producerDaemonId, actual.commit.producerDaemonId)) {
            counters.wrongOwner++;
            persistent('wrong_owner');
        } else {
            const actualById = new Map(view.messages.map((m) => [m.messageId, m] as const));
            let missing = 0;
            let regressed = 0;
            for (const [id, rev] of expected.live) {
                const found = actualById.get(id);
                if (!found) missing++;
                else if (found.rev < rev) regressed++;
            }
            let extra = 0;
            for (const id of actualById.keys()) if (!expected.live.has(id)) extra++;
            if (missing > 0) {
                counters.missingMessage++;
                persistent('missing_message');
            }
            if (extra > 0) {
                counters.extraMessage++;
                persistent('extra_message');
            }
            if (regressed > 0) {
                counters.revRegression++;
                persistent('rev_regression');
            }
            const fields = new Set<string>();
            for (const message of expected.messages) {
                const found = actualById.get(message.messageId);
                if (!found) continue;
                for (const field of COMPARED_FIELDS) {
                    if (message[field] !== found[field]) fields.add(field);
                }
                if (found.rev !== message.rev && !(found.rev < message.rev)) fields.add('rev');
            }
            if (fields.size > 0) {
                counters.fieldMismatch++;
                persistent('field_mismatch', [...fields].sort());
            }
            if (actual.commit.digest !== expected.digest && mismatches.length === 0) {
                counters.digestMismatch++;
                persistent('digest_mismatch');
            }
        }
    }

    counters.mismatches += mismatches.length;
    for (const m of mismatches) {
        LOG.info(
            'Seqscribe',
            `transcript parity mismatch kind=${m.kind} session=${m.session}` + (m.fields?.length ? ` fields=${m.fields.join(',')}` : ''),
        );
    }
    return mismatches;
}

/** Snapshot of the parity counters. */
export function transcriptParityCounters(): TranscriptParityCounters {
    return { ...counters, pendingMissingOpen: pendingMissing.size };
}

/** Reset counters. TESTS ONLY. */
export function __resetTranscriptParityForTests(): void {
    counters = freshCounters();
    pendingMissing.clear();
    observedSessions.clear();
}
