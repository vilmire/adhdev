import * as fs from 'node:fs';

interface ParsedJsonlCacheEntry {
    signature: string;
    sourceBytes: number;
    lines: any[];
}

interface ParsedJsonlCacheStats {
    hits: number;
    misses: number;
    fileReads: number;
    parsePasses: number;
}

// JSONL transcripts are append-heavy and read repeatedly while a CLI paints
// its PTY. Reuse a parse only while file identity + size + timestamps are all
// unchanged. Both entry count and aggregate source bytes are bounded because
// parsed objects occupy more memory than their on-disk representation.
const PARSED_JSONL_CACHE_MAX_ENTRIES = 8;
const PARSED_JSONL_CACHE_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const parsedJsonlCache = new Map<string, ParsedJsonlCacheEntry>();
let parsedJsonlCacheSourceBytes = 0;
const parsedJsonlCacheStats: ParsedJsonlCacheStats = { hits: 0, misses: 0, fileReads: 0, parsePasses: 0 };

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
    let text: string;
    try {
        text = fs.readFileSync(p, 'utf8');
        parsedJsonlCacheStats.fileReads++;
    } catch {
        return [];
    }
    parsedJsonlCacheStats.parsePasses++;
    const out: any[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
    }
    storeParsedJsonlCache(p, { signature, sourceBytes: stat.size, lines: out });
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
}
