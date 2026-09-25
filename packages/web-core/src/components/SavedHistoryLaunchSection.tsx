import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import LaunchSectionCard from './LaunchSectionCard'
import {
  buildSavedHistorySummaryView,
  type SavedHistorySummaryLike,
} from '../utils/saved-history-summary'
import {
  getOpenHistoryLabel,
  getSavedHistoryHelperLabel,
} from '../utils/dashboard-launch-copy'

export type SavedHistoryLaunchSectionSelectedSession = SavedHistorySummaryLike

export interface SavedHistoryLaunchSectionProps {
  busy: boolean
  savedSessionsLoading: boolean
  savedSessionsError: string
  savedSessionsLoaded?: boolean
  savedSessionsCount?: number
  selectedSession: SavedHistoryLaunchSectionSelectedSession | null
  onRefresh: () => void
  onOpenHistory: () => void
  onClearSelection: () => void
}

function buildSavedHistoryRefreshStatus(t: TFunction, {
  savedSessionsLoading,
  savedSessionsLoaded,
  savedSessionsCount = 0,
}: Pick<SavedHistoryLaunchSectionProps, 'savedSessionsLoading' | 'savedSessionsLoaded' | 'savedSessionsCount'>): string {
  if (savedSessionsLoading) {
    return t('launch.refreshingSavedHistory')
  }
  if (!savedSessionsLoaded) {
    return t('launch.savedHistoryIntro')
  }
  if (savedSessionsCount > 0) {
    return t('launch.savedHistoryLoadedCount', { count: savedSessionsCount })
  }
  return t('launch.savedHistoryNoneYet')
}

export default function SavedHistoryLaunchSection({
  busy,
  savedSessionsLoading,
  savedSessionsError,
  savedSessionsLoaded,
  savedSessionsCount = 0,
  selectedSession,
  onRefresh,
  onOpenHistory,
  onClearSelection,
}: SavedHistoryLaunchSectionProps) {
  const { t } = useTranslation('common')
  const summary = selectedSession ? buildSavedHistorySummaryView(selectedSession, t) : null
  const refreshStatus = buildSavedHistoryRefreshStatus(t, {
    savedSessionsLoading,
    savedSessionsLoaded,
    savedSessionsCount,
  })

  return (
    <LaunchSectionCard
      title={t('launch.savedHistoryBadge')}
      description={getSavedHistoryHelperLabel(t)}
      action={(
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || savedSessionsLoading}
            onClick={onRefresh}
          >
            {savedSessionsLoading ? t('launch.loadingShort') : t('launch.refresh')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={onOpenHistory}
          >
            {getOpenHistoryLabel(t)}
          </button>
        </>
      )}
    >
      {summary ? (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2.5 text-2xs text-text-muted leading-relaxed">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-3xs uppercase tracking-[0.08em] text-text-muted">{t('launch.selectedSavedHistory')}</div>
              <div className="mt-1 font-semibold text-text-primary truncate">{summary.title}</div>
              <div className="font-mono break-all mt-0.5">{summary.providerSessionId}</div>
              <div className="mt-1">{summary.metaLine}</div>
              {summary.updatedLabel && (
                <div className="mt-1 text-text-secondary">{summary.updatedLabel}</div>
              )}
              {summary.preview && (
                <div className="mt-2 line-clamp-2 text-text-secondary">{summary.preview}</div>
              )}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm shrink-0"
              onClick={onClearSelection}
              disabled={busy}
            >
              {t('launch.clearSelection')}
            </button>
          </div>
        </div>
      ) : (
        <div className="text-2xs text-text-muted" aria-live="polite">
          {refreshStatus}
        </div>
      )}

      {savedSessionsError && (
        <div className="mt-2 text-2xs text-status-error">{savedSessionsError}</div>
      )}
    </LaunchSectionCard>
  )
}
