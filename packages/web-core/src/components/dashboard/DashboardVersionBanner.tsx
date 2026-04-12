import type { DaemonData } from '../../types'
import { IconRefresh, IconX } from '../Icons'
import { getMachineDisplayName } from '../../utils/daemon-utils'

interface DashboardVersionBannerProps {
    daemons: DaemonData[]
    targetVersion?: string | null
    required?: boolean
    upgradingDaemons: Record<string, 'upgrading' | 'done' | 'error'>
    onUpgrade: (daemonId: string) => void
    onDismiss: () => void
}

export default function DashboardVersionBanner({
    daemons,
    targetVersion,
    required = false,
    upgradingDaemons,
    onUpgrade,
    onDismiss,
}: DashboardVersionBannerProps) {
    if (daemons.length === 0) return null

    return (
        <div
            className="flex items-center gap-2.5 px-4 py-2 border-b text-xs text-text-secondary shrink-0 flex-wrap"
            style={{
                background: required
                    ? 'color-mix(in srgb, var(--status-danger) 10%, transparent)'
                    : 'color-mix(in srgb, var(--status-warning) 8%, transparent)',
                borderColor: required
                    ? 'color-mix(in srgb, var(--status-danger) 24%, transparent)'
                    : 'color-mix(in srgb, var(--status-warning) 20%, transparent)',
            }}
        >
            <span className="text-sm shrink-0 mt-0.5" style={{ color: required ? 'var(--status-danger)' : 'var(--status-warning)' }}><IconRefresh size={14} /></span>
            <span className="flex-1 flex items-center gap-2 flex-wrap min-w-0">
                <span>
                    {required ? 'Daemon update required' : 'Update available'}
                    {targetVersion ? <>: <strong>v{targetVersion}</strong></> : null}
                </span>
                {daemons.map((daemon: any) => {
                    const name = getMachineDisplayName(daemon, { fallbackId: daemon.id })
                    const state = upgradingDaemons[daemon.id]
                    const currentVersion = daemon.version || daemon.daemonVersion || 'unknown'
                    const isRequired = daemon.versionUpdateRequired === true

                    return (
                        <span
                            key={daemon.id}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md"
                            style={{
                                background: isRequired
                                    ? 'color-mix(in srgb, var(--status-danger) 10%, transparent)'
                                    : 'color-mix(in srgb, var(--status-warning) 8%, transparent)',
                                border: `1px solid ${isRequired
                                    ? 'color-mix(in srgb, var(--status-danger) 20%, transparent)'
                                    : 'color-mix(in srgb, var(--status-warning) 15%, transparent)'}`,
                            }}
                        >
                            <span className="font-medium text-text-primary">{name}</span>
                            <span className="text-[10px] text-text-muted">v{currentVersion}</span>
                            {isRequired && (
                                <span className="text-[10px]" style={{ color: 'var(--status-danger)' }}>required</span>
                            )}
                            {state === 'upgrading' ? (
                                <span className="text-[10px] animate-pulse" style={{ color: isRequired ? 'var(--status-danger)' : 'var(--status-warning)' }}>upgrading…</span>
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
                                        color: isRequired ? 'var(--status-danger)' : 'var(--status-warning)',
                                        background: isRequired
                                            ? 'color-mix(in srgb, var(--status-danger) 10%, transparent)'
                                            : 'color-mix(in srgb, var(--status-warning) 10%, transparent)',
                                        border: `1px solid ${isRequired
                                            ? 'color-mix(in srgb, var(--status-danger) 20%, transparent)'
                                            : 'color-mix(in srgb, var(--status-warning) 20%, transparent)'}`,
                                    }}
                                    onClick={() => onUpgrade(daemon.id)}
                                >{isRequired ? 'Update now' : 'Upgrade'}</button>
                            )}
                        </span>
                    )
                })}
            </span>
            {!required && (
                <button
                    className="text-text-muted hover:text-text-primary transition-colors shrink-0"
                    onClick={onDismiss}
                    title="Dismiss"
                ><IconX size={16} /></button>
            )}
        </div>
    )
}
