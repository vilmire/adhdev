/**
 * Chat Commands — read side: the native-history read + ownership plumbing
 * shared by read_chat (live adapter and history-only paths) and chat_history:
 * the pin/live/workspace-latest native read, the per-session spawn floor and
 * spawn env, and the safe-mapping (ownership) gate.
 *
 * Split out of chat-commands-read.ts (file-size gate).
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ChatMessage } from '../types.js';
import { flattenContent, type ProviderModule, type ProviderScripts } from '../providers/contracts.js';
import { readProviderChatHistory } from '../config/provider-native-history.js';
import type { CommandHelpers } from './handler.js';
import { getTargetedCliAdapter } from './chat-commands-shared.js';

// Minimum tail floor for hot-path history/mirror reads. The dashboard requests a
// bounded tail (~60); we keep a small floor so a tiny requested tailLimit still
// has enough surrounding context for seed/mirror dedup correctness, but it must
// NOT dominate the hot subscribe/poll path the way the previous 200 floor did.
// readChatHistory now serves this as an O(tail) bounded read, so the cost scales
// with this floor, not with total accumulated history.
export const HOT_TAIL_MIN_LIMIT = 60;
export function normalizeComparableWorkspace(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    // Canonicalize via realpath so symlink aliases compare equal. On macOS
    // `/tmp` is a symlink to `/private/tmp`: a provider whose on-disk workspace
    // record is stored realpath'd (kimi's state.json workDir → `/private/tmp/…`)
    // must still match an ADHDev session workspace passed as `/tmp/…`. Without
    // this the native-history workspace-safety gate (workspace_from_sidecar) saw
    // a false mismatch, marked the read unsafe, and fell back to the PTY parser.
    // realpath throws when the path doesn't exist (e.g. a stale/never-created
    // workspace) — fall back to the lexical resolve then, never crash the read
    // path. Fail-closed cross-workspace safety is preserved: two genuinely
    // different directories still realpath to different paths, and the lexical
    // fallback is unchanged from the prior behaviour.
    const lexical = path.resolve(text);
    try {
        return fs.realpathSync.native(lexical);
    } catch {
        try {
            return fs.realpathSync(lexical);
        } catch {
            return lexical;
        }
    }
}

/** Test hook for the symlink-safe workspace comparison used by the
 *  native-history workspace-safety gate. */
export function __normalizeComparableWorkspaceForTest(value: unknown): string {
    return normalizeComparableWorkspace(value);
}

function getComparableVisibleText(message: ChatMessage | undefined): string {
    if (!message) return '';
    const role = String((message as any).role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'assistant') return '';
    const kind = String((message as any).kind || 'standard').trim().toLowerCase();
    if (kind && kind !== 'standard') return '';
    const content = flattenContent((message as any).content).replace(/\s+/g, ' ').trim();
    return content;
}

function hasOverlappingVisibleConversationText(nativeMessages: ChatMessage[], ptyMessages: ChatMessage[]): boolean {
    const nativeTexts = nativeMessages.map(getComparableVisibleText).filter(Boolean);
    const ptyTexts = ptyMessages.map(getComparableVisibleText).filter(Boolean);
    if (nativeTexts.length === 0 || ptyTexts.length === 0) return false;
    for (const nativeText of nativeTexts) {
        for (const ptyText of ptyTexts) {
            if (nativeText === ptyText) return true;
            const shorter = nativeText.length <= ptyText.length ? nativeText : ptyText;
            const longer = nativeText.length <= ptyText.length ? ptyText : nativeText;
            if (shorter.length >= 32 && longer.includes(shorter)) return true;
        }
    }
    return false;
}

