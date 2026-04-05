import { useEffect, useMemo, useState } from 'react'

import type { TerminalBackendStatus } from '../../types'

interface TerminalBackendBannerProps {
    terminalBackend?: TerminalBackendStatus | null
    isStandalone?: boolean
    machineLabel?: string | null
    machineKey?: string | null
}

export default function TerminalBackendBanner({
    terminalBackend,
    isStandalone = false,
    machineLabel,
    machineKey,
}: TerminalBackendBannerProps) {
    const dismissKey = useMemo(() => {
        if (!machineKey || !terminalBackend) return null
        return `adhdev:terminal-backend-banner:dismissed:${machineKey}:${terminalBackend.backend}`
    }, [machineKey, terminalBackend])
    const [dismissed, setDismissed] = useState(false)

    useEffect(() => {
        if (!dismissKey) {
            setDismissed(false)
            return
        }
        try {
            setDismissed(localStorage.getItem(dismissKey) === '1')
        } catch {
            setDismissed(false)
        }
    }, [dismissKey])

    if (!isStandalone) return null
    if (!terminalBackend) return null
    if (terminalBackend.backend !== 'xterm') return null
    if (dismissed) return null

    const label = machineLabel?.trim() || 'This machine'

    const handleDismiss = () => {
        if (dismissKey) {
            try { localStorage.setItem(dismissKey, '1') } catch { /* noop */ }
        }
        setDismissed(true)
    }

    return (
        <div
            className="py-2.5 px-5 text-[13px] font-semibold flex items-center gap-2.5"
            style={{
                background: 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))',
                borderBottom: '1px solid rgba(245,158,11,0.2)',
                color: '#d97706',
            }}
        >
            <div className="flex-1 min-w-0 flex items-center gap-2.5 justify-center flex-wrap">
                <span>{label} is using `xterm` fallback.</span>
                <span style={{ opacity: 0.8 }}>
                    ghostty-vt is unavailable on this machine, so terminal rendering may be less accurate.
                </span>
            </div>
            <button
                type="button"
                onClick={handleDismiss}
                className="shrink-0 text-[12px] font-semibold px-2 py-1 rounded-md transition-colors"
                style={{
                    color: '#b45309',
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.18)',
                }}
                aria-label="Dismiss terminal backend warning"
                title="Dismiss"
            >
                Dismiss
            </button>
        </div>
    )
}
