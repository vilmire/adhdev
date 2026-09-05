/**
 * Chat Commands — read side: handleReadChat, handleChatHistory and the
 * native-history / source-resolution / normalization helpers they use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandResult, CommandHelpers } from './handler.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { flattenContent, type ProviderModule, type ProviderScripts } from '../providers/contracts.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import { isNativeSourceCanonicalHistory, readChatHistory, readProviderChatHistory } from '../config/chat-history.js';
import { clearPersistedProviderSessionPins, loadPersistedProviderSessionPins, recordPersistedProviderSessionPin } from '../config/state-store.js';
import { LOG } from '../logging/logger.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { hashSignatureParts } from '../chat/chat-signatures.js';
import type { ChatMessage } from '../types.js';
import { filterUserFacingChatMessages, normalizeChatMessages, hasTrailingToolActivityAfterFinalAssistant } from '../providers/chat-message-normalization.js';
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
import {
    maybeHideCoordinatorPromptMessage,
    normalizeReadChatMessages,
    normalizeReadChatTailLimit,
} from './read-chat-message-filters.js';
import { decideCliReadChatSource, supportsCliNativeTranscript } from './read-chat-source-decision.js';
// (NATIVE-TURN-SIGNAL) turn-terminal marker selection — pure-move extraction
// (file-size gate); logic unchanged, see the module header.
import {
    readChatNativeTurnTerminalMarkers,
    readLiveCodexWorkspaceNativeHistory,
    selectAdapterTurnTerminalMarkers,
    selectHistoryTurnTerminalMarkers,
} from './chat-commands-read-turn-markers.js';
import {
    buildReadChatCommandResult,
    collapseAdjacentDuplicateChatMessages,
    finalizeStreamingMessagesWhenIdle,
    hasNonEmptyModalButtons,
} from './read-chat-presentation.js';

// Minimum tail floor for hot-path history/mirror reads. The dashboard requests a
// bounded tail (~60); we keep a small floor so a tiny requested tailLimit still
// has enough surrounding context for seed/mirror dedup correctness, but it must
// NOT dominate the hot subscribe/poll path the way the previous 200 floor did.
// readChatHistory now serves this as an O(tail) bounded read, so the cost scales
// with this floor, not with total accumulated history.
const HOT_TAIL_MIN_LIMIT = 60;

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

interface ResolvedNativeHistoryReadSession {
    /**
     * True when the candidate history id is the daemon runtime session id (==
     * targetSessionId) standing in for a real provider-native conv uuid — reached
     * either via getHistorySessionId's internal fallback (empty args) or because
     * the browser explicitly echoed targetSessionId back as historySessionId (the
     * poisoned agy-coordinator read). See isRuntimeFallbackHistorySessionId.
     */
    isRuntimeFallback: boolean;
    /** Owner-confirmed pin recorded by a prior bound read for this mesh session, if any. */
    pinnedProviderSessionId: string | undefined;
    /**
     * The id to key the native read on: the pin (or undefined) when the candidate
     * is a runtime fallback so pin / workspace-latest resolution engages, else the
     * candidate unchanged (a real DISTINCT provider uuid still exact-binds).
     */
    effectiveHistorySessionId: string | undefined;
}

/**
 * Resolve the runtime-fallback → pin substitution shared by every native-history
 * read path (handleChatHistory, the CLI-adapter main read, and the history-only
 * read). Each site previously inlined this same four-step computation verbatim:
 * detect the runtime fallback (candidate === targetSessionId AND no distinct
 * explicit id), look up the owner-confirmed pin, and drop the runtime id in favor
 * of the pin (or undefined) so readCliProviderNativeHistory's pin / workspace-
 * latest paths can engage instead of fail-closing to pty-parser. Extracted to a
 * single helper so the D9 historySessionId-poison guard has one definition.
 * Behavior is identical to the inlined blocks — same target (args.targetSessionId),
 * same explicit-id source, same pin key (getBoundProviderSessionIdPin trims).
 */
