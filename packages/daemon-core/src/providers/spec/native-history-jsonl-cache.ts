import * as fs from 'node:fs';

interface ParsedJsonlCacheEntry {
    signature: string;
    sourceBytes: number;
    lines: any[];
    /**
     * Byte offset just past the last '\n' whose line was parsed into `lines`.
     * A resumed read starts here, so a trailing partial write (a line the CLI
     * has not terminated yet) is never committed — see readJsonlLines.
     */
    committedBytes: number;
    /**
     * How many entries of `lines` come from `committedBytes` worth of settled
     * input. When the file ended mid-line, `lines` additionally holds the
     * records parsed from that uncommitted fragment, so a resume must drop back
     * to this length before appending the tail — otherwise the finished line is
     * emitted twice.
     */
    committedLineCount: number;
    /** File identity the committed prefix belongs to (see canResumeFrom). */
    dev: number;
    ino: number;
}

interface ParsedJsonlCacheStats {
    hits: number;
    misses: number;
    fileReads: number;
    parsePasses: number;
    /** Reads served by parsing only the appended tail of an existing entry. */
    incrementalReads: number;
    /** Bytes skipped by incremental reads — the whole point of the cache. */
    incrementalBytesSkipped: number;
}

// JSONL transcripts are append-heavy and read repeatedly while a CLI paints
// its PTY. Reuse a parse only while file identity + size + timestamps are all
// unchanged. Both entry count and aggregate source bytes are bounded because
// parsed objects occupy more memory than their on-disk representation.
const PARSED_JSONL_CACHE_MAX_ENTRIES = 8;
const PARSED_JSONL_CACHE_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const parsedJsonlCache = new Map<string, ParsedJsonlCacheEntry>();
let parsedJsonlCacheSourceBytes = 0;
const parsedJsonlCacheStats: ParsedJsonlCacheStats = {
    hits: 0,
    misses: 0,
    fileReads: 0,
    parsePasses: 0,
    incrementalReads: 0,
    incrementalBytesSkipped: 0,
};

