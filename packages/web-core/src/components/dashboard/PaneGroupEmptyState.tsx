import InstallCommand from '../InstallCommand'
import { IconRocket } from '../Icons'

interface PaneGroupEmptyStateProps {
    conversationsCount: number
    isSplitMode: boolean
    isStandalone: boolean
    hasRegisteredMachines?: boolean
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
}

export default function PaneGroupEmptyState({
    conversationsCount,
    isSplitMode,
    isStandalone,
    hasRegisteredMachines = false,
    detectedIdes,
    handleLaunchIde,
}: PaneGroupEmptyStateProps) {
    const shouldShowInstallCta = !isStandalone && !hasRegisteredMachines
    const title = isStandalone
        ? 'Waiting for your daemon'
        : hasRegisteredMachines
            ? 'No conversations yet'
            : 'Connect your first machine'
    const description = isStandalone
        ? 'Start the ADHDev daemon to connect this dashboard. Once it is online, you can open an IDE or launch CLI and ACP sessions.'
        : hasRegisteredMachines
            ? 'Your machines are connected. Open a machine, choose a workspace, then launch an IDE, CLI, or ACP session.'
            : 'Install the ADHDev daemon and link your dashboard to start.'

    if (conversationsCount === 0 && !isSplitMode && detectedIdes && handleLaunchIde) {
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
                    {isStandalone && detectedIdes.length > 0 && (
                        <div className="flex flex-col gap-3 items-center">
                            <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">Detected IDEs</div>
                            <div className="flex flex-wrap gap-2.5 justify-center mt-1">
                                {detectedIdes.map(ide => (
                                    <button
                                        key={ide.type}
                                        className="btn btn-sm bg-accent/10 border border-accent/25 text-accent text-xs font-medium px-4 py-2.5 rounded-lg cursor-pointer flex items-center gap-2 transition-all hover:bg-accent/20 hover:scale-105 active:scale-95"
                                        onClick={() => handleLaunchIde(ide.type)}
                                    >
                                        <IconRocket size={14} className="opacity-70" /> Open {ide.name}
                                    </button>
                                ))}
                            </div>
                        </div>
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
