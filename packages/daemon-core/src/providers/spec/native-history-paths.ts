/**
 * Path-template expansion and transcript-file discovery for the declarative
 * native-history executor: `{var}` / `${ENV}` / `~` expansion, directory glob
 * walking (memoized), and the newest / exact-id / session-bound file pickers.
 *
 * Split out of native-history-executor.ts (file-size gate).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { LOG } from '../../logging/logger.js';
import { SPAWN_BIND_GRACE_MS } from '../native-history/constants.js';
import type { NativeHistoryInput } from './native-history-types.js';

/**
 * Normalize `\` separators to `/` so path templates stay in posix space.
 *
 * spec.json templates are always posix, but `os.homedir()` and `${ENV}`
 * values reintroduce `\` on win32. Every string decomposition in this file
 * (split / lastIndexOf on '/') operates in posix template space; native
 * separators are only materialized where fs is actually touched (the
 * path.join calls at the readdir/stat sites).
 */
export function toPosixPath(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * Split an expanded (posix-space) path template into its directory portion
 * and trailing leaf segment — the decomposition `enumerateSessionFiles`
 * needs before globbing. The input MUST be toPosixPath-normalized: on win32
 * a naive `lastIndexOf('/')` over a backslash path misses every separator
 * and collapses the directory template to '' (the walk then scans the drive
 * root and matches nothing — the win32 "session list always empty" bug).
 */
export function splitTemplateDirLeaf(expandedRoot: string): { dirPart: string; leaf: string } {
    const idx = expandedRoot.lastIndexOf('/');
    return idx >= 0
        ? { dirPart: expandedRoot.slice(0, idx), leaf: expandedRoot.slice(idx + 1) }
        : { dirPart: '', leaf: expandedRoot };
}

/**
 * Expand the leading `~` and `${ENV}` portions of a path template WITHOUT
 * substituting per-session vars, so the caller can decide which of those become
 * enumeration wildcards. Mirrors the head of `expandPath` (tilde + env) but
 * leaves `{...}` template markers intact.
 *
 * The result is always in posix template space (toPosixPath-normalized):
 * tilde expansion joins with '/' instead of path.join, which on win32 would
 * reintroduce '\' and break every '/'-based decomposition downstream.
 */
export function expandTemplateRootForEnumeration(template: string, input: NativeHistoryInput): string {
    if (!template) return '';
    const posixHome = () => toPosixPath(os.homedir());
    let out = template;
    if (out === '~') out = posixHome();
    else if (out.startsWith('~/')) out = `${posixHome()}/${out.slice(2)}`;
    out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name, fallback) => {
        const v = input.envOverrides?.[name] ?? process.env[name];
        return v != null && v !== '' ? v : (fallback ?? '');
    });
    // Re-expand ~ in case the fallback used it.
    if (out === '~') out = posixHome();
    else if (out.startsWith('~/')) out = `${posixHome()}/${out.slice(2)}`;
    return toPosixPath(out);
}

/** Turn every remaining `{var}` template marker into a `*` glob segment. */
export function templateVarsToGlob(template: string): string {
    return template.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '*');
}

/**
 * Extract a uuid from the nearest ancestor DIRECTORY segment of a file path
 * (kimi's `.../session_<uuid>/agents/main/wire.jsonl`). Walks from the leaf's
 * parent upward and returns the first uuid found, or '' when none.
 */
export function dirUuid(filePath: string): string {
    const segs = path.dirname(filePath).split(path.sep);
    for (let i = segs.length - 1; i >= 0; i -= 1) {
        const m = segs[i].match(UUID_RE);
        if (m) return m[1];
    }
    return '';
}

/** Compare two session ids by their embedded uuid, ignoring any prefix/suffix
 *  (kimi's `session_<uuid>` pin vs the bare `<uuid>` the executor extracts). */
export function sameSessionUuid(a: string, b: string): boolean {
    if (a === b) return true;
    const ua = a.match(UUID_RE)?.[1]?.toLowerCase();
    const ub = b.match(UUID_RE)?.[1]?.toLowerCase();
    return !!ua && !!ub && ua === ub;
}

