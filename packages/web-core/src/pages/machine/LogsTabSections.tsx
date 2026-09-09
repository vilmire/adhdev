import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { LogEntry } from './types'
import type { MachineDiagnosticsStreamsState } from '../../hooks/useMachineDiagnosticsStreams'
import { DEBUG_TRACE_FILTERS } from '../../utils/logs-trace-filters'
import Card from '../../components/Card'
import {
    type DiagnosticEvent,
    type DiagnosticRepeatedPattern,
    type DiagnosticsSummary,
    type DiagnosticSource,
    type DiagnosticSourceState,
    type DiagnosticSeverity,
} from '../../utils/diagnostics-model'
import {
    truncatePayload,
    type LogsQuickFilterCounts,
    type LogsSurfaceTraceEntry,
    type LogsSurfaceWebEntry,
} from '../../utils/logs-surface'

export type LogsQuickFilter = 'all' | 'info' | 'issues'

export interface LogsSectionsOpenState {
    timeline: boolean
    daemon: boolean
    trace: boolean
    web: boolean
}

function formatTimestamp(ts: number | null, t: TFunction): string {
    if (!ts) return t('machine.logsTabSections.notYetLoaded')
    return new Date(ts).toLocaleTimeString()
}

function formatDiagnosticTimestamp(ts: number, t: TFunction): string {
    if (!Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 365 * 24 * 60 * 60 * 1000) return t('machine.logsTabSections.rawFile')
    return new Date(ts).toLocaleTimeString()
}

function sectionTone(level: DiagnosticSeverity): string {
    if (level === 'error') return 'text-red-300 border-red-500/25 bg-red-500/[0.05]'
    if (level === 'warn') return 'text-amber-200 border-amber-500/25 bg-amber-500/[0.05]'
    if (level === 'debug') return 'text-slate-300 border-slate-500/25 bg-slate-500/[0.05]'
    return 'text-text-secondary border-border-subtle bg-bg-primary'
}

function summaryCardTone(kind: 'neutral' | 'good' | 'warning' | 'danger'): string {
    if (kind === 'good') return 'border-emerald-500/20 bg-emerald-500/[0.05]'
    if (kind === 'warning') return 'border-amber-500/20 bg-amber-500/[0.05]'
    if (kind === 'danger') return 'border-red-500/20 bg-red-500/[0.05]'
    return 'border-border-subtle bg-bg-secondary'
}

function sourceLabel(source: DiagnosticSource, t: TFunction): string {
    if (source === 'daemon_log') return t('machine.logsTabSections.sourceDaemon')
    if (source === 'daemon_trace') return t('machine.logsTabSections.sourceTrace')
    if (source === 'browser_event') return t('machine.logsTabSections.sourceBrowser')
    return t('machine.logsTabSections.rawFile')
}

function DiagnosticEventRow({ event }: { event: DiagnosticEvent }) {
    const { t } = useTranslation('common')
    return (
        <div className={`py-2 px-2 mb-2 rounded-lg border ${sectionTone(event.severity)}`}>
            <div className="flex gap-2 text-3xs text-text-muted flex-wrap">
                <span>{formatDiagnosticTimestamp(event.ts, t)}</span>
                <span>{event.severity.toUpperCase()}</span>
                <span>{sourceLabel(event.source, t)}</span>
                {event.category && event.stage && <span>{event.category}.{event.stage}</span>}
                {event.topic && <span>topic={event.topic}</span>}
                {event.interactionId && <span>ix={event.interactionId}</span>}
            </div>
            <div className="mt-1 break-words text-text-primary/90">{event.message}</div>
        </div>
    )
}

