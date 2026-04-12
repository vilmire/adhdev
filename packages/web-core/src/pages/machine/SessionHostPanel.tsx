import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionHostDiagnosticsSnapshot } from '@adhdev/daemon-core'
import { IconRefresh, IconServer, IconTerminal, IconUsers, IconWarning } from '../../components/Icons'
import { eventManager } from '../../managers/EventManager'
import { useSessionHostDiagnosticsSubscription } from '../../hooks/useSessionHostDiagnosticsSubscription'
import type { CliSessionEntry } from './types'

interface SessionHostAttachedClient {
    clientId: string
    type: string
    readOnly: boolean
    attachedAt: number
    lastSeenAt: number
}

interface SessionHostWriteOwner {
    clientId: string
    ownerType: 'agent' | 'user'
    acquiredAt: number
}

interface SessionHostRecordView {
    sessionId: string
    runtimeKey: string
    displayName: string
    workspaceLabel: string
    providerType: string
    workspace: string
    lifecycle: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted'
    writeOwner: SessionHostWriteOwner | null
    attachedClients: SessionHostAttachedClient[]
    osPid?: number
    lastActivityAt: number
    createdAt: number
    startedAt?: number
    meta?: Record<string, unknown>
}

interface SessionHostLogEntryView {
    timestamp: number
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    sessionId?: string
}

interface SessionHostRequestTraceView {
    timestamp: number
    requestId: string
    type: string
    sessionId?: string
    clientId?: string
    success: boolean
    durationMs: number
    error?: string
}

interface SessionHostRuntimeTransitionView {
    timestamp: number
    sessionId: string
    action: string
    lifecycle?: string
    detail?: string
    success?: boolean
    error?: string
}

interface SessionHostDiagnosticsView {
    hostStartedAt: number
    endpoint: string
    runtimeCount: number
    sessions?: SessionHostRecordView[]
    recentLogs: SessionHostLogEntryView[]
    recentRequests: SessionHostRequestTraceView[]
    recentTransitions: SessionHostRuntimeTransitionView[]
}

interface SessionHostPanelProps {
    machineId: string
    cliSessions: CliSessionEntry[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

function unwrapCommandEnvelope(raw: any): any {
    if (raw?.result && typeof raw.result === 'object' && 'success' in raw.result) {
        return raw.result
    }
    return raw
}

function formatClock(timestamp?: number | null): string {
    if (!timestamp) return 'unknown'
    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    })
}

function formatRelativeTime(timestamp?: number | null): string {
    if (!timestamp) return 'unknown'
    const diffMs = Date.now() - timestamp
    const diffSeconds = Math.max(0, Math.round(diffMs / 1000))
    if (diffSeconds < 60) return `${diffSeconds}s ago`
    const diffMinutes = Math.round(diffSeconds / 60)
    if (diffMinutes < 60) return `${diffMinutes}m ago`
    const diffHours = Math.round(diffMinutes / 60)
    if (diffHours < 48) return `${diffHours}h ago`
    const diffDays = Math.round(diffHours / 24)
    return `${diffDays}d ago`
}

function describeOwner(owner: SessionHostWriteOwner | null | undefined): string {
    if (!owner) return 'view only'
    if (owner.ownerType === 'user') return `user control · ${owner.clientId}`
    return `agent control · ${owner.clientId}`
}

function describeRecoveryState(meta: Record<string, unknown> | undefined): string | null {
    const recoveryState = typeof meta?.runtimeRecoveryState === 'string'
        ? String(meta.runtimeRecoveryState)
        : ''
    if (!recoveryState) return null
    if (recoveryState === 'auto_resumed') return 'restored after restart'
    if (recoveryState === 'resume_failed') return 'restore failed'
    if (recoveryState === 'host_restart_interrupted') return 'host restart interrupted'
    if (recoveryState === 'orphan_snapshot') return 'snapshot recovered'
    return recoveryState.replace(/_/g, ' ')
}

