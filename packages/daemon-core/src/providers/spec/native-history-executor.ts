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

import { nativeSourceAddress } from '../../chat/message-source-address.js';
import { createCodexTurnProvenance } from '../native-history/codex-turn-provenance.js';
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
import { readJsonlLines, readProjectedJsonlRecords, projectedJsonlSnapshotState } from './native-history-jsonl-cache.js';
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
    readCandidateSessionMeta, recentFilesAcrossDateWindow, claimKeyForPath,
    collectSidecarSourceEvidenceAsync, refreshSidecarPromptEvidenceAsync, sourceRevisionAsync, type SidecarSourceEvidence, type SidecarSourceCandidate,
} from './native-history-paths.js';
export { claimKeyForPath } from './native-history-paths.js';
import {
    containsSentPrompt, hasExclusiveSentInput, hasRecordedSentInput, sentPromptSnippets,
} from '../native-history/sent-prompt-registry.js';
import { executeSqlite } from './native-history-sqlite.js';
import {
    compileRecordShapes, compileUsageShapes, projectUsageRecord, projectMessages,
    parseTimestamp,
} from './native-history-projection.js';
import { markNativeHistorySnapshot } from './native-history-snapshot.js';
import { jsonPathGet } from './native-history-jsonpath.js';

export function executeNativeHistory(cfg: NativeHistoryConfig, input: NativeHistoryInput): NativeHistoryResult | null {
    if (!cfg?.source) return null;
    if (cfg.source.kind === 'jsonl') {
        const work = executeJsonl(cfg.source, input);
        let step = work.next();
        while (!step.done) step = work.next();
        return step.value;
    }
    if (cfg.source.kind === 'sqlite') return executeSqlite(cfg.source, input);
    return null;
}

// Serialize cooperative rebuilds globally; continue the work already started
// by a sync sampler instead of discarding and replaying its first chunk.
let jsonlWorkQueue: Promise<unknown> = Promise.resolve();
// All provider readers share the allowance for this event-loop turn. Charge
// actual generator time, so twenty cold sessions cannot each spend 8ms before
// timers/IPC run. The next check phase replenishes the bucket once.
const JSONL_TURN_BUDGET_MS = 8;
let jsonlTurnRemainingMs = JSONL_TURN_BUDGET_MS;
let jsonlBudgetReset: NodeJS.Immediate | undefined;
const startedJsonlWork = new WeakSet<Generator<void, NativeHistoryResult | null, void>>();
function advanceJsonlWork(work: Generator<void, NativeHistoryResult | null, void>): IteratorResult<void, NativeHistoryResult | null> | undefined {
    // A new generator can check the stat/projection cache before spending the
    // parsing allowance. Cache misses yield before doing work if it is empty.
    if (jsonlTurnRemainingMs <= 0 && startedJsonlWork.has(work)) return undefined;
    startedJsonlWork.add(work);
    if (!jsonlBudgetReset) jsonlBudgetReset = setImmediate(() => {
        jsonlTurnRemainingMs = JSONL_TURN_BUDGET_MS;
        jsonlBudgetReset = undefined;
    });
    const start = performance.now();
    try { return work.next(); }
    finally { jsonlTurnRemainingMs -= Math.max(0, performance.now() - start); }
}
function enqueueJsonlWork(work: Generator<void, NativeHistoryResult | null, void>): Promise<NativeHistoryResult | null> {
    const run = async () => {
        let step: IteratorResult<void, NativeHistoryResult | null> | undefined;
        do {
            await new Promise<void>(resolve => setImmediate(resolve));
            step = advanceJsonlWork(work);
        } while (!step?.done);
        return step.value;
    };
    const result = jsonlWorkQueue.then(run, run);
    jsonlWorkQueue = result.catch(() => {});
    return result;
}
export function executeNativeHistoryAsync(cfg: NativeHistoryConfig, input: NativeHistoryInput): Promise<NativeHistoryResult | null> {
    if (cfg?.source?.kind !== 'jsonl') return Promise.resolve(executeNativeHistory(cfg, input));
    return enqueueJsonlWork(executeJsonl(cfg.source, input, undefined, true));
}

/** Small cold reads and bounded appends finish in the sampling tick. Larger
 * rebuilds run cooperatively and keep serving the last good source snapshot. */
