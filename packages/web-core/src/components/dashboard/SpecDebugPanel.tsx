import { useCallback, useEffect, useState } from 'react'
import { useTransport } from '../../context/TransportContext'
import type { ActiveConversation } from './types'

interface StateHistoryEntry {
    stateId: string
    label: string
    at: number
    durationMs: number
    reason?: string
    matchedStateId?: string
    matchedRules?: string[]
    debounceKind?: string
    idleHoldMs?: number
    busyHoldMs?: number
}

interface SpecSnapshot {
    cliType: string
    spec_id: string
    specPath?: string
    current_state: { id: string; label: string; title: string | null } | null
    current_modal: { title: string | null; buttons: { index: number; label: string }[] } | null
    activeInteractivePrompt: unknown
    exited: boolean
    screen: string
    sections: Record<string, string> | undefined
    stateHistory: StateHistoryEntry[]
    idleHoldPending: boolean
    lastBusyAt: number
    // Extended fields
    name?: string
    status?: string
    workingDir?: string
    spawnedAtMs?: number
    providerSessionId?: string | null
    messages?: Array<{ role: string; content: string; receivedAt?: number }>
    committedMessages?: Array<{ role: string; content: string; receivedAt?: number }>
}

interface SpecDebugResult {
    success: boolean
    error?: string
    sessionId?: string
    providerType?: string
    isSpecProvider?: boolean
    snapshot: SpecSnapshot | null
}

interface Props {
    activeConv: ActiveConversation
    onClose: () => void
}

function formatAgo(ms: number): string {
    const delta = Date.now() - ms
    if (delta < 0) return 'just now'
    if (delta < 2000) return `${delta}ms ago`
    if (delta < 60000) return `${(delta / 1000).toFixed(1)}s ago`
    const min = Math.floor(delta / 60000)
    if (min < 60) return `${min}m ago`
    return `${Math.floor(min / 60)}h ago`
}

