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
}

export default function PaneGroupEmptyState({
    conversationsCount,
    isSplitMode,
    isStandalone,
    hasRegisteredMachines = false,
    suppressGuide = false,
    onOpenNewSession,
}: PaneGroupEmptyStateProps) {
    const { t } = useTranslation('common')
    if (suppressGuide) {
        return <div className="text-sm text-text-muted opacity-0 select-none" aria-hidden="true">No active agent</div>
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
