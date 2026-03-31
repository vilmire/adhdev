import InstallCommand from '../InstallCommand'
import { IconRocket } from '../Icons'

interface PaneGroupEmptyStateProps {
    conversationsCount: number
    isSplitMode: boolean
    isStandalone: boolean
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
}

export default function PaneGroupEmptyState({
    conversationsCount,
    isSplitMode,
    isStandalone,
    detectedIdes,
    handleLaunchIde,
}: PaneGroupEmptyStateProps) {
    if (conversationsCount === 0 && !isSplitMode && detectedIdes && handleLaunchIde) {
        return (
            <div className="empty-dashboard flex-1 flex flex-col items-center justify-center -mt-8">
                <div className="glow-orb mb-6 opacity-90 animate-bounce" style={{ animationDuration: '3s' }}>
                    <img src="/otter-logo.png" alt="ADHDev" className="w-16 h-16 object-contain" />
                </div>
                <div className="text-center max-w-lg">
                    <h2 className="font-bold text-2xl mb-2.5 tracking-tight text-text-primary">
                        Waiting for your IDE
                    </h2>
                    <p className="text-[14px] text-text-secondary mb-8 leading-relaxed max-w-md mx-auto">
                        {isStandalone
                            ? 'Launch any supported IDE or CLI agent to start monitoring automatically.'
                            : 'Install the ADHDev daemon and link your dashboard to start.'}
                    </p>
                    {!isStandalone && (
                        <InstallCommand />
                    )}
                    {isStandalone && detectedIdes.length > 0 && (
                        <div className="flex flex-col gap-3 items-center">
                            <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">Fast Launch</div>
                            <div className="flex flex-wrap gap-2.5 justify-center mt-1">
                                {detectedIdes.map(ide => (
                                    <button
                                        key={ide.type}
                                        className="btn btn-sm bg-accent/10 border border-accent/25 text-accent text-xs font-medium px-4 py-2.5 rounded-lg cursor-pointer flex items-center gap-2 transition-all hover:bg-accent/20 hover:scale-105 active:scale-95"
                                        onClick={() => handleLaunchIde(ide.type)}
                                    >
                                        <IconRocket size={14} className="opacity-70" /> Launch {ide.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {!isStandalone && (
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
