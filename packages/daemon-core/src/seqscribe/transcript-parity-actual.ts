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
): TranscriptParityActual {
    const topic = sessionTranscriptTopic(rawSessionId);

    let entries: readonly TranscriptRevisionRow[];
    try {
        // ★ NO `headOrder` PIN HERE — deliberately, and unlike `mesh-parity.ts`.
        //
        // `headOrder` is `store.maxOrderUpTo()`, a query over the durable
        // `sq_log` table. `session.*.transcript` is a RING topic (`ring(500)`,
        // topics.ts), and seqscribe's `persist()` writes NO `sq_log` row for a
        // ring topic — its live entries are the in-memory tail and nothing else
        // (`log.ts` `persist`, "ring/none: no durable log row"). So `headOrder`
        // on this topic returns `null` unconditionally, and pinning to it made
        // this reader return `{status:'missing'}` on EVERY call — a parity
        // comparison that could never once succeed. `mesh-parity.ts` keeps its
        // pin correctly: `mesh.*.events` is `retention: full`.
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
        const writerVec = node.node.vectors()[topic]?.writers[expectedWriterId];
        const contig = writerVec && 'contig' in writerVec ? writerVec.contig : 0;
        const fromSeq = Math.max(1, contig - TRANSCRIPT_PARITY_SCAN_ROWS + 1);
        const result = node.node.scanEntries(topic, {
            writer: expectedWriterId,
            fromSeq,
            limit: TRANSCRIPT_PARITY_SCAN_ROWS,
        });
        entries = result.entries as unknown as readonly TranscriptRevisionRow[];
    } catch {
        return { status: 'missing' };
    }

    const assembler = new TranscriptRevisionAssembler(expectedWriterId);
    for (const entry of entries) {
        // Unrecognized kinds are harmlessly rejected by the assembler's own
        // default case without touching in-flight state — no pre-filter needed.
        assembler.ingestRow(entry);
    }

    const latest = assembler.getLatestComplete();
    if (!latest) return { status: 'missing' };
    return { status: 'found', snapshot: latest.snapshot };
}
