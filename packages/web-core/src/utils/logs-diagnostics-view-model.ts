import type { LogEntry } from '../pages/machine/types'
import type { DebugTraceCategoryFilter } from './logs-trace-filters'
import { filterDebugTraceEntries } from './logs-trace-filters'
import {
  buildDiagnosticEvents,
  buildDiagnosticSourceStates,
  summarizeDiagnosticEvents,
  type DiagnosticEvent,
  type DiagnosticSourceState,
  type DiagnosticsSummary,
} from './diagnostics-model'
import {
  filterDaemonLogEntries,
  filterDaemonRawLines,
  filterTraceEntries,
  filterWebEntries,
  getQuickFilterCounts,
  type DaemonLogPayloadKind,
  type LogsQuickFilterCounts,
  type LogsSurfaceTraceEntry,
  type LogsSurfaceWebEntry,
} from './logs-surface'

export type LogsQuickFilter = 'all' | 'info' | 'issues'

export interface BuildLogsDiagnosticsViewModelOptions {
  daemonLogs: LogEntry[]
  daemonRawText: string
  daemonLogKind: DaemonLogPayloadKind
  debugTrace: LogsSurfaceTraceEntry[]
  webEvents: LogsSurfaceWebEntry[]
  traceCategory: DebugTraceCategoryFilter
  quickFilter: LogsQuickFilter
  searchQuery: string
  daemonLoading: boolean
  traceLoading: boolean
  daemonFetchError: string
  traceFetchError: string
}

export interface LogsDiagnosticsViewModel {
  filteredDaemonLogs: LogEntry[]
  filteredDaemonRawLines: string[]
  filteredTraceEntries: LogsSurfaceTraceEntry[]
  filteredWebEvents: LogsSurfaceWebEntry[]
  visibleDaemonLogs: LogEntry[]
  visibleDaemonRawLines: string[]
  visibleTraceEntries: LogsSurfaceTraceEntry[]
  visibleWebEvents: LogsSurfaceWebEntry[]
  quickFilterCounts: LogsQuickFilterCounts
  diagnosticEvents: DiagnosticEvent[]
  diagnosticsSummary: DiagnosticsSummary
  sourceStates: DiagnosticSourceState[]
}

function visibleDaemonLogsForFilter(entries: LogEntry[], quickFilter: LogsQuickFilter): LogEntry[] {
  if (quickFilter === 'issues') return entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
  if (quickFilter === 'info') return entries.filter((entry) => entry.level !== 'debug')
  return entries
}

function visibleTraceEntriesForFilter(entries: LogsSurfaceTraceEntry[], quickFilter: LogsQuickFilter): LogsSurfaceTraceEntry[] {
  if (quickFilter === 'issues') return entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
  if (quickFilter === 'info') return entries.filter((entry) => entry.level !== 'debug')
  return entries
}

export function buildLogsDiagnosticsViewModel({
  daemonLogs,
  daemonRawText,
  daemonLogKind,
  debugTrace,
  webEvents,
  traceCategory,
  quickFilter,
  searchQuery,
  daemonLoading,
  traceLoading,
  daemonFetchError,
  traceFetchError,
}: BuildLogsDiagnosticsViewModelOptions): LogsDiagnosticsViewModel {
  const filteredDebugTrace = filterDebugTraceEntries(debugTrace, traceCategory)
  const filteredDaemonLogs = filterDaemonLogEntries(daemonLogs, searchQuery)
  const filteredDaemonRawLines = filterDaemonRawLines(daemonRawText, searchQuery)
  const filteredTraceEntries = filterTraceEntries(filteredDebugTrace, searchQuery)
  const filteredWebEvents = filterWebEntries(webEvents, searchQuery)
  const visibleDaemonLogs = visibleDaemonLogsForFilter(filteredDaemonLogs, quickFilter)
  const visibleDaemonRawLines = quickFilter === 'all' ? filteredDaemonRawLines : []
  const visibleTraceEntries = visibleTraceEntriesForFilter(filteredTraceEntries, quickFilter)
  const visibleWebEvents = quickFilter === 'issues' ? [] : filteredWebEvents
  const quickFilterCounts = getQuickFilterCounts({
    daemonLogs: filteredDaemonLogs,
    daemonRawLines: filteredDaemonRawLines,
    trace: filteredTraceEntries,
    webEvents: filteredWebEvents,
  })
  const diagnosticEvents = buildDiagnosticEvents({
    daemonLogs: visibleDaemonLogs,
    daemonRawLines: visibleDaemonRawLines,
    trace: visibleTraceEntries,
    webEvents: visibleWebEvents,
  })
  const diagnosticsSummary = summarizeDiagnosticEvents(diagnosticEvents)
  const sourceStates = buildDiagnosticSourceStates({
    daemonLoading,
    traceLoading,
    daemonFetchError,
    traceFetchError,
    daemonLogKind,
    daemonLogsCount: filteredDaemonLogs.length,
    daemonRawLineCount: filteredDaemonRawLines.length,
    traceCount: filteredTraceEntries.length,
    webEventCount: filteredWebEvents.length,
  })

  return {
    filteredDaemonLogs,
    filteredDaemonRawLines,
    filteredTraceEntries,
    filteredWebEvents,
    visibleDaemonLogs,
    visibleDaemonRawLines,
    visibleTraceEntries,
    visibleWebEvents,
    quickFilterCounts,
    diagnosticEvents,
    diagnosticsSummary,
    sourceStates,
  }
}
