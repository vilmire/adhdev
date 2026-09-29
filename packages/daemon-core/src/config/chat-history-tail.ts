/**
 * Reading a window of saved history: stable message identity + paging over the
 * collapsed record list, and the bounded-tail fast path that serves a finite
 * "latest N" request from the newest files by reverse-seeking (with an
 * append-only incremental cache for a hot session's growing daily file) instead
 * of parsing the whole conversation.
 */
import { sanitizeHistoryMessage, dedupeAdjacentHistoryMessages, collapseReplayAssistantTurns, buildHistoryMessageHash, type HistoryMessage } from './chat-history-messages.js';
import type { ProviderHistoryBehavior } from '../providers/contracts.js';
import { isActivityChatMessage } from '../providers/chat-message-normalization.js';
import * as fs from 'fs';
import * as path from 'path';

// Bounded-tail read cache. The dashboard re-subscribes and polls hot sessions
// every ~2.5s; without a cache each poll re-reads/parses/sorts the whole
// conversation just to slice a small tail. We key on (type, sessionId,
// pagination args) plus the on-disk size+mtime signature so an UNCHANGED
// session returns the previously computed tail in O(1) and only re-reads when a
// new message is appended (signature changes). The map is bounded by a small
// LRU to keep memory flat regardless of how many sessions are touched.
interface BoundedTailCacheEntry {
    signature: string;
    result: { messages: HistoryMessage[]; hasMore: boolean };
}

const BOUNDED_TAIL_CACHE_MAX_ENTRIES = 64;
const boundedTailReadCache = new Map<string, BoundedTailCacheEntry>();

export function readBoundedTailCache(key: string, signature: string): { messages: HistoryMessage[]; hasMore: boolean } | null {
    const cached = boundedTailReadCache.get(key);
    if (!cached || cached.signature !== signature) return null;
    // Refresh LRU recency.
    boundedTailReadCache.delete(key);
    boundedTailReadCache.set(key, cached);
    return cached.result;
}

export function writeBoundedTailCache(key: string, signature: string, result: { messages: HistoryMessage[]; hasMore: boolean }): void {
    boundedTailReadCache.delete(key);
    boundedTailReadCache.set(key, { signature, result });
    while (boundedTailReadCache.size > BOUNDED_TAIL_CACHE_MAX_ENTRIES) {
        const oldest = boundedTailReadCache.keys().next().value;
        if (oldest === undefined) break;
        boundedTailReadCache.delete(oldest);
    }
}

/**
 * Read history (static — called from P2P commands)
 * 
 * Read JSONL files for a session and return a chronological page while paging
 * backwards from the newest saved messages. When excludeRecentCount is set,
 * the newest N messages are skipped so older-history pagination can avoid
 * duplicating the live transcript tail already shown in the UI.
 */
function normalizePaginationNumber(value: number, fallback: number, min: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(min, numeric) : fallback;
}

/**
 * Total order for paging.
 *
 * Sorting on `receivedAt` alone is NOT a total order: a Claude JSONL line fans
 * out to several records that all inherit that line's single timestamp, and the
 * ADHDev mirror stamps whole bursts with one `receivedAt`. `Array.prototype.sort`
 * is stable, so ties previously resolved to *file read order* — which means the
 * page boundary, and therefore which messages a page contains, could differ
 * between two reads of identical data. That is a silent-hole source independent
 * of the collapse arithmetic.
 *
 * `sequence` (monotonic per session/source, A2.3) breaks the tie when both sides
 * carry it. When either lacks it we return 0 and let the stable sort preserve
 * the incoming relative order — the previous behavior, no worse.
 */
function compareHistoryMessagesForPaging(a: HistoryMessage, b: HistoryMessage): number {
    const byTime = a.receivedAt - b.receivedAt;
    if (byTime !== 0) return byTime;
    const aSeq = (a as HistoryMessage & { sequence?: number }).sequence;
    const bSeq = (b as HistoryMessage & { sequence?: number }).sequence;
    if (typeof aSeq === 'number' && typeof bSeq === 'number' && aSeq !== bSeq) {
        return aSeq - bSeq;
    }
    return 0;
}

