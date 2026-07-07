/**
 * Chat Commands — read side: handleReadChat, handleChatHistory and the
 * native-history / source-resolution / normalization helpers they use.
 */

import * as path from 'node:path';
import type { CommandResult, CommandHelpers } from './handler.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { flattenContent, type ProviderModule, type ProviderScripts } from '../providers/contracts.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import { isNativeSourceCanonicalHistory, readChatHistory, readProviderChatHistory } from '../config/chat-history.js';
import { clearPersistedProviderSessionPins, loadPersistedProviderSessionPins, recordPersistedProviderSessionPin } from '../config/state-store.js';
import { getCoordinatorForSession } from '../mesh/coordinator-registry.js';
import { LOG } from '../logging/logger.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { hashSignatureParts } from '../chat/chat-signatures.js';
import {
    CHAT_SOURCE_REGISTRY,
    buildV1NativePresentObservation,
    chatSourceSessionKey,
    type ChatSourceDecision,
    type ChatSourceObservation,
    type ChatSourceTransitionCause,
} from '../chat/source-resolver.js';
import type { ChatMessage } from '../types.js';
import { filterUserFacingChatMessages, isActivityChatMessage, isUserFacingChatMessage, normalizeChatMessages } from '../providers/chat-message-normalization.js';
import {
    READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS,
    type RuntimeChatMessageMerger,
    getCurrentProviderType,
    getTargetedCliAdapter,
    getTargetInstance,
    getTargetTransport,
    isCliLikeTransport,
    isExtensionTransport,
    parseMaybeJson,
} from './chat-commands-shared.js';
import { evaluateReadChatNodeWorkspaceScope, resolveTargetSessionActualWorkspace } from './chat-commands-scope.js';

// Minimum tail floor for hot-path history/mirror reads. The dashboard requests a
// bounded tail (~60); we keep a small floor so a tiny requested tailLimit still
// has enough surrounding context for seed/mirror dedup correctness, but it must
// NOT dominate the hot subscribe/poll path the way the previous 200 floor did.
// readChatHistory now serves this as an O(tail) bounded read, so the cost scales
// with this floor, not with total accumulated history.
const HOT_TAIL_MIN_LIMIT = 60;
// (A2.2) CLI_NATIVE_HISTORY_FRESH_MS removed with isNativeHistoryFreshEnough.
// Hardcoded native-transcript provider allow-list. Deprecated. Kept only as a
// last-resort fallback when ProviderModule is not yet loaded; on every hit we
// warn so the dependency on this set is visible. A2 deletes the set entirely
// and routes solely through canonicalHistory.contractVersion +
// isNativeSourceCanonicalHistory().
const CLI_NATIVE_TRANSCRIPT_PROVIDERS = new Set(['codex-cli', 'claude-cli', 'hermes-cli', 'antigravity-cli']);

// Last successfully-bound provider-native session id, keyed by the mesh session
// id (targetSessionId) the read was scoped to. The live pin lives on the
// CliProviderInstance and is torn down when the turn ends; a *post-turn* read
// then finds historySessionId empty AND canBindFromLiveSession=false (no live
// spawnedAtMs), so readCliProviderNativeHistory would fail closed with
// native_history_workspace_only_lookup_unsafe and surface providerSessionId=null
// + zero rows even though the transcript is physically present in state.db.
// Persisting the last resolved id here lets that later read reuse the known pin
// and run the native query normally instead of fail-closing. Refreshed on every
// successful bind; never lets an empty id clear a known pin. Keyed by mesh
// session id so pins never alias across distinct sessions sharing a workspace.
//
// The map is ALSO mirrored to disk (state.json sessionProviderSessionPins) so a
// pin survives a daemon restart. Without that, an attach-restored antigravity
// session (spawnedAtMs=0, so no live spawn floor) that has sat idle past the
// native reader's recency window can no longer resolve its own conversation .db
// after the daemon comes back — read_chat falls to the PTY parse and the
// dashboard shows the user prompt with the assistant tail missing
// (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP). The in-memory map stays the hot path;
// disk is the cold-start hydration source, read lazily on the first miss.
const lastBoundProviderSessionIdByMeshSession = new Map<string, string>();
let persistedProviderSessionPinsHydrated = false;

function hydratePersistedProviderSessionPinsOnce(): void {
    if (persistedProviderSessionPinsHydrated) return;
    persistedProviderSessionPinsHydrated = true;
    try {
        for (const [key, value] of Object.entries(loadPersistedProviderSessionPins())) {
            // Never let a stale persisted value clobber a fresher in-memory bind
            // recorded earlier this process lifetime.
            if (!lastBoundProviderSessionIdByMeshSession.has(key)) {
                lastBoundProviderSessionIdByMeshSession.set(key, value);
            }
        }
    } catch {
        // Best-effort: a missing/corrupt state file just means no cold-start pins.
    }
}

function recordBoundProviderSessionId(h: CommandHelpers, meshSessionId: string | undefined, providerSessionId: string | undefined): void {
    const key = typeof meshSessionId === 'string' ? meshSessionId.trim() : '';
    const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
    if (!key || !value) return;
    // SSOT: the session registry entry (keyed by sessionId == instanceId) is the
    // authoritative sessionId → conversation-uuid record. Writing it here — the
    // moment a native read resolves the real conversation id — makes
    // getHistorySessionId return it directly on every subsequent read, so the
    // conversation is exact-bound instead of re-resolved by the spawn-floor/mtime
    // heuristic (the crosswire/theft source). The pin below stays as the durable
    // cross-restart mirror (the registry is in-memory and cleared on restart).
    try { h.ctx?.sessionRegistry?.setProviderSessionId?.(key, value); } catch { /* best-effort SSOT write-back */ }
    lastBoundProviderSessionIdByMeshSession.set(key, value);
    // Always attempt the disk mirror — recordPersistedProviderSessionPin is itself a
    // no-op when the ON-DISK value already matches, so it does not rewrite state.json
    // on steady re-reads, yet it still lands a pin the in-memory map already holds but
    // disk lost (a prior write clobbered by another state-store writer, or a restart
    // whose hydration ran before this bind). Gating on the in-memory previous value
    // let the in-memory and on-disk pin diverge permanently, defeating the persistence.
    try { recordPersistedProviderSessionPin(key, value); } catch { /* best-effort disk mirror */ }
}

function getBoundProviderSessionIdPin(meshSessionId: string | undefined): string | undefined {
    const key = typeof meshSessionId === 'string' ? meshSessionId.trim() : '';
    if (!key) return undefined;
    hydratePersistedProviderSessionPinsOnce();
    const pinned = lastBoundProviderSessionIdByMeshSession.get(key);
    return pinned && pinned.trim() ? pinned.trim() : undefined;
}

/**
 * Test-only: clear the in-memory read-pin map and re-arm cold-start hydration so
 * each test starts from a clean pin state. The on-disk mirror is isolated per
 * test process via ADHDEV_CONFIG_DIR (test/helpers/setup-env.ts); this resets the
 * module-level cache that would otherwise leak a pin across tests sharing the
 * worker. Not part of the runtime contract.
 */
export function __resetProviderSessionPinsForTest(): void {
    lastBoundProviderSessionIdByMeshSession.clear();
    persistedProviderSessionPinsHydrated = false;
    try { clearPersistedProviderSessionPins(); } catch { /* best-effort */ }
}

/**
 * Test-only: read the in-memory read-pin (the mesh-session → conversation-uuid
 * bind recorded by recordBoundProviderSessionId and mirrored to state.json
 * sessionProviderSessionPins). Lets the antigravity-coordinator-pin tests assert
 * that an owner-confirmed workspace-latest read recorded the pin — and that a
 * non-owner-confirmed read did NOT. Not part of the runtime contract.
 */
export function __getProviderSessionPinForTest(meshSessionId: string): string | undefined {
    return getBoundProviderSessionIdPin(meshSessionId);
}

const warnedLegacyNativeAllowlistHits = new Set<string>();
function warnLegacyNativeAllowlistHit(providerType: string): void {
    if (warnedLegacyNativeAllowlistHits.has(providerType)) return;
    warnedLegacyNativeAllowlistHits.add(providerType);
    // eslint-disable-next-line no-console
    console.warn(
        `[chat-commands] supportsCliNativeTranscript fell back to the hardcoded `
        + `CLI_NATIVE_TRANSCRIPT_PROVIDERS set for "${providerType}". `
        + `The provider module was unavailable or did not declare canonicalHistory. `
        + `Set canonicalHistory.contractVersion in the provider.json to remove this dependency.`,
    );
}
function getExplicitHistorySessionId(args: any): string | undefined {
    const explicit = typeof args?.historySessionId === 'string' ? args.historySessionId.trim() : '';
    if (explicit) return explicit;

    const explicitProviderSessionId = typeof args?.providerSessionId === 'string' ? args.providerSessionId.trim() : '';
    if (explicitProviderSessionId) return explicitProviderSessionId;

    return undefined;
}

/**
 * A native-history session id is a "runtime fallback" — the daemon's own
 * ADHDev session id (targetSessionId) standing in for a real provider-native
 * conversation uuid — when it exactly equals targetSessionId. For an
 * antigravity coordinator (agy takes no --session-id, so its providerSessionId
 * never surfaces to the web), getConversationHistorySessionId falls back to the
 * ADHDev sessionId, and the browser then sends that runtime id back as
 * args.historySessionId. That id is NOT the on-disk conversations/<uuid>.db
 * name (e.g. targetSessionId 28c530af vs stamped conv uuid 07f6ed3e), so a
 * native read keyed on it can never exact-bind — it fail-closes to pty-parser
 * (user-echo only) AND bypasses the owner-confirmed pin/live-bind resolution
 * (which only runs when historySessionId is empty). Detect it whether it
 * arrived EXPLICITLY (args.historySessionId === targetSessionId, the browser's
 * poisoned read) OR only via getHistorySessionId's internal fallback (empty
 * args), and in both cases treat historySessionId as ABSENT so the owner-
 * confirmed native resolution engages and returns [user, assistant, ...].
 * A REAL, DISTINCT provider conv uuid (≠ targetSessionId) is never a runtime
 * fallback and must still exact-bind as before.
 */
function isRuntimeFallbackHistorySessionId(
    candidateHistorySessionId: string | undefined,
    targetSessionId: string | undefined,
): boolean {
    const target = typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
    if (!target) return false;
    const candidate = typeof candidateHistorySessionId === 'string' ? candidateHistorySessionId.trim() : '';
    return candidate === target;
}
function getHistorySessionId(h: CommandHelpers, args: any): string | undefined {
    const explicit = getExplicitHistorySessionId(args);
    if (explicit) return explicit;

    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId) return undefined;

    const session = h.ctx.sessionRegistry?.get(targetSessionId) as any;
    const registeredProviderSessionId = typeof session?.providerSessionId === 'string' ? session.providerSessionId.trim() : '';
    if (registeredProviderSessionId) return registeredProviderSessionId;

    const instance = getTargetInstance(h, args);
    const state = instance?.getState?.();
    const providerSessionId = typeof state?.providerSessionId === 'string' ? state.providerSessionId.trim() : '';
    if (providerSessionId) return providerSessionId;

    const currentSession = h.currentSession as any;
    if (currentSession?.sessionId === targetSessionId) {
        const currentProviderSessionId = typeof currentSession.providerSessionId === 'string'
            ? currentSession.providerSessionId.trim()
            : '';
        if (currentProviderSessionId) return currentProviderSessionId;
    }

    return targetSessionId;
}

function resolveCliNativeHistorySessionId(args: any, currentHistorySessionId: string | undefined, parsedProviderSessionId: string | undefined): string | undefined {
    const explicit = getExplicitHistorySessionId(args);
    if (explicit) return explicit;

    const parsed = typeof parsedProviderSessionId === 'string' ? parsedProviderSessionId.trim() : '';
    const current = typeof currentHistorySessionId === 'string' ? currentHistorySessionId.trim() : '';
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';

    // getHistorySessionId falls back to the runtime session id when no native
    // handle has been registered yet. For live CLI adapters the parser may
    // already know the provider-native handle; prefer it over the runtime id so
    // exact native reads do not miss the worker transcript and fall back to PTY
    // or same-workspace history.
    if (parsed && (!current || current === targetSessionId)) return parsed;
    return current || parsed || undefined;
}

function shouldSkipLiveCliNativeHistoryWithoutProviderSession(args: {
    adapter?: CliAdapter | null;
    providerType?: string;
    readChatArgs: any;
    nativeHistorySessionId?: string;
    parsedProviderSessionId?: string;
}): boolean {
    const explicit = getExplicitHistorySessionId(args.readChatArgs);
    if (explicit) return false;

    const targetSessionId = typeof args.readChatArgs?.targetSessionId === 'string'
        ? args.readChatArgs.targetSessionId.trim()
        : '';
    if (!targetSessionId) return false;

    const resolved = typeof args.nativeHistorySessionId === 'string'
        ? args.nativeHistorySessionId.trim()
        : '';
    if (!resolved || resolved !== targetSessionId) return false;

    const parsed = typeof args.parsedProviderSessionId === 'string'
        ? args.parsedProviderSessionId.trim()
        : '';
    if (parsed) return false;

    const cliType = args.adapter?.cliType || args.providerType || '';
    if (cliType !== 'codex-cli') return false;

    // A live Codex session starts with only the daemon runtime UUID. That UUID
    // is not the provider-native rollout id, so using it for native history
    // lets the file picker fall back to the newest same-workspace transcript
    // and makes concurrent fresh sessions all show the same old conversation.
    return !!args.adapter;
}

function getInteractionId(args: any): string | undefined {
    return typeof args?._interactionId === 'string' && args._interactionId.trim()
        ? args._interactionId.trim()
        : undefined;
}

