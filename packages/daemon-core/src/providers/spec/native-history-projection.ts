/**
 * Record → message projection for the declarative native-history executor:
 * jsonpath-lite field reads, record-shape / usage-shape compilation, and the
 * per-record message projection (text, tool blocks, timestamps, roles).
 *
 * Split out of native-history-executor.ts (file-size gate).
 */
import { makeUsage, type NativeUsageRecord } from '../../shared/usage-normalize.js';
import { recordBlockSource } from '../../chat/message-source-address.js';
import type {
    NativeHistoryToolMap, NativeHistoryJsonlSource, NativeHistoryMessageMap, NativeHistoryUsageMap,
} from './types.js';
import type { NativeHistoryToolBlockRef, NativeHistoryMessage } from './native-history-types.js';
import { projectToolBlock as projectToolBlockImpl } from './native-history-tool-blocks.js';

/**
 * Bind the tool-block projector to this module's own `jsonPathGet` /
 * `stringifyContent`, so the extracted module stays free of an import cycle
 * back into the executor while still resolving spec fields identically.
 */
function projectToolBlock(
    block: any,
    role: 'user' | 'assistant' | 'system',
    tmap: NativeHistoryToolMap,
    ref?: NativeHistoryToolBlockRef,
): NativeHistoryMessage | null {
    return projectToolBlockImpl(block, role, tmap, { jsonPathGet, stringifyContent }, ref);
}

/**
 * Resolve the projection strategy for a jsonl source. Multi-shape (`records[]`)
 * picks the first entry whose `where` matches a record; single-shape falls back
 * to the top-level `message_map` gated by the optional `message_filter`.
 */
// Exported for `tool-block-expand.ts`: a multi-shape (`records[]`) store picks
// the content/tools map PER RECORD, so the expand path must pick the shape with
// this same matcher rather than assuming the top-level `message_map`.
export function compileRecordShapes(src: NativeHistoryJsonlSource): {
    pick: (record: any) => { map: NativeHistoryMessageMap } | null;
} {
    if (Array.isArray(src.records) && src.records.length > 0) {
        const compiled = src.records.map((r) => ({
            where: r.where ? compileWhere(r.where) : null,
            map: r.message_map,
        }));
        return {
            pick: (record: any) => {
                for (const shape of compiled) {
                    if (!shape.where || shape.where(record)) return { map: shape.map };
                }
                return null;
            },
        };
    }
    const filter = src.message_filter ? compileWhere(src.message_filter.where) : null;
    const map = src.message_map;
    return {
        pick: (record: any) => {
            if (!map) return null;
            if (filter && !filter(record)) return null;
            return { map };
        },
    };
}

/**
 * Compile the optional `usage_records` matchers into a picker.
 *
 * Mirrors `compileRecordShapes` but for token usage: usage lines are not
 * messages and must not enter the `messages` array. Returns null when the spec
 * declares no usage extraction, so every existing provider skips the work
 * entirely.
 */
export function compileUsageShapes(src: NativeHistoryJsonlSource): ((record: any) => NativeHistoryUsageMap | null) | null {
    if (!Array.isArray(src.usage_records) || src.usage_records.length === 0) return null;
    const compiled = src.usage_records.map((r) => ({
        where: r.where ? compileWhere(r.where) : null,
        map: r.usage_map,
    }));
    return (record: any) => {
        for (const shape of compiled) {
            if (!shape.where || shape.where(record)) return shape.map;
        }
        return null;
    };
}

/**
 * Project one matched record onto a normalized usage record via its usage_map.
 *
 * Returns null when the map resolves no token path at all, so a record that
 * matched the `where` but carries nothing countable (a malformed or
 * partially-written line) does not inflate the observation count.
 */