/**
 * (SEAM) Identity of the oldest message currently rendered in the live window.
 *
 * ── Why a cursor and not a count ───────────────────────────────────────────
 * `excludeRecentCount` is COUNTED IN THE CALLER'S BUBBLE SPACE but subtracted
 * from `collapsed.length`, which is a DIFFERENT space: three stages shrink the
 * record set before the slice — `sanitizeHistoryMessage` drops empty content,
 * `dedupeAdjacentHistoryMessages` merges same-signature neighbours (its
 * signature omits `receivedAt`, so two identical texts collapse), and
 * `collapseReplayAssistantTurns` drops consecutive prose assistant turns when
 * the provider enables it. When N bubbles map to M < N records, subtracting N
 * from M overshoots and the (N - M) messages between the two windows become
 * permanently unreachable — rendered as a silent hole, never as an error.
 *
 * Resolving the boundary by IDENTITY removes the arithmetic entirely: we find
 * WHERE that message actually sits in collapsed space and page strictly older
 * than it, regardless of how much the collapse shrank.
 *
 * ── Degradation is explicit, never silent ──────────────────────────────────
 * Returns -1 when the cursor is absent or cannot be located (legacy mirror
 * records that never carried identity, the PTY path which has none, a
 * mixed-version daemon, or a cursor whose message the collapse legitimately
 * dropped). The caller then falls back to the count path — the pre-existing
 * behavior, bug included. That is the correct direction to fail: a cursor that
 * silently resolved to 0 would page from the very start of the conversation.
 */
export function findCollapsedIndexByIdentity(collapsed: HistoryMessage[], cursor: string): number {
    if (!cursor) return -1;
    for (let i = collapsed.length - 1; i >= 0; i -= 1) {
        if (buildHistoryMessageIdentity(collapsed[i]) === cursor) return i;
    }
    return -1;
}

/**
 * The identity a history record advertises to the seam, most authoritative
 * first — deliberately the same preference order (and the same `kind:` prefixes)
 * `getChatMessageStableKey` uses in web-core, so a key minted on either side of
 * the wire resolves against the other.
 *
 * `providerUnitKey`/`bubbleId`/`_turnKey`/`sequence` live on these objects as
 * untyped casts (see `normalizeProviderNativeHistoryRecords`'s A2.3 passthrough)
 * — they are real at runtime but absent from the `HistoryMessage` interface,
 * hence the casts here.
 */
export function buildHistoryMessageIdentity(message: HistoryMessage): string {
    const record = message as HistoryMessage & {
        providerUnitKey?: string;
        bubbleId?: string;
        _turnKey?: string;
        sequence?: number;
    };
    if (record.providerUnitKey) return `unit:${record.providerUnitKey}`;
    if (record.bubbleId) return `bubble:${record.bubbleId}`;
    if (typeof record.sequence === 'number' && Number.isFinite(record.sequence)) {
        return `seq:${record.sequence}`;
    }
    // NOT `_turnKey`: it is turn-grained, so it cannot identify a single record
    // and would resolve the boundary to an arbitrary bubble within the turn.
    return '';
}