function traceProviderEvent(
    args: any,
    category: 'provider' | 'parser',
    stage: string,
    options: {
        h: CommandHelpers;
        provider?: ProviderModule;
        payload?: Record<string, unknown>;
        level?: 'debug' | 'info' | 'warn' | 'error';
    },
): void {
    recordDebugTrace({
        interactionId: getInteractionId(args),
        category,
        stage,
        level: options.level || 'info',
        sessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId : options.h.currentSession?.sessionId,
        providerType: options.provider?.type || options.h.currentProviderType || options.h.currentSession?.providerType,
        payload: options.payload,
    });
}
function normalizeReadChatTailLimit(args: any): number {
    const value = Number(args?.tailLimit || 0);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeReadChatMessages(payload: Record<string, any>): ChatMessage[] {
    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    return normalizeChatMessages(messages);
}

function getMessageNewestReceivedAt(messages: Array<{ receivedAt?: unknown; timestamp?: unknown }>): number {
    let newest = 0;
    for (const message of messages) {
        const receivedAt = Number(message?.receivedAt ?? message?.timestamp ?? 0);
        if (Number.isFinite(receivedAt) && receivedAt > newest) newest = receivedAt;
    }
    return newest;
}

function readHistorySessionIdFromMessages(messages: ChatMessage[]): string | undefined {
    for (const message of messages as Array<ChatMessage & { historySessionId?: unknown }>) {
        const historySessionId = typeof message?.historySessionId === 'string' ? message.historySessionId.trim() : '';
        if (historySessionId) return historySessionId;
    }
    return undefined;
}

function shouldPreserveNativeIdentity(providerType: string, sessionId: string, message: ChatMessage): boolean {
    const providerUnitKey = typeof message.providerUnitKey === 'string' ? message.providerUnitKey.trim() : '';
    const turnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
    if (!providerUnitKey) return false;
    // (A2.3) v2 stamped identity is producer-owned and globally stable; trust it
    // unconditionally. Producers may omit _turnKey (the daemon recomputes it
    // from the current ordering), so do not require turnKey for v2 messages.
    if (providerUnitKey.startsWith('v2:') || providerUnitKey.startsWith('v2-pty:')) {
        return true;
    }
    // v1 identity always required both keys to be present.
    if (!turnKey) return false;
    if (providerType === 'hermes-cli' && sessionId) {
        return providerUnitKey.startsWith(`${providerType}:native:${sessionId}:`)
            && turnKey.startsWith(`${providerType}:native-turn:${sessionId}:`);
    }
    return true;
}

/**
 * Drop the synthetic "user" message some CLIs surface in their native
 * transcript when the daemon injects a coordinator system prompt
 * (codex puts the AGENTS.md / developer_instructions block in as
 * role=user; agy/claude/hermes have similar artifacts). The user can
 * opt back into seeing it via the provider setting
 * `showCoordinatorSystemPrompt`. Default is off — the prompt is still
 * fully visible from the chat-header ⓘ "Session info" dialog.
 *
 * Matching rules:
 *   1. Setting must be off (default).
 *   2. There must be a registered coordinator entry for the session.
 *   3. The candidate message is filtered when its role is user OR
 *      system and its content either contains the prompt body verbatim,
 *      OR contains the well-known coordinator marker
 *      `adhdev-mesh-coordinator-prompt`. The marker covers context-file
 *      cases (agy AGENTS.md / gemini GEMINI.md) where the CLI may wrap
 *      its own preamble around our block. Verbatim-content covers
 *      codex's developer_instructions echo.
 *
 * Returns the messages array unchanged when none of the rules match,
 * so this is safe to apply unconditionally to every read_chat result.
 */
function maybeHideCoordinatorPromptMessage(
    h: CommandHelpers,
    providerType: string,
    sessionId: string | undefined,
    messages: ChatMessage[],
): ChatMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (!sessionId) return messages;
    const loader = h.ctx?.providerLoader;
    if (!loader) return messages;
    let showSetting: unknown = undefined;
    try {
        showSetting = (loader as any).getSettingValue?.(providerType, 'showCoordinatorSystemPrompt');
    } catch { /* unknown setting key for this provider — fall through */ }
    if (showSetting === true) return messages;
    const coord = getCoordinatorForSession(sessionId);
    if (!coord) return messages;
    const promptBody = typeof coord.systemPrompt === 'string' ? coord.systemPrompt : '';
    const MARKER = 'adhdev-mesh-coordinator-prompt';
    const filtered = messages.filter(m => {
        const role = String((m as any)?.role || '').toLowerCase();
        if (role !== 'user' && role !== 'system') return true;
        const content = flattenContent((m as any)?.content);
        if (!content) return true;
        if (content.includes(MARKER)) return false;
        if (promptBody && content.includes(promptBody.slice(0, Math.min(400, promptBody.length)))) return false;
        return true;
    });
    if (filtered.length !== messages.length) {
        LOG.debug('ChatFilter', `[${providerType}] hid ${messages.length - filtered.length} coordinator-prompt message(s) from ${sessionId}`);
    }
    return filtered;
}

/**
 * Convenience wrapper used at every native-history call site: normalize +
 * conditionally drop the coordinator system-prompt message. Avoids
 * duplicating the filter at four read_chat code paths.
 */
function normalizeAndFilterNativeHistory(
    h: CommandHelpers,
    providerType: string,
    args: any,
    messages: ChatMessage[],
    nativeSessionId?: string,
): ChatMessage[] {
    const normalized = normalizeNativeHistoryMessages(providerType, messages, nativeSessionId);
    const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId
        : typeof args?.sessionId === 'string' ? args.sessionId
        : undefined;
    return maybeHideCoordinatorPromptMessage(h, providerType, sessionId, normalized);
}

function normalizeNativeHistoryMessages(providerType: string, messages: ChatMessage[], nativeSessionId?: string): ChatMessage[] {
    let turnIndex = 0;
    return normalizeChatMessages(messages).map((message, index) => {
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        const kind = typeof message.kind === 'string' && message.kind.trim() ? message.kind.trim() : (role === 'system' ? 'system' : 'standard');
        if ((role === 'user' || role === 'human') && index > 0) turnIndex += 1;
        const historySessionId = typeof (message as any).historySessionId === 'string'
            ? (message as any).historySessionId.trim()
            : '';
        const contentHash = hashSignatureParts([
            providerType,
            historySessionId,
            String(message.receivedAt || message.timestamp || index),
            role,
            kind,
            flattenContent(message.content),
        ]).slice(0, 12);
        const nativeIdentitySessionId = historySessionId || (typeof nativeSessionId === 'string' ? nativeSessionId.trim() : '');
        const preserveNativeIdentity = shouldPreserveNativeIdentity(providerType, nativeIdentitySessionId, message);
        const existingProviderUnitKey = typeof message.providerUnitKey === 'string' ? message.providerUnitKey.trim() : '';
        const existingTurnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
        const providerUnitKey = preserveNativeIdentity
            ? existingProviderUnitKey
            : `${providerType}:native:${nativeIdentitySessionId || 'workspace'}:${index}:${role || 'message'}:${kind}:${contentHash}`;
        const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : undefined;
        const isSystemSessionStart = role === 'system' || kind === 'system' || kind === 'session_start';
        const isActivity = role === 'assistant' && (kind === 'tool' || kind === 'terminal' || kind === 'thought');
        // (A2.3) sequence emit. Producer-supplied wins (v2-stamped messages
        // bring their own monotonic sequence); otherwise derive from
        // receivedAt/timestamp; otherwise positional. Always present on the
        // output so consumers (ChatSourceMachine) have a stable ordering key.
        const existingSequence = typeof (message as any).sequence === 'number'
            && Number.isFinite((message as any).sequence)
                ? (message as any).sequence
                : null;
        const tsCandidate = Number(message.receivedAt || message.timestamp || 0);
        const sequence = existingSequence !== null
            ? existingSequence
            : (tsCandidate > 0 ? tsCandidate : index);
        return {
            ...message,
            role: role === 'human' ? 'user' : (role || 'assistant'),
            kind: isSystemSessionStart ? 'system' : kind,
            ...(nativeIdentitySessionId ? { historySessionId: nativeIdentitySessionId } : {}),
            providerUnitKey,
            bubbleId: typeof message.bubbleId === 'string' && message.bubbleId.trim()
                && preserveNativeIdentity
                ? message.bubbleId.trim()
                : `bubble:${providerUnitKey}`,
            sequence,
            _turnKey: preserveNativeIdentity
                ? existingTurnKey
                : `${providerType}:native-turn:${nativeIdentitySessionId || 'workspace'}:${turnIndex}`,
            bubbleState: message.bubbleState || 'final',
            ...(isSystemSessionStart ? {
                visibility: message.visibility || 'hidden',
                transcriptVisibility: message.transcriptVisibility || 'hidden',
                audience: message.audience || 'internal',
                source: message.source || 'runtime_status',
            } : isActivity ? {
                source: message.source || (kind === 'terminal' ? 'terminal_command' : 'tool_call'),
                meta: { ...meta, label: message.senderName || meta?.label || (kind === 'terminal' ? 'Terminal' : 'Tool') },
            } : {
                source: message.source || (role === 'assistant' ? 'assistant_text' : undefined),
            }),
        } as ChatMessage;
    });
}

function buildCliMessageSourceProvenance(args: {
    selected: 'native-history' | 'pty-parser';
    provider: string;
    nativeHandle?: string;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    transcriptWorkspace?: string;
    fallbackReason?: string;
    nativeSource?: string;
    sourcePath?: string;
    sourceMtimeMs?: number;
    nativeHistoryCoverage?: string;
    partialReason?: string;
    unavailableReason?: string;
    nativeMessages?: ChatMessage[];
    ptyMessages?: ChatMessage[];
    returnedMessages?: ChatMessage[];
    safeMapping?: boolean;
    freshEnough?: boolean;
    ptyStatusApprovalOnly?: boolean;
}): Record<string, unknown> {
    const sourceMtimeMs = Number(args.sourceMtimeMs || 0);
    const sourceMtimeAgeMs = sourceMtimeMs > 0 ? Math.max(0, Date.now() - sourceMtimeMs) : undefined;
    const nativeMessages = args.nativeMessages || [];
    const ptyMessages = args.ptyMessages || [];
    const returnedMessages = args.returnedMessages || [];
    const identityStatus = args.selected === 'native-history'
        ? 'safe'
        : args.fallbackReason === 'native_history_not_safely_mapped'
            ? 'ambiguous_session_identity'
            : args.fallbackReason?.startsWith('native_history_unavailable')
                ? 'transcript_unmapped'
                : undefined;
    return {
        selected: args.selected,
        provider: args.provider,
        providerType: args.provider,
        ...(identityStatus ? { identityStatus } : {}),
        ...(args.nativeHandle ? { nativeHandle: args.nativeHandle } : {}),
        ...(args.nativeHandle ? { nativeSessionId: args.nativeHandle } : {}),
        ...(args.sessionWorkspace ? { sessionWorkspace: args.sessionWorkspace } : {}),
        ...(args.intendedWorkspace ? { intendedWorkspace: args.intendedWorkspace } : {}),
        ...(args.transcriptWorkspace ? { transcriptWorkspace: args.transcriptWorkspace } : {}),
        ...(args.fallbackReason ? { fallbackReason: args.fallbackReason } : {}),
        ...(args.nativeSource ? { nativeSource: args.nativeSource } : {}),
        ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
        ...(args.nativeHistoryCoverage ? { nativeHistoryCoverage: args.nativeHistoryCoverage } : {}),
        ...(args.partialReason ? { partialReason: args.partialReason } : {}),
        ...(args.unavailableReason ? { unavailableReason: args.unavailableReason } : {}),
        ptyStatusApprovalOnly: args.ptyStatusApprovalOnly === true,
        staleness: {
            sourceMtimeMs: sourceMtimeMs || undefined,
            sourceMtimeAgeMs,
            nativeNewestMessageAt: getMessageNewestReceivedAt(nativeMessages),
            ptyNewestMessageAt: getMessageNewestReceivedAt(ptyMessages),
            freshEnough: args.freshEnough === true,
        },
        coverage: {
            nativeMessageCount: nativeMessages.length,
            ptyMessageCount: ptyMessages.length,
            returnedMessageCount: returnedMessages.length,
            safeMapping: args.safeMapping === true,
            // true when PTY message bodies are suppressed and must not be treated as
            // chat content. PTY may still contribute status/approval/screen evidence.
            ptyMessagesSuppressed: args.selected === 'native-history' || args.ptyStatusApprovalOnly === true,
        },
    };
}

/**
 * Map a ChatSourceMachine transition cause back to the v1 messageSource
 * `fallbackReason` vocabulary so legacy consumers (web-cloud, tests, mesh
 * debug bundles) keep parsing strings they already know. A3 replaces the
 * caller surface with stateTransition/lockState, after which this map can be
 * deleted.
 *
 * Returns undefined when the cause does not correspond to a fallback (i.e.
 * the source is native-history and there is nothing to explain).
 */
function causeToLegacyFallbackReason(
    cause: ChatSourceTransitionCause,
    selected: 'native-history' | 'pty-parser',
    extraDetail?: { unavailableReason?: string; nativeSource?: string },
): string | undefined {
    if (selected === 'native-history') return undefined;
    switch (cause) {
        case 'initial':
            return 'native_history_not_checked';
        case 'native_progressed':
            // Selected pty-parser despite a progressed observation — that
            // means we held PtyOnly stickily (peak unmet or non-superset).
            return 'native_history_not_selected';
        case 'native_regressed_shrunk':
            return 'native_history_empty';
        case 'native_regressed_unsafe_mapping':
            return 'native_history_not_safely_mapped';
        case 'native_regressed_coverage_partial':
            return 'native_history_partial';
        case 'native_regressed_coverage_unavailable':
            return 'native_history_unavailable';
        case 'native_unavailable_read_error':
            return extraDetail?.unavailableReason
                ? `native_history_unavailable:${extraDetail.unavailableReason}`
                : 'native_history_unavailable';
        case 'native_unavailable_provider_unsupported':
            return 'provider_native_transcript_not_supported';
        case 'native_unavailable_empty':
            return 'native_history_empty';
        case 'native_unavailable_not_native_source':
            return extraDetail?.nativeSource
                ? `native_history_source_${extraDetail.nativeSource}`
                : 'native_history_unavailable';
    }
}

/**
 * Translate a native-history fetch result + provider/adapter context into a
 * ChatSourceObservation and drive ChatSourceRegistry. Returns the decision
 * together with the legacy messageSource payload so call sites can produce
 * a v1-compatible response without duplicating the registry plumbing.
 *
 * This is the replacement for the 300-line if-ladder that previously lived
 * inline in handleReadChat. It is intentionally split out for two reasons:
 * (1) we will call it from two places (CLI adapter branch + history-only
 * branch) instead of duplicating the ladder, (2) tests can drive it with
 * synthetic native-history results to verify the cause→fallbackReason
 * mapping without booting the whole readChat pipeline.
 */