export function createCooperativeNativeHistoryReader(cfg: NativeHistoryConfig) {
    const pending = new Map<string, Promise<NativeHistoryResult | null>>();
    const snapshots = new Map<string, { result: NativeHistoryResult; touchedAt: number }>();
    const loading: NativeHistoryResult = { messages: [], sourcePath: '', sourceMtimeMs: 0, unavailableReason: 'native_history_loading' };
    const sourceFor = (input: NativeHistoryInput) => cfg.source?.kind === 'jsonl'
        ? resolveJsonlSourcePathDetailed(cfg.source, input) : undefined;
    // Resolve under EACH caller's attribution rules before sharing source work.
    // Paging, forceRefresh, adapter status and completion flags aren't identity.
    const keyFor = (input: NativeHistoryInput, resolution = sourceFor(input)) =>
        resolution?.path ? JSON.stringify([input.agentType, claimKeyForPath(resolution.path)]) : undefined;
    const boundResult = (input: NativeHistoryInput, result: NativeHistoryResult | null) => {
        const requested = readRequestedSessionId(input);
        return requested && result?.providerSessionId && !sameSessionUuid(requested, result.providerSessionId) ? null : result;
    };
    const reader = (input: NativeHistoryInput): NativeHistoryResult | null => {
        if (cfg?.source?.kind !== 'jsonl') return executeNativeHistory(cfg, input);
        const resolution = sourceFor(input)!;
        const key = keyFor(input, resolution);
        if (!key) return executeNativeHistory(cfg, input);
        const now = Date.now();
        for (const [k, snapshot] of snapshots) {
            if (now - snapshot.touchedAt > 10 * 60_000) snapshots.delete(k);
        }
        const previous = snapshots.get(key);
        if (previous) previous.touchedAt = now;
        const stale = () => boundResult(input, previous ? { ...previous.result, stale: true } : loading);
        if (pending.has(key)) return stale();
        const work = executeJsonl(cfg.source, input, resolution, true);
        let step = advanceJsonlWork(work);
        // Both small cold reads and resumed appends may cross a chunk boundary.
        // Let budgeted work (including old timestamp/tool seals) finish now.
        while (step && !step.done && jsonlTurnRemainingMs > 0) step = advanceJsonlWork(work);
        if (step?.done) {
            if (step.value) snapshots.set(key, { result: step.value, touchedAt: now });
            else snapshots.delete(key);
            return step.value;
        }
        const result = enqueueJsonlWork(work).then(value => {
            if (value) snapshots.set(key, { result: value, touchedAt: Date.now() });
            else snapshots.delete(key);
            return value;
        });
        pending.set(key, result);
        void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => {});
        return stale();
    };
    reader.readAsync = async (input: NativeHistoryInput) => {
        const result = reader(input);
        const key = keyFor(input);
        return boundResult(input, await ((key && pending.get(key)) || result));
    };
    return reader;
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

interface CompactJsonlRecord {
    messages: NativeHistoryMessage[];
    fallbackTime: boolean;
    usage?: NativeUsageRecord | null;
    fallbackUsageTime: boolean;
    sessionId?: unknown;
    workspace?: string;
    terminal?: any;
    sourceAddresses?: { lineage: string; values: NativeHistoryMessage['_src'][] };
}
interface JsonlProjection {
    messages: NativeHistoryMessage[];
    usage?: NativeHistoryResult['usage'];
    turnTerminalMarkers: NativeTurnTerminalMarker[];
}
const jsonlProjections = new WeakMap<CompactJsonlRecord[], Map<string, JsonlProjection>>();

