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
import { LOG } from '../../logging/logger.js';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import type {
    NativeHistoryConfig,
    NativeHistoryJsonlSource,
    NativeHistoryMessageMap,
    NativeHistorySqliteSource,
    NativeHistoryToolMap,
} from './types.js';
import { SPAWN_BIND_GRACE_MS } from '../native-history/constants.js';

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
    /** Env overrides the daemon set on the spawned CLI. The mesh
     *  coordinator points hermes at a per-coordinator HERMES_HOME so
     *  the hermes process writes its state.db into a tmp directory
     *  instead of ~/.hermes. expandPath consults this map before
     *  process.env so the native-history reader follows the spawned
     *  child's view of HERMES_HOME / similar overrides; without it
     *  the reader would always look at ~/.hermes and miss every
     *  coordinator-session transcript. */
    envOverrides?: Record<string, string>;
    args?: Record<string, unknown>;
}

export interface NativeHistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    receivedAt: number;
    kind?: string;
    workspace?: string;
}

export interface NativeHistoryResult {
    messages: NativeHistoryMessage[];
    providerSessionId?: string;
    sourcePath: string;
    sourceMtimeMs: number;
    nativeHistoryCoverage?: 'full' | 'partial' | 'best-effort';
    workspace?: string;
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
    const requestedSessionId = readRequestedSessionId(input);

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
    // When multiple concurrent CLI sessions in the same workspace each create
    // their own rollout (e.g. two codex-cli sessions both writing into
    // ~/.codex/sessions/{date}), `newestRecentFile` picks the same file for
    // every reader and the daemon sessions cross-alias each other. Prefer
    // session-meta-aware matching: the candidate whose meta.cwd matches the
    // workspace AND whose meta.timestamp is closest to (or within
    // spawnGraceMs of) the daemon's spawn time wins. Falls back to mtime
    // ordering when no candidate exposes a usable session_meta.
    const workspaceHint = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim() : '';
    let sourcePath: string | null = null;
    if (resolved.includes('*')) {
        sourcePath = pickExactSessionFileAcrossGlob(resolved, filePat, requestedSessionId)
            || pickSessionBoundFileAcrossGlob(resolved, filePat, windowMs, sessionFloor, workspaceHint)
            || newestRecentFileAcrossGlob(resolved, filePat, windowMs, sessionFloor);
    } else {
        let stat: fs.Stats | null = null;
        try { stat = fs.statSync(resolved); } catch { /* fall through to date-walk fallback */ }
        if (stat && stat.isFile()) {
            sourcePath = resolved;
        } else if (stat && stat.isDirectory()) {
            sourcePath = pickExactSessionFile(resolved, filePat, requestedSessionId)
                || (requestedSessionId ? null : pickSessionBoundFile(resolved, filePat, windowMs, sessionFloor, workspaceHint))
                || (requestedSessionId ? null : newestRecentFile(resolved, filePat, windowMs, sessionFloor));
        }
        // Date-templated directories (e.g. ~/.codex/sessions/{yyyy}/{mm}/{dd})
        // can drift from the provider's chosen calendar day because CLIs
        // disagree on local-vs-UTC date buckets. Search nearby date dirs
        // before falling back to non-exact matching.
        if (!sourcePath && hasDateTemplateSegment(src.path)) {
            sourcePath = pickExactSessionFileAcrossDateWindow(src.path, input, filePat, requestedSessionId)
                || (requestedSessionId ? null : pickSessionBoundFileAcrossDateWindow(src.path, input, filePat, windowMs, sessionFloor, workspaceHint))
                || (requestedSessionId ? null : newestRecentFileAcrossDateWindow(src.path, input, filePat, windowMs, sessionFloor));
        }
        // Raw-workspace slug candidate: `resolved` derives its {cwd*} slug from
        // fs.realpathSync(workspace). On Windows realpath normalizes the path
        // (drive-letter case D:↔d:, \\?\ long-path prefix, junction expansion)
        // so the slug can diverge from the one the CLI actually wrote — and the
        // concrete path above then misses with ENOENT. Retry with the slug built
        // from the RAW workspace string before falling back to a scan; it's the
        // cheap fix when realpath divergence is the only problem.
        if (!sourcePath && !hasDateTemplateSegment(src.path)) {
            const resolvedRaw = expandPath(src.path, input, { skipWorkspaceRealpath: true });
            if (resolvedRaw && resolvedRaw !== resolved) {
                try {
                    const rawStat = fs.statSync(resolvedRaw);
                    if (rawStat.isFile()) sourcePath = resolvedRaw;
                    else if (rawStat.isDirectory()) {
                        sourcePath = pickExactSessionFile(resolvedRaw, filePat, requestedSessionId)
                            || (requestedSessionId ? null : newestRecentFile(resolvedRaw, filePat, windowMs, sessionFloor));
                    }
                } catch { /* raw slug also missed — fall through to scan */ }
            }
        }
        // Last-resort scan: the slug-derived directory missed entirely (the
        // dominant Windows failure: realpath/raw slug both diverge from the CLI's
        // on-disk project dir → 0 messages, no PTY fallback for native-source
        // providers). When we have an exact session id, walk the projects root
        // for `<sessionId>.jsonl` regardless of which project subdir holds it.
        // The session id is a UUID, so basename matching is unambiguous; mirrors
        // the standalone reader's scan (claude-cli-transcript.ts resolveTranscriptPath).
        if (!sourcePath && requestedSessionId) {
            sourcePath = scanProjectsRootForSessionFile(src.path, input, requestedSessionId);
        }
    }
    if (!sourcePath) {
        // Was silent before — a slug miss produced 0 messages with no trace, so
        // a live read_chat returning empty was indistinguishable from "no file"
        // vs "wrong path". Log the attempted concrete path + both slug variants
        // so the failure mode is greppable in daemon logs.
        const wsRaw = typeof input.workspace === 'string' ? input.workspace : '';
        let wsReal = wsRaw;
        try { if (wsRaw) wsReal = fs.realpathSync(wsRaw); } catch { /* keep raw */ }
        LOG.debug('NativeHistory', `jsonl unresolved: tried=${JSON.stringify(resolved)} sessionId=${requestedSessionId || '(none)'} wsRaw=${JSON.stringify(wsRaw)} wsReal=${JSON.stringify(wsReal)} rawSlug=${JSON.stringify(claudeProjectDirName(wsRaw))} realSlug=${JSON.stringify(claudeProjectDirName(wsReal))} (concrete miss + raw-slug retry + projects scan all failed)`);
        return null;
    }