export function hasSafeNativeHistoryMapping(args: {
    historySessionId?: string;
    providerSessionId?: string;
    workspace?: string;
    nativeMessages: ChatMessage[];
    ptyMessages?: ChatMessage[];
    requireWorkspaceContentOverlap?: boolean;
}): boolean {
    const isCoordinatorTranscript = args.nativeMessages.some((m: any) => {
        const text = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
        return text.includes('mesh_send_task') || text.includes('mesh_status') || text.includes('mesh_read_chat') || text.includes('mesh_launch_session');
    });

    const explicitSessionId = String(args.historySessionId || args.providerSessionId || '').trim();
    if (explicitSessionId) {
        const expectedWorkspace = normalizeComparableWorkspace(args.workspace);
        const declaredWorkspaces = args.nativeMessages
            .map((message: any) => normalizeComparableWorkspace(message?.workspace))
            .filter(Boolean);
        if (
            expectedWorkspace
            && declaredWorkspaces.length > 0
            && !declaredWorkspaces.some((workspace) => workspace === expectedWorkspace)
        ) {
            return false;
        }
        const messageSessionIds = args.nativeMessages
            .map((message: any) => typeof message?.historySessionId === 'string' ? message.historySessionId.trim() : '')
            .filter(Boolean);
        if (messageSessionIds.length > 0) {
            return messageSessionIds.some((id) => id === explicitSessionId);
        }

        // Messages carry no historySessionId — cannot confirm they belong to the requested session.
        // Only allow a coordinator transcript that is also confirmed by the PTY side; otherwise
        // fail closed so a same-workspace session's history is never silently accepted.
        if (isCoordinatorTranscript && args.ptyMessages && args.ptyMessages.length > 0) {
            const ptyHasCoordinator = args.ptyMessages.some((m: any) => {
                const text = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
                return text.includes('mesh_send_task') || text.includes('mesh_status') || text.includes('mesh_read_chat');
            });
            return ptyHasCoordinator;
        }

        // No historySessionId in messages and no coordinator cross-check: fail closed.
        // Workspace-only matching must not override an explicit session identity.
        return false;
    }
    const workspace = String(args.workspace || '').trim();
    if (!workspace) return false;
    const workspaceMatches = args.nativeMessages.some((message: any) => String(message?.workspace || '').trim() === workspace);
    if (!workspaceMatches) return false;

    if (isCoordinatorTranscript && args.ptyMessages && args.ptyMessages.length > 0) {
        const ptyHasCoordinator = args.ptyMessages.some((m: any) => {
            const text = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
            return text.includes('mesh_send_task') || text.includes('mesh_status') || text.includes('mesh_read_chat');
        });
        if (!ptyHasCoordinator) {
            return false;
        }
    }

    if (!args.requireWorkspaceContentOverlap) return true;
    return hasOverlappingVisibleConversationText(args.nativeMessages, args.ptyMessages || []);
}

// Provenance boundary: workspace-only native history lookup is never safe
// because multiple concurrent sessions sharing the same cwd would alias each
// other. historySessionId (the provider-native session key) is required to
// establish ownership. hasSafeNativeHistoryMapping() enforces the same
// invariant after the read; both guards must hold for native history to be used.
/**
 * The session id a native-history read should be scoped to: the explicit
 * targetSessionId when the caller named one (reading a specific/worker
 * session), otherwise the current live session (a self / dashboard read where
 * the current session IS the one being read). getTargetedCliAdapter already
 * uses this same fallback to resolve the adapter; the native-history floor and
 * claim-owner token must use it too. Without the fallback, a self-read arrives
 * with no targetSessionId → the floor collapses to undefined (→0) and the
 * antigravity claim-owner token collapses to '' → pickUnboundConversationDb
 * drops out of its spawn-floor branch into newest-by-mtime and binds whichever
 * conversation .db was written most recently. For an antigravity
 * coordinator that is exactly a co-located worker's .db (the worker finished
 * its turn last), so the coordinator's read cross-wires onto the replica's
 * conversation instead of its own (ANTIGRAVITY coordinator↔replica crosswire).
 */
export function effectiveReadSessionId(h: CommandHelpers, targetSessionId: string | undefined): string {
    const explicit = typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
    if (explicit) return explicit;
    const current = (h.currentSession as any)?.sessionId;
    return typeof current === 'string' ? current.trim() : '';
}

