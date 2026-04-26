import { describe, expect, it } from 'vitest'
import { buildLogsDiagnosticsViewModel } from '../../src/utils/logs-diagnostics-view-model'

describe('logs diagnostics view model', () => {
  it('keeps Info+ end-user view event-centric while hiding debug and raw fallback lines', () => {
    const model = buildLogsDiagnosticsViewModel({
      daemonLogs: [
        { timestamp: 1000, level: 'debug', message: '[daemon] noisy poll' },
        { timestamp: 2000, level: 'info', message: '[daemon] booted' },
        { timestamp: 3000, level: 'error', message: '[provider] failed' },
      ],
      daemonRawText: '[12:00:00.000] [ERR] [daemon] raw fallback failure',
      daemonLogKind: 'structured',
      debugTrace: [
        { id: 'trace-debug', ts: 1500, category: 'session_host', stage: 'poll', level: 'debug', payload: {} },
        { id: 'trace-warn', ts: 2500, category: 'session_host', stage: 'recover', level: 'warn', payload: { reason: 'slow' } },
      ],
      webEvents: [
        { id: 'web-1', ts: 2200, kind: 'subscription.publish', payload: {} },
      ],
      traceCategory: 'all',
      quickFilter: 'info',
      searchQuery: '',
      daemonLoading: false,
      traceLoading: false,
      daemonFetchError: '',
      traceFetchError: '',
    })

    expect(model.visibleDaemonLogs.map((entry) => entry.message)).toEqual(['[daemon] booted', '[provider] failed'])
    expect(model.visibleDaemonRawLines).toEqual([])
    expect(model.visibleTraceEntries.map((entry) => entry.id)).toEqual(['trace-warn'])
    expect(model.visibleWebEvents.map((entry) => entry.id)).toEqual(['web-1'])
    expect(model.diagnosticEvents.map((event) => event.source)).toEqual(['daemon_log', 'browser_event', 'daemon_trace', 'daemon_log'])
    expect(model.quickFilterCounts).toEqual({ all: 7, info: 4, issues: 2 })
    expect(model.diagnosticsSummary.latestIssue).toMatchObject({ severity: 'error', message: '[provider] failed' })
  })

  it('keeps Issues view focused on daemon and trace warn/error without browser noise', () => {
    const model = buildLogsDiagnosticsViewModel({
      daemonLogs: [
        { timestamp: 1000, level: 'info', message: '[daemon] booted' },
        { timestamp: 2000, level: 'warn', message: '[ServerConn] Pong timeout (1x)' },
      ],
      daemonRawText: '',
      daemonLogKind: 'structured',
      debugTrace: [
        { id: 'trace-error', ts: 3000, category: 'session_host', stage: 'write', level: 'error', payload: { reason: 'EPIPE' } },
      ],
      webEvents: [
        { id: 'web-1', ts: 2500, kind: 'subscription.publish', payload: {} },
      ],
      traceCategory: 'all',
      quickFilter: 'issues',
      searchQuery: '',
      daemonLoading: false,
      traceLoading: false,
      daemonFetchError: '',
      traceFetchError: '',
    })

    expect(model.visibleDaemonLogs.map((entry) => entry.level)).toEqual(['warn'])
    expect(model.visibleTraceEntries.map((entry) => entry.level)).toEqual(['error'])
    expect(model.visibleWebEvents).toEqual([])
    expect(model.diagnosticEvents.map((event) => event.source)).toEqual(['daemon_log', 'daemon_trace'])
  })
})
