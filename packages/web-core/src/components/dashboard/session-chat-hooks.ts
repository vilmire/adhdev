/**
 * session-chat-hooks — React binding layer for the session chat controller
 * (`session-chat-controller.ts`). The controller holds state with no React
 * dependency; these hooks retain it, subscribe to its snapshot, and wire the
 * one user-driven read it has: "Load older messages" (`chat_history`).
 *
 * Live content arrives only through the keyed chat lane
 * (`applyTranscriptViewToControllers`); nothing here fetches the live window.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ActiveConversation, DashboardMessage } from './types'
import { useTransport } from '../../context/TransportContext'
import { getConversationDaemonRouteId } from './conversation-selectors'
import { getConversationHistorySessionIdForRead } from './conversation-identity'
import { readChatActivityVisiblePreference } from './chat-activity-visibility'
import {
    DEFAULT_WARM_SESSION_CHAT_RECENT_ACTIVITY_MS,
    buildControllerHandle,
    buildEmptySnapshot,
    buildWarmSessionChatDescriptorState,
    controllerRegistry,
    getControllerKey,
    getControllerRegistryGeneration,
    getOrCreateSessionChatController,
    getWarmSessionChatDescriptorRefreshMs,
    subscribeControllerRegistry,
    type SessionChatControllerHandle,
    type SessionChatSnapshot,
} from './session-chat-controller'

export function useSessionChatController(
    activeConv: ActiveConversation,
    options?: { enabled?: boolean },
): SessionChatControllerHandle {
    const { sendData, sendCommand } = useTransport()
    // (CHAT-TAB-SWITCH-STALE-FALLBACK) `enabled` is "a session exists", never
    // panel visibility: dropping the controller while a pane is merely hidden
    // would empty its snapshot and flash the stale status-meta list on return.
    const enabled = options?.enabled !== false
    const daemonId = getConversationDaemonRouteId(activeConv)
    const sessionId = activeConv.sessionId || ''
    // Only a REAL, DISTINCT provider conv id is sent to the daemon as
    // historySessionId (never the runtime sessionId — that is the read poison).
    const historySessionId = getConversationHistorySessionIdForRead(activeConv)
    const fallbackRecentCount = activeConv.messages.length

    const controller = useMemo(() => {
        if (!enabled || !daemonId || !sessionId) return null
        return getOrCreateSessionChatController({
            daemonId,
            sessionId,
            historySessionId,
            sendData,
            fallbackRecentCount,
        })
        // `fallbackRecentCount` changes on every meta append; it is pushed via
        // updateOptions below instead of recreating the controller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [daemonId, enabled, historySessionId, sendData, sessionId])

    useEffect(() => {
        controller?.updateOptions({ fallbackRecentCount })
    }, [controller, fallbackRecentCount])

    const [snapshot, setSnapshot] = useState<SessionChatSnapshot>(() => (
        controller?.getSnapshot() || buildEmptySnapshot()
    ))

    useEffect(() => {
        if (!controller) {
            setSnapshot(buildEmptySnapshot())
            return
        }
        controller.retain()
        setSnapshot(controller.getSnapshot())
        const unsubscribe = controller.subscribe((nextSnapshot) => {
            setSnapshot(nextSnapshot)
        })
        return () => {
            unsubscribe()
            controller.release()
        }
    }, [controller])

    const loadHistoryPage = useCallback(async () => {
        if (!controller || !daemonId || !sessionId) return
        await controller.loadHistoryPage(async ({ offset, excludeRecentCount, excludeFromIdentity }) => {
            const raw = await sendCommand(daemonId, 'chat_history', {
                agentType: activeConv.agentType,
                offset,
                limit: 30,
                targetSessionId: sessionId,
                historySessionId,
                excludeRecentCount,
                ...(excludeFromIdentity ? { excludeFromIdentity } : {}),
                // Pages follow the dashboard activity toggle at call time.
                ...(readChatActivityVisiblePreference() ? { includeActivity: true } : {}),
            })
            const result = raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
                ? (raw as { result?: { messages?: DashboardMessage[]; hasMore?: boolean } }).result || {}
                : (raw as { messages?: DashboardMessage[]; hasMore?: boolean } | undefined) || {}
            return {
                messages: Array.isArray(result.messages) ? result.messages : [],
                hasMore: result.hasMore === true,
            }
        })
    }, [activeConv.agentType, controller, daemonId, historySessionId, sendCommand, sessionId])

    return useMemo(
        () => buildControllerHandle(snapshot, loadHistoryPage),
        [loadHistoryPage, snapshot],
    )
}

/**
 * Retain a controller for every "warm" conversation (active, parked on a
 * decision, or recently active), so their sessions are part of the transcript
 * interest and the mobile inbox previews read live keyed views.
 */