function formatDur(ms: number): string {
    if (ms <= 0) return ''
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

const REASON_COLORS: Record<string, string> = {
    busy_hold_expired: 'text-amber-300 bg-amber-500/15',
    idle_hold_committed: 'text-green-300 bg-green-500/15',
    completion_idle_after: 'text-blue-300 bg-blue-500/15',
    forced_completion: 'text-orange-300 bg-orange-500/15',
    forceEmit: 'text-purple-300 bg-purple-500/15',
    spec_reload: 'text-purple-300 bg-purple-500/15',
}

const STATE_COLORS: Record<string, string> = {
    idle: 'text-green-400',
    busy: 'text-yellow-400',
    generating: 'text-yellow-400',
    approval: 'text-orange-400',
    waiting_approval: 'text-orange-400',
    picker: 'text-blue-400',
    signing_in: 'text-blue-400',
}

function stateColor(id: string): string {
    return STATE_COLORS[id] ?? 'text-white/70'
}

export default function SpecDebugPanel({ activeConv, onClose }: Props) {
    const { sendCommand } = useTransport()
    const [loading, setLoading] = useState(true)
    const [data, setData] = useState<SpecDebugResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showScreen, setShowScreen] = useState(false)
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['footer']))

    const daemonId = activeConv.daemonId || activeConv.routeId?.split(':')[0] || activeConv.routeId || ''
    const sessionId = activeConv.sessionId || ''

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const raw = await sendCommand(daemonId, 'get_spec_debug', { targetSessionId: sessionId })
            const envelope = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const inner = (envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope) as SpecDebugResult
            if (!inner?.success) {
                setError(inner?.error || 'Failed to load spec debug')
                setData(null)
            } else {
                setData(inner)
            }
        } catch (e: any) {
            setError(e?.message || String(e))
            setData(null)
        } finally {
            setLoading(false)
        }
    }, [sendCommand, daemonId, sessionId])

    useEffect(() => { void load() }, [load])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const snap = data?.snapshot

    const toggleSection = (id: string) => {
        setExpandedSections(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Spec debug"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={onClose}
            style={{ pointerEvents: 'auto' }}
        >
            <div
                className="bg-[var(--surface-primary)] text-text-primary border border-border-default rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3 shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-primary">Spec Debug</span>
                        {snap && (
                            <span className="text-[11px] text-text-secondary font-mono">
                                {snap.spec_id}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className="text-[11px] text-text-secondary hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-white/5"
                            onClick={() => { void load() }}
                            disabled={loading}
                        >
                            {loading ? 'Loading…' : 'Refresh'}
                        </button>
                        <button
                            type="button"
                            className="text-text-secondary hover:text-text-primary transition-colors text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/5"
                            onClick={onClose}
                            aria-label="Close"
                        >
                            ×
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[12px]">
                    {error && (
                        <div className="text-red-400 bg-red-500/10 rounded p-2">{error}</div>
                    )}

                    {loading && !data && (
                        <div className="text-text-secondary text-center py-6">Loading…</div>
                    )}

                    {data && !data.isSpecProvider && (
                        <div className="text-text-secondary text-center py-6">
                            Not a spec-driven provider ({data.providerType || 'unknown'}).
                        </div>
                    )}

                    {snap && (
                        <>
                            {/* Provider info */}
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                                {snap.name && (
                                    <>
                                        <span className="text-text-secondary">Provider</span>
                                        <span className="font-mono text-text-primary">{snap.name} <span className="text-text-tertiary">({snap.cliType})</span></span>
                                    </>
                                )}
                                {snap.workingDir && (
                                    <>
                                        <span className="text-text-secondary">Working dir</span>
                                        <span className="font-mono text-text-secondary truncate" title={snap.workingDir}>{snap.workingDir}</span>
                                    </>
                                )}
                                {snap.spawnedAtMs ? (
                                    <>
                                        <span className="text-text-secondary">Spawned</span>
                                        <span className="text-text-secondary">{formatAgo(snap.spawnedAtMs)}</span>
                                    </>
                                ) : null}
                                {snap.providerSessionId && (
                                    <>
                                        <span className="text-text-secondary">Session ID</span>
                                        <span className="font-mono text-text-tertiary text-[10px] truncate" title={snap.providerSessionId}>{snap.providerSessionId}</span>
                                    </>
                                )}
                            </div>

                            {/* State summary */}
                            <div className="flex items-center gap-3 flex-wrap">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-text-secondary">State:</span>
                                    <span className={`font-semibold font-mono ${snap.current_state ? stateColor(snap.current_state.id) : 'text-white/40'}`}>
                                        {snap.current_state ? `${snap.current_state.id}` : 'none'}
                                    </span>
                                    {snap.current_state?.label && snap.current_state.label !== snap.current_state.id && (
                                        <span className="text-text-secondary">({snap.current_state.label})</span>
                                    )}
                                </div>
                                {snap.status && snap.status !== snap.current_state?.id && (
                                    <div className="flex items-center gap-1">
                                        <span className="text-text-secondary">engine:</span>
                                        <span className={`font-mono ${stateColor(snap.status)}`}>{snap.status}</span>
                                    </div>
                                )}
                                {snap.idleHoldPending && (
                                    <span className="text-yellow-400/80 text-[11px] bg-yellow-500/10 px-1.5 py-0.5 rounded">idle hold pending</span>
                                )}
                                {snap.exited && (
                                    <span className="text-red-400/80 text-[11px] bg-red-500/10 px-1.5 py-0.5 rounded">exited</span>
                                )}
                                {snap.lastBusyAt > 0 && (
                                    <span className="text-text-secondary">last busy: {formatAgo(snap.lastBusyAt)}</span>
                                )}
                            </div>

                            {snap.current_modal && (
                                <div className="bg-orange-500/10 border border-orange-500/20 rounded p-2">
                                    <span className="text-orange-300 font-semibold">Modal: </span>
                                    <span className="text-text-secondary">{snap.current_modal.title || ''}</span>
                                    {snap.current_modal.buttons.length > 0 && (
                                        <span className="text-text-secondary ml-2">
                                            [{snap.current_modal.buttons.map(b => b.label).join(' / ')}]
                                        </span>
                                    )}
                                </div>
                            )}

                            {/* Sections */}
                            {snap.sections && Object.keys(snap.sections).length > 0 && (
                                <div>
                                    <div className="text-text-secondary text-[11px] uppercase tracking-wide mb-1.5">Sections</div>
                                    <div className="space-y-1">
                                        {Object.entries(snap.sections).map(([id, text]) => {
                                            const expanded = expandedSections.has(id)
                                            const lines = text.split('\n')
                                            const preview = lines[0]?.slice(0, 80) || '(empty)'
                                            return (
                                                <div key={id} className="border border-border-subtle rounded overflow-hidden">
                                                    <button
                                                        type="button"
                                                        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 transition-colors text-left"
                                                        onClick={() => toggleSection(id)}
                                                    >
                                                        <span className="text-[10px] text-white/40">{expanded ? '▾' : '▸'}</span>
                                                        <span className="font-mono text-blue-300/80 w-20 shrink-0">{id}</span>
                                                        {!expanded && (
                                                            <span className="text-text-secondary truncate font-mono text-[11px]">{preview}</span>
                                                        )}
                                                        <span className="ml-auto text-text-tertiary text-[10px] shrink-0">{lines.length}L</span>
                                                    </button>
                                                    {expanded && (
                                                        <pre className="px-2 pb-2 font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-all bg-black/20 max-h-40 overflow-y-auto">
                                                            {text || '(empty)'}
                                                        </pre>
                                                    )}
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* State history */}
                            {snap.stateHistory && snap.stateHistory.length > 0 && (
                                <div>
                                    <div className="text-text-secondary text-[11px] uppercase tracking-wide mb-1.5">
                                        State History ({snap.stateHistory.length})
                                    </div>
                                    <div className="space-y-0.5">
                                        {[...snap.stateHistory].reverse().slice(0, 20).map((entry, i) => (
                                            <div key={i} className="flex flex-col gap-0.5 py-0.5">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className={`font-mono w-20 shrink-0 ${stateColor(entry.stateId)}`}>
                                                        {entry.stateId}
                                                    </span>
                                                    <span className="text-text-secondary text-[11px] shrink-0">
                                                        {formatAgo(entry.at)}
                                                    </span>
                                                    {entry.durationMs > 0 && (
                                                        <span className="text-text-tertiary text-[11px]">
                                                            held {formatDur(entry.durationMs)}
                                                        </span>
                                                    )}
                                                    {entry.reason && entry.reason !== 'eval_match' && (
                                                        <span className={`text-[10px] px-1 py-0.5 rounded font-mono shrink-0 ${REASON_COLORS[entry.reason] ?? 'text-white/50 bg-white/5'}`}>
                                                            {entry.reason}
                                                        </span>
                                                    )}
                                                    {entry.debounceKind && entry.debounceKind !== 'none' && (
                                                        <span className="text-text-tertiary text-[10px]">
                                                            ({entry.debounceKind})
                                                        </span>
                                                    )}
                                                    {entry.matchedStateId && entry.matchedStateId !== entry.stateId && (
                                                        <span className="text-text-tertiary text-[10px] font-mono">
                                                            eval→{entry.matchedStateId}
                                                        </span>
                                                    )}
                                                </div>
                                                {entry.matchedRules && entry.matchedRules.length > 0 && (
                                                    <div className="flex items-center gap-1 flex-wrap pl-22 ml-[88px]">
                                                        {entry.matchedRules.slice(0, 3).map((rule, ri) => (
                                                            <span key={ri} className="font-mono text-[10px] text-blue-300/60 bg-blue-500/10 px-1 py-0.5 rounded">
                                                                {rule}
                                                            </span>
                                                        ))}
                                                        {entry.matchedRules.length > 3 && (
                                                            <span className="text-[10px] text-text-tertiary">+{entry.matchedRules.length - 3} more</span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Transcript messages */}
                            {(() => {
                                const msgs = snap.messages ?? snap.committedMessages ?? []
                                if (msgs.length === 0) return null
                                const userCount = msgs.filter(m => m.role === 'user').length
                                const assistantCount = msgs.filter(m => m.role === 'assistant').length
                                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                                return (
                                    <div>
                                        <div className="text-text-secondary text-[11px] uppercase tracking-wide mb-1.5">
                                            Transcript ({msgs.length} msgs — {userCount}u / {assistantCount}a)
                                        </div>
                                        {lastAssistant && (
                                            <div className="bg-black/20 border border-border-subtle rounded p-2 text-[11px]">
                                                <div className="text-text-tertiary mb-0.5">
                                                    Last assistant {lastAssistant.receivedAt ? formatAgo(lastAssistant.receivedAt) : ''}
                                                </div>
                                                <div className="text-text-secondary font-mono whitespace-pre-wrap line-clamp-4 break-all">
                                                    {lastAssistant.content.slice(0, 400)}{lastAssistant.content.length > 400 ? '…' : ''}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )
                            })()}

                            {/* Spec path */}
                            {snap.specPath && (
                                <div className="text-[11px] text-text-tertiary font-mono truncate" title={snap.specPath}>
                                    {snap.specPath}
                                </div>
                            )}

                            {/* Raw screen toggle */}
                            <div>
                                <button
                                    type="button"
                                    className="text-[11px] text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1"
                                    onClick={() => setShowScreen(v => !v)}
                                >
                                    <span>{showScreen ? '▾' : '▸'}</span>
                                    <span>Raw screen ({snap.screen ? snap.screen.split('\n').length : 0} lines)</span>
                                </button>
                                {showScreen && (
                                    <pre className="mt-1.5 px-2 py-2 font-mono text-[11px] text-text-secondary whitespace-pre bg-black/30 rounded border border-border-subtle max-h-64 overflow-auto">
                                        {snap.screen || '(empty)'}
                                    </pre>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
