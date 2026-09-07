/**
 * Chat Commands — read side: presentation.
 *
 * The last mile of read_chat: status normalization, streaming finalization,
 * adjacent-duplicate collapsing, tail windowing, and assembly of the validated
 * read_chat CommandResult. These helpers depend on neither the provider-session
 * pin map nor native-history resolution state, which is what makes them safe to
 * lift out on their own.
 *
 * Split out of chat-commands-read.ts verbatim — no behaviour change.
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import { isValidReadChatStatus, validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import { resolveSessionTurnPresentation } from '../mesh/mesh-turn-presentation.js';
import type { ChatMessage } from '../types.js';
import { filterUserFacingChatMessages, isActivityChatMessage, isUserFacingChatMessage } from '../providers/chat-message-normalization.js';
import {
    maybeHideCoordinatorPromptMessage,
    normalizeReadChatMessages,
    normalizeReadChatTailLimit,
} from './read-chat-message-filters.js';
import { buildTranscriptObservationFromReadChat } from './transcript-observation-builder.js';
import { notifyTranscriptObservation } from '../seqscribe/transcript-publisher.js';

function shouldPreserveReadChatPayloadField(key: string): boolean {
    return key === 'messageSource' || key === 'transcriptProvenance';
}

/**
 * Resolve the provider identity for this read, in the same order the upstream
 * pipeline already uses (`chat-commands-read.ts`: explicit args > session
 * registry > current session). The args-only form this used to have was a
 * silent trap: `buildTranscriptObservationFromReadChat` returns null on an
 * empty providerType, so any caller that has a session id but no provider name
 * built NO transcript observation at all — and the choke point below is
 * fire-and-forget, so it failed without a log line.
 *
 * The caller that hits that gap is the transcript projection's own collector
 * (`boot/daemon-lifecycle.ts`), which re-enters read_chat with only
 * `{ targetSessionId }`. Dashboard reads pass `agentType` and were unaffected,
 * which is why this only ever showed up on the replica lane: a session whose
 * live streaming depends on the internal pull — e.g. one that selected
 * `native-history`, where PTY bubbles are suppressed as a content source —
 * published zero revisions while its message count climbed.
 *
 * `payload.debugReadChat.provider` is the already-resolved `adapter.cliType`
 * from the read that produced this payload, so it is preferred over the
 * registry lookup and makes the resolution work even without helpers.
 */
