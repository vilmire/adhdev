import type { LogEntry } from '../pages/machine/types'
import {
  truncatePayload,
  type LogsSurfaceLevel,
  type LogsSurfaceTraceEntry,
  type LogsSurfaceWebEntry,
} from './logs-surface'

export type DiagnosticSource = 'daemon_log' | 'daemon_trace' | 'browser_event' | 'raw_file'
export type DiagnosticSeverity = LogsSurfaceLevel
export type DiagnosticSourceStatus = 'ok' | 'loading' | 'empty' | 'error' | 'paused'

export interface DiagnosticEvent {
  id: string
  source: DiagnosticSource
  ts: number
  severity: DiagnosticSeverity
  message: string
  category?: string
  stage?: string
  topic?: string
  interactionId?: string
  payload?: Record<string, unknown>
  raw?: string
}

export interface DiagnosticSourceState {
  id: 'daemon_logs' | 'daemon_trace' | 'browser_events'
  label: string
  status: DiagnosticSourceStatus
  detail: string
}

export interface DiagnosticRepeatedPattern {
  key: string
  source: DiagnosticSource
  severity: DiagnosticSeverity
  message: string
  count: number
  firstTs: number
  lastTs: number
}

export interface DiagnosticsSummary {
  totalCount: number
  issueCount: number
  latestIssue: DiagnosticEvent | null
  repeatedPatterns: DiagnosticRepeatedPattern[]
}

export interface BuildDiagnosticEventsOptions {
  daemonLogs: LogEntry[]
  daemonRawLines: string[]
  trace: LogsSurfaceTraceEntry[]
  webEvents: LogsSurfaceWebEntry[]
}

export interface DiagnosticBundleOptions {
  events: DiagnosticEvent[]
  summary: DiagnosticsSummary
  sources: DiagnosticSourceState[]
  maxTimelineEvents?: number
}

export interface BuildDiagnosticSourceStatesOptions {
  daemonLoading: boolean
  traceLoading: boolean
  daemonFetchError: string
  traceFetchError: string
  daemonLogKind: string
  daemonLogsCount: number
  daemonRawLineCount: number
  traceCount: number
  webEventCount: number
}

export function buildDiagnosticSourceStates({
  daemonLoading,
  traceLoading,
  daemonFetchError,
  traceFetchError,
  daemonLogKind,
  daemonLogsCount,
  daemonRawLineCount,
  traceCount,
  webEventCount,
}: BuildDiagnosticSourceStatesOptions): DiagnosticSourceState[] {
  return [
    {
      id: 'daemon_logs',
      label: 'Daemon logs',
      status: daemonFetchError ? 'error' : daemonLoading ? 'loading' : daemonLogsCount > 0 || daemonRawLineCount > 0 ? 'ok' : 'empty',
      detail: daemonFetchError || (daemonLogKind === 'text'
        ? `${daemonRawLineCount} raw file-fallback line(s)`
        : `${daemonLogsCount} structured line(s)`),
    },
    {
      id: 'daemon_trace',
      label: 'Daemon trace',
      status: traceFetchError ? 'error' : traceLoading ? 'loading' : traceCount > 0 ? 'ok' : 'empty',
      detail: traceFetchError || `${traceCount} trace event(s)`,
    },
    {
      id: 'browser_events',
      label: 'Browser debug events',
      status: webEventCount > 0 ? 'ok' : 'empty',
      detail: webEventCount > 0 ? `${webEventCount} local browser event(s)` : 'No browser events captured',
    },
  ]
}

function isIssueSeverity(severity: DiagnosticSeverity): boolean {
  return severity === 'warn' || severity === 'error'
}

function severityFromRawLine(line: string): DiagnosticSeverity {
  const normalized = line.toLowerCase()
  if (/\[(err|error)\]/i.test(line) || normalized.includes(' error ') || normalized.includes(' failed')) return 'error'
  if (/\[(wrn|warn|warning)\]/i.test(line) || normalized.includes(' warning ') || normalized.includes(' timeout')) return 'warn'
  if (/\[(dbg|debug)\]/i.test(line)) return 'debug'
  return 'info'
}

function rawLineTimestamp(line: string, index: number): number {
  const isoMatch = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/)
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0])
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.MAX_SAFE_INTEGER - 100000 + index
}

function sourceRank(source: DiagnosticSource): number {
  if (source === 'daemon_log') return 0
  if (source === 'browser_event') return 1
  if (source === 'daemon_trace') return 2
  return 3
}

function eventMessageFromTrace(entry: LogsSurfaceTraceEntry): string {
  const payload = truncatePayload(entry.payload, 320)
  return payload ? `${entry.category}.${entry.stage} ${payload}` : `${entry.category}.${entry.stage}`
}

