import type { Dispatch, SetStateAction } from 'react'
import type { LogEntry } from './types'
import type { MachineDiagnosticsStreamsState } from '../../hooks/useMachineDiagnosticsStreams'
import { DEBUG_TRACE_FILTERS } from '../../utils/logs-trace-filters'
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

function formatTimestamp(ts: number | null): string {
    if (!ts) return 'Not yet loaded'
    return new Date(ts).toLocaleTimeString()
}

function formatDiagnosticTimestamp(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 365 * 24 * 60 * 60 * 1000) return 'raw file'
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

function sourceLabel(source: DiagnosticSource): string {
    if (source === 'daemon_log') return 'daemon'
    if (source === 'daemon_trace') return 'trace'
    if (source === 'browser_event') return 'browser'
    return 'raw file'
}

function DiagnosticEventRow({ event }: { event: DiagnosticEvent }) {
    return (
        <div className={`py-2 px-2 mb-2 rounded-lg border ${sectionTone(event.severity)}`}>
            <div className="flex gap-2 text-[10px] text-text-muted flex-wrap">
                <span>{formatDiagnosticTimestamp(event.ts)}</span>
                <span>{event.severity.toUpperCase()}</span>
                <span>{sourceLabel(event.source)}</span>
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
    return (
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2 items-center">
                <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mr-1">
                    View
                </span>
                <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-secondary p-1">
                    {([
                        { id: 'info', label: `Info+ (${quickFilterCounts.info})` },
                        { id: 'issues', label: `Issues (${quickFilterCounts.issues})` },
                        { id: 'all', label: `All (${quickFilterCounts.all})` },
                    ] as const).map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => onQuickFilterChange(option.id)}
                            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                                quickFilter === option.id
                                    ? 'bg-violet-500/15 text-violet-300 border border-violet-500/30'
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
                    placeholder="Search diagnostics…"
                    className="min-w-[220px] flex-1 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted"
                />
            </div>

            <div className="flex flex-wrap gap-2 items-center">
                <button onClick={onCopyDiagnostics} className="machine-btn">Copy diagnostics</button>
                <button onClick={onCopyVisible} className="machine-btn">Copy visible</button>
                <button
                    onClick={onToggleAutoRefresh}
                    className={`machine-btn ${autoRefresh ? 'text-green-500 border-green-500/30' : ''}`}
                >{autoRefresh ? '⏸ Pause' : '▶ Resume'}</button>
                <button onClick={onRefresh} className="machine-btn">↻ Refresh</button>
                <button onClick={onClear} className="machine-btn">Clear</button>
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
    return (
        <div className="rounded-xl border border-border-subtle bg-bg-secondary p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">Advanced source scope</span>
                    {(['debug', 'info', 'warn', 'error'] as const).map(level => (
                        <button
                            key={level}
                            onClick={() => onLogLevelChange(level)}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                logLevel === level ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                            }`}
                        >Daemon {level.toUpperCase()}+</button>
                    ))}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                    {DEBUG_TRACE_FILTERS.map((filter) => (
                        <button
                            key={filter.value}
                            onClick={() => onTraceCategoryChange(filter.value)}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                traceCategory === filter.value ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                            }`}
                        >
                            {filter.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
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
    const latestIssueTone = diagnosticsSummary.latestIssue?.severity === 'error' ? 'danger' : diagnosticsSummary.latestIssue?.severity === 'warn' ? 'warning' : 'good'
    const statusTone = daemonFetchError || traceFetchError ? 'danger' : autoRefresh ? 'good' : 'neutral'

    return (
        <div className="grid gap-3 md:grid-cols-3">
            <div className={`rounded-xl border p-3 ${summaryCardTone(diagnosticsSummary.issueCount > 0 ? 'warning' : 'good')}`}>
                <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Diagnostics timeline</div>
                <div className="text-[13px] text-text-primary font-medium">
                    {diagnosticEventsCount} visible event(s) · {diagnosticsSummary.issueCount} issue signal(s)
                </div>
                <div className="text-[11px] text-text-secondary mt-1">
                    {searchQuery.trim() ? `Filtered by “${searchQuery.trim()}”` : 'Daemon, trace, and browser signals merged by time'}
                </div>
            </div>

            <div className={`rounded-xl border p-3 ${summaryCardTone(latestIssueTone)}`}>
                <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Latest issue</div>
                {diagnosticsSummary.latestIssue ? (
                    <>
                        <div className="text-[13px] text-text-primary font-medium">
                            {sourceLabel(diagnosticsSummary.latestIssue.source)} · {diagnosticsSummary.latestIssue.severity.toUpperCase()}
                        </div>
                        <div className="text-[11px] text-text-secondary mt-1 line-clamp-2">
                            {diagnosticsSummary.latestIssue.message}
                        </div>
                        <div className="text-[10px] text-text-muted mt-2">
                            {formatDiagnosticTimestamp(diagnosticsSummary.latestIssue.ts)}
                        </div>
                    </>
                ) : (
                    <>
                        <div className="text-[13px] text-text-primary font-medium">No visible warn/error signal</div>
                        <div className="text-[11px] text-text-secondary mt-1">Use Issues or All if you need a narrower or rawer view.</div>
                    </>
                )}
            </div>

            <div className={`rounded-xl border p-3 ${summaryCardTone(statusTone)}`}>
                <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Source status</div>
                <div className="text-[13px] text-text-primary font-medium">
                    {daemonFetchError || traceFetchError ? 'Needs attention' : autoRefresh ? 'Live polling every 3s' : 'Paused'}
                </div>
                <div className="text-[11px] text-text-secondary mt-1">
                    Last update: {formatTimestamp(lastUpdatedAt)}
                </div>
                <div className="text-[10px] text-text-muted mt-2 space-y-1">
                    {sourceStates.map((source) => (
                        <div key={source.id}>{source.label}: {source.status}</div>
                    ))}
                </div>
            </div>
        </div>
    )
}

export function RepeatedPatternsPanel({ patterns }: { patterns: DiagnosticRepeatedPattern[] }) {
    if (patterns.length === 0) return null

    return (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Repeated issue patterns</div>
            <div className="grid gap-2 md:grid-cols-2">
                {patterns.map((pattern) => (
                    <div key={pattern.key} className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-2">
                        <div className="text-[12px] text-text-primary font-medium">{pattern.count}× {pattern.severity.toUpperCase()} · {sourceLabel(pattern.source)}</div>
                        <div className="text-[11px] text-text-secondary mt-1 line-clamp-2">{pattern.message}</div>
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
    return (
        <div className="grid gap-3">
            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
                    onClick={() => setSectionsOpen((current) => ({ ...current, timeline: !current.timeline }))}
                >
                    <div>
                        <div className="text-[10px] uppercase tracking-wider text-text-muted">Unified timeline</div>
                        <div className="text-[11px] text-text-secondary mt-1">{diagnosticEvents.length} visible diagnostic event(s)</div>
                    </div>
                    <div className="text-[11px] text-text-muted">{sectionsOpen.timeline ? 'Hide' : 'Show'}</div>
                </button>
                {sectionsOpen.timeline && (
                    <div className="border-t border-border-subtle p-3 min-h-[180px] max-h-[440px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                        {(streams.daemonLoading || streams.traceLoading) && diagnosticEvents.length === 0 && !streams.daemonFetchError && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">Loading diagnostics…</div>
                        )}
                        {(streams.daemonFetchError || streams.traceFetchError) && diagnosticEvents.length === 0 && (
                            <div className="p-6 text-center text-red-300 space-y-1">
                                {streams.daemonFetchError && <div>Daemon logs: {streams.daemonFetchError}</div>}
                                {streams.traceFetchError && <div>Daemon trace: {streams.traceFetchError}</div>}
                            </div>
                        )}
                        {!streams.daemonLoading && !streams.traceLoading && diagnosticEvents.length === 0 && !streams.daemonFetchError && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">No diagnostics match the current view.</div>
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
                        <div className="text-[10px] uppercase tracking-wider text-text-muted">Raw source · daemon logs</div>
                        <div className="text-[11px] text-text-secondary mt-1">
                            {streams.daemonLogKind === 'text'
                                ? `${visibleDaemonRawLines.length} visible raw line(s) from file fallback`
                                : `${visibleDaemonLogs.length} visible structured line(s)`}
                        </div>
                    </div>
                    <div className="text-[11px] text-text-muted">{sectionsOpen.daemon ? 'Hide' : 'Show'}</div>
                </button>
                {sectionsOpen.daemon && (
                    <div className="border-t border-border-subtle p-3 min-h-[160px] max-h-[360px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                        {streams.daemonLoading && visibleDaemonLogs.length === 0 && visibleDaemonRawLines.length === 0 && !streams.daemonFetchError && (
                            <div className="p-6 text-center text-text-muted">Loading daemon logs…</div>
                        )}
                        {!streams.daemonLoading && streams.daemonFetchError && streams.daemonLogKind === 'empty' && (
                            <div className="p-6 text-center text-red-300">{streams.daemonFetchError}</div>
                        )}
                        {!streams.daemonLoading && streams.daemonLogKind === 'empty' && !streams.daemonFetchError && (
                            <div className="p-6 text-center text-text-muted">No daemon logs captured yet for this machine.</div>
                        )}
                        {streams.daemonLogKind === 'text' && visibleDaemonRawLines.length === 0 && streams.daemonRawText && (
                            <div className="p-6 text-center text-text-muted">{quickFilter === 'all' ? 'No raw daemon log lines match the current search.' : 'Raw file-fallback logs are available only in All view.'}</div>
                        )}
                        {streams.daemonLogKind === 'structured' && visibleDaemonLogs.length === 0 && streams.daemonLogs.length > 0 && (
                            <div className="p-6 text-center text-text-muted">No structured daemon logs match the current view.</div>
                        )}
                        {streams.daemonLogKind === 'text' && visibleDaemonRawLines.map((line, index) => (
                            <div key={`raw-${index}`} className="py-0.5 text-text-secondary whitespace-pre-wrap break-words">{line}</div>
                        ))}
                        {streams.daemonLogKind !== 'text' && visibleDaemonLogs.map((log, index) => (
                            <div key={`log-${index}`} className={`flex gap-2 py-1 px-2 mb-1 rounded-lg border ${sectionTone(log.level)}`}>
                                <span className="text-text-muted min-w-[75px] shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                <span className="font-semibold min-w-[32px] shrink-0 text-[9px]">{log.level === 'error' ? 'ERR' : log.level === 'warn' ? 'WRN' : log.level === 'debug' ? 'DBG' : 'INF'}</span>
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
                        <div className="text-[10px] uppercase tracking-wider text-text-muted">
                            Raw source · daemon trace
                            {streams.traceCategory === 'session_host' ? ' · session_host only' : ''}
                        </div>
                        <div className="text-[11px] text-text-secondary mt-1">{visibleTraceEntries.length} visible trace event(s)</div>
                    </div>
                    <div className="text-[11px] text-text-muted">{sectionsOpen.trace ? 'Hide' : 'Show'}</div>
                </button>
                {sectionsOpen.trace && (
                    <div className="border-t border-border-subtle p-3 min-h-[160px] max-h-[320px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                        {streams.traceLoading && visibleTraceEntries.length === 0 && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">Loading daemon trace…</div>
                        )}
                        {!streams.traceLoading && streams.traceFetchError && visibleTraceEntries.length === 0 && (
                            <div className="p-6 text-center text-red-300">{streams.traceFetchError}</div>
                        )}
                        {!streams.traceLoading && visibleTraceEntries.length === 0 && !streams.traceFetchError && (
                            <div className="p-6 text-center text-text-muted">
                                {searchQuery.trim()
                                    ? 'No trace entries match the current search.'
                                    : streams.traceCategory === 'session_host'
                                        ? 'No session_host trace entries yet. This filter uses get_debug_trace(category=session_host).'
                                        : 'No trace entries yet. Run daemon with --dev or --trace.'}
                            </div>
                        )}
                        {visibleTraceEntries.map((entry) => (
                            <div key={entry.id} className={`py-2 px-2 mb-2 rounded-lg border ${sectionTone(entry.level)}`}>
                                <div className="flex gap-2 text-[10px] text-text-muted flex-wrap">
                                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                                    <span>{entry.level.toUpperCase()}</span>
                                    <span>{entry.category}.{entry.stage}</span>
                                    {entry.interactionId && <span>ix={entry.interactionId}</span>}
                                </div>
                                <div className="mt-1 break-words text-text-primary/90">{truncatePayload(entry.payload, 360) || 'No payload'}</div>
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
                        <div className="text-[10px] uppercase tracking-wider text-text-muted">Raw source · browser debug events</div>
                        <div className="text-[11px] text-text-secondary mt-1">{visibleWebEvents.length} visible browser event(s)</div>
                    </div>
                    <div className="text-[11px] text-text-muted">{sectionsOpen.web ? 'Hide' : 'Show'}</div>
                </button>
                {sectionsOpen.web && (
                    <div className="border-t border-border-subtle p-3 min-h-[140px] max-h-[260px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                        {visibleWebEvents.length === 0 && (
                            <div className="p-6 text-center text-text-muted">
                                {searchQuery.trim() ? 'No browser debug events match the current search.' : 'No browser debug events captured yet.'}
                            </div>
                        )}
                        {visibleWebEvents.map((entry) => (
                            <div key={entry.id} className="py-2 px-2 mb-2 rounded-lg border border-border-subtle bg-bg-primary">
                                <div className="flex gap-2 text-[10px] text-text-muted flex-wrap">
                                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                                    <span>{entry.kind}</span>
                                    {entry.topic && <span>topic={entry.topic}</span>}
                                    {entry.interactionId && <span>ix={entry.interactionId}</span>}
                                </div>
                                <div className="mt-1 break-words text-text-primary/90">{truncatePayload(entry.payload, 360) || 'No payload'}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