/**
 * Return `input.workspace` when the resolved transcript file provably lives
 * under that workspace's project-slug directory, else undefined.
 *
 * cursor-agent stores transcripts at `~/.cursor/projects/<slug>/…` where
 * `<slug>` is the workspace realpath with every non-`[A-Za-z0-9_-]` char turned
 * into `-` (the same transform claude uses, minus the leading dash from the root
 * `/`). Long slugs are truncated and suffixed with a short hash
 * (`<prefix>-<7hex>`). The transform is lossy, so we cannot reconstruct the real
 * path from the slug — but we CAN verify a candidate workspace matches it. We
 * compute the workspace's slug (both the claude form and the leading-`/`-stripped
 * cursor form) and accept when a path segment of the file equals it OR is a
 * truncated `<prefix>-<hash>` of it. On match the caller stamps the KNOWN real
 * `input.workspace`, so downstream workspace comparison (path.resolve-based)
 * still works; on mismatch we return undefined and the read fails closed rather
 * than aliasing another workspace's transcript.
 */
export function workspaceFromInputIfSlugMatches(sourcePath: string, input: NativeHistoryInput): string | undefined {
    const wsRaw = typeof input.workspace === 'string' ? input.workspace.trim() : '';
    if (!wsRaw) return undefined;
    let wsReal = wsRaw;
    try { wsReal = fs.realpathSync(wsRaw); } catch { /* keep raw */ }
    const slugs = new Set<string>();
    for (const w of [wsReal, wsRaw]) {
        if (!w) continue;
        for (const base of [
            claudeProjectDirName(w),                       // "-Users-…" (leading dash)
            claudeProjectDirName(w.replace(/^\/+/, '')),   // cursor form, no leading dash
        ]) {
            slugs.add(base);
            // cursor-agent additionally COLLAPSES consecutive dashes in its
            // slug (live-measured v2026.08.11: workspace ".../adhdev--claude-…"
            // is stored as ".../adhdev-claude-…"). A workspace path that
            // already contains '-' or any adjacent non-alphanumerics therefore
            // never matched the uncollapsed form, and the read failed closed —
            // silently degrading the chat to the PTY parse for exactly those
            // workspaces (worktrees, tmp dirs). Match the collapsed form too.
            slugs.add(base.replace(/-{2,}/g, '-'));
        }
    }
    const segments = sourcePath.split(path.sep);
    for (const seg of segments) {
        if (!seg) continue;
        for (const slug of slugs) {
            if (!slug) continue;
            if (seg === slug) return wsRaw;
            // Truncated+hashed cursor slug: `<prefix>-<7+hex>` where prefix is a
            // leading portion of the full slug. Require a non-trivial prefix so a
            // short common head can't false-match an unrelated workspace.
            const m = seg.match(/^(.*)-[0-9a-f]{6,}$/);
            if (m && m[1] && m[1].length >= 8 && slug.startsWith(m[1])) return wsRaw;
        }
    }
    return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Path expansion + globbing
// ────────────────────────────────────────────────────────────────────────────

export function expandPath(template: string, input: NativeHistoryInput, opts?: { skipWorkspaceRealpath?: boolean }): string | null {
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
    // Provider specs write `path` templates with literal '/' (see e.g.
    // adhdev-providers/cli/claude-cli/specs/4.0.json), while the ~/-expansion
    // above joins with path.join() (native separators). On win32 the two
    // halves never matched, so a concrete (non-wildcard) resolution carried
    // mixed \ and / — functionally readable by fs, but not the canonical
    // path callers/tests reasonably expect from sourcePath. The wildcard
    // walker handles '*' segments itself, so leave those untouched.
    return out.includes('*') ? out : path.normalize(out);
}

export function claudeProjectDirName(workspace: string): string {
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
/**
 * Derive the concrete base directory for the projects-root scan: the leading
 * static segments of a path template (everything before the first segment
 * containing a template var or wildcard), in posix template space. Returns ''
 * when the template has no static head. The input is toPosixPath-normalized
 * first — on win32 the tilde expansion above yields a '\'-separated head and
 * a naive split('/') would keep the whole path as one segment, deriving a
 * garbage base dir.
 */
export function staticTemplateBase(templateHead: string): string {
    const segs = toPosixPath(templateHead).split('/');
    const baseParts: string[] = [];
    for (const seg of segs) {
        if (/[{}*?]/.test(seg)) break;
        baseParts.push(seg);
    }
    return baseParts.join('/');
}

export function scanProjectsRootForSessionFile(template: string, requestedSessionId: string): string | null {
    if (!requestedSessionId) return null;
    // Resolve the leading static portion of the template (everything before the
    // first {var} segment) into a concrete base directory.
    let head = template;
    if (head.startsWith('~/') || head === '~') head = path.join(os.homedir(), head.slice(2));
    const base = staticTemplateBase(head);
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

export function globToRegex(pattern: string): RegExp {
    // Minimal glob: `*` → `[^/]*`, `?` → `[^/]`, `.` → `\.`. Anchored.
    const re = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${re}$`);
}

/**
 * Split a path template into a root seed and its remaining segments, in posix
 * template space (toPosixPath-normalized). Seeds: posix-absolute → '/', win32
 * drive ('C:/…', the normalized form of 'C:\…') → 'C:/', otherwise the first
 * segment (relative template). The seed is handed to fs as-is — both '/' and
 * 'C:/' are valid roots for node fs on their respective platforms — while
 * deeper segments join natively via path.join at the call site.
 */
export function splitTemplateRoot(template: string): { root: string; segments: string[] } {
    const parts = toPosixPath(template).split('/');
    if (parts[0] === '') return { root: '/', segments: parts.slice(1) };
    // A bare drive letter must seed the DRIVE ROOT ('C:/'), not the relative
    // segment 'C:' (which win32 resolves against the process cwd on that
    // drive — the same collapse class as the enumeration bug).
    if (/^[A-Za-z]:$/.test(parts[0])) return { root: `${parts[0]}/`, segments: parts.slice(1) };
    return { root: parts[0], segments: parts.slice(1) };
}

/**
 * Resolve a path with `*` segments to all concrete directories that match,
 * then pick the newest file inside any of them. `*` matches one path
 * component (no slashes); `**` matches zero or more components. Filenames
 * are matched against `pattern`, not the glob — file_pattern is the right
 * place for the leaf match.
 *
 * Accepts posix- or native-separated templates; decomposition happens in
 * posix template space via splitTemplateRoot.
 */
function expandDirGlobUncached(template: string): string[] {
    const { root, segments } = splitTemplateRoot(template);
    let dirs: string[] = [root];
    for (const seg of segments) {
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

// ─── GLOB-EXPANSION MEMO ─────────────────────────────────────────────────────
//
// Why: resolveJsonlSourcePathDetailed falls through up to three glob-walking
// pickers in ONE status tick (:646-669 — exact pick, then session-bound, then
// newest-recent), and each re-walks the identical tree. On the measured machine
// `~/.claude/projects` holds 579 dirs / 2,285 transcripts, so one pass costs
// ~26ms warm and the tick paid it three times over. The status reporter runs
// every 5s per live CLI session, so the waste scales with session count.
//
// expandDirGlobUncached is a pure function of the template string (dirs on
// disk in, dir list out), which is what makes memoizing it safe.
//
// TTL is the real mechanism, not mtime. Directory mtime only reflects changes
// to a directory's DIRECT children, so a validity check anchored on the glob
// root cannot see a new session appear deeper in a multi-level template:
// `~/.claude/projects/*` (1 level) would be caught, but kimi's
// `~/.kimi-code/sessions/*/session_*/agents/main` (3 levels) never would — a
// new session would stay invisible for as long as the entry lived. A TTL
// shorter than the 5s tick sidesteps that entirely: every tick re-walks at
// least once, so worst-case staleness for a new session is bounded by the TTL
// and never by the depth of the template.
const GLOB_CACHE_TTL_MS = 3_000;
const GLOB_CACHE_MAX_ENTRIES = 512;
// Namespaced so a key can never collide with a differently-derived cache key
// added later. enumerateSessionFiles passes a fully wildcarded template while
// the session-bound pickers pass an expandPath() result with a concrete
// session id and date baked in; both are complete keys on their own, and the
// prefix keeps the two families structurally separate rather than relying on
// their strings happening never to coincide.
const GLOB_CACHE_PREFIX = 'glob:';

interface GlobCacheEntry {
    dirs: string[];
    expiresAtMs: number;
}

const globCache = new Map<string, GlobCacheEntry>();
let globCacheHits = 0;
let globCacheMisses = 0;

/** Observability for the memo — asserted by tests, surfaced for perf work. */
export function getGlobCacheStats(): { hits: number; misses: number; size: number } {
    return { hits: globCacheHits, misses: globCacheMisses, size: globCache.size };
}

/**
 * Test hook: drop the memo (and its counters).
 *
 * The cache is module-global, so without this a suite would inherit whatever a
 * previous test left behind — and vitest reuses the process across files.
 */
export function __clearGlobCacheForTest(): void {
    globCache.clear();
    globCacheHits = 0;
    globCacheMisses = 0;
}

function pruneGlobCache(nowMs: number): void {
    for (const [key, entry] of globCache) {
        if (entry.expiresAtMs <= nowMs) globCache.delete(key);
    }
    // Bound the map even when nothing has expired: `{yyyy}{mm}{dd}` in a
    // template mints a fresh key every calendar day, and each live session
    // contributes its own session-bound key, so the key space grows without a
    // cap. Evict oldest-first (Map preserves insertion order).
    while (globCache.size >= GLOB_CACHE_MAX_ENTRIES) {
        const oldest = globCache.keys().next();
        if (oldest.done) break;
        globCache.delete(oldest.value);
    }
}

/**
 * Memoized `expandDirGlobUncached`. Returns a defensive copy: callers push into
 * and sort their own result arrays, and handing out the cached instance would
 * let one caller corrupt the next one's view.
 */
export function expandDirGlob(template: string): string[] {
    const key = `${GLOB_CACHE_PREFIX}${template}`;
    const now = Date.now();
    const hit = globCache.get(key);
    if (hit && hit.expiresAtMs > now) {
        globCacheHits += 1;
        return hit.dirs.slice();
    }
    globCacheMisses += 1;
    const dirs = expandDirGlobUncached(template);
    pruneGlobCache(now);
    globCache.set(key, { dirs, expiresAtMs: now + GLOB_CACHE_TTL_MS });
    return dirs.slice();
}

function walkAllDirs(root: string, out: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    out.push(root);
    for (const e of entries) {
        if (e.isDirectory()) walkAllDirs(path.join(root, e.name), out);
    }
}

export function newestRecentFileAcrossGlob(template: string, pattern: RegExp, windowMs: number, sessionFloorMs = 0): string | null {
    return recentFilesAcrossGlob(template, pattern, windowMs, sessionFloorMs)[0] ?? null;
}

/** Every matching file across the glob inside the recency window, newest first. */
export function recentFilesAcrossGlob(template: string, pattern: RegExp, windowMs: number, sessionFloorMs = 0): string[] {
    const out: { p: string; mtime: number }[] = [];
    for (const d of expandDirGlob(template)) collectRecentFiles(d, pattern, windowMs, sessionFloorMs, out);
    return out.sort((a, b) => b.mtime - a.mtime).map(c => c.p);
}

function collectRecentFiles(dir: string, pattern: RegExp, windowMs: number, sessionFloorMs: number, out: { p: string; mtime: number }[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs);
    for (const e of entries) {
        if (!e.isFile() || !pattern.test(e.name)) continue;
        const p = path.join(dir, e.name);
        const mtime = safeMtimeMs(p);
        if (mtime >= cutoff) out.push({ p, mtime });
    }
}

export function hasDateTemplateSegment(template: string): boolean {
    return /\{yyyy\}|\{mm\}|\{dd\}/.test(template);
}

/**
 * Walk nearby local calendar days of a date-templated path (e.g.
 * `~/.codex/sessions/{yyyy}/{mm}/{dd}`) and return the newest matching
 * file across all of them. Providers differ on local-vs-UTC date buckets,
 * so today's expanded dir alone can miss a live transcript.
 */
export function newestRecentFileAcrossDateWindow(
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

export function newestRecentFile(dir: string, pattern: RegExp, windowMs: number, sessionFloorMs = 0): string | null {
    return recentFiles(dir, pattern, windowMs, sessionFloorMs)[0] ?? null;
}

/** Every matching file in `dir` inside the recency window, newest first. */
export function recentFiles(dir: string, pattern: RegExp, windowMs: number, sessionFloorMs = 0): string[] {
    const out: { p: string; mtime: number }[] = [];
    collectRecentFiles(dir, pattern, windowMs, sessionFloorMs, out);
    return out.sort((a, b) => b.mtime - a.mtime).map(c => c.p);
}

export function safeMtimeMs(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

/**
 * File creation time in ms, for the spawn-proximity evidence pick: a kimi
 * wire.jsonl is created by the CLI child strictly AFTER the daemon spawned it,
 * so birthtime > the session's spawn floor for its own transcript. Falls back
 * to mtime when birthtime is unavailable (0 / not tracked) so the caller still
 * has a usable ordering key.
 */
export function safeBirthtimeMs(p: string): number {
    try {
        const st = fs.statSync(p);
        const birth = Math.floor(st.birthtimeMs);
        return birth > 0 ? birth : Math.floor(st.mtimeMs);
    } catch { return 0; }
}

export function readRequestedSessionId(input: NativeHistoryInput): string {
    const raw = input.providerSessionId || input.sessionId || input.historySessionId || '';
    const value = typeof raw === 'string' ? raw.trim() : '';
    return UUID_RE.test(value) ? value : '';
}

export function filenameUuid(filePath: string): string {
    const match = path.basename(filePath).match(UUID_RE);
    return match?.[1] || '';
}

export function pickExactSessionFile(dir: string, pattern: RegExp, requestedSessionId: string): string | null {
    if (!requestedSessionId) return null;
    const files = listMatchingFiles(dir, pattern)
        .filter(p => filenameUuid(p).toLowerCase() === requestedSessionId.toLowerCase())
        .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a));
    return files[0] || null;
}

export function pickExactSessionFileAcrossGlob(template: string, pattern: RegExp, requestedSessionId: string): string | null {
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

/**
 * dir_uuid exact pick across a glob: the requested session uuid is embedded in a
 * parent DIRECTORY segment (kimi's `session_<uuid>/…/wire.jsonl`), not the leaf
 * filename. Match the file whose ancestor path carries the requested uuid.
 */
export function pickDirUuidFileAcrossGlob(template: string, pattern: RegExp, requestedSessionId: string): string | null {
    if (!requestedSessionId) return null;
    const wantUuid = requestedSessionId.match(UUID_RE)?.[1]?.toLowerCase();
    if (!wantUuid) return null;
    const dirs = expandDirGlob(template);
    const matches: string[] = [];
    for (const d of dirs) {
        for (const p of listMatchingFiles(d, pattern)) {
            if (dirUuid(p).toLowerCase() === wantUuid) matches.push(p);
        }
    }
    matches.sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a));
    return matches[0] || null;
}

export function pickExactSessionFileAcrossDateWindow(
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

export function listMatchingFiles(dir: string, pattern: RegExp): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const e of entries) {
        if (!e.isFile() || !pattern.test(e.name)) continue;
        out.push(path.join(dir, e.name));
    }
    return out;
}

export function pickSessionBoundFile(
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

export function pickSessionBoundFileAcrossGlob(
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

export function pickSessionBoundFileAcrossDateWindow(
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

export const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
