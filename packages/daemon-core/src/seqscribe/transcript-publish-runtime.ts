/**
 * Arms `TranscriptProjectionService`'s abstract `publishRevision` against a
 * REAL seqscribe node — design §8 unit 3, the exact gap transcript-
 * publisher.ts's header names as this unit's job: "wiring an encoder call to
 * a live `node.log(topic).append` is §8 unit 3".
 *
 * Also closes the SECOND deferral transcript-parity.ts's header leaves for
 * this unit — wiring the comparator's `actual` side. Design §3.3 sanctions
 * exactly this shape for parity specifically (not live display): read back
 * what was just appended, via `scanEntries`/`headOrder`
 * (transcript-parity-actual.ts), and compare it against the in-memory
 * envelope this function just encoded. That is a real regression check on the
 * append+storage round-trip (codec bugs, JCS canonicalization drift, a future
 * change to `encodeTranscriptRevision` that silently stops round-tripping) —
 * not a tautology, because "expected" and "actual" go through two INDEPENDENT
 * assembler instances fed from two different sources (the in-memory envelope
 * vs. what the node's storage actually returns for the same topic).
 *
 * A parity failure here NEVER blocks the append that already succeeded — it
 * is diagnostics only (`compareTranscriptRevision` itself never throws), and
 * is best-effort wrapped so an assembler bug in the self-check path can never
 * turn a successful publish into a rejected one.
 */

import type { JsonValue } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { ensureSessionTranscriptTopic } from './transcript-activation.js';
import { readLocalTranscriptParityActual } from './transcript-parity-actual.js';
import { compareTranscriptRevision, redactSessionId } from './transcript-parity.js';
import { MAX_TRACKED_SESSIONS, type TranscriptRevisionEnvelope } from './transcript-publisher.js';
import type { TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    TranscriptRevisionAssembler,
} from './transcript-revision-codec.js';

/**
 * Decode an envelope this process JUST BUILT back into a snapshot, purely
 * in-memory (no I/O) — the "expected" side of the self-check. Uses the same
 * assembler the SUB path uses, fed with `writer=writerId` for every row since
 * these are not real wire rows (no `seq` yet assigned by the log).
 */
function decodeOwnEnvelope(writerId: string, envelope: TranscriptRevisionEnvelope) {
    const assembler = new TranscriptRevisionAssembler(writerId);
    assembler.ingestRow({ writer: writerId, seq: 0, kind: TRANSCRIPT_REVISION_BEGIN_KIND, payload: envelope.begin });
    envelope.chunks.forEach((chunk, index) => {
        assembler.ingestRow({ writer: writerId, seq: index + 1, kind: TRANSCRIPT_REVISION_CHUNK_KIND, payload: chunk });
    });
    return assembler.ingestRow({
        writer: writerId,
        seq: envelope.chunks.length + 1,
        kind: TRANSCRIPT_REVISION_COMMIT_KIND,
        payload: envelope.commit,
    });
}

/**
 * Minimum wall-clock gap between two parity READ-BACKS for one session (the
 * `readLocalTranscriptParityActual` + `compareTranscriptRevision` half of the
 * self-check). The in-memory `decodeOwnEnvelope` codec check still runs on
 * every publish; only the storage read-back is sampled.
 *
 * Why sample: measured on a preview daemon (rc.47), one live session hit the
 * 350 ms PTY throttle ceiling (~2.5 publishes/s), and the per-publish
 * read-back — JSON-parse + SHA-256 of the scanned revision rows — was ~20% of
 * a core. Parity is diagnostics by design (see transcript-parity-actual.ts's
 * header; `compareTranscriptRevision` never throws and never gates the
 * append), so checking a sample loses no correctness: a systematic
 * round-trip defect still shows up on the first publish and at least every
 * interval thereafter.
 *
 * Override with `ADHDEV_TRANSCRIPT_PARITY_SAMPLE_MS` (`0` = read back on every
 * publish — tests that need deterministic per-publish parity use this).
 */
export const TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS = 10_000;

/**
 * Count-based sampling floor: even inside the interval, every Nth publish of a
 * session is read back, so a long sub-interval burst still gets verified.
 */
export const TRANSCRIPT_PARITY_SAMPLE_EVERY_N = 50;

/** Sampling rows for sessions not published for this long are dropped. */
export const TRANSCRIPT_PARITY_SAMPLE_IDLE_EVICT_MS = 60 * 60 * 1000;

/** Hard cap on sessions the sampler tracks; oldest-seen evicted beyond it. */
export const TRANSCRIPT_PARITY_SAMPLE_MAX_SESSIONS = MAX_TRACKED_SESSIONS;

function resolveParitySampleIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.ADHDEV_TRANSCRIPT_PARITY_SAMPLE_MS;
    if (raw === undefined || raw.trim() === '') return TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS;
}

interface ParitySampleState {
    /** `Date.now()` of the last read-back for this session. */
    lastReadBackAt: number;
    /** Publishes since the last read-back. */
    publishesSinceReadBack: number;
    /** `Date.now()` of the last publish seen — drives idle eviction. */
    lastSeenAt: number;
}

