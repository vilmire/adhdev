/**
 * LogsTab — summary-first diagnostics surface with a unified timeline and collapsible raw sources.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { eventManager } from '../../managers/EventManager'
import { useMachineDiagnosticsStreams } from '../../hooks/useMachineDiagnosticsStreams'
import { buildDiagnosticBundle } from '../../utils/diagnostics-model'
import { buildVisibleLogsExport } from '../../utils/logs-surface'
import {
    buildLogsDiagnosticsViewModel,
    type LogsQuickFilter,
} from '../../utils/logs-diagnostics-view-model'
import {
    AdvancedSourceScope,
    DiagnosticsSections,
    DiagnosticsSummaryCards,
    LogsToolbar,
    RepeatedPatternsPanel,
    type LogsSectionsOpenState,
} from './LogsTabSections'

interface LogsTabProps {
    machineId: string
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export default function LogsTab({ machineId, sendDaemonCommand }: LogsTabProps) {
    const streams = useMachineDiagnosticsStreams({ machineId, sendDaemonCommand })
    const [quickFilter, setQuickFilter] = useState<LogsQuickFilter>('info')
    const [searchQuery, setSearchQuery] = useState('')
    const [sectionsOpen, setSectionsOpen] = useState<LogsSectionsOpenState>({ timeline: true, daemon: false, trace: false, web: false })
    const logsEndRef = useRef<HTMLDivElement>(null)
    const initialScrollDone = useRef(false)

    const viewModel = useMemo(
        () => buildLogsDiagnosticsViewModel({
            daemonLogs: streams.daemonLogs,
            daemonRawText: streams.daemonRawText,
            daemonLogKind: streams.daemonLogKind,
            debugTrace: streams.debugTrace,
            webEvents: streams.webEvents,
            traceCategory: streams.traceCategory,
            quickFilter,
            searchQuery,
            daemonLoading: streams.daemonLoading,
            traceLoading: streams.traceLoading,
            daemonFetchError: streams.daemonFetchError,
            traceFetchError: streams.traceFetchError,
        }),
        [
            quickFilter,
            searchQuery,
            streams.daemonFetchError,
            streams.daemonLoading,
            streams.daemonLogKind,
            streams.daemonLogs,
            streams.daemonRawText,
            streams.debugTrace,
            streams.traceCategory,
            streams.traceFetchError,
            streams.traceLoading,
            streams.webEvents,
        ],
    )

    useEffect(() => {
        if (streams.autoRefresh && viewModel.diagnosticEvents.length > 0) {
            const behavior = initialScrollDone.current ? 'smooth' : 'instant' as ScrollBehavior
            setTimeout(() => {
                logsEndRef.current?.scrollIntoView({ behavior })
                initialScrollDone.current = true
            }, 50)
        }
    }, [viewModel.diagnosticEvents.length, streams.autoRefresh])

    const handleCopyVisible = useCallback(async () => {
        const rendered = buildVisibleLogsExport({
            daemonLogs: viewModel.visibleDaemonLogs,
            daemonRawLines: viewModel.visibleDaemonRawLines,
            trace: viewModel.visibleTraceEntries,
            webEvents: viewModel.visibleWebEvents,
        })
        if (!rendered.trim()) {
            eventManager.showToast('No visible logs to copy.', 'info')
            return
        }
        try {
            await navigator.clipboard?.writeText(rendered)
            eventManager.showToast('Copied visible logs to clipboard.', 'success')
        } catch (cause) {
            eventManager.showToast(cause instanceof Error ? cause.message : 'Could not copy visible logs', 'warning')
        }
    }, [viewModel.visibleDaemonLogs, viewModel.visibleDaemonRawLines, viewModel.visibleTraceEntries, viewModel.visibleWebEvents])

    const handleCopyDiagnosticBundle = useCallback(async () => {
        const rendered = buildDiagnosticBundle({
            events: viewModel.diagnosticEvents,
            summary: viewModel.diagnosticsSummary,
            sources: viewModel.sourceStates,
        })
        try {
            await navigator.clipboard?.writeText(rendered)
            eventManager.showToast('Copied diagnostic bundle to clipboard.', 'success')
        } catch (cause) {
            eventManager.showToast(cause instanceof Error ? cause.message : 'Could not copy diagnostic bundle', 'warning')
        }
    }, [viewModel.diagnosticEvents, viewModel.diagnosticsSummary, viewModel.sourceStates])

    return (
        <div className="space-y-4">
            <LogsToolbar
                quickFilter={quickFilter}
                quickFilterCounts={viewModel.quickFilterCounts}
                searchQuery={searchQuery}
                autoRefresh={streams.autoRefresh}
                onQuickFilterChange={setQuickFilter}
                onSearchQueryChange={setSearchQuery}
                onCopyDiagnostics={() => { void handleCopyDiagnosticBundle() }}
                onCopyVisible={() => { void handleCopyVisible() }}
                onToggleAutoRefresh={() => streams.setAutoRefresh((value) => !value)}
                onRefresh={streams.refresh}
                onClear={streams.clear}
            />

            <AdvancedSourceScope
                logLevel={streams.logLevel}
                traceCategory={streams.traceCategory}
                onLogLevelChange={streams.setLogLevel}
                onTraceCategoryChange={streams.setTraceCategory}
            />

            <DiagnosticsSummaryCards
                diagnosticsSummary={viewModel.diagnosticsSummary}
                diagnosticEventsCount={viewModel.diagnosticEvents.length}
                sourceStates={viewModel.sourceStates}
                searchQuery={searchQuery}
                lastUpdatedAt={streams.lastUpdatedAt}
                autoRefresh={streams.autoRefresh}
                daemonFetchError={streams.daemonFetchError}
                traceFetchError={streams.traceFetchError}
            />

            <RepeatedPatternsPanel patterns={viewModel.diagnosticsSummary.repeatedPatterns} />

            <DiagnosticsSections
                streams={streams}
                sectionsOpen={sectionsOpen}
                setSectionsOpen={setSectionsOpen}
                diagnosticEvents={viewModel.diagnosticEvents}
                visibleDaemonLogs={viewModel.visibleDaemonLogs}
                visibleDaemonRawLines={viewModel.visibleDaemonRawLines}
                visibleTraceEntries={viewModel.visibleTraceEntries}
                visibleWebEvents={viewModel.visibleWebEvents}
                quickFilter={quickFilter}
                searchQuery={searchQuery}
            />
            <div ref={logsEndRef} />
        </div>
    )
}