export function pageHistoryRecords(
    agentType: string,
    records: HistoryMessage[],
    offset: number = 0,
    limit: number = 30,
    excludeRecentCount: number = 0,
    historyBehavior?: ProviderHistoryBehavior,
    excludeFromIdentity?: string,
    excludeActivity: boolean = false,
): { messages: HistoryMessage[]; hasMore: boolean } {
    // chat_history's prose-only default (mirrors read_chat's `includeActivity`
    // opt-in contract). Applied BEFORE dedup/collapse/paging so offset/limit/
    // identity-cursor arithmetic operates in the same message space the caller
    // will actually receive — filtering the paged slice afterwards would shrink
    // pages inconsistently and break `hasMore`. Default false: summary/count
    // callers keep their historical record space untouched.
    const pageable = excludeActivity
        ? records.filter((message) => !isActivityChatMessage(message as any))
        : records;
    const allMessages = pageable
        .map((message) => sanitizeHistoryMessage(agentType, message))
        .filter(Boolean) as HistoryMessage[];
    allMessages.sort(compareHistoryMessagesForPaging);
    const chronological = dedupeAdjacentHistoryMessages(agentType, allMessages);
    const collapsed = collapseReplayAssistantTurns(chronological, historyBehavior);
    const boundedLimit = normalizePaginationNumber(limit, 30, 1);
    const boundedOffset = normalizePaginationNumber(offset, 0, 0);
    // (SEAM) Prefer the identity cursor. Resolving the live window's oldest
    // message to its ACTUAL position in collapsed space makes the boundary
    // immune to the N-bubbles -> M-records shrink that the count arithmetic
    // below gets wrong. Falls back to the count when the cursor is absent or
    // unresolvable — see findCollapsedIndexByIdentity.
    const cursorIndex = excludeFromIdentity
        ? findCollapsedIndexByIdentity(collapsed, excludeFromIdentity)
        : -1;
    const boundedExclude = cursorIndex >= 0
        ? collapsed.length - cursorIndex
        : Math.min(normalizePaginationNumber(excludeRecentCount, 0, 0), collapsed.length);
    const endExclusive = Math.max(0, collapsed.length - boundedExclude - boundedOffset);
    const startInclusive = Math.max(0, endExclusive - boundedLimit);
    const sliced = collapsed.slice(startInclusive, endExclusive);
    return { messages: sliced, hasMore: startInclusive > 0 };
}

// A finite tail request can be served by reading only the newest files instead
// of the whole conversation. Treat very large limits (e.g. MAX_SAFE_INTEGER, or
// anything past a generous ceiling) as a full-history request so restore/seed
// callers keep their existing behavior.
const BOUNDED_TAIL_MAX_LIMIT = 5_000;
// Slack added to the requested window before sorting/dedup/collapse so the
// boundary message at the top of the tail dedupes/collapses identically to a
// full read. Modest and bounded — it only widens the parse window, not output.
export const BOUNDED_TAIL_SLACK = 50;

export function isBoundedTailRequest(limit: number, offset: number, excludeRecentCount: number): boolean {
    const numericLimit = Number(limit);
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) return false;
    if (numericLimit > BOUNDED_TAIL_MAX_LIMIT) return false;
    const numericOffset = Number(offset);
    const numericExclude = Number(excludeRecentCount);
    if (!Number.isFinite(numericOffset) || !Number.isFinite(numericExclude)) return false;
    return true;
}

// Byte threshold below which a file is small enough that reading the whole
// thing is cheaper than seeking. Reverse-seek pays off only on large files.
const REVERSE_TAIL_SMALL_FILE_BYTES = 64 * 1024;
// Chunk size for backward reads. We read the file tail one chunk at a time
// (newest bytes first) until we have collected enough complete lines.
const REVERSE_TAIL_CHUNK_BYTES = 64 * 1024;

// Per-(file path) incremental tail cache. A hot session's daily JSONL file grows
// append-only while it generates; the size+mtime signature on the bounded-tail
// read cache therefore invalidates on every append and forces a full re-read.
// Here we keep the most recently decoded tail LINES for a file plus the byte
// length we read them from. When the file has only grown (append-only: size
// increased, the previously-read prefix is unchanged) we read just the new bytes
// from `size` onward and splice them onto the retained tail — no full re-parse.
// Truncation/rotation (size shrank, or a fresh inode) drops the entry and falls
// back to a full reverse-seek.
interface IncrementalTailCacheEntry {
    // File length (bytes) we have already consumed into `lines`.
    size: number;
    mtimeMs: number;
    // Decoded complete lines (oldest-first) covering at least the tail window.
    // Bounded to TAIL_LINES_RETAINED so memory stays flat for huge files.
    lines: string[];
    // True when `lines` is the entire file (head reached), so older pages can
    // trust that nothing precedes the retained window.
    coversWholeFile: boolean;
}

