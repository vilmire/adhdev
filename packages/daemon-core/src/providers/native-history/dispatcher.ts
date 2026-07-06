/**
 * Spec-aware dispatcher for native conversation history.
 *
 * The four existing readers (claude/codex/antigravity/hermes) already know
 * how to parse each agent's on-disk format. This dispatcher just resolves
 * the right file given a workspace + sessionId hint, then hands it off.
 *
 * Wired into ProviderModule.scripts.readNativeHistory by provider-loader
 * when spec.json declares native_history.reader. The script signature
 * matches what chat-history.ts expects (see callProviderNativeHistoryRead).
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSession as readClaudeCliSession } from './claude-cli-transcript.js';
import { readSession as readCodexCliSession } from './codex-cli-transcript.js';
import { readSession as readAntigravityCliSession } from './antigravity-cli-transcript.js';
import { readSession as readHermesCliSession } from './hermes-cli-transcript.js';
import { SPAWN_BIND_GRACE_MS } from './constants.js';
import {
    antigravityOwnerToken,
    claimAntigravityConversation,
    isAntigravityConversationClaimedByOther,
} from './antigravity-claim-registry.js';

export type ReaderId = 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'hermes-cli';

export interface NativeHistoryInput {
    agentType?: string;
    sessionId?: string;
    providerSessionId?: string;
    historySessionId?: string;
    /** Daemon instance id of the reading session. Used (with workspace +
     *  sessionStartedAtMs) to derive the antigravity conversation-claim owner
     *  token so two concurrent sessions never bind to the same .db. */
    instanceId?: string;
    workspace?: string;
    sessionStartedAtMs?: number;
    format?: string;
    watchPath?: string;
    forceRefresh?: boolean;
    args?: Record<string, unknown>;
}

export interface NativeHistoryResult {
    messages: Array<{ role: string; content: string; receivedAt?: number; kind?: string; workspace?: string }>;
    providerSessionId?: string;
    sourcePath: string;
    sourceMtimeMs: number;
    nativeHistoryCoverage?: 'full' | 'partial' | 'best-effort';
}

