/**
 * `web_chat_pane` / `web_warm_mobile_preview` roster adapter — design
 * 2026-09-28 message-keyed storage §5.4.
 *
 * Maps a verified committed `ReplicatedTranscriptViewV2` (the worker's
 * `KeyedTranscriptFolder` output, mirrored on the main thread by
 * `transcript-view-mirror.ts`) into the rows `SessionChatController` renders.
 * The keyed chat lane is the chat pane's ONLY live source (desktop and mobile,
 * cloud and standalone — design §6.4); `web_warm_mobile_preview` reads the SAME
 * warm controller snapshot this feeds, via
 * `getSessionChatSnapshotForConversation`.
 *
 * ── Bubble identity is the producer's `messageId` ───────────────────────────
 * Every bubble on the keyed wire carries the daemon ledger's opaque
 * `messageId` (unique per bubble within the session, stable across re-reads,
 * streaming growth and source handoffs). It becomes `ChatMessage.id` AND
 * `messageId`, so `getChatMessageStableKey` keys the row `mid:<messageId>`.
 * Order is the view's `ord` order.
 *
 * ── Change detection is by `rev`, and unchanged bubbles keep their object ───
 * `mapTranscriptViewToChatView` reuses the previously mapped `DashboardMessage`
 * for every bubble whose `(messageId, rev)` did not move
 * (`TranscriptBubbleCache`). The controller then sees reference-equal rows for
 * untouched bubbles, React's memoized rows skip them, and only the bubbles a
 * frame actually changed re-render — no remount, no whole-list churn.
 *
 * `activeInteractivePrompt` is not carried: the allow-listed `{message,
 * options}` cannot reconstruct a full `InteractivePrompt` needed to ANSWER a
 * prompt, and answering always requires a live daemon RPC anyway.
 */
import type { ChatMessage } from '@adhdev/daemon-core'
import type {
    ReplicatedTranscriptMessageV2,
    ReplicatedTranscriptViewV2,
} from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import type { DashboardMessage } from './types'

/**
 * The chat pane's observable transcript readout, on its root element.
 *
 * `data-transcript-omitted-before` — the keyed view does not reach the start
 * of the conversation (the producer's `coverage.omittedBefore`: a window
 * source, or bubbles tombstoned by the 16 MiB live cap). "Load older
 * messages" (an explicit `chat_history` page) is what reaches past it. This is
 * deliberately NOT a visible banner: a data-loss-sounding banner for content
 * that `chat_history` still reaches was twice reported as a defect and retired
 * (owner decision). Absent (not "false") when the view is complete.
 */
export function buildTranscriptPaneAttributes(state: { omittedBefore?: boolean }): Record<string, string> {
    return state.omittedBefore ? { 'data-transcript-omitted-before': 'true' } : {}
}

/** One roster-mapped bubble.
 *
 * @message-projection l2k-decode
 *
 * The far side of the keyed chat wire. `check:message-projection-parity`
 * enforces that every field the keyed encoder writes and the pane needs is
 * still read back out here — dropping one at this hop loses it exactly as
 * completely as never encoding it.
 *
 * ★ `messageId` is the bubble's identity: it becomes `id` (and `messageId`),
 * which `getChatMessageStableKey` ranks first. `turnKey` goes to `_turnKey`
 * only — it is TURN-grained (shared by every bubble of a turn) and must never
 * become a per-bubble key.
 *
 * ★ `toolName` is the ONLY way the tool card label reaches this lane:
 * `meta.label` (what the REST read_chat path derives) never travels, so this
 * adapter re-derives `meta.label` from `toolName` exactly as
 * `chat-commands-read-native-normalize.ts` does for the REST path.
 *
 * ★ `expandable` replaces the v1 wire's mtime-sealed `toolBlockRef` (design
 * §5.9): a truncated tool bubble is expanded by `messageId`, and the daemon
 * resolves the block from its identity ledger. */
function mapTranscriptMessage(message: ReplicatedTranscriptMessageV2): DashboardMessage {
    const mapped: DashboardMessage = {
        role: message.role,
        kind: message.kind as ChatMessage['kind'],
        content: message.content,
        id: message.messageId,
        messageId: message.messageId,
        _ord: message.ord,
        _rev: message.rev,
    }
    if (message.receivedAt !== null) mapped.receivedAt = message.receivedAt
    if (message.timestamp !== null) mapped.timestamp = message.timestamp
    if (message.bubbleState !== null) mapped.bubbleState = message.bubbleState
    if (message.senderName !== null) mapped.senderName = message.senderName
    if (message.toolName !== null && message.toolName) {
        mapped.toolName = message.toolName
        // Same derivation as the REST path (toolName preferred over the generic
        // senderName:'Tool' marker) so both lanes label the card identically.
        mapped.meta = { ...(mapped.meta ?? {}), label: message.toolName }
    }
    if (message.expandable) mapped._expandable = true
    if (message.turnKey !== null) mapped._turnKey = message.turnKey
    return mapped
}

