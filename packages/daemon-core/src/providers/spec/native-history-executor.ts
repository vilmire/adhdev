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
    NativeHistoryUsageMap,
} from './types.js';
import { SPAWN_BIND_GRACE_MS } from '../native-history/constants.js';
import {
    foldUsageRecords,
    makeUsage,
    type NativeUsageRecord,
    type SessionUsageTotals,
} from '../native-history/usage-normalize.js';
import {
    claimTranscript,
    isTranscriptClaimedByOther,
    transcriptClaimOwnerToken,
} from '../native-history/transcript-claim-registry.js';

export interface NativeHistoryInput {
    agentType?: string;
    sessionId?: string;
    providerSessionId?: string;
    historySessionId?: string;
    /** Daemon instance id of the reading session (== the session registry
     *  sessionId == the read path's targetSessionId). Sidecar-workspace stores
     *  (kimi) derive the transcript-claim owner token from it so two concurrent
     *  same-cwd sessions never bind the same wire.jsonl. Empty → claiming is
     *  skipped (legacy single-session behaviour). */
    instanceId?: string;
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
    /**
     * Sidecar-workspace stores (kimi): how the resolved transcript was
     * attributed to this reading session.
     *   'pinned'          — exact bind by a previously pinned/claimed session id
     *   'claimed'         — exclusive claim on the single viable candidate
     *   'stale_reclaimed' — claim taken over from a demonstrably dead owner
     *   'spawn_evidence'  — unique spawn-proximity evidence (no claim identity)
     *   'legacy'          — single-candidate bind with no claim identity
     *   'ambiguous'       — FAIL CLOSED: ≥2 viable same-workspace candidates
     *   'already_claimed' — FAIL CLOSED: every viable candidate is owned by a
     *                       DIFFERENT live session
     * Undefined for non-sidecar sources (their resolution is unchanged).
     */
    attribution?: 'pinned' | 'claimed' | 'stale_reclaimed' | 'spawn_evidence' | 'legacy' | 'ambiguous' | 'already_claimed';
    /** True only when the bind rests on strong evidence (exact pin, an
     *  exclusive claim, or unique spawn-proximity evidence) — never on a
     *  newest-mtime guess. Read-path callers may persist a pin only then. */
    ownerConfirmed?: boolean;
    /** Typed fail-closed reason. 'attribution_unknown' means two or more viable
     *  same-workspace candidates could not be uniquely attributed (or all are
     *  owned by other live sessions); NO messages and NO providerSessionId are
     *  returned so no durable pin can be written from the ambiguity. */
    unavailableReason?: string;
    /** Token totals, present only when the spec declares `usage_records` and
     *  the transcript actually carried at least one matching record. */
    usage?: SessionUsageTotals;
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function executeNativeHistory(cfg: NativeHistoryConfig, input: NativeHistoryInput): NativeHistoryResult | null {
    if (!cfg?.source) return null;
    if (cfg.source.kind === 'jsonl') return executeJsonl(cfg.source, input);
    if (cfg.source.kind === 'sqlite') return executeSqlite(cfg.source, input);
    return null;
}

/**
 * One enumerated saved session. Structurally matches the fields the chat-history
 * `list_saved_sessions` pipeline expects (`normalizeProviderNativeHistorySessionSummary`
 * reads exactly these keys), so the executor can be wired straight into
 * `listNativeHistory` with no daemon-side adapter.
 */
export interface NativeHistorySessionListItem {
    historySessionId: string;
    sessionTitle?: string;
    messageCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    preview?: string;
    workspace?: string;
    sourcePath: string;
    sourceMtimeMs: number;
}

export interface NativeHistoryListResult {
    sessions: NativeHistorySessionListItem[];
}

/**
 * Enumerate every on-disk saved session for a declarative jsonl source.
 *
 * Where `executeNativeHistory` resolves the ONE file for a pinned/current
 * session, this walks the whole store: it turns the source `path` template into
 * a directory glob (per-session template vars — {session_id}, {cwd*}, the date
 * segments — collapse to `*`) and lists every file matching the leaf pattern
 * across all matched dirs. Each file becomes one session summary. session_id is
 * extracted the same way the reader does (`session_id_from`), and per-session
 * preview/messageCount/first/last come from a MINIMAL projection (first + last
 * projected message only, no full-array build).
 *
 * Without this, the loader wired only the read function and dropped the list
 * marker, so `list_saved_sessions` always returned `[]` for every v2.0
 * declarative-source provider (claude/codex/antigravity/kimi/cursor) even with
 * thousands of transcripts on disk.
 */
export function executeNativeHistoryList(cfg: NativeHistoryConfig, input?: NativeHistoryInput): NativeHistoryListResult | null {
    if (!cfg?.source) return null;
    // sqlite sources enumerate through their own `session_query`; only jsonl
    // stores are file-per-session and enumerable by directory walk here.
    if (cfg.source.kind !== 'jsonl') return null;
    return { sessions: enumerateJsonlSessions(cfg.source, input ?? {}) };
}

// ────────────────────────────────────────────────────────────────────────────
// JSONL enumeration (list_saved_sessions)
// ────────────────────────────────────────────────────────────────────────────

function enumerateJsonlSessions(src: NativeHistoryJsonlSource, input: NativeHistoryInput): NativeHistorySessionListItem[] {
    const files = enumerateSessionFiles(src, input);
    const shapes = compileRecordShapes(src);
    const out: NativeHistorySessionListItem[] = [];
    const seen = new Set<string>();
    for (const filePath of files) {
        const item = summarizeSessionFile(src, filePath, shapes);
        if (!item) continue;
        // A store can surface the same session from more than one matched dir
        // (glob overlap). Keep the newest-touched instance per session id.
        const key = item.historySessionId.toLowerCase();
        if (seen.has(key)) {
            const existing = out.find(s => s.historySessionId.toLowerCase() === key);
            if (existing && item.sourceMtimeMs > existing.sourceMtimeMs) {
                out[out.indexOf(existing)] = item;
            }
            continue;
        }
        seen.add(key);
        out.push(item);
    }
    out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return out;
}

/**
 * Resolve the source `path` template into every concrete transcript file on
 * disk. Per-session template vars ({session_id}, {cwd*}, {yyyy}/{mm}/{dd})
 * collapse to a `*` wildcard so the walk spans all sessions/workspaces/days;
 * literal `*`/`**` segments pass through to `expandDirGlob`.
 *
 * When `file_pattern` is set, the whole `path` is the directory template and
 * `file_pattern` matches the leaf file. Otherwise the last path segment is the
 * file template (e.g. `{session_id}.jsonl`) — its template vars become `*` and
 * it becomes the leaf matcher, while the preceding segments are the directory
 * template.
 */
function enumerateSessionFiles(src: NativeHistoryJsonlSource, input: NativeHistoryInput): string[] {
    const expandedRoot = expandTemplateRootForEnumeration(src.path, input);
    if (!expandedRoot) return [];

    let dirTemplate: string;
    let fileRegex: RegExp;
    if (src.file_pattern) {
        dirTemplate = templateVarsToGlob(expandedRoot);
        fileRegex = globToRegex(src.file_pattern);
    } else {
        const idx = expandedRoot.lastIndexOf('/');
        const dirPart = idx >= 0 ? expandedRoot.slice(0, idx) : '';
        const leaf = idx >= 0 ? expandedRoot.slice(idx + 1) : expandedRoot;
        dirTemplate = templateVarsToGlob(dirPart);
        fileRegex = globToRegex(templateVarsToGlob(leaf));
    }

    const dirs = expandDirGlob(dirTemplate);
    const files: string[] = [];
    for (const d of dirs) {
        for (const p of listMatchingFiles(d, fileRegex)) files.push(p);
    }
    return files;
}

/**
 * Expand the leading `~` and `${ENV}` portions of a path template WITHOUT
 * substituting per-session vars, so the caller can decide which of those become
 * enumeration wildcards. Mirrors the head of `expandPath` (tilde + env) but
 * leaves `{...}` template markers intact.
 */
function expandTemplateRootForEnumeration(template: string, input: NativeHistoryInput): string {
    if (!template) return '';
    let out = template;
    if (out.startsWith('~/') || out === '~') out = path.join(os.homedir(), out.slice(2));
    out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name, fallback) => {
        const v = input.envOverrides?.[name] ?? process.env[name];
        return v != null && v !== '' ? v : (fallback ?? '');
    });
    if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
    return out;
}