/**
 * Pull the session's spawnedAtMs out of the registry. Native-history
 * file pickers use it as a "files older than this can't be from this
 * session" floor; without it a fresh dashboard view would inherit the
 * previous session's transcript whenever its file happened to be the
 * newest match. Returns undefined when the session isn't registered
 * (e.g. read_chat before the live session was wired up) — the executor
 * treats undefined as "no floor". Resolves the effective session id
 * (targetSessionId or the current live session) so a self-read still gets its
 * real spawn floor rather than 0.
 */
export function sessionStartedAtMsFromRegistry(h: CommandHelpers, targetSessionId: string | undefined): number | undefined {
    const sid = effectiveReadSessionId(h, targetSessionId);
    if (!sid) return undefined;
    const target = h.ctx?.sessionRegistry?.get?.(sid);
    return typeof target?.spawnedAtMs === 'number' ? target.spawnedAtMs : undefined;
}

/**
 * Pull the env vars the daemon set when it spawned this session's CLI, so
 * the native-history reader expands `${VAR}` path templates from the
 * child's view rather than the daemon's.
 *
 * Returns undefined when no SpecCliAdapter is in play (legacy
 * providers / CDP) or when the adapter exposes no spawn env.
 */
export function sessionSpawnEnvFromAdapter(h: CommandHelpers, targetSessionId: string | undefined): Record<string, string> | undefined {
    const adapter = getTargetedCliAdapter(h, { targetSessionId }, undefined);
    if (!adapter || typeof adapter.getRuntimeMetadata !== 'function') return undefined;
    const meta = adapter.getRuntimeMetadata() as Record<string, unknown> | undefined;
    const env = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).spawnedEnv : undefined;
    return env && typeof env === 'object' ? env as Record<string, string> : undefined;
}

