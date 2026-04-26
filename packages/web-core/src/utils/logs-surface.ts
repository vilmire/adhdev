import type { LogEntry } from '../pages/machine/types'

export type LogsSurfaceLevel = 'debug' | 'info' | 'warn' | 'error'
export type DaemonLogPayloadKind = 'structured' | 'text' | 'empty'

export interface LogsSurfaceTraceEntry {
  id: string
  ts: number
  category: string
  stage: string
  level: LogsSurfaceLevel
  interactionId?: string
  payload?: Record<string, unknown>
}

export interface LogsSurfaceWebEntry {
  id: string
  ts: number
  kind: string
  topic?: string
  interactionId?: string
  payload?: Record<string, unknown>
}

export interface NormalizedDaemonLogsPayload {
  kind: DaemonLogPayloadKind
  entries: LogEntry[]
  rawText: string
}

export interface LogsSurfaceIssueSummary {
  source: 'daemon' | 'trace'
  level: 'warn' | 'error'
  timestamp: number
  label: string
  detail: string
}

export interface LogsSurfaceSummary {
  daemonCount: number
  traceCount: number
  webCount: number
  issueCount: number
  latestIssue: LogsSurfaceIssueSummary | null
  hasAnyData: boolean
  hasBlockingError: boolean
}

export interface SummarizeLogsSurfaceOptions {
  daemonLogs: LogEntry[]
  trace: LogsSurfaceTraceEntry[]
  webEvents: LogsSurfaceWebEntry[]
  daemonLogKind: DaemonLogPayloadKind
  daemonFetchError: string
  traceFetchError: string
  searchQuery: string
}

export interface LogsQuickFilterCounts {
  all: number
  info: number
  issues: number
}

export interface QuickFilterCountOptions {
  daemonLogs: LogEntry[]
  daemonRawLines: string[]
  trace: LogsSurfaceTraceEntry[]
  webEvents: LogsSurfaceWebEntry[]
}

export interface VisibleLogsExportOptions {
  daemonLogs: LogEntry[]
  daemonRawLines: string[]
  trace: LogsSurfaceTraceEntry[]
  webEvents: LogsSurfaceWebEntry[]
}

export interface DaemonLogMergeState {
  entries: LogEntry[]
  kind: DaemonLogPayloadKind
  rawText: string
  lastTs: number
}

function normalizeSearch(query: string): string {
  return query.trim().toLowerCase()
}

function matchesSearch(parts: Array<string | number | undefined | null>, query: string): boolean {
  const normalized = normalizeSearch(query)
  if (!normalized) return true
  return parts.some((part) => String(part ?? '').toLowerCase().includes(normalized))
}

export function formatPayload(payload?: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return ''
  try {
    return JSON.stringify(payload)
  } catch {
    return '[unserializable payload]'
  }
}

export function truncatePayload(payload?: Record<string, unknown>, maxLength = 220): string {
  const raw = formatPayload(payload)
  if (!raw) return ''
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw
}

export function normalizeDaemonLogsPayload(payload: unknown): NormalizedDaemonLogsPayload {
  const logs = (payload && typeof payload === 'object' && 'logs' in payload)
    ? (payload as { logs?: unknown }).logs
    : payload

  if (Array.isArray(logs)) {
    return {
      kind: logs.length > 0 ? 'structured' : 'empty',
      entries: logs.map((entry) => {
        const record = entry as { ts?: unknown; level?: unknown; category?: unknown; message?: unknown }
        return {
          timestamp: Number(record.ts) || 0,
          level: (record.level || 'info') as LogEntry['level'],
          message: `[${String(record.category || 'daemon')}] ${String(record.message || '')}`.trim(),
        }
      }),
      rawText: '',
    }
  }

  if (typeof logs === 'string') {
    const rawText = logs.trim()
    return {
      kind: rawText ? 'text' : 'empty',
      entries: [],
      rawText,
    }
  }

  return {
    kind: 'empty',
    entries: [],
    rawText: '',
  }
}

export function filterDaemonLogEntries(entries: LogEntry[], query: string): LogEntry[] {
  return entries.filter((entry) => matchesSearch([entry.level, entry.message], query))
}

function getDaemonLogEntryKey(entry: LogEntry): string {
  return `${entry.timestamp}:${entry.level}:${entry.message}`
}

export function mergeIncrementalDaemonLogs(
  previous: DaemonLogMergeState,
  next: NormalizedDaemonLogsPayload,
  limit = 300,
): DaemonLogMergeState {
  if (next.entries.length > 0) {
    const byKey = new Map<string, LogEntry>()
    for (const entry of previous.entries) byKey.set(getDaemonLogEntryKey(entry), entry)
    for (const entry of next.entries) byKey.set(getDaemonLogEntryKey(entry), entry)
    const entries = Array.from(byKey.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit)
    const lastTs = entries.reduce((max, entry) => Math.max(max, Number(entry.timestamp || 0)), previous.lastTs)
    return { entries, kind: 'structured', rawText: '', lastTs }
  }

  if (next.kind === 'text') {
    if (previous.entries.length > 0) return previous
    return { entries: [], kind: 'text', rawText: next.rawText, lastTs: previous.lastTs }
  }

  if (previous.entries.length > 0 || previous.rawText) {
    return previous
  }

  return { entries: [], kind: 'empty', rawText: '', lastTs: previous.lastTs }
}