function decideCliReadChatSource(args: {
    providerType: string;
    provider?: ProviderModule;
    sessionId: string;
    nativeHistoryResult: any | null;
    nativeHistoryError?: unknown;
    safeMapping: boolean;
    trustedExactNativeIdentity?: boolean;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    ptyMessages: ChatMessage[];
    ptyStatusApprovalOnly: boolean;
}): {
    decision: ChatSourceDecision;
    messageSource: Record<string, unknown>;
    nativeMessages: ChatMessage[];
    nativeSelected: boolean;
} {
    const supportsNative = supportsCliNativeTranscript(args.providerType, args.provider);
    const observation = buildObservationForCli(args, supportsNative);
    const sessionKey = chatSourceSessionKey(args.providerType, args.sessionId);
    let decision = CHAT_SOURCE_REGISTRY.observe(sessionKey, observation);

    // A restored runtime can briefly expose different native slices while the
    // provider transcript settles (for example, startup/system rows may be
    // filtered after the first read). The source machine correctly treats a
    // shrinking slice as regression, but an exact provider-session lookup with
    // no PTY transcript has no safer fallback. Re-bootstrap only this proven
    // identity so the chat does not disappear after daemon restart.
    if (
        decision.selected === 'pty-parser'
        && args.trustedExactNativeIdentity === true
        && args.safeMapping
        && args.ptyMessages.length === 0
        && observation.kind === 'native_present'
        && observation.coverage !== 'partial'
        && observation.messages.length > 0
    ) {
        CHAT_SOURCE_REGISTRY.clear(sessionKey);
        decision = CHAT_SOURCE_REGISTRY.observe(sessionKey, observation);
    }

    const nativeMessages: ChatMessage[] = observation.kind === 'native_present'
        ? extractNativeMessagesFromResult(args.providerType, args.nativeHistoryResult)
        : [];

    const nativeSource = typeof args.nativeHistoryResult?.source === 'string'
        ? args.nativeHistoryResult.source
        : undefined;
    const sourcePath = typeof args.nativeHistoryResult?.sourcePath === 'string'
        ? args.nativeHistoryResult.sourcePath
        : undefined;
    const sourceMtimeMs = typeof args.nativeHistoryResult?.sourceMtimeMs === 'number'
        ? args.nativeHistoryResult.sourceMtimeMs
        : undefined;
    const coverageHint = typeof args.nativeHistoryResult?.nativeHistoryCoverage === 'string'
        ? args.nativeHistoryResult.nativeHistoryCoverage
        : undefined;
    const partialReason = typeof args.nativeHistoryResult?.partialReason === 'string'
        ? args.nativeHistoryResult.partialReason
        : undefined;
    const unavailableReason = typeof args.nativeHistoryResult?.unavailableReason === 'string'
        ? args.nativeHistoryResult.unavailableReason
        : args.nativeHistoryError
            ? `error:${(args.nativeHistoryError as any)?.message || String(args.nativeHistoryError)}`
            : undefined;
    const nativeHandle = typeof args.nativeHistoryResult?.providerSessionId === 'string'
        ? args.nativeHistoryResult.providerSessionId
        : undefined;
    const transcriptWorkspace = typeof args.nativeHistoryResult?.workspace === 'string'
        ? args.nativeHistoryResult.workspace
        : nativeMessages.map((m: any) => typeof m?.workspace === 'string' ? m.workspace.trim() : '').find(Boolean);

    const fallbackReason = causeToLegacyFallbackReason(decision.transition.cause, decision.selected, {
        unavailableReason,
        nativeSource: nativeSource && nativeSource !== 'provider-native' ? nativeSource : undefined,
    });

    // ptyStatusApprovalOnly: when the machine selected native-history we
    // suppress PTY content so the dashboard does not double-show messages
    // already in the native transcript. When the machine selected
    // pty-parser, PTY is the authoritative source — do NOT suppress it.
    // Callers used to hard-code this to `nativeSelected first = true` which
    // suppressed PTY content even when native was empty/unavailable, leaving
    // the dashboard with zero visible messages (the codex generating/waiting
    // approval stuck state). Trust the machine here, not the caller hint.
    const ptyStatusApprovalOnly = decision.selected === 'native-history'
        ? true
        : args.ptyStatusApprovalOnly;

    const messageSource = buildCliMessageSourceProvenance({
        selected: decision.selected,
        provider: args.providerType,
        nativeHandle,
        sessionWorkspace: args.sessionWorkspace,
        intendedWorkspace: args.intendedWorkspace,
        transcriptWorkspace,
        fallbackReason,
        nativeSource,
        sourcePath,
        sourceMtimeMs,
        nativeHistoryCoverage: coverageHint,
        partialReason,
        unavailableReason,
        nativeMessages,
        ptyMessages: args.ptyMessages,
        returnedMessages: decision.selected === 'native-history' ? nativeMessages : args.ptyMessages,
        safeMapping: args.safeMapping,
        // freshEnough is a v1 concept the machine does not model directly.
        // We surface lockState.locked here so v1 consumers reading
        // staleness.freshEnough still get a meaningful boolean.
        freshEnough: decision.lockState.locked,
        ptyStatusApprovalOnly,
    });

    return {
        decision,
        messageSource,
        nativeMessages,
        nativeSelected: decision.selected === 'native-history',
    };
}

function buildObservationForCli(
    args: {
        providerType: string;
        sessionId: string;
        nativeHistoryResult: any | null;
        nativeHistoryError?: unknown;
        safeMapping: boolean;
    },
    supportsNative: boolean,
): ChatSourceObservation {
    if (!supportsNative) {
        return { kind: 'native_unavailable', reason: 'provider_not_supported' };
    }
    if (args.nativeHistoryError) {
        return { kind: 'native_unavailable', reason: 'read_error' };
    }
    const result = args.nativeHistoryResult;
    if (!result || typeof result !== 'object') {
        return { kind: 'native_unavailable', reason: 'read_error' };
    }
    const source = typeof result.source === 'string' ? result.source : '';
    if (source && source !== 'provider-native') {
        // 'native-unavailable' or other producer-side declined source.
        return { kind: 'native_unavailable', reason: source === 'native-unavailable' ? 'empty' : 'not_native_source' };
    }
    const messages = Array.isArray(result.messages) ? result.messages : [];
    if (messages.length === 0) {
        return { kind: 'native_unavailable', reason: 'empty' };
    }
    const coverage = typeof result.nativeHistoryCoverage === 'string'
        ? result.nativeHistoryCoverage
        : 'tail';
    if (coverage === 'unavailable') {
        return { kind: 'native_unavailable', reason: 'coverage_unavailable' };
    }
    return buildV1NativePresentObservation({
        providerType: args.providerType,
        sessionId: args.sessionId,
        messages,
        coverage: coverage === 'full' || coverage === 'tail' || coverage === 'current-turn' || coverage === 'partial'
            ? coverage
            : 'tail',
        safeMapping: args.safeMapping,
    });
}

function extractNativeMessagesFromResult(providerType: string, result: any): ChatMessage[] {
    if (!result || !Array.isArray(result.messages)) return [];
    return normalizeNativeHistoryMessages(
        providerType,
        result.messages as ChatMessage[],
        typeof result.providerSessionId === 'string' ? result.providerSessionId : undefined,
    );
}

/**
 * ptyStatusApprovalOnly is true when the daemon should treat PTY content as
 * status/approval signal only (not as chat messages). v1 set this to `true`
 * whenever native-history was selected as the source, and `false` otherwise.
 * The machine equivalent: when native is the source we want PTY suppressed.
 */
function primaryPtyApprovalOnlyFor(_cliType: string, nativeSelected: boolean): boolean {
    return nativeSelected;
}

/**
 * Codex-only unsafe-native fallback: when the primary native fetch produced
 * unsafe-mapping data, v1 attempted to recover by reading exact runtime
 * mirror messages, runtime input ACK messages, or by trusting the current-
 * runtime PTY when safely attributed. None of this is the machine's
 * responsibility — the machine already decided pty-parser. This helper
 * preserves the daemon-side message selection and annotates messageSource.
 */
function applyUnsafeNativeDaemonFallback(args: {
    providerType: string;
    adapter: CliAdapter;
    helpers: CommandHelpers;
    readChatArgs: any;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    ptyMessages: ChatMessage[];
    nativeHistoryLimit: number;
    provider?: ProviderModule;
    messageSourceRef: { set(value: Record<string, unknown>): void; get(): Record<string, unknown> };
    apply(selection: {
        messages: ChatMessage[];
        transcriptAuthority?: 'provider' | 'daemon';
        coverage?: 'full' | 'tail' | 'current-turn';
        status?: string;
    }): void;
    activeModal: unknown;
    returnedStatus: string;
    coverage?: 'full' | 'tail' | 'current-turn';
}): void {
    if (args.adapter.cliType !== 'codex-cli') {
        // Only codex-cli had v1 daemon mirror recovery. Other providers skip.
        return;
    }
    const ms = args.messageSourceRef.get();
    const fallbackReason = typeof ms.fallbackReason === 'string' ? ms.fallbackReason : '';
    if (!isUnsafeNativeTranscriptFallback(fallbackReason)) {
        return;
    }
    const safeCurrentRuntimePtyMessages = isCurrentRuntimePtySafelyAttributed({
        adapter: args.adapter,
        helpers: args.helpers,
        readChatArgs: args.readChatArgs,
        sessionWorkspace: args.sessionWorkspace,
        intendedWorkspace: args.intendedWorkspace,
        ptyMessages: args.ptyMessages,
    });
    if (safeCurrentRuntimePtyMessages) {
        args.apply({
            messages: args.ptyMessages,
            transcriptAuthority: 'daemon',
            coverage: args.coverage || 'current-turn',
            status: args.returnedStatus,
        });
        const next = { ...ms, selectedDaemonSource: 'current-runtime-pty', transcriptAuthority: 'daemon', runtimeMappingSafe: true };
        args.messageSourceRef.set(next);
        return;
    }
    const safeRuntimeAckMessages = selectRuntimeInputAckMessages(args.ptyMessages);
    if (safeRuntimeAckMessages.length > 0) {
        args.apply({
            messages: safeRuntimeAckMessages,
            transcriptAuthority: 'daemon',
            coverage: 'tail',
            status: coerceUnsafeNativeFallbackStatus(args.returnedStatus, args.activeModal),
        });
        const next = { ...ms, ptyStatusApprovalOnly: true };
        args.messageSourceRef.set(next);
        return;
    }
    const exactRuntimeMirrorMessages = readExactRuntimeMirrorMessages({
        providerType: args.providerType,
        targetSessionId: typeof args.readChatArgs?.targetSessionId === 'string' ? args.readChatArgs.targetSessionId : undefined,
        currentSessionId: typeof (args.helpers.currentSession as any)?.sessionId === 'string' ? (args.helpers.currentSession as any).sessionId : undefined,
        tailLimit: args.nativeHistoryLimit,
        historyBehavior: args.provider?.historyBehavior,
    });
    if (exactRuntimeMirrorMessages.length > 0) {
        args.apply({
            messages: exactRuntimeMirrorMessages,
            transcriptAuthority: 'daemon',
            coverage: 'tail',
            status: coerceUnsafeNativeFallbackStatus(args.returnedStatus, args.activeModal),
        });
        const next = { ...ms, selectedDaemonSource: 'exact-runtime-mirror', transcriptAuthority: 'daemon', ptyStatusApprovalOnly: true };
        args.messageSourceRef.set(next);
        return;
    }
    // No daemon mirror available — keep PTY messages as-is (still pty-parser
    // selection); just coerce status for waiting_approval consistency.
    args.apply({
        messages: args.ptyMessages,
        coverage: args.coverage,
        status: coerceUnsafeNativeFallbackStatus(args.returnedStatus, args.activeModal),
    });
    const next = { ...ms, ptyStatusApprovalOnly: true };
    args.messageSourceRef.set(next);
}

// (A2.2) buildNativeHistoryFallbackReason removed. ChatSourceMachine emits a
// ChatSourceTransitionCause; causeToLegacyFallbackReason maps it back to the
// v1 vocabulary for response compatibility. A3 deletes the v1 vocabulary
// entirely and surfaces stateTransition/lockState directly.

function isUnsafeNativeTranscriptFallback(reason?: string): boolean {
    const value = String(reason || '').trim();
    return value.startsWith('native_history_unavailable')
        || value === 'native_history_not_safely_mapped'
        || value === 'native_history_stale'
        || value === 'native_history_partial';
}

function coerceUnsafeNativeFallbackStatus(status: string, activeModal: unknown): string {
    if (status === 'waiting_approval' && activeModal) return status;
    return 'idle';
}

function isRuntimeInputAckMessage(message: ChatMessage | undefined): boolean {
    if (!message || typeof message !== 'object') return false;
    const role = String((message as any).role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'human') return false;
    const meta = (message as any).meta;
    return !!meta && typeof meta === 'object' && !Array.isArray(meta) && meta.runtimeInputAck === true;
}

function selectRuntimeInputAckMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter((message) => isRuntimeInputAckMessage(message));
}

function readExactRuntimeMirrorMessages(args: {
    providerType: string;
    targetSessionId?: string;
    currentSessionId?: string;
    tailLimit: number;
    historyBehavior?: ProviderModule['historyBehavior'];
}): ChatMessage[] {
    const targetSessionId = String(args.targetSessionId || '').trim();
    const currentSessionId = String(args.currentSessionId || '').trim();
    if (!targetSessionId || targetSessionId !== currentSessionId) return [];

    const history = readChatHistory(
        args.providerType,
        0,
        Math.max(args.tailLimit || 0, HOT_TAIL_MIN_LIMIT),
        targetSessionId,
        0,
        args.historyBehavior,
    );
    return normalizeChatMessages((history.messages || []) as ChatMessage[])
        .filter((message) => {
            const historySessionId = String((message as any).historySessionId || '').trim();
            const instanceId = String((message as any).instanceId || '').trim();
            return historySessionId === targetSessionId || instanceId === targetSessionId;
        });
}
function normalizeComparableWorkspace(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    return path.resolve(text);
}
function isCurrentRuntimePtySafelyAttributed(args: {
    adapter: CliAdapter;
    helpers: CommandHelpers;
    readChatArgs: any;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    ptyMessages: ChatMessage[];
}): boolean {
    if (args.adapter.cliType !== 'codex-cli') return false;
    if (!Array.isArray(args.ptyMessages) || args.ptyMessages.length === 0) return false;
    const targetSessionId = typeof args.readChatArgs?.targetSessionId === 'string'
        ? args.readChatArgs.targetSessionId.trim()
        : '';
    const currentSession = args.helpers.currentSession as any;
    const currentSessionId = typeof currentSession?.sessionId === 'string'
        ? currentSession.sessionId.trim()
        : '';
    if (!targetSessionId || !currentSessionId || targetSessionId !== currentSessionId) return false;

    const runtimeMeta = typeof (args.adapter as any).getRuntimeMetadata === 'function'
        ? (args.adapter as any).getRuntimeMetadata()
        : null;
    const runtimeId = typeof runtimeMeta?.runtimeId === 'string' ? runtimeMeta.runtimeId.trim() : '';
    if (!runtimeId || runtimeId !== targetSessionId) return false;
    const surfaceKind = typeof runtimeMeta?.surfaceKind === 'string' ? runtimeMeta.surfaceKind : '';
    if (surfaceKind === 'inactive_record' || surfaceKind === 'recovery_snapshot') return false;

    const sessionWorkspace = normalizeComparableWorkspace(args.sessionWorkspace);
    const adapterWorkspace = normalizeComparableWorkspace(args.adapter.workingDir);
    if (!sessionWorkspace || !adapterWorkspace || sessionWorkspace !== adapterWorkspace) return false;
    const intendedWorkspace = normalizeComparableWorkspace(args.intendedWorkspace);
    if (intendedWorkspace && intendedWorkspace !== sessionWorkspace) return false;

    const registryEntry = args.helpers.ctx?.sessionRegistry?.get?.(targetSessionId) as any;
    const registryInstanceKey = typeof registryEntry?.adapterKey === 'string' && registryEntry.adapterKey.trim()
        ? registryEntry.adapterKey.trim()
        : typeof registryEntry?.instanceKey === 'string' && registryEntry.instanceKey.trim()
            ? registryEntry.instanceKey.trim()
            : '';
    if (registryInstanceKey) {
        const targetInstance = args.helpers.ctx?.instanceManager?.getInstance?.(registryInstanceKey);
        if (targetInstance) {
            const instanceType = typeof (targetInstance as any).type === 'string' ? (targetInstance as any).type : '';
            if (instanceType && instanceType !== args.adapter.cliType) return false;
        }
    }

    return true;
}

