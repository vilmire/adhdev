import type { ReactNode } from 'react'

import type { DaemonData } from '../../types'
import type { MachineRecentSession, ProviderInfo, TabId, WorkspaceLaunchKind } from './types'

interface MachineCommandCenterProps {
    machineEntry: DaemonData
    providers: ProviderInfo[]
    recentSessions: MachineRecentSession[]
    onUpgradeDaemon: () => void
    onOpenLogs: () => void
    onOpenRecent: (session: MachineRecentSession) => void
    onOpenWorkspace: (kind: WorkspaceLaunchKind) => void
    onGoTab: (tab: Extract<TabId, 'providers' | 'overview' | 'logs'>) => void
}

function SectionTitle({ children }: { children: ReactNode }) {
    return <div className="machine-command-section-title">{children}</div>
}

export default function MachineCommandCenter({
    machineEntry,
    providers,
    recentSessions,
    onUpgradeDaemon,
    onOpenLogs,
    onOpenRecent,
    onOpenWorkspace,
    onGoTab,
}: MachineCommandCenterProps) {
    const detectedIdes = machineEntry.detectedIdes || []
    const cliProviders = providers.filter(provider => provider.category === 'cli')
    const acpProviders = providers.filter(provider => provider.category === 'acp')
    const topRecentSessions = recentSessions.slice(0, 4)
    const startTargets = [
        detectedIdes.length > 0 ? { id: 'ide', kind: 'ide' as const, label: 'IDE' } : null,
        cliProviders.length > 0 ? { id: 'cli', kind: 'cli' as const, label: 'CLI' } : null,
        acpProviders.length > 0 ? { id: 'acp', kind: 'acp' as const, label: 'ACP' } : null,
    ].filter(Boolean) as Array<{ id: string; kind: WorkspaceLaunchKind; label: string }>

    const formatKindLabel = (kind: MachineRecentSession['kind']) => {
        if (kind === 'ide') return 'IDE'
        if (kind === 'cli') return 'CLI'
        return 'ACP'
    }

    return (
        <div className="machine-command-center">
            {topRecentSessions.length > 0 && (
                <>
                    <SectionTitle>Recent</SectionTitle>
                    <div className="machine-command-links">
                        {topRecentSessions.map(session => (
                            <button key={session.id} type="button" className="machine-command-link" onClick={() => onOpenRecent(session)}>
                                <span className="machine-command-link-title">{session.label}</span>
                                <span className="machine-command-link-meta">
                                    {formatKindLabel(session.kind)}
                                    {session.subtitle ? ` · ${session.subtitle}` : ''}
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}

            {startTargets.length > 0 && (
                <>
                    <SectionTitle>Start</SectionTitle>
                    <div className="machine-command-launch-grid">
                        {startTargets.map(target => (
                            <button
                                key={target.id}
                                type="button"
                                className="machine-command-launch-btn"
                                onClick={() => onOpenWorkspace(target.kind)}
                            >
                                <span className="machine-command-launch-title">{target.label}</span>
                                <span className="machine-command-launch-meta">Choose workspace and provider</span>
                            </button>
                        ))}
                    </div>
                </>
            )}

            <div className="machine-command-secondary">
                {(machineEntry as any).versionMismatch && (
                    <button
                        type="button"
                        className="machine-command-secondary-link machine-command-secondary-link-accent"
                        onClick={onUpgradeDaemon}
                    >
                        Update daemon
                    </button>
                )}
                <button type="button" className="machine-command-secondary-link" onClick={onOpenLogs}>
                    Logs
                </button>
                <button type="button" className="machine-command-secondary-link" onClick={() => onGoTab('providers')}>
                    Providers
                </button>
                <button type="button" className="machine-command-secondary-link" onClick={() => onGoTab('overview')}>
                    System
                </button>
            </div>
        </div>
    )
}
