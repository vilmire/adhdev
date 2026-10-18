import { outgoingInputDigest, readOutgoingReceipt } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import { applyOutgoingReceipts } from '../utils/outgoingReceipts'
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type { ImageAttachment } from '../components/dashboard/ChatInputBar'
import { getProviderArgs, getRouteTarget, getConversationSendBlockMessage, getInlineSendFailureMessage } from './dashboardCommandUtils'
import { getCoordinatorRoutingHint } from '../components/dashboard/conversation-selectors'
import { isConversationGenerating } from '../components/dashboard/DashboardMobileChatShared'
import type { PendingLocalMessage } from '../components/dashboard/conversation-message-snapshot'
import { retirePendingLocalMessages } from '../components/dashboard/conversation-message-snapshot'
import type { DashboardMessage } from '../components/dashboard/types'
import { getExplicitSessionRevealCommand } from '../components/dashboard/dashboardSessionCommands'
import {
    clearDismissedUncertainMessageId,
    createPendingQueuedMessageId,
    OUTGOING_RECEIPT_POLL_BASE_MS,
    OUTGOING_RECEIPT_POLL_MAX_AGE_MS,
    OUTGOING_RECEIPT_POLL_MAX_MS,
    readDismissedUncertainMessageIds,
    readPendingQueuedMessages,
    writePendingQueuedMessages,
    MAX_PENDING_QUEUED_MESSAGES,
    type PendingQueuedMessage,
    type PendingInputEnvelope,
} from '../utils/pendingQueuedMessages'
import type { SendPolicy } from '@adhdev/mesh-shared'

/**
 * The full conversation-command surface, passed to render sites as ONE required
 * prop rather than spread into loose optional props.
 *
 * ★ Why this is a single object: every field here was previously an individual
 * optional (`?`) prop on `PaneGroupContent`, so adding one meant threading it
 * through up to 7 hand-written call sites with NO compile-time check that any of
 * them was updated. A missed site was a silent runtime defect, not a build
 * error — which is exactly how `pendingLocalMessage` reached only 6 of 7 sites.
 * Bundling makes the wiring a single required prop the compiler can enforce.
 *
 * ★ Deliberately NOT included: `isVisible`, `isInputActive` and
 * `scrollToBottomRequestNonce`. Those are layout concerns that legitimately
 * differ per surface (dockview tracks panel visibility/focus; mobile shows one
 * pane at a time), not command wiring, and they stay optional props.
 */
export interface DashboardConversationCommands {
    isSendingChat: boolean
    sendFeedbackMessage: string | null
    /** True when the last send was PARKED by the daemon rather than submitted. */
    lastSendQueued: boolean
    /**
     * Newest optimistic local bubble.
     *
     * ★ Retained for the surfaces that only ever showed one. The AUTHORITY is
     * `pendingLocalMessages` below — this is its last element, kept so a caller
     * that has not been migrated still renders something correct rather than
     * nothing.
     */
    pendingLocalMessage: PendingLocalMessage | null
    /**
     * (MULTI-QUEUE) Every body still waiting, oldest first, restored from
     * localStorage on mount. Feed to `withPendingLocalMessages`.
     *
     * ★ This replaced a single `useState` slot. The daemon's own queue
     * (`FsmDriver.pendingSends`) has always been a FIFO array, so a second send
     * while the agent was busy parked correctly in the daemon but OVERWROTE the
     * one UI slot — the first message vanished from screen while still queued.
     */
    pendingLocalMessages: PendingQueuedMessage[]
    isFocusingAgent: boolean
    handleSendChat: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>
    /**
     * SEND-NOW-AGENT-QUEUE: hand the already-queued optimistic bubble to the
     * AGENT'S OWN input queue while it is still generating, so it is answered as
     * the next turn WITHOUT interrupting the turn in flight. Takes no message —
     * it re-sends the parked body the bubble is showing.
     *
     * Replaced `handleForceSendChat`, whose daemon-side implementation
     * (`forceSendMessage`) never existed: the type declared it, two call sites
     * invoked it, and every adapter fell through to a plain send. The button was
     * wired to nothing. POSIX only; a refusal is reported and never escalated to
     * an interrupt. See the handler for the full derivation.
     */
    handleSendNowQueued: (pendingId?: string) => Promise<boolean>
    /**
     * (QUEUED-SEND-CANCEL) Drop ONE waiting body — the owner changed their mind
     * before the agent ever saw it.
     *
     * Addressed by entry id so cancelling the second queued message can never
     * remove the first. Clears BOTH the local store and the daemon's FIFO; see
     * the handler for why a local-only removal would be a lie.
     */
    handleCancelQueued: (pendingId: string) => Promise<boolean>
    /**
     * Retry a failed or unconfirmed-stale pending message by removing the
     * failed entry and re-submitting its original text/attachments with a new id.
     */
    handleRetryPendingMessage?: (pendingId?: string) => Promise<boolean>
    /**
     * ★ (QUEUED-SEND-STUCK-FOREVER) Reconcile the local queue against the live
     * transcript: retire bodies the daemon has echoed back, and mark bodies that
     * have waited too long to still be called "waiting".
     *
     * ★ Why the TAIL is pushed in rather than the hook reading it.
     *
     * The transcript authority is the per-pane session chat controller, which lives
     * BELOW this hook (ChatPane owns it; this hook is called by the workspace
     * above). The hook owns the queue state and its persisted copy. Rather than
     * duplicate a tail subscription up here — a second subscription to the same
     * session, with its own lifetime and its own chance to disagree — the pane
     * hands its already-computed tail to the one writer that can act on it.
     *
     * Safe to call on every tail tick: it returns without touching state when
     * nothing matched, so the common case costs one pass over the queue (which
     * is capped at MAX_PENDING_QUEUED_MESSAGES) and no re-render.
     */
    retireEchoedPendingMessages: (liveMessages: DashboardMessage[]) => void
    handleRelaunch: () => void
    handleModalButton: (button: string) => void
    handleFocusAgent: () => Promise<void>
}

interface UseDashboardConversationCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
}

interface RecentSendAttempt {
    tabKey: string
    message: string
    timestamp: number
    inputDigest?: string
}

export function shouldBlockConversationSend({
    hasMessage,
    blockedMessage,
}: {
    hasMessage: boolean
    blockedMessage: string | null
    sendInFlight?: boolean
}): boolean {
    if (!hasMessage) return true
    return !!blockedMessage
}