function lifecyclePillClass(lifecycle: string): string {
    switch (lifecycle) {
        case 'running':
            return 'bg-green-500/[0.08] text-green-500'
        case 'starting':
            return 'bg-sky-500/[0.08] text-sky-400'
        case 'stopping':
            return 'bg-orange-500/[0.08] text-orange-400'
        case 'interrupted':
            return 'bg-amber-500/[0.08] text-amber-400'
        case 'failed':
            return 'bg-red-500/[0.08] text-red-500'
        default:
            return 'bg-[#ffffff0a] text-text-muted'
    }
}

function countDuplicateSessionGroups(sessions: SessionHostRecordView[]): number {
    const groups = new Map<string, number>()
    for (const session of sessions) {
        if (!['starting', 'running', 'stopping', 'interrupted'].includes(session.lifecycle)) continue
        const providerSessionId = typeof session.meta?.providerSessionId === 'string'
            ? String(session.meta.providerSessionId).trim()
            : ''
        if (!providerSessionId) continue
        const key = `${session.providerType}::${session.workspace}::${providerSessionId}`
        groups.set(key, (groups.get(key) || 0) + 1)
    }
    return Array.from(groups.values()).filter((count) => count > 1).length
}

export default function SessionHostPanel({
    machineId,
    cliSessions,
    sendDaemonCommand,
}: SessionHostPanelProps) {
    const [error, setError] = useState('')
    const [busyActionKey, setBusyActionKey] = useState<string | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const sessionHostSubscription = useSessionHostDiagnosticsSubscription(machineId, {
        enabled: !!machineId,
        includeSessions: true,
        limit: 12,
        intervalMs: 8000,
    })
    const diagnostics = sessionHostSubscription.diagnostics as SessionHostDiagnosticsView | null
    const loading = sessionHostSubscription.loading
    const applyDiagnostics = sessionHostSubscription.applyDiagnostics
    const cliBySessionId = useMemo(
        () => new Map(cliSessions.map((session) => [session.sessionId || session.id, session])),
        [cliSessions],
    )

    const refreshDiagnostics = useCallback(async () => {
        if (!machineId) return
        setRefreshing(true)
        try {
            const raw = await sendDaemonCommand(machineId, 'session_host_get_diagnostics', {
                includeSessions: true,
                limit: 12,
            })
            const envelope = unwrapCommandEnvelope(raw)
            if (!envelope?.success) {
                throw new Error(envelope?.error || 'Could not load session host diagnostics')
            }
            applyDiagnostics((envelope.diagnostics || envelope.result || null) as SessionHostDiagnosticsSnapshot | null)
            setError('')
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Could not load session host diagnostics'
            setError(message)
        } finally {
            setRefreshing(false)
        }
    }, [applyDiagnostics, machineId, sendDaemonCommand])

    useEffect(() => {
        if (!machineId || diagnostics || loading || refreshing) return
        void refreshDiagnostics()
    }, [diagnostics, loading, machineId, refreshDiagnostics, refreshing])

    const runSessionAction = useCallback(async (
        action: 'session_host_resume_session' | 'session_host_restart_session' | 'session_host_stop_session',
        session: SessionHostRecordView,
    ) => {
        const actionKey = `${action}:${session.sessionId}`
        if (action === 'session_host_stop_session') {
            const confirmed = window.confirm(`Stop ${session.displayName}?\nThis will terminate the hosted runtime.`)
            if (!confirmed) return
        }

        setBusyActionKey(actionKey)
        try {
            const raw = await sendDaemonCommand(machineId, action, { sessionId: session.sessionId })
            const envelope = unwrapCommandEnvelope(raw)
            if (!envelope?.success) {
                throw new Error(envelope?.error || 'Session host action failed')
            }
            const verb = action === 'session_host_resume_session'
                ? 'resumed'
                : action === 'session_host_restart_session'
                    ? 'restarted'
                    : 'stopped'
            eventManager.showToast(`Session host ${verb}: ${session.displayName}`, 'success')
            await refreshDiagnostics()
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Session host action failed'
            eventManager.showToast(message, 'warning')
            setError(message)
        } finally {
            setBusyActionKey((current) => (current === actionKey ? null : current))
        }
    }, [machineId, refreshDiagnostics, sendDaemonCommand])

    const runPruneDuplicates = useCallback(async () => {
        const confirmed = window.confirm('Prune duplicate hosted runtimes?\nThe newest runtime for each provider session will be kept and older duplicates will be stopped and removed.')
        if (!confirmed) return

        setBusyActionKey('session_host_prune_duplicate_sessions')
        try {
            const raw = await sendDaemonCommand(machineId, 'session_host_prune_duplicate_sessions', {})
            const envelope = unwrapCommandEnvelope(raw)
            if (!envelope?.success) {
                throw new Error(envelope?.error || 'Duplicate prune failed')
            }
            const result = envelope.result || {}
            const prunedCount = Array.isArray(result.prunedSessionIds) ? result.prunedSessionIds.length : 0
            const groupCount = typeof result.duplicateGroupCount === 'number' ? result.duplicateGroupCount : 0
            eventManager.showToast(`Pruned ${prunedCount} duplicate runtime(s) across ${groupCount} group(s)`, 'success')
            await refreshDiagnostics()
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Duplicate prune failed'
            eventManager.showToast(message, 'warning')
            setError(message)
        } finally {
            setBusyActionKey((current) => (current === 'session_host_prune_duplicate_sessions' ? null : current))
        }
    }, [machineId, refreshDiagnostics, sendDaemonCommand])

    const sessions = useMemo(
        () => [...(diagnostics?.sessions || [])].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)),
        [diagnostics?.sessions],
    )
    const duplicateGroupCount = useMemo(
        () => countDuplicateSessionGroups(sessions),
        [sessions],
    )
    const totalAttachedClients = useMemo(
        () => sessions.reduce((sum, session) => sum + (session.attachedClients?.length || 0), 0),
        [sessions],
    )
    const recentTransitions = useMemo(
        () => [...(diagnostics?.recentTransitions || [])].slice(-6).reverse(),
        [diagnostics?.recentTransitions],
    )
    const latestWarnOrError = useMemo(
        () => [...(diagnostics?.recentLogs || [])].reverse().find((entry) => entry.level === 'warn' || entry.level === 'error') || null,
        [diagnostics?.recentLogs],
    )

    return (
        <div className="px-5 py-4 rounded-xl mb-5 bg-bg-secondary border border-border-subtle">
            <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                    <div className="text-[11px] text-text-secondary font-semibold uppercase tracking-wider flex items-center gap-1.5">
                        <IconServer size={14} /> Session Host
                    </div>
                    <div className="text-[12px] text-text-secondary mt-1">
                        Hosted CLI runtime diagnostics and recovery controls.
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {duplicateGroupCount > 0 && (
                        <button
                            type="button"
                            className="machine-btn"
                            onClick={() => { void runPruneDuplicates() }}
                            disabled={busyActionKey === 'session_host_prune_duplicate_sessions'}
                        >
                            {busyActionKey === 'session_host_prune_duplicate_sessions'
                                ? 'Pruning…'
                                : `Prune duplicates (${duplicateGroupCount})`}
                        </button>
                    )}
                    <span className={`px-2 py-1 rounded-md text-[10px] font-semibold ${
                        diagnostics ? 'bg-green-500/[0.08] text-green-500' : 'bg-amber-500/[0.08] text-amber-400'
                    }`}>
                        {diagnostics ? 'Managed' : 'Unavailable'}
                    </span>
                    <button
                        type="button"
                        className="machine-btn flex items-center gap-1"
                        onClick={() => { void refreshDiagnostics() }}
                        disabled={loading || refreshing}
                    >
                        <IconRefresh size={13} />
                        {loading || refreshing ? 'Refreshing…' : 'Refresh'}
                    </button>
                </div>
            </div>

            {error && !diagnostics && (
                <div className="rounded-xl border border-amber-500/[0.22] bg-amber-500/[0.08] px-3.5 py-3 text-[12px] text-amber-200 mb-3">
                    <div className="flex items-start gap-2">
                        <IconWarning size={14} className="mt-0.5 text-amber-300 shrink-0" />
                        <div>
                            <div className="font-medium text-amber-100">Session host diagnostics unavailable</div>
                            <div className="text-amber-200/90 mt-1">{error}</div>
                        </div>
                    </div>
                </div>
            )}

            {diagnostics && (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3 py-2.5">
                            <div className="text-[10px] uppercase tracking-wider text-text-secondary">Runtimes</div>
                            <div className="text-[18px] font-semibold text-text-primary mt-1">{diagnostics.runtimeCount}</div>
                        </div>
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3 py-2.5">
                            <div className="text-[10px] uppercase tracking-wider text-text-secondary">Clients</div>
                            <div className="text-[18px] font-semibold text-text-primary mt-1">{totalAttachedClients}</div>
                        </div>
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3 py-2.5">
                            <div className="text-[10px] uppercase tracking-wider text-text-secondary">Requests</div>
                            <div className="text-[18px] font-semibold text-text-primary mt-1">{diagnostics.recentRequests.length}</div>
                        </div>
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3 py-2.5">
                            <div className="text-[10px] uppercase tracking-wider text-text-secondary">Started</div>
                            <div className="text-[12px] font-medium text-text-primary mt-1">{formatRelativeTime(diagnostics.hostStartedAt)}</div>
                            <div className="text-[10px] text-text-secondary mt-0.5">{formatClock(diagnostics.hostStartedAt)}</div>
                        </div>
                    </div>

                    {latestWarnOrError && (
                        <div className="rounded-xl border border-amber-500/[0.16] bg-amber-500/[0.07] px-3.5 py-3 text-[11px] text-text-secondary mb-4">
                            <div className="flex items-center gap-1.5 text-amber-200 font-medium mb-1">
                                <IconWarning size={13} /> Latest host warning
                            </div>
                            <div className="text-text-primary leading-relaxed">{latestWarnOrError.message}</div>
                            <div className="text-[10px] text-text-secondary mt-1">
                                {formatClock(latestWarnOrError.timestamp)}
                                {latestWarnOrError.sessionId ? ` · ${latestWarnOrError.sessionId}` : ''}
                            </div>
                        </div>
                    )}

                    <div className="mb-4">
                        <div className="text-[11px] text-text-secondary font-semibold uppercase tracking-wider flex items-center gap-1.5 mb-2.5">
                            <IconTerminal size={14} /> Hosted Runtimes
                        </div>
                        {sessions.length === 0 ? (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-4 text-[12px] text-text-secondary">
                                No hosted runtimes on this machine yet.
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {sessions.map((session) => {
                                    const busyResume = busyActionKey === `session_host_resume_session:${session.sessionId}`
                                    const busyRestart = busyActionKey === `session_host_restart_session:${session.sessionId}`
                                    const busyStop = busyActionKey === `session_host_stop_session:${session.sessionId}`
                                    const recoveryLabel = describeRecoveryState(session.meta)
                                    const linkedCli = cliBySessionId.get(session.sessionId)
                                    const clientsLabel = session.attachedClients.length === 1
                                        ? '1 client'
                                        : `${session.attachedClients.length} clients`
                                    return (
                                        <div key={session.sessionId} className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <div className="font-medium text-[13px] text-text-primary">
                                                            {session.displayName || linkedCli?.cliName || session.providerType}
                                                        </div>
                                                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${lifecyclePillClass(session.lifecycle)}`}>
                                                            {session.lifecycle}
                                                        </span>
                                                        {recoveryLabel && (
                                                            <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-sky-500/[0.08] text-sky-300">
                                                                {recoveryLabel}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-[11px] text-text-secondary mt-1 flex flex-wrap gap-2">
                                                        <span className="text-text-primary/90">{session.workspaceLabel || linkedCli?.runtimeWorkspaceLabel || session.workspace || 'No workspace'}</span>
                                                        <span className="text-text-muted">·</span>
                                                        <span className="font-mono text-text-primary">{session.runtimeKey}</span>
                                                        {session.osPid ? (
                                                            <>
                                                                <span className="text-text-muted">·</span>
                                                                <span className="text-text-primary/90">pid {session.osPid}</span>
                                                            </>
                                                        ) : null}
                                                    </div>
                                                    <div className="text-[10px] text-text-secondary mt-1 flex flex-wrap gap-2">
                                                        <span className={session.writeOwner?.ownerType === 'user' ? 'text-amber-200' : 'text-text-primary/85'}>
                                                            {describeOwner(session.writeOwner)}
                                                        </span>
                                                        <span className="text-text-muted">·</span>
                                                        <span className="flex items-center gap-1 text-text-primary/85">
                                                            <IconUsers size={11} /> {clientsLabel}
                                                        </span>
                                                        <span className="text-text-muted">·</span>
                                                        <span className="text-text-primary/85">active {formatRelativeTime(session.lastActivityAt)}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    {(session.lifecycle === 'interrupted' || session.lifecycle === 'failed' || session.lifecycle === 'stopped') && (
                                                        <button
                                                            type="button"
                                                            className="machine-btn text-[10px] px-2 py-1"
                                                            disabled={!!busyActionKey}
                                                            onClick={() => { void runSessionAction('session_host_resume_session', session) }}
                                                        >
                                                            {busyResume ? 'Resuming…' : 'Resume'}
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="machine-btn text-[10px] px-2 py-1"
                                                        disabled={!!busyActionKey}
                                                        onClick={() => { void runSessionAction('session_host_restart_session', session) }}
                                                    >
                                                        {busyRestart ? 'Restarting…' : 'Restart'}
                                                    </button>
                                                    {(session.lifecycle === 'running' || session.lifecycle === 'starting' || session.lifecycle === 'interrupted') && (
                                                        <button
                                                            type="button"
                                                            className="machine-btn text-[10px] px-2 py-1 border-red-500/20 text-red-300 hover:text-red-200"
                                                            disabled={!!busyActionKey}
                                                            onClick={() => { void runSessionAction('session_host_stop_session', session) }}
                                                        >
                                                            {busyStop ? 'Stopping…' : 'Stop'}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="text-[11px] text-text-secondary font-semibold uppercase tracking-wider mb-2.5">
                            Recent Host Activity
                        </div>
                        {recentTransitions.length === 0 ? (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3 text-[12px] text-text-secondary">
                                No recent runtime transitions yet.
                            </div>
                        ) : (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary divide-y divide-border-subtle">
                                {recentTransitions.map((transition) => {
                                    const session = sessions.find((item) => item.sessionId === transition.sessionId)
                                    return (
                                        <div key={`${transition.sessionId}:${transition.timestamp}:${transition.action}`} className="px-3.5 py-2.5 text-[11px] flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-text-primary font-medium">
                                                    {(session?.displayName || cliBySessionId.get(transition.sessionId)?.cliName || transition.sessionId)}
                                                </div>
                                                <div className="text-text-secondary mt-0.5 leading-relaxed">
                                                    {transition.action}
                                                    {transition.lifecycle ? ` · ${transition.lifecycle}` : ''}
                                                    {transition.detail ? ` · ${transition.detail}` : ''}
                                                    {transition.error ? ` · ${transition.error}` : ''}
                                                </div>
                                            </div>
                                            <div className={`shrink-0 text-[10px] ${transition.success === false ? 'text-red-300' : 'text-text-secondary'}`}>
                                                {formatClock(transition.timestamp)}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    <div className="text-[10px] text-text-secondary mt-3">
                        Endpoint: <span className="font-mono text-text-primary">{diagnostics.endpoint || 'unknown'}</span>
                        {error ? <span className="text-amber-200"> · last error: {error}</span> : null}
                    </div>
                </>
            )}
        </div>
    )
}