function supportsCliNativeTranscript(providerType: string, provider?: ProviderModule): boolean {
    // Preferred path: the provider module declares canonicalHistory in its
    // provider.json. We trust that declaration regardless of the legacy
    // allow-list. A2 will additionally require canonicalHistory.contractVersion
    // to be a supported value (transcript-v2.ts).
    if (provider?.category === 'cli' && isNativeSourceCanonicalHistory(provider?.nativeHistory)) {
        return true;
    }
    // Last-resort fallback for early call sites where the provider module is
    // not yet loaded. Warn once per provider type so this dependency is visible
    // and can be removed in A2.
    if (CLI_NATIVE_TRANSCRIPT_PROVIDERS.has(providerType)) {
        warnLegacyNativeAllowlistHit(providerType);
        return true;
    }
    return false;
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

function hasSafeNativeHistoryMapping(args: {
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
 * conversation .db was written most recently. For an antigravity MAGI
 * coordinator that is exactly a co-located replica's .db (the replica finished
 * its turn last), so the coordinator's read cross-wires onto the replica's
 * conversation instead of its own (ANTIGRAVITY coordinator↔replica crosswire).
 */
function effectiveReadSessionId(h: CommandHelpers, targetSessionId: string | undefined): string {
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
function sessionStartedAtMsFromRegistry(h: CommandHelpers, targetSessionId: string | undefined): number | undefined {
    const sid = effectiveReadSessionId(h, targetSessionId);
    if (!sid) return undefined;
    const target = h.ctx?.sessionRegistry?.get?.(sid);
    return typeof target?.spawnedAtMs === 'number' ? target.spawnedAtMs : undefined;
}

/**
 * Pull the env vars the daemon set when it spawned this session's CLI.
 * Mesh coordinator points hermes at a per-coordinator HERMES_HOME so
 * the native-history reader needs that override to find the right
 * state.db; without it the reader sees ~/.hermes/state.db and misses
 * every coordinator-session transcript.
 *
 * Returns undefined when no SpecCliAdapter is in play (legacy
 * providers / CDP) or when the adapter exposes no spawn env.
 */
function sessionSpawnEnvFromAdapter(h: CommandHelpers, targetSessionId: string | undefined): Record<string, string> | undefined {
    const adapter = getTargetedCliAdapter(h, { targetSessionId }, undefined);
    if (!adapter || typeof adapter.getRuntimeMetadata !== 'function') return undefined;
    const meta = adapter.getRuntimeMetadata() as Record<string, unknown> | undefined;
    const env = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).spawnedEnv : undefined;
    return env && typeof env === 'object' ? env as Record<string, string> : undefined;
}


function readCliProviderNativeHistory(agentStr: string, args: {
    canonicalHistory?: ProviderModule['canonicalHistory'];
    historySessionId?: string;
    workspace?: string;
    offset: number;
    limit: number;
    excludeRecentCount: number;
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
}): ReturnType<typeof readProviderChatHistory> & { lookup: 'session' | 'workspace' } {
    const canBindFromLiveSession = !args.historySessionId
        && typeof args.sessionStartedAtMs === 'number'
        && args.sessionStartedAtMs > 0
        && typeof args.workspace === 'string'
        && args.workspace.trim().length > 0;
    const pinnedProviderSessionId = typeof args.pinnedProviderSessionId === 'string'
        ? args.pinnedProviderSessionId.trim()
        : '';
    // Pin reuse (PRIMARY): a later read whose live binding is gone
    // (historySessionId empty, no live spawnedAtMs) can still resolve to the
    // session it was last bound to. Read THAT session directly by threading the
    // pin through as historySessionId — same code path an explicit session read
    // takes — instead of fail-closing. Never overrides a caller-supplied
    // historySessionId; only kicks in when there is none.
    const effectiveHistorySessionId = args.historySessionId || (!canBindFromLiveSession ? pinnedProviderSessionId : '');
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
        historyBehavior: args.historyBehavior,
        scripts: args.scripts as any,
        excludeInProgressTurn: args.excludeInProgressTurn,
        sessionStartedAtMs: args.sessionStartedAtMs,
        envOverrides: args.envOverrides,
        instanceId: args.instanceId,
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

function readLiveCodexWorkspaceNativeHistory(agentStr: string, args: {
    canonicalHistory?: ProviderModule['canonicalHistory'];
    workspace?: string;
    offset: number;
    limit: number;
    excludeRecentCount: number;
    historyBehavior?: ProviderModule['historyBehavior'];
    scripts?: ProviderScripts;
}): (ReturnType<typeof readProviderChatHistory> & { lookup: 'workspace' }) | null {
    if (agentStr !== 'codex-cli') return null;
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
    if (!workspace) return null;
    const history = readProviderChatHistory(agentStr, {
        canonicalHistory: args.canonicalHistory,
        workspace,
        offset: args.offset,
        limit: args.limit,
        excludeRecentCount: args.excludeRecentCount,
        historyBehavior: args.historyBehavior,
        scripts: args.scripts as any,
    });
    return { ...(history as any), lookup: 'workspace' };
}

// (A2.2) isNativeHistoryFreshEnough removed. The v1 freshness comparison
// (native_newest vs pty_newest with a 5-minute mtime grace window) was the
// direct cause of the plipping behaviour: PTY arrived every turn so native
// looked stale by default. ChatSourceMachine never compares native vs PTY
// freshness — the lock holds across arbitrary PTY arrival. See
// chat/source-machine.ts for the new semantics.

function shouldPreserveReadChatPayloadField(key: string): boolean {
    return key === 'messageSource' || key === 'transcriptProvenance';
}

function updateMessageSourceReturnedCount(value: unknown, returnedMessageCount: number): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const coverage = record.coverage && typeof record.coverage === 'object' && !Array.isArray(record.coverage)
        ? record.coverage as Record<string, unknown>
        : undefined;
    if (!coverage) return value;
    return {
        ...record,
        coverage: {
            ...coverage,
            returnedMessageCount,
        },
    };
}

function deriveHistoryDedupKey(message: ChatMessage & { _unitKey?: string; _turnKey?: string }): string | undefined {
    const unitKey = typeof message._unitKey === 'string' ? message._unitKey.trim() : '';
    if (unitKey) return `read_chat:${unitKey}`;

    const turnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
    if (!turnKey) return undefined;

    let content = '';
    try {
        content = JSON.stringify(message.content ?? '');
    } catch {
        content = String(message.content ?? '');
    }
    return `read_chat:${turnKey}:${String(message.role || '').toLowerCase()}:${content}`;
}

function toHistoryPersistedMessages(messages: ChatMessage[]): Array<{
    role: string;
    content: string;
    receivedAt?: number;
    kind?: string;
    senderName?: string;
    historyDedupKey?: string;
}> {
    return messages.map((message) => ({
        role: message.role,
        content: flattenContent(message.content),
        receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : undefined,
        kind: typeof message.kind === 'string' ? message.kind : undefined,
        senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
        historyDedupKey: deriveHistoryDedupKey(message as ChatMessage & { _unitKey?: string; _turnKey?: string }),
    }));
}

function buildFullTail(messages: ChatMessage[], tailLimit: number): {
    messages: ChatMessage[];
    totalMessages: number;
} {
    const totalMessages = messages.length;
    const tailMessages = tailLimit > 0 ? messages.slice(-tailLimit) : messages;
    return {
        messages: tailMessages,
        totalMessages,
    };
}

function hasNonEmptyModalButtons(activeModal: unknown): boolean {
    if (!activeModal || typeof activeModal !== 'object') return false;
    const buttons = (activeModal as { buttons?: unknown }).buttons;
    return Array.isArray(buttons) && buttons.some((button) => typeof button === 'string' && button.trim().length > 0);
}

function normalizeReadChatCommandStatus(status: unknown, activeModal: unknown): string {
    const raw = typeof status === 'string' ? status.trim() : '';
    if (!raw) {
        return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'idle';
    }
    switch (raw) {
        case 'starting':
            return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'starting';
        case 'stopped':
        case 'disconnected':
        case 'not_monitored':
            return 'error';
        case 'waiting_approval':
            // The contract validator requires activeModal+buttons whenever
            // status is waiting_approval. If a producer/coercer set this
            // status without staging the modal yet (a race we hit with
            // codex-cli during tool approval setup), downgrade to a
            // generating-like status so readChat still returns successfully.
            // The next poll will pick up the modal once the provider has
            // emitted it.
            return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'generating';
        default:
            return raw;
    }
}

function isGeneratingLikeStatus(status: unknown): boolean {
    return status === 'generating' || status === 'streaming' || status === 'no_progress' || status === 'long_generating' || status === 'starting';
}

function hasVisibleAssistantMessage(messages: unknown[] | undefined): boolean {
    if (!Array.isArray(messages)) return false;
    return messages.some((message: any) => {
        if (!message || message.role !== 'assistant') return false;
        const kind = typeof message.kind === 'string' ? message.kind : 'standard';
        if (kind !== 'standard') return false;
        return String(message.content || '').trim().length > 0;
    });
}

function hasFinalVisibleAssistantMessage(messages: unknown[] | undefined): boolean {
    if (!Array.isArray(messages)) return false;
    const visible = filterUserFacingChatMessages(messages as ChatMessage[]);
    const last = visible[visible.length - 1] as ChatMessage | undefined;
    const role = typeof last?.role === 'string' ? last.role.trim().toLowerCase() : '';
    const content = last ? flattenContent(last.content).trim() : '';
    return (role === 'assistant' || role === 'model') && content.length > 0;
}

function shouldTrustCliAdapterTerminalStatus(parsedStatus: unknown, activeModal: unknown, adapter: CliAdapter, adapterStatus: any): boolean {
    if (!isGeneratingLikeStatus(parsedStatus)) return false;
    if (hasNonEmptyModalButtons(activeModal)) return false;
    const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
    if (adapterRawStatus !== 'idle') return false;
    if (typeof adapter.isProcessing === 'function' && adapter.isProcessing()) return false;
    return true;
}

function normalizeCliReadChatStatus(parsedStatus: unknown, activeModal: unknown, adapter: CliAdapter, adapterStatus: any, parsedMessages?: unknown[]): string {
    const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
    if (adapterRawStatus === 'starting'
        && isGeneratingLikeStatus(parsedStatus)
        && !hasNonEmptyModalButtons(activeModal)
        && Array.isArray(parsedMessages)
        && parsedMessages.length === 0
        && Array.isArray(adapterStatus?.messages)
        && adapterStatus.messages.length === 0
        && !(typeof adapter.isProcessing === 'function' && adapter.isProcessing())) {
        return 'starting';
    }
    if (
        isGeneratingLikeStatus(adapterRawStatus)
        && parsedStatus === 'idle'
        && !hasNonEmptyModalButtons(activeModal)
        && !hasVisibleAssistantMessage(parsedMessages)
    ) {
        return adapterRawStatus;
    }
    if (shouldTrustCliAdapterTerminalStatus(parsedStatus, activeModal, adapter, adapterStatus)) return 'idle';
    return typeof parsedStatus === 'string' && parsedStatus.trim() ? parsedStatus : 'idle';
}

function finalizeStreamingMessagesWhenIdle(messages: ChatMessage[], status: string): ChatMessage[] {
    if (status !== 'idle') return messages;
    return messages.map((message) => {
        const meta = message.meta && typeof message.meta === 'object'
            ? message.meta as Record<string, unknown>
            : undefined;
        const hasStreamingMeta = meta?.streaming === true;
        if (message.bubbleState !== 'streaming' && !hasStreamingMeta) return message;
        return {
            ...message,
            ...(message.bubbleState === 'streaming' ? { bubbleState: 'final' as const } : {}),
            ...(hasStreamingMeta ? { meta: { ...meta, streaming: false } } : {}),
        };
    });
}

/**
 * Collapse adjacent PTY messages whose canonical (whitespace-stripped)
 * content is identical, OR whose turn key + role/kind match.
 *
 * The PTY parser of some providers (hermes-cli observed in the wild)
 * emits the same logical assistant turn twice when the terminal re-wraps
 * the text at a different column. The two emissions differ in newline
 * position — and sometimes in a single inserted space next to punctuation
 * (e.g. `(수정 2개), upstream` vs `(수정 2개 ), upstream`), so a simple
 * `\s+ -> ' '` normalize cannot collapse them.
 *
 * Strategy:
 *   1. If both messages carry the same _turnKey + role + kind, they are
 *      the same logical turn by construction. Collapse.
 *   2. Otherwise compare with all whitespace stripped — wrap variants
 *      collapse to identical strings.
 *
 * Native-history paths run through pageHistoryRecords and already
 * collapse on a normalized signature; this helper is the PTY equivalent
 * the readChat sync path was missing.
 */
function collapseAdjacentDuplicateChatMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages) || messages.length <= 1) return messages;
    const result: ChatMessage[] = [];
    let prevRoleKind = '';
    let prevStripped = '';
    for (const message of messages) {
        const role = typeof message.role === 'string' ? message.role : '';
        const kind = typeof message.kind === 'string' ? message.kind : 'standard';
        const content = typeof message.content === 'string'
            ? message.content
            : (Array.isArray(message.content) ? message.content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('') : '');
        const strippedContent = content.replace(/\s+/g, '');
        // Empty content or system messages are passed through untouched.
        if (!strippedContent || role === 'system') {
            result.push(message);
            prevRoleKind = '';
            prevStripped = '';
            continue;
        }
        const roleKind = `${role}:${kind}`;
        const sameStripped = strippedContent === prevStripped && roleKind === prevRoleKind;
        if (result.length > 0 && sameStripped) {
            // Adjacent duplicate after stripping all whitespace. Keep the
            // *later* copy because PTY's last emission usually has the most
            // complete formatting.
            result[result.length - 1] = message;
            prevRoleKind = roleKind;
            prevStripped = strippedContent;
            continue;
        }
        result.push(message);
        prevRoleKind = roleKind;
        prevStripped = strippedContent;
    }
    return result;
}

