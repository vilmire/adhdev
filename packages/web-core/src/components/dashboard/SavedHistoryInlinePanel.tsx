/**
 * SavedHistoryInlinePanel — the saved-history picker rendered INSIDE the New
 * Session dialog (no modal-in-modal). One search box, newest first, one
 * Resume action per row; the full filter set still lives in the dashboard's
 * History modal for the power-user case.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconX } from '../Icons'
import { RefreshButton } from '../ui/RefreshButton'
import { RelativeTime } from '../ui/RelativeTime'
import { Tooltip } from '../ui/InfoTip'
import { prepareSavedHistoryEntries } from '../../utils/saved-history-filters'
import { getSavedHistoryEmptyStateLabel, getSavedHistoryModalTitle } from '../../utils/dashboard-launch-copy'
import { pathBasename } from '../../utils/path-basename'
import type { SavedSessionHistoryEntry } from './HistoryModal'

export interface SavedHistoryInlinePanelProps {
    sessions: SavedSessionHistoryEntry[]
    loading: boolean
    busy?: boolean
    resumingSessionId?: string | null
    /** When a saved session has no workspace, resuming uses this selected path. */
    fallbackWorkspacePath?: string | null
    onResume: (session: SavedSessionHistoryEntry) => void
    onRefresh: () => void
    onClose: () => void
}

export default function SavedHistoryInlinePanel({
    sessions,
    loading,
    busy = false,
    resumingSessionId = null,
    fallbackWorkspacePath,
    onResume,
    onRefresh,
    onClose,
}: SavedHistoryInlinePanelProps) {
    const { t } = useTranslation('common')
    const [query, setQuery] = useState('')
    const fallback = String(fallbackWorkspacePath || '').trim()
    const rows = useMemo(() => {
        const withFallback = sessions.map(session => (
            session.canResume || String(session.workspace || '').trim() || !fallback
                ? session
                : { ...session, workspace: fallback, canResume: true, workspaceFallbackSource: 'selected-workspace' as const }
        ))
        return prepareSavedHistoryEntries(withFallback, { textQuery: query, sortMode: 'recent' })
    }, [fallback, query, sessions])

    return (
        <div
            className="mt-3 flex max-h-[min(55vh,420px)] flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary"
            role="region"
            aria-label={getSavedHistoryModalTitle(t)}
            data-testid="saved-history-inline"
        >
            <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                <input
                    type="search"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder={t('historyModal.searchPlaceholder')}
                    aria-label={t('historyModal.searchPlaceholder')}
                    className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-primary px-3 py-1.5 text-sm text-text-primary"
                />
                <RefreshButton onClick={onRefresh} refreshing={loading} className="h-8 w-8" />
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('common.close')}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-transparent text-text-muted hover:text-text-primary"
                >
                    <IconX size={14} />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {rows.map(session => {
                    const resuming = resumingSessionId === session.providerSessionId
                    const workspace = String(session.workspace || '').trim()
                    return (
                        <div
                            key={session.id}
                            className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-bg-primary/60"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold text-text-primary">
                                    {session.title || t('historyModal.untitledSession')}
                                </div>
                                <div className="flex min-w-0 items-center gap-1.5 text-2xs text-text-muted">
                                    <RelativeTime value={session.lastMessageAt} />
                                    {workspace && (
                                        <>
                                            <span aria-hidden>·</span>
                                            <Tooltip content={workspace}><span className="truncate">{pathBasename(workspace)}</span></Tooltip>
                                        </>
                                    )}
                                    {session.messageCount > 0 && (
                                        <>
                                            <span aria-hidden>·</span>
                                            <span className="shrink-0">{t('historyModal.msgCount', { count: session.messageCount })}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                            {session.canResume ? (
                                <button
                                    type="button"
                                    className="btn btn-secondary btn-sm shrink-0"
                                    disabled={busy || !!resumingSessionId}
                                    onClick={() => onResume(session)}
                                >
                                    {resuming ? t('historyModal.statusResuming') : t('historyModal.statusResume')}
                                </button>
                            ) : (
                                <span className="shrink-0 text-2xs text-text-muted">{t('historyModal.statusMissingWorkspace')}</span>
                            )}
                        </div>
                    )
                })}
                {!loading && rows.length === 0 && (
                    <div className="px-3 py-6 text-center text-xs text-text-muted">
                        {sessions.length > 0 ? t('historyModal.noMatchingHistory') : getSavedHistoryEmptyStateLabel(t)}
                    </div>
                )}
                {loading && rows.length === 0 && (
                    <div className="px-3 py-6 text-center text-xs text-text-muted">{t('launch.loadingShort')}</div>
                )}
            </div>
        </div>
    )
}