export function projectUsageRecord(
    record: any,
    map: NativeHistoryUsageMap,
    sourceMtimeMs: number,
): NativeUsageRecord | null {
    const read = (p?: string): unknown => (p ? jsonPathGet(record, p) : undefined);

    const input = read(map.input_tokens);
    const output = read(map.output_tokens);
    const cacheRead = read(map.cache_read_tokens);
    const cacheCreation = read(map.cache_creation_tokens);
    const reasoning = read(map.reasoning_tokens);
    if (
        input === undefined && output === undefined && cacheRead === undefined
        && cacheCreation === undefined && reasoning === undefined
    ) return null;

    const modelRaw = read(map.model);
    const usage = makeUsage({
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        reasoningTokens: reasoning,
        model: typeof modelRaw === 'string' ? modelRaw : undefined,
    });

    const parsedTs = map.timestamp_ms ? parseTimestamp(read(map.timestamp_ms)) : null;
    return {
        ...usage,
        mode: map.mode === 'cumulative' ? 'cumulative' : 'delta',
        receivedAt: parsedTs == null ? sourceMtimeMs : parsedTs,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// jsonpath-lite + projection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `$.a.b[0].c` against a record. Strings without leading `$` are
 * literals. Supports `||` fallback between paths so a single message_map
 * entry can pick the first non-empty value across alternative locations
 * (e.g. agy's content vs. thinking).
 */
// Exported for `tool-block-expand.ts`: the on-demand expand path MUST resolve
// spec field locations with the same reader the parser used, or the two could
// disagree about which field a `message_map` entry names.
export function jsonPathGet(record: any, expr: string): unknown {
    if (typeof expr !== 'string') return undefined;
    if (expr.includes('||')) {
        for (const alt of expr.split('||')) {
            const v = jsonPathGet(record, alt.trim());
            if (v != null && v !== '') return v;
        }
        return undefined;
    }
    if (!expr.startsWith('$')) return expr;
    let cur: any = record;
    let i = 1;
    while (i < expr.length && cur != null) {
        const ch = expr[i];
        if (ch === '.') { i += 1; continue; }
        if (ch === '[') {
            const close = expr.indexOf(']', i);
            if (close < 0) return undefined;
            const idx = Number(expr.slice(i + 1, close));
            if (!Number.isInteger(idx)) return undefined;
            cur = cur[idx];
            i = close + 1;
            continue;
        }
        let end = i;
        while (end < expr.length && expr[end] !== '.' && expr[end] !== '[') end += 1;
        const key = expr.slice(i, end);
        cur = cur[key];
        i = end;
    }
    return cur;
}

/**
 * Project one on-disk record into zero or more transcript messages.
 *
 * A record yields at most one text bubble (the prose turn) plus — when the
 * spec declares `message_map.tools` — one `kind:'tool'` bubble per tool-call
 * or tool-result content block. Without `tools`, behaviour is identical to
 * the old single-message projection: text-only, tool blocks dropped.
 */
export function projectMessages(
    record: any,
    map: NativeHistoryMessageMap,
    index: number,
    total: number,
    sourceMtimeMs: number,
    /**
     * Lineage (history session id) for `_src` stamping — passed only by the
     * jsonl transcript reader, whose `index` is an append-stable record index.
     * Omitted (no stamping) for summaries and for sqlite rows, whose position
     * is a query-order ordinal.
     */
    sourceLineage?: string,
): NativeHistoryMessage[] {
    const roleRaw = jsonPathGet(record, map.role);
    const role = normalizeRole(roleRaw);

    // Records are passed in chronological order (oldest → newest), so the
    // last record's receivedAt should be ~sourceMtimeMs (when the file was
    // last touched) and earlier records should walk backwards. Earlier
    // version had this inverted, which made the dashboard render bubbles
    // in reverse order and produce the "chat jumping" effect.
    let receivedAt = sourceMtimeMs - ((total - 1 - index) * 1000);
    if (map.timestamp_ms) {
        const tsRaw = jsonPathGet(record, map.timestamp_ms);
        const parsed = parseTimestamp(tsRaw);
        if (parsed != null) receivedAt = parsed;
    }
    const kindRaw = map.kind ? jsonPathGet(record, map.kind) : undefined;
    const kind = typeof kindRaw === 'string' && kindRaw ? kindRaw : 'standard';

    const out: NativeHistoryMessage[] = [];

    // Two transcript shapes carry tool activity:
    //   - record-level: the whole record IS a tool call/result (codex stores
    //     each function_call / function_call_output as its own jsonl record).
    //   - block-nested: tool blocks live inside the message's content array
    //     (claude stores tool_use / tool_result as content blocks).
    // When the spec opts into `tools`, try the record itself first; if it's a
    // tool record we emit only that bubble (it has no prose). Otherwise emit
    // the text bubble plus a tool bubble per matching content block.
    if (map.tools) {
        // blockIndex -1: the record itself is the tool block, so there is no
        // content-array position to name.
        const recordTool = projectToolBlock(record, role, map.tools, {
            sourceMtimeMs,
            recordIndex: index,
            blockIndex: -1,
        });
        if (recordTool) {
            out.push(withRecordSource({ ...recordTool, receivedAt }, sourceLineage, index, -1));
            return out;
        }
    }

    // Per-message workspace: sqlite sources have no `session_meta` record to
    // carry the cwd (jsonl-only), so a spec can SELECT the session directory
    // into each row and map it here. The downstream hasSafeNativeHistoryMapping
    // guard needs it to accept a workspace-scoped read (no provider session id
    // captured from the TUI); without it every assistant bubble is dropped.
    const workspaceRaw = map.workspace ? jsonPathGet(record, map.workspace) : undefined;
    const workspace = typeof workspaceRaw === 'string' && workspaceRaw.trim() ? workspaceRaw.trim() : undefined;

    const contentRaw = jsonPathGet(record, map.content);
    const content = cleanContent(stringifyContent(contentRaw), map);
    if (content) {
        out.push(withRecordSource(
            workspace ? { role, content, receivedAt, kind, workspace } : { role, content, receivedAt, kind },
            sourceLineage,
            index,
            -1,
        ));
    }

    // Block-nested tool bubbles are ordered just after the text bubble of the
    // same record by nudging receivedAt forward a millisecond per bubble, so a
    // turn's prose still renders before its tool activity without colliding
    // with the next record's timestamp.
    if (map.tools && Array.isArray(contentRaw)) {
        let nudge = 1;
        // blockIndex is the position in the RAW content array, not a count of
        // emitted bubbles: non-tool blocks (prose) are skipped here, so the two
        // diverge, and the expand path indexes back into the raw array.
        for (let blockIndex = 0; blockIndex < contentRaw.length; blockIndex += 1) {
            const tool = projectToolBlock(contentRaw[blockIndex], role, map.tools, {
                sourceMtimeMs,
                recordIndex: index,
                blockIndex,
            });
            if (tool) {
                out.push(withRecordSource({ ...tool, receivedAt: receivedAt + nudge }, sourceLineage, index, blockIndex));
                nudge += 1;
            }
        }
    }

    return out;
}

/**
 * Stamp the identity ledger's native address (`n.<L>.<recordIndex>.<blockIndex+1>`)
 * when a lineage is known. The text bubble of a record is part 0, exactly like a
 * record-level tool bubble — the two are mutually exclusive per record.
 */
function withRecordSource(message: NativeHistoryMessage, lineage: string | undefined, recordIndex: number, blockIndex: number): NativeHistoryMessage {
    if (!lineage) return message;
    const src = recordBlockSource(lineage, recordIndex, blockIndex);
    return src ? { ...message, _src: src } : message;
}

/** Apply content_strip / content_unwrap tag surgery and trim. */
function cleanContent(input: string, map: NativeHistoryMessageMap): string {
    let content = input;
    if (content && map.content_strip) {
        for (const tag of map.content_strip) {
            const safeTag = tag.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`<${safeTag}\\b[^>]*>[\\s\\S]*?<\\/${safeTag}\\s*>`, 'gi');
            content = content.replace(re, '');
        }
    }
    if (content && map.content_unwrap) {
        for (const tag of map.content_unwrap) {
            const safeTag = tag.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            const open = new RegExp(`<${safeTag}\\b[^>]*>`, 'gi');
            const close = new RegExp(`<\\/${safeTag}\\s*>`, 'gi');
            content = content.replace(open, '').replace(close, '');
        }
    }
    return content ? content.trim() : '';
}

/**
 * Coerce a timestamp value to epoch milliseconds. Accepts:
 *   - number (ms or seconds — heuristic: < 1e12 means seconds)
 *   - ISO 8601 string ("2026-06-05T01:25:28Z")
 *   - numeric string
 *
 * Returns null when the value can't be parsed; caller falls back to the
 * monotonic-by-index estimate.
 */
export function parseTimestamp(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        return v < 1e12 ? Math.floor(v * 1000) : Math.floor(v);
    }
    if (typeof v === 'string' && v) {
        const trimmed = v.trim();
        const asNum = Number(trimmed);
        if (Number.isFinite(asNum) && asNum > 0) {
            return asNum < 1e12 ? Math.floor(asNum * 1000) : Math.floor(asNum);
        }
        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function normalizeRole(r: unknown): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human' || s === 'user_explicit') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
    if (s === 'tool' || s === 'tool_result' || s === 'function') return 'assistant';
    return 'system';
}

/**
 * Coerce a content value to a plain string the dashboard can render.
 *
 * Many providers ship structured content (claude messages are arrays of
 * typed blocks: text / tool_use / tool_result). We collapse those to
 * their text-bearing parts so the dashboard doesn't show raw JSON
 * fragments in the transcript. Tool calls/results are intentionally
 * dropped — the daemon's chat schema is for user-visible turns.
 *
 * Order of attempts:
 *   1. string                          → as-is
 *   2. array of blocks                 → join the `text` field of each
 *                                        block that has one; if none have
 *                                        a text field, fall through
 *   3. object with a top-level `text`  → that string
 *   4. last resort                     → JSON.stringify
 */
// Exported alongside `jsonPathGet` for `tool-block-expand.ts` — same reason:
// the expanded text must be stringified identically to the summarised text.
export function stringifyContent(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
        const parts: string[] = [];
        for (const block of v) {
            if (block == null) continue;
            if (typeof block === 'string') { parts.push(block); continue; }
            if (typeof block === 'object') {
                const t = (block as any).text;
                if (typeof t === 'string' && t) { parts.push(t); continue; }
                // tool_use / tool_result / image / etc — skip from the
                // user-facing transcript. They re-surface via the
                // adapter's tool-event channel if/when that's wired.
            }
        }
        if (parts.length > 0) return parts.join('\n');
        return '';
    }
    if (typeof v === 'object') {
        const t = (v as any).text;
        if (typeof t === 'string') return t;
    }
    try { return JSON.stringify(v); } catch { return String(v); }
}

// ────────────────────────────────────────────────────────────────────────────
// where-clause mini-language
//
// Grammar (intentionally tiny — keep spec readable):
//   expr  := term  (('&&' | '||') term)*
//   term  := path op literal
//   op    := '==' | '!=' | '>' | '<' | '>=' | '<='
//   path  := jsonpath like '$.foo.bar[0].baz'
//   literal := string ('"…"' or "'…'") | number | true | false | null
//
// No grouping, no negation. If you need more, write a real reader file
// behind `native_history.override_path`.
// ────────────────────────────────────────────────────────────────────────────

interface WhereTerm { path: string; op: string; lit: unknown; negate?: boolean }

export function compileWhere(src: string): (record: any) => boolean {
    const ors: WhereTerm[][] = [];
    for (const orChunk of src.split('||')) {
        const ands: WhereTerm[] = [];
        for (const andChunk of orChunk.split('&&')) {
            const term = parseTerm(andChunk.trim());
            if (term) ands.push(term);
        }
        if (ands.length > 0) ors.push(ands);
    }
    return (record: any) => ors.some(ands => ands.every(t => evalTerm(t, record)));
}

function parseTerm(src: string): WhereTerm | null {
    let s = src.trim();
    let negate = false;
    if (s.startsWith('!')) { negate = true; s = s.slice(1).trim(); }
    // Function-call form: startsWith($.x, "y") / endsWith($.x, "y") / contains($.x, "y")
    const fnMatch = s.match(/^(startsWith|endsWith|contains)\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)$/);
    if (fnMatch) {
        const [, op, pathExpr, litExpr] = fnMatch;
        return { path: pathExpr, op, lit: parseLiteral(litExpr), negate };
    }
    // Binary comparison: <path> <op> <literal>
    const opMatch = s.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!opMatch) return null;
    const [, lhs, op, rhsRaw] = opMatch;
    return { path: lhs.trim(), op, lit: parseLiteral(rhsRaw.trim()), negate };
}