function resolveNativeHistoryReadSession(
    args: any,
    candidateHistorySessionId: string | undefined,
): ResolvedNativeHistoryReadSession {
    const targetSid = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const explicitHistorySessionId = getExplicitHistorySessionId(args);
    const isRuntimeFallback = Boolean(
        targetSid
        && isRuntimeFallbackHistorySessionId(candidateHistorySessionId, targetSid)
        && (!explicitHistorySessionId
            || isRuntimeFallbackHistorySessionId(explicitHistorySessionId, targetSid)),
    );
    const pinnedProviderSessionId = getBoundProviderSessionIdPin(args?.targetSessionId);
    const effectiveHistorySessionId = isRuntimeFallback
        ? (pinnedProviderSessionId || undefined)
        : candidateHistorySessionId;
    return { isRuntimeFallback, pinnedProviderSessionId, effectiveHistorySessionId };
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
    // (CHAT-FLAP-LONG-CONVO) v3 native identity is daemon-stamped and
    // position-independent (see normalizeNativeHistoryMessages); trust it the
    // same way so a re-read of an already-normalized message preserves its key.
    if (providerUnitKey.startsWith('v2:') || providerUnitKey.startsWith('v2-pty:') || providerUnitKey.startsWith('v3:')) {
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

export function normalizeNativeHistoryMessages(providerType: string, messages: ChatMessage[], nativeSessionId?: string): ChatMessage[] {
    let turnIndex = 0;
    // (CHAT-FLAP-LONG-CONVO root fix) The providerUnitKey / bubbleId MUST be
    // position-independent: native history is re-derived on every read_chat, so
    // sending a user message grows the tail and shifts every array index by one.
    // A key that embeds `index` therefore changes for every pre-existing bubble
    // across a send → web-core getChatMessageStableKey (which correctly trusts
    // bubbleId/providerUnitKey as identity) sees a new React key → unmount+remount
    // flash. The invariant we enforce here: the same logical message keeps the
    // same key as the tail grows; different messages get different keys.
    //
    // Position-independent identity = (role, kind, content-signature) plus, for
    // messages whose (role, kind, content-signature) collides (e.g. an identical
    // reply repeated in the transcript, or ts-less messages), a stable occurrence
    // ordinal: the count of prior messages sharing the same signature. Appending
    // to the tail never renumbers earlier occurrences, so the ordinal is stable.
    // A provider-supplied native id (message.id) short-circuits the ordinal — it
    // is already globally unique and position-independent.
    const signatureOccurrences = new Map<string, number>();
    // Anchor for the ts-less sequence fallback (see below): the last real
    // timestamp seen, plus a running offset so consecutive ts-less messages stay
    // strictly ordered after it.
    let lastSequenceAnchor = 0;
    let anchorOffset = 0;
    return normalizeChatMessages(messages).map((message, index) => {
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        const kind = typeof message.kind === 'string' && message.kind.trim() ? message.kind.trim() : (role === 'system' ? 'system' : 'standard');
        if ((role === 'user' || role === 'human') && index > 0) turnIndex += 1;
        const historySessionId = typeof (message as any).historySessionId === 'string'
            ? (message as any).historySessionId.trim()
            : '';
        // Content signature is intentionally position-independent: the ts fallback
        // is '' (NOT `index`) so a message with no timestamp still hashes the same
        // regardless of where it sits in the array. Hash the FULL flattened content
        // (no slice) so distinct long messages that share a 12-char prefix do not
        // collide.
        const contentSignature = hashSignatureParts([
            providerType,
            historySessionId,
            String(message.receivedAt || message.timestamp || ''),
            role,
            kind,
            flattenContent(message.content),
        ]);
        const contentHash = contentSignature.slice(0, 12);
        const nativeIdentitySessionId = historySessionId || (typeof nativeSessionId === 'string' ? nativeSessionId.trim() : '');
        // Stable occurrence ordinal for signature collisions (0 for the first,
        // 1 for the second identical-signature message, …). A provider-native id,
        // when present, is preferred as the collision discriminator because it is
        // globally unique and never renumbers.
        const nativeMessageId = typeof message.id === 'string' && message.id.trim() ? message.id.trim() : '';
        const occurrence = signatureOccurrences.get(contentSignature) ?? 0;
        signatureOccurrences.set(contentSignature, occurrence + 1);
        const collisionDiscriminator = nativeMessageId || `#${occurrence}`;
        const preserveNativeIdentity = shouldPreserveNativeIdentity(providerType, nativeIdentitySessionId, message);
        const existingProviderUnitKey = typeof message.providerUnitKey === 'string' ? message.providerUnitKey.trim() : '';
        const existingTurnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
        const providerUnitKey = preserveNativeIdentity
            ? existingProviderUnitKey
            : `v3:${providerType}:native:${nativeIdentitySessionId || 'workspace'}:${role || 'message'}:${kind}:${contentHash}:${collisionDiscriminator}`;
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
        // (CHAT-FLAP-LONG-CONVO) sequence is part of web-core's React-key
        // composite, so a ts-less fallback of `index` would also shift the key
        // across a send. Anchor a ts-less message to the last real timestamp
        // seen (plus its occurrence offset within that anchor) so the value stays
        // ordered AND stable under tail-append instead of tracking the raw
        // array position.
        let sequence: number;
        if (existingSequence !== null) {
            sequence = existingSequence;
        } else if (tsCandidate > 0) {
            sequence = tsCandidate;
            lastSequenceAnchor = tsCandidate;
            anchorOffset = 0;
        } else {
            anchorOffset += 1;
            sequence = lastSequenceAnchor + anchorOffset;
        }
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

/**
 * LOAD-OLDER PTY FALLBACK (zero-bubble fix): when an exact (session-scoped)
 * native-history read comes back empty or unsafe but the session's own PTY
 * transcript has rows, serve those rows as the chat_history page instead of
 * returning []. This is the "Load older" twin of the read_chat STICKY-NATIVE
 * empty-hold fix: the same transient native gap that must not blank the live
 * tail must also not make history paging unrecoverable.
 *
 * Safety is fail-closed, mirroring isCurrentRuntimePtySafelyAttributed: the
 * adapter must be runtime-bound to the session being read (runtimeId match),
 * must not be an inactive/recovery surface, and its working directory must
 * match the session workspace (symlink-safe compare). Anything unproven
 * returns null and the caller keeps the previous empty/native-unavailable
 * response, so untrusted cross-session PTY content is never exposed.
 *
 * Paging contract matches the native path: exclude the rows the live tail
 * already shows (excludeRecentCount), then walk older pages by offset/limit.
 */
function readSafeSessionPtyHistoryPage(args: {
    h: CommandHelpers;
    readArgs: any;
    provider?: ProviderModule;
    sessionWorkspace?: string;
    excludeRecentCount: number;
    offset: number;
    limit: number;
}): { messages: ChatMessage[]; hasMore: boolean } | null {
    const adapter = getTargetedCliAdapter(args.h, args.readArgs, args.provider?.type);
    if (!adapter || typeof adapter.getScriptParsedStatus !== 'function') return null;
    const targetSessionId = effectiveReadSessionId(args.h, args.readArgs?.targetSessionId);
    if (!targetSessionId) return null;
    const runtimeMeta = typeof (adapter as any).getRuntimeMetadata === 'function'
        ? (adapter as any).getRuntimeMetadata()
        : null;
    const runtimeId = typeof runtimeMeta?.runtimeId === 'string' ? runtimeMeta.runtimeId.trim() : '';
    if (!runtimeId || runtimeId !== targetSessionId) return null;
    const surfaceKind = typeof runtimeMeta?.surfaceKind === 'string' ? runtimeMeta.surfaceKind : '';
    if (surfaceKind === 'inactive_record' || surfaceKind === 'recovery_snapshot') return null;
    const sessionWorkspace = normalizeComparableWorkspace(args.sessionWorkspace);
    const adapterWorkspace = normalizeComparableWorkspace(adapter.workingDir);
    if (!sessionWorkspace || !adapterWorkspace || sessionWorkspace !== adapterWorkspace) return null;

    let parsed: any = null;
    try {
        parsed = parseMaybeJson(adapter.getScriptParsedStatus());
    } catch {
        return null;
    }
    const ptyMessages = collapseAdjacentDuplicateChatMessages(
        normalizeChatMessages(Array.isArray(parsed?.messages) ? parsed.messages as ChatMessage[] : []),
    );
    if (ptyMessages.length === 0) return null;
    const end = Math.max(0, ptyMessages.length - args.excludeRecentCount - args.offset);
    const start = Math.max(0, end - args.limit);
    return { messages: ptyMessages.slice(start, end), hasMore: start > 0 };
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

// (A2.2) isNativeHistoryFreshEnough removed. The v1 freshness comparison
// (native_newest vs pty_newest with a 5-minute mtime grace window) was the
// direct cause of the plipping behaviour: PTY arrived every turn so native
// looked stale by default. ChatSourceMachine never compares native vs PTY
// freshness — the lock holds across arbitrary PTY arrival. See
// chat/source-machine.ts for the new semantics.

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
        // (SEAM) Identity of the oldest message in the browser's live window.
        // Preferred over `excludeRecentCount` — that count is measured in bubble
        // space but subtracted from collapsed-record space, so it overshoots
        // whenever collapse shrinks the set and leaves a silent hole. Absent from
        // older browsers, in which case the count path is used unchanged.
        const excludeFromIdentity = typeof args?.excludeFromIdentity === 'string' && args.excludeFromIdentity
            ? args.excludeFromIdentity
            : undefined;
        const workspace = typeof args?.workspace === 'string'
            ? args.workspace
            : typeof (h.currentSession as any)?.workspace === 'string'
                ? (h.currentSession as any).workspace
                : undefined;
        // Same runtime-fallback poison guard as the subscribe / history-only
        // paths (see resolveNativeHistoryReadSession): getHistorySessionId falls
        // back to targetSessionId (the ADHDev id) for an agy coordinator, and the
        // browser may also send that id back explicitly. Reading native history
        // keyed on it can never exact-bind (it is not the on-disk conv uuid). Drop
        // it here too so the pin / workspace-latest / owner-confirmed resolution
        // engages instead of fail-closing to pty-parser. A real DISTINCT provider
        // uuid is preserved.
        const {
            isRuntimeFallback: historySessionIdIsRuntimeFallback,
            pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
            effectiveHistorySessionId,
        } = resolveNativeHistoryReadSession(args, historySessionId);
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
                excludeFromIdentity,
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
                excludeFromIdentity,
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
            const nativeUnsafeMapping = (result as any).source === 'provider-native' && messages.length > 0 && !safeMapping;
            // LOAD-OLDER PTY FALLBACK (zero-bubble fix): an exact session-scoped
            // native read that is empty (the same transient gap that blanks the
            // live tail) or unsafe must not leave "Load older" returning []
            // forever when the session's own PTY transcript has safely
            // attributable rows. Fail-closed inside readSafeSessionPtyHistoryPage
            // (runtime identity + workspace checks), so untrusted cross-session
            // PTY content is never exposed.
            if ((nativeUnsafeMapping || messages.length === 0) && exactNativeHistoryScope) {
                const ptyPage = readSafeSessionPtyHistoryPage({
                    h,
                    readArgs: args,
                    provider,
                    sessionWorkspace: workspace,
                    excludeRecentCount,
                    offset: offset || 0,
                    limit: limit || 30,
                });
                if (ptyPage) {
                    return {
                        success: true,
                        messages: ptyPage.messages,
                        hasMore: ptyPage.hasMore,
                        source: 'pty-parser',
                        agent: agentStr,
                    };
                }
            }
            if (nativeUnsafeMapping) {
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
                // Runtime-fallback → pin substitution (see
                // resolveNativeHistoryReadSession): nativeHistoryReadSessionId is
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
                const {
                    pinnedProviderSessionId: pinnedProviderSessionIdForRead,
                    effectiveHistorySessionId: effectiveNativeReadSessionId,
                } = resolveNativeHistoryReadSession(args, nativeHistoryReadSessionId);
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
            // (NATIVE-TURN-SIGNAL) Markers captured from the codex live-workspace
            // native probe when THAT read is the one the machine selects (the
            // primary nativeHistory may be unread/unsafe in that branch).
            let liveSelectedNativeTurnTerminalMarkers: unknown[] | undefined = undefined;

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
                        liveSelectedNativeTurnTerminalMarkers = readChatNativeTurnTerminalMarkers(liveWorkspaceNativeHistory);
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
            // RC17-NATIVE-FINAL-ASSISTANT-MIDTURN: hasFinalVisibleAssistantMessage only
            // checks that the LAST visible native-transcript message is a non-empty
            // assistant/model bubble — it has no notion of whether that bubble is
            // actually the end of the turn. A live Claude repro showed this reconciling
            // generating→idle on an INTERIM narration bubble ("Starting the collector
            // now, before the two-turn protocol.") emitted mid-turn, well before the
            // real two-turn protocol/tool work ran — exactly the false-completion class
            // rc.16 (9452bd03/6677a565) closed for the mesh-event ingress via
            // hasTrailingToolActivityAfterFinalAssistant + hasLiveTurnPendingEvidence.
            // This read_chat status ingress is a SEPARATE consumer of the same
            // native-final-assistant signal (it feeds the `status` field returned to
            // read_chat/dashboard, not the mesh agent:generating_completed event) and
            // never got the equivalent veto. This reconciliation exists precisely for a
            // PTY/adapter status detector that never transitions to idle on its own (see
            // read-chat-completed-session-fallback.test.ts's antigravity stuck-busy
            // case: isProcessing() stays true forever, empty PTY messages, and native
            // history is the only signal that ever resolves it) — so gating on the
            // adapter's own pending-response bit here would neuter this reconciliation
            // for that exact intended case. Apply only STRUCTURAL, evidence-based vetoes
            // instead, mirroring rc.16's hasLiveTurnPendingEvidence: trailing tool/
            // terminal activity after the final-looking assistant bubble, scanned in (a)
            // the native messages being judged — the transcript's own admission that its
            // "final" bubble kept going — and (b) the live PTY-parsed tail
            // (returnedMessages), which carries no native-transcript write-lag and is
            // exactly how a live Claude repro was caught: the native JSONL's last row was
            // still the interim narration bubble (no trailing tool row landed there yet),
            // but the PTY had already rendered the very next "Auto-approved: Yes\nBash
            // command" tool activity. The antigravity stuck-busy case has an EMPTY PTY
            // message list, so (b) is a no-op there (the function short-circuits false on
            // an empty/absent array) and the existing regression is unaffected.
            if (
                isGeneratingLikeStatus(selectedStatus)
                && selectedTranscriptAuthority === 'provider'
                && !hasNonEmptyModalButtons(activeModal)
                && hasFinalVisibleAssistantMessage(selectedMessages)
                && !hasTrailingToolActivityAfterFinalAssistant(selectedMessages as any)
                && !hasTrailingToolActivityAfterFinalAssistant(returnedMessages as any)
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
            // (NATIVE-TURN-SIGNAL) marker selection — see chat-commands-read-turn-markers.ts.
            const turnTerminalMarkers = selectAdapterTurnTerminalMarkers({
                nativeSelected: primary.nativeSelected,
                safeMapping,
                nativeHistory,
                liveSelected: liveSelectedNativeTurnTerminalMarkers,
            });
            return buildReadChatCommandResult({
                messages: selectedMessages,
                status: selectedStatus,
                activeModal,
                messageSource,
                transcriptProvenance: messageSource,
                ...(turnTerminalMarkers !== undefined ? { turnTerminalMarkers } : {}),
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
            // read, prefer the pin so the query hits the real session. Detects the
            // fallback whether historySessionId reached targetSid via
            // getHistorySessionId's internal fallback (empty args) or the browser
            // explicitly echoed targetSid back (poisoned agy-coordinator
            // subscription / D8 refreshAuthoritativeTail read); a real DISTINCT
            // provider uuid still exact-binds unchanged. See
            // resolveNativeHistoryReadSession.
            const {
                isRuntimeFallback: historySessionIdIsRuntimeFallback,
                pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
                effectiveHistorySessionId: effectiveHistorySessionIdForRead,
            } = resolveNativeHistoryReadSession(args, historySessionId);
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

            // (NATIVE-TURN-SIGNAL) marker selection — same rule as the adapter
            // path; see chat-commands-read-turn-markers.ts.
            const historyTurnTerminalMarkers = selectHistoryTurnTerminalMarkers({
                nativeSelected: decision.nativeSelected,
                safeMapping,
                history,
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
                        ...(historyTurnTerminalMarkers !== undefined ? { turnTerminalMarkers: historyTurnTerminalMarkers } : {}),
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
                ...(historyTurnTerminalMarkers !== undefined ? { turnTerminalMarkers: historyTurnTerminalMarkers } : {}),
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
