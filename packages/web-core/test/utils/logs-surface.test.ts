import { describe, expect, it } from 'vitest'
import {
  appendIncrementalTraceEntries,
  buildVisibleLogsExport,
  getQuickFilterCounts,
  mergeIncrementalDaemonLogs,
  normalizeDaemonLogsPayload,
  summarizeLogsSurface,
  type LogsSurfaceTraceEntry,
  type LogsSurfaceWebEntry,
} from '../../src/utils/logs-surface'

describe('logs surface helpers', () => {
  it('normalizes structured daemon log arrays into display entries', () => {
    expect(normalizeDaemonLogsPayload({
      logs: [
        { ts: 1710000000000, level: 'warn', category: 'p2p', message: 'TURN relay degraded' },
      ],
    })).toEqual({
      kind: 'structured',
      entries: [
        {
          timestamp: 1710000000000,
          level: 'warn',
          message: '[p2p] TURN relay degraded',
        },
      ],
      rawText: '',
    })
  })

  it('preserves file-fallback text logs instead of pretending the tab is still loading', () => {
    expect(normalizeDaemonLogsPayload({
      logs: '[12:00:00.000] [INF] [daemon] boot complete\n[12:00:01.000] [ERR] [p2p] TURN failed',
    })).toEqual({
      kind: 'text',
      entries: [],
      rawText: '[12:00:00.000] [INF] [daemon] boot complete\n[12:00:01.000] [ERR] [p2p] TURN failed',
    })
  })

  it('summarizes the newest warn or error across daemon and trace streams', () => {
    const trace: LogsSurfaceTraceEntry[] = [
      {
        id: 'trace-1',
        ts: 1710000000000,
        category: 'session_host',
        stage: 'start',
        level: 'info',
        payload: {},
      },
      {
        id: 'trace-2',
        ts: 1710000002000,
        category: 'session_host',
        stage: 'recover',
        level: 'error',
        payload: { reason: 'runtime crashed' },
      },
    ]
    const webEvents: LogsSurfaceWebEntry[] = [
      {
        id: 'web-1',
        ts: 1710000001000,
        kind: 'subscription.publish',
        payload: {},
      },
    ]

    expect(summarizeLogsSurface({
      daemonLogs: [
        { timestamp: 1710000001500, level: 'warn', message: '[p2p] reconnecting' },
      ],
      trace,
      webEvents,
      daemonLogKind: 'structured',
      daemonFetchError: '',
      traceFetchError: '',
      searchQuery: '',
    })).toMatchObject({
      daemonCount: 1,
      traceCount: 2,
      webCount: 1,
      issueCount: 2,
      latestIssue: {
        source: 'trace',
        level: 'error',
        label: 'session_host.recover',
      },
      hasAnyData: true,
      hasBlockingError: false,
    })
  })

  it('counts all/info/issues quick filters from the currently visible entries', () => {
    const trace: LogsSurfaceTraceEntry[] = [
      { id: 'trace-1', ts: 10, category: 'session_host', stage: 'start', level: 'info', payload: {} },
      { id: 'trace-2', ts: 20, category: 'session_host', stage: 'recover', level: 'warn', payload: {} },
    ]
    const webEvents: LogsSurfaceWebEntry[] = [
      { id: 'web-1', ts: 30, kind: 'subscription.publish', payload: {} },
    ]

    expect(getQuickFilterCounts({
      daemonLogs: [
        { timestamp: 5, level: 'info', message: '[daemon] booted' },
        { timestamp: 15, level: 'error', message: '[p2p] failed' },
      ],
      daemonRawLines: [],
      trace,
      webEvents,
    })).toEqual({
      all: 5,
      info: 5,
      issues: 2,
    })
  })

  it('builds a copy-friendly export of the currently visible logs', () => {
    const trace: LogsSurfaceTraceEntry[] = [
      { id: 'trace-2', ts: 20, category: 'session_host', stage: 'recover', level: 'warn', payload: { reason: 'slow reconnect' } },
    ]
    const webEvents: LogsSurfaceWebEntry[] = [
      { id: 'web-1', ts: 30, kind: 'subscription.publish', topic: 'session.modal', payload: { key: 'session:1' } },
    ]

    const rendered = buildVisibleLogsExport({
      daemonLogs: [
        { timestamp: 15, level: 'error', message: '[p2p] failed' },
      ],
      daemonRawLines: [],
      trace,
      webEvents,
    })

    expect(rendered).toContain('[daemon logs]')
    expect(rendered).toContain('[trace]')
    expect(rendered).toContain('[browser events]')
  })

  it('keeps existing structured daemon logs when an incremental poll returns no new entries', () => {
    const previous = {
      entries: [
        { timestamp: 1000, level: 'info' as const, message: '[daemon] booted' },
      ],
      kind: 'structured' as const,
      rawText: '',
      lastTs: 1000,
    }

    expect(mergeIncrementalDaemonLogs(previous, normalizeDaemonLogsPayload({ logs: [] }))).toEqual(previous)
  })

  it('does not downgrade an existing structured daemon buffer to raw text fallback', () => {
    const previous = {
      entries: [
        { timestamp: 1000, level: 'info' as const, message: '[daemon] booted' },
      ],
      kind: 'structured' as const,
      rawText: '',
      lastTs: 1000,
    }

    expect(mergeIncrementalDaemonLogs(previous, normalizeDaemonLogsPayload({
      logs: '[12:00:00.000] [INF] [daemon] older fallback line',
    }))).toEqual(previous)
  })

  it('appends incremental trace entries without clearing the previous trace buffer on empty polls', () => {
    const existing: LogsSurfaceTraceEntry[] = [
      { id: 'trace-1', ts: 1000, category: 'session_host', stage: 'start', level: 'info', payload: {} },
    ]

    expect(appendIncrementalTraceEntries(existing, [], 120)).toEqual(existing)
    expect(appendIncrementalTraceEntries(existing, [
      { id: 'trace-2', ts: 1200, category: 'session_host', stage: 'recover', level: 'warn', payload: { reason: 'slow' } },
    ], 120)).toEqual([
      ...existing,
      { id: 'trace-2', ts: 1200, category: 'session_host', stage: 'recover', level: 'warn', payload: { reason: 'slow' } },
    ])
  })

  it('treats fetch failures as blocking state even when buffers are empty', () => {
    expect(summarizeLogsSurface({
      daemonLogs: [],
      trace: [],
      webEvents: [],
      daemonLogKind: 'empty',
      daemonFetchError: 'Could not load daemon logs',
      traceFetchError: '',
      searchQuery: '',
    })).toMatchObject({
      hasAnyData: false,
      hasBlockingError: true,
      issueCount: 0,
    })
  })
})