export function shouldSuppressRecentDuplicateSend(
    lastSend: RecentSendAttempt | null | undefined,
    attempt: RecentSendAttempt,
    dedupeWindowMs = 2000,
): boolean {
    if (!lastSend) return false
    return lastSend.tabKey === attempt.tabKey
        && lastSend.message === attempt.message && lastSend.inputDigest === attempt.inputDigest
        && (attempt.timestamp - lastSend.timestamp) < dedupeWindowMs
}

export function clearRecentSendOnFailure(
    lastSend: RecentSendAttempt | null | undefined,
    failedAttempt: RecentSendAttempt,
): RecentSendAttempt | null {
    if (!lastSend) return null
    return lastSend.tabKey === failedAttempt.tabKey
        && lastSend.message === failedAttempt.message
        && lastSend.timestamp === failedAttempt.timestamp
        && lastSend.inputDigest === failedAttempt.inputDigest
        ? null
        : lastSend
}

export function unwrapCommandResult(raw: any): any {
    if (!raw || typeof raw !== 'object') return raw
    if (raw.result && typeof raw.result === 'object') return raw.result
    return raw
}

/**
 * (QUEUED-SEND-LOSS consumer) Did the daemon PARK this send instead of
 * submitting it?
 *
 * The daemon reports the distinction precisely — `chat-commands-write.ts`
 * answers `{sent:false, queued:true, submitted:false}` when the driver's
 * in-memory FIFO took the body (SessionInputService `queued` outcome), and the
 * mesh path reports `{queued:true, queuedReason:'driver_fifo_parked'}`. Until
 * now NOTHING on the web side read either field, so that contract was dead and
 * the user-visible defect it was meant to fix was still live.
 *
 * ★ `queued` is NOT a failure. The command succeeded; the body is accepted and
 * will be written when the agent stops generating. It must not be routed into
 * the error path — that would show a send failure for a send that is going to
 * happen. It only means "do not tell the user this is delivered yet".
 *
 * ★ Read `sent === false` as well as `queued`. A queued result carries both,
 * and treating a bare `sent:false` as an error is what the pre-existing
 * `res?.sent === false` throw below did — which would have turned every queued
 * send into a spurious "Send failed" the moment the daemon started reporting
 * it truthfully.
 */
/**
 * Shown while a send is parked. Phrased as a state, not a failure — the message
 * IS accepted; it is waiting for the agent to stop generating.
 */
export const QUEUED_SEND_MESSAGE = 'Waiting to send — the agent is still working.'

/**
 * Shown when a cancel lost the race: the daemon had already taken the body out
 * of its queue and written it to the agent. Phrased as a fact about what
 * happened, not as an error the owner can retry.
 */
export const CANCEL_QUEUED_TOO_LATE_MESSAGE = 'Too late to cancel — this message was already sent to the agent.'

export function isQueuedSendResult(res: any): boolean {
    if (!res || typeof res !== 'object') return false
    return res.queued === true
}

/**
 * (QUEUED-SEND-STICKY) Should the parked-send notice be released?
 *
 * `sendFeedbackMessage` is written once, at the moment the daemon parks a send,
 * and until now it was cleared by exactly two things: the next send attempt, and
 * a tab switch. Neither happens when the agent simply finishes — so the notice
 * outlived the condition it describes and an idle session kept telling the owner
 * "the agent is still working". That is the defect: the message was CORRECT when
 * shown, and never released.
 *
 * The release condition is the live session status, read through the same
 * `isConversationGenerating` predicate every other surface uses, so a status the
 * predicate counts as working (`finalizing`/`starting`, added in oss df900791)
 * keeps the notice up rather than flashing it away mid-turn.
 *
 * ★ Deliberately scoped to the QUEUED notice only. `sendFeedbackMessage` also
 * carries send FAILURES, which describe a past event, not a live condition — an
 * agent going idle does not make a failed send succeed, so those must stay until
 * the user acts. Releasing on idle unconditionally would silently swallow them.
 *
 * ★ Not a timeout. The notice is bound to the state that justifies it; there is
 * no duration at which a still-generating agent should stop being reported.
 */
export function shouldReleaseQueuedSendFeedback({
    feedbackMessage,
    lastSendQueued,
    isGenerating,
}: {
    feedbackMessage: string | null
    lastSendQueued: boolean
    isGenerating: boolean
}): boolean {
    if (!lastSendQueued) return false
    if (feedbackMessage !== QUEUED_SEND_MESSAGE) return false
    return !isGenerating
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error || '')
}

function isExpectedActionResolutionError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase()
    return message.includes('button not found')
        || message.includes('not in approval state')
        || message.includes('command failed')
}

function getActionFailureText(buttonText: string, error?: unknown): string {
    const message = getErrorMessage(error)
    if (!message) return `⚠️ **${buttonText}** unavailable`
    if (message.toLowerCase().includes('button not found')) {
        return `⚠️ **${buttonText}** failed — button not found`
    }
    return `⚠️ **${buttonText}** failed — ${message}`
}

/**
 * How long a cancel may wait for an in-flight `send_chat` to resolve.
 *
 * Long enough to cover an ordinary P2P round trip (the common case resolves in
 * well under a second), short enough that a wedged transport cannot leave the
 * owner staring at an unresponsive Cancel button. On expiry the cancel proceeds
 * anyway — see the call site for why timing out must not imply "nothing parked".
 */
const CANCEL_SETTLE_WAIT_MS = 5_000

/** What an in-flight `send_chat` turned out to be, once it answered. */
type SendSettlement = 'parked' | 'not-parked'

/**
 * (CANCEL-INFLIGHT-LEAK) Await an in-flight `send_chat` directly.
 *
 * ★ Why a promise registry and not the rendered entry's `settled` flag.
 *
 * `settled` lives in React state, so it only becomes visible to a handler after
 * a re-render. A cancel that waited on it would be waiting on the render loop,
 * not on the network — and in a test (or any synchronously-batched update) the
 * wait can starve the very render that would end it. Recording the promise in a
 * ref keeps the dependency where it belongs: the cancel awaits the same round
 * trip the send is awaiting, and rendering is free to happen whenever it likes.
 *
 * Resolves rather than rejects on timeout; the caller must treat "still unknown"
 * as "may be parked", which is the safe direction.
 */
