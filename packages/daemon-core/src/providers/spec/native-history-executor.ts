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
import * as path from 'node:path';
import { LOG } from '../../logging/logger.js';
import { SPAWN_BIND_GRACE_MS } from '../native-history/constants.js';
import { foldUsageRecords, type NativeUsageRecord } from '../../shared/usage-normalize.js';
import {
    claimTranscript, isTranscriptClaimedByOther, transcriptClaimOwnerToken,
} from '../native-history/transcript-claim-registry.js';
import type { NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';
import type { NativeHistoryConfig, NativeHistoryJsonlSource, NativeHistoryMessageMap } from './types.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import type { NativeHistoryInput, NativeHistoryMessage, NativeHistoryResult } from './native-history-types.js';
import {
    splitTemplateDirLeaf, expandTemplateRootForEnumeration, templateVarsToGlob, dirUuid,
    sameSessionUuid, workspaceFromInputIfSlugMatches, expandPath, claudeProjectDirName,
    scanProjectsRootForSessionFile, globToRegex, expandDirGlob, newestRecentFileAcrossGlob,
    hasDateTemplateSegment, newestRecentFileAcrossDateWindow, newestRecentFile, safeMtimeMs,
    safeBirthtimeMs, readRequestedSessionId, filenameUuid, pickExactSessionFile,
    pickExactSessionFileAcrossGlob, pickDirUuidFileAcrossGlob, pickExactSessionFileAcrossDateWindow,
    listMatchingFiles, pickSessionBoundFile, pickSessionBoundFileAcrossGlob,
    pickSessionBoundFileAcrossDateWindow, UUID_RE, recentFiles, recentFilesAcrossGlob,
} from './native-history-paths.js';
import { containsSentPrompt, sentPromptSnippets } from '../native-history/sent-prompt-registry.js';
import { executeSqlite } from './native-history-sqlite.js';
import {
    compileRecordShapes, compileUsageShapes, projectUsageRecord, projectMessages,
    parseTimestamp,
} from './native-history-projection.js';
import { jsonPathGet } from './native-history-jsonpath.js';

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
        const { dirPart, leaf } = splitTemplateDirLeaf(expandedRoot);
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
    // Completion evidence explicitly requests forceRefresh: it never trusts a
    // reusable parse, even when the filesystem reports coarse or unchanged
    // timestamps.
    //
    // What keeps the resulting full re-parse affordable is NOT a throttle on this
    // path — there is none, despite what this comment used to claim. It is the
    // caller's own cadence: the single forceRefresh caller is
    // readExternalCompletionMessages (providers/completion/evidence.ts), reached
    // via probeNativeTranscriptSignals / hasFreshNativeFinalAssistantForCurrentTurn,
    // which by construction run only at the stall threshold (≥180s of PTY stasis)
    // or during an armed completion-debounce retry — never on the routine 5s tick.
    // If a future caller starts requesting forceRefresh at PTY frequency, that
    // cadence assumption is what breaks, and this becomes a full re-parse per
    // chunk. Relaxing forceRefresh to bypass only the memo (keeping the
    // size/mtime resume path, which re-stats and reads actual bytes so it is not
    // stale) is the known fix if that day comes.
    const forceRefresh = input.forceRefresh === true || input.args?.forceRefresh === true;
    const lines = readJsonlLines(sourcePath, forceRefresh);
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
        for (const msg of projectMessages(rec, shape.map, i, lines.length, mtime, providerSessionId || requested || sourcePath)) {
            if (transcriptWorkspace) msg.workspace = transcriptWorkspace;
            messages.push(msg);
        }
    }
    if (messages.length === 0) return null;

    const turnTerminalMarkers = extractBuiltinTurnTerminalMarkers(input.agentType, lines);

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
        ...(turnTerminalMarkers.length > 0 ? { turnTerminalMarkers } : {}),
    };
}

/**
 * (NATIVE-TURN-SIGNAL) Extract the provider's own turn-terminal records for
 * agentTypes this declarative jsonl executor has a BUILT-IN signal for.
 *
 * A v1 SDK provider (spec.json's `native_history.source`, the shape this
 * executor reads) has no `completionSignal` declaration surface at all —
 * unlike the legacy TypeScript-reader path (native-turn-signal.ts /
 * codex-cli-transcript.ts), which only activates for a provider whose
 * `provider.v1.json` sets `nativeHistory.scripts.readSession` to the daemon
 * dispatcher. codex-cli ships as a v1 SDK provider (specs/4.0.json) driven by
 * SpecCliAdapter, which reads through THIS executor, not that dispatcher — so
 * the dispatcher-side fix never took effect for it. Mirrors
 * codex-cli-transcript.ts's CODEX_DEFAULT_COMPLETION_SIGNAL default (same
 * reasoning: editing the published spec.json would drift the channel
 * bundleDigest and require a provider version bump, a release action, not a
 * code change) rather than duplicating a `completionSignal` concept into the
 * v1 spec schema.
 */
