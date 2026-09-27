/**
 * Tail-SNAP selector for `session.<id>.transcript` topics.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 * The vendor's built-in `tail` view SNAPs the last `FULL_TAIL_DEFAULT` (500)
 * rows of a full-retention topic. A transcript revision is `begin + N chunks
 * + commit` with chunks up to 36 KiB (transcript-revision-codec.ts), so that
 * window is up to ~18 MB of JCS — re-read from SQLite, serialized and base64'd
 * for every fresh or resyncing subscriber. Incident 2026-09-27: a
 * backpressured subscriber turned that into one full-tail SNAP per applied
 * write (fixed in the vendor's SubHub — resync is now coalesced), but even one
 * coalesced SNAP of 500 × 36 KiB blocks the event loop for no reader benefit.
 *
 * ── What readers actually need ─────────────────────────────────────────────
 * Every reader of this topic keeps ONE complete revision, and each revision is
 * a complete snapshot on its own:
 *   - `TranscriptReplicaStore` feeds SNAP rows into a single
 *     `TranscriptRevisionAssembler` and keeps its latest `complete`;
 *   - web-core's `subscribeSessionTranscript` collapses a SNAP to the newest
 *     verifiable revision (design §3.7's single atomic swap).
 * So the SNAP only needs the newest structurally complete revision
 * (`begin … commit`) plus whatever follows it (the in-flight next revision).
 * This selector returns exactly that SUFFIX of the default window — rows are
 * contiguous in rowid order, so nothing inside the kept range is dropped and
 * a reader sees the same rows the default SNAP would have ended with.
 *
 * ── Fail-open ──────────────────────────────────────────────────────────────
 * When no structurally complete revision is found within the default window
 * (a revision larger than the window, a torn envelope, a foreign-writer mix)
 * the selector returns null and the vendor serves the default window — the
 * pre-selector behavior. "Structurally complete" = a commit, its begin (same
 * writer / producerEpoch / revision / chunk count), and every chunk index in
 * between; hash/UTF-8 verification stays the assembler's job.
 *
 * One reader-visible difference, deliberately accepted: web-core's
 * `omittedBefore` flag (`ringCoversWriterStart`) is raised when a reset SNAP
 * does not contain the owner's seq 1, so it now reads true on a fresh
 * subscription to a session with more than one revision. It only drives the
 * `data-transcript-omitted-before` DOM attribute (the banner was retired —
 * transcript-chat-pane-adapter.ts), and it is accurate in the sense that
 * matters: older revisions were not delivered, and none were needed.
 */

import type { JsonValue, LogEntry, SeqscribeNodeExt, TailSource } from 'seqscribe';
import {
    MAX_TRANSCRIPT_REVISION_ROWS,
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
} from './transcript-revision-codec.js';

/** Backward page size — a revision's begin is usually within one or two pages. */
const PAGE_ROWS = 64;

/** `session.<safeSessionId>.transcript` (topics.ts#sessionTranscriptTopic). */
export function isSessionTranscriptTopic(topic: string): boolean {
    return topic.startsWith('session.') && topic.endsWith('.transcript') && topic.length > 'session..transcript'.length;
}

interface RevisionKey {
    writer: string;
    producerEpoch: string;
    revision: number;
    chunks: number;
}

function field(payload: JsonValue, name: string): unknown {
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)[name]
        : undefined;
}

function revisionKeyOf(entry: LogEntry): RevisionKey | null {
    const producerEpoch = field(entry.payload, 'producerEpoch');
    const revision = field(entry.payload, 'revision');
    const chunks = field(entry.payload, 'chunks');
    if (typeof producerEpoch !== 'string' || typeof revision !== 'number' || typeof chunks !== 'number') return null;
    return { writer: entry.writer, producerEpoch, revision, chunks };
}

function sameRevision(a: RevisionKey, b: RevisionKey): boolean {
    return (
        a.writer === b.writer &&
        a.producerEpoch === b.producerEpoch &&
        a.revision === b.revision &&
        a.chunks === b.chunks
    );
}

/**
 * The rows a transcript tail SNAP carries: the suffix of the tail window that
 * starts at the newest structurally complete revision's `begin`. Null → the
 * vendor's default window (see the fail-open note above).
 */
export function selectTranscriptTailSnapshot(src: TailSource): LogEntry[] | null {
    const newestFirst: LogEntry[] = [];
    let target: RevisionKey | null = null;
    let seenChunks = new Set<number>();
    let before: number | null = null;
    // A complete revision plus an in-flight one fit in 2 × MAX rows; never
    // walk further than the window the default SNAP would have served.
    const limit = Math.min(src.defaultLimit, 2 * MAX_TRANSCRIPT_REVISION_ROWS + 20);

    while (newestFirst.length < limit) {
        const page = src.page(before, Math.min(PAGE_ROWS, limit - newestFirst.length));
        if (page.length === 0) return null;
        for (const { entry, rowid } of page) {
            before = rowid;
            newestFirst.push(entry);
            if (target === null) {
                // The newest commit is the candidate; rows after it are the
                // in-flight next revision and ride along untouched.
                if (entry.kind === TRANSCRIPT_REVISION_COMMIT_KIND) {
                    target = revisionKeyOf(entry);
                    seenChunks = new Set();
                }
                continue;
            }
            const key = revisionKeyOf(entry);
            if (entry.kind === TRANSCRIPT_REVISION_CHUNK_KIND) {
                const index = field(entry.payload, 'index');
                if (key && sameRevision(key, target) && typeof index === 'number') seenChunks.add(index);
                continue;
            }
            if (entry.kind === TRANSCRIPT_REVISION_BEGIN_KIND && key && sameRevision(key, target)) {
                if (seenChunks.size === target.chunks) return newestFirst.reverse();
                target = null; // torn revision — fall back to the next older commit
                continue;
            }
            if (entry.kind === TRANSCRIPT_REVISION_COMMIT_KIND) {
                // Another commit before the candidate's begin: the candidate's
                // envelope is broken (begin missing). Restart from this one.
                target = revisionKeyOf(entry);
                seenChunks = new Set();
            }
        }
    }
    return null;
}

/**
 * Install the transcript selector on the daemon's node. Non-transcript tail
 * topics (`fleet.status`, …) keep the default window.
 */
export function installTranscriptTailSnapshotSelector(node: Pick<SeqscribeNodeExt, 'setTailSnapshotSelector'>): void {
    node.setTailSnapshotSelector((src) =>
        isSessionTranscriptTopic(src.topic) ? selectTranscriptTailSnapshot(src) : null,
    );
}