// How many trailing lines we retain per file. The bounded-tail caller never
// asks for more than BOUNDED_TAIL_MAX_LIMIT + slack; keep a generous multiple so
// repeated reads at the same window are served incrementally.
const TAIL_LINES_RETAINED = BOUNDED_TAIL_MAX_LIMIT + 2 * BOUNDED_TAIL_SLACK;
const INCREMENTAL_TAIL_CACHE_MAX_ENTRIES = 64;
const incrementalTailCache = new Map<string, IncrementalTailCacheEntry>();

function evictIncrementalTailCache(): void {
    while (incrementalTailCache.size > INCREMENTAL_TAIL_CACHE_MAX_ENTRIES) {
        const oldest = incrementalTailCache.keys().next().value;
        if (oldest === undefined) break;
        incrementalTailCache.delete(oldest);
    }
}

// Split a Buffer into complete lines plus a leftover head fragment, partitioning
// only on the newline byte (0x0A). 0x0A never appears inside a multibyte UTF-8
// sequence, so decoding each complete byte segment is boundary-safe. The leftover
// (bytes before the first newline) is returned undecoded so a caller stitching
// chunks together never splits a multibyte char.
function splitBufferLines(buf: Buffer): { head: Buffer; lines: string[] } {
    const lines: string[] = [];
    let lineEnd = buf.length;
    let firstNewline = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        if (i + 1 < lineEnd) {
            lines.push(buf.toString('utf-8', i + 1, lineEnd));
        }
        lineEnd = i;
        firstNewline = i;
    }
    // Lines were collected newest-first; restore oldest-first for the segment
    // that follows the first (lowest-index) newline.
    lines.reverse();
    const head = firstNewline >= 0 ? buf.subarray(0, firstNewline) : buf;
    return { head, lines };
}

// Read the last bytes of a file, newest-first, until we have at least `needed`
// complete lines (or reach the start of the file). Returns lines oldest-first and
// whether the whole file was consumed. Boundary-safe: lines are cut on the
// newline byte only, so multibyte UTF-8 chars are never split, and a trailing
// partial line (no terminating newline) is preserved as a complete final line.
function readReverseTailLines(filePath: string, needed: number): { lines: string[]; coversWholeFile: boolean; size: number; mtimeMs: number } {
    const fd = fs.openSync(filePath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const size = stat.size;
        let position = size;
        // `carry` holds bytes belonging to a line that straddles the current
        // chunk boundary (its start is in an older, not-yet-read chunk).
        let carry: Buffer = Buffer.alloc(0);
        const collected: string[] = [];

        while (position > 0 && collected.length < needed) {
            const chunkSize = Math.min(REVERSE_TAIL_CHUNK_BYTES, position);
            position -= chunkSize;
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, position);
            const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
            const { head, lines } = splitBufferLines(combined);
            // `head` is the (possibly partial) line whose start lies further back;
            // hold it for the next (older) chunk to complete.
            carry = head;
            // `lines` are oldest-first within this combined buffer; prepend them
            // ahead of what we already collected (which is strictly newer).
            for (let i = lines.length - 1; i >= 0; i--) {
                collected.push(lines[i]);
            }
        }

        const reachedStart = position <= 0;
        if (reachedStart && carry.length) {
            // Leftover head at the start of the file is itself a complete line.
            collected.push(carry.toString('utf-8'));
        }
        // `collected` is newest-first; restore oldest-first.
        collected.reverse();
        return { lines: collected, coversWholeFile: reachedStart, size, mtimeMs: stat.mtimeMs };
    } finally {
        fs.closeSync(fd);
    }
}

