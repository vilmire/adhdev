/**
 * Declarative native-history executor.
 *
 * Reads a spec.json's `native_history.source` block and turns it into a
 * NativeHistoryResult by talking directly to the on-disk store (jsonl
 * file or sqlite db). No per-provider TypeScript reader required —
 * adding a new provider is just authoring spec.json.
 *
 * Two source kinds:
 *   - jsonl   — newest matching file inside a path (with variable expansion)
 *               + jsonpath-lite map for each record
 *   - sqlite  — read-only better-sqlite3 handle, two queries (session pick
 *               + message fetch) + jsonpath-lite map for each row
 *
 * Exotic formats can still ship a provider-local reader via
 * `native_history.override_path` — the dispatcher in provider-loader picks
 * that path instead of calling this executor.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    NativeHistoryConfig,
    NativeHistoryJsonlSource,
    NativeHistoryMessageMap,
    NativeHistorySqliteSource,
} from './types.js';

export interface NativeHistoryInput {
    agentType?: string;
    sessionId?: string;
    providerSessionId?: string;
    historySessionId?: string;
    workspace?: string;
    /** Daemon-side wall clock at the moment the session was registered.
     *  Native-history file lookups use this as the lower bound: any file
     *  whose mtime is before the current session started can't be from
     *  this session, so it's excluded from newest-recent matching. The
     *  caller (chat-history pipeline) populates this from the session
     *  registry; specs/executor never need to know how it's sourced. */
    sessionStartedAtMs?: number;
    args?: Record<string, unknown>;
}

export interface NativeHistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    receivedAt: number;
    kind?: string;
}