function awaitSendSettlement(
    registry: Map<string, Promise<SendSettlement>>,
    pendingId: string,
    timeoutMs: number = CANCEL_SETTLE_WAIT_MS,
): Promise<SendSettlement | 'unknown'> {
    const inFlight = registry.get(pendingId)
    if (!inFlight) return Promise.resolve('unknown')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'unknown'>(resolve => {
        timer = setTimeout(() => resolve('unknown'), timeoutMs)
    })
    return Promise.race([inFlight, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

/**
 * Build a structured `InputEnvelope`-shaped body from a message + attachments,
 * matching the daemon's `normalizeInputEnvelope` contract. Shared by the fresh
 * send path (`handleSendChat`) and by the pending-store writer, so the SAME
 * shape is what gets persisted, what gets sent, and — on send-now — what gets
 * resubmitted (see `pendingQueuedMessages.ts`'s `PendingInputEnvelope`, a
 * capped/persistable projection of this).
 */
function buildInputEnvelope(message: string, attachments: ImageAttachment[] | undefined): PendingInputEnvelope | undefined {
    if (!attachments || attachments.length === 0) return undefined
    const parts: PendingInputEnvelope['parts'] = attachments.map((att) => ({
        type: 'image',
        mimeType: att.mimeType,
        data: att.data,
        alt: att.name,
    }))
    if (message) parts.push({ type: 'text', text: message })
    return { parts, textFallback: message }
}

/**
 * Build the payload for a send_chat command — one `OutboundMessage` on the wire.
 *
 * ★ (Phase D, docs/design/2026-09-23-wiring-unification.md §6 D1/D3/D4) The
 * payload is exactly `{ messageId, input, policy }` (+ the provider routing
 * args). The daemon's SessionInputService reads `messageId` and `policy` only;
 * the legacy `sendNow`/`interrupt` booleans and the top-level `message`
 * back-compat field are gone (D3 cut-compat — the daemon still maps them for
 * one release for OLDER dashboards, not for this one).
 *
 * `messageId` is the SAME id used for the entry's optimistic local bubble and
 * its `pendingQueuedMessages` row — minted once, never re-derived — so the
 * daemon's FIFO entry, its ack echo (`meta.sourceMessageId`) and this bubble
 * share one identity.
 *
 * ★ Takes an already-built `envelope` rather than re-deriving one from
 * `message`/`attachments`, so a send-now resubmit (`handleSendNowQueued`)
 * passes the ORIGINAL parked envelope straight through — including image
 * parts. Re-deriving from `message` alone on resubmit is the "triple-bubble"
 * regression the D section exists to close.
 */
function buildSendChatPayload(
    messageId: string,
    message: string,
    envelope: PendingInputEnvelope | undefined,
    activeConv: ActiveConversation,
    policy: SendPolicy = { mode: 'queue' },
): Record<string, unknown> {
    const input = envelope
        ? { parts: envelope.parts, textFallback: envelope.textFallback }
        : { parts: [{ type: 'text', text: message }], textFallback: message }
    return { messageId, input, policy, ...getProviderArgs(activeConv) }
}

export function useDashboardConversationCommands({
    sendDaemonCommand,
    activeConv,
    setActionLogs,
    isStandalone: _isStandalone,
}: UseDashboardConversationCommandsOptions) {
    const [isFocusingAgent, setIsFocusingAgent] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const [sendFeedbackMessage, setSendFeedbackMessage] = useState<string | null>(null)
    const [lastSendQueued, setLastSendQueued] = useState(false)
    // (OPTIMISTIC-USER-BUBBLE + MULTI-QUEUE) Every body the owner submitted that
    // has not yet been echoed back, oldest first. Rendered locally from the
    // moment it is submitted until the daemon's echo carries it back. See
    // `withPendingLocalMessages` for the dedup contract that retires them.
    const [pendingLocalMessages, setPendingLocalMessages] = useState<PendingQueuedMessage[]>([])
    const sendInFlightRef = useRef(false)
    const lastSendRef = useRef<RecentSendAttempt | null>(null)
    // SEND-NOW / CANCEL read the parked queue through a ref rather than closing
    // over the state, so the handlers keep a stable identity across the queued
    // flip. The bubble's memo comparator compares handlers by reference
    // (chatMessageBubbles.tsx), so a new function every render would re-render
    // every row on every tick.
    const pendingLocalMessagesRef = useRef<PendingQueuedMessage[]>([])
    pendingLocalMessagesRef.current = pendingLocalMessages
    /**
     * (CANCEL-INFLIGHT-LEAK) Entry id → its unresolved `send_chat`, so a cancel
     * arriving mid-round-trip can await the real outcome instead of guessing
     * from a `queued` flag that has not been written yet. Entries are deleted as
     * they settle, so this holds only genuinely open sends.
     *
     * ★ (Phase D-web) This map's key IS `OutboundMessage.messageId` — the same
     * id `createPendingQueuedMessageId` mints and `buildSendChatPayload` puts on
     * the wire — not a separate local identity that happens to coexist with it.
     * A concurrent double-submit for the SAME `messageId` (e.g. two clicks
     * racing before `sendInFlightRef` latches) therefore already dedupes here:
     * the second caller would see an entry already present for that id. Actual
     * SEND suppression on genuine double-invocation still relies on
     * `sendInFlightRef`'s synchronous latch above (checked before this map is
     * ever touched) — see phase-D-plan.md §7.3 risk 1 for why `messageId`
     * identity alone cannot cover the double-click case (two distinct clicks
     * mint two distinct ids by design).
     */
    const inFlightSendsRef = useRef<Map<string, Promise<SendSettlement>>>(new Map())

    /**
     * The localStorage bucket for the ACTIVE conversation.
     *
     * `tabKey` is the same identity the per-conversation reset below already
     * used, so a restored queue lands on exactly the tab that queued it.
     */
    const pendingStoreKey = activeConv?.tabKey || ''
    const pendingStoreKeyRef = useRef(pendingStoreKey)
    pendingStoreKeyRef.current = pendingStoreKey

    /**
     * ★ Single writer for the pending queue. Every mutation goes through here so
     * React state and the persisted copy can never drift — drift between "what
     * is rendered" and "what is remembered" is precisely the class of defect
     * this change fixes.
     */
    const updatePendingMessages = useCallback((
        updater: (prev: PendingQueuedMessage[]) => PendingQueuedMessage[],
    ) => {
        setPendingLocalMessages(prev => {
            const next = updater(prev)
            if (next === prev) return prev
            writePendingQueuedMessages(pendingStoreKeyRef.current, next)
            return next
        })
    }, [])

    const receiptConversationRef = useRef(activeConv)
    receiptConversationRef.current = activeConv
    const conversationMountedAtRef = useRef(Date.now())
    const dismissedUncertainOnRender = readDismissedUncertainMessageIds()
    const activeReceiptPendingKey = pendingLocalMessages
        .filter(entry =>
            entry.requiresReceipt
            && !entry.sendFailed
            && entry.outgoingReceipt?.state !== 'failed'
            && !dismissedUncertainOnRender.has(entry.id),
        )
        .map(entry => entry.id)
        .join(',')
    // Reconcile native sends from authoritative, correlated write receipts.
    // Read-only replay survives missing transcript events and reconnects; it
    // never resubmits a body. Text echoes remain a legacy non-PTY render aid.
    // Polls with exponential backoff and a bounded max age after which an
    // unconfirmed message is marked stale/uncertain (with Retry) and polling stops.
    useEffect(() => {
        const conversation = receiptConversationRef.current
        if (!conversation || !activeReceiptPendingKey) return
        const key = conversation.tabKey
        const mountAt = conversationMountedAtRef.current
        let cancelled = false
        let reading = false
        let attempt = 0
        let timer: ReturnType<typeof setTimeout> | null = null

        const clearScheduled = () => {
            if (timer !== null) {
                clearTimeout(timer)
                timer = null
            }
        }

        const getPollableEntries = (now: number) => {
            const dismissed = readDismissedUncertainMessageIds(now)
            return pendingLocalMessagesRef.current.filter(e =>
                e.requiresReceipt
                && !e.sendFailed
                && e.outgoingReceipt?.state !== 'failed'
                && !dismissed.has(e.id)
                && (now - Math.max(e.sentAt, mountAt) < OUTGOING_RECEIPT_POLL_MAX_AGE_MS),
            )
        }

        const markExpiredEntriesStale = (now: number) => {
            const dismissed = readDismissedUncertainMessageIds(now)
            updatePendingMessages(prev => {
                let changed = false
                const next = prev.map(entry => {
                    if (
                        entry.requiresReceipt
                        && !entry.sendFailed
                        && entry.outgoingReceipt?.state !== 'failed'
                        && (!entry.stale || !entry.deliveryUncertain)
                        && !dismissed.has(entry.id)
                        && (now - Math.max(entry.sentAt, mountAt) >= OUTGOING_RECEIPT_POLL_MAX_AGE_MS)
                    ) {
                        changed = true
                        return { ...entry, stale: true, deliveryUncertain: true }
                    }
                    return entry
                })
                return changed ? next : prev
            })
        }

        const scheduleNext = () => {
            if (cancelled) return
            const now = Date.now()
            markExpiredEntriesStale(now)
            if (getPollableEntries(now).length === 0) return
            const delay = Math.min(OUTGOING_RECEIPT_POLL_MAX_MS, OUTGOING_RECEIPT_POLL_BASE_MS * Math.pow(2, attempt))
            attempt += 1
            clearScheduled()
            timer = setTimeout(() => {
                timer = null
                void refresh()
            }, delay)
        }

        const refresh = async () => {
            if (cancelled) return
            const now = Date.now()
            markExpiredEntriesStale(now)
            const pollable = getPollableEntries(now)
            if (pollable.length === 0) return
            if (reading) return
            reading = true
            try {
                const target = getRouteTarget(conversation)
                if (!target) return
                const ids = pollable.map(e => e.id)
                const raw = await sendDaemonCommand(target, 'outgoing_receipts', { ...getProviderArgs(conversation), messageIds: ids })
                const result = unwrapCommandResult(raw)
                if (cancelled || pendingStoreKeyRef.current !== key || !Array.isArray(result?.receipts)) return
                updatePendingMessages(prev => applyOutgoingReceipts(prev, result.receipts, true))
            } catch {
                if (!cancelled && pendingStoreKeyRef.current === key) {
                    updatePendingMessages(prev => prev.map(entry => entry.requiresReceipt
                        ? { ...entry, deliveryUncertain: true } : entry))
                }
            } finally {
                reading = false
                scheduleNext()
            }
        }

        void refresh()
        const reconnect = () => {
            attempt = 0
            clearScheduled()
            void refresh()
        }
        window.addEventListener('online', reconnect)
        return () => {
            cancelled = true
            clearScheduled()
            window.removeEventListener('online', reconnect)
        }
    }, [activeConv?.tabKey, activeConv?.sessionId, activeConv?.daemonId, activeConv?.connectionState, activeReceiptPendingKey, sendDaemonCommand, updatePendingMessages])

    const retireEchoedPendingMessages = useCallback((liveMessages: DashboardMessage[]) => {
        updatePendingMessages(prev => {
            const result = retirePendingLocalMessages(prev, liveMessages)
            return result.changed ? (result.entries as PendingQueuedMessage[]) : prev
        })
    }, [updatePendingMessages])

    useEffect(() => {
        conversationMountedAtRef.current = Date.now()
        setSendFeedbackMessage(null)
        setLastSendQueued(false)
        // Scoped per conversation: a pending bubble belongs to the tab it was
        // typed in and must not follow the user to another session.
        //
        // ★ RESTART FIX: rather than clearing to empty, REHYDRATE from the
        // durable store. On a fresh app start this is the whole repair — the
        // bodies are still parked in the daemon's FIFO, and this is what puts
        // them back on screen instead of leaving the owner staring at a
        // conversation with their message missing.
        setPendingLocalMessages(pendingStoreKey ? readPendingQueuedMessages(pendingStoreKey).map(entry => {
            if (entry.requiresReceipt || activeConv?.transport !== 'pty') return entry
            return { ...entry, queued: entry.queued === true, requiresReceipt: true, targetSessionId: activeConv?.sessionId,
                inputDigest: outgoingInputDigest(entry.input ?? { parts: [{ type: 'text', text: entry.content }], textFallback: entry.content }),
                deliveryUncertain: true }
        }) : [])
    }, [activeConv?.tabKey, activeConv?.sessionId, activeConv?.transport, pendingStoreKey])

    // (QUEUED-SEND-STICKY) Release the parked-send notice when the agent stops
    // generating. Subscribes to the live status so BOTH surfaces that render
    // `sendFeedbackMessage` — the input placeholder and the line below it —
    // clear together; they read the same state, so neither can go stale alone.
    const isActiveConvGenerating = activeConv ? isConversationGenerating(activeConv) : false
    useEffect(() => {
        setSendFeedbackMessage(prev => (
            shouldReleaseQueuedSendFeedback({
                feedbackMessage: prev,
                lastSendQueued,
                isGenerating: isActiveConvGenerating,
            }) ? null : prev
        ))
        if (!isActiveConvGenerating && lastSendQueued) setLastSendQueued(false)
    }, [isActiveConvGenerating, lastSendQueued])

    const handleSendChat = useCallback(async (rawMessage: string, attachments?: ImageAttachment[]): Promise<boolean> => {
        if (!activeConv) return false
        if (sendInFlightRef.current) return false

        const message = rawMessage.trim()
        const blockedMessage = getConversationSendBlockMessage(activeConv)
        if (shouldBlockConversationSend({
            hasMessage: !!message,
            blockedMessage,
            sendInFlight: sendInFlightRef.current,
        })) {
            if (blockedMessage) setSendFeedbackMessage(blockedMessage)
            return false
        }

        if (pendingLocalMessagesRef.current.length >= MAX_PENDING_QUEUED_MESSAGES && pendingLocalMessagesRef.current.some(e => e.requiresReceipt)) {
            setSendFeedbackMessage('Resolve outstanding delivery before sending more messages.')
            return false
        }
        const inputEnvelope = buildInputEnvelope(message, attachments)
        const inputDigest = outgoingInputDigest(inputEnvelope ?? { parts: [{ type: 'text', text: message }], textFallback: message })
        if (pendingLocalMessagesRef.current.some(entry => entry.requiresReceipt && entry.inputDigest === inputDigest
            && entry.targetSessionId === activeConv.sessionId && entry.outgoingReceipt?.state !== 'failed' && !entry.sendFailed && (entry.deliveryUncertain || !entry.outgoingReceipt))) {
            setSendFeedbackMessage('Delivery unconfirmed — do not resend.')
            return false
        }
        const now = Date.now()
        const attempt: RecentSendAttempt = {
            tabKey: activeConv.tabKey,
            message,
            timestamp: now,
            inputDigest,
        }
        if (shouldSuppressRecentDuplicateSend(lastSendRef.current, attempt)) {
            setSendFeedbackMessage(null)
            return true
        }

        sendInFlightRef.current = true
        setIsSendingChat(true)
        setSendFeedbackMessage(null)
        setLastSendQueued(false)
        lastSendRef.current = attempt

        // ★ Optimistic append happens HERE — before the await, not after it.
        // That is the entire point: `sendDaemonCommand` resolves only after a
        // full round trip, and on a busy agent the daemon parks the body and
        // the echo waits for the queue to drain. Appending after the await
        // would reproduce exactly the latency this fixes.
        //
        // ★ APPEND, not replace. The previous single-slot assignment dropped an
        // already-waiting bubble the moment a second message was sent, even
        // though the daemon had both parked in its FIFO.
        //
        // ★ (Phase D-web) `pendingId` IS the `OutboundMessage.messageId` — minted
        // once, here, and reused unchanged as: the local bubble's id, the
        // pending-store row's id, the wire `messageId` in `buildSendChatPayload`,
        // and (on Send now) the resubmit id. See `pendingQueuedMessages.ts`'s
        // `createPendingQueuedMessageId` doc for the correction to its old
        // "the daemon never sees it" claim.
        const pendingId = createPendingQueuedMessageId(now)
        // (CANCEL-INFLIGHT-LEAK) Publish this send's outcome BEFORE awaiting it,
        // so a cancel pressed during the round trip has something to await. It
        // is resolved exactly once, in the finally below.
        let settleSend: (settlement: SendSettlement) => void = () => {}
        inFlightSendsRef.current.set(pendingId, new Promise<SendSettlement>(resolve => {
            settleSend = resolve
        }))
        let sendSettlement: SendSettlement = 'not-parked'
        updatePendingMessages(prev => [
            ...prev,
            { id: pendingId, content: message, sentAt: now, queued: false, requiresReceipt: activeConv.transport === 'pty',
                targetSessionId: activeConv.sessionId,
                inputDigest,
                ...(inputEnvelope ? { input: inputEnvelope } : {}) },
        ].slice(-MAX_PENDING_QUEUED_MESSAGES))

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) {
                lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
                // Nothing was sent, so no echo will ever retire the bubble.
                // Mark as failed so the owner keeps their text and can Retry.
                updatePendingMessages(prev => prev.map(entry => entry.id === pendingId
                    ? { ...entry, sendFailed: true, deliveryUncertain: true } : entry))
                setSendFeedbackMessage('Unable to send message right now.')
                return false
            }

            const raw = await sendDaemonCommand(routeTarget, 'send_chat', buildSendChatPayload(pendingId, message, inputEnvelope, activeConv))
            const res = unwrapCommandResult(raw)
            updatePendingMessages(prev => applyOutgoingReceipts(prev, [res?.outgoingReceipt], true))
            const receipt = readOutgoingReceipt(res?.outgoingReceipt)
            if (receipt?.state === 'failed' && receipt.messageId === pendingId
                && receipt.sessionId === activeConv.sessionId && receipt.inputDigest === inputDigest) {
                lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
                setLastSendQueued(false)
                updatePendingMessages(prev => prev.map(entry => entry.id === pendingId
                    ? { ...entry, sendFailed: true, deliveryUncertain: true } : entry))
                setSendFeedbackMessage(getInlineSendFailureMessage(new Error(res?.error || res?.reason || 'Rejected before writing.')))
                return false
            }

            if (res?.deduplicated) {
                setSendFeedbackMessage(null)
                return true
            }

            // ★ ORDER MATTERS: the queued check must precede `sent === false`.
            // A queued result carries `sent:false` by contract, so the throw
            // below would classify a successfully-parked message as a send
            // failure — showing an error for a message that is going to be
            // delivered, and clearing the tracked attempt so the user's retry
            // sends it twice.
            // The optimistic bubble deliberately STAYS for a queued send — the
            // body is accepted and will be written, so the owner should keep
            // seeing it. It carries the queued flag so the pane can mark it as
            // waiting rather than delivered.
            if (isQueuedSendResult(res)) {
                // The daemon PARKED the body — this is the state a concurrent
                // cancel has to know about, and the only one that needs a claim.
                sendSettlement = 'parked'
                setLastSendQueued(true)
                updatePendingMessages(prev => prev.map(entry => (
                    entry.id === pendingId ? { ...entry, queued: true } : entry
                )))
                setSendFeedbackMessage(null)
                return true
            }

            if (res?.sent === false) {
                throw new Error(res?.error || 'Send failed')
            }

            if (res?.success === false) {
                throw new Error(res?.error || 'Send failed')
            }

            // Accepted by an idle session: keep `queued: false` so it renders
            // immediately as a normal sent user message in the transcript
            // rather than flashing as a queued strip item first.
            updatePendingMessages(prev => prev.map(entry => entry.id === pendingId && entry.requiresReceipt
                ? { ...entry, queued: false, deliveryUncertain: true } : entry))
            setLastSendQueued(false)
            setSendFeedbackMessage(null)
            return true
        } catch (e) {
            const errorMessage = getErrorMessage(e)
            if (errorMessage.toLowerCase().includes('provider sendmessage did not confirm send')) {
                console.warn('Send not confirmed by provider script:', errorMessage)
            } else {
                console.warn('Send blocked/failed', e)
            }
            lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
            // Keep the message text marked as failed/uncertain so the owner
            // can retry without re-typing.
            updatePendingMessages(prev => prev.map(entry => entry.id === pendingId
                ? { ...entry, sendFailed: true, deliveryUncertain: true } : entry))
            setSendFeedbackMessage(getInlineSendFailureMessage(e))
            return false
        } finally {
            // (CANCEL-INFLIGHT-LEAK) The round trip is over, whatever it decided.
            // Releasing here rather than on the success paths covers the throw
            // and early-return exits too — a send that never settled would leave
            // a waiting cancel to burn its whole timeout.
            //
            // `not-parked` is the default: every path that did not observe an
            // explicit `queued` answer either delivered the body or failed, and
            // in both cases the daemon FIFO holds nothing to claim.
            inFlightSendsRef.current.delete(pendingId)
            settleSend(sendSettlement)
            updatePendingMessages(prev => prev.map(entry => (
                entry.id === pendingId ? { ...entry, settled: true } : entry
            )))
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand, updatePendingMessages])

    /**
     * SEND-NOW. The message is already PARKED in the daemon's driver FIFO
     * (`pendingLocalMessages[n].queued`); the user pressed the button inside that
     * bubble to stop waiting for the agent to finish on its own.
     *
     * ★ Takes the entry id so a multi-entry queue acts on the bubble that was
     * actually pressed. Omitting it keeps the historical behaviour (act on the
     * oldest queued entry — the one the daemon will drain next).
     *
     * ★ SEND-NOW-AGENT-QUEUE: this hands the body to the AGENT'S OWN input queue
     * and does NOT interrupt. The turn in flight keeps running and finishes
     * normally; the CLI answers this body as the next turn (claude-cli shows
     * "Press up to edit queued messages"). That is what the owner wants when
     * they add a follow-up thought mid-turn — losing the answer they are waiting
     * for is the outcome they avoided by not pressing stop.
     *
     * ★ This is NOT the retired force-inject. oss 6cca365b removed a path that
     * wrote `text + '\r'` as ONE write and was told it had sent something the
     * CLI never consumed. Live A/B (2026-09-12, claude-cli v2.1.220) showed the
     * failure belonged to that combined write: the same body written as text,
     * then a gap, then the submit key IS taken by the CLI's queue. The daemon's
     * `send_now` policy performs only that split shape, on POSIX only — win32's
     * ConPTY absorbs a delayed lone CR and has not been re-measured, so it
     * refuses rather than guessing.
     *
     * ★ A refusal does NOT fall back to interrupting. The daemon reports why and
     * the bubble stays queued for the ordinary idle drain, because silently
     * destroying a turn the owner did not ask to destroy is worse than the
     * message waiting a little longer.
     *
     * Takes no message argument on purpose: it re-sends the body the bubble is
     * already showing, so the two can never disagree.
     */
    const handleSendNowQueued = useCallback(async (pendingId?: string): Promise<boolean> => {
        if (!activeConv) return false
        if (sendInFlightRef.current) return false
        const queue = pendingLocalMessagesRef.current
        const pending = pendingId
            ? queue.find(entry => entry.id === pendingId)
            : queue.find(entry => entry.queued === true)
        if (!pending || !pending.queued || pending.deliveryUncertain || (pending.requiresReceipt && !pending.outgoingReceipt)) return false

        const message = pending.content.trim()
        if (!message) return false
        const targetId = pending.id

        sendInFlightRef.current = true
        setIsSendingChat(true)
        setSendFeedbackMessage(null)

        // The bubble deliberately STAYS mounted and STAYS queued for the whole
        // round trip. It is the same body the user is looking at; removing it
        // and re-adding it would flicker, and leaving it un-queued would hide
        // the state we are still in until the daemon answers.
        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) {
                setSendFeedbackMessage('Unable to send message right now.')
                return false
            }

            // ★ The recent-duplicate record is NOT consulted or cleared here.
            // The body is intentionally the same text as the original send —
            // that is the whole feature — so the dedup guard that protects
            // against double-typing would suppress every send-now if applied,
            // and clearing it would let a subsequent retry double-park.
            //
            // ★ (Phase D-web) SAME `messageId` (`targetId`), SAME `pending.input`
            // envelope — this is a RESUBMIT of the original `OutboundMessage`
            // under a different `policy`, not a new logical send. Passing
            // `pending.input` (rather than re-deriving from `message` alone)
            // is what keeps an attachment attached across send-now; see
            // `buildSendChatPayload`'s doc comment for the regression this closes.
            const raw = await sendDaemonCommand(
                routeTarget,
                'send_chat',
                buildSendChatPayload(targetId, message, pending.input, activeConv, { mode: 'send_now' }),
            )
            const res = unwrapCommandResult(raw)
            updatePendingMessages(prev => applyOutgoingReceipts(prev, [res?.outgoingReceipt], true))

            // The daemon refused — nothing was written. Reasons range from
            // "never possible here" (win32, or a driver without the split
            // write) to "not right now" (the session stopped generating, a
            // previous send is still submitting). Either way the bubble STAYS
            // queued so the ordinary idle drain still delivers it, and the
            // owner is told why rather than watching a button do nothing.
            if (res?.success === false) {
                setSendFeedbackMessage(getInlineSendFailureMessage(new Error(res?.error || 'Send now failed')))
                return false
            }

            // ★ Handed to the AGENT's own queue. The body left our FIFO and is
            // in the CLI, so the queued badge is dropped — but it has NOT been
            // answered yet, and the bubble stays until the daemon's echo retires
            // it, exactly like an ordinary send awaiting its turn.
            if (res?.queuedWithAgent === true) {
                setLastSendQueued(false)
                updatePendingMessages(prev => prev.map(entry => (
                    entry.id === targetId ? { ...entry, queued: false, deliveryUncertain: true } : entry
                )))
                setSendFeedbackMessage(null)
                return true
            }

            // Parked in the daemon FIFO rather than delivered. Report that
            // honestly rather than clearing the queued badge on a delivery that
            // did not happen.
            if (isQueuedSendResult(res)) {
                setLastSendQueued(true)
                updatePendingMessages(prev => prev.map(entry => (
                    entry.id === targetId ? { ...entry, queued: true } : entry
                )))
                setSendFeedbackMessage(null)
                return true
            }

            // Delivered as a real turn: drop the queued badge. The bubble stays
            // until matching write evidence retires it, exactly as a normal send.
            setLastSendQueued(false)
            updatePendingMessages(prev => prev.map(entry => (
                entry.id === targetId ? { ...entry, queued: false, deliveryUncertain: true } : entry
            )))
            setSendFeedbackMessage(null)
            return true
        } catch (e) {
            console.warn('Send now blocked/failed', e)
            setSendFeedbackMessage(getInlineSendFailureMessage(e))
            return false
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand, updatePendingMessages])

    /**
     * (QUEUED-SEND-CANCEL) Withdraw ONE waiting body.
     *
     * ★ Why this must reach the daemon, and cannot be a local removal.
     *
     * The body is not merely "displayed" as waiting — it is genuinely parked in
     * `FsmDriver.pendingSends`, and `drainPendingSends()` WILL write it to the
     * PTY as soon as the agent goes idle. Removing only the local bubble would
     * produce the worst possible outcome: the owner is told the message is
     * cancelled, sees it disappear, and then the agent answers it anyway some
     * time later. So the local entry is dropped only AFTER the daemon confirms
     * it actually removed the body from its queue.
     *
     * The daemon side withdraws the FIFO entry parked under this bubble's
     * `messageId` (SessionInputService.withdraw) — the same id-keyed claim the
     * send-now / interrupt routes use.
     *
     * ★ Failure is NOT silent. If the daemon cannot find the body — most often
     * because it already drained and is being answered right now — the bubble
     * STAYS and the owner is told, rather than being shown a cancellation that
     * did not happen.
     */
    const handleCancelQueued = useCallback(async (pendingId: string): Promise<boolean> => {
        if (!activeConv || !pendingId) return false
        const pending = pendingLocalMessagesRef.current.find(entry => entry.id === pendingId)
        if ((pending?.outgoingReceipt?.state === 'failed' && pending.outgoingReceipt.proof === 'not_written') || pending?.sendFailed === true) {
            clearDismissedUncertainMessageId(pendingId)
            updatePendingMessages(prev => prev.filter(entry => entry.id !== pendingId))
            return true
        }
        if (pending?.deliveryUncertain || (pending?.requiresReceipt && !pending.outgoingReceipt && pending.settled)) return false
        if (!pending) return false

        const message = pending.content.trim()

        // ★ (CANCEL-INFLIGHT-LEAK) A local-only drop is correct ONLY for an
        // entry whose send has already RESOLVED without parking: the daemon
        // delivered it or refused it, so there is no remote state to contradict.
        //
        // An UNSETTLED entry is the opposite case and used to take this same
        // branch. Its `send_chat` is still in flight, so the daemon may be
        // parking the body at this very moment — and the old code removed the
        // bubble and issued no command, leaving that body in the FIFO to be
        // drained minutes later. The owner saw a clean cancellation and the
        // agent answered the message anyway, with no bubble left to explain it.
        // Unknown must therefore fall through to the daemon: asking to cancel a
        // body that was never parked costs one command and answers
        // `cancelled: 0`, while skipping the ask costs the owner a message they
        // believed they had withdrawn.
        if (pending.settled && !pending.queued) {
            if (pending.requiresReceipt) return false
            updatePendingMessages(prev => prev.filter(entry => entry.id !== pendingId))
            return true
        }

        // ★ Order the two commands rather than racing them. `cancel_queued_chat`
        // can only claim a body that is ALREADY in the FIFO, so firing it while
        // `send_chat` is still travelling would answer `cancelled: 0` for a body
        // that gets parked a moment later — a cancel that reports "too late"
        // and then lets the message through anyway, which is the same silent
        // delivery in a new disguise. Waiting for the send to resolve makes the
        // claim meaningful; if the wait times out we still ask (a stale bubble
        // the owner wants gone beats a body nobody tried to withdraw).
        if (!pending.settled) {
            const settlement = await awaitSendSettlement(inFlightSendsRef.current, pendingId)
            // Resolved without parking: delivered as a real turn, or refused.
            // The FIFO holds nothing, so a claim would be noise — drop locally.
            if (settlement === 'not-parked') {
                if (pending.requiresReceipt) return false
                updatePendingMessages(prev => prev.filter(entry => entry.id !== pendingId))
                return true
            }
            // `parked` and `unknown` both fall through to the daemon. `unknown`
            // deliberately does NOT drop locally: an unresolved send is exactly
            // the state whose body may be sitting in the FIFO, and assuming
            // "nothing was parked" there is the original defect.
        }

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) {
                setSendFeedbackMessage('Unable to cancel this message right now.')
                return false
            }

            // ★ (Phase D) Cancelled by `messageId` — the daemon FIFO entry carries
            // the same id, so the withdrawal is exact. `message` rides along only
            // for a pre-D daemon's one-release text fallback.
            const raw = await sendDaemonCommand(routeTarget, 'cancel_queued_chat', {
                messageId: pendingId,
                message,
                ...getProviderArgs(activeConv),
            })
            const res = unwrapCommandResult(raw)

            // `cancelled: 0` means the FIFO did not hold this body. That has TWO
            // FIFO absence can mean either a drain or a lost parked body.
            // Native receipts keep both cases uncertain; the legacy non-PTY
            // local-dismiss behavior remains limited to its existing stale rows.
            const daemonHoldsNothing = typeof res?.cancelled === 'number' && res.cancelled === 0
            if (daemonHoldsNothing && pending.stale === true && !pending.requiresReceipt) {
                updatePendingMessages(prev => prev.filter(entry => entry.id !== pendingId))
                setSendFeedbackMessage(prev => (prev === QUEUED_SEND_MESSAGE ? null : prev))
                return true
            }
            if (res?.success === false || daemonHoldsNothing) {
                if (pending.requiresReceipt) updatePendingMessages(prev => prev.map(entry => entry.id === pendingId
                    ? { ...entry, deliveryUncertain: true } : entry))
                setSendFeedbackMessage(pending.requiresReceipt ? 'Delivery unconfirmed — do not resend.' : CANCEL_QUEUED_TOO_LATE_MESSAGE)
                return false
            }

            if (pending.requiresReceipt && !(res?.removed === true || res?.cancelled > 0)) return false
            if (res?.messageId && res.messageId !== pendingId) return false
            updatePendingMessages(prev => prev.filter(entry => entry.id !== pendingId))
            // The parked-send notice describes a wait that no longer exists once
            // nothing is queued.
            setSendFeedbackMessage(prev => (prev === QUEUED_SEND_MESSAGE ? null : prev))
            return true
        } catch (e) {
            console.warn('Cancel queued send failed', e)
            setSendFeedbackMessage(getInlineSendFailureMessage(e))
            return false
        }
    }, [activeConv, sendDaemonCommand, updatePendingMessages])

    const handleRetryPendingMessage = useCallback(async (pendingId?: string): Promise<boolean> => {
        if (!activeConv || sendInFlightRef.current) return false
        const queue = pendingLocalMessagesRef.current
        const target = pendingId
            ? queue.find(entry => entry.id === pendingId)
            : queue.find(entry => entry.sendFailed === true || entry.outgoingReceipt?.state === 'failed' || entry.stale === true || entry.deliveryUncertain === true)
        if (!target) return false
        const attachments: ImageAttachment[] | undefined = target.input?.parts
            ?.filter(part => part.type === 'image' && typeof part.data === 'string' && part.data.length > 0)
            .map((part, idx) => ({
                id: `retry-${target.id}-${idx}`,
                dataUrl: `data:${part.mimeType || 'image/png'};base64,${part.data}`,
                mimeType: part.mimeType || 'image/png',
                name: part.alt || `image-${idx + 1}.png`,
            }))
        clearDismissedUncertainMessageId(target.id)
        lastSendRef.current = null
        const nextQueue = queue.filter(entry => entry.id !== target.id)
        pendingLocalMessagesRef.current = nextQueue
        updatePendingMessages(prev => prev.filter(entry => entry.id !== target.id))
        return handleSendChat(target.content, attachments && attachments.length > 0 ? attachments : undefined)
    }, [activeConv, handleSendChat, updatePendingMessages])

    const handleRelaunch = useCallback(async () => {
        if (!activeConv) return

        try {
            if (!activeConv.hostIdeType) return
            await sendDaemonCommand(activeConv.routeId, 'launch_ide', {
                ideType: activeConv.hostIdeType,
                enableCdp: true,
            })
        } catch (e) {
            console.error('Relaunch failed', e)
        }
    }, [activeConv, sendDaemonCommand])

    const handleModalButton = useCallback(async (buttonText: string) => {
        if (!activeConv) return

        try {
            const buttons = activeConv.modalButtons || []
            const buttonIndex = buttons.indexOf(buttonText)
            const clean = buttonText.replace(/[⌥⏎⇧⌫⌘⌃]/g, '').trim().toLowerCase()
            const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean)
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) return

            const raw = await sendDaemonCommand(routeTarget, 'resolve_action', {
                button: buttonText,
                action: isApprove ? 'approve' : 'reject',
                ...(buttonIndex >= 0 && { buttonIndex }),
                ...getProviderArgs(activeConv),
                // Gate B: a remote mesh-worker approval must relay through the session's
                // coordinator. Carry the coordinator routing hint so web-cloud picks it
                // even with multiple command-channel daemons connected (empty for local).
                ...getCoordinatorRoutingHint(activeConv),
            })
            const res = unwrapCommandResult(raw)

            if (!res.success) {
                setActionLogs(prev => [...prev, {
                    routeId: activeConv.tabKey,
                    text: getActionFailureText(buttonText, res?.error),
                    timestamp: Date.now(),
                }])
            }
        } catch (e) {
            if (!isExpectedActionResolutionError(e)) {
                console.error('[ModalButton] Error:', e)
            }
            setActionLogs(prev => [...prev, {
                routeId: activeConv.tabKey,
                text: isExpectedActionResolutionError(e)
                    ? getActionFailureText(buttonText, e)
                    : `❌ **${buttonText}** error`,
                timestamp: Date.now(),
            }])
        }
    }, [activeConv, sendDaemonCommand, setActionLogs])

    const handleFocusAgent = useCallback(async () => {
        if (!activeConv || isFocusingAgent) return

        setIsFocusingAgent(true)
        try {
            await sendDaemonCommand(activeConv.routeId, getExplicitSessionRevealCommand(), {
                ...(activeConv.sessionId && { targetSessionId: activeConv.sessionId }),
            })
        } catch (e) {
            console.error('Focus agent failed', e)
        } finally {
            setIsFocusingAgent(false)
        }
    }, [activeConv, isFocusingAgent, sendDaemonCommand])

    // ★ MUST stay memoized. Render sites take this whole object as ONE prop and
    // compare it by reference in `React.memo`. A fresh object literal every
    // render would fail that comparison unconditionally, defeating the memo and
    // re-rendering the chat pane on every parent render — the one performance
    // hazard this bundling introduces.
    //
    // The five handlers below are already `useCallback`-stable, so this memo
    // recomputes only when a value the consumers actually render changes.
    // Compatibility view for surfaces that render only one bubble: the NEWEST
    // entry. Derived (not separate state) so it can never disagree with the
    // authoritative array.
    const pendingLocalMessage = pendingLocalMessages.length > 0
        ? pendingLocalMessages[pendingLocalMessages.length - 1]
        : null

    return useMemo<DashboardConversationCommands>(() => ({
        isSendingChat,
        sendFeedbackMessage,
        lastSendQueued,
        pendingLocalMessage,
        pendingLocalMessages,
        isFocusingAgent,
        handleSendChat,
        handleSendNowQueued,
        handleCancelQueued,
        handleRetryPendingMessage,
        retireEchoedPendingMessages,
        handleRelaunch,
        handleModalButton,
        handleFocusAgent,
    }), [
        isSendingChat,
        sendFeedbackMessage,
        lastSendQueued,
        pendingLocalMessage,
        pendingLocalMessages,
        isFocusingAgent,
        handleSendChat,
        handleSendNowQueued,
        handleCancelQueued,
        handleRetryPendingMessage,
        retireEchoedPendingMessages,
        handleRelaunch,
        handleModalButton,
        handleFocusAgent,
    ])
}