function extractBuiltinTurnTerminalMarkers(agentType: string | undefined, lines: any[]): NativeTurnTerminalMarker[] {
    if (agentType === 'kimi') return extractKimiTurnTerminalMarkers(lines);
    if (agentType !== 'codex-cli') return [];
    const markers: NativeTurnTerminalMarker[] = [];
    for (const rec of lines) {
        if (String(rec?.type ?? '') !== 'event_msg') continue;
        const payload = rec?.payload;
        if (!payload || typeof payload !== 'object') continue;
        const payloadType = String(payload.type ?? '').trim();
        const isComplete = payloadType === 'task_complete';
        const isAbort = payloadType === 'turn_aborted';
        if (!isComplete && !isAbort) continue;
        const receivedAt = parseTimestamp(rec?.timestamp) ?? Date.now();
        const summary = flattenJsonlText(payload.last_agent_message);
        const rawTurnId = payload.turn_id;
        const turnId = typeof rawTurnId === 'string' && rawTurnId.trim() ? rawTurnId.trim() : '';
        markers.push({
            receivedAt,
            outcome: isAbort ? 'aborted' : 'completed',
            summary,
            ...(turnId ? { turnId } : {}),
        });
    }
    return markers;
}

/**
 * kimi wire.jsonl turn-terminal records. Every turn ends with exactly one
 * `{"type":"turn.ended","turnId":<n>,"reason":"completed"|"cancelled",
 * "durationMs":<n>,"time":<epoch ms>}` record (a user cancel also writes a
 * separate turn.cancel first, but turn.ended is always the terminal one).
 * The record carries no final text, so summary stays empty and the existing
 * summary-provenance chain keeps reconstructing it from assistant messages —
 * the marker's job here is only to prove THIS turn ended (turn-scoped by
 * selectTurnTerminalMarker via turnStartedAt).
 */
function extractKimiTurnTerminalMarkers(lines: any[]): NativeTurnTerminalMarker[] {
    const markers: NativeTurnTerminalMarker[] = [];
    for (const rec of lines) {
        if (String(rec?.type ?? '') !== 'turn.ended') continue;
        const receivedAt = parseTimestamp(rec?.time) ?? Date.now();
        const reason = String(rec?.reason ?? '').trim();
        const rawTurnId = rec?.turnId;
        const turnId = typeof rawTurnId === 'number' && Number.isFinite(rawTurnId)
            ? String(rawTurnId)
            : typeof rawTurnId === 'string' && rawTurnId.trim() ? rawTurnId.trim() : '';
        markers.push({
            receivedAt,
            outcome: reason === 'cancelled' ? 'aborted' : 'completed',
            summary: '',
            ...(turnId ? { turnId } : {}),
        });
    }
    return markers;
}

/** Flatten a codex jsonl text-bearing field (string, array, or {text}-shaped
 *  object) into plain text — same coercions codex-cli-transcript.ts applies. */
