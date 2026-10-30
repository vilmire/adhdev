/**
 * Spec-aware dispatcher for native conversation history.
 *
 * The existing readers (claude/codex/antigravity/grok) already know
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
import type { NativeHistoryToolBlockRef } from '../spec/native-history-types.js';
import { readSession as readClaudeCliSession } from './claude-cli-transcript.js';
import { codexSessionsRoot, readSession as readCodexCliSession } from './codex-cli-transcript.js';
import { readSession as readAntigravityCliSession } from './antigravity-cli-transcript.js';
import {
    readSession as readGrokCliSession,
    listSessions as listGrokCliSessions,
    listSessionsAllWorkspaces as listGrokCliSessionsAllWorkspaces,
    resolveGrokPath,
} from './grok-cli-transcript.js';
import { hasExclusiveSentInput } from './sent-prompt-registry.js';
import { SPAWN_BIND_GRACE_MS } from './constants.js';
import { readFirstJsonlRecord } from './first-jsonl-record.js';
import {
    antigravityOwnerToken,
    claimAntigravityConversation,
    isAntigravityConversationClaimedByOther,
} from './antigravity-claim-registry.js';
import { isSafeFilename } from './fs-utils.js';
import { isUuidLike } from './transcript-common.js';
import { type MessageSourceAddress, readMessageSourceAddress } from '../../chat/message-source-address.js';

export type ReaderId = 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'grok-cli';

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
    envOverrides?: Record<string, string>;
    format?: string;
    watchPath?: string;
    forceRefresh?: boolean;
    args?: Record<string, unknown>;
}

export interface NativeHistoryResult {
    messages: Array<{
        role: string;
        content: string;
        receivedAt?: number;
        kind?: string;
        workspace?: string;
        /**
         * (TOOL-EXPAND) Content-free address of the tool block this bubble was
         * summarised from, present only when the reader actually truncated it.
         * Stamped by the JSONL readers (claude/codex/grok) and by antigravity's
         * .db path (keyed by steps.idx); absent for hermes, whose sqlite store
         * has no stable record key, which is what lets the dashboard tell
         * "nothing more to fetch" from "not addressable".
         */
        toolBlockRef?: NativeHistoryToolBlockRef;
        /**
         * Display label for a tool/terminal bubble (e.g. 'Tool', 'Terminal', or a
         * provider-supplied sender). Consumed by chat-commands-read-native-
         * normalize.ts to derive meta.label. Set by claude/codex/antigravity/
         * hermes readers on tool/terminal messages; absent otherwise.
         */
        senderName?: string;
        /**
         * The specific tool being invoked (e.g. 'read_file'), when the reader
         * resolves one — distinct from the generic senderName:'Tool'. Currently
         * only antigravity's reader stamps this; other readers fold the tool
         * name into `content` instead.
         */
        toolName?: string;
        bubbleState?: 'final';
        /**
         * Daemon-internal source address for the message identity ledger,
         * stamped by the reader (`chat/message-source-address.ts`). Carried by
         * name like `toolBlockRef`; never leaves the daemon.
         */
        _src?: MessageSourceAddress;
    }>;
    providerSessionId?: string;
    sourcePath: string;
    sourceMtimeMs: number;
    unavailableReason?: string;
    nativeHistoryCoverage?: 'full' | 'partial' | 'best-effort';
    /** True for an accepted authoritative handle or unique full sent-input
     * evidence. Spawn time and claim exclusivity alone never prove ownership. */
    ownerConfirmed?: boolean;
    /**
     * (NATIVE-TURN-SIGNAL) The provider's own turn-terminal records, when its reader
     * surfaces them (codex task_complete / turn_aborted). Absent for readers that have
     * no such record — those keep the message-shape inference path.
     */
    turnTerminalMarkers?: NativeTurnTerminalMarker[];
}

/**
 * One reader record → one `NativeHistoryMessage`.
 *
 * @message-projection l3 ref
 *
 * `ref` sub-lane, not `identity`: this projection's declared output contract is
 * `NativeHistoryMessage` (native-history-types.ts), which has no identity fields
 * at ALL. Requiring them here would demand fields the type does not have — the
 * bubble identity a message carries downstream is minted after this hop.
 *
 * This is the FIRST hop of every native-history read, so a field dropped here is
 * unrecoverable: the activeChat and persisted-tail remaps downstream can only
 * carry what they are handed.
 */
