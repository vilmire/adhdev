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
 * OWN node (the producer reading back what it just wrote), pinned to
 * `headOrder` so a concurrent in-flight append cannot make the scan observe a
 * moving target. It shares zero code with `TranscriptReplicaStore` — that
 * class exists for live display, this one exists for self-verification.
 *
 * `LogEntry` (seqscribe's scan result row shape: `{writer, seq, kind,
 * payload}`, payload already-parsed JSON) is structurally compatible with
 * `TranscriptRevisionRow` — no adapter needed, unlike SUB's `Row` (payload is
 * a JSON STRING there; see transcript-replica-store.ts).
 */

import type { SeqscribeNodeHandle } from './node.js';
import { sessionTranscriptTopic } from './topics.js';
import type { TranscriptParityActual } from './transcript-parity.js';
import { TranscriptRevisionAssembler, type TranscriptRevisionRow } from './transcript-revision-codec.js';

/**
 * Read the latest verified-complete transcript revision `expectedWriterId`
 * has written to its OWN node for `rawSessionId`, or `{status:'missing'}` if
 * none is found (no head, scan failure, or no complete revision assembled
 * from what was scanned).
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

    let head: { seq: number } | null;
    try {
        head = node.node.headOrder(topic);
    } catch {
        return { status: 'missing' };
    }
    if (!head) return { status: 'missing' };

    let entries: readonly TranscriptRevisionRow[];
    try {
        // No `limit`: the ring's own retention (500 rows, design §3.3) is the
        // real bound. Pinning `toSeq` to the head we just read keeps this scan
        // from observing rows appended concurrently after the pin.
        const result = node.node.scanEntries(topic, { writer: expectedWriterId, toSeq: head.seq });
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