export function createNativeHistoryDispatcher(reader: ReaderId): (input: NativeHistoryInput) => NativeHistoryResult | null {
    return (input: NativeHistoryInput) => {
        const workspace = input.workspace || '';
        const sessionId = input.sessionId || input.historySessionId || '';
        // Caller may pass a providerSessionId (the *provider's own* id, e.g.
        // the uuid claude writes into the jsonl basename). When present, the
        // dispatcher only returns a transcript whose file id matches —
        // otherwise the newest_by_mtime fallback can surface a different
        // session's chat (round 9 part b: the user reported "previous chat
        // shows up before I type anything" on every provider).
        const requestedProviderSid = input.providerSessionId || '';

        const sessionStartedAtMs = typeof input.sessionStartedAtMs === 'number'
            ? input.sessionStartedAtMs
            : typeof input.args?.sessionStartedAtMs === 'number'
                ? input.args.sessionStartedAtMs
                : 0;
        const instanceId = typeof input.instanceId === 'string'
            ? input.instanceId
            : typeof input.args?.instanceId === 'string'
                ? (input.args.instanceId as string)
                : '';
        const sourcePath = resolveSourcePath(reader, workspace, sessionId, sessionStartedAtMs, instanceId);
        if (!sourcePath) return null;
        if (input.forceRefresh === true || input.args?.forceRefresh === true) {
            try { fs.statSync(sourcePath); } catch { /* best-effort metadata refresh */ }
        }

        const session = readByReader(reader, sourcePath, sessionId, workspace, requestedProviderSid);
        if (!session) return null;

        if (requestedProviderSid && session.providerSessionId && session.providerSessionId !== requestedProviderSid) {
            return null;
        }

        // For antigravity, the authoritative conversation id is the on-disk uuid
        // embedded in the resolved path (conversations/<uuid>.db or
        // brain/<uuid>/…/transcript.jsonl), NOT the ADHDev session id the caller
        // threaded in. Surface that uuid as providerSessionId whenever the reader
        // did not already return a distinct one, so the read_chat layer can pin
        // the real conversation and (post-restart) exact-bind straight to it
        // instead of re-running the mtime/recency heuristic that drops an idle
        // store (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP). Other providers keep the
        // reader's value verbatim.
        let resolvedProviderSessionId = session.providerSessionId;
        if (reader === 'antigravity-cli') {
            const onDiskUuid = extractAntigravityConversationUuid(session.sourcePath || sourcePath);
            if (onDiskUuid && (!resolvedProviderSessionId || resolvedProviderSessionId === sessionId)) {
                resolvedProviderSessionId = onDiskUuid;
            }
        }

        return {
            messages: session.messages.map((m: any) => ({
                role: normalizeRole(m.role),
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                receivedAt: typeof m.receivedAt === 'number' ? m.receivedAt : Date.parse(m.timestamp || '') || Date.now(),
                kind: typeof m.kind === 'string' ? m.kind : 'standard',
                workspace: typeof m.workspace === 'string' ? m.workspace : workspace || undefined,
            })),
            providerSessionId: resolvedProviderSessionId,
            sourcePath: session.sourcePath,
            sourceMtimeMs: session.sourceMtimeMs,
            nativeHistoryCoverage: (session as any).nativeHistoryCoverage || 'full',
        };
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-provider path resolution
// ────────────────────────────────────────────────────────────────────────────

function resolveSourcePath(reader: ReaderId, workspace: string, sessionId: string, sessionStartedAtMs: number, instanceId: string): string | null {
    switch (reader) {
        case 'claude-cli':   return resolveClaudePath(workspace, sessionId);
        case 'codex-cli':    return resolveCodexPath(workspace, sessionId, sessionStartedAtMs);
        case 'antigravity-cli': return resolveAntigravityPath(workspace, sessionId, sessionStartedAtMs, instanceId);
        case 'hermes-cli':   return resolveHermesPath(workspace, sessionId);
    }
}

function resolveClaudePath(workspace: string, sessionId: string): string | null {
    // claude stores per-cwd: ~/.claude/projects/<cwd-as-dashes>/<uuid>.jsonl
    const dir = path.join(os.homedir(), '.claude', 'projects', cwdAsDashes(workspace));
    if (!fs.existsSync(dir)) return null;
    if (sessionId) {
        const candidate = path.join(dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
    }
    // No exact match: return null. The newest_by_mtime fallback used to
    // grab whichever transcript was touched most recently, but that
    // surfaced a different (often the user's *external* claude session
    // in the same workspace) chat in the dashboard before the user
    // typed anything. The right answer is to show nothing until either
    // the daemon's sessionId actually maps to a file or the caller
    // passes the correct providerSessionId (round 9 part b).
    return null;
}

function resolveCodexPath(workspace: string, sessionId: string, sessionStartedAtMs: number): string | null {
    // codex stores by UTC date: ~/.codex/sessions/<year>/<month>/<day>/<file>.jsonl
    const root = codexSessionsRoot();
    if (sessionId && isUuidLikeSessionId(sessionId)) {
        return findCodexPathBySessionId(root, sessionId);
    }
    return findCodexPathByRuntime(root, workspace, sessionStartedAtMs);
}

function findCodexPathBySessionId(root: string, sessionId: string): string | null {
    if (!fs.existsSync(root)) return null;
    const needle = sessionId.toLowerCase();
    const matches: Array<{ p: string; mtime: number }> = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            if (!entry.name.toLowerCase().includes(needle)) continue;
            if (!isSafeFilename(entry.name.replace('.jsonl', ''))) continue;
            matches.push({ p: entryPath, mtime: safeMtime(entryPath) });
        }
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0]?.p ?? null;
}

function findCodexPathByRuntime(root: string, workspace: string, sessionStartedAtMs: number): string | null {
    if (!fs.existsSync(root) || !workspace) return null;
    const workspaceResolved = resolveRealPath(workspace);
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const matches: Array<{ p: string; mtime: number; diff: number }> = [];
    const stack: string[] = [root];

    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const mtime = safeMtime(entryPath);
            if (mtime < cutoff) continue;
            const meta = readCodexSessionMeta(entryPath);
            if (!meta?.cwd || resolveRealPath(meta.cwd) !== workspaceResolved) continue;
            const diff = sessionStartedAtMs > 0 && meta.timestampMs != null
                ? Math.abs(meta.timestampMs - sessionStartedAtMs)
                : 0;
            if (sessionStartedAtMs > 0 && (meta.timestampMs == null || diff > SPAWN_BIND_GRACE_MS)) continue;
            matches.push({ p: entryPath, mtime, diff });
        }
    }

    matches.sort((a, b) => sessionStartedAtMs > 0
        ? a.diff - b.diff || b.mtime - a.mtime
        : b.mtime - a.mtime);
    return matches[0]?.p ?? null;
}

