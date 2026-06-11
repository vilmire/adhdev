import { useCallback, useEffect, useState } from 'react'
import { useTransport } from '../../context/TransportContext'
import type { ActiveConversation } from './types'
import SpecFormBuilder, { type SpecModel, type FsmCond, type PreviewMap } from './SpecFormBuilder'

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

/** v4 FSM live condition-eval node (mirrors fsm-evaluator CondResult). */
interface FsmCondNode {
    kind: string
    result: boolean
    detail: string
    remainingMs?: number
    children?: FsmCondNode[]
}

/** v4 FSM live transition row (mirrors fsm-evaluator TransitionEval). */
interface FsmTransitionEval {
    to: string
    label: string
    holdSatisfied: boolean
    holdRemainingMs: number
    condResult: boolean
    cond?: FsmCondNode
    fires: boolean
    priority: number
}

interface FsmDebug {
    currentState: string
    label: string
    stateAgeMs: number
    status: string
    cursor: { row: number; col: number }
    transitions: FsmTransitionEval[]
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
    cursorPosition?: { row: number; col: number } | null
    completionIdleDebounce?: { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null
    /** v4 FSM live transition table (null for v3 debounce specs). */
    fsm?: FsmDebug | null
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
    busy_hold_expired: 'text-amber-200 bg-amber-500/20 border border-amber-500/30',
    idle_hold_committed: 'text-green-200 bg-green-500/20 border border-green-500/30',
    completion_idle_after: 'text-sky-200 bg-sky-500/20 border border-sky-500/30',
    forced_completion: 'text-orange-200 bg-orange-500/20 border border-orange-500/30',
    forceEmit: 'text-purple-200 bg-purple-500/20 border border-purple-500/30',
    spec_reload: 'text-purple-200 bg-purple-500/20 border border-purple-500/30',
    eval_match: 'text-zinc-300 bg-zinc-500/15 border border-zinc-500/20',
}

const STATE_BADGE: Record<string, string> = {
    idle: 'text-green-100 bg-green-600/30 border border-green-500/40',
    busy: 'text-yellow-100 bg-yellow-600/30 border border-yellow-500/40',
    generating: 'text-yellow-100 bg-yellow-600/30 border border-yellow-500/40',
    approval: 'text-orange-100 bg-orange-600/30 border border-orange-500/40',
    waiting_approval: 'text-orange-100 bg-orange-600/30 border border-orange-500/40',
    picker: 'text-sky-100 bg-sky-600/30 border border-sky-500/40',
    signing_in: 'text-sky-100 bg-sky-600/30 border border-sky-500/40',
}

function stateBadge(id: string): string {
    return STATE_BADGE[id] ?? 'text-zinc-200 bg-zinc-600/20 border border-zinc-500/30'
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold mb-1.5 mt-0.5">
            {children}
        </div>
    )
}

function Divider() {
    return <div className="border-t border-white/8 my-2" />
}

/** Recursive render of an FSM condition-eval tree — shows each leaf's match
 *  result and any time countdown so "why isn't it transitioning" is visible. */
function CondTree({ node, depth = 0 }: { node: FsmCondNode; depth?: number }) {
    const color = node.result ? 'text-green-300' : 'text-zinc-500'
    const dot = node.result ? '●' : '○'
    return (
        <div style={{ marginLeft: depth * 10 }} className="font-mono text-[10px] leading-relaxed">
            <span className={color}>{dot} </span>
            <span className="text-zinc-400">{node.kind}</span>
            <span className="text-zinc-500"> {node.detail}</span>
            {node.remainingMs != null && node.remainingMs > 0 && (
                <span className="text-amber-300"> ({node.remainingMs}ms left)</span>
            )}
            {node.children?.map((c, i) => <CondTree key={i} node={c} depth={depth + 1} />)}
        </div>
    )
}