function flattenJsonlText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(flattenJsonlText).filter(Boolean).join('\n').trim();
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text.trim();
        if (typeof obj.content === 'string' || Array.isArray(obj.content)) return flattenJsonlText(obj.content);
    }
    return '';
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
            const exact = pickExactSessionFileAcrossGlob(resolved, filePat, requestedSessionId);
            if (exact) claimOwnTranscript(exact, input);
            sourcePath = exact || pickSessionBoundFileAcrossGlob(resolved, filePat, windowMs, sessionFloor, workspaceHint);
            if (!sourcePath) {
                return pickRecentByPromptEvidence(recentFilesAcrossGlob(resolved, filePat, windowMs, sessionFloor), input);
            }
        }
    } else {
        let stat: fs.Stats | null = null;
        try { stat = fs.statSync(resolved); } catch { /* fall through to date-walk fallback */ }
        if (stat && stat.isFile()) {
            sourcePath = resolved;
        } else if (stat && stat.isDirectory()) {
            const exact = pickExactSessionFile(resolved, filePat, requestedSessionId);
            if (exact) claimOwnTranscript(exact, input);
            sourcePath = exact
                || (requestedSessionId ? null : pickSessionBoundFile(resolved, filePat, windowMs, sessionFloor, workspaceHint));
            if (!sourcePath && !requestedSessionId) {
                const pick = pickRecentByPromptEvidence(recentFiles(resolved, filePat, windowMs, sessionFloor), input);
                if (pick.path) return pick;
            }
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
            sourcePath = scanProjectsRootForSessionFile(src.path, requestedSessionId);
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

/** Largest transcript scanned whole for prompt evidence; bigger files are
 *  scanned head+tail (a session's prompts sit at its start and its end). */
const PROMPT_EVIDENCE_SCAN_BYTES = 4 * 1024 * 1024;

function readForPromptEvidence(p: string): string {
    try {
        const size = fs.statSync(p).size;
        if (size <= PROMPT_EVIDENCE_SCAN_BYTES * 2) return fs.readFileSync(p, 'utf8');
        const fd = fs.openSync(p, 'r');
        try {
            const head = Buffer.alloc(PROMPT_EVIDENCE_SCAN_BYTES);
            const tail = Buffer.alloc(PROMPT_EVIDENCE_SCAN_BYTES);
            fs.readSync(fd, head, 0, head.length, 0);
            fs.readSync(fd, tail, 0, tail.length, size - tail.length);
            return head.toString('utf8') + '\n' + tail.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }
}

/** Refresh this session's claim on the transcript it is exact-bound to, so a
 *  same-workspace sibling's recency pick never lands on it. A denial is
 *  ignored — an exact id bind stays authoritative for its own reader. */
function claimOwnTranscript(p: string, input: NativeHistoryInput): void {
    const owner = transcriptClaimOwnerToken(input.instanceId);
    if (owner) claimTranscript(claimKeyForPath(p), owner);
}

/**
 * Recency pick for stores that expose no session id up front (cursor's
 * agent-transcripts, and any jsonl source without session_meta), made safe for
 * two live sessions in one workspace: newest-mtime alone bound both to the same
 * conversation (2026-10-05 provider matrix).
 *
 *   - a transcript another live session claimed is never picked;
 *   - when this session has sent prompts, only a transcript containing one of
 *     them is its own — that pick is claimed and owner-confirmed (pinnable);
 *     none matching fails closed (no path) rather than borrowing a sibling's;
 *   - with no recorded prompts (attached/restored session) the newest unclaimed
 *     transcript is returned unconfirmed, as before.
 */
function pickRecentByPromptEvidence(candidates: string[], input: NativeHistoryInput): JsonlSourceResolution {
    const owner = transcriptClaimOwnerToken(input.instanceId);
    if (!owner) return { path: candidates[0] ?? null };
    const unclaimed = candidates.filter(p => !isTranscriptClaimedByOther(claimKeyForPath(p), owner));
    const snippets = sentPromptSnippets(input.instanceId);
    if (snippets.length === 0) return { path: unclaimed[0] ?? null };
    const own = unclaimed.find(p => containsSentPrompt(readForPromptEvidence(p), snippets));
    if (!own) {
        if (unclaimed.length > 0) LOG.debug('TranscriptClaim', `decision=no_prompt_evidence provider=${input.agentType || '?'} owner=${owner} candidates=${unclaimed.length} → unresolved (no borrowed transcript)`);
        return { path: null };
    }
    const verdict = claimTranscript(claimKeyForPath(own), owner);
    if (verdict === 'denied') return { path: null };
    return { path: own, outcome: { attribution: 'claimed', ownerConfirmed: true } };
}

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

    // Content evidence first: the wire containing a prompt THIS session sent
    // is its own. It also stops a lone candidate from being taken when it is a
    // sibling's whose own reader has not claimed it yet (the first reader used
    // to bind whatever single wire existed). No prompts recorded (attached /
    // restored session) → the spawn-evidence rules below, unchanged.
    const snippets = sentPromptSnippets(input.instanceId);
    let chosen: string | null = null;
    if (snippets.length > 0) {
        const withPrompt = eligible.filter(c => containsSentPrompt(readForPromptEvidence(c.p), snippets));
        if (withPrompt.length === 1) chosen = withPrompt[0].p;
        else if (withPrompt.length === 0) return { path: null };
    }
    if (!chosen && eligible.length === 1) {
        chosen = eligible[0].p;
    } else if (!chosen) {
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