function* executeJsonl(src: NativeHistoryJsonlSource, input: NativeHistoryInput, resolution = resolveJsonlSourcePathDetailed(src, input), cooperative = false): Generator<void, NativeHistoryResult | null, void> {
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

    const shapes = compileRecordShapes(src);
    const pickUsage = compileUsageShapes(src);
    const requested = readRequestedSessionId(input) || '';
    // Parse/project each new record once. Store summaries instead of raw tool
    // payloads, independently of the 16 MiB raw-object cache. A fresh stat is
    // always performed, including forceRefresh completion probes.
    const projectionKey = JSON.stringify([src, input.agentType]);
    const lines: CompactJsonlRecord[] = yield* readProjectedJsonlRecords(sourcePath, projectionKey, (rec, i) => {
        const shape = shapes.pick(rec);
        const usageMap = pickUsage?.(rec);
        const messages = shape ? projectMessages(rec, shape.map, i, i + 1, 1, '__projection__') : [];
        let terminal: any;
        if (input.agentType === 'codex-cli' && rec?.type === 'event_msg') {
            const payload = rec?.payload;
            terminal = { type: rec.type, timestamp: rec.timestamp, payload: payload && {
                type: payload.type, turn_id: payload.turn_id,
                message: typeof payload.message === 'string' ? payload.message : undefined,
                error: payload.error && typeof payload.error === 'object' ? { type: payload.error.type } : payload.error,
                last_agent_message: flattenJsonlText(payload.last_agent_message),
            } };
        } else if (input.agentType === 'kimi' && rec?.type === 'turn.ended') {
            terminal = { type: rec.type, time: rec.time, reason: rec.reason, turnId: rec.turnId };
        }
        return {
            messages,
            fallbackTime: !!shape && (!shape.map.timestamp_ms || parseTimestamp(jsonPathGet(rec, shape.map.timestamp_ms)) == null),
            usage: usageMap ? projectUsageRecord(rec, usageMap, 0) : undefined,
            fallbackUsageTime: !!usageMap && (!usageMap.timestamp_ms || parseTimestamp(jsonPathGet(rec, usageMap.timestamp_ms)) == null),
            sessionId: i === 0 && src.session_id_path ? jsonPathGet(rec, src.session_id_path) : undefined,
            workspace: i < 5 ? readSessionMetaWorkspace([rec]) : undefined,
            terminal,
        };
    }, cooperative ? () => jsonlTurnRemainingMs > 0 : undefined);
    if (lines.length === 0) return null;
    // Seal with the revision actually read. Appends during message assembly
    // may leave a usable prefix; rewrites must restart through the digest gate.
    let revision = projectedJsonlSnapshotState(sourcePath, projectionKey, lines);
    if (!revision) return yield* executeJsonl(src, input, resolution, cooperative);
    const mtime = revision.sourceMtimeMs;
    // Prefer an in-transcript session_meta cwd; fall back to the input workspace
    // only when the spec opts in AND the resolved file lives under that
    // workspace's project slug (cursor-agent writes no session_meta and hides the
    // workspace in the lossy on-disk slug — see workspace_from_input). A store
    // whose workspace lives in a per-session sidecar json (kimi's state.json,
    // whose `wd_<slug>_<sha12>` dir is irreversible) reads it from there.
    const transcriptWorkspace = lines.slice(0, 5).find(record => record.workspace)?.workspace
        ?? (src.workspace_from_sidecar ? readSidecarWorkspace(sourcePath, src.workspace_from_sidecar) : undefined)
        ?? (src.workspace_from_input ? workspaceFromInputIfSlugMatches(sourcePath, input) : undefined);

    // session id: filename uuid, a parent directory uuid, or extracted from the
    // first record.
    let providerSessionId: string | undefined;
    if (src.session_id_from === 'first_record' && src.session_id_path) {
        const v = lines[0].sessionId;
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
    if (requested && providerSessionId && !sameSessionUuid(providerSessionId, requested)) return null;

    const projectionContext = JSON.stringify([mtime, transcriptWorkspace, providerSessionId || requested || sourcePath]);
    let byContext = jsonlProjections.get(lines);
    let projection = byContext?.get(projectionContext);
    if (!projection) {
        if (cooperative && jsonlTurnRemainingMs <= 0) yield;
        const messages: NativeHistoryMessage[] = [];
        const usageRecords: NativeUsageRecord[] = [];
        const lineage = providerSessionId || requested || sourcePath;
        let sliceStartedAt = performance.now();
        for (let i = 0; i < lines.length; i++) {
            const rec = lines[i];
            if (rec.usage) usageRecords.push(rec.fallbackUsageTime ? { ...rec.usage, receivedAt: mtime } : rec.usage);
            // Committed records survive appends; hash their lineage once.
            if (rec.sourceAddresses?.lineage !== lineage) {
                rec.sourceAddresses = { lineage, values: rec.messages.map(original => original._src?.cls === 'n'
                    ? nativeSourceAddress(lineage, original._src.addr) : original._src) };
            }
            for (const [messageIndex, original] of rec.messages.entries()) {
                const msg = { ...original };
                if (rec.fallbackTime) msg.receivedAt += mtime - ((lines.length - 1 - i) * 1000) - 1;
                if (msg.toolBlockRef) {
                    if (mtime > 0) msg.toolBlockRef = { ...msg.toolBlockRef, sourceMtimeMs: mtime };
                    else delete msg.toolBlockRef;
                }
                // Stamp the same source lineage as the original full projection.
                if (original._src?.cls === 'n') msg._src = rec.sourceAddresses.values[messageIndex];
                if (transcriptWorkspace) msg.workspace = transcriptWorkspace;
                messages.push(msg);
            }
            if (i + 1 < lines.length && ((i + 1) % 256 === 0
                || ((i + 1) % 16 === 0 && performance.now() - sliceStartedAt >= 1))) {
                yield;
                sliceStartedAt = performance.now();
            }
        }
        // A live writer must not force an endless reassembly from record zero.
        // Publish an append-validated prefix as stale; the next read catches
        // its tail. A rewrite/replacement still invalidates all assembled data.
        revision = projectedJsonlSnapshotState(sourcePath, projectionKey, lines);
        if (!revision) return yield* executeJsonl(src, input, resolution, cooperative);
        const turnTerminalMarkers = extractBuiltinTurnTerminalMarkers(input.agentType, lines.map(rec => rec.terminal), providerSessionId);
        projection = { messages: markNativeHistorySnapshot(messages), turnTerminalMarkers,
            ...(usageRecords.length ? { usage: foldUsageRecords(usageRecords, {
                providerSessionId: providerSessionId || '', agent: typeof input.agentType === 'string' ? input.agentType : 'unknown',
            }) } : {}),
        };
        if (!byContext) jsonlProjections.set(lines, byContext = new Map());
        byContext.set(projectionContext, projection);
    }
    const { messages, usage, turnTerminalMarkers } = projection;
    if (messages.length === 0 && turnTerminalMarkers.length === 0) return null;

    const workspaceHint = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim() : '';
    const workspaceMatches = !workspaceHint
        || !transcriptWorkspace
        || claimKeyForPath(transcriptWorkspace) === claimKeyForPath(workspaceHint);
    const codexExactConfirmed = Boolean(
        requested && providerSessionId && sameSessionUuid(providerSessionId, requested) && workspaceMatches,
    );
    if (input.agentType === 'codex-cli' && codexExactConfirmed) {
        claimOwnTranscript(sourcePath, input);
    }
    const codexPromptConfirmed = outcome?.ownerConfirmed === true
        && workspaceMatches
        && Boolean(
            input.instanceId
            && hasExclusiveSentInput(
                input.instanceId,
                messages.filter(m => m.role === 'user').map(m => m.content),
            ),
        );

    return {
        messages,
        ...(revision.stale ? { stale: true } : {}),
        providerSessionId,
        sourcePath,
        sourceMtimeMs: mtime,
        nativeHistoryCoverage: 'full',
        workspace: transcriptWorkspace,
        attribution: outcome?.attribution,
        // A timestamp/mtime pick is a candidate, not runtime ownership proof.
        ownerConfirmed: input.agentType === 'codex-cli'
            ? (codexExactConfirmed || codexPromptConfirmed)
            : outcome?.ownerConfirmed,
        ...(usage ? { usage } : {}),
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
function extractBuiltinTurnTerminalMarkers(agentType: string | undefined, lines: any[], nativeSessionId?: string): NativeTurnTerminalMarker[] {
    if (agentType === 'kimi') return extractKimiTurnTerminalMarkers(lines);
    if (agentType !== 'codex-cli') return [];
    const markers: NativeTurnTerminalMarker[] = [];
    const provenance = createCodexTurnProvenance(nativeSessionId);
    for (const rec of lines) {
        if (String(rec?.type ?? '') !== 'event_msg') continue;
        const payload = rec?.payload;
        if (!payload || typeof payload !== 'object') continue;
        const payloadType = String(payload.type ?? '').trim();
        const isComplete = payloadType === 'task_complete';
        const isAbort = payloadType === 'turn_aborted';
        const receivedAt = parseTimestamp(rec?.timestamp) ?? 0;
        if (!isComplete && !isAbort) { provenance(payload, receivedAt); continue; }
        const summary = flattenJsonlText(payload.last_agent_message);
        const rawTurnId = payload.turn_id;
        const turnId = typeof rawTurnId === 'string' && rawTurnId.trim() ? rawTurnId.trim() : '';
        const marker = provenance(payload, receivedAt, {
            receivedAt,
            outcome: isAbort ? 'aborted' : 'completed',
            summary,
            ...(turnId ? { turnId } : {}),
        });
        if (marker) markers.push(marker);
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

export interface JsonlSourceResolution {
    path: string | null;
    outcome?: JsonlClaimOutcome;
    evidence?: SidecarSourceEvidence;
    claimKey?: string;
    stale?: boolean;
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
        } else if (input.agentType === 'codex-cli' && !requestedSessionId && transcriptClaimOwnerToken(input.instanceId)) {
            return resolveCodexInstanceSource(src, resolved, stat?.isDirectory() ? resolved : null, filePat, windowMs, sessionFloor, workspaceHint, input);
        } else if (stat && stat.isDirectory()) {
            const exact = pickExactSessionFile(resolved, filePat, requestedSessionId);
            if (exact) {
                const owner = transcriptClaimOwnerToken(input.instanceId);
                if (owner && isTranscriptClaimedByOther(claimKeyForPath(exact), owner)) {
                    return failClosedResolution('already_claimed', workspaceHint, owner);
                }
                if (input.agentType !== 'codex-cli') claimOwnTranscript(exact, input);
            }
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
            const exactDate = pickExactSessionFileAcrossDateWindow(src.path, input, filePat, requestedSessionId);
            if (exactDate) {
                const owner = transcriptClaimOwnerToken(input.instanceId);
                if (owner && isTranscriptClaimedByOther(claimKeyForPath(exactDate), owner)) {
                    return failClosedResolution('already_claimed', workspaceHint, owner);
                }
            }
            sourcePath = exactDate
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

function resolveCodexInstanceSource(
    src: NativeHistoryJsonlSource,
    _resolved: string,
    dir: string | null,
    filePat: RegExp,
    windowMs: number,
    sessionFloor: number,
    workspaceHint: string,
    input: NativeHistoryInput,
): JsonlSourceResolution {
    const owner = transcriptClaimOwnerToken(input.instanceId);
    if (!owner) return { path: null };
    const effectiveFloor = sessionFloor > 0 ? Math.max(0, sessionFloor - SPAWN_BIND_GRACE_MS) : 0;
    const rawCandidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (p: string | null | undefined) => {
        if (!p || seen.has(p)) return;
        seen.add(p);
        rawCandidates.push(p);
    };
    if (dir) {
        for (const p of recentFiles(dir, filePat, windowMs, effectiveFloor)) addCandidate(p);
    }
    if (hasDateTemplateSegment(src.path)) {
        for (const p of recentFilesAcrossDateWindow(src.path, input, filePat, windowMs, effectiveFloor)) addCandidate(p);
    }
    const unclaimed = rawCandidates.filter(p => !isTranscriptClaimedByOther(claimKeyForPath(p), owner));
    const wsKey = workspaceHint ? claimKeyForPath(workspaceHint) : '';

    if (hasRecordedSentInput(input.instanceId)) {
        const shapes = compileRecordShapes(src);
        const matches = unclaimed.filter((p) => {
            const meta = readCandidateSessionMeta(p);
            if (wsKey && (!meta?.cwd || claimKeyForPath(meta.cwd) !== wsKey)) return false;
            if (sessionFloor > 0 && meta?.sessionTimestampMs != null && meta.sessionTimestampMs < sessionFloor - SPAWN_BIND_GRACE_MS) {
                return false;
            }
            const lines = readJsonlLines(p);
            if (lines.length === 0) return false;
            const userTexts: string[] = [];
            for (let i = 0; i < lines.length; i += 1) {
                const rec = lines[i];
                const shape = shapes.pick(rec);
                if (!shape) continue;
                for (const msg of projectMessages(rec, shape.map, i, lines.length, 0)) {
                    if (msg.role === 'user' && msg.content) userTexts.push(msg.content);
                }
            }
            return Boolean(input.instanceId && hasExclusiveSentInput(input.instanceId, userTexts));
        });
        if (matches.length > 1) return failClosedResolution('ambiguous', workspaceHint, owner);
        if (matches.length === 1) {
            const verdict = claimTranscript(claimKeyForPath(matches[0]), owner);
            if (verdict === 'denied') return failClosedResolution('already_claimed', workspaceHint, owner);
            return {
                path: matches[0],
                outcome: { attribution: verdict === 'stale_reclaimed' ? 'stale_reclaimed' : 'claimed', ownerConfirmed: true },
            };
        }
        return { path: null };
    }

    const bound = (dir ? pickSessionBoundFile(dir, filePat, windowMs, sessionFloor, workspaceHint) : null)
        || (hasDateTemplateSegment(src.path) ? pickSessionBoundFileAcrossDateWindow(src.path, input, filePat, windowMs, sessionFloor, workspaceHint) : null);
    if (bound && !isTranscriptClaimedByOther(claimKeyForPath(bound), owner)) {
        return { path: bound, outcome: { attribution: 'legacy', ownerConfirmed: false } };
    }
    const wsFiltered = wsKey
        ? unclaimed.filter((p) => {
            const meta = readCandidateSessionMeta(p);
            return Boolean(meta?.cwd && claimKeyForPath(meta.cwd) === wsKey);
        })
        : unclaimed;
    const fallback = wsFiltered[0] ?? (!wsKey ? unclaimed[0] : null) ?? null;
    return { path: fallback, ...(fallback ? { outcome: { attribution: 'legacy', ownerConfirmed: false } } : {}) };
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
    template: string, pattern: RegExp, windowMs: number, sessionFloorMs: number,
    workspaceHint: string, requestedSessionId: string,
    sidecar: { rel_path: string; workspace_path: string }, input: NativeHistoryInput,
): JsonlSourceResolution {
    const exact = requestedSessionId ? pickDirUuidFileAcrossGlob(template, pattern, requestedSessionId) : null;
    const legacy = !requestedSessionId && !workspaceHint ? newestRecentFileAcrossGlob(template, pattern, windowMs, sessionFloorMs) : null;
    const entries = requestedSessionId || !workspaceHint
        ? (exact || legacy ? [{ p: (exact || legacy)!, mtime: safeMtimeMs((exact || legacy)!), birth: 0 }] : [])
        : listSidecarWorkspaceCandidates(template, pattern, windowMs, sessionFloorMs, workspaceHint, sidecar);
    const candidates = entries.map(c => ({ ...c, key: claimKeyForPath(c.p), workspaceMatches: true }));
    return selectSidecarClaimSource(candidates, input, windowMs,
        (p, snippets) => containsSentPrompt(readForPromptEvidence(p), snippets));
}

/** The SAME selection/claim transaction serves synchronous history and async
 * status. All filesystem evidence is gathered before entering this function. */
function selectSidecarClaimSource(
    candidates: SidecarSourceCandidate[], input: NativeHistoryInput, windowMs: number,
    matchesPrompt: (p: string, snippets: string[]) => boolean,
): JsonlSourceResolution {
    const owner = transcriptClaimOwnerToken(input.instanceId);
    const workspaceHint = input.workspace?.trim() ?? '';
    const requestedSessionId = readRequestedSessionId(input);
    const sessionFloorMs = input.sessionStartedAtMs ?? 0;
    if (requestedSessionId) {
        const pinned = candidates.find(c => sameSessionUuid(dirUuid(c.p), requestedSessionId));
        if (!pinned) return { path: null };
        if (!owner) return { path: pinned.p, outcome: { attribution: 'pinned' } };
        const verdict = claimTranscript(pinned.key, owner);
        if (verdict === 'denied') return failClosedResolution('already_claimed', workspaceHint, owner);
        return { path: pinned.p, outcome: { attribution: verdict === 'stale_reclaimed' ? 'stale_reclaimed' : 'pinned', ownerConfirmed: true } };
    }
    const cutoff = Math.max(Date.now() - windowMs, sessionFloorMs);
    const scoped = candidates.filter(c => c.mtime >= cutoff && (!workspaceHint || c.workspaceMatches));
    if (!workspaceHint) return { path: scoped[0]?.p ?? null };
    if (!scoped.length) return { path: null };
    if (!owner) {
        if (scoped.length === 1) return { path: scoped[0].p, outcome: { attribution: 'legacy' } };
        const picked = pickUniqueSpawnEvidence(scoped, sessionFloorMs);
        if (picked) return { path: picked, outcome: { attribution: 'spawn_evidence', ownerConfirmed: true } };
        return failClosedResolution('ambiguous', workspaceHint, owner);
    }
    const unclaimed = scoped.filter(c => !isTranscriptClaimedByOther(c.key, owner));
    if (!unclaimed.length) return failClosedResolution('already_claimed', workspaceHint, owner);
    const eligible = sessionFloorMs > 0
        ? unclaimed.filter(c => (c.birth > 0 ? c.birth : c.mtime) >= sessionFloorMs - SPAWN_BIND_GRACE_MS) : unclaimed;
    if (!eligible.length) return { path: null };
    const snippets = sentPromptSnippets(input.instanceId);
    let chosen: string | null = null;
    if (snippets.length) {
        const matches = eligible.filter(c => matchesPrompt(c.p, snippets));
        if (matches.length === 1) chosen = matches[0].p;
        else if (!matches.length) return { path: null };
    }
    if (!chosen && eligible.length === 1) chosen = eligible[0].p;
    else if (!chosen) chosen = pickUniqueSpawnEvidence(eligible, sessionFloorMs);
    if (!chosen) return failClosedResolution('ambiguous', workspaceHint, owner);
    const verdict = claimTranscript(eligible.find(c => c.p === chosen)!.key, owner);
    if (verdict === 'denied') return failClosedResolution('already_claimed', workspaceHint, owner);
    return { path: chosen, outcome: { attribution: verdict === 'stale_reclaimed' ? 'stale_reclaimed' : 'claimed', ownerConfirmed: true } };
}

/** Reuse prepared evidence when only registry ownership/prompt identity changed.
 * isCurrent must be checked BEFORE the serialized claim, not just before UI writes. */
export function resolveJsonlSidecarSourceFromEvidence(
    src: NativeHistoryJsonlSource, input: NativeHistoryInput, evidence: SidecarSourceEvidence, isCurrent: () => boolean,
): JsonlSourceResolution {
    if (!isCurrent()) return { path: null, stale: true };
    if (evidence.directPath) return { path: evidence.directPath, evidence };
    if (!src.workspace_from_sidecar && src.session_id_from === 'dir_uuid') {
        const requested = readRequestedSessionId(input);
        const cutoff = Math.max(Date.now() - (src.recent_window_ms ?? 5 * 60_000), input.sessionStartedAtMs ?? 0);
        const chosen = evidence.candidates.find(c => requested ? sameSessionUuid(dirUuid(c.p), requested) : c.mtime >= cutoff);
        return { path: chosen?.p ?? null, evidence };
    }
    const result = selectSidecarClaimSource(evidence.candidates, input, src.recent_window_ms ?? 5 * 60_000,
        (p, snippets) => JSON.stringify(snippets) === evidence.promptIdentity && evidence.candidates.find(c => c.p === p)?.promptMatches === true);
    return { ...result, evidence, claimKey: evidence.candidates.find(c => c.p === result.path)?.key };
}

export async function resolveJsonlSidecarSourceAsync(
    src: NativeHistoryJsonlSource, input: NativeHistoryInput,
    options: { isCurrent: () => boolean; evidence?: SidecarSourceEvidence },
): Promise<JsonlSourceResolution> {
    const evidence = options.evidence ?? await collectSidecarSourceEvidenceAsync(src, input);
    if (evidence.promptIdentity !== JSON.stringify(sentPromptSnippets(input.instanceId))) await refreshSidecarPromptEvidenceAsync(evidence, input);
    // Reconcile creation/rename/write races during enumeration and evidence reads.
    for (const [p, revision] of evidence.revisions) {
        if (!options.isCurrent() || await sourceRevisionAsync(p) !== revision) return { path: null, evidence, stale: true };
    }
    if (evidence.promptIdentity !== JSON.stringify(sentPromptSnippets(input.instanceId))) return { path: null, evidence, stale: true };
    return resolveJsonlSidecarSourceFromEvidence(src, input, evidence, options.isCurrent);
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
