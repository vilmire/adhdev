/**
 * Producer-side parity `actual` reader — design §3.3/§5.3, §8 unit 3.
 *
 * Closes one of the three deferrals this unit inherits from §8 unit 2
 * (transcript-parity.ts's header): "Wiring `actual` to a LIVE subscriber
 * replica is §8 unit 3". A live cross-daemon subscriber replica
 * (transcript-replica-store.ts) exists now, but design §3.3 is explicit that
 * PARITY specifically must NOT read through it:
 *
 *   "live consumer는 built-in tail SUB/SNAP/DELTA를 사용하고 scanEntries로
 *   polling하지 않는다. parity/incident audit만 headOrder(topic)로 비교
 *   상한을 pin한 뒤, current owner writer의 pinned seq까지 writer-form
 *   scanEntries({writer, fromSeq, toSeq, limit})를 사용한다."
 *
 * So this module is a SEPARATE, audit-only read path: it scans the topic's
 * OWN node (the producer reading back what it just wrote). It shares zero code
 * with `TranscriptReplicaStore` — that class exists for live display, this one
 * exists for self-verification.
 *
 * ★ The `headOrder` pin in the quote above does NOT apply to this topic, and
 * following it literally was a defect: `session.*.transcript` is a ring topic,
 * whose entries never reach the `sq_log` table `headOrder` queries, so the pin
 * evaluated to `null` and this reader reported `missing` on every single call.
 * The SAME design paragraph also requires the ring-tail-merging writer form,
 * which is the half that is correct for a ring — see the long note at the
 * `scanEntries` call below for the full reasoning and the second, independent
 * reason the pin was unusable here.
 *
 * `LogEntry` (seqscribe's scan result row shape: `{writer, seq, kind,
 * payload}`, payload already-parsed JSON) is structurally compatible with
 * `TranscriptRevisionRow` — no adapter needed, unlike SUB's `Row` (payload is
 * a JSON STRING there; see transcript-replica-store.ts).
 */

import type { SeqscribeNodeHandle } from './node.js';
import { SESSION_TRANSCRIPT_RING, sessionTranscriptTopic } from './topics.js';

/**
 * Seq-window width for the parity scan — exactly the transcript ring size, so
 * the window can cover every row the ring is still able to hold and never
 * fewer. Derived from `SESSION_TRANSCRIPT_RING` rather than restated, so
 * resizing the ring cannot silently leave this scan reading a short window.
 *
 * Also within seqscribe's `SCAN_MAX_LIMIT` (10,000), which would otherwise clamp
 * silently.
 */
const TRANSCRIPT_PARITY_SCAN_ROWS = SESSION_TRANSCRIPT_RING;

/**
 * Extra rows the narrow first-pass window reads beyond the caller's
 * `expectedRows` hint — room for rows a concurrent in-flight append may have
 * landed after the revision being verified (see the narrow-first note in
 * `readLocalTranscriptParityActual`). Exported for tests.
 */
export const TRANSCRIPT_PARITY_NARROW_SLACK_ROWS = 8;

export interface TranscriptParityReadOptions {
    /**
     * Rows the caller just appended for the revision it wants verified
     * (`chunks.length + 2`: begin + chunks + commit). When present, a narrow
     * head-anchored window is tried first; absent, only the full window runs.
     */
    expectedRows?: number;
}
import type { TranscriptParityActual } from './transcript-parity.js';
import { TranscriptRevisionAssembler, type TranscriptRevisionRow } from './transcript-revision-codec.js';

/**
 * Read the latest verified-complete transcript revision `expectedWriterId`
 * has written to its OWN node for `rawSessionId`, or `{status:'missing'}` if
 * none is found (scan failure, or no complete revision assembled from what was
 * scanned).
 *
 * Never throws — parity is diagnostics (matches `compareTranscriptRevision`'s
 * own never-throws contract).
 */
