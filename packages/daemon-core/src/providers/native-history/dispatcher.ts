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
import type { NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';
import { readSession as readClaudeCliSession } from './claude-cli-transcript.js';
import { readSession as readCodexCliSession } from './codex-cli-transcript.js';
import { readSession as readAntigravityCliSession } from './antigravity-cli-transcript.js';
import { readSession as readHermesCliSession } from './hermes-cli-transcript.js';
import {
    readSession as readGrokCliSession,
    listSessions as listGrokCliSessions,
    listSessionsAllWorkspaces as listGrokCliSessionsAllWorkspaces,
    resolveGrokPath,
} from './grok-cli-transcript.js';
import { SPAWN_BIND_GRACE_MS } from './constants.js';
import {
    antigravityOwnerToken,
    claimAntigravityConversation,
    isAntigravityConversationClaimedByOther,
} from './antigravity-claim-registry.js';

export type ReaderId = 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'hermes-cli' | 'grok-cli';

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
    /**
     * True only when the resolved conversation is confirmed to belong to THIS
     * reading session by the owner-token identity (an exact uuid bind, or a
     * spawn-floor/birth-time pick born after this session started). False for a
     * bare recency/newest-by-mtime pick made with no spawn floor — that pick may
     * alias a co-located concurrent session (the antigravity coordinator↔replica
     * crosswire), so its uuid must NEVER be recorded as a pin nor trusted to
     * satisfy the same-pass safe-mapping identity check. Read-path callers gate
     * the workspace-latest pin + first-read trust on this flag. Non-antigravity
     * readers leave it undefined (their existing exact-file resolution is
     * unaffected by this signal).
     */
    ownerConfirmed?: boolean;
    /**
     * (NATIVE-TURN-SIGNAL) The provider's own turn-terminal records, when its reader
     * surfaces them (codex task_complete / turn_aborted). Absent for readers that have
     * no such record — those keep the message-shape inference path.
     */
    turnTerminalMarkers?: NativeTurnTerminalMarker[];
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
        const resolved = resolveSourcePath(reader, workspace, sessionId, sessionStartedAtMs, instanceId);
        const sourcePath = resolved?.path || null;
        if (!sourcePath) return null;
        // Owner-confirmation only meaningful for antigravity (see resolveAntigravityPath).
        // For other readers the file was resolved by exact per-session key already;
        // leave the flag undefined so the read-path callers treat them as before.
        const ownerConfirmed = reader === 'antigravity-cli' ? resolved?.ownerConfirmed === true : undefined;
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
            ownerConfirmed,
            // (NATIVE-TURN-SIGNAL) Pass the provider's own turn-terminal records through
            // untouched. Readers that surface none simply omit the field.
            ...(Array.isArray((session as any).turnTerminalMarkers) && (session as any).turnTerminalMarkers.length > 0
                ? { turnTerminalMarkers: (session as any).turnTerminalMarkers }
                : {}),
        };
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-provider path resolution
// ────────────────────────────────────────────────────────────────────────────

interface ResolvedSource {
    path: string;
    /** Antigravity only: whether the resolution was owner-token-confirmed (see
     *  NativeHistoryResult.ownerConfirmed / resolveAntigravityPath). */
    ownerConfirmed?: boolean;
}

function resolveSourcePath(reader: ReaderId, workspace: string, sessionId: string, sessionStartedAtMs: number, instanceId: string): ResolvedSource | null {
    switch (reader) {
        case 'claude-cli':   { const p = resolveClaudePath(workspace, sessionId); return p ? { path: p } : null; }
        case 'codex-cli':    { const p = resolveCodexPath(workspace, sessionId, sessionStartedAtMs); return p ? { path: p } : null; }
        case 'antigravity-cli': return resolveAntigravityPath(workspace, sessionId, sessionStartedAtMs, instanceId);
        case 'hermes-cli':   { const p = resolveHermesPath(workspace, sessionId); return p ? { path: p } : null; }
        // grok stores per-cwd like claude, but keyed by the url-encoded cwd and
        // with the uuid as a DIRECTORY (…/<uuid>/chat_history.jsonl) rather than
        // the filename, so resolution lives in the reader module.
        case 'grok-cli':     { const p = resolveGrokPath(workspace, sessionId); return p ? { path: p } : null; }
    }
}

/**
 * Exported for the background-task detector (providers/spec): resolve THIS
 * session's antigravity conversation store with the exact same binding,
 * claim-exclusion and spawn-floor rules the read path uses, so the detector
 * never scans a sibling session's conversation. `sessionId` is the provider
 * session id (the on-disk conversation uuid) when known.
 */
