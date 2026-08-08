import { IconPlus } from '../Icons'
import InstallCommand from '../InstallCommand'
import { useTranslation } from 'react-i18next'

interface PaneGroupEmptyStateProps {
    conversationsCount: number
    isSplitMode: boolean
    isStandalone: boolean
    hasRegisteredMachines?: boolean
    suppressGuide?: boolean
    onOpenNewSession?: () => void
    /**
     * True while the conversation list is still in flight. Until it clears,
     * "zero conversations" is indistinguishable from "not loaded yet", so the
     * empty state would otherwise assert "No conversations yet" (or, worse, the
     * install CTA) against data that has not arrived. Defaults to false so call
     * sites that do not track load state keep their current behaviour.
     *
     * Callers should derive this via `areConversationsLoaded(ides, initialDataLoaded)`
     * rather than from `initialDataLoaded` alone: the latter only tracks the daemon
     * discovery snapshot, while conversations arrive later over P2P.
     */
    isLoading?: boolean
}

export default function PaneGroupEmptyState({
    conversationsCount,
    isSplitMode,
    isStandalone,
    hasRegisteredMachines = false,
    suppressGuide = false,
    onOpenNewSession,
    isLoading = false,
}: PaneGroupEmptyStateProps) {
    const { t } = useTranslation('common')
    if (suppressGuide) {
        return <div className="text-sm text-text-muted opacity-0 select-none" aria-hidden="true">No active agent</div>
    }

    if (isLoading) {
        return (
            <div className="empty-dashboard flex-1 flex flex-col items-center justify-center gap-3 -mt-8 text-text-muted">
                <div
                    className="w-7 h-7 rounded-full animate-spin border-[2.5px] border-accent-primary/20 border-t-accent-primary-light"
                    aria-hidden="true"
                />
                <p className="text-sm">{t('paneGroup.loadingSessions')}</p>
            </div>
        )
    }

    const shouldShowInstallCta = !isStandalone && !hasRegisteredMachines
    const canStartSession = hasRegisteredMachines && !!onOpenNewSession
    const title = hasRegisteredMachines
        ? t('paneGroup.noConversations')
        : isStandalone
            ? t('paneGroup.waitingForDaemon')
            : t('paneGroup.connectYourMachines')
    const description = hasRegisteredMachines
        ? t('paneGroup.newSessionDescription')
        : isStandalone
            ? t('paneGroup.daemonDescription')
            : t('paneGroup.installDescription')

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
                    {canStartSession && (
                        <div className="flex items-center justify-center mb-4">
                            <button
                                type="button"
                                onClick={onOpenNewSession}
                                className="btn btn-secondary btn-sm inline-flex items-center gap-2"
                                title={t('paneGroup.newSession')}
                                aria-label={t('paneGroup.newSession')}
                            >
                                <IconPlus size={14} />
                                <span>{t('paneGroup.newSession')}</span>
                            </button>
                        </div>
                    )}
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
