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

/** One roster-mapped message.
 *
 * ★ Identity mapping is deliberately NARROW. `turnKey` goes to `_turnKey` only —
 * it is TURN-grained (one value per user message, shared by every bubble of the
 * turn) and must never be assigned to the per-BUBBLE `bubbleId`, or all bubbles
 * of a turn collapse onto one React key. `sequence` (allow-listed, a monotonic
 * per-session integer) IS per-message and carries through. `providerUnitKey`
 * stays off the wire on purpose: it embeds a content hash. */
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
        // `_turnKey` ONLY. `turnKey` is TURN-grained — the producer increments it
        // once per user message, so every bubble of a multi-bubble turn (prompt →
        // tool → output → answer) shares one value. Assigning it to `bubbleId`
        // (a per-BUBBLE field) made all N bubbles collide on a single React key,
        // because `getChatMessageStableKey` ranks `_turnKey`/`bubbleId` above the
        // content-hash fallback. Leaving `bubbleId` unset lets that fallback
        // distinguish bubbles by their own content, which is correct-by-default.
        mapped._turnKey = message.turnKey
    }
    if (typeof message.sequence === 'number') mapped.sequence = message.sequence
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

/**
 * (§8 unit 9-pre-c) Is this snapshot structurally complete enough to map?
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * `mapTranscriptSnapshotToChatTailUpdate` reads `activeModal` as
 * `snapshot.activeModal ? {...} : null`, which treats a MISSING field and an
 * absent modal identically. `activeModal` is a REQUIRED, non-optional field on
 * `ReplicatedTranscriptSnapshotV1` (`ReplicatedTranscriptModalV1 | null`) and
 * `encodeTranscriptSnapshot` always emits it — so its absence is a projection
 * regression, never a legitimate shape.
 *
 * Conflating the two degrades SILENTLY in the worst possible direction: a
 * session sitting on `waiting_approval` renders with NO approval UI. The user
 * cannot act, the agent stays blocked, and nothing reports an error. That is
 * the same empty-success class the §5.6 fire drill exists to catch, on the
 * highest-traffic consumer (roster ids 1-2).
 *
 * ── Why a validator here rather than a throw inside the mapper ─────────────
 * ★ The production call chain has NO try/catch:
 *   `p2p-manager.ts` `onSnapshot` → `applyTranscriptReplicaSnapshotToControllers`
 *   → `applyTranscriptReplicaSnapshot` → this mapper,
 * and `onSnapshot` is invoked directly inside `transcript-worker-host.ts`'s
 * `snapshotChannel.port1.onmessage`. A raw throw would escape into a
 * MessagePort event handler — killing that delivery AND skipping the
 * downstream `transcriptSnapshotHandlers`, i.e. trading a silent wrong answer
 * for a silent dropped one. Neither is a fallback.
 *
 * So the contract is a DECLINE, matching what every other roster consumer
 * already does: unit 6's `isUsableSnapshot` (mcp-server) and unit 7's
 * (`transcript-daemon-consumer-read.ts`) both refuse structurally-invalid
 * snapshots and let the caller run legacy. This is the same discipline for
 * ids 1-2, which were the only consumers lacking it.
 *
 * ★ An ALLOW-LIST of required shape, never a deny-list sanitizer — the
 * repo-wide rule for every boundary of this kind (CLAUDE.md server content
 * boundary). It asserts what must be present rather than stripping what must
 * not be, so a field added upstream cannot slip through unvalidated.
 *
 * Deliberately NOT validated: `title` and `turnKey`, which the injection suite
 * documents as structural-but-not-behaviour-gating, and `historySessionId` /
 * `providerObservedStatus`, which are legitimately nullable and read
 * defensively. Validating them would reject snapshots the pane can render
 * perfectly well — a fallback is not free, it costs the replica lane.
 */
export function isMappableTranscriptSnapshot(snapshot: ReplicatedTranscriptSnapshotV1): boolean {
    if (!snapshot || typeof snapshot !== 'object') return false
    const value = snapshot as unknown as Record<string, unknown>

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
