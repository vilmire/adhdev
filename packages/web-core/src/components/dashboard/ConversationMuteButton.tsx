/**
 * ConversationMuteButton — mute/unmute toggle for the open conversation, shown in
 * the chat header next to the Session info (ⓘ) action.
 *
 * Mute is daemon-owned: the `muted` flag rides the status snapshot (see daemon
 * status/builders). This button sends `set_conversation_prefs` to the owning
 * daemon and reflects the click instantly with a local optimistic override,
 * clearing it once the authoritative `muted` prop catches up (or after a timeout
 * so a lost command can't wedge the icon).
 */
import { useEffect, useRef, useState } from 'react'
import { IconBell, IconBellOff } from '../Icons'

interface Props {
    sessionId: string | undefined
    daemonId: string | undefined
    /** Authoritative muted flag from the daemon status snapshot. */
    muted: boolean
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
}

const PENDING_TTL_MS = 8000

export default function ConversationMuteButton({ sessionId, daemonId, muted, sendDaemonCommand }: Props) {
    // Optimistic override: the value we just requested, held until the daemon
    // snapshot confirms it (muted === pending) or the request times out.
    const [pending, setPending] = useState<boolean | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Clear the override once the authoritative value catches up.
    useEffect(() => {
        if (pending !== null && muted === pending) setPending(null)
    }, [muted, pending])

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

    if (!sessionId || !daemonId) return null

    const effectiveMuted = pending !== null ? pending : muted

    const onClick = () => {
        const next = !effectiveMuted
        setPending(next)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setPending(null), PENDING_TTL_MS)
        void sendDaemonCommand(daemonId, 'set_conversation_prefs', { sessionId, muted: next })
            .catch((error) => {
                console.warn('[conversation-prefs] toggle mute failed', error)
                setPending(null)
            })
    }

    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={effectiveMuted ? 'Unmute this chat' : 'Mute this chat'}
            aria-pressed={effectiveMuted}
            title={effectiveMuted ? 'Muted — notifications silenced. Click to unmute.' : 'Mute notifications for this chat'}
            className={`inline-flex items-center justify-center w-6 h-6 rounded-full leading-none transition-colors ${
                effectiveMuted
                    ? 'bg-amber-500 text-white hover:bg-amber-600'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-secondary'
            }`}
            /* Parent activity-toggle-bar disables pointer events so the floating
               overlay doesn't steal chat-body clicks; re-enable on the button. */
            style={{ pointerEvents: 'auto' }}
        >
            {effectiveMuted ? <IconBellOff size={13} /> : <IconBell size={13} />}
        </button>
    )
}
