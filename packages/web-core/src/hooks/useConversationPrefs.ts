/**
 * useConversationPrefs — daemon-owned per-conversation Mute/Hide with an
 * optimistic overlay.
 *
 * Mute/Hide state lives on the live session in daemon memory and rides the status
 * snapshot as `muted` / `surfaceHidden` (see daemon status/builders). A toggle
 * sends `set_conversation_prefs` to the owning daemon; the authoritative value
 * comes back on the next status snapshot (≤500ms on standalone).
 *
 * To make the toggle feel instant, we keep a small in-memory overlay of pending
 * values keyed by sessionId. `isMuted`/`isHidden` return the pending value when
 * one is set, otherwise the live daemon value. Once the live snapshot catches up
 * to the pending value (daemon confirmed), the overlay entry is dropped so the
 * daemon becomes the single source of truth again. A pending entry also expires
 * after a timeout so a dropped/failed command can't wedge the UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getConversationLiveInboxState, type LiveSessionInboxState } from '../components/dashboard/DashboardMobileChatShared'
import { getConversationMachineId } from '../components/dashboard/conversation-selectors'

type PendingPref = { muted?: boolean; hidden?: boolean; at: number }

// Drop an unconfirmed optimistic entry after this long so a failed/lost command
// never leaves the UI stuck showing a state the daemon never adopted.
const PENDING_TTL_MS = 8000

/**
 * Judge a set_conversation_prefs response for the overlay reconcile. Pure + exported so the
 * cloud double-envelope + mirrorStale handling is unit-testable without a DOM.
 *
 * Fix (3) — cloud double-envelope: the cloud transport wraps the daemon response once
 * (`{ success: true, result: <daemon body> }`), so the worker's own `success:false` / `mirrorStale`
 * lives on `result.result`, not the outer object. Inspecting only the outer envelope missed every
 * remote-worker rejection (the outer wrapper is always success:true). Unwrap the inner body first.
 * Fix (4): a local write that succeeded but whose coordinator mirror refresh failed reports
 * `mirrorStale:true` — treat it as not-confirmed so the optimistic overlay is dropped rather than
 * left showing a value the coordinator will re-stamp back.
 */
export function evaluateConversationPrefsResult(result: unknown): { confirmed: boolean; reason?: string } {
    const body = (result && typeof result === 'object' && 'result' in (result as any))
        ? (result as any).result
        : result
    const isObj = body && typeof body === 'object'
    const failed = isObj && (body as any).success === false
    const mirrorStale = isObj && (body as any).mirrorStale === true
    if (!failed && !mirrorStale) return { confirmed: true }
    const reason = failed && typeof (body as any).error === 'string'
        ? (body as any).error
        : (mirrorStale ? 'the coordinator did not confirm the change' : 'command was rejected')
    return { confirmed: false, reason }
}

export interface ConversationPrefsController {
    isMuted: (conversation: ActiveConversation) => boolean
    isHidden: (conversation: ActiveConversation) => boolean
    toggleMute: (conversation: ActiveConversation) => void
    setHidden: (conversation: ActiveConversation, hidden: boolean) => void
    toggleHidden: (conversation: ActiveConversation) => void
}