export function LogsToolbar({
    quickFilter,
    quickFilterCounts,
    searchQuery,
    autoRefresh,
    onQuickFilterChange,
    onSearchQueryChange,
    onCopyDiagnostics,
    onCopyVisible,
    onToggleAutoRefresh,
    onRefresh,
    onClear,
}: {
    quickFilter: LogsQuickFilter
    quickFilterCounts: LogsQuickFilterCounts
    searchQuery: string
    autoRefresh: boolean
    onQuickFilterChange: (filter: LogsQuickFilter) => void
    onSearchQueryChange: (query: string) => void
    onCopyDiagnostics: () => void
    onCopyVisible: () => void
    onToggleAutoRefresh: () => void
    onRefresh: () => void
    onClear: () => void
}) {
    const { t } = useTranslation('common')
    return (
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2 items-center">
                <span className="text-2xs text-text-muted font-semibold uppercase tracking-wider mr-1">
                    {t('machine.logsTabSections.view')}
                </span>
                <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-secondary p-1">
                    {([
                        { id: 'info', label: t('machine.logsTabSections.filterInfo', { count: quickFilterCounts.info }) },
                        { id: 'issues', label: t('machine.logsTabSections.filterIssues', { count: quickFilterCounts.issues }) },
                        { id: 'all', label: t('machine.logsTabSections.filterAll', { count: quickFilterCounts.all }) },
                    ] as const).map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => onQuickFilterChange(option.id)}
                            className={`rounded-md px-2.5 py-1 text-2xs transition-colors ${
                                quickFilter === option.id
                                    ? 'bg-accent-primary/15 text-accent-primary border border-accent-primary/30'
                                    : 'text-text-secondary hover:text-text-primary'
                            }`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                <input
                    value={searchQuery}
                    onChange={(event) => onSearchQueryChange(event.target.value)}
                    placeholder={t('machine.logsTabSections.searchPlaceholder')}
                    className="min-w-[220px] flex-1 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
                />
            </div>

            <div className="flex flex-wrap gap-2 items-center">
                <button onClick={onCopyDiagnostics} className="machine-btn">{t('machine.logsTabSections.copyDiagnostics')}</button>
                <button onClick={onCopyVisible} className="machine-btn">{t('machine.logsTabSections.copyVisible')}</button>
                <button
                    onClick={onToggleAutoRefresh}
                    className={`machine-btn ${autoRefresh ? 'text-green-500 border-green-500/30' : ''}`}
                >{autoRefresh ? t('machine.logsTabSections.pause') : t('machine.logsTabSections.resume')}</button>
                <button onClick={onRefresh} className="machine-btn">{t('machine.logsTabSections.refresh')}</button>
                <button onClick={onClear} className="machine-btn">{t('machine.logsTabSections.clear')}</button>
            </div>
        </div>
    )
}

export function AdvancedSourceScope({
    logLevel,
    traceCategory,
    onLogLevelChange,
    onTraceCategoryChange,
}: Pick<MachineDiagnosticsStreamsState, 'logLevel' | 'traceCategory'> & {
    onLogLevelChange: MachineDiagnosticsStreamsState['setLogLevel']
    onTraceCategoryChange: MachineDiagnosticsStreamsState['setTraceCategory']
}) {
    const { t } = useTranslation('common')
    return (
        <Card padding="sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-3xs uppercase tracking-wider text-text-muted font-semibold">{t('machine.logsTabSections.advancedSourceScope')}</span>
                    {(['debug', 'info', 'warn', 'error'] as const).map(level => (
                        <button
                            key={level}
                            onClick={() => onLogLevelChange(level)}
                            className={`machine-btn text-3xs px-2 py-0.5 ${
                                logLevel === level ? 'bg-accent-primary/15 border-accent-primary/40 text-accent-primary' : ''
                            }`}
                        >{t('machine.logsTabSections.daemonLevelPlus', { level: level.toUpperCase() })}</button>
                    ))}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                    {DEBUG_TRACE_FILTERS.map((filter) => (
                        <button
                            key={filter.value}
                            onClick={() => onTraceCategoryChange(filter.value)}
                            className={`machine-btn text-3xs px-2 py-0.5 ${
                                traceCategory === filter.value ? 'bg-accent-primary/15 border-accent-primary/40 text-accent-primary' : ''
                            }`}
                        >
                            {filter.label}
                        </button>
                    ))}
                </div>
            </div>
        </Card>
    )
}

export function DiagnosticsSummaryCards({
    diagnosticsSummary,
    diagnosticEventsCount,
    sourceStates,
    searchQuery,
    lastUpdatedAt,
    autoRefresh,
    daemonFetchError,
    traceFetchError,
}: {
    diagnosticsSummary: DiagnosticsSummary
    diagnosticEventsCount: number
    sourceStates: DiagnosticSourceState[]
    searchQuery: string
    lastUpdatedAt: number | null
    autoRefresh: boolean
    daemonFetchError: string
    traceFetchError: string
}) {
    const { t } = useTranslation('common')
    const latestIssueTone = diagnosticsSummary.latestIssue?.severity === 'error' ? 'danger' : diagnosticsSummary.latestIssue?.severity === 'warn' ? 'warning' : 'good'
    const statusTone = daemonFetchError || traceFetchError ? 'danger' : autoRefresh ? 'good' : 'neutral'

    return (
        <div className="grid gap-3 md:grid-cols-3">
            <div className={`rounded-xl border p-3 ${summaryCardTone(diagnosticsSummary.issueCount > 0 ? 'warning' : 'good')}`}>
                <div className="text-3xs uppercase tracking-wider text-text-muted mb-2">{t('machine.logsTabSections.diagnosticsTimeline')}</div>
                <div className="text-[13px] text-text-primary font-medium">
                    {t('machine.logsTabSections.visibleEventsIssues', { events: diagnosticEventsCount, issues: diagnosticsSummary.issueCount })}
                </div>
                <div className="text-2xs text-text-secondary mt-1">
                    {searchQuery.trim() ? t('machine.logsTabSections.filteredBy', { query: searchQuery.trim() }) : t('machine.logsTabSections.mergedByTime')}
                </div>
            </div>

            <div className={`rounded-xl border p-3 ${summaryCardTone(latestIssueTone)}`}>
                <div className="text-3xs uppercase tracking-wider text-text-muted mb-2">{t('machine.logsTabSections.latestIssue')}</div>
                {diagnosticsSummary.latestIssue ? (
                    <>
                        <div className="text-[13px] text-text-primary font-medium">
                            {sourceLabel(diagnosticsSummary.latestIssue.source, t)} · {diagnosticsSummary.latestIssue.severity.toUpperCase()}
                        </div>
                        <div className="text-2xs text-text-secondary mt-1 line-clamp-2">
                            {diagnosticsSummary.latestIssue.message}
                        </div>
                        <div className="text-3xs text-text-muted mt-2">
                            {formatDiagnosticTimestamp(diagnosticsSummary.latestIssue.ts, t)}
                        </div>
                    </>
                ) : (
                    <>
                        <div className="text-[13px] text-text-primary font-medium">{t('machine.logsTabSections.noVisibleIssue')}</div>
                        <div className="text-2xs text-text-secondary mt-1">{t('machine.logsTabSections.useIssuesOrAll')}</div>
                    </>
                )}
            </div>

            <div className={`rounded-xl border p-3 ${summaryCardTone(statusTone)}`}>
                <div className="text-3xs uppercase tracking-wider text-text-muted mb-2">{t('machine.logsTabSections.sourceStatus')}</div>
                <div className="text-[13px] text-text-primary font-medium">
                    {daemonFetchError || traceFetchError ? t('machine.logsTabSections.needsAttention') : autoRefresh ? t('machine.logsTabSections.livePolling') : t('machine.logsTabSections.paused')}
                </div>
                <div className="text-2xs text-text-secondary mt-1">
                    {t('machine.logsTabSections.lastUpdate', { time: formatTimestamp(lastUpdatedAt, t) })}
                </div>
                <div className="text-3xs text-text-muted mt-2 space-y-1">
                    {sourceStates.map((source) => (
                        <div key={source.id}>{source.label}: {source.status}</div>
                    ))}
                </div>
            </div>
        </div>
    )
}

export function RepeatedPatternsPanel({ patterns }: { patterns: DiagnosticRepeatedPattern[] }) {
    const { t } = useTranslation('common')
    if (patterns.length === 0) return null

    return (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <div className="text-3xs uppercase tracking-wider text-text-muted mb-2">{t('machine.logsTabSections.repeatedIssuePatterns')}</div>
            <div className="grid gap-2 md:grid-cols-2">
                {patterns.map((pattern) => (
                    <div key={pattern.key} className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-2">
                        <div className="text-xs text-text-primary font-medium">{pattern.count}× {pattern.severity.toUpperCase()} · {sourceLabel(pattern.source, t)}</div>
                        <div className="text-2xs text-text-secondary mt-1 line-clamp-2">{pattern.message}</div>
                    </div>
                ))}
            </div>
        </div>
    )
}

export function DiagnosticsSections({
    streams,
    sectionsOpen,
    setSectionsOpen,
    diagnosticEvents,
    visibleDaemonLogs,
    visibleDaemonRawLines,
    visibleTraceEntries,
    visibleWebEvents,
    quickFilter,
    searchQuery,
}: {
    streams: MachineDiagnosticsStreamsState
    sectionsOpen: LogsSectionsOpenState
    setSectionsOpen: Dispatch<SetStateAction<LogsSectionsOpenState>>
    diagnosticEvents: DiagnosticEvent[]
    visibleDaemonLogs: LogEntry[]
    visibleDaemonRawLines: string[]
    visibleTraceEntries: LogsSurfaceTraceEntry[]
    visibleWebEvents: LogsSurfaceWebEntry[]
    quickFilter: LogsQuickFilter
    searchQuery: string
}) {
    const { t } = useTranslation('common')
    return (
        <div className="grid gap-3">
            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
                    onClick={() => setSectionsOpen((current) => ({ ...current, timeline: !current.timeline }))}
                >
                    <div>
                        <div className="text-3xs uppercase tracking-wider text-text-muted">{t('machine.logsTabSections.unifiedTimeline')}</div>
                        <div className="text-2xs text-text-secondary mt-1">{t('machine.logsTabSections.visibleDiagnosticEvents', { count: diagnosticEvents.length })}</div>
                    </div>
                    <div className="text-2xs text-text-muted">{sectionsOpen.timeline ? t('machine.logsTabSections.hide') : t('machine.logsTabSections.show')}</div>
                </button>
                {sectionsOpen.timeline && (
                    <div className="border-t border-border-subtle p-3 min-h-[180px] max-h-[440px] overflow-y-auto font-mono text-2xs leading-relaxed">
                        {(streams.daemonLoading || streams.traceLoading) && diagnosticEvents.length === 0 && !streams.daemonFetchError && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">{t('machine.logsTabSections.loadingDiagnostics')}</div>
                        )}
                        {(streams.daemonFetchError || streams.traceFetchError) && diagnosticEvents.length === 0 && (
                            <div className="p-6 text-center text-red-300 space-y-1">
                                {streams.daemonFetchError && <div>{t('machine.logsTabSections.daemonLogsError', { error: streams.daemonFetchError })}</div>}
                                {streams.traceFetchError && <div>{t('machine.logsTabSections.daemonTraceError', { error: streams.traceFetchError })}</div>}
                            </div>
                        )}
                        {!streams.daemonLoading && !streams.traceLoading && diagnosticEvents.length === 0 && !streams.daemonFetchError && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">{t('machine.logsTabSections.noDiagnosticsMatch')}</div>
                        )}
                        {diagnosticEvents.map((event) => <DiagnosticEventRow key={event.id} event={event} />)}
                    </div>
                )}
            </div>

            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
                    onClick={() => setSectionsOpen((current) => ({ ...current, daemon: !current.daemon }))}
                >
                    <div>
                        <div className="text-3xs uppercase tracking-wider text-text-muted">{t('machine.logsTabSections.rawSourceDaemonLogs')}</div>
                        <div className="text-2xs text-text-secondary mt-1">
                            {streams.daemonLogKind === 'text'
                                ? t('machine.logsTabSections.visibleRawLinesFallback', { count: visibleDaemonRawLines.length })
                                : t('machine.logsTabSections.visibleStructuredLines', { count: visibleDaemonLogs.length })}
                        </div>
                    </div>
                    <div className="text-2xs text-text-muted">{sectionsOpen.daemon ? t('machine.logsTabSections.hide') : t('machine.logsTabSections.show')}</div>
                </button>
                {sectionsOpen.daemon && (
                    <div className="border-t border-border-subtle p-3 min-h-[160px] max-h-[360px] overflow-y-auto font-mono text-2xs leading-relaxed">
                        {streams.daemonLoading && visibleDaemonLogs.length === 0 && visibleDaemonRawLines.length === 0 && !streams.daemonFetchError && (
                            <div className="p-6 text-center text-text-muted">{t('machine.logsTabSections.loadingDaemonLogs')}</div>
                        )}
                        {!streams.daemonLoading && streams.daemonFetchError && streams.daemonLogKind === 'empty' && (
                            <div className="p-6 text-center text-red-300">{streams.daemonFetchError}</div>
                        )}
                        {!streams.daemonLoading && streams.daemonLogKind === 'empty' && !streams.daemonFetchError && (
                            <div className="p-6 text-center text-text-muted">{t('machine.logsTabSections.noDaemonLogsYet')}</div>
                        )}
                        {streams.daemonLogKind === 'text' && visibleDaemonRawLines.length === 0 && streams.daemonRawText && (
                            <div className="p-6 text-center text-text-muted">{quickFilter === 'all' ? t('machine.logsTabSections.noRawLinesMatchSearch') : t('machine.logsTabSections.rawFallbackOnlyInAll')}</div>
                        )}
                        {streams.daemonLogKind === 'structured' && visibleDaemonLogs.length === 0 && streams.daemonLogs.length > 0 && (
                            <div className="p-6 text-center text-text-muted">{t('machine.logsTabSections.noStructuredLogsMatch')}</div>
                        )}
                        {streams.daemonLogKind === 'text' && visibleDaemonRawLines.map((line, index) => (
                            <div key={`raw-${index}`} className="py-0.5 text-text-secondary whitespace-pre-wrap break-words">{line}</div>
                        ))}
                        {streams.daemonLogKind !== 'text' && visibleDaemonLogs.map((log, index) => (
                            <div key={`log-${index}`} className={`flex gap-2 py-1 px-2 mb-1 rounded-lg border ${sectionTone(log.level)}`}>
                                <span className="text-text-muted min-w-[75px] shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                <span className="font-semibold min-w-[32px] shrink-0 text-4xs">{log.level === 'error' ? 'ERR' : log.level === 'warn' ? 'WRN' : log.level === 'debug' ? 'DBG' : 'INF'}</span>
                                <span className="break-words">{log.message}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
                    onClick={() => setSectionsOpen((current) => ({ ...current, trace: !current.trace }))}
                >
                    <div>
                        <div className="text-3xs uppercase tracking-wider text-text-muted">
                            {t('machine.logsTabSections.rawSourceDaemonTrace')}
                            {streams.traceCategory === 'session_host' ? ` · ${t('machine.logsTabSections.sessionHostOnly')}` : ''}
                        </div>
                        <div className="text-2xs text-text-secondary mt-1">{t('machine.logsTabSections.visibleTraceEvents', { count: visibleTraceEntries.length })}</div>
                    </div>
                    <div className="text-2xs text-text-muted">{sectionsOpen.trace ? t('machine.logsTabSections.hide') : t('machine.logsTabSections.show')}</div>
                </button>
                {sectionsOpen.trace && (
                    <div className="border-t border-border-subtle p-3 min-h-[160px] max-h-[320px] overflow-y-auto font-mono text-2xs leading-relaxed">
                        {streams.traceLoading && visibleTraceEntries.length === 0 && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">{t('machine.logsTabSections.loadingDaemonTrace')}</div>
                        )}
                        {!streams.traceLoading && streams.traceFetchError && visibleTraceEntries.length === 0 && (
                            <div className="p-6 text-center text-red-300">{streams.traceFetchError}</div>
                        )}
                        {!streams.traceLoading && visibleTraceEntries.length === 0 && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">
                                {searchQuery.trim()
                                    ? t('machine.logsTabSections.noTraceEntriesMatchSearch')
                                    : streams.traceCategory === 'session_host'
                                        ? t('machine.logsTabSections.noSessionHostTraceYet')
                                        : t('machine.logsTabSections.noTraceEntriesYet')}
                            </div>
                        )}
                        {visibleTraceEntries.map((entry) => (
                            <div key={entry.id} className={`py-2 px-2 mb-2 rounded-lg border ${sectionTone(entry.level)}`}>
                                <div className="flex gap-2 text-3xs text-text-muted flex-wrap">
                                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                                    <span>{entry.level.toUpperCase()}</span>
                                    <span>{entry.category}.{entry.stage}</span>
                                    {entry.interactionId && <span>ix={entry.interactionId}</span>}
                                </div>
                                <div className="mt-1 break-words text-text-primary/90">{truncatePayload(entry.payload, 360) || t('machine.logsTabSections.noPayload')}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
                    onClick={() => setSectionsOpen((current) => ({ ...current, web: !current.web }))}
                >
                    <div>
                        <div className="text-3xs uppercase tracking-wider text-text-muted">{t('machine.logsTabSections.rawSourceBrowserEvents')}</div>
                        <div className="text-2xs text-text-secondary mt-1">{t('machine.logsTabSections.visibleBrowserEvents', { count: visibleWebEvents.length })}</div>
                    </div>
                    <div className="text-2xs text-text-muted">{sectionsOpen.web ? t('machine.logsTabSections.hide') : t('machine.logsTabSections.show')}</div>
                </button>
                {sectionsOpen.web && (
                    <div className="border-t border-border-subtle p-3 min-h-[140px] max-h-[260px] overflow-y-auto font-mono text-2xs leading-relaxed">
                        {visibleWebEvents.length === 0 && (
                            <div className="p-6 text-center text-text-muted">
                                {searchQuery.trim() ? t('machine.logsTabSections.noBrowserEventsMatchSearch') : t('machine.logsTabSections.noBrowserEventsYet')}
                            </div>
                        )}
                        {visibleWebEvents.map((entry) => (
                            <div key={entry.id} className="py-2 px-2 mb-2 rounded-lg border border-border-subtle bg-bg-primary">
                                <div className="flex gap-2 text-3xs text-text-muted flex-wrap">
                                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                                    <span>{entry.kind}</span>
                                    {entry.topic && <span>topic={entry.topic}</span>}
                                    {entry.interactionId && <span>ix={entry.interactionId}</span>}
                                </div>
                                <div className="mt-1 break-words text-text-primary/90">{truncatePayload(entry.payload, 360) || t('machine.logsTabSections.noPayload')}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
