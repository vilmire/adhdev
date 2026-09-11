/**
 * session-chat-tail-hooks — React binding layer for the chat-tail controller.
 *
 * Moved VERBATIM out of `session-chat-tail-controller.ts` (which had grown past
 * the file-size gate) so the controller module holds transport/state logic with
 * no React dependency, and this module holds the hooks that subscribe to it.
 * No logic change: hook bodies, dependency arrays, and effect ordering are
 * preserved exactly. The controller module re-exports these three hooks, so
 * every existing import path keeps working.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionChatTailUpdate } from '@adhdev/daemon-core'
import type { ActiveConversation, DashboardMessage } from './types'
import { useTransport } from '../../context/TransportContext'
import { getConversationDaemonRouteId } from './conversation-selectors'
import { getConversationHistorySessionIdForRead } from './conversation-identity'
import {
  readChatActivityVisiblePreference,
  subscribeChatActivityVisiblePreference,
} from './chat-activity-visibility'
import {
  CHAT_TAIL_LIVENESS_TICK_MS,
  DEFAULT_TAIL_LIMIT,
  DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS,
  buildChatTailLivenessWatchdogPlan,
  buildControllerHandle,
  buildEmptySnapshot,
  buildWarmSessionChatTailDescriptorState,
  controllerRegistry,
  getControllerKey,
  getControllerRegistryGeneration,
  getOrCreateSessionChatTailController,
  getWarmSessionChatTailDescriptorRefreshMs,
  subscribeControllerRegistry,
  type SessionChatTailControllerHandle,
  type SessionChatTailSnapshot,
} from './session-chat-tail-controller'

export function useSessionChatTailController(
  activeConv: ActiveConversation,
  options?: { enabled?: boolean; tailLimit?: number; refreshEnabled?: boolean },
): SessionChatTailControllerHandle {
  const { sendData, sendCommand, isConnected } = useTransport()
  const enabled = options?.enabled !== false
  // (CHAT-TAB-SWITCH-STALE-FALLBACK) Panel visibility must NOT gate `enabled`.
  // Dropping the controller when a pane is merely hidden empties the snapshot
  // (`hasLiveSnapshot: false`), which makes the pane fall back to the stale
  // status-meta `conversation.messages` list — the "old messages then catch-up"
  // the user sees on every session-tab switch. Visibility only gates the
  // one-shot authoritative re-pull below, which is the part that actually costs
  // a round trip; holding the (registry-shared, refcounted) subscription while
  // hidden is what keeps the live window intact across a switch.
  const refreshEnabled = options?.refreshEnabled !== false
  const daemonId = getConversationDaemonRouteId(activeConv)
  const sessionId = activeConv.sessionId || ''
  // Only a REAL, DISTINCT provider conv id is sent to the daemon as
  // historySessionId; for an agy coordinator (no surfaced providerSessionId)
  // this is undefined so every native read (subscribe / read_chat / chat_history)
  // OMITS the arg and the daemon runs its owner-confirmed native resolution
  // instead of fail-closing on the runtime session id. Never fall back to
  // sessionId here — that fallback is the read poison.
  const historySessionId = getConversationHistorySessionIdForRead(activeConv)
  const subscriptionKey = `daemon:${daemonId}:session:${sessionId}`
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)

  const fallbackRecentCount = activeConv.messages.length

  const controller = useMemo(() => {
    if (!enabled || !daemonId || !sessionId) return null
    return getOrCreateSessionChatTailController({
      daemonId,
      sessionId,
      historySessionId,
      subscriptionKey,
      sendData,
      tailLimit,
      fallbackRecentCount,
      // Activity toggle at creation time; flips are pushed via updateOptions
      // in the preference effect below (never a controller-recreate dep).
      includeActivity: readChatActivityVisiblePreference(),
    })
    // `fallbackRecentCount` (activeConv.messages.length) is intentionally NOT a
    // dep: it changes on every meta append, and including it tore down and
    // recreated the controller (and its subscription) on every tick — pure
    // resubscribe churn. The controller is keyed by stable ids; we push the
    // fresh fallback count via updateOptions() in the effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonId, enabled, historySessionId, sendData, sessionId, subscriptionKey, tailLimit])

  // Keep the (already-stable) controller's fallback count current without
  // recreating it. updateOptions only resubscribes when an identity field
  // (sendData/daemonId/sessionId) actually changes, so a plain count bump is a
  // cheap in-place update.
  useEffect(() => {
    controller?.updateOptions({ fallbackRecentCount })
  }, [controller, fallbackRecentCount])

  const [snapshot, setSnapshot] = useState<SessionChatTailSnapshot>(() => (
    controller?.getSnapshot() || buildEmptySnapshot(tailLimit)
  ))

  useEffect(() => {
    if (!controller) {
      setSnapshot(buildEmptySnapshot(tailLimit))
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
  }, [controller, tailLimit])

  const loadHistoryPage = useCallback(async () => {
    if (!controller || !daemonId || !sessionId) return
    await controller.loadHistoryPage(async ({ offset, excludeRecentCount, excludeFromIdentity }) => {
      const agentType = activeConv.agentType
      const raw = await sendCommand(daemonId, 'chat_history', {
        agentType,
        offset,
        limit: 30,
        targetSessionId: sessionId,
        historySessionId,
        excludeRecentCount,
        // Omitted when empty so the payload an old browser sends and the payload
        // a new browser sends for an identity-less transcript are the same shape.
        ...(excludeFromIdentity ? { excludeFromIdentity } : {}),
        // Same toggle that drives the live tail's includeActivity — read at
        // call time so pages loaded after a toggle flip follow the new state.
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

  // (D8 — web self-heal) One-shot authoritative tail re-pull via read_chat. Fed
  // through the controller's SAME apply path as the subscription, so a stale
  // user-only liveMessages is replaced by the daemon's [user, assistant] tail
  // (D2/D6 compose; no duplicate assistant bubble). Fires on mount, on tab focus
  // (visibilitychange→visible), and on WS reconnect — debounced to one request
  // per burst inside the controller.
  const refreshAuthoritativeTail = useCallback((force = false): Promise<void> => {
    if (!controller || !daemonId || !sessionId) return Promise.resolve()
    return controller.refreshAuthoritativeTail(async () => {
      const raw = await sendCommand(daemonId, 'read_chat', {
        agentType: activeConv.agentType,
        targetSessionId: sessionId,
        historySessionId,
        ...(tailLimit > 0 ? { tailLimit } : {}),
        // Activity toggle opt-in, read at call time (a re-pull fired right
        // after a toggle flip must reflect the NEW state, and a stale-closure
        // boolean here would clobber activity rows the push lane delivered).
        ...(readChatActivityVisiblePreference() ? { includeActivity: true } : {}),
      })
      // Response shape differs by transport (see TransportContext note): unwrap
      // the Cloud `result` wrapper, then read the daemon's raw read_chat body.
      const body = (raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
        ? (raw as { result?: unknown }).result
        : raw) as Record<string, unknown> | undefined
      if (!body || typeof body !== 'object') return null
      if (body.success === false) return null
      const messages = Array.isArray(body.messages)
        ? body.messages as DashboardMessage[]
        : (Array.isArray(body.messagesTail) ? body.messagesTail as DashboardMessage[] : [])
      // Map the read_chat body into the same SessionChatTailUpdate shape the
      // subscription delivers, so handleUpdate applies it identically.
      return {
        topic: 'session.chat_tail',
        key: subscriptionKey,
        sessionId,
        historySessionId,
        seq: 0,
        timestamp: 0,
        messages,
        status: typeof body.status === 'string' ? body.status : 'idle',
        ...(body.messageSource && typeof body.messageSource === 'object'
          ? { messageSource: body.messageSource as Record<string, unknown> }
          : {}),
      } as unknown as SessionChatTailUpdate
    }, { force })
  }, [activeConv.agentType, controller, daemonId, historySessionId, sendCommand, sessionId, subscriptionKey, tailLimit])

  // Activity-toggle flip → push the new state into the controller (which
  // resubscribes the legacy lane with the new params) and, when turning ON,
  // force one authoritative re-pull so the already-open pane fills with
  // activity rows immediately instead of waiting for the next daemon push.
  // Turning OFF needs no re-pull: rendering filters activity out client-side.
  useEffect(() => {
    if (!controller) return
    return subscribeChatActivityVisiblePreference((visible) => {
      controller.updateOptions({ includeActivity: visible })
      if (visible) void refreshAuthoritativeTail(true)
    })
    // refreshAuthoritativeTail is stable for a given session identity (same
    // rationale as the mount effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, daemonId, sessionId, historySessionId])

  // Mount + tab-focus + reconnect self-heal. Mount fire happens once per active
  // session (deps are the stable identity fields). Focus and reconnect re-pull
  // the authoritative tail so a browser stranded on a stale user-only snapshot
  // recovers without a hard refresh.
  useEffect(() => {
    if (!controller || !enabled || !refreshEnabled || !daemonId || !sessionId) return
    // Initial mount pull. Also fires on the hidden→visible edge, because
    // `refreshEnabled` is a dep: a pane that comes back into view re-pulls the
    // authoritative tail once. It does so on top of a live snapshot that was
    // never dropped, so it corrects rather than repopulates — no stale-fallback
    // frame in between.
    void refreshAuthoritativeTail(true)

    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refreshAuthoritativeTail()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }

    // Poll the transport connection state (edge-detect disconnect→connect) to
    // re-pull after a WS reconnect. Cheap: a boolean read on a short interval,
    // and the re-pull itself is debounced.
    let lastConnected = isConnected ? isConnected(daemonId) : true
    const reconnectTimer = setInterval(() => {
      if (!isConnected) return
      const connectedNow = isConnected(daemonId)
      if (connectedNow && !lastConnected) {
        void refreshAuthoritativeTail()
      }
      lastConnected = connectedNow
    }, 2_000)

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
      clearInterval(reconnectTimer)
    }
    // refreshAuthoritativeTail is stable across renders for a given session
    // identity; excluded to keep this a mount/session-scoped effect rather than
    // re-running on every meta append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, daemonId, enabled, refreshEnabled, sessionId, historySessionId])

  // (LIVENESS) Watchdog — deliberately a SEPARATE effect from the edge triggers
  // above, and deliberately NOT gated on `refreshEnabled`.
  //
  // ★ The bug this shape fixes: the watchdog used to live inside the effect
  // above, so `refreshEnabled === false` (a hidden Dockview panel) returned
  // early and tore the timer down along with the edge listeners. But the
  // watchdog's stated purpose is to back up panes that get no edges — so it was
  // disarmed in precisely the situation it was written for, and only re-armed
  // once the user manually produced the hidden→visible edge, which already
  // triggers a pull on its own. It could therefore never be the thing that
  // rescued a pane; it was structurally dead weight.
  //
  // It is armed on `enabled` instead, which is the SUBSCRIPTION axis
  // (`ChatPane.tsx` `buildChatPaneTailControllerOptions`: `enabled` = a session
  // exists, `refreshEnabled` = the panel is visible). That matches what the
  // watchdog guards: the push lane the controller is still subscribed to while
  // hidden. Load is bounded by the raised hidden quiet floor
  // (CHAT_TAIL_LIVENESS_HIDDEN_QUIET_FLOOR_MS) plus the pre-existing
  // single-flight/debounce/backoff guards, not by stopping the timer.
  //
  // The mount pull and the `visibilitychange` listener stay in the gated effect
  // above: those ARE edge-driven and visibility is the correct gate for them.
  const watchdogPlan = buildChatTailLivenessWatchdogPlan({
    hasController: !!controller,
    enabled,
    daemonId,
    sessionId,
    refreshEnabled,
  })
  useEffect(() => {
    if (!controller || !watchdogPlan.armed) return
    const livenessTimer = setInterval(() => {
      // Only a boolean check per tick; the controller answers false in every
      // healthy case (single-flight, replica-safe, status-scaled quiet period),
      // so a healthy lane costs no RPC at all.
      if (!controller.shouldRefreshForLiveness({ visible: watchdogPlan.visible })) return
      void refreshAuthoritativeTail()
    }, CHAT_TAIL_LIVENESS_TICK_MS)
    return () => {
      clearInterval(livenessTimer)
    }
    // Same rationale as above: `refreshAuthoritativeTail` is stable for a given
    // session identity. `watchdogPlan.visible` (i.e. `refreshEnabled`) IS a dep
    // here — it selects the quiet window, but never whether the timer runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, watchdogPlan.armed, watchdogPlan.visible, sessionId, historySessionId])

  return useMemo(
    () => buildControllerHandle(snapshot, loadHistoryPage),
    [loadHistoryPage, snapshot],
  )
}

export function useWarmSessionChatTailControllers(
  conversations: ActiveConversation[],
  options?: { enabled?: boolean; tailLimit?: number; recentActivityMs?: number },
): void {
  const { sendData } = useTransport()
  const enabled = options?.enabled !== false
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)
  const recentActivityMs = Math.max(0, Number(options?.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS))
  const refreshMs = getWarmSessionChatTailDescriptorRefreshMs(recentActivityMs)
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
    () => buildWarmSessionChatTailDescriptorState(conversations, { recentActivityMs }),
    [conversations, recentActivityMs, refreshTick],
  )

  useEffect(() => {
    if (!enabled || !sendData || descriptorState.descriptors.length === 0) return
    const controllers = descriptorState.descriptors.map((descriptor) => getOrCreateSessionChatTailController({
      ...descriptor,
      sendData,
      tailLimit,
    }))
    controllers.forEach((controller) => {
      controller.retain()
    })
    return () => {
      controllers.forEach((controller) => controller.release())
    }
  }, [descriptorState.signature, enabled, sendData, tailLimit])
}

/**
 * (B2) Reactive version counter that bumps whenever any warm chat_tail controller
 * for the given conversations emits a new snapshot.
 *
 * The mobile inbox derives its list-item preview/timestamp from the warm
 * controller snapshots via getSessionChatTailSnapshotForConversation(), which is
 * an imperative read of a non-reactive module-level registry Map. That read alone
 * does NOT re-run the inbox `items` memo when a `session.chat_tail` push updates a
 * controller — so previews only refreshed when some OTHER dependency (e.g. opening
 * and closing a conversation) forced the memo to recompute.
 *
 * This hook subscribes to the same controllers the inbox reads and returns a
 * number that increments on every snapshot change. Feed the returned value into
 * the inbox `items` memo dependency array so the memo recomputes (and re-reads the
 * now-updated snapshot) as soon as a new tail arrives — no re-entry required.
 */
export function useWarmSessionChatTailSnapshotVersion(
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

  // Track registry membership changes so we (re)subscribe once a warm controller
  // for one of our keys is actually created (it may not exist yet at first run).
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
      // subscribe() synchronously seeds the listener once with the current
      // snapshot; skip that first call so mount/(re)subscribe doesn't bump.
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
    // Re-run on membership change (controllerKeySignature) and when a controller
    // is added/removed from the registry (registryGeneration) so late-created
    // warm controllers get subscribed.
  }, [controllerKeySignature, registryGeneration])

  return version
}