function resolveReadChatProviderHint(
    payload: Record<string, any>,
    args: any,
    h: CommandHelpers | undefined,
    sessionIdHint: string,
): string {
    if (typeof args?.cliType === 'string' && args.cliType) return args.cliType;
    if (typeof args?.providerType === 'string' && args.providerType) return args.providerType;
    if (typeof args?.agentType === 'string' && args.agentType) return args.agentType;
    const fromPayload = payload?.debugReadChat?.provider;
    if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
    if (sessionIdHint) {
        const session = (h?.ctx as any)?.sessionRegistry?.get?.(sessionIdHint);
        if (typeof session?.providerType === 'string' && session.providerType) return session.providerType;
    }
    const current = (h?.currentSession as any)?.providerType;
    if (typeof current === 'string' && current) return current;
    return '';
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

export function buildFullTail(messages: ChatMessage[], tailLimit: number): {
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

export function hasNonEmptyModalButtons(activeModal: unknown): boolean {
    if (!activeModal || typeof activeModal !== 'object') return false;
    const buttons = (activeModal as { buttons?: unknown }).buttons;
    return Array.isArray(buttons) && buttons.some((button) => typeof button === 'string' && button.trim().length > 0);
}

export function normalizeReadChatCommandStatus(status: unknown, activeModal: unknown): string {
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
            // Contract clamp (owner-visible failure 2026-08-24: a worker
            // session's turn projection surfaced raw 'stopped' and every
            // read_chat failed validation in a 2s loop — the reader lost the
            // ENTIRE transcript over one unknown status token). An unknown
            // status maps to the closest honest contract value instead of
            // failing the read: modal staged → waiting_approval, else
            // no_progress ("cannot prove progress"), which no consumer treats
            // as terminal or as completion evidence.
            if (!isValidReadChatStatus(raw)) {
                return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'no_progress';
            }
            return raw;
    }
}

export function finalizeStreamingMessagesWhenIdle(messages: ChatMessage[], status: string): ChatMessage[] {
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
export function collapseAdjacentDuplicateChatMessages(messages: ChatMessage[]): ChatMessage[] {
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

export function buildReadChatCommandResult(payload: Record<string, any>, args: any, h?: CommandHelpers): CommandResult {
    let validatedPayload: Record<string, any>;
    const debugReadChat = payload?.debugReadChat && typeof payload.debugReadChat === 'object'
        ? payload.debugReadChat
        : undefined;
    // TURN-PRESENTATION (Stage 6): for a session with a mesh turn attempt, the
    // reducer projection is the status authority — the legacy point-sample /
    // null→idle derivations above still run (they feed the shadow comparator and
    // remain the fallback for sessions with no attempt), but they can no longer
    // override the projected execution state on this surface.
    const presentationSessionIdHint = typeof args?.targetSessionId === 'string' && args.targetSessionId.trim()
        ? args.targetSessionId.trim()
        : typeof args?.sessionId === 'string' && args.sessionId.trim()
            ? args.sessionId.trim()
            : typeof (h?.currentSession as any)?.sessionId === 'string' ? String((h!.currentSession as any).sessionId) : '';
    const providerHint = resolveReadChatProviderHint(payload, args, h, presentationSessionIdHint);
    const legacyStatus = normalizeReadChatCommandStatus(payload?.status, payload?.activeModal);
    const turnPresentation = resolveSessionTurnPresentation({
        sessionId: presentationSessionIdHint || undefined,
        legacyStatus,
        providerType: providerHint || undefined,
        surface: 'read_chat',
    });
    let effectiveStatus = legacyStatus;
    if (turnPresentation.authority === 'turn_reducer') {
        // The reducer projection is the status AUTHORITY, but not a contract
        // bypass: its raw vocabulary ('stopped', …) must pass through the same
        // normalizer as the legacy sample, or one out-of-contract token fails
        // the whole read (the 2026-08-24 loop failure above).
        effectiveStatus = normalizeReadChatCommandStatus(turnPresentation.status, payload?.activeModal);
        // Contract safety: waiting_approval requires activeModal buttons. If the
        // reducer parked the attempt but the modal is not staged on THIS read yet,
        // present generating rather than failing the read (the next poll surfaces
        // the modal) — same rule the legacy path applies.
        if (effectiveStatus === 'waiting_approval' && !hasNonEmptyModalButtons(payload?.activeModal)) {
            effectiveStatus = 'generating';
        }
    }
    try {
        validatedPayload = validateReadChatResultPayload({
            ...payload,
            status: effectiveStatus,
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
    // (sessionIdHint keeps its ORIGINAL semantics for the coordinator-prompt
    // filter — no current-session fallback — so message content filtering is
    // unchanged by the Stage 6 status-authority work.)
    const sessionIdHint = typeof args?.targetSessionId === 'string' ? args.targetSessionId
        : typeof args?.sessionId === 'string' ? args.sessionId
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

    // ── §8 unit 2 choke point (design §5.2) ─────────────────────────────────
    // "buildReadChatCommandResult의 validation/source selection 뒤, tail
    // slicing 전에 typed TranscriptObservation을 만든다." The observation still
    // carries `visibleMessages` (the FULL set this read observed, never
    // `sync.messages`'s request-specific tailLimit slice) — `sync` only had to
    // be computed first here because `preservedPayloadFields.messageSource`'s
    // returnedCount is refreshed from it above, and this block reuses that
    // same `preservedPayloadFields` object as the observation's provenance.
    // Fire-and-forget and exception-swallowed: `notifyTranscriptObservation` is
    // a safe no-op until a later unit (§8 unit 3+) calls
    // `configureTranscriptProjection`, and even once configured it must NEVER
    // be able to break this read.
    try {
        const observation = buildTranscriptObservationFromReadChat({
            sessionId: sessionIdHint || presentationSessionIdHint,
            historySessionId: typeof validatedPayload.historySessionId === 'string' ? validatedPayload.historySessionId : null,
            providerType: providerHint || turnPresentation.providerType || '',
            providerSessionId: typeof validatedPayload.providerSessionId === 'string' ? validatedPayload.providerSessionId : null,
            status: effectiveStatus,
            providerObservedStatus: legacyStatus,
            title: typeof validatedPayload.title === 'string' ? validatedPayload.title : null,
            activeModal: validatedPayload.activeModal ?? null,
            activeInteractivePrompt: validatedPayload.activeInteractivePrompt ?? null,
            turn: turnPresentation.authority === 'turn_reducer' ? turnPresentation : null,
            provenance: preservedPayloadFields,
            messages: visibleMessages,
            coverage: {
                mode: 'full',
                totalMessageCount: messages.length,
                returnedMessageCount: visibleMessages.length,
                omittedBefore: false,
            },
        });
        if (observation) notifyTranscriptObservation(observation.sessionId, observation);
    } catch {
        // Transcript projection must never be able to break read_chat itself.
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
        // PROJECTION-SELF-REFERENCE (turn-completion deadlock): the provider's OWN
        // status verdict, BEFORE the Stage 6 projection overrides it above.
        //
        // Why this must be emitted separately: when an attempt exists, `status`
        // becomes the ledger stage. The mesh transcript completion poll
        // (pollAssignedTaskTerminalEvidence) then required `status === 'idle'`
        // before it would write the terminal outcome INTO that same ledger — so a
        // finished worker's ledger stage stayed `generating` forever, and the
        // stage it was waiting on was the one only it could advance. Live: attempt
        // 22ac9624 frozen at stage=generating for 1h+ with 328 `session_not_idle`
        // drops, reproduced on codex-cli AND claude-cli (not provider-specific).
        //
        // This field breaks the cycle by preserving the one input that is
        // genuinely independent of the ledger. It is ADDITIVE — `status` keeps its
        // Stage 6 semantics for every existing consumer, and nothing that relies
        // on the projection overriding the point sample changes behaviour.
        // Consumers must NOT use this as a general status: a point sample can read
        // idle mid-turn, which is exactly why Stage 6 exists. It is safe only
        // behind the poll's structural turn-end guards (post-dispatch final
        // assistant, no trailing tool activity, settle window).
        providerObservedStatus: legacyStatus,
        // Stage 6: the authoritative turn presentation rides the read_chat
        // payload for mesh-owned sessions (identity + stage + evidence
        // timestamps; the `status` field above already reflects it).
        ...(turnPresentation.authority === 'turn_reducer' ? { turn: turnPresentation } : {}),
        ...(returnedDebugReadChat ? { debugReadChat: returnedDebugReadChat } : {}),
    };
}
