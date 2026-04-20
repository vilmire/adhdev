/**
 * LogsTab — Daemon log viewer with summary cards, searchable raw streams, and explicit fetch state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry } from './types'
import { webDebugStore } from '../../debug/webDebugStore'
import { eventManager } from '../../managers/EventManager'
import {
    DEBUG_TRACE_FILTERS,
    buildDebugTraceQuery,
    filterDebugTraceEntries,
    type DebugTraceCategoryFilter,
} from '../../utils/logs-trace-filters'
import {
    buildVisibleLogsExport,
    filterDaemonLogEntries,
    filterDaemonRawLines,
    filterTraceEntries,
    filterWebEntries,
    getQuickFilterCounts,
    normalizeDaemonLogsPayload,
    summarizeLogsSurface,
    truncatePayload,
    type DaemonLogPayloadKind,
    type LogsSurfaceTraceEntry,
    type LogsSurfaceWebEntry,
} from '../../utils/logs-surface'

interface LogsTabProps {
    machineId: string
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

type LogsQuickFilter = 'all' | 'info' | 'issues'

function formatTimestamp(ts: number | null): string {
    if (!ts) return 'Not yet loaded'
    return new Date(ts).toLocaleTimeString()
}

function sectionTone(level: 'debug' | 'info' | 'warn' | 'error'): string {
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

export default function LogsTab({ machineId, sendDaemonCommand }: LogsTabProps) {
    const [daemonLogs, setDaemonLogs] = useState<LogEntry[]>([])
    const [daemonLogKind, setDaemonLogKind] = useState<DaemonLogPayloadKind>('empty')
    const [daemonRawText, setDaemonRawText] = useState('')
    const [debugTrace, setDebugTrace] = useState<LogsSurfaceTraceEntry[]>([])
    const [webEvents, setWebEvents] = useState<LogsSurfaceWebEntry[]>([])
    const [lastLogTs, setLastLogTs] = useState(0)
    const [lastTraceTs, setLastTraceTs] = useState(0)
    const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
    const [autoRefresh, setAutoRefresh] = useState(true)
    const [logLevel, setLogLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('info')
    const [quickFilter, setQuickFilter] = useState<LogsQuickFilter>('info')
    const [traceCategory, setTraceCategory] = useState<DebugTraceCategoryFilter>('all')
    const [searchQuery, setSearchQuery] = useState('')
    const [daemonLoading, setDaemonLoading] = useState(true)
    const [traceLoading, setTraceLoading] = useState(true)
    const [daemonFetchError, setDaemonFetchError] = useState('')
    const [traceFetchError, setTraceFetchError] = useState('')
    const [reloadToken, setReloadToken] = useState(0)
    const [sectionsOpen, setSectionsOpen] = useState({ daemon: true, trace: false, web: false })
    const logsEndRef = useRef<HTMLDivElement>(null)
    const initialScrollDone = useRef(false)

    const filteredDebugTrace = useMemo(
        () => filterDebugTraceEntries(debugTrace, traceCategory),
        [debugTrace, traceCategory],
    )
    const filteredDaemonLogs = useMemo(
        () => filterDaemonLogEntries(daemonLogs, searchQuery),
        [daemonLogs, searchQuery],
    )
    const filteredDaemonRawLines = useMemo(
        () => filterDaemonRawLines(daemonRawText, searchQuery),
        [daemonRawText, searchQuery],
    )
    const filteredTraceEntries = useMemo(
        () => filterTraceEntries(filteredDebugTrace, searchQuery),
        [filteredDebugTrace, searchQuery],
    )
    const filteredWebEvents = useMemo(
        () => filterWebEntries(webEvents, searchQuery),
        [webEvents, searchQuery],
    )
    const visibleDaemonLogs = useMemo(
        () => quickFilter === 'issues'
            ? filteredDaemonLogs.filter((entry) => entry.level === 'warn' || entry.level === 'error')
            : quickFilter === 'info'
                ? filteredDaemonLogs.filter((entry) => entry.level !== 'debug')
                : filteredDaemonLogs,
        [filteredDaemonLogs, quickFilter],
    )
    const visibleDaemonRawLines = useMemo(
        () => quickFilter === 'all' ? filteredDaemonRawLines : [],
        [filteredDaemonRawLines, quickFilter],
    )
    const visibleTraceEntries = useMemo(
        () => quickFilter === 'issues'
            ? filteredTraceEntries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
            : quickFilter === 'info'
                ? filteredTraceEntries.filter((entry) => entry.level !== 'debug')
                : filteredTraceEntries,
        [filteredTraceEntries, quickFilter],
    )
    const visibleWebEvents = useMemo(
        () => quickFilter === 'issues' ? [] : filteredWebEvents,
        [filteredWebEvents, quickFilter],
    )
    const quickFilterCounts = useMemo(
        () => getQuickFilterCounts({
            daemonLogs: filteredDaemonLogs,
            daemonRawLines: filteredDaemonRawLines,
            trace: filteredTraceEntries,
            webEvents: filteredWebEvents,
        }),
        [filteredDaemonLogs, filteredDaemonRawLines, filteredTraceEntries, filteredWebEvents],
    )
    const summary = useMemo(
        () => summarizeLogsSurface({
            daemonLogs,
            trace: filteredDebugTrace,
            webEvents,
            daemonLogKind,
            daemonFetchError,
            traceFetchError,
            searchQuery,
        }),
        [daemonFetchError, daemonLogKind, daemonLogs, filteredDebugTrace, searchQuery, traceFetchError, webEvents],
    )

    const fetchDebugData = useCallback(async () => {
        if (!machineId) return

        const [logsRes, traceRes] = await Promise.allSettled([
            sendDaemonCommand(machineId, 'get_logs', { count: 200, minLevel: logLevel, since: lastLogTs }),
            sendDaemonCommand(machineId, 'get_debug_trace', buildDebugTraceQuery({ count: 120, since: lastTraceTs, category: traceCategory })),
        ])

        if (logsRes.status === 'fulfilled') {
            const rawLogsRes = logsRes.value
            const logsPayload = rawLogsRes?.result || rawLogsRes
            const normalized = normalizeDaemonLogsPayload(logsPayload)
            setDaemonLoading(false)
            setDaemonFetchError(rawLogsRes?.success === false ? String(rawLogsRes?.error || 'Could not load daemon logs') : '')
            setDaemonLogKind(normalized.kind)
            setDaemonRawText(normalized.rawText)
            if (normalized.entries.length > 0) {
                setDaemonLogs((prev) => {
                    const next = lastLogTs > 0 ? [...prev, ...normalized.entries] : normalized.entries
                    return next.slice(-300)
                })
                const maxTs = normalized.entries.reduce((max, entry) => Math.max(max, Number(entry.timestamp || 0)), lastLogTs)
                if (maxTs > lastLogTs) setLastLogTs(maxTs)
            } else if (normalized.kind !== 'structured' && lastLogTs === 0) {
                setDaemonLogs([])
            }
        } else {
            setDaemonLoading(false)
            setDaemonFetchError(logsRes.reason instanceof Error ? logsRes.reason.message : 'Could not load daemon logs')
        }

        if (traceRes.status === 'fulfilled') {
            const rawTraceRes = traceRes.value
            const tracePayload = rawTraceRes?.result || rawTraceRes
            if (rawTraceRes?.success === false) {
                setTraceFetchError(String(rawTraceRes?.error || 'Could not load daemon trace'))
            } else if (Array.isArray(tracePayload?.trace)) {
                setTraceFetchError('')
                setDebugTrace(tracePayload.trace.slice(-120) as LogsSurfaceTraceEntry[])
                const maxTraceTs = tracePayload.trace.reduce((max: number, entry: { ts?: unknown }) => Math.max(max, Number(entry.ts || 0)), lastTraceTs)
                if (maxTraceTs > lastTraceTs) setLastTraceTs(maxTraceTs)
            } else {
                setTraceFetchError('')
                setDebugTrace([])
            }
            setTraceLoading(false)
        } else {
            setTraceLoading(false)
            setTraceFetchError(traceRes.reason instanceof Error ? traceRes.reason.message : 'Could not load daemon trace')
        }

        setWebEvents(webDebugStore.list({ limit: 120 }) as LogsSurfaceWebEntry[])
        setLastUpdatedAt(Date.now())
    }, [lastLogTs, lastTraceTs, logLevel, machineId, sendDaemonCommand, traceCategory])

    useEffect(() => {
        if (!machineId) return
        void fetchDebugData()
        if (!autoRefresh) return
        const timer = setInterval(() => {
            void fetchDebugData()
        }, 3000)
        return () => clearInterval(timer)
    }, [autoRefresh, fetchDebugData, machineId, reloadToken])

    useEffect(() => {
        if (autoRefresh && (visibleDaemonLogs.length > 0 || visibleDaemonRawLines.length > 0 || visibleTraceEntries.length > 0 || visibleWebEvents.length > 0)) {
            const behavior = initialScrollDone.current ? 'smooth' : 'instant' as ScrollBehavior
            setTimeout(() => {
                logsEndRef.current?.scrollIntoView({ behavior })
                initialScrollDone.current = true
            }, 50)
        }
    }, [visibleDaemonLogs.length, visibleDaemonRawLines.length, visibleTraceEntries.length, visibleWebEvents.length, autoRefresh])

    useEffect(() => {
        setDebugTrace([])
        setLastTraceTs(0)
        setTraceLoading(true)
    }, [traceCategory])

    const latestIssueTone = summary.latestIssue?.level === 'error' ? 'danger' : summary.latestIssue?.level === 'warn' ? 'warning' : 'good'
    const statusTone = daemonFetchError || traceFetchError ? 'danger' : autoRefresh ? 'good' : 'neutral'

    const handleCopyVisible = useCallback(async () => {
        const rendered = buildVisibleLogsExport({
            daemonLogs: visibleDaemonLogs,
            daemonRawLines: visibleDaemonRawLines,
            trace: visibleTraceEntries,
            webEvents: visibleWebEvents,
        })
        if (!rendered.trim()) {
            eventManager.showToast('복사할 visible logs가 없습니다.', 'info')
            return
        }
        try {
            await navigator.clipboard?.writeText(rendered)
            eventManager.showToast('Visible logs를 클립보드에 복사했습니다.', 'success')
        } catch (cause) {
            eventManager.showToast(cause instanceof Error ? cause.message : 'Could not copy visible logs', 'warning')
        }
    }, [visibleDaemonLogs, visibleDaemonRawLines, visibleTraceEntries, visibleWebEvents])

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mr-1">
                        Level
                    </span>
                    {(['debug', 'info', 'warn', 'error'] as const).map(level => (
                        <button
                            key={level}
                            onClick={() => {
                                setLogLevel(level)
                                setDaemonLogs([])
                                setDaemonRawText('')
                                setDaemonLogKind('empty')
                                setLastLogTs(0)
                                setDaemonLoading(true)
                            }}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                logLevel === level ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                            }`}
                        >{level.toUpperCase()}</button>
                    ))}
                    <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider ml-3 mr-1">
                        Trace
                    </span>
                    {DEBUG_TRACE_FILTERS.map((filter) => (
                        <button
                            key={filter.value}
                            onClick={() => setTraceCategory(filter.value)}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                traceCategory === filter.value ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                            }`}
                        >
                            {filter.label}
                        </button>
                    ))}
                </div>

                <div className="flex flex-wrap gap-2 items-center">
                    <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-secondary p-1">
                        {([
                            { id: 'info', label: `Info+ (${quickFilterCounts.info})` },
                            { id: 'issues', label: `Issues (${quickFilterCounts.issues})` },
                            { id: 'all', label: `All (${quickFilterCounts.all})` },
                        ] as const).map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                onClick={() => setQuickFilter(option.id)}
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
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Search visible logs, trace, events…"
                        className="min-w-[220px] flex-1 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted"
                    />
                    <button
                        onClick={() => { void handleCopyVisible() }}
                        className="machine-btn"
                    >Copy visible</button>
                    <button
                        onClick={() => setAutoRefresh((value) => !value)}
                        className={`machine-btn ${autoRefresh ? 'text-green-500 border-green-500/30' : ''}`}
                    >{autoRefresh ? '⏸ Pause' : '▶ Resume'}</button>
                    <button
                        onClick={() => setReloadToken((value) => value + 1)}
                        className="machine-btn"
                    >↻ Refresh</button>
                    <button
                        onClick={() => {
                            setDaemonLogs([])
                            setDaemonRawText('')
                            setDaemonLogKind('empty')
                            setDebugTrace([])
                            setWebEvents([])
                            setLastLogTs(0)
                            setLastTraceTs(0)
                            setLastUpdatedAt(null)
                            setDaemonFetchError('')
                            setTraceFetchError('')
                            setDaemonLoading(true)
                            setTraceLoading(true)
                            webDebugStore.clear()
                        }}
                        className="machine-btn"
                    >Clear</button>
                </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
                <div className={`rounded-xl border p-3 ${summaryCardTone(summary.issueCount > 0 ? 'warning' : 'good')}`}>
                    <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Visible signals</div>
                    <div className="text-[13px] text-text-primary font-medium">
                        daemon {visibleDaemonLogs.length + visibleDaemonRawLines.length} · trace {visibleTraceEntries.length} · web {visibleWebEvents.length}
                    </div>
                    <div className="text-[11px] text-text-secondary mt-1">
                        {searchQuery.trim() ? `Filtered by “${searchQuery.trim()}”` : 'Showing the latest buffered entries'}
                    </div>
                </div>

                <div className={`rounded-xl border p-3 ${summaryCardTone(latestIssueTone)}`}>
                    <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Attention needed</div>
                    {summary.latestIssue ? (
                        <>
                            <div className="text-[13px] text-text-primary font-medium">
                                {summary.latestIssue.source} · {summary.latestIssue.label}
                            </div>
                            <div className="text-[11px] text-text-secondary mt-1 line-clamp-2">
                                {summary.latestIssue.detail}
                            </div>
                            <div className="text-[10px] text-text-muted mt-2">
                                {summary.issueCount} warn/error signal(s) · {formatTimestamp(summary.latestIssue.timestamp)}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="text-[13px] text-text-primary font-medium">No recent warn/error signal</div>
                            <div className="text-[11px] text-text-secondary mt-1">Use search or lower the log level if you need more context.</div>
                        </>
                    )}
                </div>

                <div className={`rounded-xl border p-3 ${summaryCardTone(statusTone)}`}>
                    <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Fetch status</div>
                    <div className="text-[13px] text-text-primary font-medium">
                        {daemonFetchError || traceFetchError ? 'Needs attention' : autoRefresh ? 'Live polling every 3s' : 'Paused'}
                    </div>
                    <div className="text-[11px] text-text-secondary mt-1">
                        Last update: {formatTimestamp(lastUpdatedAt)}
                    </div>
                    {(daemonFetchError || traceFetchError) && (
                        <div className="text-[11px] text-red-300 mt-2 space-y-1">
                            {daemonFetchError && <div>Daemon logs: {daemonFetchError}</div>}
                            {traceFetchError && <div>Daemon trace: {traceFetchError}</div>}
                        </div>
                    )}
                </div>
            </div>

            <div className="grid gap-3">
                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                    <button
                        type="button"
                        className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
                        onClick={() => setSectionsOpen((current) => ({ ...current, daemon: !current.daemon }))}
                    >
                        <div>
                            <div className="text-[10px] uppercase tracking-wider text-text-muted">Daemon logs</div>
                            <div className="text-[11px] text-text-secondary mt-1">
                                {daemonLogKind === 'text'
                                    ? `${visibleDaemonRawLines.length} visible raw line(s) from file fallback`
                                    : `${visibleDaemonLogs.length} visible structured line(s)`}
                            </div>
                        </div>
                        <div className="text-[11px] text-text-muted">{sectionsOpen.daemon ? 'Hide' : 'Show'}</div>
                    </button>
                    {sectionsOpen.daemon && (
                        <div className="border-t border-border-subtle p-3 min-h-[160px] max-h-[360px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                            {daemonLoading && !summary.hasAnyData && !daemonFetchError && (
                                <div className="p-6 text-center text-text-muted">Loading daemon logs…</div>
                            )}
                            {!daemonLoading && daemonFetchError && daemonLogKind === 'empty' && (
                                <div className="p-6 text-center text-red-300">{daemonFetchError}</div>
                            )}
                            {!daemonLoading && daemonLogKind === 'empty' && !daemonFetchError && (
                                <div className="p-6 text-center text-text-muted">No daemon logs captured yet for this machine.</div>
                            )}
                            {daemonLogKind === 'text' && visibleDaemonRawLines.length === 0 && daemonRawText && (
                                <div className="p-6 text-center text-text-muted">{quickFilter === 'all' ? 'No raw daemon log lines match the current search.' : 'Raw file-fallback logs are available only in All view.'}</div>
                            )}
                            {daemonLogKind === 'structured' && visibleDaemonLogs.length === 0 && daemonLogs.length > 0 && (
                                <div className="p-6 text-center text-text-muted">No structured daemon logs match the current view.</div>
                            )}
                            {daemonLogKind === 'text' && visibleDaemonRawLines.map((line, index) => (
                                <div key={`raw-${index}`} className="py-0.5 text-text-secondary whitespace-pre-wrap break-words">{line}</div>
                            ))}
                            {daemonLogKind !== 'text' && visibleDaemonLogs.map((log, index) => (
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
                                Structured daemon trace
                                {traceCategory === 'session_host' ? ' · session_host only' : ''}
                            </div>
                            <div className="text-[11px] text-text-secondary mt-1">{visibleTraceEntries.length} visible trace event(s)</div>
                        </div>
                        <div className="text-[11px] text-text-muted">{sectionsOpen.trace ? 'Hide' : 'Show'}</div>
                    </button>
                    {sectionsOpen.trace && (
                        <div className="border-t border-border-subtle p-3 min-h-[160px] max-h-[320px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                            {traceLoading && visibleTraceEntries.length === 0 && !traceFetchError && (
                                <div className="p-6 text-center text-text-muted">Loading daemon trace…</div>
                            )}
                            {!traceLoading && traceFetchError && visibleTraceEntries.length === 0 && (
                                <div className="p-6 text-center text-red-300">{traceFetchError}</div>
                            )}
                            {!traceLoading && visibleTraceEntries.length === 0 && !traceFetchError && (
                                <div className="p-6 text-center text-text-muted">
                                    {searchQuery.trim()
                                        ? 'No trace entries match the current search.'
                                        : traceCategory === 'session_host'
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
                            <div className="text-[10px] uppercase tracking-wider text-text-muted">Browser debug events</div>
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
            <div ref={logsEndRef} />
        </div>
    )
}
