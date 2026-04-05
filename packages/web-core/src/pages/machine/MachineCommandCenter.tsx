import type { ReactNode } from 'react'

import type { DaemonData } from '../../types'
import type { MachineRecentLaunch, ProviderInfo, TabId, WorkspaceLaunchKind } from './types'

interface MachineCommandCenterProps {
    machineEntry: DaemonData
    providers: ProviderInfo[]
    recentLaunches: MachineRecentLaunch[]
    onUpgradeDaemon: () => void
    onOpenLogs: () => void
    onOpenRecent: (launch: MachineRecentLaunch) => void
    onOpenWorkspace: (kind: WorkspaceLaunchKind) => void
    onGoTab: (tab: Extract<TabId, 'providers' | 'overview' | 'logs'>) => void
}

function SectionTitle({ children }: { children: ReactNode }) {
    return <div className="text-xs font-semibold text-text-muted mb-2 tracking-wide uppercase">{children}</div>
}

export default function MachineCommandCenter({
    machineEntry,
    providers,
    recentLaunches,
    onUpgradeDaemon,
    onOpenLogs,
    onOpenRecent,
    onOpenWorkspace,
    onGoTab,
}: MachineCommandCenterProps) {
    const detectedIdes = machineEntry.detectedIdes || []
    const cliProviders = providers.filter(provider => provider.category === 'cli')
    const acpProviders = providers.filter(provider => provider.category === 'acp')
    const topRecentLaunches = recentLaunches.slice(0, 4)
    const startTargets = [
        detectedIdes.length > 0 ? { id: 'ide', kind: 'ide' as const, label: 'IDE Workspace', desc: 'Graphical app' } : null,
        cliProviders.length > 0 ? { id: 'cli', kind: 'cli' as const, label: 'CLI Workspace', desc: 'Terminal' } : null,
        acpProviders.length > 0 ? { id: 'acp', kind: 'acp' as const, label: 'ACP Workspace', desc: 'Agent' } : null,
    ].filter(Boolean) as Array<{ id: string; kind: WorkspaceLaunchKind; label: string; desc: string }>

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

            {startTargets.length > 0 && (
                <div className="flex flex-col gap-2">
                    <SectionTitle>New Workspace</SectionTitle>
                    <div className="grid grid-cols-2 gap-2">
                        {startTargets.map(target => (
                            <button
                                key={target.id}
                                type="button"
                                className="flex flex-col items-center justify-center p-3 gap-1 rounded-xl bg-bg-surface border border-[#ffffff08] hover:bg-[#ffffff0e] hover:scale-[1.02] active:scale-95 transition-all cursor-pointer"
                                onClick={() => onOpenWorkspace(target.kind)}
                            >
                                <span className="text-sm font-semibold text-text-primary text-center">
                                    {target.label.replace(' Workspace', '')}
                                </span>
                                <span className="text-[10px] text-text-muted text-center uppercase tracking-wide">
                                    {target.desc}
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
                <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-secondary btn-sm flex-1" onClick={onOpenLogs}>
                        Logs
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm flex-1" onClick={() => onGoTab('providers')}>
                        Providers
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm flex-1" onClick={() => onGoTab('overview')}>
                        System
                    </button>
                </div>
            </div>
        </div>
    )
}
