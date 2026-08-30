/**
 * `web_chat_pane` / `web_warm_mobile_preview` roster adapter — design §4, §8
 * unit 5 ("web chat pane consumer cutover").
 *
 * Maps a verified-complete `ReplicatedTranscriptSnapshotV1` (§8 unit 1's
 * closed wire allow-list) into the exact `SessionChatTailUpdate` shape
 * `SessionChatTailController.handleUpdate` already consumes (design:
 * "기존 controller snapshot API 유지"), so every existing shrink-defense /
 * dedup / force-apply rule in that controller composes unchanged regardless
 * of which source (replica or legacy `session.chat_tail`) produced the
 * update. `web_warm_mobile_preview` needs no separate adapter — per §4 it
 * reads the SAME warm controller snapshot this feeds, via
 * `getSessionChatTailSnapshotForConversation`.
 *
 * ── What does NOT round-trip, and why that is safe ──────────────────────────
 * `ReplicatedTranscriptSnapshotV1.provenance.messageSource` is a single
 * allow-listed SCALAR (§2.4: "provenance: messageSource/transcriptProvenance
 * 의 명시적 scalar/enum allow-list"), not the rich `{selected, fallbackReason,
 * nativeSource}` object `read_chat`'s live `messageSource` carries. This
 * adapter reconstructs only `{selected: <that scalar>}`. The controller's A3
 * shrink-defense (`isNativeHistorySource`, `shouldForceApplyNativeAssistantTail`)
 * only ever reads `.selected` — so the important fast path (force-apply a
 * native-history tail that finally adds the assistant answer) still fires.
 * The `fallbackReason`-keyed LENIENCY branch inside `shouldDeferBusyTailUpdate`
 * simply never engages for a replica-sourced update (no `fallbackReason`
 * field to read), which falls through to the stricter count-heuristic — a
 * safe direction to fail in (more conservative shrink-defense, never less).
 *
 * `activeInteractivePrompt` is intentionally left `null`: the allow-listed
 * `ReplicatedTranscriptPromptV1` (`{message, options}`) cannot reconstruct a
 * full `InteractivePrompt` (`promptId/origin/providerType/createdAt/
 * questions[]`, `providers/types/interactive-prompt.ts`) needed to ANSWER a
 * prompt — and answering always requires a live daemon RPC regardless of
 * transcript source, so this is not a functional regression.
 */
import type {
    ChatMessage,
    ReplicatedTranscriptMessageV1,
    ReplicatedTranscriptSnapshotV1,
    SessionChatTailUpdate,
} from '@adhdev/daemon-core'
import type { DashboardMessage } from './types'

/** One roster-mapped message. `turnKey` (the allow-listed "stable message key",
 * §2.4) stands in for the richer `bubbleId`/`providerUnitKey`/`id` fields a
 * live `read_chat` message carries, since the wire allow-list has only one
 * stable-identity field. */
function mapTranscriptMessage(message: ReplicatedTranscriptMessageV1): DashboardMessage {
    const mapped: ChatMessage = {
        role: message.role,
        kind: message.kind as ChatMessage['kind'],
        content: message.content,
    }
    if (message.receivedAt !== null) mapped.receivedAt = message.receivedAt
    if (message.timestamp !== null) mapped.timestamp = message.timestamp
    if (message.bubbleState !== null) mapped.bubbleState = message.bubbleState
    if (message.senderName !== null) mapped.senderName = message.senderName
    if (message.turnKey !== null) {
        mapped.bubbleId = message.turnKey
        mapped._turnKey = message.turnKey
    }
    return mapped as DashboardMessage
}

/**
 * The (necessarily narrower) `messageSource` reconstruction — see this file's
 * header for what it can and cannot carry.
 */
function mapMessageSource(
    provenance: ReplicatedTranscriptSnapshotV1['provenance'],
): Record<string, unknown> | undefined {
    if (!provenance.messageSource) return undefined
    return { selected: provenance.messageSource }
}

export interface TranscriptChatTailUpdate extends SessionChatTailUpdate {
    /** Ring/SNAP-reset discontinuity — design §3.7's "이전 내용 생략" signal. */
    omittedBefore: boolean
    /** Design §5.5's "stale idle UI" — a replica tail whose freshness gate did not hold. */
    stale: boolean
    /** Single-source-of-truth telemetry field (design §5.6). */
    transcriptReadSource: 'replica'
}

/**
 * Map one verified-complete replica snapshot into the controller's update
 * shape. `subscriptionKey`/`seq`/`timestamp` are wire bookkeeping the
 * controller's `handleUpdate` does not read (see its `readChatTailUpdateMessages`/
 * `readUpdateStringField` helpers) — filled with harmless placeholders so the
 * object satisfies `SessionChatTailUpdate` structurally.
 *
 * `omittedBefore`/`stale` are the CALLER's readiness/SNAP-reset decision
 * (design §3.7, §5.5) — this function only carries them onto the wire shape,
 * it does not compute them from the snapshot itself.
 */
export function mapTranscriptSnapshotToChatTailUpdate(
    snapshot: ReplicatedTranscriptSnapshotV1,
    options: { subscriptionKey: string; omittedBefore: boolean; stale: boolean },
): TranscriptChatTailUpdate {
    const messageSource = mapMessageSource(snapshot.provenance)
    return {
        topic: 'session.chat_tail',
        key: options.subscriptionKey,
        sessionId: snapshot.sessionId,
        ...(snapshot.historySessionId ? { historySessionId: snapshot.historySessionId } : {}),
        seq: snapshot.revision,
        timestamp: 0,
        messages: snapshot.messages.map(mapTranscriptMessage),
        status: snapshot.status,
        ...(snapshot.title ? { title: snapshot.title } : {}),
        activeModal: snapshot.activeModal
            ? { message: snapshot.activeModal.message, buttons: [...snapshot.activeModal.buttons] }
            : null,
        activeInteractivePrompt: null,
        ...(messageSource ? { messageSource } : {}),
        omittedBefore: options.omittedBefore,
        stale: options.stale,
        transcriptReadSource: 'replica',
    }
}
