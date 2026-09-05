/**
 * Worker-side live transcript feed for ONE session — the piece unit 4's
 * foundation deliberately left open ("topic activation / re-attach on reset is
 * consumer-cutover territory", `transcript-worker-entry.ts`) and that unit 5's
 * landed `transcript-chat-pane-adapter.ts` has been waiting on with zero
 * production callers.
 *
 * This joins three already-built halves:
 *
 *   topic-addressing.ts        → WHICH topic (byte-identical to the daemon's)
 *   TranscriptWorkerNode       → attach/subscribe mechanics
 *   TranscriptRevisionAssembler → begin/chunk/commit → verified snapshot
 *
 * ── Why the assembler is imported from daemon-core rather than copied ───────
 * `transcript-revision-codec.ts` was made Node-`Buffer`-free specifically so
 * this module could reuse it in a browser Worker (see that file's "Portable on
 * purpose" header). Reusing it is what makes the browser's verification —
 * chunk indexing, byte counts, SHA-256, owner/writer gating — the SAME code the
 * daemon and mcp-server run, rather than a second implementation that could
 * drift into accepting a revision the daemon would reject. It is reached
 * through daemon-core's `./seqscribe/transcript-revision-codec` SUBPATH export,
 * never the root barrel: a barrel value-import would drag the logger's fs/path
 * into the browser bundle and kill it.
 *
 * ── SNAP reset is a display signal, not a data loss ─────────────────────────
 * seqscribe's built-in ring `tail` view re-SNAPs whenever a DELTA outruns the
 * frame budget or the send queue drops (`vendor/seqscribe/src/subs.ts`). Design
 * §3.7 requires that a reset NOT blank the pane: the last verified complete
 * revision keeps displaying until a new one verifies, and the discontinuity
 * surfaces as `omittedBefore` — ChatPane's "이전 내용 생략" banner. So a reset
 * here only sets a flag; it never clears `latest`.
 *
 * A SNAP also carries the whole ring tail oldest-first, so it must resolve to a
 * SINGLE atomic swap to the newest verifiable revision — see the long note in
 * `ingest` below for why replaying each one is a user-visible regression.
 */
import { TranscriptRevisionAssembler, type TranscriptRevisionRow } from '@adhdev/daemon-core/seqscribe/transcript-revision-codec';
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core/seqscribe/transcript-projection';
import type { PeerHandle, Row, Subscription } from 'seqscribe';
import { sessionTranscriptPolicy, sessionTranscriptTopic } from './topic-addressing.js';
import type { TranscriptWorkerNode } from './transcript-worker-node.js';

/** What the consumer needs alongside the snapshot to render it correctly. */
export interface TranscriptSessionUpdate {
    readonly snapshot: ReplicatedTranscriptSnapshotV1;
    /**
     * A SNAP reset has occurred since the previous delivered revision, so rows
     * before this one may never have been seen — design §3.7's "이전 내용 생략".
     * Sticky until the next clean (non-reset) revision, because the gap does not
     * heal just because a later revision happens to arrive without a reset flag.
     */
    readonly omittedBefore: boolean;
}

export interface TranscriptSessionSubscriptionOptions {
    /** Raw session id. Sanitized into the topic name here — callers pass raw. */
    readonly sessionId: string;
    /** The attached daemon peer this session's transcript is served by. */
    readonly peer: PeerHandle;
    /**
     * The daemon's seqscribe writer id. Gates EVERY row (design §3.3) so a
     * second writer on the topic cannot land a revision. Optional only because
     * the browser may not know it before the first `begin` — when omitted the
     * codec's own identity checks still apply.
     */
    readonly ownerWriterId?: string;
    /**
     * Fires for each verified-complete revision, in arrival order — with one
     * deliberate collapse: a SNAP reset delivers the whole ring tail at once,
     * and fires ONCE with the newest verifiable revision in it (design §3.7's
     * atomic swap), not once per historical revision the ring still holds.
     */
    onSnapshot(update: TranscriptSessionUpdate): void;
    /**
     * A row was rejected. Reason is the codec's closed union — surfaced so the
     * consumer can fall back with a real reason instead of silently showing a
     * stale pane.
     */
    onRejected?(reason: string): void;
}

export interface TranscriptSessionSubscriptionHandle {
    /** The topic this subscription is bound to — for diagnostics/tests. */
    readonly topic: string;
    /** Last verified complete revision, or null before the first one lands. */
    latest(): TranscriptSessionUpdate | null;
    /** Idempotent. */
    close(): void;
}

/**
 * `Row.payload` arrives as a JSON STRING (`subs.ts#ringRow` stringifies
 * `LogEntry.payload`), so it must be parsed before the assembler — which types
 * `payload` as the decoded object — ever sees it.
 *
 * A row whose payload is not parseable JSON is dropped rather than handed on:
 * the assembler's rejection vocabulary describes malformed TRANSCRIPT
 * envelopes, and a non-JSON ring row is a transport-level corruption that
 * predates that vocabulary.
 */