function toNativeHistoryMessage(m: any, workspace: string): NativeHistoryResult['messages'][number] {
    return {
        role: normalizeRole(m.role),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        receivedAt: typeof m.receivedAt === 'number' ? m.receivedAt : Date.parse(m.timestamp || '') || Date.now(),
        kind: typeof m.kind === 'string' ? m.kind : 'standard',
        ...(m.bubbleState === 'final' ? { bubbleState: 'final' as const } : {}),
        workspace: typeof m.workspace === 'string' ? m.workspace : workspace || undefined,
        // (TOOL-EXPAND) Forward the reader's ref. This projection is an
        // allow-list, so a ref the reader stamped is dropped here unless
        // named explicitly — which is why it is validated rather than
        // spread: a malformed ref reaching the dashboard would render an
        // expand button that can only ever fail.
        ...(isToolBlockRef(m.toolBlockRef) ? { toolBlockRef: m.toolBlockRef } : {}),
        // Every native-history reader (claude/codex/antigravity/grok) may
        // stamp senderName (display label for tool/terminal bubbles — see
        // chat-commands-read-native-normalize.ts's meta.label derivation) and,
        // for readers that resolve a specific tool call (currently antigravity),
        // toolName (the actual tool being invoked, e.g. "read_file" — distinct
        // from the generic senderName:'Tool'). Same allow-list style as
        // toolBlockRef above: named explicitly rather than spread, so an
        // unrelated property on the reader's internal record never rides this
        // wire by accident.
        ...(typeof m.senderName === 'string' && m.senderName ? { senderName: m.senderName } : {}),
        ...(typeof m.toolName === 'string' && m.toolName ? { toolName: m.toolName } : {}),
        // The reader's source address for the message identity ledger. Same
        // allow-list rule: re-read shape-checked, never spread.
        ...(() => {
            const src = readMessageSourceAddress(m._src);
            return src ? { _src: src } : {};
        })(),
    };
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
        const homeDir = typeof input.envOverrides?.HOME === 'string' && input.envOverrides.HOME.trim()
            ? input.envOverrides.HOME.trim()
            : undefined;
        const resolved = resolveSourcePath(reader, workspace, sessionId, sessionStartedAtMs, instanceId, requestedProviderSid, homeDir);
        const sourcePath = resolved?.path || null;
        if (!sourcePath) return null;
        // Owner-confirmation only meaningful for antigravity (see resolveAntigravityPath).
        // For other readers the file was resolved by exact per-session key already;
        // leave the flag undefined so the read-path callers treat them as before.
        let ownerConfirmed = reader === 'antigravity-cli' ? resolved?.ownerConfirmed === true : undefined;
        if (input.forceRefresh === true || input.args?.forceRefresh === true) {
            try { fs.statSync(sourcePath); } catch { /* best-effort metadata refresh */ }
        }

        const readSessionId = reader === 'antigravity-cli'
            ? extractAntigravityConversationUuid(sourcePath) || sessionId
            : sessionId;
        const session = readByReader(reader, sourcePath, readSessionId, workspace);
        if (!session) return null;
        if (reader === 'codex-cli' && !requestedProviderSid && !isUuidLike(sessionId) && instanceId) {
            ownerConfirmed = !!instanceId && sessionStartedAtMs > 0
                && hasExclusiveSentInput(instanceId, session.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content));
            if (!ownerConfirmed) return { messages: [], sourcePath: '', sourceMtimeMs: 0,
                ownerConfirmed: false, unavailableReason: 'native_owner_unverified' };
        }

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
            messages: session.messages.map((m: any) => toNativeHistoryMessage(m, workspace)),
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

function resolveSourcePath(reader: ReaderId, workspace: string, sessionId: string, sessionStartedAtMs: number, instanceId: string, providerSessionId: string, homeDir?: string): ResolvedSource | null {
    switch (reader) {
        case 'claude-cli':   { const p = resolveClaudePath(workspace, sessionId); return p ? { path: p } : null; }
        case 'codex-cli':    { const p = resolveCodexPath(workspace, sessionId, sessionStartedAtMs, instanceId, homeDir); return p ? { path: p } : null; }
        case 'antigravity-cli': return resolveAntigravityPath(workspace, providerSessionId || sessionId, sessionStartedAtMs, instanceId, !providerSessionId, homeDir);
        // grok stores per-cwd like claude, but keyed by the url-encoded cwd and
        // with the uuid as a DIRECTORY (…/<uuid>/chat_history.jsonl) rather than
        // the filename, so resolution lives in the reader module.
        case 'grok-cli':     { const p = resolveGrokPath(workspace, sessionId); return p ? { path: p } : null; }
    }
}

