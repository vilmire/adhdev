import { useCallback, useEffect, useRef, useState } from 'react'
import { webDebugStore } from '../debug/webDebugStore'
import type { LogEntry } from '../pages/machine/types'
import {
  buildDebugTraceQuery,
  type DebugTraceCategoryFilter,
} from '../utils/logs-trace-filters'
import {
  appendIncrementalTraceEntries,
  mergeIncrementalDaemonLogs,
  normalizeDaemonLogsPayload,
  type DaemonLogMergeState,
  type DaemonLogPayloadKind,
  type LogsSurfaceTraceEntry,
  type LogsSurfaceWebEntry,
} from '../utils/logs-surface'

export interface UseMachineDiagnosticsStreamsOptions {
  machineId: string
  sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export interface MachineDiagnosticsStreamsState {
  daemonLogs: LogEntry[]
  daemonLogKind: DaemonLogPayloadKind
  daemonRawText: string
  debugTrace: LogsSurfaceTraceEntry[]
  webEvents: LogsSurfaceWebEntry[]
  lastUpdatedAt: number | null
  autoRefresh: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  traceCategory: DebugTraceCategoryFilter
  daemonLoading: boolean
  traceLoading: boolean
  daemonFetchError: string
  traceFetchError: string
  setAutoRefresh: (enabled: boolean | ((enabled: boolean) => boolean)) => void
  setLogLevel: (level: 'debug' | 'info' | 'warn' | 'error') => void
  setTraceCategory: (category: DebugTraceCategoryFilter) => void
  refresh: () => void
  clear: () => void
}

export function useMachineDiagnosticsStreams({
  machineId,
  sendDaemonCommand,
}: UseMachineDiagnosticsStreamsOptions): MachineDiagnosticsStreamsState {
  const [daemonLogs, setDaemonLogs] = useState<LogEntry[]>([])
  const [daemonLogKind, setDaemonLogKind] = useState<DaemonLogPayloadKind>('empty')
  const [daemonRawText, setDaemonRawText] = useState('')
  const [debugTrace, setDebugTrace] = useState<LogsSurfaceTraceEntry[]>([])
  const [webEvents, setWebEvents] = useState<LogsSurfaceWebEntry[]>([])
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [logLevelState, setLogLevelState] = useState<'debug' | 'info' | 'warn' | 'error'>('info')
  const [traceCategoryState, setTraceCategoryState] = useState<DebugTraceCategoryFilter>('all')
  const [daemonLoading, setDaemonLoading] = useState(true)
  const [traceLoading, setTraceLoading] = useState(true)
  const [daemonFetchError, setDaemonFetchError] = useState('')
  const [traceFetchError, setTraceFetchError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const lastLogTsRef = useRef(0)
  const lastTraceTsRef = useRef(0)
  const daemonStateRef = useRef<DaemonLogMergeState>({ entries: [], kind: 'empty', rawText: '', lastTs: 0 })
  const debugTraceRef = useRef<LogsSurfaceTraceEntry[]>([])

  const resetDaemonState = useCallback(() => {
    const emptyState: DaemonLogMergeState = { entries: [], kind: 'empty', rawText: '', lastTs: 0 }
    daemonStateRef.current = emptyState
    lastLogTsRef.current = 0
    setDaemonLogs([])
    setDaemonRawText('')
    setDaemonLogKind('empty')
    setDaemonLoading(true)
  }, [])

  const resetTraceState = useCallback(() => {
    debugTraceRef.current = []
    lastTraceTsRef.current = 0
    setDebugTrace([])
    setTraceLoading(true)
  }, [])

  const setLogLevel = useCallback((level: 'debug' | 'info' | 'warn' | 'error') => {
    if (level === logLevelState) return
    resetDaemonState()
    setLogLevelState(level)
  }, [logLevelState, resetDaemonState])

  const setTraceCategory = useCallback((category: DebugTraceCategoryFilter) => {
    setTraceCategoryState((current) => current === category ? current : category)
  }, [])

  const clear = useCallback(() => {
    resetDaemonState()
    resetTraceState()
    setWebEvents([])
    setLastUpdatedAt(null)
    setDaemonFetchError('')
    setTraceFetchError('')
    webDebugStore.clear()
  }, [resetDaemonState, resetTraceState])

  const refresh = useCallback(() => {
    setReloadToken((value) => value + 1)
  }, [])

  const fetchDebugData = useCallback(async () => {
    if (!machineId) return

    const sinceLogTs = lastLogTsRef.current
    const sinceTraceTs = lastTraceTsRef.current
    const [logsRes, traceRes] = await Promise.allSettled([
      sendDaemonCommand(machineId, 'get_logs', { count: 200, minLevel: logLevelState, since: sinceLogTs }),
      sendDaemonCommand(machineId, 'get_debug_trace', buildDebugTraceQuery({ count: 120, since: sinceTraceTs, category: traceCategoryState })),
    ])

    if (logsRes.status === 'fulfilled') {
      const rawLogsRes = logsRes.value
      const logsPayload = rawLogsRes?.result || rawLogsRes
      const normalized = normalizeDaemonLogsPayload(logsPayload)
      const merged = mergeIncrementalDaemonLogs(daemonStateRef.current, normalized, 300)
      daemonStateRef.current = merged
      lastLogTsRef.current = merged.lastTs
      setDaemonLoading(false)
      setDaemonFetchError(rawLogsRes?.success === false ? String(rawLogsRes?.error || 'Could not load daemon logs') : '')
      setDaemonLogKind(merged.kind)
      setDaemonRawText(merged.rawText)
      setDaemonLogs(merged.entries)
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
        const nextTrace = tracePayload.trace as LogsSurfaceTraceEntry[]
        const mergedTrace = appendIncrementalTraceEntries(debugTraceRef.current, nextTrace, 120)
        const maxTraceTs = nextTrace.reduce((max: number, entry: { ts?: unknown }) => Math.max(max, Number(entry.ts || 0)), sinceTraceTs)
        debugTraceRef.current = mergedTrace
        if (maxTraceTs > sinceTraceTs) lastTraceTsRef.current = maxTraceTs
        setTraceFetchError('')
        setDebugTrace(mergedTrace)
      } else {
        setTraceFetchError('')
      }
      setTraceLoading(false)
    } else {
      setTraceLoading(false)
      setTraceFetchError(traceRes.reason instanceof Error ? traceRes.reason.message : 'Could not load daemon trace')
    }

    setWebEvents(webDebugStore.list({ limit: 120 }) as LogsSurfaceWebEntry[])
    setLastUpdatedAt(Date.now())
  }, [logLevelState, machineId, sendDaemonCommand, traceCategoryState])

  useEffect(() => {
    resetTraceState()
  }, [resetTraceState, traceCategoryState])

  useEffect(() => {
    if (!machineId) return
    void fetchDebugData()
    if (!autoRefresh) return
    const timer = setInterval(() => {
      void fetchDebugData()
    }, 3000)
    return () => clearInterval(timer)
  }, [autoRefresh, fetchDebugData, machineId, reloadToken])

  return {
    daemonLogs,
    daemonLogKind,
    daemonRawText,
    debugTrace,
    webEvents,
    lastUpdatedAt,
    autoRefresh,
    logLevel: logLevelState,
    traceCategory: traceCategoryState,
    daemonLoading,
    traceLoading,
    daemonFetchError,
    traceFetchError,
    setAutoRefresh,
    setLogLevel,
    setTraceCategory,
    refresh,
    clear,
  }
}