function parsedJsonlSignature(stat: fs.Stats): string {
    // size catches normal appends; ctime/ino additionally catch same-size
    // rewrites and atomic replacement even on coarse-mtime filesystems.
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function storeParsedJsonlCache(p: string, entry: ParsedJsonlCacheEntry): void {
    const prior = parsedJsonlCache.get(p);
    if (prior) parsedJsonlCacheSourceBytes -= prior.sourceBytes;
    parsedJsonlCache.delete(p);

    if (entry.sourceBytes > PARSED_JSONL_CACHE_MAX_SOURCE_BYTES) return;
    parsedJsonlCache.set(p, entry);
    parsedJsonlCacheSourceBytes += entry.sourceBytes;

    while (
        parsedJsonlCache.size > PARSED_JSONL_CACHE_MAX_ENTRIES
        || parsedJsonlCacheSourceBytes > PARSED_JSONL_CACHE_MAX_SOURCE_BYTES
    ) {
        const oldestKey = parsedJsonlCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = parsedJsonlCache.get(oldestKey);
        if (oldest) parsedJsonlCacheSourceBytes -= oldest.sourceBytes;
        parsedJsonlCache.delete(oldestKey);
    }
}

/**
 * Whether `cached`'s committed prefix is still a byte-prefix of the file `stat`
 * describes, i.e. the file only grew.
 *
 * This is deliberately conservative. Anything that is not "same file, same
 * inode, not shorter than what we already committed" falls back to a full
 * re-read: truncation, rotation, atomic replace (new ino), or a same-path file
 * on a different device. We do NOT verify the retained prefix byte-for-byte —
 * a rewrite that preserves length and inode while changing earlier bytes would
 * be missed — because that is precisely what dev+ino+size+mtime+ctime already
 * guards against for the whole-file path, and no JSONL store this cache serves
 * (claude / codex / cursor / kimi) rewrites in place. Stores that DO mutate in
 * place (hermes sqlite, antigravity .db) never reach this module.
 */
function canResumeFrom(cached: ParsedJsonlCacheEntry, stat: fs.Stats): boolean {
    if (cached.dev !== stat.dev || cached.ino !== stat.ino) return false;
    // A shrink means bytes we already committed are gone — the prefix is void.
    if (stat.size < cached.committedBytes) return false;
    return true;
}

/**
 * Parse `text` as JSONL, appending records to `out`.
 *
 * Returns the number of leading bytes that may be COMMITTED to the cache as a
 * settled prefix: everything up to and including the final newline. A trailing
 * fragment with no newline is parsed and emitted (so a writer that omits the
 * final newline still surfaces its last record, exactly as the pre-cache
 * whole-file reader did) but is deliberately NOT committed, because the writer
 * may still be mid-flush and about to extend that very line. The next read
 * re-reads and re-parses those bytes, at which point the completed line
 * replaces the fragment.
 *
 * That split — emit everything, commit only what is newline-terminated — is
 * what makes an incremental resume safe against JSONL partial writes without
 * changing what callers observe.
 */
function parseJsonlInto(out: any[], text: string): { committedBytes: number; committedLineCount: number } {
    const lastNewline = text.lastIndexOf('\n');
    // Only the segment after the final newline can be an in-progress write;
    // every earlier segment is newline-terminated and therefore settled.
    const settled = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    const fragment = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;

    for (const line of settled.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
    }
    const committedLineCount = out.length;

    const trimmedFragment = fragment.trim();
    if (trimmedFragment) {
        try { out.push(JSON.parse(trimmedFragment)); } catch { /* skip malformed line */ }
    }

    return { committedBytes: Buffer.byteLength(settled, 'utf8'), committedLineCount };
}

function readTailBytes(p: string, from: number, to: number): string | null {
    if (to <= from) return '';
    let fd: number | null = null;
    try {
        fd = fs.openSync(p, 'r');
        const length = to - from;
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, from);
        // A multi-byte UTF-8 character can straddle the `to` boundary only if
        // the writer appended past the size we stat'ed; we simply parse what we
        // read and let the unterminated remainder roll into the next tick.
        return buf.subarray(0, read).toString('utf8');
    } catch {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
}

export function readJsonlLines(p: string, forceRefresh = false): any[] {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(p);
    } catch {
        return [];
    }
    const signature = parsedJsonlSignature(stat);
    const cached = parsedJsonlCache.get(p);
    if (!forceRefresh && cached?.signature === signature) {
        parsedJsonlCacheStats.hits++;
        // Refresh LRU recency without cloning the read-only parsed records.
        parsedJsonlCache.delete(p);
        parsedJsonlCache.set(p, cached);
        return cached.lines;
    }

    parsedJsonlCacheStats.misses++;

    // Append-only fast path: the file grew (or only its timestamps moved) and
    // the bytes we already parsed are still a prefix of it, so parse just the
    // tail and extend the existing record array. `forceRefresh` opts out — a
    // completion-contract probe wants a genuinely fresh read of the whole file.
    if (!forceRefresh && cached && canResumeFrom(cached, stat)) {
        const tail = readTailBytes(p, cached.committedBytes, stat.size);
        if (tail !== null) {
            parsedJsonlCacheStats.fileReads++;
            parsedJsonlCacheStats.incrementalReads++;
            parsedJsonlCacheStats.incrementalBytesSkipped += cached.committedBytes;
            // Copy before extending: consumers hold the array returned by an
            // earlier call, and a cached parse must never mutate under them.
            // Truncating to committedLineCount drops any record parsed from a
            // previously-unterminated trailing fragment, whose full bytes are
            // re-read below — without this the finished line lands twice.
            const lines = cached.lines.slice(0, cached.committedLineCount);
            if (tail.length > 0) parsedJsonlCacheStats.parsePasses++;
            const parsed = parseJsonlInto(lines, tail);
            storeParsedJsonlCache(p, {
                signature,
                sourceBytes: stat.size,
                lines,
                committedBytes: cached.committedBytes + parsed.committedBytes,
                committedLineCount: parsed.committedLineCount,
                dev: stat.dev,
                ino: stat.ino,
            });
            return lines;
        }
        // Tail read failed — fall through to the whole-file path.
    }

    let text: string;
    try {
        text = fs.readFileSync(p, 'utf8');
        parsedJsonlCacheStats.fileReads++;
    } catch {
        return [];
    }
    parsedJsonlCacheStats.parsePasses++;
    const out: any[] = [];
    const parsed = parseJsonlInto(out, text);
    storeParsedJsonlCache(p, {
        signature,
        sourceBytes: stat.size,
        lines: out,
        committedBytes: parsed.committedBytes,
        committedLineCount: parsed.committedLineCount,
        dev: stat.dev,
        ino: stat.ino,
    });
    return out;
}

/** TESTS ONLY: deterministic cache/read counters for hot-path regression tests. */
export function __getParsedJsonlCacheStatsForTests(): ParsedJsonlCacheStats {
    return { ...parsedJsonlCacheStats };
}

/** TESTS ONLY. */
export function __resetParsedJsonlCacheForTests(): void {
    parsedJsonlCache.clear();
    parsedJsonlCacheSourceBytes = 0;
    parsedJsonlCacheStats.hits = 0;
    parsedJsonlCacheStats.misses = 0;
    parsedJsonlCacheStats.fileReads = 0;
    parsedJsonlCacheStats.parsePasses = 0;
    parsedJsonlCacheStats.incrementalReads = 0;
    parsedJsonlCacheStats.incrementalBytesSkipped = 0;
}