    const mtime = safeMtimeMs(sourcePath);
    const lines = readJsonlLines(sourcePath);
    if (lines.length === 0) return null;
    const transcriptWorkspace = readSessionMetaWorkspace(lines);

    // session id: filename uuid or extracted from first record
    let providerSessionId: string | undefined;
    if (src.session_id_from === 'first_record' && src.session_id_path) {
        const v = jsonPathGet(lines[0], src.session_id_path);
        if (typeof v === 'string' && v) providerSessionId = v;
    } else if (src.session_id_from === 'filename_uuid' || !src.session_id_from) {
        const m = path.basename(sourcePath).match(UUID_RE);
        if (m) providerSessionId = m[1];
    }

    const requested = requestedSessionId || '';
    if (requested && providerSessionId && providerSessionId !== requested) return null;

    const filter = src.message_filter ? compileWhere(src.message_filter.where) : null;
    const messages: NativeHistoryMessage[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const rec = lines[i];
        if (filter && !filter(rec)) continue;
        for (const msg of projectMessages(rec, src.message_map, i, lines.length, mtime)) {
            if (transcriptWorkspace) msg.workspace = transcriptWorkspace;
            messages.push(msg);
        }
    }
    if (messages.length === 0) return null;

    return {
        messages,
        providerSessionId,
        sourcePath,
        sourceMtimeMs: mtime,
        nativeHistoryCoverage: 'full',
        workspace: transcriptWorkspace,
    };
}

