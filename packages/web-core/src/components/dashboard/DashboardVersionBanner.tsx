import type { DaemonData } from '../../types'
import { IconRefresh } from '../Icons'
import { getMachineDisplayName } from '../../utils/daemon-utils'

interface DashboardVersionBannerProps {
    daemons: DaemonData[]
    upgradingDaemons: Record<string, 'upgrading' | 'done' | 'error'>
    onUpgrade: (daemonId: string) => void
    onDismiss: () => void
}

export default function DashboardVersionBanner({
    daemons,
    upgradingDaemons,
    onUpgrade,
    onDismiss,
}: DashboardVersionBannerProps) {
    if (daemons.length === 0) return null

    const latest = daemons[0] as any

    return (
        <div
            className="flex items-center gap-2.5 px-4 py-2 border-b text-xs text-text-secondary shrink-0 flex-wrap"
            style={{ background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--status-warning) 20%, transparent)' }}
        >
            <span className="text-sm shrink-0 mt-0.5" style={{ color: 'var(--status-warning)' }}><IconRefresh size={14} /></span>
            <span className="flex-1 flex items-center gap-2 flex-wrap min-w-0">
                <span>
                    Update available: <strong>v{latest.version}</strong> → <strong>v{latest.serverVersion}</strong>
                </span>
                {daemons.map((daemon: any) => {
                    const name = getMachineDisplayName(daemon, { fallbackId: daemon.id })
                    const state = upgradingDaemons[daemon.id]

                    return (
                        <span
                            key={daemon.id}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md"
                            style={{ background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--status-warning) 15%, transparent)' }}
                        >
                            <span className="font-medium text-text-primary">{name}</span>
                            <span className="text-[10px] text-text-muted">v{daemon.version}</span>
                            {state === 'upgrading' ? (
                                <span className="text-[10px] animate-pulse" style={{ color: 'var(--status-warning)' }}>upgrading…</span>
                            ) : state === 'done' ? (
                                <span className="text-[10px] text-green-400">✓ restarting</span>
                            ) : state === 'error' ? (
                                <button
                                    className="text-[10px] text-red-400 hover:text-red-300 underline cursor-pointer"
                                    onClick={() => onUpgrade(daemon.id)}
                                >retry</button>
                            ) : (
                                <button
                                    className="text-[10px] font-semibold cursor-pointer px-1.5 py-px rounded transition-colors"
                                    style={{
                                        color: 'var(--status-warning)',
                                        background: 'color-mix(in srgb, var(--status-warning) 10%, transparent)',
                                        border: '1px solid color-mix(in srgb, var(--status-warning) 20%, transparent)',
                                    }}
                                    onClick={() => onUpgrade(daemon.id)}
                                >Upgrade</button>
                            )}
                        </span>
                    )
                })}
            </span>
            <button
                className="text-text-muted hover:text-text-primary transition-colors text-sm px-1 shrink-0"
                onClick={onDismiss}
                title="Dismiss"
            >✕</button>
        </div>
    )
}