/** Turn every remaining `{var}` template marker into a `*` glob segment. */
function templateVarsToGlob(template: string): string {
    return template.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '*');
}

/**
 * Extract the session id from a resolved transcript file exactly the way the
 * reader (`executeJsonl`) does, honouring `session_id_from`. Returns '' when no
 * id can be derived so the caller can drop the file.
 */
function sessionIdForFile(src: NativeHistoryJsonlSource, filePath: string): string {
    if (src.session_id_from === 'first_record' && src.session_id_path) {
        const lines = readJsonlLines(filePath);
        if (lines.length > 0) {
            const v = jsonPathGet(lines[0], src.session_id_path);
            if (typeof v === 'string' && v) return v;
        }
        return '';
    }
    if (src.session_id_from === 'dir_uuid') {
        return dirUuid(filePath) || '';
    }
    // filename_uuid (explicit or default).
    return filenameUuid(filePath);
}

/**
 * Build one session summary from a transcript file with a MINIMAL parse: project
 * records through the same record-shape machinery the reader uses, but keep only
 * the running count plus the first and last projected message (no full-array
 * materialization). preview/sessionTitle come from the last non-tool message.
 */
function summarizeSessionFile(
    src: NativeHistoryJsonlSource,
    filePath: string,
    shapes: { pick: (record: any) => { map: NativeHistoryMessageMap } | null },
): NativeHistorySessionListItem | null {
    const historySessionId = sessionIdForFile(src, filePath);
    if (!historySessionId) return null;

    const mtime = safeMtimeMs(filePath);
    const lines = readJsonlLines(filePath);
    if (lines.length === 0) return null;

    let messageCount = 0;
    let first: NativeHistoryMessage | null = null;
    let last: NativeHistoryMessage | null = null;
    let lastNonTool: NativeHistoryMessage | null = null;
    for (let i = 0; i < lines.length; i += 1) {
        const rec = lines[i];
        const shape = shapes.pick(rec);
        if (!shape) continue;
        for (const msg of projectMessages(rec, shape.map, i, lines.length, mtime)) {
            messageCount += 1;
            if (!first) first = msg;
            last = msg;
            if (msg.kind !== 'tool') lastNonTool = msg;
        }
    }
    if (messageCount === 0 || !first || !last) return null;

    // Workspace attribution mirrors the reader: prefer an in-transcript
    // session_meta cwd, then a sidecar, then the (verified) input workspace.
    const workspace = readSessionMetaWorkspace(lines)
        ?? (src.workspace_from_sidecar ? readSidecarWorkspace(filePath, src.workspace_from_sidecar) : undefined);

    const previewMsg = lastNonTool ?? last;
    return {
        historySessionId,
        sessionTitle: previewMsg.content || undefined,
        messageCount,
        firstMessageAt: first.receivedAt || mtime,
        lastMessageAt: last.receivedAt || first.receivedAt || mtime,
        preview: previewMsg.content || undefined,
        workspace,
        sourcePath: filePath,
        sourceMtimeMs: mtime,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// JSONL
// ────────────────────────────────────────────────────────────────────────────

function executeJsonl(src: NativeHistoryJsonlSource, input: NativeHistoryInput): NativeHistoryResult | null {
    const resolution = resolveJsonlSourcePathDetailed(src, input);
    const outcome = resolution.outcome;
    if (outcome && (outcome.attribution === 'ambiguous' || outcome.attribution === 'already_claimed')) {
        // Fail closed under same-cwd concurrency: never surface a transcript —
        // or a providerSessionId that could be pinned — from an ambiguous or
        // foreign-owned resolution.
        return {
            messages: [],
            sourcePath: '',
            sourceMtimeMs: 0,
            nativeHistoryCoverage: 'full',
            attribution: outcome.attribution,
            ownerConfirmed: false,
            unavailableReason: outcome.unavailableReason || 'attribution_unknown',
        };
    }
    const sourcePath = resolution.path;
    if (!sourcePath) {
        // Was silent before — a slug miss produced 0 messages with no trace, so
        // a live read_chat returning empty was indistinguishable from "no file"
        // vs "wrong path". Log the attempted concrete path + both slug variants
        // so the failure mode is greppable in daemon logs.
        const resolved = expandPath(src.path, input);
        const requestedSessionId = readRequestedSessionId(input);
        const wsRaw = typeof input.workspace === 'string' ? input.workspace : '';
        let wsReal = wsRaw;
        try { if (wsRaw) wsReal = fs.realpathSync(wsRaw); } catch { /* keep raw */ }
        LOG.debug('NativeHistory', `jsonl unresolved: tried=${JSON.stringify(resolved)} sessionId=${requestedSessionId || '(none)'} wsRaw=${JSON.stringify(wsRaw)} wsReal=${JSON.stringify(wsReal)} rawSlug=${JSON.stringify(claudeProjectDirName(wsRaw))} realSlug=${JSON.stringify(claudeProjectDirName(wsReal))} (concrete miss + raw-slug retry + projects scan all failed)`);
        return null;
    }

    const mtime = safeMtimeMs(sourcePath);
    const lines = readJsonlLines(sourcePath);
    if (lines.length === 0) return null;
    // Prefer an in-transcript session_meta cwd; fall back to the input workspace
    // only when the spec opts in AND the resolved file lives under that
    // workspace's project slug (cursor-agent writes no session_meta and hides the
    // workspace in the lossy on-disk slug — see workspace_from_input). A store
    // whose workspace lives in a per-session sidecar json (kimi's state.json,
    // whose `wd_<slug>_<sha12>` dir is irreversible) reads it from there.
    const transcriptWorkspace = readSessionMetaWorkspace(lines)
        ?? (src.workspace_from_sidecar ? readSidecarWorkspace(sourcePath, src.workspace_from_sidecar) : undefined)
        ?? (src.workspace_from_input ? workspaceFromInputIfSlugMatches(sourcePath, input) : undefined);

    // session id: filename uuid, a parent directory uuid, or extracted from the
    // first record.
    let providerSessionId: string | undefined;
    if (src.session_id_from === 'first_record' && src.session_id_path) {
        const v = jsonPathGet(lines[0], src.session_id_path);
        if (typeof v === 'string' && v) providerSessionId = v;
    } else if (src.session_id_from === 'dir_uuid') {
        providerSessionId = dirUuid(sourcePath) || undefined;
    } else if (src.session_id_from === 'filename_uuid' || !src.session_id_from) {
        const m = path.basename(sourcePath).match(UUID_RE);
        if (m) providerSessionId = m[1];
    }

    // Compare requested vs resolved by embedded uuid so a `session_<uuid>` pin
    // (kimi's on-disk session id carries a `session_` prefix) still matches the
    // bare uuid the executor extracts from the directory segment.
    const requested = readRequestedSessionId(input) || '';
    if (requested && providerSessionId && !sameSessionUuid(providerSessionId, requested)) return null;

    // Multi-shape (records[]) vs single-shape (message_map) projection.
    const shapes = compileRecordShapes(src);
    // Usage lines are matched on a SEPARATE pass-through of the same records:
    // they are not messages, and a usage line that matched no message shape
    // would otherwise be dropped before it could be counted.
    const pickUsage = compileUsageShapes(src);
    const messages: NativeHistoryMessage[] = [];
    const usageRecords: NativeUsageRecord[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const rec = lines[i];
        if (pickUsage) {
            const usageMap = pickUsage(rec);
            if (usageMap) {
                const usageRecord = projectUsageRecord(rec, usageMap, mtime);
                if (usageRecord) usageRecords.push(usageRecord);
            }
        }
        const shape = shapes.pick(rec);
        if (!shape) continue;
        for (const msg of projectMessages(rec, shape.map, i, lines.length, mtime)) {
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
        attribution: outcome?.attribution,
        ownerConfirmed: outcome?.ownerConfirmed,
        ...(usageRecords.length > 0
            ? {
                usage: foldUsageRecords(usageRecords, {
                    providerSessionId: providerSessionId || '',
                    agent: typeof input.agentType === 'string' ? input.agentType : 'unknown',
                }),
            }
            : {}),
    };
}

/**
 * Resolve the concrete on-disk transcript file a jsonl native-history source
 * points at, applying the same slug/date/session-bound/scan fallbacks the
 * message reader uses. Returns null when no file can be located.
 *
 * Extracted so status-only readers (background-task detection) can locate the
 * live transcript without re-parsing every message on each status poll.
 */
export function resolveJsonlSourcePath(src: NativeHistoryJsonlSource, input: NativeHistoryInput): string | null {
    return resolveJsonlSourcePathDetailed(src, input).path;
}

/** The attribution outcome of a sidecar-workspace (kimi) resolution. Only set
 *  on the sidecar claim paths; every other source resolves exactly as before
 *  and carries no outcome. */
interface JsonlClaimOutcome {
    attribution: NonNullable<NativeHistoryResult['attribution']>;
    ownerConfirmed?: boolean;
    unavailableReason?: string;
}

interface JsonlSourceResolution {
    path: string | null;
    outcome?: JsonlClaimOutcome;
}

function resolveJsonlSourcePathDetailed(src: NativeHistoryJsonlSource, input: NativeHistoryInput): JsonlSourceResolution {
    const resolved = expandPath(src.path, input);
    if (!resolved) return { path: null };

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
        // dir_uuid + sidecar-workspace stores (kimi): the session id lives in a
        // parent directory segment (not the fixed leaf filename) and the
        // workspace lives in a per-session sidecar json (not the irreversible
        // `wd_<slug>_<sha12>` dir, not the transcript). The filename-uuid pickers
        // can't match here, so select by the directory uuid when pinned, else by
        // the sidecar workDir + recency when workspace-scoped.
        if (src.workspace_from_sidecar) {
            // Claim-based attribution (Stage 4): one live session binds at most
            // one transcript, one transcript is claimed by at most one live
            // session, and ambiguity fails closed — newest-mtime is never the
            // deciding fallback under same-cwd concurrency.
            return resolveSidecarClaimSource(resolved, filePat, windowMs, sessionFloor, workspaceHint, requestedSessionId, src.workspace_from_sidecar, input);
        }
        if (src.session_id_from === 'dir_uuid') {
            sourcePath = pickDirUuidFileAcrossGlob(resolved, filePat, requestedSessionId);
            if (!sourcePath && !requestedSessionId) {
                sourcePath = newestRecentFileAcrossGlob(resolved, filePat, windowMs, sessionFloor);
            }
        } else {
            sourcePath = pickExactSessionFileAcrossGlob(resolved, filePat, requestedSessionId)
                || pickSessionBoundFileAcrossGlob(resolved, filePat, windowMs, sessionFloor, workspaceHint)
                || newestRecentFileAcrossGlob(resolved, filePat, windowMs, sessionFloor);
        }
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
    return { path: sourcePath };
}

// ────────────────────────────────────────────────────────────────────────────
// Sidecar-workspace claim-based attribution (kimi)
//
// kimi exposes no reliable session id at spawn/screen, so two live ADHDev
// sessions sharing a cwd cannot be attributed by the provider at all — the
// daemon must own attribution. The rules below are the Stage-4 contract:
//
//   - EXCLUSIVE: one transcript path is claimed by at most one live session
//     (transcript-claim-registry, owner = iid:<instanceId>), and a session's
//     first claimed bind is then locked in (the read path persists a pin only
//     from an owner-confirmed bind, and every later read exact-binds on it).
//   - EVIDENCE ORDER: exact pin → claim exclusion → spawn proximity (birth
//     time within SPAWN_BIND_GRACE_MS of the session's spawn floor). Newest
//     mtime is NEVER the deciding fallback when ≥2 viable same-workspace
//     candidates remain.
//   - FAIL CLOSED: an ambiguous or foreign-owned resolution returns a typed
//     outcome (attribution 'ambiguous' / 'already_claimed', unavailableReason
//     'attribution_unknown') with no path, no messages, no providerSessionId —
//     so no durable pin can be written from ambiguity.
// ────────────────────────────────────────────────────────────────────────────

/** Canonical claim key for a transcript path: best-effort realpath so
 *  /tmp ↔ /private/tmp aliases of the same wire.jsonl share one claim. */
function claimKeyForPath(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

function failClosedResolution(attribution: 'ambiguous' | 'already_claimed', workspaceHint: string, owner: string): JsonlSourceResolution {
    LOG.info('TranscriptClaim', `decision=${attribution} provider=kimi workspace=${JSON.stringify(workspaceHint)} owner=${owner || '(none)'} → attribution_unknown (fail closed, no pin)`);
    return { path: null, outcome: { attribution, ownerConfirmed: false, unavailableReason: 'attribution_unknown' } };
}

/**
 * The single candidate whose birth time falls within ±SPAWN_BIND_GRACE_MS of
 * the session's spawn floor — the spawn-proximity evidence pick. Returns null
 * when no floor is known or the within-grace set does not hold EXACTLY ONE
 * candidate (a tie is ambiguity, not evidence). mtime is only the birth-time
 * fallback for filesystems without birthtime — never an ordering heuristic.
 *
 * Exported for tests: the selection rule is deterministic given fabricated
 * candidates, which is how the mtime-independence guarantee is pinned down
 * (real birthtimes can't be backdated in a fixture).
 */
export function pickUniqueSpawnEvidence(
    candidates: Array<{ p: string; mtime: number; birth: number }>,
    sessionFloorMs: number,
): string | null {
    if (!(sessionFloorMs > 0) || candidates.length === 0) return null;
    const within = candidates.filter(c => {
        const born = c.birth > 0 ? c.birth : c.mtime;
        return Math.abs(born - sessionFloorMs) <= SPAWN_BIND_GRACE_MS;
    });
    return within.length === 1 ? within[0].p : null;
}

/**
 * Claim-aware resolution for sidecar-workspace stores (kimi's
 * `sessions/<wdKey>/session_<uuid>/agents/main/wire.jsonl` + sibling
 * `state.json` workDir). See the contract comment above.
 */
function resolveSidecarClaimSource(
    template: string,
    pattern: RegExp,
    windowMs: number,
    sessionFloorMs: number,
    workspaceHint: string,
    requestedSessionId: string,
    sidecar: { rel_path: string; workspace_path: string },
    input: NativeHistoryInput,
): JsonlSourceResolution {
    const owner = transcriptClaimOwnerToken(input.instanceId);

    // (1) Pinned/exact bind: the strongest evidence — a previously claimed,
    //     owner-confirmed session id. Exact-bind the directory uuid and refresh
    //     the claim. A live FOREIGN claim on the pinned transcript means the
    //     pin and the registry disagree (contested store) → fail closed rather
    //     than read a sibling's transcript.
    if (requestedSessionId) {
        const pinned = pickDirUuidFileAcrossGlob(template, pattern, requestedSessionId);
        if (!pinned) return { path: null };
        if (!owner) return { path: pinned, outcome: { attribution: 'pinned' } };
        const verdict = claimTranscript(claimKeyForPath(pinned), owner);
        if (verdict === 'denied') return failClosedResolution('already_claimed', workspaceHint, owner);
        return {
            path: pinned,
            outcome: { attribution: verdict === 'stale_reclaimed' ? 'stale_reclaimed' : 'pinned', ownerConfirmed: true },
        };
    }

    // (2) No workspace hint: no scoping evidence at all — keep the legacy
    //     newest-recent single-session dev/test behaviour.
    if (!workspaceHint) {
        return { path: newestRecentFileAcrossGlob(template, pattern, windowMs, sessionFloorMs) };
    }

    // (3) Workspace-scoped discovery. Candidates: sidecar workDir matches the
    //     input workspace, inside the recency/spawn-floor window. Claims make
    //     the pick exclusive; spawn proximity disambiguates; anything else
    //     fails closed.
    const candidates = listSidecarWorkspaceCandidates(template, pattern, windowMs, sessionFloorMs, workspaceHint, sidecar);
    if (candidates.length === 0) return { path: null };

    if (!owner) {
        // Legacy identity-less resolution (no instanceId — unit tests, early
        // boot, non-session callers). A single viable candidate binds exactly
        // as before; with ≥2 candidates only UNIQUE spawn-proximity evidence
        // may decide — never newest mtime.
        if (candidates.length === 1) return { path: candidates[0].p, outcome: { attribution: 'legacy' } };
        const picked = pickUniqueSpawnEvidence(candidates, sessionFloorMs);
        if (picked) return { path: picked, outcome: { attribution: 'spawn_evidence', ownerConfirmed: true } };
        return failClosedResolution('ambiguous', workspaceHint, owner);
    }

    // Claims active: never consider a transcript a DIFFERENT live session owns.
    const unclaimed = candidates.filter(c => !isTranscriptClaimedByOther(claimKeyForPath(c.p), owner));
    if (unclaimed.length === 0) return failClosedResolution('already_claimed', workspaceHint, owner);

    // Spawn-floor guard: this session's own wire.jsonl is born at/after it
    // spawned (minus grace), so a pre-spawn store belongs to an earlier session
    // and is never bound. With no viable own store yet, return null (wait for
    // the own transcript on the next read) instead of mis-binding.
    const eligible = sessionFloorMs > 0
        ? unclaimed.filter(c => (c.birth > 0 ? c.birth : c.mtime) >= sessionFloorMs - SPAWN_BIND_GRACE_MS)
        : unclaimed;
    if (eligible.length === 0) return { path: null };

    let chosen: string | null = null;
    if (eligible.length === 1) {
        chosen = eligible[0].p;
    } else {
        // ≥2 viable candidates: only unique spawn-proximity evidence may
        // decide. A wire born within ±grace of THIS session's spawn is its own;
        // a sibling spawned seconds later falls outside the window, so each
        // session still resolves its own transcript — independent of mtime
        // ordering. A genuine tie is ambiguity → fail closed.
        chosen = pickUniqueSpawnEvidence(eligible, sessionFloorMs);
    }
    if (!chosen) return failClosedResolution('ambiguous', workspaceHint, owner);

    const verdict = claimTranscript(claimKeyForPath(chosen), owner);
    if (verdict === 'denied') return failClosedResolution('already_claimed', workspaceHint, owner);
    return {
        path: chosen,
        outcome: { attribution: verdict === 'stale_reclaimed' ? 'stale_reclaimed' : 'claimed', ownerConfirmed: true },
    };
}

/**
 * Enumerate the viable sidecar-workspace candidates across the glob: wire
 * files inside the recency/spawn-floor window whose sidecar `state.json`
 * workDir matches the input workspace. Sorted newest-mtime first ONLY as a
 * stable enumeration order — selection never uses it as the deciding
 * heuristic. Each candidate carries its birth time for the spawn-proximity
 * evidence pick.
 */
function listSidecarWorkspaceCandidates(
    template: string,
    pattern: RegExp,
    windowMs: number,
    sessionFloorMs: number,
    workspaceHint: string,
    sidecar: { rel_path: string; workspace_path: string },
): Array<{ p: string; mtime: number; birth: number }> {
    let wsResolved = workspaceHint;
    try { wsResolved = fs.realpathSync(workspaceHint); } catch { /* keep raw */ }
    const dirs = expandDirGlob(template);
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs);
    const out: Array<{ p: string; mtime: number; birth: number }> = [];
    for (const d of dirs) {
        for (const p of listMatchingFiles(d, pattern)) {
            const mtime = safeMtimeMs(p);
            if (mtime < cutoff) continue;
            const ws = readSidecarWorkspace(p, sidecar);
            if (!ws) continue;
            let wsReal = ws;
            try { wsReal = fs.realpathSync(ws); } catch { /* keep raw */ }
            if (ws !== workspaceHint && wsReal !== wsResolved) continue;
            out.push({ p, mtime, birth: safeBirthtimeMs(p) });
        }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

function readSessionMetaWorkspace(lines: any[]): string | undefined {
    for (const record of lines.slice(0, 5)) {
        if (String(record?.type ?? '') !== 'session_meta') continue;
        const cwd = typeof record?.payload?.cwd === 'string' ? record.payload.cwd.trim() : '';
        if (cwd) return cwd;
    }
    return undefined;
}

/**
 * Read the workspace from a per-session sidecar json file (kimi's state.json).
 * `rel_path` is resolved relative to the wire file's directory and the workspace
 * is pulled out via `workspace_path` (jsonpath-lite). Returns undefined on any
 * miss so the caller falls through to the next attribution strategy.
 */
function readSidecarWorkspace(
    sourcePath: string,
    cfg: { rel_path: string; workspace_path: string },
): string | undefined {
    try {
        const sidecar = path.resolve(path.dirname(sourcePath), cfg.rel_path);
        const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        const v = jsonPathGet(parsed, cfg.workspace_path);
        return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extract a uuid from the nearest ancestor DIRECTORY segment of a file path
 * (kimi's `.../session_<uuid>/agents/main/wire.jsonl`). Walks from the leaf's
 * parent upward and returns the first uuid found, or '' when none.
 */
function dirUuid(filePath: string): string {
    const segs = path.dirname(filePath).split(path.sep);
    for (let i = segs.length - 1; i >= 0; i -= 1) {
        const m = segs[i].match(UUID_RE);
        if (m) return m[1];
    }
    return '';
}

/** Compare two session ids by their embedded uuid, ignoring any prefix/suffix
 *  (kimi's `session_<uuid>` pin vs the bare `<uuid>` the executor extracts). */
function sameSessionUuid(a: string, b: string): boolean {
    if (a === b) return true;
    const ua = a.match(UUID_RE)?.[1]?.toLowerCase();
    const ub = b.match(UUID_RE)?.[1]?.toLowerCase();
    return !!ua && !!ub && ua === ub;
}

/**
 * Resolve the projection strategy for a jsonl source. Multi-shape (`records[]`)
 * picks the first entry whose `where` matches a record; single-shape falls back
 * to the top-level `message_map` gated by the optional `message_filter`.
 */
function compileRecordShapes(src: NativeHistoryJsonlSource): {
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
function compileUsageShapes(src: NativeHistoryJsonlSource): ((record: any) => NativeHistoryUsageMap | null) | null {
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
function projectUsageRecord(
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
function workspaceFromInputIfSlugMatches(sourcePath: string, input: NativeHistoryInput): string | undefined {
    const wsRaw = typeof input.workspace === 'string' ? input.workspace.trim() : '';
    if (!wsRaw) return undefined;
    let wsReal = wsRaw;
    try { wsReal = fs.realpathSync(wsRaw); } catch { /* keep raw */ }
    const slugs = new Set<string>();
    for (const w of [wsReal, wsRaw]) {
        if (!w) continue;
        slugs.add(claudeProjectDirName(w));            // "-Users-…" (leading dash)
        slugs.add(claudeProjectDirName(w.replace(/^\/+/, ''))); // cursor form, no leading dash
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
        const requested = input.providerSessionId || '';
        // Resolve the session id the message query runs against. The `requested`
        // pin path is tried first, but a pinned id that has NO rows in the store
        // is not a real session — fall back to the newest-session `session_query`
        // instead of returning empty. This is the hermes read_chat gap: hermes
        // never surfaces its own provider session id to the daemon (the spec
        // declares no session-id extraction and the adapter's screen-scrape is
        // codex-only), so the read pipeline falls back to threading the mesh
        // RUNTIME session id through as `providerSessionId`. That runtime id does
        // not exist in ~/.hermes/state.db, so the old unconditional pin path ran
        // `message_query WHERE session_id = '<runtime id>'` → 0 rows → null, and
        // the answer (physically present under the real cli session) was never
        // returned. Validating the pin by the spec's own `message_query` keeps
        // this schema-agnostic and only rescues the mis-bound-id case: a genuine
        // discovered pin (codex/claude use jsonl sources and never reach here;
        // any real sqlite pin has rows) still short-circuits on its own rows.
        // Expand an anchor session id to every session id in its logical
        // cluster. When the spec declares `session_cluster_query` the anchor is
        // run through it (bound `?`) and each returned row's FIRST column is a
        // cluster member id — typically a WITH RECURSIVE walk up to the cluster
        // root and back down through all descendants, so passing a root, middle,
        // or leaf anchor all resolve the same complete set. The anchor is always
        // included even if the query omits it (defensive) so a spec with no
        // cluster query, or a query that returns nothing, still reads the anchor
        // itself. Absent query → just the anchor (single-session behaviour).
        const resolveClusterIds = (anchorId: string): string[] => {
            const ids = new Set<string>();
            if (anchorId) ids.add(anchorId);
            if (src.session_cluster_query && anchorId) {
                try {
                    const rows: any[] = db.prepare(src.session_cluster_query).all(anchorId);
                    for (const row of rows) {
                        const idRaw = Object.values(row)[0];
                        if (idRaw != null && String(idRaw)) ids.add(String(idRaw));
                    }
                } catch { /* fall back to anchor-only on a malformed cluster query */ }
            }
            return Array.from(ids);
        };

        // Read messages for an anchor's WHOLE cluster, merged and re-sorted by
        // their mapped timestamp so bubbles from different sub-sessions interleave
        // in true chronological order (the turn's final assistant — written into a
        // descendant sub-session in the split-turn case — lands last). No per-session
        // short-circuit: an anchor whose OWN row has zero messages (hermes writes a
        // 0-message intermediate `sessions` row) still yields the cluster's rows,
        // and the whole cluster is scanned rather than stopping at the first
        // non-empty session. Returns null only when the ENTIRE cluster is empty,
        // preserving the pin-validation contract below (a pin that resolves no rows
        // anywhere is a mis-bound id and falls through to newest-session recovery).
        const resolveMessagesFor = (anchorId: string): any[] | null => {
            if (!anchorId) return null;
            const clusterIds = resolveClusterIds(anchorId);
            const merged: any[] = [];
            for (const id of clusterIds) {
                let rows: any[];
                try { rows = db.prepare(src.message_query).all(id); }
                catch { continue; }
                if (rows && rows.length > 0) merged.push(...rows);
            }
            if (merged.length === 0) return null;
            if (clusterIds.length > 1) sortRowsByMappedTimestamp(merged, src.message_map);
            return merged;
        };

        const resolveNewestSessionId = (): string => {
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
                // Workspace the daemon spawned this CLI in. A store that keeps
                // the session directory as a column (opencode's
                // `session.directory`) can scope the newest-session pick to this
                // workspace so two concurrent sessions in different workspaces
                // don't cross-bind — the time floor alone can't disambiguate
                // when the OTHER workspace's session was touched more recently.
                const workspaceHint = typeof input.workspace === 'string' ? input.workspace : '';
                const stmt = db.prepare(src.session_query);
                // Binding tiers, tried in order (better-sqlite3 throws when the
                // statement declares params the bind object/args don't satisfy,
                // so each tier is guarded):
                //   1. named { floor, workspace } — spec references @floor/@workspace
                //   2. positional (floor) — legacy single-`?` floor specs
                //   3. no-arg — specs with no bound params
                try {
                    sessionRow = stmt.get({ floor: sessionFloorSeconds, workspace: workspaceHint });
                } catch {
                    try {
                        sessionRow = stmt.get(sessionFloorSeconds);
                    } catch {
                        sessionRow = stmt.get();
                    }
                }
            } catch { return ''; }
            if (!sessionRow) return '';
            // First column of the first row is the session id.
            const sessionIdRaw = Object.values(sessionRow)[0];
            return sessionIdRaw == null ? '' : String(sessionIdRaw);
        };

        let sessionId: string;
        let messageRows: any[] | null;
        if (requested) {
            // Pin path: read the requested session directly and skip the
            // newest-wins `session_query`. hermes ≥0.14 spawns a fresh
            // `sessions` row per internal sub-session, so an unpinned
            // `ORDER BY started_at DESC LIMIT 1` pick drifts to a different id
            // on every read (re-bind churn + reading completion evidence from
            // the wrong session). A pin that resolves rows is authoritative.
            messageRows = resolveMessagesFor(requested);
            if (messageRows) {
                sessionId = requested;
            } else {
                // The pinned id has no rows — it is not a real session in this
                // store (the mis-bound mesh runtime-id case). Recover by letting
                // the spec's own newest-session query self-resolve instead of
                // returning empty.
                sessionId = resolveNewestSessionId();
                messageRows = resolveMessagesFor(sessionId);
            }
        } else {
            sessionId = resolveNewestSessionId();
            messageRows = resolveMessagesFor(sessionId);
        }
        if (!sessionId) return null;
        if (!messageRows || messageRows.length === 0) return null;

        const mtime = safeMtimeMs(resolved);
        const messages: NativeHistoryMessage[] = [];
        for (let i = 0; i < messageRows.length; i += 1) {
            for (const msg of projectMessages(messageRows[i], src.message_map, i, messageRows.length, mtime)) {
                messages.push(msg);
            }
        }
        if (messages.length === 0) return null;

        // Surface the workspace at the result level too (mirrors the jsonl
        // session_meta path) so callers that read result.workspace — not just
        // per-message workspace — see the session directory.
        const resultWorkspace = messages.find(m => m.workspace)?.workspace;

        return {
            messages,
            providerSessionId: sessionId,
            sourcePath: resolved,
            sourceMtimeMs: mtime,
            nativeHistoryCoverage: 'full',
            ...(resultWorkspace ? { workspace: resultWorkspace } : {}),
        };
    } finally {
        try { db.close(); } catch { /* ignore */ }
    }
}

/**
 * Stable-sort merged cluster rows by their mapped timestamp so bubbles read
 * from different sub-sessions interleave in true chronological order. Uses the
 * same `message_map.timestamp_ms` jsonpath + `parseTimestamp` heuristic the
 * projection uses, so the sort key agrees with the receivedAt each row will be
 * given. Rows with no resolvable timestamp keep their pre-sort relative order
 * (stable), and equal timestamps preserve insertion order — both matter because
 * a turn's terminal bubbles can share a sub-second timestamp.
 */
function sortRowsByMappedTimestamp(rows: any[], map: NativeHistoryMessageMap): void {
    if (!map.timestamp_ms) return;
    const keyed = rows.map((row, index) => {
        const parsed = parseTimestamp(jsonPathGet(row, map.timestamp_ms as string));
        return { row, index, ts: parsed == null ? Number.NaN : parsed };
    });
    keyed.sort((a, b) => {
        const aHas = !Number.isNaN(a.ts);
        const bHas = !Number.isNaN(b.ts);
        if (aHas && bHas && a.ts !== b.ts) return a.ts - b.ts;
        // Missing-timestamp rows and ties fall back to original insertion order
        // so the sort stays stable.
        return a.index - b.index;
    });
    for (let i = 0; i < keyed.length; i += 1) rows[i] = keyed[i].row;
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

/**
 * File creation time in ms, for the spawn-proximity evidence pick: a kimi
 * wire.jsonl is created by the CLI child strictly AFTER the daemon spawned it,
 * so birthtime > the session's spawn floor for its own transcript. Falls back
 * to mtime when birthtime is unavailable (0 / not tracked) so the caller still
 * has a usable ordering key.
 */
function safeBirthtimeMs(p: string): number {
    try {
        const st = fs.statSync(p);
        const birth = Math.floor(st.birthtimeMs);
        return birth > 0 ? birth : Math.floor(st.mtimeMs);
    } catch { return 0; }
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

/**
 * dir_uuid exact pick across a glob: the requested session uuid is embedded in a
 * parent DIRECTORY segment (kimi's `session_<uuid>/…/wire.jsonl`), not the leaf
 * filename. Match the file whose ancestor path carries the requested uuid.
 */
function pickDirUuidFileAcrossGlob(template: string, pattern: RegExp, requestedSessionId: string): string | null {
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

    // Per-message workspace: sqlite sources have no `session_meta` record to
    // carry the cwd (jsonl-only), so a spec can SELECT the session directory
    // into each row and map it here. The downstream hasSafeNativeHistoryMapping
    // guard needs it to accept a workspace-scoped read (no provider session id
    // captured from the TUI); without it every assistant bubble is dropped.
    const workspaceRaw = map.workspace ? jsonPathGet(record, map.workspace) : undefined;
    const workspace = typeof workspaceRaw === 'string' && workspaceRaw.trim() ? workspaceRaw.trim() : undefined;

    const contentRaw = jsonPathGet(record, map.content);
    const content = cleanContent(stringifyContent(contentRaw), map);
    if (content) out.push(workspace ? { role, content, receivedAt, kind, workspace } : { role, content, receivedAt, kind });

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
