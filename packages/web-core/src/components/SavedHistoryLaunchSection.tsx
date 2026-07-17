import { useTranslation } from 'react-i18next'
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

function buildSavedHistoryRefreshStatus({
  savedSessionsLoading,
  savedSessionsLoaded,
  savedSessionsCount = 0,
}: Pick<SavedHistoryLaunchSectionProps, 'savedSessionsLoading' | 'savedSessionsLoaded' | 'savedSessionsCount'>): string {
  if (savedSessionsLoading) {
    return 'Refreshing saved history…'
  }
  if (!savedSessionsLoaded) {
    return 'Start fresh, or open saved history when you want continuity.'
  }
  if (savedSessionsCount > 0) {
    const noun = savedSessionsCount === 1 ? 'history' : 'histories'
    return `${savedSessionsCount} saved ${noun} loaded. Open saved history to choose one.`
  }
  return 'No saved history found yet. New Hermes CLI conversations will appear here after ADHDev captures provider history.'
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
  const summary = selectedSession ? buildSavedHistorySummaryView(selectedSession) : null
  const refreshStatus = buildSavedHistoryRefreshStatus({
    savedSessionsLoading,
    savedSessionsLoaded,
    savedSessionsCount,
  })

  return (
    <LaunchSectionCard
      title="Saved history"
      description={getSavedHistoryHelperLabel(t)}
      action={(
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || savedSessionsLoading}
            onClick={onRefresh}
          >
            {savedSessionsLoading ? 'Loading…' : 'Refresh'}
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
        <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2.5 text-[11px] text-text-muted leading-relaxed">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Selected saved history</div>
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
              Clear
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-text-muted" aria-live="polite">
          {refreshStatus}
        </div>
      )}

      {savedSessionsError && (
        <div className="mt-2 text-[11px] text-status-error">{savedSessionsError}</div>
      )}
    </LaunchSectionCard>
  )
}