/**
 * Exported for the background-task detector (providers/spec): resolve THIS
 * session's antigravity conversation store with the exact same binding,
 * claim-exclusion and sent-input ownership rules the read path uses, so the detector
 * never scans a sibling session's conversation. `sessionId` is the provider
 * session id (the on-disk conversation uuid) when known.
 */
export function resolveAntigravityConversationPath(
    workspace: string,
    sessionId: string,
    sessionStartedAtMs: number,
    instanceId: string,
    options?: { homeDir?: string; allowDiscovery?: boolean },
): { path: string; ownerConfirmed?: boolean } | null {
    return resolveAntigravityPath(
        workspace,
        sessionId,
        sessionStartedAtMs,
        instanceId,
        options?.allowDiscovery ?? true,
        options?.homeDir,
    );
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
    if (key) for (const stored of codexRuntimeBindings.keys()) if (stored.endsWith('\0' + key)) codexRuntimeBindings.delete(stored);
}

function resolveCodexPath(workspace: string, sessionId: string, sessionStartedAtMs: number, instanceId = '', homeDir?: string): string | null {
    // codex stores by UTC date: ~/.codex/sessions/<year>/<month>/<day>/<file>.jsonl
    const root = homeDir ? path.join(homeDir, '.codex', 'sessions') : codexSessionsRoot();
    // An explicit uuid is authoritative BOTH WAYS: a hit binds exactly, and a MISS
    // returns null rather than falling through to the runtime search. The caller
    // named a specific session; resolving some other file for it is precisely the
    // "previous chat shows up before I type anything" defect (round 9 part b), so a
    // requested-but-absent session must stay unresolved.
    if (sessionId && isUuidLike(sessionId)) {
        return findCodexPathBySessionId(root, sessionId);
    }

    // Sticky binding: reuse this session's previously-proven file before re-running
    // the timeboxed search, so an aged-out mtime cannot un-bind a live session.
    const baseKey = codexRuntimeBindingKey(workspace, sessionStartedAtMs);
    const key = baseKey ? [root, instanceId, baseKey].join('\0') : null;
    if (key) {
        const pinned = codexRuntimeBindings.get(key);
        if (pinned) {
            if (fs.existsSync(pinned)) return pinned;
            codexRuntimeBindings.delete(key); // stale entry — fall through to a fresh search
        }
    }

    const resolved = findCodexPathByRuntime(root, workspace, sessionStartedAtMs, instanceId);
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

function findCodexPathByRuntime(root: string, workspace: string, sessionStartedAtMs: number, instanceId: string): string | null {
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
            if (instanceId) {
                const candidate = readCodexCliSession(entryPath);
                if (!candidate || !hasExclusiveSentInput(instanceId, candidate.messages.filter(m => m.role === 'user').map(m => m.content))) continue;
            }
            matches.push({ p: entryPath, mtime, diff });
        }
    }

    if (instanceId && matches.length !== 1) return null;
    matches.sort((a, b) => sessionStartedAtMs > 0
        ? a.diff - b.diff || b.mtime - a.mtime
        : b.mtime - a.mtime);
    return matches[0]?.p ?? null;
}

