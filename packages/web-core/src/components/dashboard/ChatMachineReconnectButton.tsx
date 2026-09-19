/**
 * ChatMachineReconnectButton — inline manual reconnect for the machine that owns
 * the open chat, rendered in the chat header next to the bell / Session info (ⓘ).
 *
 * WHY THIS EXISTS (owner request): P2PManager parks a daemon after exhausting its
 * auto-reconnect budget (`blockAutoReconnect` → `connectionRetryStatuses[id].blocked`,
 * see web-cloud p2p-manager.ts). Recovery from that parked state is manual, and until
 * now the only controls were on the Machines list and the Machine detail page — so a
 * user reading a chat had to navigate away to get their machine back.
 *
 * WHY IT IS GATED ON `blocked` RATHER THAN ALWAYS VISIBLE: while auto-reconnect is
 * still running, a manual retry is at best redundant and at worst resets a backoff
 * that is about to succeed. The button is only an answer to the parked state, so it
 * renders nothing otherwise and the header keeps its usual three controls. This also
 * makes it inert on standalone, which has no P2P layer and therefore never populates
 * `connectionRetryStatuses` at all (its `retryConnection` is a no-op) — no platform
 * branch needed.
 *
 * It calls the SAME `retryConnection(machineId)` contract the Machines page uses
 * (BaseDaemonContextValue.retryConnection → p2pManager.retryConnect on cloud). No new
 * endpoint, no second reconnect state machine.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconPlug } from '../Icons'
import LoadingSpinner from '../ui/LoadingSpinner'

interface Props {
    /** Machine-level daemon id owning the open conversation. */
    machineId: string | undefined
    /** True when auto-reconnect has parked this machine and only a manual retry recovers it. */
    blocked: boolean
    /** Shared reconnect contract; absent on hosts that do not implement one. */
    retryConnection?: (machineId: string) => void
}

/**
 * Click lock duration. `retryConnection` returns void and the authoritative
 * release signal is `blocked` flipping false (the manager clears the parked
 * status synchronously inside `retryConnect`). This timeout is only the safety
 * net for the path where a retry neither clears the status nor re-parks, which
 * would otherwise leave the control disabled forever.
 */
const RETRY_LOCK_TIMEOUT_MS = 10000

export default function ChatMachineReconnectButton({ machineId, blocked, retryConnection }: Props) {
    const { t } = useTranslation('common')
    const [pending, setPending] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // The parked status clearing is the real "retry accepted" signal — release the
    // lock on it rather than guessing a duration.
    useEffect(() => {
        if (!blocked) setPending(false)
    }, [blocked])

    useEffect(() => {
        if (!pending) return
        const timer = setTimeout(() => setPending(false), RETRY_LOCK_TIMEOUT_MS)
        return () => clearTimeout(timer)
    }, [pending])

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

    if (!machineId || !blocked || !retryConnection) return null

    const onClick = () => {
        // Guard the double-tap: a parked machine invites impatient tapping, and each
        // call tears down and re-creates the peer connection.
        if (pending) return
        setPending(true)
        retryConnection(machineId)
    }

    return (
        <button
            type="button"
            data-testid="chat-machine-reconnect"
            onClick={onClick}
            disabled={pending}
            aria-label={t('chatPane.reconnectMachine')}
            title={t('chatPane.reconnectMachineTitle')}
            className="inline-flex items-center justify-center gap-1 h-6 px-2 rounded-full leading-none text-3xs font-bold transition-colors bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 disabled:opacity-60 disabled:cursor-not-allowed"
            /* Parent activity-toggle-bar disables pointer events so the floating
               overlay doesn't steal chat-body clicks; re-enable on the button. */
            style={{ pointerEvents: 'auto' }}
        >
            {pending ? <LoadingSpinner size={11} thickness={2} color="muted" /> : <IconPlug size={12} />}
            <span>{pending ? t('chatPane.reconnectingMachine') : t('chatPane.reconnectMachine')}</span>
        </button>
    )
}
