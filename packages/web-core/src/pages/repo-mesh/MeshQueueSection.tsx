import { useTranslation } from 'react-i18next'
import { Section } from '../../components/ui/Section'
import { describeQueueTaskMessage } from '../../utils/queue-task-label'
import { IconRefresh, NodeHealthBadge } from './icons'
import type { MeshQueueEntry, MeshQueueSummary } from './types'

// M7: dispatched→terminal wall clock from queue truth (dispatchTimestamp/updatedAt).
// Shown only when both endpoints exist — no estimates.
function describeTaskDuration(item: MeshQueueEntry): string | null {
    if (item.status !== 'completed' && item.status !== 'failed') return null
    const dispatched = item.dispatchTimestamp ? new Date(item.dispatchTimestamp).getTime() : NaN
    const terminal = item.updatedAt ? new Date(item.updatedAt).getTime() : NaN
    if (!Number.isFinite(dispatched) || !Number.isFinite(terminal) || terminal < dispatched) return null
    const totalSeconds = Math.round((terminal - dispatched) / 1000)
    if (totalSeconds < 60) return `${totalSeconds}s`
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

interface Props {
    queueSummary: MeshQueueSummary | null
    queueLoading: boolean
    queueError: string | null
    activeDaemonId: string
    onRefresh: () => void
}

export function MeshQueueSection({ queueSummary, queueLoading, queueError, activeDaemonId, onRefresh }: Props) {
    const { t } = useTranslation('common')
    return (
        <Section title={t('repoMesh.queue.title')} description={t('repoMesh.queue.description')}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 flex-1 min-w-[260px]">
                    {([
                        ['statActive', queueSummary?.active ?? 0, 'text-accent-primary'],
                        ['statPending', queueSummary?.activeCounts.pending ?? queueSummary?.counts.pending ?? 0, 'text-text-primary'],
                        ['statAssigned', queueSummary?.activeCounts.assigned ?? queueSummary?.counts.assigned ?? 0, 'text-blue-400'],
                        ['statStale', queueSummary?.staleAssignedCount ?? 0, 'text-amber-400'],
                        ['statHistorical', queueSummary?.historical ?? 0, 'text-text-muted'],
                        ['statCompleted', queueSummary?.historicalCounts.completed ?? queueSummary?.counts.completed ?? 0, 'text-green-400'],
                        ['statFailed', queueSummary?.historicalCounts.failed ?? queueSummary?.counts.failed ?? 0, 'text-red-400'],
                    ] as const).map(([labelKey, value, color]) => (
                        <div key={labelKey} className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wide text-text-muted">{t(`repoMesh.queue.${labelKey}`)}</div>
                            <div className={`text-lg font-bold ${color}`}>{value}</div>
                        </div>
                    ))}
                </div>
                <button type="button" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={onRefresh} disabled={queueLoading || !activeDaemonId}>
                    <IconRefresh size={13} />{queueLoading ? t('repoMesh.queue.loading') : t('repoMesh.queue.refresh')}
                </button>
            </div>
            {queueError && <div className="mb-3 text-[12px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">{queueError}</div>}
            {!queueSummary ? (
                <div className="text-[12px] text-text-muted rounded-lg border border-border-subtle bg-bg-secondary px-3 py-3">
                    {t('repoMesh.queue.refreshHint')}
                </div>
            ) : queueSummary.recent.length === 0 ? (
                <div className="text-[12px] text-text-muted rounded-lg border border-border-subtle bg-bg-secondary px-3 py-3">{t('repoMesh.queue.empty')}</div>
            ) : (
                <div className="flex flex-col gap-2">
                    {queueSummary.recent.map((item: MeshQueueEntry) => (
                        <div key={item.id} className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-mono text-[11px] text-text-muted">{item.id.slice(0, 12)}</span>
                                        <NodeHealthBadge status={item.status} />
                                        {item.staleAssigned && (
                                            <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5" title={item.staleReason || t('repoMesh.queue.staleTitle')}>{t('repoMesh.queue.staleBadge')}</span>
                                        )}
                                        {(item.waitingOn?.length ?? 0) > 0 && (
                                            <span className="text-[10px] text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-full px-2 py-0.5" title={t('repoMesh.queue.waitingOnTitle', { tasks: item.waitingOn!.join(', ') })}>
                                                {t('repoMesh.queue.waitsOn', { count: item.waitingOn!.length })}
                                            </span>
                                        )}
                                        {item.blockedReason && (
                                            <span className="text-[10px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5" title={item.blockedReason}>{t('repoMesh.queue.blocked')}</span>
                                        )}
                                        {describeTaskDuration(item) && (
                                            <span className="text-[10px] text-text-muted bg-surface-secondary border border-border-subtle rounded-full px-2 py-0.5" title={t('repoMesh.queue.durationTitle')}>
                                                {describeTaskDuration(item)}{(item.requeueCount ?? 0) > 0 ? t('repoMesh.queue.retry', { count: item.requeueCount }) : ''}
                                            </span>
                                        )}
                                    </div>
                                    {item.message && <div className="text-[12px] text-text-primary truncate" title={item.message}>{describeQueueTaskMessage(item.message)}</div>}
                                </div>
                                <div className="text-right text-[10px] text-text-muted shrink-0">
                                    {item.nodeId && <div>{t('repoMesh.queue.node', { id: item.nodeId.slice(0, 10) })}</div>}
                                    {item.sessionId && <div>{t('repoMesh.queue.session', { id: item.sessionId.slice(0, 10) })}</div>}
                                    {item.updatedAt && <div>{new Date(item.updatedAt).toLocaleTimeString()}</div>}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Section>
    )
}