function readSessionMetaWorkspace(lines: any[]): string | undefined {
    for (const record of lines.slice(0, 5)) {
        if (String(record?.type ?? '') !== 'session_meta') continue;
        const cwd = typeof record?.payload?.cwd === 'string' ? record.payload.cwd.trim() : '';
        if (cwd) return cwd;
    }
    return undefined;
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
        Database = loadBetterSqlite3();
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
            for (const msg of projectMessages(messageRows[i], src.message_map, i, messageRows.length, mtime)) {
                messages.push(msg);
            }
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

function expandPath(template: string, input: NativeHistoryInput, opts?: { skipWorkspaceRealpath?: boolean }): string | null {
    if (!template) return null;
    let out = template;
    if (out.startsWith('~/') || out === '~') {
        out = path.join(os.homedir(), out.slice(2));
    }
    // ${VAR} expands from envOverrides (the spawned child's view) first,
    // then process.env. ${VAR:-fallback} keeps the bash-style default
    // so spec authors can say e.g. ${HERMES_HOME:-~/.hermes}/state.db
    // and have it work both for coordinator-launched sessions (where
    // HERMES_HOME is set to a tmpdir) and normal sessions.
    out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name, fallback) => {
        const v = input.envOverrides?.[name] ?? process.env[name];
        return v != null && v !== '' ? v : (fallback ?? '');
    });
    // Re-expand ~ in case the fallback used it.
    if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
    const now = new Date();
    // Claude writes per-cwd transcripts under the resolved path and replaces
    // every non-alphanumeric project-path character except `_` and `-` with
    // `-`. Realpath also handles aliases such as /tmp -> /private/tmp.
    const workspaceRaw = input.workspace ?? '';
    let workspaceResolved = workspaceRaw;
    // The caller may request the RAW slug (skip realpath) to recover from
    // Windows realpath normalization diverging the {cwd*} slug from the dir
    // the CLI actually created. Default keeps realpath (handles /tmp ->
    // /private/tmp aliasing that the CLI itself resolves on macOS).
    if (workspaceRaw && !opts?.skipWorkspaceRealpath) {
        try { workspaceResolved = fs.realpathSync(workspaceRaw); }
        catch { /* path may not exist yet — keep the raw value */ }
    }
    const vars: Record<string, string> = {
        cwd: workspaceResolved,
        cwd_dashed: workspaceResolved.replace(/\//g, '-'),
        cwd_claude_project: claudeProjectDirName(workspaceResolved),
        session_id: input.providerSessionId || input.sessionId || input.historySessionId || '',
        yyyy: String(now.getFullYear()),
        mm: String(now.getMonth() + 1).padStart(2, '0'),
        dd: String(now.getDate()).padStart(2, '0'),
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

function claudeProjectDirName(workspace: string): string {
    return workspace.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Last-resort lookup for a transcript by its exact session id, ignoring the
 * per-cwd slug entirely. The slug-derived directory above can miss completely
 * when the CLI's on-disk project dir disagrees with the slug we reconstruct
 * (notably on Windows, where fs.realpathSync normalizes drive-letter case and
 * adds a \\?\ prefix). Since the session id is a UUID, scanning the projects
 * root for `<sessionId>.jsonl` is unambiguous.
 *
 * Derives the scan base from the template's segments up to (but excluding) the
 * first one that references a per-session variable ({cwd*} or {session_id}) —
 * e.g. `~/.claude/projects/{cwd_claude_project}/{session_id}.jsonl` → scan
 * `~/.claude/projects`. Returns the matching file path, or null.
 */
function scanProjectsRootForSessionFile(template: string, input: NativeHistoryInput, requestedSessionId: string): string | null {
    if (!requestedSessionId) return null;
    // Resolve the leading static portion of the template (everything before the
    // first {var} segment) into a concrete base directory.
    let head = template;
    if (head.startsWith('~/') || head === '~') head = path.join(os.homedir(), head.slice(2));
    const segs = head.split('/');
    const baseParts: string[] = [];
    for (const seg of segs) {
        if (/[{}*?]/.test(seg)) break;
        baseParts.push(seg);
    }
    const base = baseParts.join('/');
    if (!base) return null;
    let baseStat: fs.Stats | null = null;
    try { baseStat = fs.statSync(base); } catch { return null; }
    if (!baseStat.isDirectory()) return null;

    const needle = `${requestedSessionId.toLowerCase()}.jsonl`;
    // Bounded walk: project layouts are <root>/<projectDir>/<uuid>.jsonl, so a
    // shallow scan (root + one level of subdirs) suffices and avoids walking an
    // unbounded tree. Check the root itself first, then each immediate subdir.
    const dirsToScan: string[] = [base];
    try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory()) dirsToScan.push(path.join(base, entry.name));
        }
    } catch { /* readdir failed — fall back to scanning base only */ }

    for (const dir of dirsToScan) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (entry.name.toLowerCase() !== needle) continue;
            const found = path.join(dir, entry.name);
            LOG.debug('NativeHistory', `jsonl scan-fallback hit: sessionId=${requestedSessionId} resolved via projects-root scan → ${JSON.stringify(found)} (slug-derived path missed; likely realpath/slug divergence)`);
            return found;
        }
    }
    return null;
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

function hasDateTemplateSegment(template: string): boolean {
    return /\{yyyy\}|\{mm\}|\{dd\}/.test(template);
}