// Return the tail lines (oldest-first) for a single history file, reading as
// little of the file as possible. Strategy:
//   - Small files: one readFileSync (seeking is not worth the syscalls).
//   - Large files: reverse byte-seek for the newest `needed` lines.
//   - Append-only growth since the last read: read only the appended bytes and
//     splice them onto the retained tail (no full re-parse) — this is what keeps
//     a hot, still-generating session cheap to poll.
// `needed` is a soft floor; we may return more (whole small files / retained
// window). Lines include any trailing partial (unterminated) final line.
function readFileTailLines(filePath: string, needed: number): { lines: string[]; coversWholeFile: boolean } {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return { lines: [], coversWholeFile: true };
    }
    const size = stat.size;
    const mtimeMs = stat.mtimeMs;
    if (size === 0) {
        incrementalTailCache.delete(filePath);
        return { lines: [], coversWholeFile: true };
    }

    const cached = incrementalTailCache.get(filePath);
    if (cached) {
        if (cached.size === size && cached.mtimeMs === mtimeMs) {
            // Unchanged since last read — reuse retained tail. Refresh LRU.
            incrementalTailCache.delete(filePath);
            incrementalTailCache.set(filePath, cached);
            if (cached.coversWholeFile || cached.lines.length >= needed) {
                return { lines: cached.lines, coversWholeFile: cached.coversWholeFile };
            }
            // Retained window is smaller than this request needs; fall through
            // to a fresh reverse-seek for the larger window.
        } else if (size > cached.size) {
            // Append-only growth: the prefix [0, cached.size) is assumed
            // unchanged (JSONL is append-only). Read just the new bytes and
            // stitch them — but verify the byte at cached.size-1 is still the
            // newline that terminated our last retained line, so a rewrite that
            // happens to grow the file (compaction) is detected and rejected.
            const incremental = tryIncrementalTailGrowth(filePath, cached, size, mtimeMs, needed);
            if (incremental) return { lines: incremental.lines, coversWholeFile: incremental.coversWholeFile };
        }
        // size shrank (truncation/rotation) or incremental failed → drop & reload.
        incrementalTailCache.delete(filePath);
    }

    if (size <= REVERSE_TAIL_SMALL_FILE_BYTES) {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return { lines: [], coversWholeFile: true };
        }
        const lines = content.split('\n');
        // A trailing newline yields a final empty element; drop only that one so
        // an unterminated partial last line is still preserved.
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        storeIncrementalTailCache(filePath, size, mtimeMs, lines, true);
        return { lines, coversWholeFile: true };
    }

    let result: { lines: string[]; coversWholeFile: boolean; size: number; mtimeMs: number };
    try {
        result = readReverseTailLines(filePath, needed);
    } catch {
        return { lines: [], coversWholeFile: true };
    }
    storeIncrementalTailCache(filePath, result.size, result.mtimeMs, result.lines, result.coversWholeFile);
    return { lines: result.lines, coversWholeFile: result.coversWholeFile };
}

