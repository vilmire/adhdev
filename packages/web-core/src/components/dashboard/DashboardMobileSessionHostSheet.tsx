import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DaemonData } from '../../types'
import { eventManager } from '../../managers/EventManager'
import { IconRefresh, IconServer, IconTerminal, IconUsers, IconWarning, IconX } from '../Icons'
import type { MobileMachineCard } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'

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
    recentTransitions: SessionHostRuntimeTransitionView[]
}

interface DashboardMobileSessionHostSheetProps {
    machineCards: MobileMachineCard[]
    conversations: ActiveConversation[]
    ides: DaemonData[]
    initialMachineId?: string | null
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onOpenConversation: (conversation: ActiveConversation) => void
    onClose: () => void
}

function unwrapCommandEnvelope(raw: any): any {
    if (raw?.result && typeof raw.result === 'object' && 'success' in raw.result) return raw.result
    return raw
}

function getRouteMachineId(id: string | null | undefined) {
    if (!id) return ''
    const value = String(id)
    return value.includes(':') ? value.split(':')[0] || value : value
}

function formatClock(timestamp?: number | null): string {
    if (!timestamp) return 'unknown'
    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
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

export default function DashboardMobileSessionHostSheet({
    machineCards,
    conversations,
    ides,
    initialMachineId,
    sendDaemonCommand,
    onOpenConversation,
    onClose,
}: DashboardMobileSessionHostSheetProps) {
    const [activeMachineId, setActiveMachineId] = useState<string | null>(initialMachineId || machineCards[0]?.id || null)
    const [diagnostics, setDiagnostics] = useState<SessionHostDiagnosticsView | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [busyActionKey, setBusyActionKey] = useState<string | null>(null)

    useEffect(() => {
        setActiveMachineId(initialMachineId || machineCards[0]?.id || null)
    }, [initialMachineId, machineCards])

    const activeMachine = useMemo(
        () => machineCards.find((machine) => machine.id === activeMachineId) || machineCards[0] || null,
        [activeMachineId, machineCards],
    )

    const activeCliEntries = useMemo(
        () => ides.filter(entry => {
            if (entry.daemonMode) return false
            if (entry.transport !== 'pty') return false
            const entryMachineId = getRouteMachineId(entry.daemonId || entry.id)
            return !!activeMachine?.id && entryMachineId === activeMachine.id
        }),
        [activeMachine?.id, ides],
    )

    const linkedConversationBySessionId = useMemo(() => {
        const map = new Map<string, ActiveConversation>()
        for (const entry of activeCliEntries) {
            const conversation = conversations.find((candidate) => (
                candidate.sessionId === entry.sessionId
                || candidate.ideId === entry.id
            ))
            if (entry.sessionId && conversation) map.set(entry.sessionId, conversation)
        }
        return map
    }, [activeCliEntries, conversations])

    const loadDiagnostics = useCallback(async (opts?: { silent?: boolean }) => {
        if (!activeMachine?.id) return
        if (!opts?.silent) setLoading(true)
        try {
            const raw = await sendDaemonCommand(activeMachine.id, 'session_host_get_diagnostics', {
                includeSessions: true,
                limit: 6,
            })
            const envelope = unwrapCommandEnvelope(raw)
            if (!envelope?.success) throw new Error(envelope?.error || 'Could not load session host diagnostics')
            setDiagnostics((envelope.diagnostics || envelope.result || null) as SessionHostDiagnosticsView | null)
            setError('')
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Could not load session host diagnostics'
            setError(message)
        } finally {
            if (!opts?.silent) setLoading(false)
        }
    }, [activeMachine?.id, sendDaemonCommand])

    useEffect(() => {
        void loadDiagnostics()
        const timer = window.setInterval(() => {
            void loadDiagnostics({ silent: true })
        }, 10000)
        return () => window.clearInterval(timer)
    }, [loadDiagnostics])

    const runSessionAction = useCallback(async (
        action: 'session_host_resume_session' | 'session_host_restart_session' | 'session_host_stop_session',
        session: SessionHostRecordView,
    ) => {
        if (!activeMachine?.id) return
        if (action === 'session_host_stop_session') {
            const confirmed = window.confirm(`Stop ${session.displayName}?\nThis will terminate the hosted runtime.`)
            if (!confirmed) return
        }

        const actionKey = `${action}:${session.sessionId}`
        setBusyActionKey(actionKey)
        try {
            const raw = await sendDaemonCommand(activeMachine.id, action, { sessionId: session.sessionId })
            const envelope = unwrapCommandEnvelope(raw)
            if (!envelope?.success) throw new Error(envelope?.error || 'Session host action failed')
            const verb = action === 'session_host_resume_session'
                ? 'resumed'
                : action === 'session_host_restart_session'
                    ? 'restarted'
                    : 'stopped'
            eventManager.showToast(`Session host ${verb}: ${session.displayName}`, 'success')
            await loadDiagnostics({ silent: true })
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Session host action failed'
            setError(message)
            eventManager.showToast(message, 'warning')
        } finally {
            setBusyActionKey((current) => (current === actionKey ? null : current))
        }
    }, [activeMachine?.id, loadDiagnostics, sendDaemonCommand])

    const runPruneDuplicates = useCallback(async () => {
        if (!activeMachine?.id) return
        const confirmed = window.confirm('Prune duplicate hosted runtimes?\nThe newest runtime for each provider session will be kept and older duplicates will be stopped and removed.')
        if (!confirmed) return

        setBusyActionKey('session_host_prune_duplicate_sessions')
        try {
            const raw = await sendDaemonCommand(activeMachine.id, 'session_host_prune_duplicate_sessions', {})
            const envelope = unwrapCommandEnvelope(raw)
            if (!envelope?.success) throw new Error(envelope?.error || 'Duplicate prune failed')
            const result = envelope.result || {}
            const prunedCount = Array.isArray(result.prunedSessionIds) ? result.prunedSessionIds.length : 0
            const groupCount = typeof result.duplicateGroupCount === 'number' ? result.duplicateGroupCount : 0
            eventManager.showToast(`Pruned ${prunedCount} duplicate runtime(s) across ${groupCount} group(s)`, 'success')
            await loadDiagnostics({ silent: true })
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Duplicate prune failed'
            setError(message)
            eventManager.showToast(message, 'warning')
        } finally {
            setBusyActionKey((current) => (current === 'session_host_prune_duplicate_sessions' ? null : current))
        }
    }, [activeMachine?.id, loadDiagnostics, sendDaemonCommand])

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

    const latestWarnOrError = useMemo(
        () => [...(diagnostics?.recentLogs || [])].reverse().find((entry) => entry.level === 'warn' || entry.level === 'error') || null,
        [diagnostics?.recentLogs],
    )

    const recentTransitions = useMemo(
        () => [...(diagnostics?.recentTransitions || [])].slice(-3).reverse(),
        [diagnostics?.recentTransitions],
    )

    return (
        <div className="fixed inset-0 z-[115] flex items-end justify-center bg-black/55 backdrop-blur-[2px] md:items-center md:p-4" onClick={onClose}>
            <div
                className="w-full max-h-[88vh] overflow-hidden rounded-t-[28px] border border-border-subtle bg-bg-primary shadow-[0_-20px_60px_rgba(0,0,0,0.35)] md:max-w-3xl md:rounded-[28px] md:shadow-[0_20px_60px_rgba(0,0,0,0.35)]"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-border-subtle" />
                <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                            <IconServer size={14} /> Session Host
                        </div>
                        <div className="mt-1 text-[18px] font-black tracking-tight text-text-primary">
                            {activeMachine?.label || 'No machine selected'}
                        </div>
                        <div className="mt-1 text-[12px] text-text-secondary">
                            Hosted CLI runtime recovery and control.
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            className="flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle bg-bg-secondary text-text-secondary"
                            onClick={() => { void loadDiagnostics() }}
                            disabled={loading}
                            aria-label="Refresh session host"
                        >
                            <IconRefresh size={16} />
                        </button>
                        <button
                            type="button"
                            className="flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle bg-bg-secondary text-text-secondary"
                            onClick={onClose}
                            aria-label="Close session host"
                        >
                            <IconX size={16} />
                        </button>
                    </div>
                </div>

                {machineCards.length > 1 && (
                    <div className="flex gap-2 overflow-x-auto px-5 pb-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {machineCards.map((machine) => (
                            <button
                                key={machine.id}
                                type="button"
                                className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                                    machine.id === activeMachine?.id
                                        ? 'border-accent-primary/40 bg-accent-primary/12 text-accent-primary'
                                        : 'border-border-subtle bg-bg-secondary text-text-secondary'
                                }`}
                                onClick={() => setActiveMachineId(machine.id)}
                            >
                                {machine.label}
                            </button>
                        ))}
                    </div>
                )}

                <div className="flex max-h-[calc(88vh-122px)] flex-col gap-3 overflow-y-auto px-5 pb-[calc(18px+env(safe-area-inset-bottom,0px))]">
                    {error && !diagnostics && (
                        <div className="rounded-2xl border border-amber-500/[0.22] bg-amber-500/[0.08] px-4 py-3 text-[12px] text-amber-100">
                            <div className="flex items-start gap-2">
                                <IconWarning size={14} className="mt-0.5 shrink-0 text-amber-300" />
                                <div>
                                    <div className="font-medium">Session host unavailable</div>
                                    <div className="mt-1 text-amber-200/90">{error}</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {diagnostics && (
                        <>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="rounded-2xl border border-border-subtle bg-bg-secondary px-3 py-3">
                                    <div className="text-[10px] uppercase tracking-[0.16em] text-text-secondary">Runtimes</div>
                                    <div className="mt-1 text-[18px] font-bold text-text-primary">{diagnostics.runtimeCount}</div>
                                </div>
                                <div className="rounded-2xl border border-border-subtle bg-bg-secondary px-3 py-3">
                                    <div className="text-[10px] uppercase tracking-[0.16em] text-text-secondary">Clients</div>
                                    <div className="mt-1 text-[18px] font-bold text-text-primary">{totalAttachedClients}</div>
                                </div>
                                <div className="rounded-2xl border border-border-subtle bg-bg-secondary px-3 py-3">
                                    <div className="text-[10px] uppercase tracking-[0.16em] text-text-secondary">Started</div>
                                    <div className="mt-1 text-[12px] font-semibold text-text-primary">{formatRelativeTime(diagnostics.hostStartedAt)}</div>
                                    <div className="mt-0.5 text-[10px] text-text-secondary">{formatClock(diagnostics.hostStartedAt)}</div>
                                </div>
                            </div>

                            {latestWarnOrError && (
                                <div className="rounded-2xl border border-amber-500/[0.16] bg-amber-500/[0.07] px-4 py-3">
                                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
                                        <IconWarning size={13} /> Latest warning
                                    </div>
                                    <div className="text-[13px] leading-relaxed text-text-primary">{latestWarnOrError.message}</div>
                                </div>
                            )}

                            <div className="flex items-center justify-between gap-3 pt-1">
                                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                                    <IconTerminal size={14} /> Hosted runtimes
                                </div>
                                <div className="flex items-center gap-2">
                                    {duplicateGroupCount > 0 && (
                                        <button
                                            type="button"
                                            className="machine-btn px-2.5 py-1 text-[11px]"
                                            disabled={busyActionKey === 'session_host_prune_duplicate_sessions'}
                                            onClick={() => { void runPruneDuplicates() }}
                                        >
                                            {busyActionKey === 'session_host_prune_duplicate_sessions'
                                                ? 'Pruning…'
                                                : `Prune ${duplicateGroupCount}`}
                                        </button>
                                    )}
                                    <div className="text-[11px] text-text-secondary">{activeCliEntries.length} dashboard session{activeCliEntries.length === 1 ? '' : 's'}</div>
                                </div>
                            </div>

                            {sessions.length === 0 ? (
                                <div className="rounded-2xl border border-border-subtle bg-bg-secondary px-4 py-4 text-[13px] text-text-secondary">
                                    No hosted CLI runtimes on this machine yet.
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {sessions.map((session) => {
                                        const linkedConversation = linkedConversationBySessionId.get(session.sessionId)
                                        const linkedCli = activeCliEntries.find((entry) => entry.sessionId === session.sessionId)
                                        const busyResume = busyActionKey === `session_host_resume_session:${session.sessionId}`
                                        const busyRestart = busyActionKey === `session_host_restart_session:${session.sessionId}`
                                        const busyStop = busyActionKey === `session_host_stop_session:${session.sessionId}`
                                        const recoveryLabel = describeRecoveryState(session.meta)
                                        const recoveryError = typeof session.meta?.runtimeRecoveryError === 'string'
                                            ? String(session.meta.runtimeRecoveryError)
                                            : ''
                                        return (
                                            <div key={session.sessionId} className="rounded-2xl border border-border-subtle bg-bg-secondary px-4 py-3.5">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <div className="text-[14px] font-bold text-text-primary">
                                                                {session.displayName || linkedCli?.runtimeDisplayName || linkedCli?.cliName || session.providerType}
                                                            </div>
                                                            <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${lifecyclePillClass(session.lifecycle)}`}>
                                                                {session.lifecycle}
                                                            </span>
                                                            {recoveryLabel && (
                                                                <span className="rounded-md bg-sky-500/[0.08] px-2 py-0.5 text-[10px] font-semibold text-sky-300">
                                                                    {recoveryLabel}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="mt-1 text-[12px] text-text-secondary">
                                                            {session.workspaceLabel || linkedCli?.runtimeWorkspaceLabel || session.workspace || 'No workspace'}
                                                        </div>
                                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                                                            <span className="font-mono text-text-primary">{session.runtimeKey}</span>
                                                            <span className="text-text-muted">·</span>
                                                            <span className={session.writeOwner?.ownerType === 'user' ? 'text-amber-200' : 'text-text-primary/85'}>
                                                                {describeOwner(session.writeOwner)}
                                                            </span>
                                                            <span className="text-text-muted">·</span>
                                                            <span className="flex items-center gap-1 text-text-primary/85">
                                                                <IconUsers size={11} /> {session.attachedClients.length}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1 text-[11px] text-text-secondary">
                                                            Active {formatRelativeTime(session.lastActivityAt)}
                                                            {session.osPid ? ` · pid ${session.osPid}` : ''}
                                                        </div>
                                                        {recoveryError && (
                                                            <div className="mt-2 rounded-xl border border-red-500/[0.18] bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-200">
                                                                {recoveryError}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    {linkedConversation && (
                                                        <button
                                                            type="button"
                                                            className="machine-btn px-2.5 py-1 text-[11px]"
                                                            onClick={() => {
                                                                onOpenConversation(linkedConversation)
                                                                onClose()
                                                            }}
                                                        >
                                                            Open chat
                                                        </button>
                                                    )}
                                                    {(session.lifecycle === 'interrupted' || session.lifecycle === 'failed' || session.lifecycle === 'stopped') && (
                                                        <button
                                                            type="button"
                                                            className="machine-btn px-2.5 py-1 text-[11px]"
                                                            disabled={!!busyActionKey}
                                                            onClick={() => { void runSessionAction('session_host_resume_session', session) }}
                                                        >
                                                            {busyResume ? 'Resuming…' : 'Resume'}
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="machine-btn px-2.5 py-1 text-[11px]"
                                                        disabled={!!busyActionKey}
                                                        onClick={() => { void runSessionAction('session_host_restart_session', session) }}
                                                    >
                                                        {busyRestart ? 'Restarting…' : 'Restart'}
                                                    </button>
                                                    {(session.lifecycle === 'running' || session.lifecycle === 'starting' || session.lifecycle === 'interrupted') && (
                                                        <button
                                                            type="button"
                                                            className="machine-btn border-red-500/20 px-2.5 py-1 text-[11px] text-red-300 hover:text-red-200"
                                                            disabled={!!busyActionKey}
                                                            onClick={() => { void runSessionAction('session_host_stop_session', session) }}
                                                        >
                                                            {busyStop ? 'Stopping…' : 'Stop'}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}

                            {recentTransitions.length > 0 && (
                                <div className="pb-1">
                                    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                                        Recent activity
                                    </div>
                                    <div className="rounded-2xl border border-border-subtle bg-bg-secondary divide-y divide-border-subtle">
                                        {recentTransitions.map((transition) => {
                                            const session = sessions.find((item) => item.sessionId === transition.sessionId)
                                            return (
                                                <div key={`${transition.sessionId}:${transition.timestamp}:${transition.action}`} className="flex items-start justify-between gap-3 px-4 py-2.5">
                                                    <div className="min-w-0">
                                                        <div className="text-[12px] font-semibold text-text-primary">
                                                            {session?.displayName || transition.sessionId}
                                                        </div>
                                                        <div className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">
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
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