function readCodexSessionMeta(filePath: string): { cwd?: string; timestampMs?: number } | null {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(8192);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (bytes <= 0) return null;
            const text = buffer.subarray(0, bytes).toString('utf8');
            const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length).trim();
            if (!firstLine) return null;
            const record = JSON.parse(firstLine) as Record<string, unknown>;
            if (record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') return null;
            const payload = record.payload as Record<string, unknown>;
            const timestampRaw = payload.timestamp;
            const timestampMs = typeof timestampRaw === 'string'
                ? Date.parse(timestampRaw)
                : typeof timestampRaw === 'number'
                    ? (timestampRaw < 1e12 ? timestampRaw * 1000 : timestampRaw)
                    : NaN;
            return {
                cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
                timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
            };
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

function resolveRealPath(value: string): string {
    try { return fs.realpathSync(value); } catch { return value; }
}

/**
 * Pull the antigravity conversation uuid out of a resolved source path. Both
 * on-disk layouts embed it: conversations/<uuid>.db and
 * brain/<uuid>/.system_generated/logs/transcript*.jsonl (and the legacy
 * conversations/<uuid>.pb). Returns the uuid when a segment matches the
 * canonical form, else ''.
 */
function extractAntigravityConversationUuid(sourcePath: string): string {
    if (!sourcePath) return '';
    const segments = sourcePath.split(/[\\/]/);
    // conversations/<uuid>.db|.pb — the basename minus extension.
    const base = segments[segments.length - 1] || '';
    const baseMatch = /^([0-9a-f-]+)\.(?:db|pb)$/i.exec(base);
    if (baseMatch && isUuidLikeSessionId(baseMatch[1])) return baseMatch[1];
    // brain/<uuid>/… — the first uuid-like path segment.
    for (const seg of segments) {
        if (isUuidLikeSessionId(seg)) return seg;
    }
    return '';
}

/**
 * The daemon may stamp a session's spawn time a hair before the CLI child
 * actually creates its conversation .db, so treat a store born within this
 * grace of the spawn floor as still belonging to this session. Kept small
 * (< a typical concurrent-spawn gap) so a sibling's PRE-spawn store is still
 * excluded rather than mis-bound.
 */
const AGY_SPAWN_CLAIM_GRACE_MS = 2000;

function resolveAntigravityPath(
    workspace: string,
    sessionId: string,
    sessionStartedAtMs: number,
    instanceId: string,
): string | null {
    const agyRoot = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    // Owner token identifies THIS reading session. The provider instance derives
    // the identical token (workspace + startedAt, or instanceId) so it can
    // release these claims on shutdown. '' when there is no stable identity to
    // key on — claiming is then skipped but exclusion still runs.
    const owner = antigravityOwnerToken(workspace, sessionStartedAtMs, instanceId);

    // (1) Exact session bind + LOCK: current antigravity writes a per-session
    //     SQLite db at conversations/<uuid>.db. Once the caller knows the session
    //     id, bind straight to it — this is authoritative and never re-resolves
    //     by mtime, so an already-bound session cannot be hijacked by a newer
    //     .db on a later read. Claim it so a concurrent unbound sibling can never
    //     grab this same conversation.
    if (sessionId && isUuidLikeSessionId(sessionId)) {
        const dbPath = path.join(agyRoot, 'conversations', `${sessionId}.db`);
        if (fs.existsSync(dbPath)) {
            if (owner) claimAntigravityConversation(sessionId, owner);
            return dbPath;
        }
    }

    // (2) brain/<uuid>/.system_generated/logs/transcript.jsonl (legacy full source).
    //     Only bind to a brain transcript that is NON-EMPTY: current antigravity
    //     writes this file but leaves it 0 bytes (all real conversation data now
    //     lives in the per-session .db), so an empty transcript here would
    //     otherwise shadow the .db fallback below and return no messages. Skip
    //     empty transcripts so an unbound read still reaches the .db. Exclude any
    //     brain conversation already claimed by a DIFFERENT live session.
    const brainRoot = path.join(agyRoot, 'brain');
    if (fs.existsSync(brainRoot)) {
        const cutoff = spawnAwareCutoff(sessionStartedAtMs);
        const entries = fs.readdirSync(brainRoot, { withFileTypes: true })
            .filter(e => e.isDirectory() && isUuidLikeSessionId(e.name))
            .filter(e => !isAntigravityConversationClaimedByOther(e.name, owner))
            .map(e => ({ uuid: e.name, p: path.join(brainRoot, e.name), mtime: safeMtime(path.join(brainRoot, e.name)) }))
            .filter(e => e.mtime >= cutoff)
            .sort((a, b) => b.mtime - a.mtime);
        for (const e of entries) {
            const t = path.join(e.p, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(t) && safeSize(t) > 0) {
                if (owner) claimAntigravityConversation(e.uuid, owner);
                return t;
            }
        }
    }

    // (3) No brain transcript and no bound session id: pick a conversations/<uuid>.db
    //     that is NOT claimed by another live session, guarded by this session's
    //     spawn time so we never mis-bind to a sibling's earlier store.
    const convRoot = path.join(agyRoot, 'conversations');
    const picked = pickUnboundConversationDb(convRoot, sessionStartedAtMs, owner);
    if (picked) {
        if (owner) claimAntigravityConversation(picked.uuid, owner);
        return picked.path;
    }

    return null;
}

/**
 * Choose the conversations/<uuid>.db for an as-yet-unbound antigravity session.
 *
 * Two isolation rules keep concurrent sessions apart:
 *   - claim exclusion: skip any .db already owned by a DIFFERENT live session,
 *     so two sessions can never resolve to the same conversation;
 *   - spawn-window guard: a session's own store is created at/after it spawned,
 *     so when a spawn floor is known, only stores born at/after (floor - grace)
 *     are eligible. A store that predates this session's spawn belongs to an
 *     earlier session and is never bound — if none qualifies we return null
 *     (native_history_empty) and let the caller retry once this session's own
 *     store appears, rather than binding a sibling's conversation.
 *
 * Among eligible unclaimed stores the OLDEST-created wins: in the normal case
 * (each session polls native history only after its own store exists, and an
 * earlier-spawned session polls earlier) this hands each session the first
 * store created after it started — its own. When no spawn floor is available
 * (legacy/unpinned discovery) we fall back to newest-by-mtime within the
 * recency window, preserving the original single-session behaviour.
 */
function pickUnboundConversationDb(
    convRoot: string,
    sessionFloorMs: number,
    owner: string,
): { path: string; uuid: string } | null {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(convRoot, { withFileTypes: true }); } catch { return null; }

    // A known spawn floor already pins a candidate to THIS session by birth time
    // (a store created at/after the session spawned is its own). Once that floor
    // is available, the recency window is not just unnecessary but harmful: an
    // antigravity session that has sat idle longer than RECENT_WINDOW_MS still
    // owns its conversation .db, but the recency cutoff would drop it from the
    // candidate set, collapsing the read to native_history_empty and forcing the
    // dashboard onto the PTY parse (user echo only, assistant tail lost —
    // ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP, most visible right after a daemon
    // restart clears the in-memory read pin). So only apply the recency cutoff in
    // the floor-less (legacy/unpinned) discovery path, where it is the sole guard
    // against binding an unrelated old store. When a floor is known the birth-time
    // filter below is the authoritative, idle-agnostic owner check.
    const applyRecencyCutoff = !(sessionFloorMs > 0);
    const recencyCutoff = Date.now() - RECENT_WINDOW_MS;
    const candidates: Array<{ path: string; uuid: string; mtime: number; birth: number }> = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = /^([0-9a-f-]+)\.db$/i.exec(entry.name);
        if (!match || !isUuidLikeSessionId(match[1])) continue;
        const uuid = match[1];
        // (isolation) never consider a conversation a different live session owns.
        if (isAntigravityConversationClaimedByOther(uuid, owner)) continue;
        const p = path.join(convRoot, entry.name);
        const mtime = safeMtime(p);
        if (applyRecencyCutoff && mtime < recencyCutoff) continue;
        candidates.push({ path: p, uuid, mtime, birth: safeBirthtime(p) });
    }
    if (candidates.length === 0) return null;

    if (sessionFloorMs > 0) {
        const floor = sessionFloorMs - AGY_SPAWN_CLAIM_GRACE_MS;
        const own = candidates.filter(c => (c.birth > 0 ? c.birth : c.mtime) >= floor);
        // A store created before this session spawned belongs to an earlier
        // session — do NOT bind to it. Wait for our own store on the next read.
        if (own.length === 0) return null;
        own.sort((a, b) => (a.birth || a.mtime) - (b.birth || b.mtime));
        return { path: own[0].path, uuid: own[0].uuid };
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    return { path: candidates[0].path, uuid: candidates[0].uuid };
}