export function useWarmSessionChatControllers(
    conversations: ActiveConversation[],
    options?: { enabled?: boolean; recentActivityMs?: number },
): void {
    const { sendData } = useTransport()
    const enabled = options?.enabled !== false
    const recentActivityMs = Math.max(0, Number(options?.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_RECENT_ACTIVITY_MS))
    const refreshMs = getWarmSessionChatDescriptorRefreshMs(recentActivityMs)
    const [refreshTick, setRefreshTick] = useState(0)

    useEffect(() => {
        if (!enabled || conversations.length === 0) return
        const timer = setInterval(() => {
            setRefreshTick((prev) => prev + 1)
        }, refreshMs)
        return () => {
            clearInterval(timer)
        }
    }, [conversations.length, enabled, refreshMs])

    const descriptorState = useMemo(
        () => buildWarmSessionChatDescriptorState(conversations, { recentActivityMs }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [conversations, recentActivityMs, refreshTick],
    )

    useEffect(() => {
        if (!enabled || descriptorState.descriptors.length === 0) return
        const controllers = descriptorState.descriptors.map((descriptor) => getOrCreateSessionChatController({
            ...descriptor,
            ...(sendData ? { sendData } : {}),
        }))
        controllers.forEach((controller) => controller.retain())
        return () => {
            controllers.forEach((controller) => controller.release())
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [descriptorState.signature, enabled, sendData])
}

/**
 * Reactive version counter that bumps whenever any warm controller for the given
 * conversations emits a new snapshot. The mobile inbox derives row previews from
 * an imperative registry read (`getSessionChatSnapshotForConversation`); feeding
 * this into its memo deps makes the previews follow live keyed frames.
 */
export function useWarmSessionChatSnapshotVersion(
    conversations: ActiveConversation[],
): number {
    const [version, setVersion] = useState(0)

    const controllerKeys = useMemo(() => {
        const keys: string[] = []
        for (const conversation of conversations) {
            const daemonId = getConversationDaemonRouteId(conversation)
            const sessionId = conversation.sessionId || ''
            if (!daemonId || !sessionId) continue
            const historySessionIdForRead = getConversationHistorySessionIdForRead(conversation)
            keys.push(getControllerKey(daemonId, sessionId, historySessionIdForRead || sessionId))
        }
        return keys
    }, [conversations])

    const controllerKeySignature = controllerKeys.join('|')

    // Track registry membership so we (re)subscribe once a warm controller for
    // one of our keys is actually created.
    const registryGeneration = useSyncExternalStore(
        subscribeControllerRegistry,
        getControllerRegistryGeneration,
        getControllerRegistryGeneration,
    )

    useEffect(() => {
        if (controllerKeys.length === 0) return
        const unsubscribes: Array<() => void> = []
        for (const key of controllerKeys) {
            const controller = controllerRegistry.get(key)
            if (!controller) continue
            // subscribe() synchronously seeds the listener once; skip that call.
            let seededSnapshot = false
            unsubscribes.push(
                controller.subscribe(() => {
                    if (!seededSnapshot) {
                        seededSnapshot = true
                        return
                    }
                    setVersion((prev) => prev + 1)
                }),
            )
        }
        return () => {
            for (const unsubscribe of unsubscribes) unsubscribe()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [controllerKeySignature, registryGeneration])

    return version
}