export function appendIncrementalTraceEntries(
  previous: LogsSurfaceTraceEntry[],
  next: LogsSurfaceTraceEntry[],
  limit = 120,
): LogsSurfaceTraceEntry[] {
  if (next.length === 0) return previous
  const byId = new Map<string, LogsSurfaceTraceEntry>()
  for (const entry of previous) byId.set(entry.id, entry)
  for (const entry of next) byId.set(entry.id, entry)
  return Array.from(byId.values())
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit)
}

export function filterDaemonRawLines(rawText: string, query: string): string[] {
  return rawText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => matchesSearch([line], query))
}

export function filterTraceEntries(entries: LogsSurfaceTraceEntry[], query: string): LogsSurfaceTraceEntry[] {
  return entries.filter((entry) => matchesSearch([
    entry.level,
    entry.category,
    entry.stage,
    entry.interactionId,
    formatPayload(entry.payload),
  ], query))
}

export function filterWebEntries(entries: LogsSurfaceWebEntry[], query: string): LogsSurfaceWebEntry[] {
  return entries.filter((entry) => matchesSearch([
    entry.kind,
    entry.topic,
    entry.interactionId,
    formatPayload(entry.payload),
  ], query))
}

function isIssueLevel(level: LogsSurfaceLevel): level is 'warn' | 'error' {
  return level === 'warn' || level === 'error'
}

export function getQuickFilterCounts({ daemonLogs, daemonRawLines, trace, webEvents }: QuickFilterCountOptions): LogsQuickFilterCounts {
  return {
    all: daemonLogs.length + daemonRawLines.length + trace.length + webEvents.length,
    info: daemonLogs.filter((entry) => entry.level !== 'debug').length
      + trace.filter((entry) => entry.level !== 'debug').length
      + webEvents.length,
    issues: daemonLogs.filter((entry) => isIssueLevel(entry.level)).length
      + trace.filter((entry) => isIssueLevel(entry.level)).length,
  }
}

export function buildVisibleLogsExport({ daemonLogs, daemonRawLines, trace, webEvents }: VisibleLogsExportOptions): string {
  const sections: string[] = []

  if (daemonLogs.length > 0) {
    sections.push([
      '[daemon logs]',
      ...daemonLogs.map((entry) => `${new Date(entry.timestamp).toISOString()} ${entry.level.toUpperCase()} ${entry.message}`),
    ].join('\n'))
  } else if (daemonRawLines.length > 0) {
    sections.push(['[daemon logs]', ...daemonRawLines].join('\n'))
  }

  if (trace.length > 0) {
    sections.push([
      '[trace]',
      ...trace.map((entry) => `${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase()} ${entry.category}.${entry.stage} ${truncatePayload(entry.payload, 500)}`.trim()),
    ].join('\n'))
  }

  if (webEvents.length > 0) {
    sections.push([
      '[browser events]',
      ...webEvents.map((entry) => `${new Date(entry.ts).toISOString()} ${entry.kind}${entry.topic ? ` topic=${entry.topic}` : ''} ${truncatePayload(entry.payload, 500)}`.trim()),
    ].join('\n'))
  }

  return sections.join('\n\n')
}

export function summarizeLogsSurface({
  daemonLogs,
  trace,
  webEvents,
  daemonLogKind,
  daemonFetchError,
  traceFetchError,
  searchQuery,
}: SummarizeLogsSurfaceOptions): LogsSurfaceSummary {
  const filteredDaemon = filterDaemonLogEntries(daemonLogs, searchQuery)
  const filteredTrace = filterTraceEntries(trace, searchQuery)
  const filteredWeb = filterWebEntries(webEvents, searchQuery)
  const daemonIssues: LogsSurfaceIssueSummary[] = filteredDaemon
    .filter((entry): entry is LogEntry & { level: 'warn' | 'error' } => entry.level === 'warn' || entry.level === 'error')
    .map((entry) => ({
      source: 'daemon',
      level: entry.level,
      timestamp: entry.timestamp,
      label: 'daemon',
      detail: entry.message,
    }))
  const traceIssues: LogsSurfaceIssueSummary[] = filteredTrace
    .filter((entry): entry is LogsSurfaceTraceEntry & { level: 'warn' | 'error' } => entry.level === 'warn' || entry.level === 'error')
    .map((entry) => ({
      source: 'trace',
      level: entry.level,
      timestamp: entry.ts,
      label: `${entry.category}.${entry.stage}`,
      detail: truncatePayload(entry.payload, 320) || `${entry.category}.${entry.stage}`,
    }))
  const issues = [...daemonIssues, ...traceIssues]
    .sort((a, b) => b.timestamp - a.timestamp)

  return {
    daemonCount: filteredDaemon.length,
    traceCount: filteredTrace.length,
    webCount: filteredWeb.length,
    issueCount: issues.length,
    latestIssue: issues[0] || null,
    hasAnyData: daemonLogKind === 'text' || filteredDaemon.length > 0 || filteredTrace.length > 0 || filteredWeb.length > 0,
    hasBlockingError: Boolean(daemonFetchError || traceFetchError),
  }
}