function eventMessageFromWeb(entry: LogsSurfaceWebEntry): string {
  const payload = truncatePayload(entry.payload, 320)
  const topic = entry.topic ? ` topic=${entry.topic}` : ''
  return payload ? `${entry.kind}${topic} ${payload}` : `${entry.kind}${topic}`
}

export function buildDiagnosticEvents({ daemonLogs, daemonRawLines, trace, webEvents }: BuildDiagnosticEventsOptions): DiagnosticEvent[] {
  const events: DiagnosticEvent[] = []

  daemonLogs.forEach((entry, index) => {
    events.push({
      id: `daemon-log-${entry.timestamp}-${index}`,
      source: 'daemon_log',
      ts: Number(entry.timestamp || 0),
      severity: entry.level,
      message: entry.message,
      raw: entry.message,
    })
  })

  webEvents.forEach((entry) => {
    events.push({
      id: `browser-event-${entry.id}`,
      source: 'browser_event',
      ts: Number(entry.ts || 0),
      severity: 'info',
      message: eventMessageFromWeb(entry),
      topic: entry.topic,
      interactionId: entry.interactionId,
      payload: entry.payload,
    })
  })

  trace.forEach((entry) => {
    events.push({
      id: `daemon-trace-${entry.id}`,
      source: 'daemon_trace',
      ts: Number(entry.ts || 0),
      severity: entry.level,
      message: eventMessageFromTrace(entry),
      category: entry.category,
      stage: entry.stage,
      interactionId: entry.interactionId,
      payload: entry.payload,
    })
  })

  daemonRawLines.forEach((line, index) => {
    events.push({
      id: `raw-file-${index}`,
      source: 'raw_file',
      ts: rawLineTimestamp(line, index),
      severity: severityFromRawLine(line),
      message: line,
      raw: line,
    })
  })

  return events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts
    return sourceRank(a.source) - sourceRank(b.source)
  })
}

function patternKey(event: DiagnosticEvent): string {
  return `${event.source}:${event.severity}:${event.message}`
}

export function summarizeDiagnosticEvents(events: DiagnosticEvent[]): DiagnosticsSummary {
  const issues = events
    .filter((event) => isIssueSeverity(event.severity))
    .sort((a, b) => b.ts - a.ts)
  const patterns = new Map<string, DiagnosticRepeatedPattern>()

  for (const event of events) {
    if (!isIssueSeverity(event.severity)) continue
    const key = patternKey(event)
    const existing = patterns.get(key)
    if (existing) {
      existing.count += 1
      existing.firstTs = Math.min(existing.firstTs, event.ts)
      existing.lastTs = Math.max(existing.lastTs, event.ts)
    } else {
      patterns.set(key, {
        key,
        source: event.source,
        severity: event.severity,
        message: event.message,
        count: 1,
        firstTs: event.ts,
        lastTs: event.ts,
      })
    }
  }

  return {
    totalCount: events.length,
    issueCount: issues.length,
    latestIssue: issues[0] || null,
    repeatedPatterns: Array.from(patterns.values())
      .filter((pattern) => pattern.count > 1)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return b.lastTs - a.lastTs
      })
      .slice(0, 5),
  }
}

function formatIso(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 365 * 24 * 60 * 60 * 1000) return 'unknown-time'
  return new Date(ts).toISOString()
}

function formatEventLine(event: DiagnosticEvent): string {
  const location = event.category && event.stage
    ? ` ${event.category}.${event.stage}`
    : event.topic
      ? ` topic=${event.topic}`
      : ''
  const interaction = event.interactionId ? ` ix=${event.interactionId}` : ''
  return `${formatIso(event.ts)} ${event.severity.toUpperCase()} ${event.source}${location}${interaction} ${event.message}`.trim()
}

export function buildDiagnosticBundle({ events, summary, sources, maxTimelineEvents = 80 }: DiagnosticBundleOptions): string {
  const sections: string[] = []
  sections.push([
    '[diagnostic summary]',
    `total_events: ${summary.totalCount}`,
    `issue_events: ${summary.issueCount}`,
  ].join('\n'))

  sections.push([
    '[source status]',
    ...sources.map((source) => `${source.label}: ${source.status} - ${source.detail}`),
  ].join('\n'))

  if (summary.latestIssue) {
    sections.push([
      '[latest issue]',
      formatEventLine(summary.latestIssue),
    ].join('\n'))
  }

  if (summary.repeatedPatterns.length > 0) {
    sections.push([
      '[top repeated patterns]',
      ...summary.repeatedPatterns.map((pattern) => `${pattern.count}x ${pattern.severity.toUpperCase()} ${pattern.source} ${pattern.message}`),
    ].join('\n'))
  }

  const timeline = events.slice(-maxTimelineEvents)
  sections.push([
    '[timeline]',
    ...(timeline.length > 0 ? timeline.map(formatEventLine) : ['No diagnostic events captured.']),
  ].join('\n'))

  return sections.join('\n\n')
}
