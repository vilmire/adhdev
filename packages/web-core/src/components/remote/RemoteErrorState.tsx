import { useTranslation } from 'react-i18next'
import { IconWarning, IconRefresh } from '../Icons'

interface RemoteErrorStateProps {
    connState: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed'
    onRetry?: () => void
}

/**
 * G7-1: failed/disconnected must surface as an explicit error, not sit in
 * "Reconnecting..." forever. This is the only place that renders once the
 * 15s escalation timer (or an outright 'failed' state) fires in RemoteView.
 */
export default function RemoteErrorState({ connState, onRetry }: RemoteErrorStateProps) {
    const { t } = useTranslation('common')
    const reasonKey = connState === 'failed'
        ? 'remote.error.reasonFailed'
        : 'remote.error.reasonDisconnected'

    return (
        <div
            data-testid="remote-error-state"
            className="text-center flex flex-col items-center gap-3 px-6"
        >
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center border border-red-500/25 bg-red-500/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
                <IconWarning size={22} className="text-red-400" />
            </div>
            <div className="text-white/90 text-[13px] leading-[1.45] font-semibold tracking-wide">{t('remote.error.title')}</div>
            <div className="text-2xs text-white/50 max-w-[260px]">{t(reasonKey)}</div>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 h-8 px-3.5 rounded-lg flex items-center gap-1.5 bg-white/[0.08] border border-white/15 text-white/90 text-2xs font-bold hover:bg-white/[0.14] transition-colors"
                >
                    <IconRefresh size={13} />
                    {t('remote.error.retry')}
                </button>
            )}
        </div>
    )
}
