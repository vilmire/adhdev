import InstallCommand from '../InstallCommand'

interface PaneGroupEmptyStateProps {
    conversationsCount: number
    isSplitMode: boolean
    isStandalone: boolean
    hasRegisteredMachines?: boolean
    suppressGuide?: boolean
}

export default function PaneGroupEmptyState({
    conversationsCount,
    isSplitMode,
    isStandalone,
    hasRegisteredMachines = false,
    suppressGuide = false,
}: PaneGroupEmptyStateProps) {
    if (suppressGuide) {
        return <div className="text-sm text-text-muted opacity-0 select-none" aria-hidden="true">No active agent</div>
    }

    const shouldShowInstallCta = !isStandalone && !hasRegisteredMachines
    const title = isStandalone
        ? 'Waiting for your daemon'
        : hasRegisteredMachines
            ? 'No conversations yet'
            : 'Connect your machines'
    const description = isStandalone
        ? 'Start the ADHDev daemon to connect this dashboard. Once it is online, you can open an IDE or launch CLI and ACP sessions.'
        : hasRegisteredMachines
            ? 'Your machines are connected. Open a machine, choose a workspace, then launch an IDE, CLI, or ACP session.'
            : 'Install ADHDev on a machine, sign in, and it will show up here.'

    if (conversationsCount === 0 && !isSplitMode) {
        return (
            <div className="empty-dashboard flex-1 flex flex-col items-center justify-center -mt-8">
                <div className="glow-orb mb-6 opacity-90 animate-bounce" style={{ animationDuration: '3s' }}>
                    <img src="/otter-logo.png" alt="ADHDev" className="w-16 h-16 object-contain" />
                </div>
                <div className="text-center max-w-lg">
                    <h2 className="font-bold text-2xl mb-2.5 tracking-tight text-text-primary">
                        {title}
                    </h2>
                    <p className="text-[14px] text-text-secondary mb-8 leading-relaxed max-w-md mx-auto">
                        {description}
                    </p>
                    {shouldShowInstallCta && (
                        <InstallCommand />
                    )}
                    {shouldShowInstallCta && (
                        <div className="mt-8">
                            <a
                                href="https://docs.adhf.dev"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm font-medium text-accent hover:opacity-80 transition-colors flex items-center justify-center gap-1.5"
                            >
                                📚 Read the documentation →
                            </a>
                        </div>
                    )}
                </div>
            </div>
        )
    }

    return (
        <div className="text-sm text-text-muted opacity-50">
            {isSplitMode ? 'Move a tab here to view' : 'No active agent'}
        </div>
    )
}
