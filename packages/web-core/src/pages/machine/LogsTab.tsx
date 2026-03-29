/**
 * LogsTab — Daemon log viewer with level filter and auto-refresh.
 */
import { useState, useEffect, useRef } from 'react'
import type { LogEntry } from './types'

interface LogsTabProps {
    machineId: string
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export default function LogsTab({ machineId, sendDaemonCommand }: LogsTabProps) {
    const [daemonLogs, setDaemonLogs] = useState<LogEntry[]>([])
    const [lastLogTs, setLastLogTs] = useState(0)
    const [autoRefresh, setAutoRefresh] = useState(true)
    const [logLevel, setLogLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('debug')
    const logsEndRef = useRef<HTMLDivElement>(null)
    const initialScrollDone = useRef(false)

    // Fetch daemon logs (ring buffer)
    useEffect(() => {
        if (!machineId || !autoRefresh) return
        const fetchLogs = async () => {
            try {
                const res: any = await sendDaemonCommand(machineId, 'get_logs', { count: 200, minLevel: logLevel, since: lastLogTs })
                const payload = res?.result || res
                if (res?.success && Array.isArray(payload?.logs) && payload.logs.length > 0) {
                    setDaemonLogs(prev => {
                        const combined = [...prev, ...payload.logs.map((l: any) => ({
                            timestamp: l.ts,
                            level: l.level as 'info' | 'warn' | 'error',
                            message: `[${l.category}] ${l.message}`,
                        }))].slice(-300)
                        return combined
                    })
                    const maxTs = Math.max(...payload.logs.map((l: any) => l.ts))
                    setLastLogTs(maxTs)
                }
            } catch { /* silent */ }
        }
        fetchLogs()
        const timer = setInterval(fetchLogs, 3000)
        return () => clearInterval(timer)
    }, [machineId, autoRefresh, lastLogTs, logLevel, sendDaemonCommand])

    // Auto-scroll
    useEffect(() => {
        if (autoRefresh && daemonLogs.length > 0) {
            const behavior = initialScrollDone.current ? 'smooth' : 'instant' as ScrollBehavior;
            setTimeout(() => {
                logsEndRef.current?.scrollIntoView({ behavior });
                initialScrollDone.current = true;
            }, 50)
        }
    }, [daemonLogs.length, autoRefresh])

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
                    <span className="text-[10px] text-text-muted">{daemonLogs.length} entries</span>
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className={`machine-btn ${
                            autoRefresh ? 'text-green-500 border-green-500/30' : ''
                        }`}
                    >{autoRefresh ? '⏸ Pause' : '▶ Resume'}</button>
                    <button
                        onClick={() => { setDaemonLogs([]); setLastLogTs(0) }}
                        className="machine-btn"
                    >Clear</button>
                </div>
            </div>
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 min-h-[200px] max-h-[500px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                {daemonLogs.length === 0 && (
                    <div className="p-10 text-center text-text-muted">
                        Loading daemon logs...
                    </div>
                )}
                {daemonLogs.map((log, i) => (
                    <div key={i} className="flex gap-2 py-px" style={{
                        color: log.level === 'error' ? '#ef4444' : log.level === 'warn' ? '#f59e0b' : (log.level as string) === 'debug' ? '#64748b' : '#94a3b8',
                    }}>
                        <span className="text-text-muted min-w-[75px] shrink-0">
                            {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="font-semibold min-w-[32px] shrink-0 text-[9px]" style={{
                            color: log.level === 'error' ? '#ef4444' : log.level === 'warn' ? '#f59e0b' : (log.level as string) === 'debug' ? '#475569' : '#8b5cf6',
                        }}>
                            {log.level === 'error' ? 'ERR' : log.level === 'warn' ? 'WRN' : (log.level as string) === 'debug' ? 'DBG' : 'INF'}
                        </span>
                        <span>{log.message}</span>
                    </div>
                ))}
                <div ref={logsEndRef} />
            </div>
        </div>
    )
}