function buildReadChatCommandResult(payload: Record<string, any>, args: any, h?: CommandHelpers): CommandResult {
    let validatedPayload: Record<string, any>;
    const debugReadChat = payload?.debugReadChat && typeof payload.debugReadChat === 'object'
        ? payload.debugReadChat
        : undefined;
    try {
        validatedPayload = validateReadChatResultPayload({
            ...payload,
            status: normalizeReadChatCommandStatus(payload?.status, payload?.activeModal),
        }, 'read_chat command result') as Record<string, any>;
    } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
    }
    const messages = normalizeReadChatMessages(validatedPayload);
    // Last-mile coordinator-prompt filter. Different read_chat code paths
    // produce the final messages array (native-history main path, codex
    // exact-runtime-mirror fallback, daemon-side pty-parser, etc), so
    // applying it here means we don't have to thread the filter through
    // every one. Driven by the provider setting `showCoordinatorSystemPrompt`
    // + the coordinator-registry entry for the target session.
    const sessionIdHint = typeof args?.targetSessionId === 'string' ? args.targetSessionId
        : typeof args?.sessionId === 'string' ? args.sessionId
        : '';
    const providerHint = typeof args?.cliType === 'string' ? args.cliType
        : typeof args?.providerType === 'string' ? args.providerType
        : typeof args?.agentType === 'string' ? args.agentType
        : '';
    const filteredMessages = h
        ? maybeHideCoordinatorPromptMessage(h, providerHint, sessionIdHint, messages)
        : messages;
    // By default read_chat returns only user-facing prose turns. When the
    // caller opts in with `includeActivity`, tool/terminal/thought activity
    // bubbles (e.g. the native transcript's tool calls and results) are kept
    // inline too, in chronological order, so a restored conversation can show
    // what the agent actually did — not just the prose around it.
    const includeActivity = args?.includeActivity === true || args?.includeActivity === 'true';
    const visibleMessages = includeActivity
        ? filteredMessages.filter((m) => isUserFacingChatMessage(m) || isActivityChatMessage(m))
        : filterUserFacingChatMessages(filteredMessages);
    const sync = buildFullTail(visibleMessages, normalizeReadChatTailLimit(args));
    const hiddenMsgCount = Math.max(0, messages.length - visibleMessages.length);
    const preservedPayloadFields = Object.fromEntries(Object.entries(payload).filter(([key]) => shouldPreserveReadChatPayloadField(key)));
    if (preservedPayloadFields.messageSource) {
        preservedPayloadFields.messageSource = updateMessageSourceReturnedCount(preservedPayloadFields.messageSource, sync.messages.length);
    }
    if (preservedPayloadFields.transcriptProvenance) {
        preservedPayloadFields.transcriptProvenance = updateMessageSourceReturnedCount(preservedPayloadFields.transcriptProvenance, sync.messages.length);
    }
    const returnedDebugReadChat = debugReadChat
        ? {
            ...debugReadChat,
            fullMsgCount: typeof debugReadChat.fullMsgCount === 'number'
                ? debugReadChat.fullMsgCount
                : messages.length,
            visibleMsgCount: visibleMessages.length,
            hiddenMsgCount,
            returnedMsgCount: sync.messages.length,
        }
        : undefined;
    return {
        success: true,
        ...validatedPayload,
        ...preservedPayloadFields,
        messages: sync.messages,
        totalMessages: sync.totalMessages,
        ...(returnedDebugReadChat ? { debugReadChat: returnedDebugReadChat } : {}),
    };
}


function toNonNegativeNumber(value: any): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function getCliVisibleTranscriptCount(adapter: any): number {
    if (typeof adapter?.getScriptParsedStatus !== 'function') return 0;
    try {
        const parsed = parseMaybeJson(adapter.getScriptParsedStatus());
        return Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
    } catch {
        return 0;
    }
}

