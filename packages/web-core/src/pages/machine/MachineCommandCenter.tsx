import type { ReactNode } from 'react'

import type { DaemonData } from '../../types'
import type { MachineRecentLaunch, ProviderInfo } from './types'

interface MachineCommandCenterProps {
    machineEntry: DaemonData
    providers: ProviderInfo[]
    recentLaunches: MachineRecentLaunch[]
    onUpgradeDaemon: () => void
    onOpenRecent: (launch: MachineRecentLaunch) => void
}

function SectionTitle({ children }: { children: ReactNode }) {
    return <div className="text-xs font-semibold text-text-muted mb-2 tracking-wide uppercase">{children}</div>
}

export default function MachineCommandCenter({
    machineEntry,
    providers: _providers,
    recentLaunches,
    onUpgradeDaemon,
    onOpenRecent,
}: MachineCommandCenterProps) {
    const topRecentLaunches = recentLaunches.slice(0, 4)

    const formatKindLabel = (kind: MachineRecentLaunch['kind']) => {
        if (kind === 'ide') return 'IDE'
        if (kind === 'cli') return 'CLI'
        return 'ACP'
    }

    return (
        <div className="flex flex-col gap-6 md:min-w-[280px] md:max-w-[340px] shrink-0 border-r border-[#ffffff0a] pr-4 md:pr-6 md:h-full overflow-y-auto">
            {topRecentLaunches.length > 0 && (
                <div className="flex flex-col gap-2">
                    <SectionTitle>Recent Activity</SectionTitle>
                    <div className="flex flex-col gap-1.5">
                        {topRecentLaunches.map(launch => (
                            <button
                                key={launch.id}
                                type="button"
                                className="flex flex-col gap-1 items-start text-left p-3 rounded-xl bg-bg-surface border border-[#ffffff08] hover:bg-[#ffffff0a] hover:border-[#ffffff10] transition-colors cursor-pointer group"
                                onClick={() => onOpenRecent(launch)}
                            >
                                <span className="text-sm font-semibold text-text-primary truncate w-full group-hover:text-accent-primary transition-colors">
                                    {launch.label}
                                </span>
                                <span className="text-xs text-text-secondary truncate w-full opacity-80">
                                    {formatKindLabel(launch.kind)}
                                    {launch.subtitle ? ` · ${launch.subtitle}` : ''}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-2 mt-auto pt-4 border-t border-[#ffffff08]">
                {(machineEntry as any).versionMismatch && (
                    <button
                        type="button"
                        className="btn btn-sm w-full bg-accent-primary/20 text-accent-primary border-accent-primary/30 hover:bg-accent-primary/30"
                        onClick={onUpgradeDaemon}
                    >
                        Update Daemon
                    </button>
                )}
            </div>
        </div>
    )
}