export function useConversationPrefs(
    liveSessionInboxState: Map<string, LiveSessionInboxState>,
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>,
    // RESTORE-STICK / mission 6938892f: surface a user-visible error when the toggle
    // fails. Before this the .catch only console.warn'd, so a Hide/Mute (or restore)
    // that never reached the owning worker — 'Session not found' before the command was
    // forwarded, or 'P2P not connected' — silently rolled back and the user saw the row
    // "not respond". Optional so standalone/simpler callers can omit it.
    onError?: (message: string) => void,
): ConversationPrefsController {
    // sessionId → optimistic pending prefs. A ref holds the source of truth; a
    // version counter forces re-render when it changes (the ref itself is stable).
    const pendingRef = useRef<Map<string, PendingPref>>(new Map())
    const [, bumpVersion] = useState(0)
    const rerender = useCallback(() => bumpVersion(v => v + 1), [])

    // Reconcile: drop pending entries the live snapshot has caught up to, and
    // expire stale ones. Runs whenever the live state changes.
    useEffect(() => {
        const pending = pendingRef.current
        if (pending.size === 0) return
        const now = Date.now()
        let changed = false
        for (const [sessionId, pref] of pending) {
            const live = liveSessionInboxState.get(sessionId)
            const mutedSettled = pref.muted === undefined || (live ? live.muted === pref.muted : false)
            const hiddenSettled = pref.hidden === undefined || (live ? live.surfaceHidden === pref.hidden : false)
            const expired = now - pref.at > PENDING_TTL_MS
            if ((mutedSettled && hiddenSettled) || expired) {
                pending.delete(sessionId)
                changed = true
            }
        }
        if (changed) rerender()
    }, [liveSessionInboxState, rerender])

    // Expire stragglers even when no new live snapshot arrives (e.g. command lost).
    useEffect(() => {
        if (pendingRef.current.size === 0) return
        const timer = setInterval(() => {
            const pending = pendingRef.current
            const now = Date.now()
            let changed = false
            for (const [sessionId, pref] of pending) {
                if (now - pref.at > PENDING_TTL_MS) { pending.delete(sessionId); changed = true }
            }
            if (changed) rerender()
            if (pending.size === 0) clearInterval(timer)
        }, 1000)
        return () => clearInterval(timer)
    })

    const setPending = useCallback((sessionId: string, patch: { muted?: boolean; hidden?: boolean }) => {
        const existing = pendingRef.current.get(sessionId)
        pendingRef.current.set(sessionId, { ...existing, ...patch, at: Date.now() })
        rerender()
    }, [rerender])

    const isMuted = useCallback((conversation: ActiveConversation) => {
        const sessionId = conversation.sessionId
        const pending = sessionId ? pendingRef.current.get(sessionId) : undefined
        if (pending?.muted !== undefined) return pending.muted
        return getConversationLiveInboxState(conversation, liveSessionInboxState).muted
    }, [liveSessionInboxState])

    const isHidden = useCallback((conversation: ActiveConversation) => {
        const sessionId = conversation.sessionId
        const pending = sessionId ? pendingRef.current.get(sessionId) : undefined
        if (pending?.hidden !== undefined) return pending.hidden
        return getConversationLiveInboxState(conversation, liveSessionInboxState).surfaceHidden
    }, [liveSessionInboxState])

    const send = useCallback((conversation: ActiveConversation, prefs: { muted?: boolean; hidden?: boolean }) => {
        const daemonId = getConversationMachineId(conversation)
        const sessionId = conversation.sessionId
        if (!daemonId || !sessionId) return
        // MESH-WORKER-PREFS Fix (1)+(2): for a REMOTE mesh worker session the dashboard holds no
        // direct channel to `daemonId` (the worker), so the command must relay through the session's
        // coordinator. The coordinator stamps its own id onto the mirrored session settings
        // (meshCoordinatorDaemonId), so pass it as a routing hint. web-cloud's sendDaemonCommand
        // relays to THAT coordinator (identity-verified) even when several command-channel daemons
        // are connected — instead of refusing unless exactly one exists. Absent for local sessions.
        const coordinatorDaemonId = typeof conversation.settings?.meshCoordinatorDaemonId === 'string'
            ? conversation.settings.meshCoordinatorDaemonId
            : undefined
        setPending(sessionId, prefs)
        void sendDaemonCommand(daemonId, 'set_conversation_prefs', {
            sessionId,
            ...prefs,
            ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
        })
            .then((result) => {
                // A daemon-level failure (remote worker success:false / unforwardable session) or a
                // failed coordinator mirror refresh (mirrorStale) resolves rather than rejects —
                // treat it as not-confirmed so the optimistic overlay doesn't stick on a state the
                // daemon never adopted. evaluateConversationPrefsResult unwraps the cloud
                // double-envelope (Fix 3) and honors mirrorStale (Fix 4).
                const verdict = evaluateConversationPrefsResult(result)
                if (!verdict.confirmed) {
                    console.warn('[conversation-prefs] set_conversation_prefs not confirmed', verdict.reason)
                    pendingRef.current.delete(sessionId)
                    rerender()
                    onError?.(`Couldn't update conversation — ${verdict.reason}`)
                }
            })
            .catch((error) => {
                console.warn('[conversation-prefs] set_conversation_prefs failed', error)
                // Roll the optimistic entry back on failure so the UI snaps to the
                // real (unchanged) daemon state instead of lying.
                pendingRef.current.delete(sessionId)
                rerender()
                const reason = error instanceof Error ? error.message : String(error ?? 'the daemon is unreachable')
                onError?.(`Couldn't update conversation — ${reason}`)
            })
    }, [sendDaemonCommand, setPending, rerender, onError])

    const toggleMute = useCallback((conversation: ActiveConversation) => {
        send(conversation, { muted: !isMuted(conversation) })
    }, [send, isMuted])

    const setHidden = useCallback((conversation: ActiveConversation, hidden: boolean) => {
        send(conversation, { hidden })
    }, [send])

    const toggleHidden = useCallback((conversation: ActiveConversation) => {
        send(conversation, { hidden: !isHidden(conversation) })
    }, [send, isHidden])

    return { isMuted, isHidden, toggleMute, setHidden, toggleHidden }
}
