/**
 * useConversationMute — mute/unmute state for one conversation, used by the
 * conversation "…" actions menu (ConversationActionsMenu).
 *
 * Mute is daemon-owned: the `muted` flag rides the status snapshot (see daemon
 * status/builders). Toggling sends `set_conversation_prefs` to the owning
 * daemon and reflects the click instantly with a local optimistic override,
 * clearing it once the authoritative `muted` prop catches up (or after a timeout
 * so a lost command can't wedge the state).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface Options {
    sessionId: string | undefined
    daemonId: string | undefined
    /** Authoritative muted flag from the daemon status snapshot. */
    muted: boolean
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
}

const PENDING_TTL_MS = 8000

export function useConversationMute({ sessionId, daemonId, muted, sendDaemonCommand }: Options) {
    // Optimistic override: the value we just requested, held until the daemon
    // snapshot confirms it (muted === pending) or the request times out.
    const [pending, setPending] = useState<boolean | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Clear the override once the authoritative value catches up.
    useEffect(() => {
        if (pending !== null && muted === pending) setPending(null)
    }, [muted, pending])

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

    const effectiveMuted = pending !== null ? pending : muted
    const available = !!sessionId && !!daemonId

    const toggle = useCallback(() => {
        if (!sessionId || !daemonId) return
        const next = !effectiveMuted
        setPending(next)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setPending(null), PENDING_TTL_MS)
        void sendDaemonCommand(daemonId, 'set_conversation_prefs', { sessionId, muted: next })
            .catch((error) => {
                console.warn('[conversation-prefs] toggle mute failed', error)
                setPending(null)
            })
    }, [daemonId, effectiveMuted, sendDaemonCommand, sessionId])

    return { available, muted: effectiveMuted, toggle }
}