export function resolveAntigravityConversationPath(
    workspace: string,
    sessionId: string,
    sessionStartedAtMs: number,
    instanceId: string,
): { path: string; ownerConfirmed?: boolean } | null {
    return resolveAntigravityPath(workspace, sessionId, sessionStartedAtMs, instanceId);
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

/**
 * FLOOR-TIMING-WEDGE (fix 2 — binding persistence). Memo of runtime-resolved codex
 * rollout paths, keyed by the session's stable spawn identity (workspace + spawn ms).
 *
 * WHY: findCodexPathByRuntime is a TIMEBOXED search — it only considers files whose
 * mtime is within RECENT_WINDOW_MS (5 min) and whose session_meta timestamp is within
 * SPAWN_BIND_GRACE_MS of this session's spawn. Both conditions are properties of the
 * SEARCH, not of the binding: a session that resolved correctly at minute 2 stops
 * resolving at minute 6 purely because its rollout mtime aged out of the window, even
 * though the file is the same file and still on disk. Every later completion probe
 * then reads null — no transcript, no proof of turn end, and (pre-fix-1) a permanent
 * 'generating' wedge. The other resolution route, the PTY screen scrape for the
 * uuid (extractProviderSessionIdFromScreen), is equally fragile: the header line it
 * matches scrolls away, so the uuid can be lost mid-session too.
 *
 * The memo makes the binding STICKY: once this session has been matched to a rollout
 * file by the strict timing rules, that answer is reused for the session's lifetime
 * and no longer requires re-passing a workspace+timing match it already passed.
 *
 * Safety — the memo can only ever return the SAME file the strict search already
 * accepted for the SAME session identity:
 *   • The key includes sessionStartedAtMs, so two sessions in one workspace (and a
 *     restarted session, which gets a new spawn stamp) never share an entry.
 *   • It is only WRITTEN on a successful strict resolution — it can never invent a
 *     binding the timing rules would have rejected.
 *   • It is invalidated when the file disappears, so a deleted/rotated rollout falls
 *     back to a fresh search rather than pinning a stale path.
 *   • Entries are only kept for keyed (spawn-stamped) sessions; an unkeyed caller
 *     (sessionStartedAtMs <= 0) is unchanged, since it has no identity to pin to.
 */
const codexRuntimeBindings = new Map<string, string>();

function codexRuntimeBindingKey(workspace: string, sessionStartedAtMs: number): string | null {
    if (!workspace || !(sessionStartedAtMs > 0)) return null;
    return `${resolveRealPath(workspace)}::${sessionStartedAtMs}`;
}

/** Test/lifecycle hook: drop a session's sticky codex binding (or all of them). */
export function clearCodexRuntimeBinding(workspace?: string, sessionStartedAtMs?: number): void {
    if (workspace === undefined && sessionStartedAtMs === undefined) {
        codexRuntimeBindings.clear();
        return;
    }
    const key = codexRuntimeBindingKey(workspace || '', sessionStartedAtMs || 0);
    if (key) codexRuntimeBindings.delete(key);
}

function resolveCodexPath(workspace: string, sessionId: string, sessionStartedAtMs: number): string | null {
    // codex stores by UTC date: ~/.codex/sessions/<year>/<month>/<day>/<file>.jsonl
    const root = codexSessionsRoot();
    // An explicit uuid is authoritative BOTH WAYS: a hit binds exactly, and a MISS
    // returns null rather than falling through to the runtime search. The caller
    // named a specific session; resolving some other file for it is precisely the
    // "previous chat shows up before I type anything" defect (round 9 part b), so a
    // requested-but-absent session must stay unresolved.
    if (sessionId && isUuidLikeSessionId(sessionId)) {
        return findCodexPathBySessionId(root, sessionId);
    }

    // Sticky binding: reuse this session's previously-proven file before re-running
    // the timeboxed search, so an aged-out mtime cannot un-bind a live session.
    const key = codexRuntimeBindingKey(workspace, sessionStartedAtMs);
    if (key) {
        const pinned = codexRuntimeBindings.get(key);
        if (pinned) {
            if (fs.existsSync(pinned)) return pinned;
            codexRuntimeBindings.delete(key); // stale entry — fall through to a fresh search
        }
    }

    const resolved = findCodexPathByRuntime(root, workspace, sessionStartedAtMs);
    if (resolved && key) codexRuntimeBindings.set(key, resolved);
    return resolved;
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
): ResolvedSource | null {
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
            // Exact uuid bind — the caller named this conversation, so it is
            // authoritatively this session's own. Owner-confirmed.
            return { path: dbPath, ownerConfirmed: true };
        }
    }

    // (2) brain/<uuid>/.system_generated/logs/transcript.jsonl (legacy full source).
    //     Only bind to a brain transcript that is NON-EMPTY (antigravity may leave
    //     it 0 bytes when the real data lives in the per-session .db). Exclude any
    //     brain conversation already claimed by a DIFFERENT live session.
    //
    //     Selection MUST mirror pickUnboundConversationDb (step 3): when a spawn
    //     floor is known, a brain dir born at/after the floor is THIS session's own,
    //     and among those the OLDEST-created wins (the store created first after the
    //     session started). The previous newest-by-mtime sort silently mis-bound: in
    //     a MAGI panel every co-located antigravity session (coordinator + replicas)
    //     has a non-empty brain transcript, and the replica that finished its turn
    //     last has the newest mtime — so a coordinator's read grabbed the replica's
    //     transcript here, BEFORE step 3's floor-aware pick could run. That is the
    //     antigravity coordinator↔replica crosswire, and it lives in THIS step, not
    //     step 3. Keep newest-by-mtime only in the floor-less legacy path.
    const brainRoot = path.join(agyRoot, 'brain');
    if (fs.existsSync(brainRoot)) {
        const cutoff = spawnAwareCutoff(sessionStartedAtMs);
        const nonEmptyBrain = (uuid: string, p: string): string | null => {
            const t = path.join(p, '.system_generated', 'logs', 'transcript.jsonl');
            return (fs.existsSync(t) && safeSize(t) > 0) ? t : null;
        };
        const all = fs.readdirSync(brainRoot, { withFileTypes: true })
            .filter(e => e.isDirectory() && isUuidLikeSessionId(e.name))
            .filter(e => !isAntigravityConversationClaimedByOther(e.name, owner))
            .map(e => {
                const p = path.join(brainRoot, e.name);
                return { uuid: e.name, p, mtime: safeMtime(p), birth: safeBirthtime(p) };
            })
            .filter(e => e.mtime >= cutoff);
        let ordered: Array<{ uuid: string; p: string }> = [];
        // Floor branch (sessionStartedAtMs > 0) is birth-confirmed as this
        // session's own store → owner-confirmed. Floor-less newest-by-mtime is a
        // bare recency pick that can alias a co-located session → NOT confirmed.
        const brainOwnerConfirmed = sessionStartedAtMs > 0;
        if (sessionStartedAtMs > 0) {
            // Floor branch: this session's own = born at/after (floor - grace),
            // oldest-birth first. Mirrors pickUnboundConversationDb exactly so the
            // two steps can never resolve DIFFERENT conversations for one session.
            const floor = sessionStartedAtMs - AGY_SPAWN_CLAIM_GRACE_MS;
            ordered = all
                .filter(e => (e.birth > 0 ? e.birth : e.mtime) >= floor)
                .sort((a, b) => (a.birth || a.mtime) - (b.birth || b.mtime));
        } else {
            // Floor-less legacy/unpinned discovery: newest-by-mtime (single-session).
            ordered = [...all].sort((a, b) => b.mtime - a.mtime);
        }
        for (const e of ordered) {
            const t = nonEmptyBrain(e.uuid, e.p);
            if (t) {
                if (owner) claimAntigravityConversation(e.uuid, owner);
                return { path: t, ownerConfirmed: brainOwnerConfirmed };
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
        return { path: picked.path, ownerConfirmed: picked.ownerConfirmed };
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
): { path: string; uuid: string; ownerConfirmed: boolean } | null {
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
        // Birth-time confirmed as this session's own store → owner-confirmed.
        return { path: own[0].path, uuid: own[0].uuid, ownerConfirmed: true };
    }

    // Floor-less newest-by-mtime: a bare recency pick with no per-session
    // guarantee — it can alias a co-located concurrent session, so it is NOT
    // owner-confirmed and must not be pinned/trusted by the read-path callers.
    candidates.sort((a, b) => b.mtime - a.mtime);
    return { path: candidates[0].path, uuid: candidates[0].uuid, ownerConfirmed: false };
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
        case 'grok-cli':        return readGrokCliSession(sourcePath, sessionId, workspace || undefined);
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

/**
 * Enumerator counterpart to `createNativeHistoryDispatcher`.
 *
 * Returns null for readers with no enumerable store, so `provider-loader` leaves
 * `listNativeHistory` unwired for them exactly as before — claude/codex/
 * antigravity/hermes keep whatever listing they already had. Only readers listed
 * here gain `list_saved_sessions`.
 */
export function createNativeHistoryListDispatcher(
    reader: ReaderId,
): ((input: NativeHistoryInput) => unknown) | null {
    if (reader !== 'grok-cli') return null;
    return (input: NativeHistoryInput) => {
        const limitRaw = (input.args as Record<string, unknown> | undefined)?.limit;
        const limit = typeof limitRaw === 'number' && limitRaw > 0 ? Math.floor(limitRaw) : 50;
        // The `list_saved_sessions` caller (collectProviderScriptNativeHistory-
        // SessionSummaries) passes only {agentType, format, watchPath, args} —
        // no workspace. So enumerate EVERY workspace grok has a store for and
        // let the caller filter, rather than returning nothing.
        const sessions = input.workspace
            ? listGrokCliSessions(input.workspace, limit)
            : listGrokCliSessionsAllWorkspaces(limit);
        // Caller reads `result.sessions`; a bare array is silently dropped.
        return { sessions };
    };
}

function normalizeRole(r: any): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
    // daemon's chat schema rejects 'tool'/'function' — surface as assistant.
    if (s === 'tool' || s === 'tool_result' || s === 'function') return 'assistant';
    return 'system';
}
