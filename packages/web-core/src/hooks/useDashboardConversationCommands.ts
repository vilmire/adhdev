import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type { ImageAttachment } from '../components/dashboard/ChatInputBar'
import { getProviderArgs, getRouteTarget, getConversationSendBlockMessage, getInlineSendFailureMessage } from './dashboardCommandUtils'
import { getCoordinatorRoutingHint } from '../components/dashboard/conversation-selectors'
import { isConversationGenerating } from '../components/dashboard/DashboardMobileChatShared'
import type { PendingLocalMessage } from '../components/dashboard/conversation-message-snapshot'
import { getExplicitSessionRevealCommand } from '../components/dashboard/dashboardSessionCommands'

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
    /** Optimistic local bubble; feed to `withPendingLocalMessage`. */
    pendingLocalMessage: PendingLocalMessage | null
    isFocusingAgent: boolean
    handleSendChat: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>
    handleForceSendChat: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>
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
        && lastSend.message === attempt.message
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
 * in-memory FIFO took the body, and `cli-manager.ts` adds
 * `{queued:true, queuedReason:'agent_runtime_busy'}` on the mesh path. Until
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
 * Build the payload for a send_chat command.
 * When attachments are present, build a structured InputEnvelope so the daemon
 * can route image data to the correct provider input path.
 * Falls back to the plain {message} shape for text-only sends.
 */
function buildSendChatPayload(
    message: string,
    attachments: ImageAttachment[] | undefined,
    activeConv: ActiveConversation,
    options: { force?: boolean } = {},
): Record<string, unknown> {
    const providerArgs = getProviderArgs(activeConv)
    if (!attachments || attachments.length === 0) {
        return { message, ...(options.force ? { force: true } : {}), ...providerArgs }
    }

    // Structured input envelope — matches daemon's normalizeInputEnvelope contract
    const parts: unknown[] = attachments.map((att) => ({
        type: 'image',
        mimeType: att.mimeType,
        data: att.data,
        alt: att.name,
    }))
    if (message) {
        parts.push({ type: 'text', text: message })
    }

    return {
        message,          // kept for backward-compat with older daemons
        input: {
            parts,
            textFallback: message,
        },
        ...(options.force ? { force: true } : {}),
        ...providerArgs,
    }
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
    // (OPTIMISTIC-USER-BUBBLE) The owner's message, rendered locally from the
    // moment it is submitted until the daemon's echo carries it back. See
    // `withPendingLocalMessage` for the dedup contract that retires it.
    const [pendingLocalMessage, setPendingLocalMessage] = useState<PendingLocalMessage | null>(null)
    const sendInFlightRef = useRef(false)
    const lastSendRef = useRef<RecentSendAttempt | null>(null)

    useEffect(() => {
        setSendFeedbackMessage(null)
        setLastSendQueued(false)
        // Scoped per conversation: a pending bubble belongs to the tab it was
        // typed in and must not follow the user to another session.
        setPendingLocalMessage(null)
    }, [activeConv?.tabKey])

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

        const now = Date.now()
        const attempt: RecentSendAttempt = {
            tabKey: activeConv.tabKey,
            message,
            timestamp: now,
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
        setPendingLocalMessage({ content: message, sentAt: now })

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) {
                lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
                // Nothing was sent, so no echo will ever retire the bubble.
                setPendingLocalMessage(null)
                setSendFeedbackMessage('Unable to send message right now.')
                return false
            }

            const raw = await sendDaemonCommand(routeTarget, 'send_chat', buildSendChatPayload(message, attachments, activeConv))
            const res = unwrapCommandResult(raw)

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
                setLastSendQueued(true)
                setPendingLocalMessage(prev => (prev ? { ...prev, queued: true } : prev))
                setSendFeedbackMessage(QUEUED_SEND_MESSAGE)
                return true
            }

            if (res?.sent === false) {
                throw new Error(res?.error || 'Send failed')
            }

            if (res?.success === false) {
                throw new Error(res?.error || 'Send failed')
            }

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
            // The send failed, so the daemon will never echo this text back.
            // Leaving the optimistic bubble would show a message that was never
            // delivered as though it had been.
            setPendingLocalMessage(null)
            setSendFeedbackMessage(getInlineSendFailureMessage(e))
            return false
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand])

    const handleForceSendChat = useCallback(async (rawMessage: string, attachments?: ImageAttachment[]): Promise<boolean> => {
        if (!activeConv) return false
        if (sendInFlightRef.current) return false

        const message = rawMessage.trim()
        if (!message && (!attachments || attachments.length === 0)) return false

        const now = Date.now()
        const attempt: RecentSendAttempt = {
            tabKey: activeConv.tabKey,
            message: `force:${message}`,
            timestamp: now,
        }
        if (shouldSuppressRecentDuplicateSend(lastSendRef.current, attempt)) {
            setSendFeedbackMessage(null)
            return true
        }

        sendInFlightRef.current = true
        setIsSendingChat(true)
        setSendFeedbackMessage(null)
        lastSendRef.current = attempt

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) {
                lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
                setSendFeedbackMessage('Unable to send message right now.')
                return false
            }

            const raw = await sendDaemonCommand(routeTarget, 'send_chat', buildSendChatPayload(message, attachments, activeConv, { force: true }))
            const res = unwrapCommandResult(raw)
            if (res?.success === false || res?.sent === false) {
                throw new Error(res?.error || 'Send failed')
            }
            setSendFeedbackMessage(null)
            return true
        } catch (e) {
            console.warn('Force send blocked/failed', e)
            lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
            setSendFeedbackMessage(getInlineSendFailureMessage(e))
            return false
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand])

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
    return useMemo<DashboardConversationCommands>(() => ({
        isSendingChat,
        sendFeedbackMessage,
        lastSendQueued,
        pendingLocalMessage,
        isFocusingAgent,
        handleSendChat,
        handleForceSendChat,
        handleRelaunch,
        handleModalButton,
        handleFocusAgent,
    }), [
        isSendingChat,
        sendFeedbackMessage,
        lastSendQueued,
        pendingLocalMessage,
        isFocusingAgent,
        handleSendChat,
        handleForceSendChat,
        handleRelaunch,
        handleModalButton,
        handleFocusAgent,
    ])
}