/**
 * Walk nearby local calendar days of a date-templated path (e.g.
 * `~/.codex/sessions/{yyyy}/{mm}/{dd}`) and return the newest matching
 * file across all of them. Providers differ on local-vs-UTC date buckets,
 * so today's expanded dir alone can miss a live transcript.
 */
function newestRecentFileAcrossDateWindow(
    template: string,
    input: NativeHistoryInput,
    pattern: RegExp,
    windowMs: number,
    sessionFloorMs: number,
): string | null {
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs);
    let best: { p: string; mtime: number } | null = null;
    for (const dayOffset of [0, -1, 1, -2, 2]) {
        const dayMs = Date.now() + dayOffset * 24 * 60 * 60 * 1000;
        const dayInput: NativeHistoryInput = { ...input, sessionStartedAtMs: sessionFloorMs };
        const resolved = expandPathForDate(template, dayInput, new Date(dayMs));
        if (!resolved) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isFile() || !pattern.test(e.name)) continue;
            const p = path.join(resolved, e.name);
            const mtime = safeMtimeMs(p);
            if (mtime < cutoff) continue;
            if (!best || mtime > best.mtime) best = { p, mtime };
        }
    }
    return best ? best.p : null;
}

function expandPathForDate(template: string, input: NativeHistoryInput, day: Date): string | null {
    // Reuse expandPath logic but stamp {yyyy}/{mm}/{dd} from the given day.
    if (!template) return null;
    let out = template;
    if (out.startsWith('~/') || out === '~') {
        out = path.join(os.homedir(), out.slice(2));
    }
    out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name, fallback) => {
        const v = input.envOverrides?.[name] ?? process.env[name];
        return v != null && v !== '' ? v : (fallback ?? '');
    });
    if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
    const workspaceRaw = input.workspace ?? '';
    let workspaceResolved = workspaceRaw;
    if (workspaceRaw) {
        try { workspaceResolved = fs.realpathSync(workspaceRaw); } catch { /* keep raw */ }
    }
    const vars: Record<string, string> = {
        cwd: workspaceResolved,
        cwd_dashed: workspaceResolved.replace(/\//g, '-'),
        cwd_claude_project: claudeProjectDirName(workspaceResolved),
        session_id: input.providerSessionId || input.sessionId || input.historySessionId || '',
        yyyy: String(day.getFullYear()),
        mm: String(day.getMonth() + 1).padStart(2, '0'),
        dd: String(day.getDate()).padStart(2, '0'),
    };
    let missing = false;
    out = out.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name) => {
        const v = vars[name] ?? '';
        if (!v) missing = true;
        return v;
    });
    if (missing) return null;
    return out;
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

function readRequestedSessionId(input: NativeHistoryInput): string {
    const raw = input.providerSessionId || input.sessionId || input.historySessionId || '';
    const value = typeof raw === 'string' ? raw.trim() : '';
    return UUID_RE.test(value) ? value : '';
}

function filenameUuid(filePath: string): string {
    const match = path.basename(filePath).match(UUID_RE);
    return match?.[1] || '';
}

function pickExactSessionFile(dir: string, pattern: RegExp, requestedSessionId: string): string | null {
    if (!requestedSessionId) return null;
    const files = listMatchingFiles(dir, pattern)
        .filter(p => filenameUuid(p).toLowerCase() === requestedSessionId.toLowerCase())
        .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a));
    return files[0] || null;
}

function pickExactSessionFileAcrossGlob(template: string, pattern: RegExp, requestedSessionId: string): string | null {
    if (!requestedSessionId) return null;
    const dirs = expandDirGlob(template);
    const matches: string[] = [];
    for (const d of dirs) {
        const found = pickExactSessionFile(d, pattern, requestedSessionId);
        if (found) matches.push(found);
    }
    matches.sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a));
    return matches[0] || null;
}

function pickExactSessionFileAcrossDateWindow(
    template: string,
    input: NativeHistoryInput,
    pattern: RegExp,
    requestedSessionId: string,
): string | null {
    if (!requestedSessionId) return null;
    const matches: string[] = [];
    for (const dayOffset of [0, -1, 1, -2, 2]) {
        const dayMs = Date.now() + dayOffset * 24 * 60 * 60 * 1000;
        const resolved = expandPathForDate(template, input, new Date(dayMs));
        if (!resolved) continue;
        const found = pickExactSessionFile(resolved, pattern, requestedSessionId);
        if (found) matches.push(found);
    }
    matches.sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a));
    return matches[0] || null;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-session rollout binding
