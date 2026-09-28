/**
 * `web_chat_pane` / `web_warm_mobile_preview` roster adapter — design §4, §8
 * unit 5 ("web chat pane consumer cutover"), keyed since design 2026-09-28
 * message-keyed storage §5.4.
 *
 * Maps a verified committed `ReplicatedTranscriptViewV2` (the worker's
 * `KeyedTranscriptFolder` output, mirrored on the main thread by
 * `transcript-view-mirror.ts`) into the exact `SessionChatTailUpdate` shape
 * `SessionChatTailController.handleUpdate` already consumes, so every existing
 * shrink-defense / dedup / force-apply rule in that controller composes
 * unchanged regardless of which source (replica or legacy
 * `session.chat_tail` / `read_chat`) produced the update.
 * `web_warm_mobile_preview` needs no separate adapter — per §4 it reads the
 * SAME warm controller snapshot this feeds, via
 * `getSessionChatTailSnapshotForConversation`.
 *
 * ── Bubble identity is the producer's `messageId` ───────────────────────────
 * Every bubble on the keyed wire carries the daemon ledger's opaque
 * `messageId` (unique per bubble within the session, stable across re-reads,
 * streaming growth and source handoffs). It becomes `ChatMessage.id` AND
 * `messageId`, so `getChatMessageStableKey` keys the row `mid:<messageId>` —
 * the same key the legacy read_chat lane produces for the same bubble, so a
 * lane switch does not remount. Order is the view's `ord` order.
 *
 * ── Change detection is by `rev`, and unchanged bubbles keep their object ───
 * `mapTranscriptViewToChatTailUpdate` reuses the previously mapped
 * `DashboardMessage` for every bubble whose `(messageId, rev)` did not move
 * (`TranscriptBubbleCache`). The controller then sees reference-equal rows for
 * untouched bubbles, React's memoized rows skip them, and only the bubbles a
 * frame actually changed re-render — no remount, no whole-list churn.
 *
 * ── What does NOT round-trip, and why that is safe ──────────────────────────
 * `provenance.messageSource` is a single allow-listed SCALAR, not the rich
 * `{selected, fallbackReason, nativeSource}` object `read_chat`'s live
 * `messageSource` carries. This adapter reconstructs only `{selected: <that
 * scalar>}`. The controller's A3 shrink-defense (`isNativeHistorySource`,
 * `shouldForceApplyNativeAssistantTail`) only ever reads `.selected` — so the
 * important fast path (force-apply a native-history tail that finally adds the
 * assistant answer) still fires. The `fallbackReason`-keyed LENIENCY branch
 * inside `shouldDeferBusyTailUpdate` simply never engages for a
 * replica-sourced update, which falls through to the stricter count-heuristic
 * — a safe direction to fail in.
 *
 * `activeInteractivePrompt` is intentionally left `null`: the allow-listed
 * `{message, options}` cannot reconstruct a full `InteractivePrompt`
 * (`promptId/origin/providerType/createdAt/questions[]`) needed to ANSWER a
 * prompt — and answering always requires a live daemon RPC regardless of
 * transcript source, so this is not a functional regression.
 */
import type { ChatMessage, SessionChatTailUpdate } from '@adhdev/daemon-core'
import type {
    ReplicatedTranscriptMessageV2,
    ReplicatedTranscriptViewV2,
} from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import type { DashboardMessage } from './types'

/**
 * (§8 unit 4c) The chat pane's observable read-source readout.
 *
 * Design §5.6 makes `transcriptReadSource` the single source of truth for
 * "which transport produced this tail", explicitly so a rollback cannot
 * degrade into an invisible merge of two sources. Units 4b/5 computed and
 * stored it correctly, but NOTHING read it — so replica and legacy rendered
 * identically and there was no way, short of a debugger, to tell whether the
 * replica lane was actually feeding the pane or had silently fallen back.
 *
 * These attributes close that gap on the pane's root element. They are a
 * developer/rollout signal, deliberately not user-facing chrome: visible UI
 * would need copy, i18n and a product decision, and would surface transport
 * plumbing to every user for no benefit. They ship in production builds
 * (unlike a dev-only panel) because live verification is exactly where the
 * distinction matters, and they express CURRENT STATE (unlike a console log)
 * so they can be asserted in a DOM test and inspected at any moment.
 *
 * `fallbackReason` / `stale` are OMITTED rather than emitted empty: absence is
 * meaningful. A session that never attempted the replica has no reason at all,
 * which must not be confused with one that fell back for an unrecorded reason.
 *
 * ── Why `omittedBefore` is here and NOT a visible banner ────────────────────
 * A ring-eviction discontinuity used to render as the "showing latest only"
 * banner in ChatPane. It was retired as user-facing chrome (owner decision):
 * "Load older messages" already sits directly above the tail and is gated
 * independently of this flag — `ChatMessageList.tsx:491,512` render it on
 * `(hiddenLiveCount > 0 || hasMoreHistory) && !isLoadingMore`, which never
 * reads `omittedBefore`. So the banner restated an affordance the user could
 * already see, and it read as a data-loss warning when nothing was lost
 * (provider-native/ADHDev JSONL history is untouched; `chat_history` still
 * reaches it). It was twice reported as a defect — once when it was a false
 * positive, once when it was CORRECT. A signal that alarms even when accurate
 * has failed as UI.
 *
 * The detection is still sound and stays armed — only its surface moved. Do
 * not "restore" the banner; if this needs to be user-visible again, that is a
 * product/copy decision, not a bug fix.
 */