/**
 * mtime floor for the brain-transcript scan: the later of the recency window
 * and this session's spawn floor (minus the claim grace), so a fresh read
 * cannot surface a brain dir last touched before this session started.
 */
function spawnAwareCutoff(sessionStartedAtMs: number): number {
    const recency = Date.now() - RECENT_WINDOW_MS;
    if (sessionStartedAtMs > 0) return Math.max(recency, sessionStartedAtMs - AGY_SPAWN_CLAIM_GRACE_MS);
    return recency;
}

function resolveHermesPath(workspace: string, sessionId: string): string | null {
    void workspace; void sessionId;
    // Hermes ≥ 0.14 persists all chat to ~/.hermes/state.db (SQLite). The
    // db file is the "path" we hand to the reader — it pulls the newest
    // source='cli' session inside readSession.
    const dbPath = path.join(os.homedir(), '.hermes', 'state.db');
    if (fs.existsSync(dbPath)) return dbPath;
    // Legacy fallback: pre-db hermes wrote per-session JSON dumps.
    const dir = path.join(os.homedir(), '.hermes', 'sessions');
    if (!fs.existsSync(dir)) return null;
    return newestRecentFile(dir, /^session_.*\.json$/);
}

// ────────────────────────────────────────────────────────────────────────────
// Reader dispatch
// ────────────────────────────────────────────────────────────────────────────