export function readLocalTranscriptParityActual(
    node: SeqscribeNodeHandle,
    rawSessionId: string,
    expectedWriterId: string,
    options: TranscriptParityReadOptions = {},
): TranscriptParityActual {
    const topic = sessionTranscriptTopic(rawSessionId);

    let contig: number;
    try {
        // ★ NO `headOrder` PIN HERE.
        //
        // `headOrder` is `store.maxOrderUpTo()`, a query over the durable
        // `sq_log` table. G2b (2026-09-24) switched `session.*.transcript`
        // from `ring(500)` to `full` retention (`topics.ts`), so this topic
        // now DOES write durable `sq_log` rows and `headOrder` would no
        // longer return `null` unconditionally the way it did under `ring`.
        // This reader still does not pin to it, for the second, independent
        // reason below (a topic-wide head is not necessarily this writer's
        // own seq) — that reasoning was always true and does not depend on
        // retention mode. Revisiting a `headOrder` pin here is future work,
        // not required by the retention switch: the writer-form scan below
        // is correct as-is under `full` retention too (`core.ringTail` is
        // simply an empty no-op merge for a non-ring topic; the durable
        // `entriesRange`/`archivedEntries` sources now actually hold rows
        // instead of being unconditionally empty).
        //
        // A second, independent reason not to reuse that pin: `headOrder`
        // returns the TOPIC-WIDE max `Order`, whose `.seq` belongs to whichever
        // writer sorts last in the HLC ordering — not necessarily
        // `expectedWriterId`. Feeding another writer's seq in as this writer's
        // `toSeq` bound is meaningless even on a topic that does persist rows.
        //
        // Omitting `toSeq` makes the writer form default it to this writer's own
        // `core.getStream(topic, writer).contigSeq` (`node.ts` scanEntries), and
        // that form already merges `core.ringTail(topic)` as a third source
        // alongside the two durable ones (node.ts, "P25"). That is precisely the
        // merge design §3.3 calls for on a ring ("ring은 durable row가 없으므로
        // ... in-memory ring tail을 merge하도록 규정된 writer form이 필요하다").
        //
        // Losing the pin costs nothing here: the assembler only ever emits a
        // revision whose `commit` row it has already seen, so a concurrently
        // appended in-flight `begin`/`chunk` suffix is held as unfinished state
        // and never surfaces. Reading one revision NEWER than the instant of
        // entry is also not a parity error — `compareTranscriptRevision` matches
        // on revision identity, not on a wall-clock instant.
        //
        // ★ `fromSeq` MUST be anchored to the head, not left to default to 1.
        //
        // The writer form bounds its page as a SEQ WINDOW — `[fromSeq, fromSeq +
        // limit - 1]` (node.ts) — NOT as "the last `limit` rows". With the
        // default `fromSeq: 1` and the default limit of 500, the window is seqs
        // 1..500 forever, while the ring holds the NEWEST 500 seqs. Once a
        // session publishes past seq 500 those two ranges start sliding apart,
        // and the scan returns only their shrinking intersection — i.e. the
        // OLDEST surviving rows. Parity would then compare a stale revision
        // against the freshly published one and report mismatch: the same
        // always-fails outcome as the `headOrder` bug, just arriving later in a
        // session's life. (The suite's ring-overflow test pins this: 187
        // revisions published, and the unanchored form returns revision 166.)
        //
        // Anchoring `fromSeq` to `contig - MAX + 1` makes the window track the
        // head, so the scan always covers the newest rows the ring holds.
        // `Math.max(1, …)` keeps a young session (head below the window size)
        // reading from the true start.
        //
        // `vectors()` is the public way to read this writer's `contig` head —
        // the library exposes no `streamHead`, and `headOrder` is the sq_log
        // query that does not apply here. A writer with no entries yet (or a
        // retired one, which carries `finalSeq` rather than `contig`) simply
        // yields head 0 → `fromSeq: 1`, and the scan comes back empty.
        //
        // ★ Narrow-first (CPU fix, 2026-09-25). The full window is ~125
        // revisions (~10 MB of chunk payload at live sizes), and every row in
        // it is JSON-parsed and re-hashed (`sha256HexUtf8` via the assembler)
        // just to surface the ONE newest complete revision. Measured on a
        // preview daemon that was ~20% of a core at the 350 ms publish
        // ceiling. When the caller knows how many rows it just appended
        // (`expectedRows` = chunks + begin + commit), the newest revision
        // sits in the last `expectedRows` seqs below `contig`, so a window of
        // `expectedRows + TRANSCRIPT_PARITY_NARROW_SLACK_ROWS` anchored the
        // same way (`contig - width + 1`, clamped to 1 — the SAME head-anchor
        // rule as above, just a smaller width) is enough. The slack absorbs
        // rows a concurrent in-flight append may have landed after ours; if
        // those rows push our commit out of the narrow window (or the window
        // otherwise yields no complete revision), the full 500-row window
        // below runs exactly as before — the fallback preserves today's
        // semantics, so the narrow pass can only ever save work, never change
        // an answer from `found` to `missing`.
        const writerVec = node.node.vectors()[topic]?.writers[expectedWriterId];
        contig = writerVec && 'contig' in writerVec ? writerVec.contig : 0;
    } catch {
        return { status: 'missing' };
    }

    const expectedRows = options.expectedRows;
    if (typeof expectedRows === 'number' && Number.isFinite(expectedRows) && expectedRows > 0) {
        const width = Math.floor(expectedRows) + TRANSCRIPT_PARITY_NARROW_SLACK_ROWS;
        if (width < TRANSCRIPT_PARITY_SCAN_ROWS) {
            const narrow = scanLatestComplete(node, topic, expectedWriterId, contig, width);
            if (narrow === 'failed') return { status: 'missing' };
            if (narrow) return { status: 'found', snapshot: narrow.snapshot };
        }
    }

    const full = scanLatestComplete(node, topic, expectedWriterId, contig, TRANSCRIPT_PARITY_SCAN_ROWS);
    if (!full || full === 'failed') return { status: 'missing' };
    return { status: 'found', snapshot: full.snapshot };
}

/**
 * Scan the head-anchored seq window `[max(1, contig - width + 1), contig]`
 * and return the newest complete revision the assembler can build from it,
 * `null` if none, or `'failed'` if the scan itself threw.
 */
function scanLatestComplete(
    node: SeqscribeNodeHandle,
    topic: string,
    expectedWriterId: string,
    contig: number,
    width: number,
): ReturnType<TranscriptRevisionAssembler['getLatestComplete']> | 'failed' {
    let entries: readonly TranscriptRevisionRow[];
    try {
        const fromSeq = Math.max(1, contig - width + 1);
        const result = node.node.scanEntries(topic, {
            writer: expectedWriterId,
            fromSeq,
            limit: width,
        });
        entries = result.entries as unknown as readonly TranscriptRevisionRow[];
    } catch {
        return 'failed';
    }

    const assembler = new TranscriptRevisionAssembler(expectedWriterId);
    for (const entry of entries) {
        // Unrecognized kinds are harmlessly rejected by the assembler's own
        // default case without touching in-flight state — no pre-filter needed.
        assembler.ingestRow(entry);
    }
    return assembler.getLatestComplete();
}