//
// Reads the first JSONL line of a candidate file and returns a `session_meta`
// payload if present. Codex-cli writes
//   {"timestamp":"...","type":"session_meta","payload":{"id":...,"cwd":...,
//    "timestamp":"..."}}
// as the first record. Other providers that don't follow this convention
// return null and fall back to the mtime-based picker.
// ────────────────────────────────────────────────────────────────────────────

interface CandidateMeta {
    cwd?: string;
    sessionTimestampMs?: number;
}

function readCandidateSessionMeta(filePath: string): CandidateMeta | null {
    try {
        // Read only the first line — meta is always the first JSONL record
        // and full file reads here would scale O(files × file_size).
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(8192);
            const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
            if (bytes <= 0) return null;
            const text = buf.subarray(0, bytes).toString('utf8');
            const nl = text.indexOf('\n');
            const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
            if (!firstLine) return null;
            const parsed = JSON.parse(firstLine) as Record<string, unknown>;
            if (String(parsed.type ?? '') !== 'session_meta') return null;
            const payload = parsed.payload && typeof parsed.payload === 'object'
                ? (parsed.payload as Record<string, unknown>)
                : null;
            if (!payload) return null;
            const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
            const tsRaw = payload.timestamp;
            const tsMs = typeof tsRaw === 'string'
                ? Date.parse(tsRaw)
                : typeof tsRaw === 'number'
                    ? (tsRaw < 1e12 ? Math.floor(tsRaw * 1000) : Math.floor(tsRaw))
                    : NaN;
            return {
                cwd,
                sessionTimestampMs: Number.isFinite(tsMs) ? tsMs : undefined,
            };
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

function pickBoundFromEntries(
    candidatePaths: string[],
    sessionFloorMs: number,
    workspaceHint: string,
): string | null {
    if (!sessionFloorMs || !workspaceHint || candidatePaths.length === 0) return null;
    // Resolve workspaceHint to handle macOS /tmp → /private/tmp aliasing, the
    // same way expandPath does for the template substitution. Without this
    // the daemon's `/Users/foo/repo` and codex's `/private/Users/foo/repo`
    // never compare equal and disambiguation silently fails.
    let workspaceResolved = workspaceHint;
    try { workspaceResolved = fs.realpathSync(workspaceHint); } catch { /* keep raw */ }
    let best: { p: string; diff: number } | null = null;
    for (const p of candidatePaths) {
        const meta = readCandidateSessionMeta(p);
        if (!meta || !meta.cwd || meta.sessionTimestampMs == null) continue;
        let candidateCwd = meta.cwd;
        try { candidateCwd = fs.realpathSync(meta.cwd); } catch { /* keep raw */ }
        if (candidateCwd !== workspaceResolved && meta.cwd !== workspaceHint) continue;
        const diff = Math.abs(meta.sessionTimestampMs - sessionFloorMs);
        if (diff > SPAWN_BIND_GRACE_MS) continue;
        if (!best || diff < best.diff) best = { p, diff };
    }
    return best ? best.p : null;
}

function listMatchingFiles(dir: string, pattern: RegExp): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const e of entries) {
        if (!e.isFile() || !pattern.test(e.name)) continue;
        out.push(path.join(dir, e.name));
    }
    return out;
}

function pickSessionBoundFile(
    dir: string,
    pattern: RegExp,
    windowMs: number,
    sessionFloorMs: number,
    workspaceHint: string,
): string | null {
    if (!sessionFloorMs || !workspaceHint) return null;
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs - SPAWN_BIND_GRACE_MS);
    const files = listMatchingFiles(dir, pattern).filter(p => safeMtimeMs(p) >= cutoff);
    return pickBoundFromEntries(files, sessionFloorMs, workspaceHint);
}

function pickSessionBoundFileAcrossGlob(
    template: string,
    pattern: RegExp,
    windowMs: number,
    sessionFloorMs: number,
    workspaceHint: string,
): string | null {
    if (!sessionFloorMs || !workspaceHint) return null;
    const dirs = expandDirGlob(template);
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs - SPAWN_BIND_GRACE_MS);
    const files: string[] = [];
    for (const d of dirs) {
        for (const p of listMatchingFiles(d, pattern)) {
            if (safeMtimeMs(p) >= cutoff) files.push(p);
        }
    }
    return pickBoundFromEntries(files, sessionFloorMs, workspaceHint);
}