export function readCliProviderNativeHistory(agentStr: string, args: {
    canonicalHistory?: ProviderModule['canonicalHistory'];
    historySessionId?: string;
    workspace?: string;
    offset: number;
    limit: number;
    excludeRecentCount: number;
    /** (SEAM) See handleChatHistory — identity cursor, preferred over the count. */
    excludeFromIdentity?: string;
    historyBehavior?: ProviderModule['historyBehavior'];
    scripts?: ProviderScripts;
    excludeInProgressTurn?: boolean;
    sessionStartedAtMs?: number;
    envOverrides?: Record<string, string>;
    // Last provider-native session id previously bound for this mesh session
    // (see lastBoundProviderSessionIdByMeshSession). When historySessionId is
    // empty and no live session can be bound (post-turn read), reuse this pin so
    // the native query runs against the known session instead of fail-closing.
    pinnedProviderSessionId?: string;
    // Opt-in last-resort: when there is no caller session id, no live binding,
    // and NO pin was ever recorded, allow a workspace-scoped read (newest
    // session in state.db with rows for this workspace). Strictly behind the pin
    // — it never fires when pinnedProviderSessionId is set — and still subject to
    // the downstream hasSafeNativeHistoryMapping workspace-overlap gate. Only the
    // read_chat path opts in, and only with a concrete workspace.
    allowWorkspaceLatestFallback?: boolean;
    // ADHDev session id of the reading session (== the session registry's
    // sessionId == the provider instance's instanceId). Threaded to the
    // native-history dispatcher so antigravity's conversation-claim owner token
    // is keyed on this stable identity and matches the instance-side token —
    // without it two concurrent antigravity sessions cross-bind each other's
    // conversation .db.
    instanceId?: string;
    excludeActivity?: boolean; // chat_history's prose-only default — see readProviderChatHistory
}): ReturnType<typeof readProviderChatHistory> & { lookup: 'session' | 'workspace' } {
    const canBindFromLiveSession = !args.historySessionId
        && typeof args.sessionStartedAtMs === 'number'
        && args.sessionStartedAtMs > 0
        && typeof args.workspace === 'string'
        && args.workspace.trim().length > 0;
    const pinnedProviderSessionId = typeof args.pinnedProviderSessionId === 'string'
        ? args.pinnedProviderSessionId.trim()
        : '';
    // Pin reuse (PRIMARY): a read with no caller-supplied historySessionId can
    // still resolve to the session it was last bound to. Read THAT session
    // directly by threading the pin through as historySessionId — same code path
    // an explicit session read takes — instead of relying on the live spawn/cwd/
    // mtime heuristic. Never overrides a caller-supplied historySessionId; only
    // kicks in when there is none.
    //
    // The pin is preferred EVEN FOR A LIVE SESSION (canBindFromLiveSession).
    // The pin is keyed on this session's own mesh id (getBoundProviderSessionIdPin
    // (targetSessionId)) and holds the provider-native uuid proven in a prior
    // read, so it can only ever resolve to THIS session's own transcript — it
    // cannot alias a concurrent session sharing the cwd. Bypassing the pin while
    // a session is live (the old behaviour) forced the FIRST read of every new
    // turn back onto the spawn/mtime heuristic: cursor's native tail is briefly
    // stale (previous turn) versus the just-echoed PTY user line, so the
    // workspace-overlap safe-mapping gate fails and the read flips to PTY
    // (native_history_not_safely_mapped) before native re-locks. Preferring the
    // pin makes that first read an EXACT-identity lookup (trustedExactNativeIdentity
    // = true), which reads the correct cumulative file AND lets the STICKY-NATIVE
    // hold cover the turn boundary. This is the pin-bypass class fix.
    const effectiveHistorySessionId = args.historySessionId || pinnedProviderSessionId || '';
    // Last-resort workspace-latest (b): only when nothing above resolved a
    // session id AND no pin exists AND the caller opted in with a workspace.
    // Strictly behind pin reuse — pinnedProviderSessionId being set disables it.
    const workspaceLatestFallback = !effectiveHistorySessionId
        && !canBindFromLiveSession
        && !pinnedProviderSessionId
        && args.allowWorkspaceLatestFallback === true
        && typeof args.workspace === 'string'
        && args.workspace.trim().length > 0;
    if (!effectiveHistorySessionId && !canBindFromLiveSession && !workspaceLatestFallback) {
        // No caller session id, no live binding, no known pin, no opted-in
        // workspace-latest. This is the genuinely-unresolvable case — a
        // workspace-only lookup here could alias a concurrent session sharing the
        // cwd, so fail closed as before. The pin/live/workspace-latest paths are
        // all checked AHEAD of this so a resolvable session is never dropped here.
        return {
            messages: [],
            hasMore: false,
            source: 'native-unavailable',
            unavailableReason: 'native_history_workspace_only_lookup_unsafe',
            lookup: 'session',
        } as ReturnType<typeof readProviderChatHistory> & { lookup: 'session' | 'workspace' };
    }
    const sessionHistory = readProviderChatHistory(agentStr, {
        canonicalHistory: args.canonicalHistory,
        historySessionId: effectiveHistorySessionId || undefined,
        workspace: args.workspace,
        offset: args.offset,
        limit: args.limit,
        excludeRecentCount: args.excludeRecentCount,
        excludeFromIdentity: args.excludeFromIdentity,
        historyBehavior: args.historyBehavior,
        scripts: args.scripts as any,
        excludeInProgressTurn: args.excludeInProgressTurn,
        sessionStartedAtMs: args.sessionStartedAtMs,
        envOverrides: args.envOverrides,
        instanceId: args.instanceId,
        excludeActivity: args.excludeActivity,
    });
    const boundProviderSessionId = typeof (sessionHistory as any)?.providerSessionId === 'string'
        ? (sessionHistory as any).providerSessionId.trim()
        : '';
    // A fresh live session can be bound without a provider id when the native
    // reader matched both cwd and session_meta.timestamp to spawnedAtMs. A
    // pin-bound read is always session-scoped (we passed an explicit id).
    return {
        ...(sessionHistory as any),
        lookup: effectiveHistorySessionId || (canBindFromLiveSession && boundProviderSessionId)
            ? 'session'
            : 'workspace',
    };
}