export function buildTranscriptReadSourceAttributes(state: {
    transcriptReadSource: 'replica' | 'legacy'
    transcriptFallbackReason?: string
    stale?: boolean
    omittedBefore?: boolean
    transcriptReplicaDegraded?: boolean
}): Record<string, string> {
    return {
        'data-transcript-read-source': state.transcriptReadSource,
        ...(state.transcriptFallbackReason
            ? { 'data-transcript-fallback-reason': state.transcriptFallbackReason }
            : {}),
        ...(state.stale ? { 'data-transcript-stale': 'true' } : {}),
        ...(state.omittedBefore ? { 'data-transcript-omitted-before': 'true' } : {}),
        // (§8 unit 9) ★ Emitted ONLY on a genuine replica→legacy regression, not
        // on every legacy read. `data-transcript-read-source="legacy"` is the
        // normal state for a `shadow`-mode daemon and says nothing is wrong;
        // this attribute is the one that means a lane BROKE. Absent (not
        // "false") when healthy, so its presence alone is the assertion.
        ...(state.transcriptReplicaDegraded ? { 'data-transcript-replica-degraded': 'true' } : {}),
    }
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
 * The (necessarily narrower) `messageSource` reconstruction — see this file's
 * header for what it can and cannot carry.
 */
function mapMessageSource(
    provenance: ReplicatedTranscriptViewV2['provenance'],
): Record<string, unknown> | undefined {
    if (!provenance.messageSource) return undefined
    return { selected: provenance.messageSource }
}

/**
 * (§8 unit 9-pre-c) Is this view structurally complete enough to map?
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
 *   → `applyTranscriptReplicaViewToControllers`
 *   → `applyTranscriptReplicaView` → this mapper.
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

export interface TranscriptChatTailUpdate extends SessionChatTailUpdate {
    /** Bubbles before the live set were omitted — the producer's `coverage.omittedBefore`. */
    omittedBefore: boolean
    /** Design §5.5's "stale idle UI" — a replica tail whose freshness gate did not hold. */
    stale: boolean
    /** Single-source-of-truth telemetry field (design §5.6). */
    transcriptReadSource: 'replica'
}

/**
 * Map one verified committed view into the controller's update shape.
 * `subscriptionKey`/`seq`/`timestamp` are wire bookkeeping the controller's
 * `handleUpdate` does not read — `seq` carries the commit's frame number for
 * diagnostics only.
 *
 * `omittedBefore` is the producer's statement (`coverage.omittedBefore`);
 * `stale` is the CALLER's freshness decision (design §5.5).
 *
 * `cache` preserves bubble object identity across frames (see
 * `TranscriptBubbleCache`); without one every bubble is mapped afresh.
 */
export function mapTranscriptViewToChatTailUpdate(
    view: ReplicatedTranscriptViewV2,
    options: { subscriptionKey: string; stale: boolean; cache?: TranscriptBubbleCache },
): TranscriptChatTailUpdate {
    const messageSource = mapMessageSource(view.provenance)
    return {
        topic: 'session.chat_tail',
        key: options.subscriptionKey,
        sessionId: view.sessionId,
        ...(view.historySessionId ? { historySessionId: view.historySessionId } : {}),
        seq: view.frame,
        timestamp: 0,
        messages: options.cache ? options.cache.map(view.messages) : view.messages.map(mapTranscriptMessage),
        status: view.status,
        ...(view.title ? { title: view.title } : {}),
        activeModal: view.activeModal
            ? { message: view.activeModal.message, buttons: [...view.activeModal.buttons] }
            : null,
        activeInteractivePrompt: null,
        ...(messageSource ? { messageSource } : {}),
        omittedBefore: view.coverage?.omittedBefore === true,
        stale: options.stale,
        transcriptReadSource: 'replica',
    }
}