function pickSessionBoundFileAcrossDateWindow(
    template: string,
    input: NativeHistoryInput,
    pattern: RegExp,
    windowMs: number,
    sessionFloorMs: number,
    workspaceHint: string,
): string | null {
    if (!sessionFloorMs || !workspaceHint) return null;
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs - SPAWN_BIND_GRACE_MS);
    const files: string[] = [];
    for (const dayOffset of [0, -1, 1, -2, 2]) {
        const dayMs = sessionFloorMs + dayOffset * 24 * 60 * 60 * 1000;
        const dayInput: NativeHistoryInput = { ...input, sessionStartedAtMs: sessionFloorMs };
        const resolved = expandPathForDate(template, dayInput, new Date(dayMs));
        if (!resolved) continue;
        for (const p of listMatchingFiles(resolved, pattern)) {
            if (safeMtimeMs(p) >= cutoff) files.push(p);
        }
    }
    return pickBoundFromEntries(files, sessionFloorMs, workspaceHint);
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

/**
 * Project one on-disk record into zero or more transcript messages.
 *
 * A record yields at most one text bubble (the prose turn) plus — when the
 * spec declares `message_map.tools` — one `kind:'tool'` bubble per tool-call
 * or tool-result content block. Without `tools`, behaviour is identical to
 * the old single-message projection: text-only, tool blocks dropped.
 */
function projectMessages(record: any, map: NativeHistoryMessageMap, index: number, total: number, sourceMtimeMs: number): NativeHistoryMessage[] {
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
        const recordTool = projectToolBlock(record, role, map.tools);
        if (recordTool) {
            out.push({ ...recordTool, receivedAt });
            return out;
        }
    }

    const contentRaw = jsonPathGet(record, map.content);
    const content = cleanContent(stringifyContent(contentRaw), map);
    if (content) out.push({ role, content, receivedAt, kind });

    // Block-nested tool bubbles are ordered just after the text bubble of the
    // same record by nudging receivedAt forward a millisecond per bubble, so a
    // turn's prose still renders before its tool activity without colliding
    // with the next record's timestamp.
    if (map.tools && Array.isArray(contentRaw)) {
        let nudge = 1;
        for (const block of contentRaw) {
            const tool = projectToolBlock(block, role, map.tools);
            if (tool) {
                out.push({ ...tool, receivedAt: receivedAt + nudge });
                nudge += 1;
            }
        }
    }

    return out;
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

const DEFAULT_TOOL_CALL_TYPES = ['tool_use', 'function_call', 'custom_tool_call'];
const DEFAULT_TOOL_RESULT_TYPES = ['tool_result', 'function_call_output', 'custom_tool_call_output'];

/**
 * Turn a single content block into a `kind:'tool'` message, or null if the
 * block is not a tool call/result. Field locations come from the spec's
 * `tools` map with Anthropic-block defaults.
 *
 * Both tool calls and tool results render on the assistant side: a tool call
 * is the agent's action, and a tool result is part of the agent's work, not a
 * user turn (claude/codex persist results under the user / no role, which would
 * otherwise misattribute them). Calls render as `↗ {name}: {one-line args}`,
 * results as `↘ {one-line result}`. The `role` param is accepted for symmetry
 * but tool bubbles are always assistant.
 */
function projectToolBlock(block: any, role: 'user' | 'assistant' | 'system', tmap: NativeHistoryToolMap): NativeHistoryMessage | null {
    void role;
    if (block == null || typeof block !== 'object') return null;
    const typeVal = String(jsonPathGet(block, tmap.block_type || '$.type') ?? '');
    if (!typeVal) return null;
    const callTypes = tmap.call_types ?? DEFAULT_TOOL_CALL_TYPES;
    const resultTypes = tmap.result_types ?? DEFAULT_TOOL_RESULT_TYPES;

    if (callTypes.includes(typeVal)) {
        const name = String(jsonPathGet(block, tmap.call_name || '$.name') ?? 'tool').trim() || 'tool';
        const args = oneLine(stringifyContent(jsonPathGet(block, tmap.call_args || '$.input')), 240);
        const content = args ? `↗ ${name}: ${args}` : `↗ ${name}`;
        return { role: 'assistant', content, receivedAt: 0, kind: 'tool' };
    }
    if (resultTypes.includes(typeVal)) {
        const result = oneLine(stringifyContent(jsonPathGet(block, tmap.result_content || '$.content')), 600);
        if (!result) return null;
        return { role: 'assistant', content: `↘ ${result}`, receivedAt: 0, kind: 'tool' };
    }
    return null;
}

/** Collapse whitespace to single spaces and cap length for a tool summary. */
function oneLine(s: string, max: number): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
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