// Read appended bytes [cached.size, size) and splice them onto the retained tail.
// Returns null if the prior byte is not a newline (the retained tail did not end
// on a record boundary, e.g. the file was rewritten) so the caller can full-reload.
function tryIncrementalTailGrowth(
    filePath: string,
    cached: IncrementalTailCacheEntry,
    size: number,
    mtimeMs: number,
    needed: number,
): { lines: string[]; coversWholeFile: boolean } | null {
    const fd = fs.openSync(filePath, 'r');
    try {
        // Confirm the byte ending the previously-read prefix is still a newline.
        if (cached.size > 0) {
            const boundary = Buffer.alloc(1);
            fs.readSync(fd, boundary, 0, 1, cached.size - 1);
            if (boundary[0] !== 0x0a) return null;
        }
        const appendedLength = size - cached.size;
        const appended = Buffer.alloc(appendedLength);
        fs.readSync(fd, appended, 0, appendedLength, cached.size);
        const newLines = appended.toString('utf-8').split('\n');
        if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
        const merged = cached.lines.concat(newLines);
        // Keep memory flat: retain only the trailing window.
        const trimmed = merged.length > TAIL_LINES_RETAINED
            ? merged.slice(merged.length - TAIL_LINES_RETAINED)
            : merged;
        const coversWholeFile = cached.coversWholeFile && trimmed.length === merged.length;
        storeIncrementalTailCache(filePath, size, mtimeMs, trimmed, coversWholeFile);
        if (coversWholeFile || trimmed.length >= needed) {
            return { lines: trimmed, coversWholeFile };
        }
        // Should not happen (we only grew), but be safe.
        return { lines: trimmed, coversWholeFile };
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

function storeIncrementalTailCache(filePath: string, size: number, mtimeMs: number, lines: string[], coversWholeFile: boolean): void {
    const retained = lines.length > TAIL_LINES_RETAINED ? lines.slice(lines.length - TAIL_LINES_RETAINED) : lines;
    const covers = coversWholeFile && retained.length === lines.length;
    incrementalTailCache.delete(filePath);
    incrementalTailCache.set(filePath, { size, mtimeMs, lines: retained, coversWholeFile: covers });
    evictIncrementalTailCache();
}

// Read newest-first only as many files as needed to cover the requested window
// plus slack. listHistoryFiles already returns files reversed (newest-first), so
// we accumulate (de-duped) candidates from the end and stop once we have enough,
// then hand the bounded window to pageHistoryRecords in chronological order.
export function readBoundedTailRecords(
    agentType: string,
    dir: string,
    files: string[],
    needed: number,
): { records: HistoryMessage[]; readAllFiles: boolean } {
    const collected: HistoryMessage[] = [];
    const seen = new Set<string>();
    let readAllFiles = true;

    for (let f = 0; f < files.length; f++) {
        const filePath = path.join(dir, files[f]);
        // Read only the file tail needed to top up the window — for a large
        // single-day file this seeks the last `needed` lines instead of parsing
        // the whole file. We re-derive the per-file floor each iteration from how
        // many records are still missing (plus slack so dedup at the boundary is
        // stable), capped at `needed`.
        const remaining = Math.max(0, needed - collected.length);
        const perFileNeeded = Math.min(needed, remaining + BOUNDED_TAIL_SLACK);
        const { lines, coversWholeFile } = readFileTailLines(filePath, perFileNeeded);
        // Walk this file's tail lines newest-first so we fill the tail window from
        // the bottom. seen-dedup keeps the same first-wins-by-newest semantics the
        // full read produced (files are processed newest-first there too).
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line) continue;
            try {
                const parsed = JSON.parse(line) as HistoryMessage;
                const sanitizedMessage = sanitizeHistoryMessage(agentType, parsed);
                if (!sanitizedMessage) continue;
                const hash = buildHistoryMessageHash(agentType, sanitizedMessage);
                if (seen.has(hash)) continue;
                seen.add(hash);
                collected.push(sanitizedMessage);
            } catch { /* skip invalid lines */ }
        }
        // If we only read this file's tail (its head was not reached), older
        // messages remain within this very file — the conversation is NOT fully
        // represented even if this is the last file, so hasMore must stay true.
        if (!coversWholeFile) {
            readAllFiles = false;
            break;
        }
        // Stop once we have the window AND there is at least one more file (so a
        // potential older boundary message exists). If this is the last file we
        // fall through and mark the whole history as read.
        if (collected.length >= needed && f < files.length - 1) {
            readAllFiles = false;
            break;
        }
    }

    // collected is newest-first across the bounded window; restore chronological
    // (oldest-first) order before paging. pageHistoryRecords re-sorts by
    // receivedAt regardless, so this is purely for stable input ordering.
    collected.reverse();
    return { records: collected, readAllFiles };
}
