import { describe, expect, it } from 'vitest'
import {
  buildDiagnosticBundle,
  buildDiagnosticEvents,
  buildDiagnosticSourceStates,
  summarizeDiagnosticEvents,
  type DiagnosticSourceState,
} from '../../src/utils/diagnostics-model'
import type { LogsSurfaceTraceEntry, LogsSurfaceWebEntry } from '../../src/utils/logs-surface'

describe('diagnostics model', () => {
  it('builds one chronological timeline across daemon logs, trace, browser events, and raw fallback lines', () => {
    const trace: LogsSurfaceTraceEntry[] = [
      { id: 'trace-1', ts: 3000, category: 'session_host', stage: 'write', level: 'error', interactionId: 'ix-1', payload: { reason: 'EPIPE' } },
    ]
    const webEvents: LogsSurfaceWebEntry[] = [
      { id: 'web-1', ts: 2000, kind: 'subscription.publish', topic: 'session.modal', interactionId: 'ix-1', payload: { key: 'session:1' } },
    ]

    const events = buildDiagnosticEvents({
      daemonLogs: [
        { timestamp: 1000, level: 'info', message: '[daemon] booted' },
      ],
      daemonRawLines: ['[12:00:04.000] [WRN] [daemon] raw fallback warning'],
      trace,
      webEvents,
    })

    expect(events.map((event) => event.source)).toEqual([
      'daemon_log',
      'browser_event',
      'daemon_trace',
      'raw_file',
    ])
    expect(events.map((event) => event.severity)).toEqual(['info', 'info', 'error', 'warn'])
    expect(events[2]).toMatchObject({
      interactionId: 'ix-1',
      category: 'session_host',
      stage: 'write',
    })
  })

  it('summarizes latest issue and repeated warning patterns from the unified timeline', () => {
    const events = buildDiagnosticEvents({
      daemonLogs: [
        { timestamp: 1000, level: 'warn', message: '[ServerConn] Pong timeout (1x)' },
        { timestamp: 2000, level: 'warn', message: '[ServerConn] Pong timeout (1x)' },
        { timestamp: 3000, level: 'error', message: '[provider] command failed' },
      ],
      daemonRawLines: [],
      trace: [],
      webEvents: [],
    })

    const summary = summarizeDiagnosticEvents(events)

    expect(summary.issueCount).toBe(3)
    expect(summary.latestIssue).toMatchObject({ severity: 'error', message: '[provider] command failed' })
    expect(summary.repeatedPatterns[0]).toMatchObject({
      severity: 'warn',
      count: 2,
      message: '[ServerConn] Pong timeout (1x)',
    })
  })

  it('describes source status separately from visible timeline filtering', () => {
    expect(buildDiagnosticSourceStates({
      daemonLoading: false,
      traceLoading: true,
      daemonFetchError: '',
      traceFetchError: '',
      daemonLogKind: 'structured',
      daemonLogsCount: 2,
      daemonRawLineCount: 0,
      traceCount: 0,
      webEventCount: 1,
    })).toEqual([
      { id: 'daemon_logs', label: 'Daemon logs', status: 'ok', detail: '2 structured line(s)' },
      { id: 'daemon_trace', label: 'Daemon trace', status: 'loading', detail: '0 trace event(s)' },
      { id: 'browser_events', label: 'Browser debug events', status: 'ok', detail: '1 local browser event(s)' },
    ])
  })

  it('builds an agent-friendly diagnostic bundle with sources, issue summary, repeated patterns, and timeline', () => {
    const events = buildDiagnosticEvents({
      daemonLogs: [
        { timestamp: 1000, level: 'warn', message: '[ServerConn] Pong timeout (1x)' },
        { timestamp: 2000, level: 'warn', message: '[ServerConn] Pong timeout (1x)' },
      ],
      daemonRawLines: [],
      trace: [
        { id: 'trace-1', ts: 3000, category: 'session_host', stage: 'recover', level: 'error', payload: { reason: 'runtime crashed' } },
      ],
      webEvents: [],
    })
    const sources: DiagnosticSourceState[] = [
      { id: 'daemon_logs', label: 'Daemon logs', status: 'ok', detail: '2 structured entries' },
      { id: 'daemon_trace', label: 'Daemon trace', status: 'ok', detail: '1 trace entry' },
      { id: 'browser_events', label: 'Browser debug events', status: 'empty', detail: 'No browser events captured' },
    ]

    const rendered = buildDiagnosticBundle({
      events,
      summary: summarizeDiagnosticEvents(events),
      sources,
      maxTimelineEvents: 5,
    })

    expect(rendered).toContain('[diagnostic summary]')
    expect(rendered).toContain('[source status]')
    expect(rendered).toContain('[latest issue]')
    expect(rendered).toContain('[top repeated patterns]')
    expect(rendered).toContain('[timeline]')
    expect(rendered).toContain('Daemon trace: ok - 1 trace entry')
    expect(rendered).toContain('2x WARN daemon_log [ServerConn] Pong timeout (1x)')
    expect(rendered).toContain('ERROR daemon_trace session_host.recover')
  })
})