/** One outgoing transition with its fire/hold/cond status. */
function TransitionRow({ t }: { t: FsmTransitionEval }) {
    const [open, setOpen] = useState(false)
    const status = t.fires
        ? 'text-green-200 bg-green-600/25 border-green-500/40'
        : !t.holdSatisfied
            ? 'text-amber-200 bg-amber-600/20 border-amber-500/30'
            : 'text-zinc-400 bg-zinc-700/30 border-zinc-600/30'
    return (
        <div className="border border-zinc-700/50 rounded bg-zinc-800/30 overflow-hidden">
            <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1 hover:bg-zinc-700/30 text-left"
                onClick={() => setOpen(o => !o)}
            >
                <span className="text-[10px] text-zinc-500 w-3">{t.cond ? (open ? '▾' : '▸') : ' '}</span>
                <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded border ${status}`}>→ {t.to}</span>
                <span className="text-zinc-400 font-mono text-[10px] truncate">{t.label}</span>
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    {t.fires && <span className="text-green-300 text-[10px] font-mono">FIRES</span>}
                    {!t.holdSatisfied && <span className="text-amber-300 text-[10px] font-mono">hold {t.holdRemainingMs}ms</span>}
                    <span className={`text-[10px] font-mono ${t.condResult ? 'text-green-400' : 'text-zinc-600'}`}>
                        {t.condResult ? 'cond✓' : 'cond✗'}
                    </span>
                </span>
            </button>
            {open && t.cond && (
                <div className="px-3 pb-1.5 pt-0.5 bg-black/30 border-t border-zinc-700/50">
                    <CondTree node={t.cond} />
                </div>
            )}
        </div>
    )
}

export default function SpecDebugPanel({ activeConv, onClose }: Props) {
    const { sendCommand } = useTransport()
    const [loading, setLoading] = useState(true)
    const [data, setData] = useState<SpecDebugResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showScreen, setShowScreen] = useState(false)
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['footer']))
    const [snapshotLabel, setSnapshotLabel] = useState<'Snapshot' | 'Copied!'>('Snapshot')

    // ── Live spec editor (load file → structured edit → save → hot-reload) ──
    const [editing, setEditing] = useState(false)
    const [specModel, setSpecModel] = useState<SpecModel | null>(null)
    const [rawMode, setRawMode] = useState(false)
    const [specSource, setSpecSource] = useState('')
    const [specDirty, setSpecDirty] = useState(false)
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
    const [saveError, setSaveError] = useState<string | null>(null)
    const [validationErrors, setValidationErrors] = useState<string[]>([])
    const [preview, setPreview] = useState<PreviewMap>({})
    const [autoRefresh, setAutoRefresh] = useState(false)

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

    // Auto-refresh: poll the FSM debug state on an interval so transitions can
    // be watched live. Off by default; toggled in the FSM section header.
    useEffect(() => {
        if (!autoRefresh) return
        const iv = setInterval(() => { void load() }, 1000)
        return () => clearInterval(iv)
    }, [autoRefresh, load])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose, editing])

    // Validate the current model on the daemon (structure + refs + regex).
    const validateModel = useCallback(async (m: SpecModel) => {
        try {
            const raw = await sendCommand(daemonId, 'validate_spec', { content: JSON.stringify(m) })
            const env = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const inner = (env.result && typeof env.result === 'object' ? env.result : env) as { valid?: boolean; errors?: string[] }
            setValidationErrors(inner?.valid ? [] : (inner?.errors ?? ['validation failed']))
        } catch (e: any) {
            setValidationErrors([e?.message || String(e)])
        }
    }, [sendCommand, daemonId])

    const openEditor = useCallback(async () => {
        setSaveError(null)
        setSaveState('idle')
        setPreview({})
        try {
            const raw = await sendCommand(daemonId, 'get_spec_source', { targetSessionId: sessionId })
            const env = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const inner = (env.result && typeof env.result === 'object' ? env.result : env) as { success?: boolean; content?: string; error?: string }
            if (!inner?.success || typeof inner.content !== 'string') {
                setSaveError(inner?.error || 'Failed to load spec source')
                return
            }
            setSpecSource(inner.content)
            let parsed: SpecModel | null = null
            try { parsed = JSON.parse(inner.content) as SpecModel } catch { /* raw-only fallback */ }
            if (parsed && parsed.$schema === 'adhdev:cli/spec@4') {
                setSpecModel(parsed)
                setRawMode(false)
                void validateModel(parsed)
            } else {
                // Non-v4 spec — fall back to raw text editing.
                setSpecModel(null)
                setRawMode(true)
            }
            setSpecDirty(false)
            setEditing(true)
        } catch (e: any) {
            setSaveError(e?.message || String(e))
        }
    }, [sendCommand, daemonId, sessionId, validateModel])

    // Edit a model field → re-validate (debounced lightly by React batching).
    const onModelChange = useCallback((next: SpecModel) => {
        setSpecModel(next)
        setSpecSource(JSON.stringify(next, null, 2))
        setSpecDirty(true)
        setSaveState('idle')
        void validateModel(next)
    }, [validateModel])

    // Test one condition against the live session screen.
    const onPreview = useCallback(async (path: string, cond: FsmCond) => {
        setPreview(p => ({ ...p, [path]: 'loading' }))
        try {
            const raw = await sendCommand(daemonId, 'eval_condition_preview', { targetSessionId: sessionId, condition: cond })
            const env = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const inner = (env.result && typeof env.result === 'object' ? env.result : env) as { success?: boolean; result?: { result: boolean; detail?: string }; error?: string }
            if (!inner?.success || !inner.result) {
                setPreview(p => ({ ...p, [path]: { result: false, detail: inner?.error } }))
            } else {
                setPreview(p => ({ ...p, [path]: { result: inner.result!.result, detail: inner.result!.detail } }))
            }
        } catch (e: any) {
            setPreview(p => ({ ...p, [path]: { result: false, detail: e?.message } }))
        }
    }, [sendCommand, daemonId, sessionId])

    const saveSpec = useCallback(async () => {
        const specPath = data?.snapshot?.specPath
        if (!specPath) { setSaveError('No spec path on this session'); return }
        if (!rawMode && validationErrors.length > 0) { setSaveError('Fix validation errors before saving'); return }
        // In form mode the model is the source of truth; serialize it. In raw
        // mode the textarea is.
        const content = !rawMode && specModel ? JSON.stringify(specModel, null, 2) : specSource
        setSaveState('saving')
        setSaveError(null)
        try {
            const raw = await sendCommand(daemonId, 'write_spec_source', { specPath, content })
            const env = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const inner = (env.result && typeof env.result === 'object' ? env.result : env) as { success?: boolean; error?: string; validationErrors?: string[] }
            if (!inner?.success) {
                setSaveState('error')
                setSaveError(inner?.validationErrors?.join('\n') || inner?.error || 'Save failed')
                return
            }
            setSaveState('saved')
            setSpecDirty(false)
            // The driver's fs.watch hot-reloads; refresh after a beat so the
            // new transition table shows up.
            setTimeout(() => { void load() }, 400)
            setTimeout(() => setSaveState('idle'), 1500)
        } catch (e: any) {
            setSaveState('error')
            setSaveError(e?.message || String(e))
        }
    }, [sendCommand, daemonId, data?.snapshot?.specPath, specSource, specModel, rawMode, validationErrors, load])

    const snap = data?.snapshot

    const handleSnapshot = async () => {
        let resolved = data
        if (!resolved) {
            await load()
            resolved = data
        }
        const s = resolved?.snapshot
        const lines: string[] = []
        lines.push('# Spec Debug Snapshot')
        lines.push(`Generated: ${new Date().toISOString()}`)
        lines.push(`Session: ${resolved?.sessionId ?? ''} (${resolved?.providerType ?? ''})`)
        lines.push(`Spec: ${s?.spec_id ?? ''} (${s?.specPath ?? ''})`)
        lines.push(`Provider: ${s?.name ?? ''} (${s?.cliType ?? ''})`)
        lines.push(`Working dir: ${s?.workingDir ?? ''}`)
        lines.push(`Spawned: ${s?.spawnedAtMs ? new Date(s.spawnedAtMs).toISOString() : ''}`)
        lines.push('')
        lines.push('## Current State')
        lines.push(`State: ${s?.current_state?.id ?? 'none'} (${s?.current_state?.label ?? ''})`)
        lines.push(`Status: ${s?.status ?? ''}`)
        lines.push(`Idle hold pending: ${s?.idleHoldPending ?? false}`)
        lines.push(`Exited: ${s?.exited ?? false}`)
        lines.push(`Last busy: ${s?.lastBusyAt ? formatAgo(s.lastBusyAt) : ''}`)
        lines.push(`Cursor: ${s?.cursorPosition != null ? `(${s.cursorPosition.row},${s.cursorPosition.col})` : 'n/a'}`)
        if (s?.completionIdleDebounce?.active) {
            const d = s.completionIdleDebounce
            lines.push(`completion_idle_after: age=${d.ageMs}ms hold=${d.holdMs}ms force=${d.forceAfterMs}ms remaining=${Math.max(0, d.holdMs - d.ageMs)}ms`)
        }
        lines.push('')
        lines.push('## Modal')
        if (s?.current_modal) {
            const btns = s.current_modal.buttons.map(b => b.label).join(' / ')
            lines.push(`${s.current_modal.title ?? ''} [${btns}]`)
        } else {
            lines.push('none')
        }
        lines.push('')
        lines.push('## State History (last 20)')
        const history = s?.stateHistory ? [...s.stateHistory].reverse().slice(0, 20) : []
        for (const entry of history) {
            const reason = entry.reason != null ? (typeof entry.reason === 'string' ? entry.reason : JSON.stringify(entry.reason)) : ''
            const debounce = entry.debounceKind != null ? (typeof entry.debounceKind === 'string' ? entry.debounceKind : JSON.stringify(entry.debounceKind)) : ''
            const matchedStateId = entry.matchedStateId != null ? String(entry.matchedStateId) : ''
            const rules = (entry.matchedRules ?? []).map(r => typeof r === 'string' ? r : JSON.stringify(r)).join(', ')
            lines.push(`- ${entry.stateId} @ ${new Date(entry.at).toISOString()} held ${entry.durationMs}ms | reason: ${reason} | debounce: ${debounce} | eval→${matchedStateId} | rules: ${rules}`)
        }
        lines.push('')
        lines.push('## Sections')
        if (s?.sections) {
            for (const [id, text] of Object.entries(s.sections)) {
                const preview = text.split('\n').slice(0, 3).join('\n')
                lines.push(`${id}: ${preview}`)
            }
        }
        lines.push('')
        lines.push('## Last Assistant Message')
        const msgs = s?.messages ?? s?.committedMessages ?? []
        const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
        lines.push(lastAssistant ? lastAssistant.content.slice(0, 400) : '')
        lines.push('')
        lines.push('## Screen (first 50 lines)')
        lines.push(s?.screen ? s.screen.split('\n').slice(0, 50).join('\n') : '')

        try {
            await navigator.clipboard.writeText(lines.join('\n'))
            setSnapshotLabel('Copied!')
            setTimeout(() => setSnapshotLabel('Snapshot'), 1500)
        } catch (e) {
            console.error('[SpecDebugPanel] clipboard write failed', e)
        }
    }

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
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
            onClick={onClose}
            style={{ pointerEvents: 'auto' }}
        >
            <div
                className="bg-zinc-900 text-zinc-100 border border-zinc-700 rounded-t-xl sm:rounded-lg shadow-2xl max-w-2xl w-full max-h-[92vh] sm:max-h-[88vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-2.5 shrink-0 gap-2 min-w-0">
                    <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
                        <span className="text-sm font-semibold text-zinc-100 shrink-0">Spec Debug</span>
                        {snap && (
                            <span className="text-[11px] text-zinc-400 font-mono bg-zinc-800 px-1.5 py-0.5 rounded truncate">
                                {snap.spec_id}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {snap?.specPath && (
                            <button
                                type="button"
                                className={`text-[11px] transition-colors px-2 py-1 rounded border ${editing ? 'text-sky-200 bg-sky-600/25 border-sky-500/40' : 'text-zinc-300 hover:text-white hover:bg-zinc-700 border-transparent hover:border-zinc-600'}`}
                                onClick={() => { if (editing) { setEditing(false) } else { void openEditor() } }}
                                disabled={loading}
                            >
                                {editing ? 'Close Editor' : 'Edit Spec'}
                            </button>
                        )}
                        <button
                            type="button"
                            className="text-[11px] text-zinc-300 hover:text-white transition-colors px-2 py-1 rounded hover:bg-zinc-700 border border-transparent hover:border-zinc-600"
                            onClick={() => { void handleSnapshot() }}
                            disabled={loading}
                        >
                            {snapshotLabel}
                        </button>
                        <button
                            type="button"
                            className="text-[11px] text-zinc-300 hover:text-white transition-colors px-2 py-1 rounded hover:bg-zinc-700 border border-transparent hover:border-zinc-600"
                            onClick={() => { void load() }}
                            disabled={loading}
                        >
                            {loading ? 'Loading…' : 'Refresh'}
                        </button>
                        <button
                            type="button"
                            className="text-zinc-400 hover:text-zinc-100 transition-colors text-xl leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700"
                            onClick={onClose}
                            aria-label="Close"
                        >
                            ×
                        </button>
                    </div>
                </div>

                {/* Spec editor — structured FSM builder (form) or raw JSON.
                    Save serializes the model, the daemon re-validates, and the
                    driver fs.watch hot-reloads the running session. */}
                {editing && (
                    <div className="flex-1 flex flex-col min-h-0 px-4 py-3 gap-2">
                        <div className="flex items-center gap-2 shrink-0">
                            <div className="inline-flex rounded border border-zinc-700 overflow-hidden text-[10px]">
                                <button
                                    type="button"
                                    className={`px-2 py-0.5 ${!rawMode ? 'bg-sky-600/30 text-sky-100' : 'text-zinc-400 hover:bg-zinc-700/40'}`}
                                    onClick={() => {
                                        // form → ensure model parsed from current source
                                        if (rawMode) {
                                            try { const m = JSON.parse(specSource) as SpecModel; setSpecModel(m); void validateModel(m) } catch { /* stay raw */ return }
                                        }
                                        setRawMode(false)
                                    }}
                                    disabled={!specModel && rawMode}
                                >Form</button>
                                <button
                                    type="button"
                                    className={`px-2 py-0.5 ${rawMode ? 'bg-sky-600/30 text-sky-100' : 'text-zinc-400 hover:bg-zinc-700/40'}`}
                                    onClick={() => { if (specModel) setSpecSource(JSON.stringify(specModel, null, 2)); setRawMode(true) }}
                                >JSON</button>
                            </div>
                            <span className="text-[10px] text-zinc-500 font-mono truncate flex-1" title={snap?.specPath}>{(snap?.specPath ?? '').split('/').slice(-3).join('/')}</span>
                            {specDirty && <span className="text-amber-300 text-[10px]">unsaved</span>}
                            {!rawMode && validationErrors.length > 0 && (
                                <span className="text-red-300 text-[10px]">{validationErrors.length} error{validationErrors.length > 1 ? 's' : ''}</span>
                            )}
                            <button
                                type="button"
                                className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${(saveState === 'saving' || (!rawMode && validationErrors.length > 0)) ? 'text-zinc-600 border-zinc-700 cursor-not-allowed' : 'text-green-200 bg-green-600/25 border-green-500/40 hover:bg-green-600/40'}`}
                                onClick={() => { void saveSpec() }}
                                disabled={saveState === 'saving' || (!rawMode && validationErrors.length > 0)}
                            >
                                {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓ (reloading)' : 'Save & Apply'}
                            </button>
                        </div>
                        {saveError && (
                            <pre className="text-red-300 bg-red-900/40 border border-red-700/50 rounded p-2 text-[10px] whitespace-pre-wrap shrink-0 max-h-28 overflow-y-auto">{saveError}</pre>
                        )}
                        {!rawMode && validationErrors.length > 0 && (
                            <div className="text-red-300 bg-red-900/30 border border-red-700/40 rounded p-1.5 text-[10px] shrink-0 max-h-24 overflow-y-auto space-y-0.5">
                                {validationErrors.map((e, i) => <div key={i} className="font-mono">{e}</div>)}
                            </div>
                        )}
                        <div className="flex-1 min-h-0 overflow-y-auto">
                            {rawMode || !specModel ? (
                                <textarea
                                    value={specSource}
                                    onChange={e => { setSpecSource(e.target.value); setSpecDirty(true); setSaveState('idle') }}
                                    spellCheck={false}
                                    className="w-full h-full min-h-[300px] font-mono text-[11px] leading-relaxed bg-black/40 text-zinc-200 border border-zinc-700 rounded p-3 resize-none outline-none focus:border-sky-500/50"
                                />
                            ) : (
                                <SpecFormBuilder model={specModel} onChange={onModelChange} onPreview={onPreview} preview={preview} />
                            )}
                        </div>
                        <div className="text-[10px] text-zinc-500 shrink-0">
                            {rawMode
                                ? 'Raw JSON — validated on save.'
                                : 'Build the FSM; from/to are constrained to existing states. "test" evaluates a condition against the live screen. Save hot-reloads the session.'}
                        </div>
                    </div>
                )}

                {/* Body */}
                {!editing && (
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-[12px]">
                    {error && (
                        <div className="text-red-300 bg-red-900/40 border border-red-700/50 rounded p-2">{error}</div>
                    )}

                    {loading && !data && (
                        <div className="text-zinc-500 text-center py-6">Loading…</div>
                    )}

                    {data && !data.isSpecProvider && (
                        <div className="text-zinc-500 text-center py-6">
                            Not a spec-driven provider ({data.providerType || 'unknown'}).
                        </div>
                    )}

                    {snap && (
                        <>
                            {/* Provider info */}
                            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] bg-zinc-800/60 rounded-md px-3 py-2 border border-zinc-700/50">
                                {snap.name && (
                                    <>
                                        <span className="text-zinc-500">Provider</span>
                                        <span className="font-mono text-zinc-200">{snap.name} <span className="text-zinc-500">({snap.cliType})</span></span>
                                    </>
                                )}
                                {snap.workingDir && (
                                    <>
                                        <span className="text-zinc-500">Dir</span>
                                        <span className="font-mono text-zinc-300 truncate" title={snap.workingDir}>{snap.workingDir}</span>
                                    </>
                                )}
                                {snap.spawnedAtMs ? (
                                    <>
                                        <span className="text-zinc-500">Spawned</span>
                                        <span className="text-zinc-400">{formatAgo(snap.spawnedAtMs)}</span>
                                    </>
                                ) : null}
                                {snap.providerSessionId && (
                                    <>
                                        <span className="text-zinc-500">Session</span>
                                        <span className="font-mono text-zinc-500 text-[10px] truncate" title={snap.providerSessionId}>{snap.providerSessionId}</span>
                                    </>
                                )}
                            </div>

                            {/* State summary */}
                            <div className="flex items-center gap-2 flex-wrap bg-zinc-800/40 rounded-md px-3 py-2 border border-zinc-700/50">
                                <span className={`font-semibold font-mono text-[12px] px-2 py-0.5 rounded ${snap.current_state ? stateBadge(snap.current_state.id) : 'text-zinc-500'}`}>
                                    {snap.current_state ? snap.current_state.id : 'none'}
                                </span>
                                {snap.current_state?.label && snap.current_state.label !== snap.current_state.id && (
                                    <span className="text-zinc-400 text-[11px]">{snap.current_state.label}</span>
                                )}
                                {snap.status && snap.status !== snap.current_state?.id && (
                                    <span className="text-zinc-500 text-[11px]">
                                        engine: <span className={`font-mono ${stateBadge(snap.status)} px-1 py-0.5 rounded text-[10px]`}>{snap.status}</span>
                                    </span>
                                )}
                                {snap.idleHoldPending && (
                                    <span className="text-yellow-200 text-[10px] bg-yellow-600/25 border border-yellow-500/35 px-1.5 py-0.5 rounded font-mono">idle hold pending</span>
                                )}
                                {snap.exited && (
                                    <span className="text-red-200 text-[10px] bg-red-600/25 border border-red-500/35 px-1.5 py-0.5 rounded font-mono">exited</span>
                                )}
                                {snap.cursorPosition != null && (
                                    <span className="text-zinc-500 text-[11px] font-mono">
                                        cursor: <span className="text-zinc-300">{snap.cursorPosition.row},{snap.cursorPosition.col}</span>
                                    </span>
                                )}
                                {snap.lastBusyAt > 0 && (
                                    <span className="text-zinc-500 text-[11px] ml-auto">last busy: <span className="text-zinc-400">{formatAgo(snap.lastBusyAt)}</span></span>
                                )}
                            </div>
                            {snap.completionIdleDebounce?.active && (
                                <div className="flex items-center gap-2 text-[11px] bg-sky-900/20 border border-sky-700/30 rounded-md px-3 py-1.5 font-mono">
                                    <span className="text-sky-400">completion_idle_after</span>
                                    <span className="text-zinc-400">age: <span className="text-sky-200">{snap.completionIdleDebounce.ageMs}ms</span></span>
                                    <span className="text-zinc-500">/</span>
                                    <span className="text-zinc-400">hold: <span className="text-zinc-300">{snap.completionIdleDebounce.holdMs}ms</span></span>
                                    <span className="text-zinc-400">force: <span className="text-zinc-300">{snap.completionIdleDebounce.forceAfterMs}ms</span></span>
                                    <span className="text-zinc-500 ml-auto">
                                        {snap.completionIdleDebounce.ageMs < snap.completionIdleDebounce.holdMs
                                            ? <span className="text-amber-300">hold remaining: {snap.completionIdleDebounce.holdMs - snap.completionIdleDebounce.ageMs}ms</span>
                                            : snap.completionIdleDebounce.ageMs < snap.completionIdleDebounce.forceAfterMs
                                                ? <span className="text-orange-300">force in: {snap.completionIdleDebounce.forceAfterMs - snap.completionIdleDebounce.ageMs}ms</span>
                                                : <span className="text-red-300">overdue</span>
                                        }
                                    </span>
                                </div>
                            )}

                            {snap.current_modal && (
                                <div className="bg-orange-900/30 border border-orange-600/40 rounded-md p-2.5">
                                    <span className="text-orange-200 font-semibold">Modal: </span>
                                    <span className="text-zinc-300">{snap.current_modal.title || ''}</span>
                                    {snap.current_modal.buttons.length > 0 && (
                                        <span className="text-zinc-400 ml-2">
                                            [{snap.current_modal.buttons.map(b => b.label).join(' / ')}]
                                        </span>
                                    )}
                                </div>
                            )}

                            {/* FSM live transitions (v4 only) */}
                            {snap.fsm && (
                                <>
                                    <Divider />
                                    <div>
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <SectionLabel>FSM — outgoing from <span className="text-sky-300 font-mono normal-case">{snap.fsm.currentState}</span> (held {formatDur(snap.fsm.stateAgeMs)})</SectionLabel>
                                            <label className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500 cursor-pointer select-none mb-1.5">
                                                <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-sky-500" />
                                                live
                                            </label>
                                        </div>
                                        <div className="space-y-1">
                                            {snap.fsm.transitions.length === 0 && (
                                                <div className="text-zinc-600 text-[11px] italic px-1">no outgoing transitions (terminal state)</div>
                                            )}
                                            {snap.fsm.transitions.map((t, i) => <TransitionRow key={i} t={t} />)}
                                        </div>
                                    </div>
                                </>
                            )}

                            <Divider />

                            {/* Sections */}
                            {snap.sections && Object.keys(snap.sections).length > 0 && (
                                <div>
                                    <SectionLabel>Sections</SectionLabel>
                                    <div className="space-y-1">
                                        {Object.entries(snap.sections).map(([id, text]) => {
                                            const expanded = expandedSections.has(id)
                                            const lines = text.split('\n')
                                            const preview = lines[0]?.slice(0, 80) || '(empty)'
                                            return (
                                                <div key={id} className="border border-zinc-700 rounded overflow-hidden bg-zinc-800/30">
                                                    <button
                                                        type="button"
                                                        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-zinc-700/40 transition-colors text-left"
                                                        onClick={() => toggleSection(id)}
                                                    >
                                                        <span className="text-[10px] text-zinc-500 w-3">{expanded ? '▾' : '▸'}</span>
                                                        <span className="font-mono text-sky-300 w-20 shrink-0 text-[11px]">{id}</span>
                                                        {!expanded && (
                                                            <span className="text-zinc-400 truncate font-mono text-[11px]">{preview}</span>
                                                        )}
                                                        <span className="ml-auto text-zinc-600 text-[10px] shrink-0">{lines.length}L</span>
                                                    </button>
                                                    {expanded && (
                                                        <pre className="px-3 pb-2.5 pt-1 font-mono text-[11px] text-zinc-300 whitespace-pre-wrap break-all bg-black/30 max-h-40 overflow-y-auto border-t border-zinc-700/50">
                                                            {text || '(empty)'}
                                                        </pre>
                                                    )}
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}

                            <Divider />

                            {/* State history */}
                            {snap.stateHistory && snap.stateHistory.length > 0 && (
                                <div>
                                    <SectionLabel>State History ({snap.stateHistory.length})</SectionLabel>
                                    <div className="space-y-px">
                                        {[...snap.stateHistory].reverse().slice(0, 20).map((entry, i) => (
                                            <div key={i} className="rounded px-2 py-1 hover:bg-zinc-800/60 transition-colors">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className={`font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${stateBadge(entry.stateId)}`}>
                                                        {entry.stateId}
                                                    </span>
                                                    <span className="text-zinc-400 text-[11px] shrink-0 tabular-nums">
                                                        {formatAgo(entry.at)}
                                                    </span>
                                                    {entry.durationMs > 0 && (
                                                        <span className="text-zinc-500 text-[11px]">
                                                            held <span className="text-zinc-400">{formatDur(entry.durationMs)}</span>
                                                        </span>
                                                    )}
                                                    {entry.reason && (
                                                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${REASON_COLORS[String(entry.reason)] ?? 'text-zinc-400 bg-zinc-700/50 border border-zinc-600/30'}`}>
                                                            {String(entry.reason)}
                                                        </span>
                                                    )}
                                                    {entry.debounceKind && String(entry.debounceKind) !== 'none' && (
                                                        <span className="text-zinc-500 text-[10px] font-mono">
                                                            debounce:{String(entry.debounceKind)}
                                                        </span>
                                                    )}
                                                    {entry.matchedStateId && String(entry.matchedStateId) !== entry.stateId && (
                                                        <span className="text-zinc-500 text-[10px] font-mono">
                                                            eval→<span className="text-zinc-300">{String(entry.matchedStateId)}</span>
                                                        </span>
                                                    )}
                                                </div>
                                                {entry.matchedRules && entry.matchedRules.length > 0 && (
                                                    <div className="flex items-start gap-1 flex-wrap mt-0.5 ml-1 pl-1 border-l border-zinc-700">
                                                        {entry.matchedRules.slice(0, 3).map((rule, ri) => (
                                                            <span key={ri} className="font-mono text-[10px] text-sky-200 bg-sky-900/40 border border-sky-700/40 px-1.5 py-0.5 rounded break-all">
                                                                {typeof rule === 'string' ? rule : JSON.stringify(rule)}
                                                            </span>
                                                        ))}
                                                        {entry.matchedRules.length > 3 && (
                                                            <span className="text-[10px] text-zinc-500">+{entry.matchedRules.length - 3} more</span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <Divider />

                            {/* Transcript messages */}
                            {(() => {
                                const msgs = snap.messages ?? snap.committedMessages ?? []
                                if (msgs.length === 0) return null
                                const userCount = msgs.filter(m => m.role === 'user').length
                                const assistantCount = msgs.filter(m => m.role === 'assistant').length
                                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                                return (
                                    <div>
                                        <SectionLabel>Transcript ({msgs.length} — {userCount}u / {assistantCount}a)</SectionLabel>
                                        {lastAssistant && (
                                            <div className="bg-zinc-800/50 border border-zinc-700 rounded-md p-2.5 text-[11px]">
                                                <div className="text-zinc-500 mb-1 text-[10px]">
                                                    Last assistant {lastAssistant.receivedAt ? formatAgo(lastAssistant.receivedAt) : ''}
                                                </div>
                                                <div className="text-zinc-300 font-mono whitespace-pre-wrap line-clamp-4 break-all">
                                                    {lastAssistant.content.slice(0, 400)}{lastAssistant.content.length > 400 ? '…' : ''}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )
                            })()}

                            {/* Spec path */}
                            {snap.specPath && (
                                <div className="text-[10px] text-zinc-600 font-mono truncate border-t border-zinc-800 pt-2 mt-1" title={snap.specPath}>
                                    {snap.specPath}
                                </div>
                            )}

                            {/* Raw screen toggle */}
                            <div>
                                <button
                                    type="button"
                                    className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1.5"
                                    onClick={() => setShowScreen(v => !v)}
                                >
                                    <span className="text-zinc-600">{showScreen ? '▾' : '▸'}</span>
                                    <span>Raw screen ({snap.screen ? snap.screen.split('\n').length : 0} lines)</span>
                                </button>
                                {showScreen && (
                                    <pre className="mt-1.5 px-3 py-2 font-mono text-[11px] text-zinc-300 whitespace-pre bg-black/40 rounded-md border border-zinc-700 max-h-64 overflow-auto">
                                        {snap.screen || '(empty)'}
                                    </pre>
                                )}
                            </div>
                        </>
                    )}
                </div>
                )}
            </div>
        </div>
    )
}
