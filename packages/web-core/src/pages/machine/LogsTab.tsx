/**
 * LogsTab — Daemon log viewer with level filter and auto-refresh.
 */
import { useState, useEffect, useRef } from 'react'
import type { LogEntry } from './types'
import { webDebugStore } from '../../debug/webDebugStore'

interface LogsTabProps {
    machineId: string
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

interface DebugTraceEntryView {
    id: string
    ts: number
    category: string
    stage: string
    level: 'debug' | 'info' | 'warn' | 'error'
    interactionId?: string
    payload?: Record<string, unknown>
}

interface WebDebugEntryView {
    id: string
    ts: number
    kind: string
    topic?: string
    interactionId?: string
    payload?: Record<string, unknown>
}

function formatPayload(payload?: Record<string, unknown>): string {
    if (!payload || Object.keys(payload).length === 0) return ''
    try {
        const raw = JSON.stringify(payload)
        return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw
    } catch {
        return '[unserializable payload]'
    }
}

export default function LogsTab({ machineId, sendDaemonCommand }: LogsTabProps) {
    const [daemonLogs, setDaemonLogs] = useState<LogEntry[]>([])
    const [debugTrace, setDebugTrace] = useState<DebugTraceEntryView[]>([])
    const [webEvents, setWebEvents] = useState<WebDebugEntryView[]>([])
    const [lastLogTs, setLastLogTs] = useState(0)
    const [lastTraceTs, setLastTraceTs] = useState(0)
    const [autoRefresh, setAutoRefresh] = useState(true)
    const [logLevel, setLogLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('debug')
    const logsEndRef = useRef<HTMLDivElement>(null)
    const initialScrollDone = useRef(false)

    useEffect(() => {
        if (!machineId || !autoRefresh) return
        const fetchDebugData = async () => {
            try {
                const [logsRes, traceRes] = await Promise.all([
                    sendDaemonCommand(machineId, 'get_logs', { count: 200, minLevel: logLevel, since: lastLogTs }),
                    sendDaemonCommand(machineId, 'get_debug_trace', { count: 120, since: lastTraceTs }),
                ])

                const logsPayload = logsRes?.result || logsRes
                if (logsRes?.success && Array.isArray(logsPayload?.logs) && logsPayload.logs.length > 0) {
                    setDaemonLogs(prev => {
                        const combined = [...prev, ...logsPayload.logs.map((l: any) => ({
                            timestamp: l.ts,
                            level: l.level as 'debug' | 'info' | 'warn' | 'error',
                            message: `[${l.category}] ${l.message}`,
                        }))].slice(-300)
                        return combined
                    })
                    const maxTs = Math.max(...logsPayload.logs.map((l: any) => l.ts))
                    setLastLogTs(maxTs)
                }

                const tracePayload = traceRes?.result || traceRes
                if (traceRes?.success && Array.isArray(tracePayload?.trace)) {
                    setDebugTrace(tracePayload.trace.slice(-120))
                    const maxTraceTs = tracePayload.trace.reduce((max: number, entry: any) => Math.max(max, Number(entry.ts || 0)), lastTraceTs)
                    if (maxTraceTs > lastTraceTs) setLastTraceTs(maxTraceTs)
                }
            } catch {
                /* silent */
            }

            setWebEvents(webDebugStore.list({ limit: 120 }) as WebDebugEntryView[])
        }
        fetchDebugData()
        const timer = setInterval(fetchDebugData, 3000)
        return () => clearInterval(timer)
    }, [machineId, autoRefresh, lastLogTs, lastTraceTs, logLevel, sendDaemonCommand])

    useEffect(() => {
        if (autoRefresh && (daemonLogs.length > 0 || debugTrace.length > 0 || webEvents.length > 0)) {
            const behavior = initialScrollDone.current ? 'smooth' : 'instant' as ScrollBehavior;
            setTimeout(() => {
                logsEndRef.current?.scrollIntoView({ behavior });
                initialScrollDone.current = true;
            }, 50)
        }
    }, [daemonLogs.length, debugTrace.length, webEvents.length, autoRefresh])

    return (
        <div>
            <div className="flex justify-between items-center mb-3">
                <div className="flex gap-1 items-center">
                    <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mr-2">
                        Level
                    </span>
                    {(['debug', 'info', 'warn', 'error'] as const).map(level => (
                        <button
                            key={level}
                            onClick={() => { setLogLevel(level); setDaemonLogs([]); setLastLogTs(0) }}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                logLevel === level ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                            }`}
                        >{level.toUpperCase()}</button>
                    ))}
                </div>
                <div className="flex gap-1.5 items-center">
                    <span className="text-[10px] text-text-muted">logs={daemonLogs.length} trace={debugTrace.length} web={webEvents.length}</span>
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className={`machine-btn ${
                            autoRefresh ? 'text-green-500 border-green-500/30' : ''
                        }`}
                    >{autoRefresh ? '⏸ Pause' : '▶ Resume'}</button>
                    <button
                        onClick={() => {
                            setDaemonLogs([])
                            setDebugTrace([])
                            setWebEvents([])
                            setLastLogTs(0)
                            setLastTraceTs(0)
                            webDebugStore.clear()
                        }}
                        className="machine-btn"
                    >Clear</button>
                </div>
            </div>

            <div className="grid gap-3">
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 min-h-[180px] max-h-[360px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Daemon logs</div>
                    {daemonLogs.length === 0 && (
                        <div className="p-6 text-center text-text-muted">Loading daemon logs...</div>
                    )}
                    {daemonLogs.map((log, i) => (
                        <div key={`log-${i}`} className="flex gap-2 py-px" style={{
                            color: log.level === 'error' ? '#ef4444' : log.level === 'warn' ? 'var(--status-warning)' : (log.level as string) === 'debug' ? '#64748b' : '#94a3b8',
                        }}>
                            <span className="text-text-muted min-w-[75px] shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                            <span className="font-semibold min-w-[32px] shrink-0 text-[9px]">{log.level === 'error' ? 'ERR' : log.level === 'warn' ? 'WRN' : (log.level as string) === 'debug' ? 'DBG' : 'INF'}</span>
                            <span>{log.message}</span>
                        </div>
                    ))}
                </div>

                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 min-h-[180px] max-h-[320px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Structured daemon trace</div>
                    {debugTrace.length === 0 && (
                        <div className="p-6 text-center text-text-muted">No trace entries yet. Run daemon with --dev or --trace.</div>
                    )}
                    {debugTrace.map((entry) => (
                        <div key={entry.id} className="py-1 border-b border-white/5 last:border-b-0">
                            <div className="flex gap-2 text-[10px] text-text-muted">
                                <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                                <span>{entry.level.toUpperCase()}</span>
                                <span>{entry.category}.{entry.stage}</span>
                                {entry.interactionId && <span>ix={entry.interactionId}</span>}
                            </div>
                            <div>{formatPayload(entry.payload)}</div>
                        </div>
                    ))}
                </div>

                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 min-h-[160px] max-h-[260px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Browser debug events</div>
                    {webEvents.length === 0 && (
                        <div className="p-6 text-center text-text-muted">No browser debug events captured yet.</div>
                    )}
                    {webEvents.map((entry) => (
                        <div key={entry.id} className="py-1 border-b border-white/5 last:border-b-0">
                            <div className="flex gap-2 text-[10px] text-text-muted">
                                <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                                <span>{entry.kind}</span>
                                {entry.topic && <span>topic={entry.topic}</span>}
                                {entry.interactionId && <span>ix={entry.interactionId}</span>}
                            </div>
                            <div>{formatPayload(entry.payload)}</div>
                        </div>
                    ))}
                </div>
            </div>
            <div ref={logsEndRef} />
        </div>
    )
}
