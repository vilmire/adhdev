import type {
    RepoMeshLedgerSummaryStatus,
    RepoMeshQueueSummary,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import type { MeshGraphTheme } from '../meshGraphTheme'
import {
    sessionStatusLabel,
    shortSessionId,
    type AsyncRefineJob,
    type SessionListEntry,
} from './meshSurfaceHelpers'

export function MeshHealthPanel({
    canonicalStatus,
    queueSummary,
    ledgerSummary,
    isBootstrapMode,
    meshTheme,
    sessionEntries,
    inlineMode = false,
}: {
    canonicalStatus: RepoMeshStatus
    queueSummary: RepoMeshQueueSummary | null
    ledgerSummary: RepoMeshLedgerSummaryStatus
    isBootstrapMode: boolean
    meshTheme: MeshGraphTheme
    sessionEntries: SessionListEntry[]
    inlineMode?: boolean
}) {
    const hasQueueActivity = queueSummary && (queueSummary.active > 0 || queueSummary.historical > 0)
    const hasLedgerFailures = ledgerSummary.recentFailures > 0 || ledgerSummary.taskFailed > 0
    const failedQueueTasks = (canonicalStatus.queue as any)?.tasks
        ? ((canonicalStatus.queue as any).tasks as RepoMeshQueueTask[])
            .filter(task => task.status === 'failed' || task.status === 'cancelled')
            .slice(0, 5)
        : []
    const asyncRefineJobs = (canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined
    const activeRefineJobs = asyncRefineJobs?.filter(j => j.status === 'running' || j.status === 'accepted') ?? []
    const failedRefineJobs = asyncRefineJobs?.filter(j => j.status === 'failed') ?? []
    const staleWork = (canonicalStatus as any).staleDirectWorkSummary as { count: number; reasonCounts?: Record<string, number> } | undefined
    const hasStaleWork = staleWork && staleWork.count > 0

    if (!hasQueueActivity && !hasLedgerFailures && canonicalStatus.nodes.length === 0 && !isBootstrapMode
        && activeRefineJobs.length === 0 && failedRefineJobs.length === 0 && !hasStaleWork && sessionEntries.length === 0) {
        return null
    }

    const dk = meshTheme.isDark
    const sepClass = `border-t ${dk ? 'border-white/8' : 'border-slate-200'}`
    const subDetailsClass = `group w-full rounded-lg border text-xs ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`
    const subSummaryClass = `flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden ${meshTheme.textSecondary}`

    // stat tile: value + label below
    function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: 'rose' | 'sky' | 'amber' | 'emerald' | 'muted' }) {
        const valClass = tone === 'rose' ? (dk ? 'text-rose-300' : 'text-rose-600')
            : tone === 'sky' ? (dk ? 'text-sky-300' : 'text-sky-600')
            : tone === 'amber' ? (dk ? 'text-amber-300' : 'text-amber-600')
            : tone === 'emerald' ? (dk ? 'text-emerald-300' : 'text-emerald-600')
            : tone === 'muted' ? meshTheme.textMuted
            : meshTheme.textPrimary
        return (
            <div className={`flex flex-col items-center rounded-lg border px-2 py-1.5 ${dk ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-white/70'}`}>
                <span className={`tabular-nums text-sm font-semibold leading-none ${valClass}`}>{value}</span>
                <span className={`mt-0.5 text-[9px] uppercase tracking-wide ${meshTheme.textMuted}`}>{label}</span>
            </div>
        )
    }

    const contentDiv = (
        <div className="flex flex-col gap-3 text-xs">
            {/* Stat tiles grid */}
            <div className="grid grid-cols-4 gap-1.5">
                {queueSummary ? (
                    <>
                        <StatTile label="Pending" value={queueSummary.pending} />
                        <StatTile label="Active" value={queueSummary.active} tone={queueSummary.active > 0 ? 'sky' : undefined} />
                        <StatTile label="Done" value={queueSummary.completed} tone="emerald" />
                        <StatTile label="Failed" value={queueSummary.failed} tone={queueSummary.failed > 0 ? 'rose' : undefined} />
                    </>
                ) : (
                    <>
                        <StatTile label="Done" value={ledgerSummary.taskCompleted} tone="emerald" />
                        <StatTile label="Failed" value={ledgerSummary.taskFailed} tone={ledgerSummary.taskFailed > 0 ? 'rose' : undefined} />
                        <StatTile label="Sessions" value={ledgerSummary.sessionLaunched} />
                        <StatTile label="Recent↯" value={ledgerSummary.recentFailures} tone={ledgerSummary.recentFailures > 0 ? 'amber' : 'muted'} />
                    </>
                )}
            </div>

            {/* Secondary stats row when queue present */}
            {queueSummary && (
                <div className="grid grid-cols-3 gap-1.5">
                    <StatTile label="Ledger done" value={ledgerSummary.taskCompleted} tone="emerald" />
                    <StatTile label="Sessions" value={ledgerSummary.sessionLaunched} />
                    <StatTile label="Recent↯" value={ledgerSummary.recentFailures} tone={ledgerSummary.recentFailures > 0 ? 'amber' : 'muted'} />
                </div>
            )}

            {/* Last activity */}
            {ledgerSummary.lastActivityAt && (
                <div className={`flex items-center justify-between ${meshTheme.textMuted}`}>
                    <span>Last activity</span>
                    <span className="font-mono text-[10px]">{ledgerSummary.lastActivityAt.slice(5, 16)}</span>
                </div>
            )}

            {/* Node connections */}
            {canonicalStatus.nodes.length > 0 && (
                <div className={`pt-2.5 ${sepClass}`}>
                    <div className="flex flex-col gap-1">
                        {canonicalStatus.nodes.map(node => {
                            const connState = node.connection?.state ?? 'unknown'
                            const isConnecting = connState === 'unknown' || connState === 'connecting'
                            const isFailed = connState === 'failed' || connState === 'closed' || connState === 'disconnected'
                            const isConnected = connState === 'connected' || connState === 'self'
                            const dotClass = isConnecting
                                ? (dk ? 'bg-amber-400' : 'bg-amber-400')
                                : isFailed
                                    ? (dk ? 'bg-rose-400' : 'bg-rose-500')
                                    : isConnected
                                        ? (dk ? 'bg-emerald-400' : 'bg-emerald-500')
                                        : (dk ? 'bg-slate-500' : 'bg-slate-400')
                            return (
                                <div key={node.nodeId} className="flex items-center gap-2">
                                    <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
                                    <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={node.workspace}>{node.machineLabel}</span>
                                    <span className={`shrink-0 font-mono text-[10px] ${meshTheme.textMuted}`}>{isConnecting ? '…' : connState}</span>
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}

            {/* Refine jobs — collapsible */}
            {asyncRefineJobs && asyncRefineJobs.length > 0 && (
                <div className={`pt-2.5 ${sepClass}`}>
                    <details className={subDetailsClass}>
                        <summary className={subSummaryClass}>
                            <span className="flex-1">Refine jobs</span>
                            <span className={`tabular-nums ${dk ? 'text-slate-400' : 'text-slate-500'}`}>{asyncRefineJobs.length}</span>
                            {failedRefineJobs.length > 0 && <span className={dk ? 'text-rose-300' : 'text-rose-600'}>{failedRefineJobs.length} failed</span>}
                        </summary>
                        <div className="flex flex-col gap-0.5 px-2.5 pb-2">
                            {asyncRefineJobs.slice(0, 8).map(job => (
                                <div key={job.jobId} className="flex items-center gap-2">
                                    <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`}>
                                        {job.branch ?? job.jobId.slice(0, 14)}{job.into ? ` → ${job.into}` : ''}
                                    </span>
                                    <span className={`shrink-0 text-[9px] font-semibold ${
                                        job.status === 'failed' ? (dk ? 'text-rose-300' : 'text-rose-600')
                                        : job.status === 'running' || job.status === 'accepted' ? (dk ? 'text-sky-300' : 'text-sky-600')
                                        : (dk ? 'text-emerald-300' : 'text-emerald-600')
                                    }`}>{job.status}</span>
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}

            {/* Failed queue tasks — collapsible */}
            {failedQueueTasks.length > 0 && (
                <div className={asyncRefineJobs && asyncRefineJobs.length > 0 ? '' : `pt-2.5 ${sepClass}`}>
                    <details className={subDetailsClass}>
                        <summary className={subSummaryClass}>
                            <span className={`flex-1 ${dk ? 'text-rose-300' : 'text-rose-600'}`}>Failed tasks</span>
                            <span className={`tabular-nums ${dk ? 'text-rose-400' : 'text-rose-500'}`}>{failedQueueTasks.length}</span>
                        </summary>
                        <div className="flex flex-col gap-1 px-2.5 pb-2">
                            {failedQueueTasks.map(task => (
                                <div key={task.id} className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <span className={`font-mono text-[10px] ${meshTheme.textMuted}`}>{task.id.slice(0, 10)}</span>
                                        {task.message && <span className={`flex-1 truncate ${dk ? 'text-slate-300' : 'text-slate-700'}`}>{task.message.slice(0, 55)}</span>}
                                    </div>
                                    {task.cancelReason && <div className={`truncate text-[10px] ${meshTheme.textMuted}`}>{task.cancelReason.slice(0, 55)}</div>}
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}

            {/* Stale work */}
            {hasStaleWork && (
                <div className={`flex items-center justify-between pt-2.5 ${sepClass}`}>
                    <span className={meshTheme.textMuted}>Stale work</span>
                    <span className={`tabular-nums ${dk ? 'text-amber-300' : 'text-amber-600'}`}>{staleWork!.count}</span>
                </div>
            )}

            {/* Sessions — collapsible */}
            {sessionEntries.length > 0 && (
                <div className={`pt-2.5 ${sepClass}`}>
                    <details className={subDetailsClass}>
                        <summary className={subSummaryClass}>
                            <span className="flex-1">Sessions</span>
                            <span className={`tabular-nums ${dk ? 'text-slate-400' : 'text-slate-500'}`}>{sessionEntries.length}</span>
                        </summary>
                        <div className="flex flex-col gap-0.5 px-2.5 pb-2">
                            {sessionEntries.map(entry => (
                                <div key={entry.session.sessionId} className="flex items-center gap-2">
                                    <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`} title={entry.session.sessionId}>
                                        {shortSessionId(entry.session.sessionId)}
                                    </span>
                                    <span className={`shrink-0 ${meshTheme.textMuted}`}>{entry.session.providerType || '?'}</span>
                                    <span className={`shrink-0 text-[9px] font-semibold ${meshTheme.textMuted}`}>{sessionStatusLabel(entry.session)}</span>
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}
        </div>
    )

    if (inlineMode) return contentDiv

    return (
        <details className={`rounded-2xl border text-xs ${meshTheme.isDark ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
            <summary className={`flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium [&::-webkit-details-marker]:hidden ${meshTheme.textSecondary}`}>
                <span className="flex-1">Mesh Health Panel</span>
                {activeRefineJobs.length > 0 && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700'}`}>
                        {activeRefineJobs.length} refining
                    </span>
                )}
                {failedRefineJobs.length > 0 && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-rose-400/30 bg-rose-500/12 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                        {failedRefineJobs.length} refine failed
                    </span>
                )}
                {hasLedgerFailures && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-rose-400/30 bg-rose-500/12 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                        {ledgerSummary.recentFailures} recent failures
                    </span>
                )}
                {isBootstrapMode && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-amber-400/20 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                        awaiting live data
                    </span>
                )}
            </summary>
            {contentDiv}
        </details>
    )
}