function readCodexSessionMeta(filePath: string): { cwd?: string; timestampMs?: number } | null {
    try {
        const record = readFirstJsonlRecord(filePath);
        if (!record) return null;
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
    if (baseMatch && isUuidLike(baseMatch[1])) return baseMatch[1];
    // brain/<uuid>/… — the first uuid-like path segment.
    for (const seg of segments) {
        if (isUuidLike(seg)) return seg;
    }
    return '';
}

/** Time only excludes pre-spawn stores; it never establishes attribution. */
const AGY_SPAWN_CLAIM_GRACE_MS = 2000;

function resolveAntigravityPath(
    workspace: string,
    sessionId: string,
    sessionStartedAtMs: number,
    instanceId: string,
    allowDiscovery = true,
    homeDir?: string,
): ResolvedSource | null {
    const baseHome = typeof homeDir === 'string' && homeDir.trim() ? homeDir.trim() : os.homedir();
    const agyRoot = path.join(baseHome, '.gemini', 'antigravity-cli');
    const owner = antigravityOwnerToken(workspace, sessionStartedAtMs, instanceId);
    const brainPath = (uuid: string) => path.join(agyRoot, 'brain', uuid, '.system_generated', 'logs', 'transcript.jsonl');
    const accept = (uuid: string, sourcePath: string): ResolvedSource | null => {
        if (isAntigravityConversationClaimedByOther(uuid, owner)) return null;
        if (owner && !claimAntigravityConversation(uuid, owner)) return null;
        return { path: sourcePath, ownerConfirmed: true };
    };

    // Explicit persisted/provider handles remain authoritative, but never
    // override another live owner's claim. Apply the same rule to both layouts.
    if (sessionId && isUuidLike(sessionId)) {
        const db = path.join(agyRoot, 'conversations', `${sessionId}.db`);
        if (fs.existsSync(db)) return accept(sessionId, db);
        const brain = brainPath(sessionId);
        if (safeSize(brain) > 0) return accept(sessionId, brain);
    }

    if (!allowDiscovery || !owner) return null;
    const candidates = new Map<string, string[]>();
    const add = (uuid: string, sourcePath: string, birthPath: string) => {
        if (sessionStartedAtMs > 0) {
            if (safeBirthtime(birthPath) < sessionStartedAtMs - AGY_SPAWN_CLAIM_GRACE_MS) return;
        } else if (safeMtime(sourcePath) < Date.now() - RECENT_WINDOW_MS) return;
        const paths = candidates.get(uuid) ?? [];
        paths.push(sourcePath);
        candidates.set(uuid, paths);
    };
    const entries = (root: string): fs.Dirent[] => {
        try { return fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    };
    const convRoot = path.join(agyRoot, 'conversations');
    for (const entry of entries(convRoot)) {
        const match = /^([0-9a-f-]+)\.db$/i.exec(entry.name);
        if (!entry.isFile() || !match || !isUuidLike(match[1])) continue;
        const db = path.join(convRoot, entry.name);
        add(match[1].toLowerCase(), db, db);
    }
    const brainRoot = path.join(agyRoot, 'brain');
    for (const entry of entries(brainRoot)) {
        if (!entry.isDirectory() || !isUuidLike(entry.name)) continue;
        const brain = brainPath(entry.name);
        if (safeSize(brain) > 0) add(entry.name.toLowerCase(), brain, path.join(brainRoot, entry.name));
    }

    // Prove identity BEFORE any claim or owner-confirmed result can create a
    // sticky read pin. Check all stores, including claimed siblings: exclusivity
    // cannot turn ambiguous evidence into positive attribution. DB and brain
    // copies of one UUID count as one conversation.
    const matches: Array<{ uuid: string; sourcePath: string }> = [];
    for (const [uuid, paths] of candidates) {
        for (const sourcePath of paths) {
            const session = readAntigravityCliSession(sourcePath, uuid, workspace || undefined);
            const users = session?.messages.filter(m => m.role === 'user').map(m => m.content) ?? [];
            if (!hasExclusiveSentInput(instanceId, users)) continue;
            matches.push({ uuid, sourcePath });
            break;
        }
    }
    if (matches.length !== 1) return null;
    return accept(matches[0].uuid, matches[0].sourcePath);
}

// ────────────────────────────────────────────────────────────────────────────
// Reader dispatch
// ────────────────────────────────────────────────────────────────────────────

function readByReader(
    reader: ReaderId,
    sourcePath: string,
    sessionId: string,
    workspace: string,
): any | null {
    switch (reader) {
        case 'claude-cli':      return readClaudeCliSession(sourcePath);
        case 'codex-cli':       return readCodexCliSession(sourcePath);
        case 'antigravity-cli': return readAntigravityCliSession(sourcePath, sessionId || undefined, workspace || undefined);
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

/** Recent-activity window used by the antigravity/codex resolvers (see their headers). */
const RECENT_WINDOW_MS = 5 * 60 * 1000;

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

/**
 * Shape-check a reader-stamped tool block ref before it leaves the dispatcher.
 *
 * Mirrors `isValidRef` in `spec/tool-block-expand.ts` — the module that will
 * later have to resolve it. Rejecting here rather than at resolve time means an
 * unusable ref never becomes a visible expand affordance in the first place.
 */
function isToolBlockRef(v: unknown): v is NativeHistoryToolBlockRef {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return Number.isFinite(r.sourceMtimeMs)
        && Number.isInteger(r.recordIndex)
        && Number.isInteger(r.blockIndex)
        && (r.recordIndex as number) >= 0
        && (r.blockIndex as number) >= -1;
}

function normalizeRole(r: any): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
    // daemon's chat schema rejects 'tool'/'function' — surface as assistant.
    if (s === 'tool' || s === 'tool_result' || s === 'function') return 'assistant';
    return 'system';
}