function parseLiteral(src: string): unknown {
    if (src === 'true') return true;
    if (src === 'false') return false;
    if (src === 'null') return null;
    if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
        return src.slice(1, -1);
    }
    const n = Number(src);
    if (!Number.isNaN(n)) return n;
    return src; // bareword — treated as string
}

function evalTerm(t: WhereTerm, record: any): boolean {
    const lhs = jsonPathGet(record, t.path);
    const lit = t.lit;
    let result: boolean;
    switch (t.op) {
        case '==':         result = lhs === lit; break;
        case '!=':         result = lhs !== lit; break;
        case '>':          result = Number(lhs) >  Number(lit); break;
        case '<':          result = Number(lhs) <  Number(lit); break;
        case '>=':         result = Number(lhs) >= Number(lit); break;
        case '<=':         result = Number(lhs) <= Number(lit); break;
        case 'startsWith': result = typeof lhs === 'string' && typeof lit === 'string' && lhs.startsWith(lit); break;
        case 'endsWith':   result = typeof lhs === 'string' && typeof lit === 'string' && lhs.endsWith(lit); break;
        case 'contains':   result = typeof lhs === 'string' && typeof lit === 'string' && lhs.includes(lit); break;
        default:           result = false;
    }
    return t.negate ? !result : result;
}