export interface NativeHistoryResult {
    messages: NativeHistoryMessage[];
    providerSessionId?: string;
    sourcePath: string;
    sourceMtimeMs: number;
    nativeHistoryCoverage?: 'full' | 'partial' | 'best-effort';
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function executeNativeHistory(cfg: NativeHistoryConfig, input: NativeHistoryInput): NativeHistoryResult | null {
    if (!cfg?.source) return null;
    if (cfg.source.kind === 'jsonl') return executeJsonl(cfg.source, input);
    if (cfg.source.kind === 'sqlite') return executeSqlite(cfg.source, input);
    return null;
}

// ────────────────────────────────────────────────────────────────────────────
// JSONL
// ────────────────────────────────────────────────────────────────────────────

function executeJsonl(src: NativeHistoryJsonlSource, input: NativeHistoryInput): NativeHistoryResult | null {
    const resolved = expandPath(src.path, input);
    if (!resolved) return null;

    const windowMs = typeof src.recent_window_ms === 'number' ? src.recent_window_ms : 5 * 60_000;
    const filePat = src.file_pattern ? globToRegex(src.file_pattern) : /.*\.jsonl$/;

    // path can be:
    //   - a concrete file  → used as-is
    //   - a concrete dir   → newest matching file inside recent_window_ms
    //   - a path with `*` or `**` segments → walk all dirs that match the
    //     glob, pick the newest matching file across all matches. Lets
    //     specs like ~/.gemini/antigravity-cli/brain/*/.system_generated/logs
    //     resolve transparently without a per-provider override.
    // The session-start cutoff guarantees a fresh dashboard view can't
    // pick up a transcript file from a session that ended before this
    // one started. recent_window_ms only controls how far back we'd
    // otherwise look for a matching file; the session-start floor wins
    // when it's later.
    const sessionFloor = typeof input.sessionStartedAtMs === 'number' ? input.sessionStartedAtMs : 0;
    let sourcePath: string | null = null;
    if (resolved.includes('*')) {
        sourcePath = newestRecentFileAcrossGlob(resolved, filePat, windowMs, sessionFloor);
    } else {
        let stat: fs.Stats | null = null;
        try { stat = fs.statSync(resolved); } catch { return null; }
        if (stat.isFile()) {
            sourcePath = resolved;
        } else if (stat.isDirectory()) {
            sourcePath = newestRecentFile(resolved, filePat, windowMs, sessionFloor);
        }
    }
    if (!sourcePath) return null;

    const mtime = safeMtimeMs(sourcePath);
    const lines = readJsonlLines(sourcePath);
    if (lines.length === 0) return null;

    // session id: filename uuid or extracted from first record
    let providerSessionId: string | undefined;
    if (src.session_id_from === 'first_record' && src.session_id_path) {
        const v = jsonPathGet(lines[0], src.session_id_path);
        if (typeof v === 'string' && v) providerSessionId = v;
    } else if (src.session_id_from === 'filename_uuid' || !src.session_id_from) {
        const m = path.basename(sourcePath).match(UUID_RE);
        if (m) providerSessionId = m[1];
    }

    const requested = input.providerSessionId || '';
    if (requested && providerSessionId && providerSessionId !== requested) return null;

    const filter = src.message_filter ? compileWhere(src.message_filter.where) : null;
    const messages: NativeHistoryMessage[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const rec = lines[i];
        if (filter && !filter(rec)) continue;
        const msg = projectMessage(rec, src.message_map, i, lines.length, mtime);
        if (msg) messages.push(msg);
    }
    if (messages.length === 0) return null;

    return {
        messages,
        providerSessionId,
        sourcePath,
        sourceMtimeMs: mtime,
        nativeHistoryCoverage: 'full',
    };
}

function readJsonlLines(p: string): any[] {
    let text: string;
    try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
    const out: any[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// SQLite
// ────────────────────────────────────────────────────────────────────────────

function executeSqlite(src: NativeHistorySqliteSource, input: NativeHistoryInput): NativeHistoryResult | null {
    const resolved = expandPath(src.path, input);
    if (!resolved || !fs.existsSync(resolved)) return null;

    let Database: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        Database = require('better-sqlite3');
    } catch { return null; }

    let db: any;
    try { db = new Database(resolved, { readonly: true, fileMustExist: true }); }
    catch { return null; }

    try {
        let sessionRow: any;
        try {
            // session_query may reference `?` to receive the session's
            // start-time floor in seconds (e.g. WHERE started_at >= ?).
            // That gives spec authors a robust way to keep prior-session
            // rows out of a fresh dashboard view without inventing their
            // own time arithmetic in SQL. When the caller didn't pass a
            // session floor (i.e. no live session is associated with the
            // call), we use 0 so spec queries that bind `?` still produce
            // a sane result rather than choking the whole executor.
            const sessionFloorSeconds = typeof input.sessionStartedAtMs === 'number'
                ? Math.floor(input.sessionStartedAtMs / 1000)
                : 0;
            const stmt = db.prepare(src.session_query);
            // better-sqlite3 throws when the param count doesn't match,
            // so try the bound form first and fall back to the no-arg
            // form if the query doesn't reference `?`. This avoids
            // depending on a parameterCount property that better-sqlite3
            // doesn't expose.
            try {
                sessionRow = stmt.get(sessionFloorSeconds);
            } catch {
                sessionRow = stmt.get();
            }
        } catch { return null; }
        if (!sessionRow) return null;
        // First column of the first row is the session id.
        const sessionIdRaw = Object.values(sessionRow)[0];
        const sessionId = sessionIdRaw == null ? '' : String(sessionIdRaw);
        if (!sessionId) return null;

        const requested = input.providerSessionId || '';
        if (requested && sessionId !== requested) return null;

        const messageRows: any[] = db.prepare(src.message_query).all(sessionId);
        if (!messageRows || messageRows.length === 0) return null;

        const mtime = safeMtimeMs(resolved);
        const messages: NativeHistoryMessage[] = [];
        for (let i = 0; i < messageRows.length; i += 1) {
            const msg = projectMessage(messageRows[i], src.message_map, i, messageRows.length, mtime);
            if (msg) messages.push(msg);
        }
        if (messages.length === 0) return null;

        return {
            messages,
            providerSessionId: sessionId,
            sourcePath: resolved,
            sourceMtimeMs: mtime,
            nativeHistoryCoverage: 'full',
        };
    } finally {
        try { db.close(); } catch { /* ignore */ }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Path expansion + globbing
// ────────────────────────────────────────────────────────────────────────────

function expandPath(template: string, input: NativeHistoryInput): string | null {
    if (!template) return null;
    let out = template;
    if (out.startsWith('~/') || out === '~') {
        out = path.join(os.homedir(), out.slice(2));
    }
    out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, name) => process.env[name] ?? '');
    const now = new Date();
    const vars: Record<string, string> = {
        cwd: input.workspace ?? '',
        cwd_dashed: (input.workspace ?? '').replace(/\//g, '-'),
        session_id: input.providerSessionId || input.sessionId || input.historySessionId || '',
        yyyy: String(now.getUTCFullYear()),
        mm: String(now.getUTCMonth() + 1).padStart(2, '0'),
        dd: String(now.getUTCDate()).padStart(2, '0'),
    };
    // Replace {var}. If a referenced variable is empty (e.g. session_id
    // before the agent has allocated one), return null so the caller
    // doesn't accidentally fall through to an unrelated newest-file
    // match. Wildcards (`*`) are explicitly allowed to pass — the dir
    // glob walker handles them separately.
    let missing = false;
    out = out.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name) => {
        const v = vars[name] ?? '';
        if (!v) missing = true;
        return v;
    });
    if (missing) return null;
    return out;
}

function globToRegex(pattern: string): RegExp {
    // Minimal glob: `*` → `[^/]*`, `?` → `[^/]`, `.` → `\.`. Anchored.
    const re = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${re}$`);
}

/**
 * Resolve a path with `*` segments to all concrete directories that match,
 * then pick the newest file inside any of them. `*` matches one path
 * component (no slashes); `**` matches zero or more components. Filenames
 * are matched against `pattern`, not the glob — file_pattern is the right
 * place for the leaf match.
 */
function expandDirGlob(template: string): string[] {
    const parts = template.split('/');
    let dirs: string[] = parts[0] === '' ? ['/'] : [parts[0]];
    for (let i = 1; i < parts.length; i += 1) {
        const seg = parts[i];
        if (!seg) continue;
        const next: string[] = [];
        if (seg === '**') {
            for (const d of dirs) walkAllDirs(d, next);
            dirs = next;
            continue;
        }
        if (seg.includes('*') || seg.includes('?')) {
            const re = globToRegex(seg);
            for (const d of dirs) {
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
                for (const e of entries) {
                    if (e.isDirectory() && re.test(e.name)) next.push(path.join(d, e.name));
                }
            }
        } else {
            for (const d of dirs) {
                const candidate = path.join(d, seg);
                let stat: fs.Stats | null = null;
                try { stat = fs.statSync(candidate); } catch { continue; }
                if (stat.isDirectory()) next.push(candidate);
            }
        }
        dirs = next;
    }
    return dirs;
}

function walkAllDirs(root: string, out: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    out.push(root);
    for (const e of entries) {
        if (e.isDirectory()) walkAllDirs(path.join(root, e.name), out);
    }
}

function newestRecentFileAcrossGlob(template: string, pattern: RegExp, windowMs: number, sessionFloorMs = 0): string | null {
    const dirs = expandDirGlob(template);
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs);
    let best: { p: string; mtime: number } | null = null;
    for (const d of dirs) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isFile() || !pattern.test(e.name)) continue;
            const p = path.join(d, e.name);
            const mtime = safeMtimeMs(p);
            if (mtime < cutoff) continue;
            if (!best || mtime > best.mtime) best = { p, mtime };
        }
    }
    return best ? best.p : null;
}

function newestRecentFile(dir: string, pattern: RegExp, windowMs: number, sessionFloorMs = 0): string | null {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs);
    let best: { p: string; mtime: number } | null = null;
    for (const e of entries) {
        if (!e.isFile() || !pattern.test(e.name)) continue;
        const p = path.join(dir, e.name);
        const mtime = safeMtimeMs(p);
        if (mtime < cutoff) continue;
        if (!best || mtime > best.mtime) best = { p, mtime };
    }
    return best ? best.p : null;
}

function safeMtimeMs(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
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
function jsonPathGet(record: any, expr: string): unknown {
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

function projectMessage(record: any, map: NativeHistoryMessageMap, index: number, total: number, sourceMtimeMs: number): NativeHistoryMessage | null {
    const roleRaw = jsonPathGet(record, map.role);
    const contentRaw = jsonPathGet(record, map.content);
    const role = normalizeRole(roleRaw);
    let content = stringifyContent(contentRaw);
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
    if (content) content = content.trim();
    if (!content) return null;

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
    return { role, content, receivedAt, kind };
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
function parseTimestamp(v: unknown): number | null {
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
function stringifyContent(v: unknown): string {
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

function compileWhere(src: string): (record: any) => boolean {
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