export async function handleChatHistory(h: CommandHelpers, args: any): Promise<CommandResult> {
    const { agentType, offset, limit } = args;
    const historySessionId = getHistorySessionId(h, args);
    try {
        const provider = h.getProvider(agentType);
        const agentStr = provider?.type || agentType || getCurrentProviderType(h);
        const transport = getTargetTransport(h, provider);
        const hasExplicitExcludeRecentCount = args?.excludeRecentCount !== undefined && args?.excludeRecentCount !== null;
        let excludeRecentCount = toNonNegativeNumber(args?.excludeRecentCount);
        if (!hasExplicitExcludeRecentCount && isCliLikeTransport(transport)) {
            const adapter = getTargetedCliAdapter(h, args, provider?.type);
            const visibleCount = getCliVisibleTranscriptCount(adapter);
            if (visibleCount > excludeRecentCount) excludeRecentCount = visibleCount;
        }
        const workspace = typeof args?.workspace === 'string'
            ? args.workspace
            : typeof (h.currentSession as any)?.workspace === 'string'
                ? (h.currentSession as any).workspace
                : undefined;
        // Same runtime-fallback poison guard as the subscribe / history-only
        // paths: getHistorySessionId falls back to targetSessionId (the ADHDev
        // id) for an agy coordinator, and the browser may also send that id back
        // explicitly. Reading native history keyed on it can never exact-bind
        // (it is not the on-disk conv uuid). Drop it here too so the pin /
        // workspace-latest / owner-confirmed resolution engages instead of
        // fail-closing to pty-parser. A real DISTINCT provider uuid is preserved.
        const targetSidForHistory = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
        const explicitHistorySessionIdForHistory = getExplicitHistorySessionId(args);
        const historySessionIdIsRuntimeFallback = Boolean(
            targetSidForHistory
            && isRuntimeFallbackHistorySessionId(historySessionId, targetSidForHistory)
            && (!explicitHistorySessionIdForHistory
                || isRuntimeFallbackHistorySessionId(explicitHistorySessionIdForHistory, targetSidForHistory)),
        );
        const pinnedProviderSessionIdForHistory = getBoundProviderSessionIdPin(args?.targetSessionId);
        const effectiveHistorySessionId = historySessionIdIsRuntimeFallback
            ? (pinnedProviderSessionIdForHistory || undefined)
            : historySessionId;
        const exactNativeHistoryScope = Boolean(
            (typeof args?.targetSessionId === 'string' && args.targetSessionId.trim())
            || (typeof args?.historySessionId === 'string' && args.historySessionId.trim() && !historySessionIdIsRuntimeFallback)
            || (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
        );
        const result = supportsCliNativeTranscript(agentStr, provider) && isNativeSourceCanonicalHistory(provider?.nativeHistory)
            ? readCliProviderNativeHistory(agentStr, {
                canonicalHistory: provider?.nativeHistory,
                historySessionId: effectiveHistorySessionId,
                workspace,
                offset: offset || 0,
                limit: limit || 30,
                excludeRecentCount,
                historyBehavior: provider?.historyBehavior,
                scripts: provider?.scripts as any,
                sessionStartedAtMs: sessionStartedAtMsFromRegistry(h, args?.targetSessionId),
                envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
                instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
                pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
                allowWorkspaceLatestFallback: !pinnedProviderSessionIdForHistory && historySessionIdIsRuntimeFallback,
            })
            : readProviderChatHistory(agentStr, {
                canonicalHistory: provider?.nativeHistory,
                historySessionId,
                workspace,
                offset: offset || 0,
                limit: limit || 30,
                excludeRecentCount,
                historyBehavior: provider?.historyBehavior,
                scripts: provider?.scripts as any,
            });
        if (supportsCliNativeTranscript(agentStr, provider) && isNativeSourceCanonicalHistory(provider?.nativeHistory)) {
            const lookup = (result as any).lookup === 'workspace' ? 'workspace' : 'session';
            const messages = Array.isArray((result as any).messages)
                ? normalizeAndFilterNativeHistory(h, agentStr, args, (result as any).messages as ChatMessage[], (result as any)?.providerSessionId)
                : [];
            const historyProviderSessionId = typeof (result as any)?.providerSessionId === 'string'
                ? (result as any).providerSessionId
                : readHistorySessionIdFromMessages(messages) || effectiveHistorySessionId;
            // Mirror of the subscribe path (see handleReadChat): an antigravity
            // workspace-latest read still surfaces the on-disk uuid, but that uuid is
            // only safe to persist / trust when it was OWNER-token-confirmed as this
            // session's own — a bare recency pick could be a co-located replica's
            // conversation. Gate the pin and the same-pass identity on ownerConfirmed.
            const resolvedProviderSessionId = typeof (result as any)?.providerSessionId === 'string'
                ? (result as any).providerSessionId.trim()
                : '';
            const resultLookupIsWorkspace = lookup === 'workspace';
            const resultOwnerConfirmed = (result as any)?.ownerConfirmed === true;
            const ownerConfirmedUuid = resultOwnerConfirmed && typeof historyProviderSessionId === 'string' && historyProviderSessionId.trim()
                ? historyProviderSessionId.trim()
                : '';
            if (resolvedProviderSessionId && (!resultLookupIsWorkspace || resultOwnerConfirmed)) {
                recordBoundProviderSessionId(h, effectiveReadSessionId(h, args?.targetSessionId), resolvedProviderSessionId);
            }
            const safeMapping = hasSafeNativeHistoryMapping({
                historySessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : effectiveHistorySessionId),
                providerSessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : historyProviderSessionId),
                workspace,
                nativeMessages: messages,
            });
            if ((result as any).source === 'provider-native' && messages.length > 0 && !safeMapping) {
                return {
                    success: true,
                    messages: [],
                    hasMore: false,
                    source: 'native-unavailable',
                    agent: agentStr,
                };
            }
        }
        return { success: true, ...result, agent: agentStr };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleReadChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    // Node scope guard: a daemon hosting a base node + several worktree nodes must
    // not serve worktree A's transcript (or splice sibling worktree turns via the
    // native-history-by-workspace fallback) when a coordinator scoped the read to
    // worktree B. mesh_read_chat always passes the requested node's workspace as
    // args.workspace; refuse a CONFIRMED cross-workspace read rather than mix.
    {
        const guardSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
        if (guardSessionId && typeof args?.workspace === 'string' && args.workspace.trim()) {
            const verdict = evaluateReadChatNodeWorkspaceScope({
                targetSessionId: guardSessionId,
                intendedWorkspace: args.workspace,
                sessionWorkspace: resolveTargetSessionActualWorkspace(h, guardSessionId),
            });
            if (verdict.scoped) {
                LOG.info('Command', `[read_chat] node scope mismatch: session ${guardSessionId} workspace "${verdict.actual}" ≠ requested node workspace "${verdict.intended}" — refusing cross-worktree transcript`);
                return {
                    success: false,
                    code: 'read_chat_session_node_scope_mismatch',
                    error: `Session ${guardSessionId} belongs to a different worktree (workspace "${verdict.actual}") than the requested node (workspace "${verdict.intended}"). Refusing to return a cross-worktree transcript — target the node that owns this session.`,
                };
            }
        }
    }
    // Resolve provider in order: explicit agentType/providerType > registered session.
    // Without this fallback, callers that only have a sessionId (e.g. a chat tail
    // controller that just got handed a session ID over WS) get an empty result
    // because getProvider(undefined) returns undefined and the rest of the pipeline
    // bails. This makes the UI look like the session "disappeared".
    let providerHint: string | undefined = args?.agentType || args?.providerType;
    if (!providerHint) {
        const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
        if (targetSessionId) {
            const session = (h.ctx as any)?.sessionRegistry?.get?.(targetSessionId);
            if (session && typeof session.providerType === 'string') {
                providerHint = session.providerType;
            }
        }
        if (!providerHint && h.currentSession?.providerType) {
            providerHint = h.currentSession.providerType;
        }
    }
    const provider = h.getProvider(providerHint);
    const transport = getTargetTransport(h, provider);
    const historySessionId = getHistorySessionId(h, args);

    const _log = (msg: string) => LOG.debug('Command', `[read_chat] ${msg}`);

    // PTY / ACP transport: read from adapter
    if (isCliLikeTransport(transport)) {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (adapter) {
            _log(`${transport} adapter: ${adapter.cliType}`);
            if (typeof adapter.getScriptParsedStatus !== 'function') {
                return { success: false, error: `${transport} adapter parseSession unavailable` };
            }
            let parsedStatus: any = null;
            try {
                parsedStatus = parseMaybeJson(adapter.getScriptParsedStatus());
            } catch (error: any) {
                return { success: false, error: error?.message || String(error) };
            }
            const parsedRecord = parsedStatus && typeof parsedStatus === 'object'
                ? parsedStatus as Record<string, any>
                : null;
            if (!parsedRecord || !Array.isArray(parsedRecord.messages)) {
                return { success: false, error: `${transport} parser did not return messages` };
            }
            const adapterStatus = typeof adapter.getStatus === 'function'
                ? adapter.getStatus()
                : {};
            const title = typeof parsedRecord.title === 'string' ? parsedRecord.title : undefined;
            const providerSessionId = typeof parsedRecord.providerSessionId === 'string'
                ? parsedRecord.providerSessionId
                : undefined;
            const transcriptAuthority = parsedRecord.transcriptAuthority === 'provider' || parsedRecord.transcriptAuthority === 'daemon'
                ? parsedRecord.transcriptAuthority
                : undefined;
            const coverage = parsedRecord.coverage === 'full' || parsedRecord.coverage === 'tail' || parsedRecord.coverage === 'current-turn'
                ? parsedRecord.coverage
                : undefined;
            const activeModal = parsedRecord.activeModal ?? parsedRecord.modal ?? null;
            const returnedStatus = normalizeCliReadChatStatus(parsedRecord.status, activeModal, adapter, adapterStatus, parsedRecord.messages);
            const runtimeMessageMerger = getTargetInstance(h, args) as RuntimeChatMessageMerger | null;
            const parsedMessages = collapseAdjacentDuplicateChatMessages(
                finalizeStreamingMessagesWhenIdle(parsedRecord.messages as ChatMessage[], returnedStatus),
            );
            const returnedMessages = runtimeMessageMerger?.category === 'cli'
                && runtimeMessageMerger.type === adapter.cliType
                && typeof runtimeMessageMerger.mergeRuntimeChatMessages === 'function'
                ? runtimeMessageMerger.mergeRuntimeChatMessages(parsedMessages)
                : parsedMessages;
            const providerType = provider?.type || adapter.cliType;
            let selectedMessages = returnedMessages;
            let selectedTitle = title;
            let selectedProviderSessionId = providerSessionId;
            let selectedTranscriptAuthority = transcriptAuthority;
            let selectedCoverage = coverage;
            let selectedStatus = returnedStatus;
            const _targetSidForWs = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
            const _registryWs = _targetSidForWs
                ? (h.ctx?.sessionRegistry?.get?.(_targetSidForWs) as any)?.workspace
                : undefined;
            const _currentSessionWs = typeof (h.currentSession as any)?.workspace === 'string'
                ? (h.currentSession as any).workspace
                : typeof adapter.workingDir === 'string'
                    ? adapter.workingDir
                    : undefined;
            const sessionWorkspace = _targetSidForWs
                ? (typeof _registryWs === 'string' ? _registryWs : (typeof args?.workspace === 'string' ? args.workspace : undefined) ?? _currentSessionWs)
                : _currentSessionWs;
            const intendedWorkspace = typeof args?.workspace === 'string' ? args.workspace : undefined;
            // ───────────────────────────────────────────────────────────
            //  Chat source decision via ChatSourceMachine (A2 big-bang).
            //  Replaces the ~300-line if-ladder that mixed source decision
            //  with native fetch, anchor mutation, and runtime mirror
            //  selection. The machine decides only between native-history
            //  and pty-parser; downstream selection of which message array
            //  to surface stays here.
            //
            //  Behavioural changes vs v1:
            //    - No more nativeHistoryAnchoredAt mutation on the adapter.
            //      Lock state lives in CHAT_SOURCE_REGISTRY keyed by
            //      (providerType, sessionId).
            //    - No PTY-vs-native freshness comparison. The lock holds
            //      across arbitrary PTY arrival; only native regression /
            //      unavailability unlocks. This is the plipping fix.
            //    - 6 trigger strings (native_history_partial / _stale /
            //      _not_safely_mapped / _empty / _error / _unavailable)
            //      collapse to 3 events with diagnostic causes preserved
            //      and mapped back to legacy fallbackReason strings for
            //      response compatibility.
            //    - Codex live-workspace native probe and unsafe-native
            //      daemon mirror fallbacks are preserved as additional
            //      input rounds to the machine; they were never the source
            //      decision itself, they were retries.
            // ───────────────────────────────────────────────────────────

            const supportsNative = supportsCliNativeTranscript(providerType, provider)
                && isNativeSourceCanonicalHistory(provider?.nativeHistory);
            const agentStr = provider?.type || args?.agentType || getCurrentProviderType(h, adapter.cliType);
            const workspace = sessionWorkspace;
            const nativeHistoryLimit = Math.max(
                normalizeReadChatTailLimit(args) || 0,
                returnedMessages.length,
                HOT_TAIL_MIN_LIMIT,
            );
            const nativeHistorySessionId = supportsNative
                ? resolveCliNativeHistorySessionId(args, historySessionId, providerSessionId)
                : undefined;
            const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
            const skipLiveNativeHistoryWithoutProviderSession = shouldSkipLiveCliNativeHistoryWithoutProviderSession({
                adapter,
                providerType,
                readChatArgs: args,
                nativeHistorySessionId,
                parsedProviderSessionId: providerSessionId,
            });
            const nativeHistoryReadSessionId = skipLiveNativeHistoryWithoutProviderSession
                ? undefined
                : nativeHistorySessionId;
            const exactNativeHistoryScope = Boolean(
                (typeof args?.historySessionId === 'string' && args.historySessionId.trim())
                || (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
                || providerSessionId
                || (nativeHistoryReadSessionId && nativeHistoryReadSessionId !== targetSessionId)
                || ((h.currentSession as any)?.sessionId === args?.targetSessionId && typeof (h.currentSession as any)?.providerSessionId === 'string' && (h.currentSession as any).providerSessionId.trim())
            );

            // 1. Fetch native history (or skip if provider does not support it).
            let nativeHistory: any | null = null;
            let nativeHistoryError: unknown | undefined;
            if (supportsNative) {
                // Runtime-fallback → pin substitution: nativeHistoryReadSessionId is
                // the bare runtime/session id when no explicit provider handle was
                // supplied and none was parsed (antigravity takes no --session-id, so
                // its this.providerSessionId stays empty and getHistorySessionId falls
                // back to targetSessionId). That runtime id is not the on-disk
                // conversations/<uuid>.db name, so a native read keyed on it can never
                // exact-bind and falls to the recency heuristic — which drops an idle
                // (or restored, spawnedAtMs=0) session's own store. Prefer a pin (a
                // real conversation id a prior read resolved for THIS session, now also
                // persisted across restart) over the runtime id, else drop the runtime
                // id so readCliProviderNativeHistory's pin / workspace-latest paths can
                // engage. Mirrors the handleChatHistory path's established handling.
                const pinnedProviderSessionIdForRead = getBoundProviderSessionIdPin(targetSessionId);
                // Runtime fallback whether the runtime id was reached via
                // getHistorySessionId's internal fallback (empty args) OR the
                // browser explicitly sent historySessionId === targetSessionId
                // (the poisoned agy-coordinator read). Both must drop the
                // runtime id so pin / live-bind resolution engages; only a real
                // DISTINCT provider uuid stays as an exact-bind id.
                const explicitHistorySessionIdForRead = getExplicitHistorySessionId(args);
                const nativeReadSessionIdIsRuntimeFallback = Boolean(
                    targetSessionId
                    && isRuntimeFallbackHistorySessionId(nativeHistoryReadSessionId, targetSessionId)
                    && (!explicitHistorySessionIdForRead
                        || isRuntimeFallbackHistorySessionId(explicitHistorySessionIdForRead, targetSessionId)),
                );
                const effectiveNativeReadSessionId = nativeReadSessionIdIsRuntimeFallback
                    ? (pinnedProviderSessionIdForRead || undefined)
                    : nativeHistoryReadSessionId;
                try {
                    nativeHistory = readCliProviderNativeHistory(agentStr, {
                        canonicalHistory: provider?.nativeHistory,
                        historySessionId: effectiveNativeReadSessionId,
                        workspace,
                        offset: 0,
                        limit: nativeHistoryLimit,
                        excludeRecentCount: 0,
                        historyBehavior: provider?.historyBehavior,
                        scripts: provider?.scripts as any,
                        excludeInProgressTurn: returnedStatus === 'waiting_approval',
                        sessionStartedAtMs: sessionStartedAtMsFromRegistry(h, args?.targetSessionId),
                        envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
                        // Stable per-session identity for antigravity's conversation-claim
                        // owner token (== session registry sessionId == instance instanceId).
                        instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
                        pinnedProviderSessionId: pinnedProviderSessionIdForRead,
                        // Last-resort only when no pin was ever recorded for this
                        // session; the downstream workspace-overlap safety gate
                        // still filters an aliased session out.
                        allowWorkspaceLatestFallback: !pinnedProviderSessionIdForRead,
                    });
                    // Refresh the per-mesh-session pin whenever a native read
                    // resolves a concrete provider-native session id. A later
                    // post-turn read (live binding gone) can then reuse it
                    // instead of fail-closing. Only a non-empty resolved id
                    // updates the pin; an empty result never clears a known one.
                    const resolvedProviderSessionId = typeof nativeHistory?.providerSessionId === 'string'
                        ? nativeHistory.providerSessionId.trim()
                        : '';
                    // Pin gating for the antigravity workspace-latest branch: a
                    // coordinator session has no pin (agy takes no --session-id) and
                    // spawnedAtMs=0 after attach-restore, so the read resolves via the
                    // workspace-latest fallback (lookup === 'workspace') rather than an
                    // exact bind. The dispatcher STILL surfaces the on-disk conversation
                    // uuid there — but that uuid is only safe to persist as a pin when it
                    // was OWNER-token-confirmed (exact uuid bind, or a spawn-floor/birth
                    // pick). A bare recency/newest-by-mtime pick (ownerConfirmed=false)
                    // could be a co-located replica's conversation, so recording it would
                    // hard-wire the coordinator↔replica crosswire permanently — never pin
                    // that. Exact-bind / session-scoped reads (lookup === 'session') are
                    // already owner-scoped by construction, so keep pinning them as before.
                    const resolvedLookupIsWorkspace = (nativeHistory as any)?.lookup === 'workspace';
                    const nativeOwnerConfirmed = (nativeHistory as any)?.ownerConfirmed === true;
                    const mayPinResolvedProviderSessionId = resolvedProviderSessionId
                        && (!resolvedLookupIsWorkspace || nativeOwnerConfirmed);
                    if (mayPinResolvedProviderSessionId) {
                        recordBoundProviderSessionId(h, effectiveReadSessionId(h, targetSessionId), resolvedProviderSessionId);
                    }
                } catch (error: any) {
                    nativeHistoryError = error;
                    nativeHistory = null;
                }
            }

            // 2. Compute safeMapping with the same rules the v1 code used so the
            //    machine sees the same observation it always would have.
            let nativeMessages: ChatMessage[] = nativeHistory && Array.isArray(nativeHistory.messages)
                ? normalizeAndFilterNativeHistory(h, agentStr, args, nativeHistory.messages as ChatMessage[], nativeHistory.providerSessionId)
                : [];
            const sessionStartedAtMs = sessionStartedAtMsFromRegistry(h, args?.targetSessionId);
            let historyProviderSessionId = typeof nativeHistory?.providerSessionId === 'string'
                ? nativeHistory.providerSessionId
                : readHistorySessionIdFromMessages(nativeMessages) || nativeHistoryReadSessionId || historySessionId;
            let lookup = nativeHistory?.lookup === 'workspace' ? 'workspace' : 'session';
            // Owner-confirmed uuid for THIS read (antigravity): the dispatcher
            // resolved a conversation and confirmed it is this session's own via the
            // owner token (exact uuid bind, or a spawn-floor/birth pick) — NOT a bare
            // recency pick. When present it is the authoritative conversation
            // identity for the same-pass safe-mapping check below, even on a
            // workspace-latest (lookup === 'workspace') read where the coordinator
            // has no pin. A coordinator session hits this path (agy takes no
            // --session-id, spawnedAtMs=0 after attach-restore); without it the
            // safe-mapping check saw undefined identity → workspace-overlap branch →
            // the PTY snapshot has only the user echo → fail-closed → regress to
            // pty-parser (user-echo only). Trusting the owner-confirmed uuid lets the
            // assistant answer reach the dashboard on the FIRST read.
            const ownerConfirmedUuid = adapter.cliType === 'antigravity-cli'
                && (nativeHistory as any)?.ownerConfirmed === true
                && typeof historyProviderSessionId === 'string'
                && historyProviderSessionId.trim()
                ? historyProviderSessionId.trim()
                : '';
            let nativeHistorySessionForMapping = ownerConfirmedUuid
                ? ownerConfirmedUuid
                : adapter.cliType === 'antigravity-cli'
                    && historyProviderSessionId
                    && nativeHistoryReadSessionId
                    && historyProviderSessionId !== nativeHistoryReadSessionId
                    ? undefined
                    : nativeHistoryReadSessionId;
            // For an owner-confirmed uuid, feed the uuid as the explicit session
            // identity to the safe-mapping check even on a workspace-latest read so
            // the session-branch identity test runs uuid-to-uuid (messages carry the
            // uuid as historySessionId) and trusts the assistant in this same pass.
            let safeMapping = supportsNative && nativeHistory
                ? hasSafeNativeHistoryMapping({
                    historySessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : nativeHistorySessionForMapping),
                    providerSessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : historyProviderSessionId || providerSessionId),
                    workspace,
                    nativeMessages,
                    ptyMessages: returnedMessages,
                    requireWorkspaceContentOverlap: lookup === 'workspace' && !exactNativeHistoryScope && !ownerConfirmedUuid,
                })
                : false;
            if (skipLiveNativeHistoryWithoutProviderSession && (!safeMapping || returnedMessages.length === 0)) {
                nativeHistory = null;
                nativeMessages = [];
                historyProviderSessionId = undefined;
                lookup = 'session';
                safeMapping = false;
            }
            const mayRetryUnsafeAutoDetectedCodexSession = adapter.cliType === 'codex-cli'
                && !getExplicitHistorySessionId(args)
                && Boolean(sessionStartedAtMs && sessionStartedAtMs > 0)
                && !skipLiveNativeHistoryWithoutProviderSession
                && !safeMapping;
            if (mayRetryUnsafeAutoDetectedCodexSession) {
                try {
                    nativeHistory = readCliProviderNativeHistory(agentStr, {
                        canonicalHistory: provider?.nativeHistory,
                        historySessionId: undefined,
                        workspace,
                        offset: 0,
                        limit: nativeHistoryLimit,
                        excludeRecentCount: 0,
                        historyBehavior: provider?.historyBehavior,
                        scripts: provider?.scripts as any,
                        excludeInProgressTurn: returnedStatus === 'waiting_approval',
                        sessionStartedAtMs,
                        envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
                        instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
                    });
                    nativeHistoryError = undefined;
                    nativeMessages = nativeHistory && Array.isArray(nativeHistory.messages)
                        ? normalizeAndFilterNativeHistory(h, agentStr, args, nativeHistory.messages as ChatMessage[], nativeHistory.providerSessionId)
                        : [];
                    historyProviderSessionId = typeof nativeHistory?.providerSessionId === 'string'
                        ? nativeHistory.providerSessionId
                        : readHistorySessionIdFromMessages(nativeMessages);
                    lookup = nativeHistory?.lookup === 'workspace' ? 'workspace' : 'session';
                    nativeHistorySessionForMapping = undefined;
                    safeMapping = supportsNative && nativeHistory
                        ? hasSafeNativeHistoryMapping({
                            historySessionId: lookup === 'workspace' ? undefined : historyProviderSessionId,
                            providerSessionId: lookup === 'workspace' ? undefined : historyProviderSessionId,
                            workspace,
                            nativeMessages,
                            ptyMessages: returnedMessages,
                            requireWorkspaceContentOverlap: lookup === 'workspace' && !exactNativeHistoryScope,
                        })
                        : false;
                } catch (error: any) {
                    nativeHistoryError = error;
                    nativeHistory = null;
                    nativeMessages = [];
                    historyProviderSessionId = undefined;
                    safeMapping = false;
                }
            }
            const trustedExactNativeIdentity = lookup !== 'workspace'
                && Boolean(nativeHistoryReadSessionId)
                && Boolean(historyProviderSessionId)
                && nativeHistoryReadSessionId === historyProviderSessionId;

            // 3. Drive ChatSourceMachine — one observation per readChat call,
            //    keyed by (providerType, sessionKey-for-this-call). targetSessionId
            //    is the most specific session anchor we have; fall back to
            //    historySessionId so we never leak state across distinct sessions.
            const machineSessionKey = String(
                args?.targetSessionId
                || providerSessionId
                || historySessionId
                || (h.currentSession as any)?.sessionId
                || ''
            );
            const primary = decideCliReadChatSource({
                providerType,
                provider,
                sessionId: machineSessionKey,
                nativeHistoryResult: nativeHistory,
                nativeHistoryError,
                safeMapping,
                trustedExactNativeIdentity,
                sessionWorkspace,
                intendedWorkspace,
                ptyMessages: returnedMessages,
                // Start with PTY visible; decideCliReadChatSource flips this
                // to true when the machine actually selects native-history.
                ptyStatusApprovalOnly: false,
            });
            let messageSource: Record<string, unknown> = primary.messageSource;

            if (primary.nativeSelected) {
                selectedMessages = finalizeStreamingMessagesWhenIdle(primary.nativeMessages, returnedStatus);
                selectedProviderSessionId = historyProviderSessionId || providerSessionId;
                selectedTranscriptAuthority = 'provider';
                selectedCoverage = nativeHistory?.hasMore ? 'tail' : 'full';
                if (selectedProviderSessionId && selectedProviderSessionId !== providerSessionId) {
                    adapter.updateRuntimeMeta?.({ providerSessionId: selectedProviderSessionId });
                }
            } else if (supportsNative) {
                // Native not selected. Two preserved v1 fallbacks before settling
                // on PTY: (a) Codex-only live workspace native probe; (b) unsafe-
                // native daemon mirror selection. The machine sees each retry as
                // an additional observation.
                const liveCurrentRuntimePtySafe = isCurrentRuntimePtySafelyAttributed({
                    adapter,
                    helpers: h,
                    readChatArgs: args,
                    sessionWorkspace,
                    intendedWorkspace,
                    ptyMessages: returnedMessages,
                });
                const mayProbeLiveCodexWorkspaceNative = adapter.cliType === 'codex-cli'
                    && liveCurrentRuntimePtySafe
                    && !(typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
                    && !(providerSessionId && providerSessionId.trim())
                    && !nativeHistoryReadSessionId
                    && (!historyProviderSessionId || historyProviderSessionId === nativeHistoryReadSessionId || historyProviderSessionId === historySessionId)
                    && !skipLiveNativeHistoryWithoutProviderSession;
                const liveWorkspaceNativeHistory = mayProbeLiveCodexWorkspaceNative
                    ? readLiveCodexWorkspaceNativeHistory(agentStr, {
                        canonicalHistory: provider?.nativeHistory,
                        workspace,
                        offset: 0,
                        limit: nativeHistoryLimit,
                        excludeRecentCount: 0,
                        historyBehavior: provider?.historyBehavior,
                        scripts: provider?.scripts as any,
                    })
                    : null;
                const liveWorkspaceNativeMessages = Array.isArray((liveWorkspaceNativeHistory as any)?.messages)
                    ? normalizeAndFilterNativeHistory(h, agentStr, args, (liveWorkspaceNativeHistory as any).messages as ChatMessage[], (liveWorkspaceNativeHistory as any)?.providerSessionId)
                    : [];
                const liveWorkspaceNativeProviderSessionId = typeof (liveWorkspaceNativeHistory as any)?.providerSessionId === 'string'
                    ? (liveWorkspaceNativeHistory as any).providerSessionId
                    : readHistorySessionIdFromMessages(liveWorkspaceNativeMessages);
                const liveWorkspaceNativeSafeMapping = liveWorkspaceNativeMessages.length > 0
                    && hasSafeNativeHistoryMapping({
                        workspace,
                        nativeMessages: liveWorkspaceNativeMessages,
                        ptyMessages: returnedMessages,
                        requireWorkspaceContentOverlap: true,
                    });
                if (liveWorkspaceNativeHistory) {
                    const liveDecision = decideCliReadChatSource({
                        providerType,
                        provider,
                        // Distinct session key so a transient codex live-probe does not
                        // clobber the primary session's lock. The machine treats this
                        // as its own session; the primary session's state is untouched.
                        sessionId: `${machineSessionKey}::live-workspace`,
                        nativeHistoryResult: liveWorkspaceNativeHistory,
                        safeMapping: liveWorkspaceNativeSafeMapping,
                        sessionWorkspace,
                        intendedWorkspace,
                        ptyMessages: returnedMessages,
                        ptyStatusApprovalOnly: true,
                    });
                    if (liveDecision.nativeSelected) {
                        selectedMessages = finalizeStreamingMessagesWhenIdle(liveDecision.nativeMessages, returnedStatus);
                        selectedProviderSessionId = liveWorkspaceNativeProviderSessionId || providerSessionId;
                        selectedTranscriptAuthority = 'provider';
                        selectedCoverage = (liveWorkspaceNativeHistory as any).hasMore ? 'tail' : 'full';
                        if (selectedProviderSessionId && selectedProviderSessionId !== providerSessionId) {
                            adapter.updateRuntimeMeta?.({ providerSessionId: selectedProviderSessionId });
                        }
                        messageSource = liveDecision.messageSource;
                        (messageSource as any).selectedDaemonSource = 'live-workspace-native-history';
                        (messageSource as any).runtimeMappingSafe = true;
                    } else {
                        // Live probe also rejected: apply unsafe-native daemon mirror
                        // selection (codex-only) using the primary decision's
                        // fallbackReason.
                        applyUnsafeNativeDaemonFallback({
                            providerType,
                            adapter,
                            helpers: h,
                            readChatArgs: args,
                            sessionWorkspace,
                            intendedWorkspace,
                            ptyMessages: returnedMessages,
                            nativeHistoryLimit,
                            provider,
                            messageSourceRef: { set(value) { messageSource = value; }, get() { return messageSource; } },
                            apply(selection) {
                                selectedMessages = selection.messages;
                                selectedTranscriptAuthority = selection.transcriptAuthority;
                                selectedCoverage = selection.coverage ?? coverage;
                                selectedStatus = selection.status ?? returnedStatus;
                            },
                            activeModal,
                            returnedStatus,
                            coverage,
                        });
                    }
                } else {
                    applyUnsafeNativeDaemonFallback({
                        providerType,
                        adapter,
                        helpers: h,
                        readChatArgs: args,
                        sessionWorkspace,
                        intendedWorkspace,
                        ptyMessages: returnedMessages,
                        nativeHistoryLimit,
                        provider,
                        messageSourceRef: { set(value) { messageSource = value; }, get() { return messageSource; } },
                        apply(selection) {
                            selectedMessages = selection.messages;
                            selectedTranscriptAuthority = selection.transcriptAuthority;
                            selectedCoverage = selection.coverage ?? coverage;
                            selectedStatus = selection.status ?? returnedStatus;
                        },
                        activeModal,
                        returnedStatus,
                        coverage,
                    });
                }
            }
            if (
                isGeneratingLikeStatus(selectedStatus)
                && selectedTranscriptAuthority === 'provider'
                && !hasNonEmptyModalButtons(activeModal)
                && hasFinalVisibleAssistantMessage(selectedMessages)
            ) {
                selectedStatus = 'idle';
                selectedMessages = finalizeStreamingMessagesWhenIdle(selectedMessages, selectedStatus);
                messageSource = {
                    ...messageSource,
                    statusReconciled: {
                        from: returnedStatus,
                        to: 'idle',
                        reason: 'provider_native_final_assistant',
                    },
                };
            }
            LOG.debug('Command', `[read_chat] cli-like parsed provider=${adapter.cliType} target=${String(args?.targetSessionId || '')} adapterStatus=${String(adapterStatus.status || '')} parsedStatus=${String(parsedRecord.status || '')} parsedMsgCount=${parsedRecord.messages.length} returnedMsgCount=${returnedMessages.length}`);
            return buildReadChatCommandResult({
                messages: selectedMessages,
                status: selectedStatus,
                activeModal,
                messageSource,
                transcriptProvenance: messageSource,
                debugReadChat: {
                    provider: adapter.cliType,
                    targetSessionId: String(args?.targetSessionId || ''),
                    adapterStatus: String(adapterStatus.status || ''),
                    parsedStatus: String(parsedRecord.status || ''),
                    returnedStatus: String(selectedStatus || ''),
                    selectedMessageSource: (messageSource as any).selected,
                    messageSource,
                    shouldPreferAdapterMessages: supportsCliNativeTranscript(providerType, provider)
                        && isNativeSourceCanonicalHistory(provider?.nativeHistory)
                        && (messageSource as any).selected !== 'native-history'
                        && typeof (messageSource as any).fallbackReason === 'string'
                        && (messageSource as any).fallbackReason.startsWith('native_history_')
                        && (messageSource as any).fallbackReason !== 'native_history_not_checked'
                        && !isUnsafeNativeTranscriptFallback((messageSource as any).fallbackReason)
                        && !(selectedTranscriptAuthority === 'provider' && selectedCoverage === 'full'),
                    parsedMsgCount: parsedRecord.messages.length,
                    returnedMsgCount: selectedMessages.length,
                },
                ...(selectedTitle ? { title: selectedTitle } : {}),
                ...(selectedProviderSessionId ? { providerSessionId: selectedProviderSessionId } : {}),
                ...(selectedTranscriptAuthority ? { transcriptAuthority: selectedTranscriptAuthority } : {}),
                ...(selectedCoverage ? { coverage: selectedCoverage } : {}),
            }, args, h);
        }
        // History-only path (no adapter). Same source-decision contract as
        // the adapter path above, but with no PTY messages — the machine
        // simply decides whether native is usable; if not we return the
        // history we have plus a `native_history_not_safely_available`
        // error response when the provider requires native source.
        const historyLimit = normalizeReadChatTailLimit(args);
        try {
            const agentStr = provider?.type || args?.agentType || getCurrentProviderType(h);
            const targetSid = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
            const registrySessionWorkspace = targetSid
                ? (h.ctx?.sessionRegistry?.get?.(targetSid) as any)?.workspace
                : undefined;
            const currentSessionWorkspace = typeof (h.currentSession as any)?.workspace === 'string'
                ? (h.currentSession as any).workspace
                : undefined;
            const argsWorkspace = typeof args?.workspace === 'string' ? args.workspace : undefined;
            // When reading a different session (targetSid), prefer that session's registered
            // workspace (or the caller-supplied args.workspace) over the current (coordinator)
            // session's workspace — otherwise the coordinator's cwd shadows the worker's cwd
            // and history lookups find the wrong files.
            const workspace = targetSid
                ? (typeof registrySessionWorkspace === 'string' ? registrySessionWorkspace : argsWorkspace ?? currentSessionWorkspace)
                : (typeof currentSessionWorkspace === 'string' ? currentSessionWorkspace : undefined);
            const intendedWorkspace = argsWorkspace;
            const supportsNative = supportsCliNativeTranscript(agentStr, provider)
                && isNativeSourceCanonicalHistory(provider?.nativeHistory);
            // Post-turn read (no live adapter): getHistorySessionId falls back to
            // the daemon runtime session id when no provider-native id was ever
            // registered. That runtime id is NOT a real provider session, so a
            // native read keyed on it resolves nothing (providerSessionId=null,
            // zero rows) even though the transcript is present in state.db. When
            // this is that runtime fallback (historySessionId === targetSid and no
            // explicit id was passed) and we hold a pin from an earlier bound
            // read, prefer the pin so the query hits the real session.
            const pinnedProviderSessionIdForHistory = getBoundProviderSessionIdPin(targetSid);
            // Runtime fallback whether historySessionId reached targetSid via
            // getHistorySessionId's internal fallback (empty args) OR the browser
            // explicitly sent historySessionId === targetSid (the poisoned
            // agy-coordinator subscription / D8 refreshAuthoritativeTail read).
            // In both cases the runtime id is NOT a real provider conv uuid, so
            // drop it and let pin / workspace-latest / owner-confirmed resolution
            // run. A real DISTINCT provider uuid still exact-binds unchanged.
            const explicitHistorySessionId = getExplicitHistorySessionId(args);
            const historySessionIdIsRuntimeFallback = Boolean(
                targetSid
                && isRuntimeFallbackHistorySessionId(historySessionId, targetSid)
                && (!explicitHistorySessionId
                    || isRuntimeFallbackHistorySessionId(explicitHistorySessionId, targetSid)),
            );
            // When this is the runtime fallback (not a real provider id): prefer
            // the pin if we have one, else drop the runtime id entirely so the
            // pin-reuse / workspace-latest logic inside readCliProviderNativeHistory
            // can engage (passing the runtime id as historySessionId would pin the
            // query to a non-existent session and never reach those paths).
            const effectiveHistorySessionIdForRead = historySessionIdIsRuntimeFallback
                ? (pinnedProviderSessionIdForHistory || undefined)
                : historySessionId;
            const history = supportsNative
                ? readCliProviderNativeHistory(agentStr, {
                    canonicalHistory: provider?.nativeHistory,
                    historySessionId: effectiveHistorySessionIdForRead,
                    workspace,
                    offset: 0,
                    limit: historyLimit,
                    excludeRecentCount: 0,
                    historyBehavior: provider?.historyBehavior,
                    scripts: provider?.scripts as any,
                    sessionStartedAtMs: sessionStartedAtMsFromRegistry(h, args?.targetSessionId),
                    envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
                    instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
                    pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
                    // Last-resort only when no pin was ever recorded AND the
                    // runtime fallback did not resolve a real provider session.
                    allowWorkspaceLatestFallback: !pinnedProviderSessionIdForHistory && historySessionIdIsRuntimeFallback,
                })
                : readProviderChatHistory(agentStr, {
                    canonicalHistory: provider?.nativeHistory,
                    historySessionId,
                    workspace,
                    offset: 0,
                    limit: historyLimit,
                    excludeRecentCount: 0,
                    historyBehavior: provider?.historyBehavior,
                    scripts: provider?.scripts as any,
                });
            const lookup = (history as any)?.lookup === 'workspace' ? 'workspace' : 'session';
            const historyMessages = Array.isArray((history as any)?.messages)
                ? normalizeAndFilterNativeHistory(h, agentStr, args, (history as any).messages as ChatMessage[], (history as any)?.providerSessionId)
                : [];
            const historyProviderSessionId = typeof (history as any)?.providerSessionId === 'string'
                ? (history as any).providerSessionId
                : readHistorySessionIdFromMessages(historyMessages) || effectiveHistorySessionIdForRead;
            // Antigravity coordinator root fix (history-only path — the post-turn
            // read a coordinator actually hits: no live adapter, no pin, agy takes no
            // --session-id so spawnedAtMs is 0 after attach-restore → the read resolves
            // via the workspace-latest fallback, lookup === 'workspace'). The dispatcher
            // STILL surfaces the on-disk conversation uuid there, and flags whether it
            // was OWNER-token-confirmed as this session's own (an exact/birth pick) vs a
            // bare recency pick that could be a co-located replica's conversation.
            //   • Pin the uuid on a workspace-latest read ONLY when owner-confirmed —
            //     recording a replica's uuid would hard-wire the coordinator↔replica
            //     crosswire permanently. Exact/session-scoped reads pin as before.
            //   • Feed the owner-confirmed uuid as the explicit identity to the
            //     safe-mapping check even on a workspace-latest read so the identity
            //     test runs uuid-to-uuid and trusts the assistant on this FIRST read
            //     (else it saw undefined identity → workspace-overlap branch → the PTY
            //     snapshot has only the user echo → fail-closed → regress to pty-parser).
            const historyLookupIsWorkspace = lookup === 'workspace';
            const historyOwnerConfirmed = agentStr === 'antigravity-cli' && (history as any)?.ownerConfirmed === true;
            const historyOwnerConfirmedUuid = historyOwnerConfirmed
                && typeof historyProviderSessionId === 'string' && historyProviderSessionId.trim()
                ? historyProviderSessionId.trim()
                : '';
            // Refresh the pin whenever this path resolves a real provider id — but for
            // a workspace-latest antigravity read, only when the uuid is owner-confirmed.
            if (typeof (history as any)?.providerSessionId === 'string'
                && (history as any).providerSessionId.trim()
                && (!historyLookupIsWorkspace || !agentStr || agentStr !== 'antigravity-cli' || historyOwnerConfirmed)) {
                recordBoundProviderSessionId(h, effectiveReadSessionId(h, targetSid), (history as any).providerSessionId.trim());
            }
            // Use the id we actually read with (pin / real provider id), NOT the
            // raw runtime-fallback historySessionId — otherwise the mapping guard
            // compares the stamped messages' real id against the runtime id and
            // fails closed, undoing the pin reuse.
            const mappingSessionId = historyOwnerConfirmedUuid || effectiveHistorySessionIdForRead;
            // Fail closed for an antigravity workspace-latest read whose uuid was NOT
            // owner-confirmed: it is a bare recency/newest-by-mtime pick that could be
            // a co-located concurrent session's (replica's) conversation. Without an
            // owner-token confirmation we cannot prove ownership, so refuse it rather
            // than surface a sibling's transcript (the coordinator↔replica crosswire
            // guard). This is the same fail-closed default the design study protects —
            // only an owner-confirmed uuid escapes it above.
            const antigravityWorkspaceLatestUnconfirmed = agentStr === 'antigravity-cli'
                && historyLookupIsWorkspace
                && !historyOwnerConfirmedUuid;
            const safeMapping = supportsNative && !antigravityWorkspaceLatestUnconfirmed
                ? hasSafeNativeHistoryMapping({
                    historySessionId: historyOwnerConfirmedUuid || (lookup === 'workspace' ? undefined : mappingSessionId),
                    providerSessionId: historyOwnerConfirmedUuid || (lookup === 'workspace' ? undefined : historyProviderSessionId),
                    workspace,
                    nativeMessages: historyMessages,
                })
                : false;
            const trustedExactNativeIdentity = (lookup !== 'workspace' || Boolean(historyOwnerConfirmedUuid))
                && Boolean(mappingSessionId)
                && Boolean(historyProviderSessionId)
                && mappingSessionId === historyProviderSessionId;

            const machineSessionKey = String(
                args?.targetSessionId
                || historyProviderSessionId
                || historySessionId
                || (h.currentSession as any)?.sessionId
                || ''
            );
            const decision = decideCliReadChatSource({
                providerType: agentStr,
                provider,
                sessionId: machineSessionKey,
                nativeHistoryResult: history,
                safeMapping,
                trustedExactNativeIdentity,
                sessionWorkspace: workspace,
                intendedWorkspace,
                ptyMessages: [],
                ptyStatusApprovalOnly: false,
            });

            if (supportsNative && !decision.nativeSelected) {
                // Native-only content preservation (hermes chat_tail gap).
                // The history-only path has NO PTY transcript (native-only
                // providers suppress PTY bodies), so args.ptyMessages is empty
                // and the machine's pty-parser selection returns NOTHING. But a
                // post-turn / cold read routinely lands here with a REAL,
                // safely-mapped native slice that the source FSM declined only
                // because coverage came back 'partial' (missing sessionStartedAtMs
                // → Booting→Recovering→pty-parser) or a transient shrink looked
                // like a regression. Dropping those rows deletes the assistant
                // answer from chat_tail / read_chat entirely. When the native
                // read actually resolved rows for THIS session identity
                // (safeMapping proves ownership: matching historySessionId /
                // providerSessionId + workspace), return them instead of an empty
                // array. This never loosens identity safety — it is gated on the
                // same hasSafeNativeHistoryMapping used everywhere else — and it
                // is scoped to the native-only history path (no PTY to prefer).
                // Truly-empty native reads (historyMessages.length === 0) and
                // unsafe/workspace-aliasing reads (safeMapping === false) still
                // fall through to the soft-pending dead-end below.
                if (safeMapping && historyMessages.length > 0) {
                    LOG.debug('Command', `[read_chat] native-only content preserved despite pty-parser selection target=${String(args?.targetSessionId || '')} provider=${agentStr} rows=${historyMessages.length} cause=${decision.decision.transition.cause}`);
                    return buildReadChatCommandResult({
                        messages: historyMessages,
                        status: 'idle',
                        messageSource: {
                            ...decision.messageSource,
                            nativeOnlyContentPreserved: true,
                            returnedMessageCount: historyMessages.length,
                        },
                        transcriptProvenance: {
                            ...decision.messageSource,
                            nativeOnlyContentPreserved: true,
                        },
                        ...(typeof (history as any)?.title === 'string' ? { title: (history as any).title } : {}),
                        ...(historyProviderSessionId ? { providerSessionId: historyProviderSessionId } : {}),
                        ...(((provider?.historyBehavior as any)?.transcriptAuthority === 'provider' || (provider?.historyBehavior as any)?.transcriptAuthority === 'daemon')
                            ? { transcriptAuthority: (provider?.historyBehavior as any).transcriptAuthority }
                            : {}),
                        coverage: 'tail',
                    }, args, h);
                }
                // Dead-end: we are in the history-only path (no live PTY/ACP
                // adapter was found for this target session) AND provider-native
                // history is not safely mappable to the requested session
                // (no historySessionId stamp / workspace mismatch). Previously
                // this returned `success:false`, which the command logger emits
                // at warn level on EVERY poll (handler.ts logCommandEnd) —
                // mesh coordinators poll read_chat continuously, so a worker whose
                // transcript can never be safely mapped produced a 100% warn-log
                // storm with no recovery. Switch to a SOFT response: success with
                // empty messages + pending:true so the coordinator treats it as
                // "no live messages readable yet" rather than a hard failure, and
                // carry the machine-readable reason for debuggability. The normal
                // live-adapter path (above) and the safe-native return (below) are
                // unaffected — this is strictly the both-absent dead end.
                LOG.debug('Command', `[read_chat] soft pending: no live adapter and native history not safely mappable target=${String(args?.targetSessionId || '')} provider=${agentStr} reason=native_history_not_safely_available`);
                return {
                    success: true,
                    pending: true,
                    // Both signals are true here: we reached the history-only path
                    // because no live adapter was found (`live_adapter_not_found`),
                    // and native history is not safely mappable
                    // (`native_history_not_safely_available`).
                    reason: 'native_history_not_safely_available',
                    reasons: ['live_adapter_not_found', 'native_history_not_safely_available'],
                    code: 'native_history_not_safely_available',
                    messages: [],
                    status: 'idle',
                    providerSessionId: historyProviderSessionId,
                    messageSource: decision.messageSource,
                    transcriptProvenance: decision.messageSource,
                };
            }
            return buildReadChatCommandResult({
                messages: historyMessages,
                status: 'idle',
                messageSource: decision.messageSource,
                transcriptProvenance: decision.messageSource,
                ...(typeof (history as any)?.title === 'string' ? { title: (history as any).title } : {}),
                ...(historyProviderSessionId ? { providerSessionId: historyProviderSessionId } : {}),
                ...(((provider?.historyBehavior as any)?.transcriptAuthority === 'provider' || (provider?.historyBehavior as any)?.transcriptAuthority === 'daemon')
                    ? { transcriptAuthority: (provider?.historyBehavior as any).transcriptAuthority }
                    : {}),
                coverage: 'tail',
            }, args, h);
        } catch (error: any) {
            return { success: false, error: error?.message || `${transport} adapter not found` };
        }
    }

    // Extension transport: evaluateInSession
    if (isExtensionTransport(transport)) {
        let extensionReadChatError = '';
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch (e: any) {
                        extensionReadChatError = `extension read_chat parse failed: ${e?.message || String(e)}`;
                    }
                }
                if (parsed && typeof parsed === 'object') {
                    const validated = validateReadChatResultPayload(parsed, 'extension read_chat');
                    _log(`Extension OK: ${validated.messages?.length || 0} msgs`);
                    traceProviderEvent(args, 'provider', 'extension.read_chat.success', {
                        h,
                        provider,
                        payload: {
                            method: 'evaluateProviderScript',
                            result: evalResult.result,
                            parsed: validated,
                            messageCount: Array.isArray(validated.messages) ? validated.messages.length : 0,
                        },
                    });
                    h.historyWriter.appendNewMessages(
                        provider?.type || 'unknown_extension',
                        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
                        validated.title,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult(validated as Record<string, any>, args, h);
                }
                if (!extensionReadChatError) {
                    extensionReadChatError = 'extension read_chat returned a non-object payload';
                }
            } else {
                extensionReadChatError = 'extension read_chat returned no payload';
            }
        } catch (e: any) {
            extensionReadChatError = `extension read_chat failed: ${e?.message || String(e)}`;
            _log(`Extension error: ${e.message}`);
            traceProviderEvent(args, 'provider', 'extension.read_chat.error', {
                h,
                provider,
                level: 'warn',
                payload: { method: 'evaluateProviderScript', error: e.message },
            });
        }
        // Alternative: AgentStreamManager (script fail when)
        if (h.agentStream) {
            const cdp = h.getCdp();
            const parentSessionId = h.currentSession?.parentSessionId;
            if (cdp && parentSessionId) {
                const stream = await h.agentStream.collectActiveSession(cdp, parentSessionId);
                if (stream && stream.agentType !== provider?.type) {
                    return { success: false, error: `extension read_chat stream agent mismatch for ${provider?.type || 'unknown_extension'}` };
                }
                if (stream) {
                    h.historyWriter.appendNewMessages(
                        stream.agentType,
                        toHistoryPersistedMessages(stream.messages || []),
                        undefined,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult({
                        messages: stream.messages || [],
                        status: stream.status,
                        agentType: stream.agentType,
                    }, args, h);
                }
            }
        }
        return { success: false, error: extensionReadChatError || 'extension read_chat unavailable' };
    }

    // IDE category (default): cdp.evaluate
    const cdp = h.getCdp();
    if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };

    // webview IDE (Kiro, PearAI) → evaluateInWebviewFrame directly use
    const webviewScript = h.getProviderScript('webviewReadChat') || h.getProviderScript('webview_read_chat');
    if (webviewScript) {
        let webviewReadChatError = '';
        try {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText
                ? (body: string) => body.includes(matchText)
                : undefined;
            const raw = await cdp.evaluateInWebviewFrame(webviewScript, matchFn);
            if (raw) {
                let parsed: any = raw;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch (e: any) {
                        webviewReadChatError = `webview read_chat parse failed: ${e?.message || String(e)}`;
                    }
                }
                if (parsed && typeof parsed === 'object') {
                    const validated = validateReadChatResultPayload(parsed, 'webview read_chat');
                    _log(`Webview OK: ${validated.messages?.length || 0} msgs`);
                    h.historyWriter.appendNewMessages(
                        provider?.type || getCurrentProviderType(h, 'unknown_webview'),
                        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
                        validated.title,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult(validated as Record<string, any>, args, h);
                }
                if (!webviewReadChatError) {
                    webviewReadChatError = 'webview read_chat returned a non-object payload';
                }
            } else {
                webviewReadChatError = 'webview read_chat returned no payload';
            }
        } catch (e: any) {
            webviewReadChatError = `webview read_chat failed: ${e?.message || String(e)}`;
            _log(`Webview readChat error: ${e.message}`);
        }
        return { success: false, error: webviewReadChatError || 'webview read_chat unavailable' };
    }

    // Regular IDE (Cursor, Windsurf, Trae etc) → main DOM evaluate
    const script = h.getProviderScript('readChat') || h.getProviderScript('read_chat');
    if (script) {
        let ideReadChatError = '';
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
            if (evalResult?.result) {
                let parsed: any = evalResult.result;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch (e: any) {
                        ideReadChatError = `ide read_chat parse failed: ${e?.message || String(e)}`;
                    }
                }
                if (parsed && typeof parsed === 'object') {
                    const validated = validateReadChatResultPayload(parsed, 'ide read_chat');
                    _log(`OK: ${validated.messages?.length || 0} msgs`);
                    traceProviderEvent(args, 'provider', 'ide.read_chat.success', {
                        h,
                        provider,
                        payload: {
                            method: 'evaluate',
                            result: evalResult.result,
                            parsed: validated,
                            messageCount: Array.isArray(validated.messages) ? validated.messages.length : 0,
                        },
                    });
                    h.historyWriter.appendNewMessages(
                        provider?.type || getCurrentProviderType(h, 'unknown_ide'),
                        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
                        validated.title,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult(validated as Record<string, any>, args, h);
                }
                if (!ideReadChatError) {
                    ideReadChatError = 'ide read_chat returned a non-object payload';
                }
            } else {
                ideReadChatError = 'ide read_chat returned no payload';
            }
        } catch (e: any) {
            ideReadChatError = `ide read_chat failed: ${e?.message || String(e)}`;
            LOG.info('Command', `[read_chat] Script error: ${e.message}`);
            traceProviderEvent(args, 'provider', 'ide.read_chat.error', {
                h,
                provider,
                level: 'warn',
                payload: { method: 'evaluate', error: e.message },
            });
        }
        return { success: false, error: ideReadChatError || 'ide read_chat unavailable' };
    }

    return { success: false, error: 'read_chat unavailable' };
}