/**
 * Per-publisher sampler. Returns true when this publish should run the
 * read-back. Bounded: idle rows (> `TRANSCRIPT_PARITY_SAMPLE_IDLE_EVICT_MS`)
 * are swept on insert, and the map never exceeds
 * `TRANSCRIPT_PARITY_SAMPLE_MAX_SESSIONS` (Map insertion order ≈ least
 * recently seen, since every publish re-inserts its row).
 */
function createParitySampler(): (sessionId: string) => boolean {
    const state = new Map<string, ParitySampleState>();
    return (sessionId: string): boolean => {
        const intervalMs = resolveParitySampleIntervalMs();
        const now = Date.now();
        const row = state.get(sessionId);
        if (row) state.delete(sessionId);

        let readBack: boolean;
        if (!row || intervalMs === 0) {
            readBack = true;
        } else {
            const publishes = row.publishesSinceReadBack + 1;
            readBack = now - row.lastReadBackAt >= intervalMs || publishes >= TRANSCRIPT_PARITY_SAMPLE_EVERY_N;
        }

        const next: ParitySampleState = readBack
            ? { lastReadBackAt: now, publishesSinceReadBack: 0, lastSeenAt: now }
            : { lastReadBackAt: row!.lastReadBackAt, publishesSinceReadBack: row!.publishesSinceReadBack + 1, lastSeenAt: now };

        if (!row) {
            // New row: sweep idle sessions, then enforce the hard cap.
            for (const [id, other] of state) {
                if (now - other.lastSeenAt > TRANSCRIPT_PARITY_SAMPLE_IDLE_EVICT_MS) state.delete(id);
            }
            while (state.size >= TRANSCRIPT_PARITY_SAMPLE_MAX_SESSIONS) {
                const oldest = state.keys().next().value;
                if (oldest === undefined) break;
                state.delete(oldest);
            }
        }
        state.set(sessionId, next);
        return readBack;
    };
}

/**
 * Build the `publishRevision` function `configureTranscriptProjection` (boot)
 * hands to `TranscriptProjectionService`. `ownerDaemonId` should be the SAME
 * identity `deps.daemonId()` reports — passed separately here only because
 * this factory is called once at boot with the resolved value in hand.
 */
export function createLiveTranscriptPublisher(
    node: SeqscribeNodeHandle,
    claims: TranscriptTopicClaimRegistry,
    ownerDaemonId: string,
): (sessionId: string, envelope: TranscriptRevisionEnvelope) => Promise<void> {
    const shouldReadBack = createParitySampler();
    return async (sessionId: string, envelope: TranscriptRevisionEnvelope): Promise<void> => {
        const activation = ensureSessionTranscriptTopic(node, claims, sessionId, ownerDaemonId);
        if (!activation.ok) {
            throw new Error(
                `transcript topic unavailable session=${redactSessionId(sessionId)} reason=${activation.reason}`,
            );
        }

        const log = node.node.log(activation.topic);
        // Single current-owner writer appends begin/chunks/commit IN ORDER
        // (design §3.3). Order comes from ISSUE order, not await order: every
        // `append` call enqueues synchronously (seqscribe log.ts `push`), the
        // group-commit `flush` drains that queue FIFO, and `processAppend`
        // assigns `seq = head.contigSeq + 1` sequentially as it walks the
        // batch. So issuing all N+2 appends before awaiting preserves
        // begin→chunks→commit exactly, while collapsing what used to be N+2
        // separate GROUP_COMMIT_MS timer waits into (usually) one commit.
        //
        // Failure semantics are unchanged-or-better: a flush aborts its whole
        // transaction and rejects every item in the batch, and `Promise.all`
        // rejects on the first of those — where sequential awaits would stop
        // at the first failure having already durably landed the rows before
        // it. Batched, those rows roll back with the transaction.
        const appends: Promise<unknown>[] = [
            log.append(TRANSCRIPT_REVISION_BEGIN_KIND, envelope.begin as unknown as JsonValue),
        ];
        for (const chunk of envelope.chunks) {
            appends.push(log.append(TRANSCRIPT_REVISION_CHUNK_KIND, chunk as unknown as JsonValue));
        }
        appends.push(log.append(TRANSCRIPT_REVISION_COMMIT_KIND, envelope.commit as unknown as JsonValue));
        await Promise.all(appends);

        try {
            const expected = decodeOwnEnvelope(node.writerId, envelope);
            if (expected.status !== 'complete') {
                // The envelope this process just built failed to round-trip
                // through the SAME codec that will decode it off the wire —
                // an encoder/codec bug, not a transport one. Surface it and
                // skip the parity call entirely rather than compare against
                // nothing.
                LOG.warn(
                    'Seqscribe',
                    `transcript self-decode failed session=${redactSessionId(sessionId)} status=${expected.status}`,
                );
                return;
            }
            // Sampled — see TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS.
            if (!shouldReadBack(sessionId)) return;
            // `expectedRows` lets the reader try a narrow window holding just
            // this revision (begin + chunks + commit) before the full ring
            // window — see the narrow-first note in transcript-parity-actual.ts.
            const actual = readLocalTranscriptParityActual(node, sessionId, node.writerId, {
                expectedRows: envelope.chunks.length + 2,
            });
            compareTranscriptRevision(`${ownerDaemonId}:${sessionId}`, expected.snapshot, actual);
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `transcript parity self-check failed session=${redactSessionId(sessionId)}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    };
}