/**
 * Per-subscription cache of mapped bubbles, keyed by `messageId`.
 *
 * A hit is reused — the SAME `DashboardMessage` object — when the incoming
 * bubble is the same object the mirror already held (the bubble was not in
 * this frame), or, after a reset frame re-sent every bubble as a fresh clone,
 * when its `rev` and `ord` did not move. `rev` is the producer's per-bubble
 * revision (any change to the bubble bumps it), so that is the change test;
 * `content` is compared too on that reset-only path, as a guard against a
 * producer whose revision counter restarted.
 */
export class TranscriptBubbleCache {
    private entries = new Map<string, { source: ReplicatedTranscriptMessageV2; mapped: DashboardMessage }>()

    map(messages: readonly ReplicatedTranscriptMessageV2[]): DashboardMessage[] {
        const next = new Map<string, { source: ReplicatedTranscriptMessageV2; mapped: DashboardMessage }>()
        const out = messages.map((message) => {
            const hit = this.entries.get(message.messageId)
            let entry = hit
            if (
                !hit
                || (hit.source !== message
                    && (hit.source.rev !== message.rev
                        || hit.source.ord !== message.ord
                        || hit.source.content !== message.content))
            ) {
                entry = { source: message, mapped: mapTranscriptMessage(message) }
            } else if (hit.source !== message) {
                entry = { source: message, mapped: hit.mapped }
            }
            next.set(message.messageId, entry!)
            return entry!.mapped
        })
        this.entries = next
        return out
    }
}

/**
 * Is this view structurally complete enough to map?
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * The mapper reads `activeModal` as `view.activeModal ? {...} : null`, which
 * treats a MISSING field and an absent modal identically. `activeModal` is a
 * REQUIRED field on `ReplicatedTranscriptViewV2` (`ChatModalV2 | null`) and
 * the folder always materializes it — so its absence is a projection
 * regression, never a legitimate shape. Conflating the two degrades SILENTLY
 * in the worst direction: a session sitting on `waiting_approval` renders with
 * NO approval UI.
 *
 * ── Why a validator here rather than a throw inside the mapper ─────────────
 * ★ The production call chain has NO try/catch:
 *   host `onView` (`transcript-worker-host.ts`'s view-port `onmessage`)
 *   → `applyTranscriptViewToControllers`
 *   → `SessionChatController.applyTranscriptView` → this mapper.
 * A raw throw would escape into a MessagePort event handler — killing that
 * delivery AND skipping the caller's downstream handlers, i.e. trading a
 * silent wrong answer for a silent dropped one. So the contract is a DECLINE,
 * matching every other roster consumer (`isUsableSnapshot` in mcp-server and
 * `transcript-daemon-consumer-read.ts`).
 *
 * ★ An ALLOW-LIST of required shape, never a deny-list sanitizer — it asserts
 * what must be present rather than stripping what must not be, so a field
 * added upstream cannot slip through unvalidated.
 */
export function isMappableTranscriptView(view: ReplicatedTranscriptViewV2): boolean {
    if (!view || typeof view !== 'object') return false
    const value = view as unknown as Record<string, unknown>

    if (value.schemaVersion !== 2) return false
    if (typeof value.sessionId !== 'string' || !value.sessionId) return false
    if (typeof value.status !== 'string' || !value.status) return false
    if (!Array.isArray(value.messages)) return false
    if (!value.provenance || typeof value.provenance !== 'object') return false

    // ★ The field this whole validator exists for. `undefined` means the
    // projection stopped carrying it; `null` means "no modal", which is a
    // normal and renderable state.
    if (!('activeModal' in value)) return false
    const modal = value.activeModal
    if (modal !== null) {
        if (!modal || typeof modal !== 'object') return false
        const shape = modal as Record<string, unknown>
        if (typeof shape.message !== 'string') return false
        if (!Array.isArray(shape.buttons)) return false
    }

    return true
}

/** What one committed view contributes to a session chat snapshot. */
export interface TranscriptChatView {
    /** Bubbles in `ord` order; unchanged bubbles are the same objects as last time (with a cache). */
    readonly messages: DashboardMessage[]
    /** The producer's reported session status for this commit. */
    readonly status: string
    /** Bubbles before the live set were omitted — the producer's `coverage.omittedBefore`. */
    readonly omittedBefore: boolean
}

/**
 * Map one verified committed view into the controller's rows.
 *
 * `cache` preserves bubble object identity across frames (see
 * `TranscriptBubbleCache`); without one every bubble is mapped afresh.
 */
export function mapTranscriptViewToChatView(
    view: ReplicatedTranscriptViewV2,
    options: { cache?: TranscriptBubbleCache } = {},
): TranscriptChatView {
    return {
        messages: options.cache ? options.cache.map(view.messages) : view.messages.map(mapTranscriptMessage),
        status: view.status,
        omittedBefore: view.coverage?.omittedBefore === true,
    }
}