function readByReader(
    reader: ReaderId,
    sourcePath: string,
    sessionId: string,
    workspace: string,
    requestedProviderSid: string,
): any | null {
    switch (reader) {
        case 'claude-cli':      return readClaudeCliSession(sourcePath);
        case 'codex-cli':       return readCodexCliSession(sourcePath);
        case 'antigravity-cli': return readAntigravityCliSession(sourcePath, sessionId || undefined, workspace || undefined);
        // hermes reads a *shared* state.db and would otherwise pick the newest
        // source='cli' session, which drifts every read (hermes ≥0.14 writes a
        // fresh row per internal sub-session). Pass the bound id so it reads
        // THAT session directly instead of newest-wins. claude/codex resolve a
        // per-session file upstream, so they need no equivalent pin here.
        case 'hermes-cli':      return readHermesCliSession(sourcePath, requestedProviderSid || undefined);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function cwdAsDashes(cwd: string): string {
    if (!cwd) return '';
    return cwd.replace(/\//g, '-');
}

function codexSessionsRoot(): string {
    return path.join(os.homedir(), '.codex', 'sessions');
}

function isUuidLikeSessionId(sessionId: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

function isSafeFilename(name: string): boolean {
    return /^[A-Za-z0-9._:-]+$/.test(name) && !name.includes('..');
}

function newestFile(dir: string, pattern: RegExp): string | null {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile() && pattern.test(e.name))
            .map(e => ({ p: path.join(dir, e.name), mtime: safeMtime(path.join(dir, e.name)) }))
            .sort((a, b) => b.mtime - a.mtime);
        return entries[0]?.p ?? null;
    } catch { return null; }
}

/**
 * Like newestFile but only returns a candidate when its mtime is within
 * the recent activity window. Prevents the dashboard from surfacing a
 * prior session's transcript when the daemon's sessionId doesn't match
 * any file on disk (e.g. claude allocates its own uuid; daemon and
 * agent disagree about what the "current" session is).
 */
const RECENT_WINDOW_MS = 5 * 60 * 1000;
function newestRecentFile(dir: string, pattern: RegExp): string | null {
    try {
        const cutoff = Date.now() - RECENT_WINDOW_MS;
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile() && pattern.test(e.name))
            .map(e => ({ p: path.join(dir, e.name), mtime: safeMtime(path.join(dir, e.name)) }))
            .filter(e => e.mtime >= cutoff)
            .sort((a, b) => b.mtime - a.mtime);
        return entries[0]?.p ?? null;
    } catch { return null; }
}

function safeMtime(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

/**
 * File creation time in ms. birthtimeMs is high-precision on all shipped
 * runners (NTFS/ext4/APFS), and a conversation .db is created by the CLI child
 * strictly AFTER the daemon spawned it, so birthtime > the session's spawn
 * floor for its own store. Falls back to mtime when birthtime is unavailable
 * (0 / not tracked) so the caller still has a usable ordering key.
 */
function safeBirthtime(p: string): number {
    try {
        const st = fs.statSync(p);
        const birth = Math.floor(st.birthtimeMs);
        return birth > 0 ? birth : Math.floor(st.mtimeMs);
    } catch { return 0; }
}

function safeSize(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

function normalizeRole(r: any): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
    // daemon's chat schema rejects 'tool'/'function' — surface as assistant.
    if (s === 'tool' || s === 'tool_result' || s === 'function') return 'assistant';
    return 'system';
}