function toRevisionRow(row: Row): TranscriptRevisionRow | null {
    const { writer, seq, kind, payload } = row;
    if (typeof writer !== 'string' || typeof seq !== 'number' || typeof kind !== 'string') return null;
    if (typeof payload !== 'string') return null;
    try {
        return { writer, seq, kind, payload: JSON.parse(payload) as unknown };
    } catch {
        return null;
    }
}

/**
 * Define the session's transcript topic, subscribe to its ring tail through the
 * already-attached daemon peer, and reassemble verified snapshots.
 *
 * The topic is defined on THIS node with the same policy the daemon uses
 * (`sessionTranscriptPolicy`) because `topicSchemaHash` covers the policy —
 * a divergent one is rejected peer-side as `ERR_SCHEMA_MISMATCH`, not silently
 * tolerated. `TranscriptWorkerNode`'s ring-only interlock independently refuses
 * anything non-ring here.
 */
export function subscribeSessionTranscript(
    node: TranscriptWorkerNode,
    options: TranscriptSessionSubscriptionOptions,
): TranscriptSessionSubscriptionHandle {
    const topic = sessionTranscriptTopic(options.sessionId);
    // Idempotent by design: re-defining an identical topic/policy is a no-op in
    // seqscribe, so a second session activation for the same topic is safe.
    node.node.defineTopic(topic, sessionTranscriptPolicy());

    const assembler = new TranscriptRevisionAssembler(options.ownerWriterId);
    let latest: TranscriptSessionUpdate | null = null;
    let pendingOmittedBefore = false;
    let closed = false;

    const ingest = (rows: readonly Row[], reset: boolean): void => {
        if (closed) return;
        // Sticky: a reset marks the NEXT delivered revision as discontinuous.
        // Cleared only when that revision is actually delivered below, so a
        // reset followed by rows that never complete keeps the flag armed.
        if (reset) pendingOmittedBefore = true;

        // ── Why a reset collapses to ONE emission ──────────────────────────
        // A SNAP hands over the WHOLE ring tail, oldest-first. Since one
        // transcript revision is only `begin + N chunks + commit` rows, a
        // 500-slot ring holds well over a hundred PAST revisions. Emitting
        // each one as it reassembles replays the session's history forward
        // through the pane — the user watches a correct view snap back to an
        // old message. Nothing downstream catches it: the assembler's
        // `complete` is overwritten unconditionally, `handleUpdate` never
        // reads `seq`, and the pane's shrink guard only fires when the new
        // message list is SHORTER — oldest-first replay grows monotonically,
        // so it is structurally blind to this direction.
        //
        // Design §3.7 already specifies the correct behaviour: "SNAP은 tail
        // rows 전체에서 가장 새로운 검증 가능한 complete revision을 찾는다"
        // and swaps ONCE, atomically. So on a reset we reassemble every row
        // but publish only the highest-revision complete snapshot.
        //
        // DELTA (`reset === false`) is untouched: those rows are sequential
        // steady-state upserts and each one is a genuine new revision.
        let best: ReplicatedTranscriptSnapshotV1 | null = null;

        for (const row of rows) {
            const revisionRow = toRevisionRow(row);
            if (!revisionRow) continue;
            const result = assembler.ingestRow(revisionRow);
            if (result.status === 'rejected') {
                options.onRejected?.(result.reason);
                continue;
            }
            if (result.status !== 'complete') continue;
            if (reset) {
                // Keep the newest. `>=` (not `>`) so that when a publisher
                // restart legitimately resets the counter, the later-arriving
                // rows — which are the newer ones in ring order — still win.
                if (!best || result.snapshot.revision >= best.revision) best = result.snapshot;
                continue;
            }
            const update: TranscriptSessionUpdate = {
                snapshot: result.snapshot,
                omittedBefore: pendingOmittedBefore,
            };
            pendingOmittedBefore = false;
            latest = update;
            options.onSnapshot(update);
        }

        if (!best) return;
        // `omittedBefore` rides on THIS emission — the one the consumer
        // actually renders. Attaching it to the first replayed revision (as
        // the per-row path did) meant the "이전 내용 생략" banner was consumed
        // by a revision that a later one immediately replaced, so the gap the
        // user needed to see disappeared before they could see it.
        const update: TranscriptSessionUpdate = { snapshot: best, omittedBefore: pendingOmittedBefore };
        pendingOmittedBefore = false;
        latest = update;
        options.onSnapshot(update);
    };

    const subscription: Subscription = node.subscribe(options.peer, { view: 'tail', params: { topic } });
    subscription.onSnapshot((rows, reset) => ingest(rows, reset));
    // DELTA upserts are the steady-state path once a SNAP has landed; without
    // this the pane would only ever update on a reset.
    subscription.onDelta(({ upserts }) => ingest(upserts, false));

    return {
        topic,
        latest: () => latest,
        close(): void {
            if (closed) return;
            closed = true;
            node.unsubscribe(subscription);
        },
    };
}
