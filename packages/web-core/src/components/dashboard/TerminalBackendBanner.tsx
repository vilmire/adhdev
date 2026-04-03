import type { TerminalBackendStatus } from '../../types'

interface TerminalBackendBannerProps {
    terminalBackend?: TerminalBackendStatus | null
    isStandalone?: boolean
}

export default function TerminalBackendBanner({
    terminalBackend,
    isStandalone = false,
}: TerminalBackendBannerProps) {
    if (!isStandalone) return null
    if (!terminalBackend) return null
    if (terminalBackend.backend !== 'xterm') return null

    return (
        <div
            className="py-2.5 px-5 text-[13px] font-semibold flex items-center gap-2.5 justify-center"
            style={{
                background: 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))',
                borderBottom: '1px solid rgba(245,158,11,0.2)',
                color: '#d97706',
            }}
        >
            <span>Terminal is using `xterm` fallback.</span>
            <span style={{ opacity: 0.8 }}>
                ghostty-vt is unavailable on this machine, so terminal rendering may be less accurate.
            </span>
        </div>
    )
}
