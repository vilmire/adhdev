/**
 * MAGI kind → panel binding editor — CRUD UI for the per-task_kind panel bindings.
 *
 * Each MAGI `task_kind` (rca / design / claim_audit / freeform) can be bound to a
 * list of slots, where each slot = (machine nodeId + provider [+ model]). A bare
 * `mesh_magi_review({task_kind})` resolves the panel from THESE bindings — there is
 * NO hardcoded preset auto-synthesis fallback. An UNCONFIGURED kind is a hard error
 * (`magi_kind_not_configured`), never a silent synthetic panel, so every kind the
 * operator wants to reach via task_kind must have ≥1 slot configured here.
 *
 * It talks to the daemon through the SAME `sendDaemonCommand` seam the rest of
 * MeshObservabilitySurface uses — `magi_kind_panel_list` /
 * `magi_kind_panel_set` / `magi_kind_panel_remove`, the daemon-core handlers. Cloud
 * routes these P2P-only (web-cloud api.ts); standalone routes them to the same
 * daemon-core router over localhost:3847. One handler set, both transports.
 *
 * The `model` axis is best-effort: claude-cli maps model → --model at launch (manifest
 * modelLaunchArgs); ACP providers map it via setConfigOption. Providers that can't
 * honor it ignore it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MagiSlot, MagiKindPanelMap, MagiTaskKind } from '@adhdev/mesh-shared'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'

/**
 * Static provider fallback used when no live mesh node reports any provider
 * (offline / pre-handshake). Live providers always take precedence; this is only
 * the empty-mesh escape hatch so the dropdown never dead-ends.
 */
const FALLBACK_PROVIDERS = ['claude-cli', 'codex-cli', 'gemini-cli', 'hermes-cli', 'antigravity-cli']

/** The four task_kinds surfaced by the editor, in a stable display order. */
const TASK_KINDS: { kind: MagiTaskKind; label: string; hint: string }[] = [
    { kind: 'rca', label: 'Root-cause analysis', hint: 'rca' },
    { kind: 'design', label: 'Design / approach review', hint: 'design' },
    { kind: 'claim_audit', label: 'Verify specific claims', hint: 'claim_audit' },
    { kind: 'freeform', label: 'Freeform review', hint: 'freeform' },
]

/** Common model suggestions offered via the datalist (free text still allowed). */
const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku']

interface MagiKindPanelEditorProps {
    status: RepoMeshStatus | null
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

/** Slim live-node view, matching the (nodeId, providers, providerPriority) axis. */
interface LiveNode {
    nodeId: string
    machineLabel?: string
    providers?: string[]
    providerPriority?: string[]
}

// ─── Draft editor state (string-form for inputs) ────────────────────────────

interface SlotDraft {
    nodeId: string
    provider: string
    model: string
    n: string
}

function emptySlot(): SlotDraft {
    return { nodeId: '', provider: '', model: '', n: '' }
}

function liveNodeProviders(n: LiveNode): string[] {
    return n.providers?.length ? n.providers.filter(Boolean) : (n.providerPriority ?? []).filter(Boolean)
}

function slotToDraft(s: MagiSlot): SlotDraft {
    return {
        nodeId: s.nodeId ?? '',
        provider: s.provider ?? '',
        model: s.model ?? '',
        n: s.n != null ? String(s.n) : '',
    }
}

/** Build the `slots` payload from drafts. Returns null + reason when invalid client-side. */
function draftsToSlots(drafts: SlotDraft[]): { slots: MagiSlot[] } | { error: string } {
    const slots: MagiSlot[] = []
    for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i]
        const provider = d.provider.trim()
        if (!provider) return { error: `Slot ${i + 1}: provider is required` }
        const nodeId = d.nodeId.trim()
        const model = d.model.trim()
        const nRaw = d.n.trim()
        let n: number | undefined
        if (nRaw) {
            const parsed = Number(nRaw)
            if (!Number.isFinite(parsed) || parsed < 1) return { error: `Slot ${i + 1}: replica count must be ≥ 1` }
            n = Math.floor(parsed)
        }
        slots.push({
            provider,
            ...(nodeId ? { nodeId } : {}),
            ...(model ? { model } : {}),
            ...(n !== undefined ? { n } : {}),
        })
    }
    if (slots.length === 0) return { error: 'A kind binding needs at least one slot' }
    return { slots }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MagiKindPanelEditor({ status, daemonId, sendDaemonCommand }: MagiKindPanelEditorProps) {
    const { theme } = useTheme()
    const meshTheme: MeshGraphTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const [kindPanels, setKindPanels] = useState<MagiKindPanelMap>({})
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Per-kind draft slot lists. A kind absent from this map has never been edited
    // in this session (its rendered slots come from kindPanels).
    const [drafts, setDrafts] = useState<Partial<Record<MagiTaskKind, SlotDraft[]>>>({})
    const [savingKind, setSavingKind] = useState<MagiTaskKind | null>(null)

    const liveNodes: LiveNode[] = useMemo(
        () => (status?.nodes ?? []).map(n => ({ nodeId: n.nodeId, machineLabel: n.machineLabel, providers: n.providers, providerPriority: n.providerPriority })),
        [status?.nodes],
    )
    const knownNodeIds = useMemo(() => (status?.nodes ?? []).map(n => n.nodeId), [status?.nodes])

    // Friendly display label per nodeId (raw id stays the option value). Falls back
    // to the raw nodeId when the normalized machineLabel is unavailable.
    const nodeLabelById = useMemo(
        () => Object.fromEntries((status?.nodes ?? []).map(n => [n.nodeId, n.machineLabel || n.nodeId])),
        [status?.nodes],
    )

    // Providers offered per node, keyed by nodeId — used to filter the provider
    // dropdown to the selected node's providers.
    const providersByNode = useMemo(() => {
        const map: Record<string, string[]> = {}
        for (const n of liveNodes) map[n.nodeId] = liveNodeProviders(n)
        return map
    }, [liveNodes])

    // Provider candidates when no node is pinned: every provider any live node
    // reports, unioned with the static fallback so the dropdown never dead-ends.
    const allProviderCandidates = useMemo(() => {
        const live = [...new Set(liveNodes.flatMap(liveNodeProviders).filter(Boolean))]
        return [...new Set([...live, ...FALLBACK_PROVIDERS])].sort()
    }, [liveNodes])

    const canCommand = !!daemonId && !!sendDaemonCommand

    const unwrap = (raw: any) => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

    const loadKindPanels = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        setLoading(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_kind_panel_list', {})
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to load kind panels')
            setKindPanels((result?.kindPanels && typeof result.kindPanels === 'object') ? result.kindPanels : {})
            // Reset drafts to the freshly loaded state.
            setDrafts({})
        } catch (e: any) {
            setError(e?.message || 'Failed to load kind panels')
        } finally {
            setLoading(false)
        }
    }, [daemonId, sendDaemonCommand])

    useEffect(() => { void loadKindPanels() }, [loadKindPanels])

    // Effective slot drafts for a kind: the in-session draft if the operator has
    // touched it, else derived from the loaded binding.
    const slotsForKind = useCallback((kind: MagiTaskKind): SlotDraft[] => {
        if (drafts[kind]) return drafts[kind]!
        const bound = kindPanels[kind]
        return bound ? bound.map(slotToDraft) : []
    }, [drafts, kindPanels])

    const setSlotsForKind = (kind: MagiTaskKind, next: SlotDraft[]) => {
        setDrafts(d => ({ ...d, [kind]: next }))
    }

    const updateSlot = (kind: MagiTaskKind, idx: number, patch: Partial<SlotDraft>) => {
        const cur = slotsForKind(kind)
        setSlotsForKind(kind, cur.map((s, i) => i === idx ? { ...s, ...patch } : s))
    }
    const addSlot = (kind: MagiTaskKind) => {
        setSlotsForKind(kind, [...slotsForKind(kind), emptySlot()])
    }
    const removeSlot = (kind: MagiTaskKind, idx: number) => {
        setSlotsForKind(kind, slotsForKind(kind).filter((_, i) => i !== idx))
    }

    const handleSave = useCallback(async (kind: MagiTaskKind) => {
        if (!daemonId || !sendDaemonCommand) return
        const built = draftsToSlots(slotsForKind(kind))
        if ('error' in built) { setError(`${kind}: ${built.error}`); return }
        setSavingKind(kind)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_kind_panel_set', { kind, slots: built.slots })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to save kind binding')
            await loadKindPanels()
        } catch (e: any) {
            setError(e?.message || 'Failed to save kind binding')
        } finally {
            setSavingKind(null)
        }
    }, [daemonId, sendDaemonCommand, slotsForKind, loadKindPanels])

    const handleRemove = useCallback(async (kind: MagiTaskKind) => {
        if (!daemonId || !sendDaemonCommand) return
        if (!confirm(`Remove the MAGI panel binding for "${kind}"?`)) return
        setSavingKind(kind)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_kind_panel_remove', { kind })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to remove kind binding')
            await loadKindPanels()
        } catch (e: any) {
            setError(e?.message || 'Failed to remove kind binding')
        } finally {
            setSavingKind(null)
        }
    }, [daemonId, sendDaemonCommand, loadKindPanels])

    const inputClass = `w-full rounded-lg border px-2.5 py-1.5 text-xs ${meshTheme.isDark ? 'border-white/10 bg-slate-950/40 text-slate-100 placeholder:text-slate-500' : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400'}`
    // Use the app design-system buttons so MAGI matches the rest of the mesh UI
    // (the old ad-hoc bg-sky-500 primary was the lone off-theme blue button).
    const btnPrimary = 'btn btn-primary btn-sm'
    const btnGhost = 'btn btn-secondary btn-sm'

    return (
        <div className="flex flex-col gap-3 p-1">
            <div className="flex flex-wrap items-center gap-2">
                <p className={`text-[12px] ${meshTheme.textSecondary}`}>
                    Pick which agents review each task type. Add one row per agent.
                </p>
                <div className="ml-auto flex items-center gap-2">
                    <button type="button" className={btnGhost} onClick={() => void loadKindPanels()} disabled={loading || !canCommand}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                </div>
            </div>

            {!canCommand && (
                <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    Connect to a coordinator daemon to manage kind → panel bindings.
                </div>
            )}

            {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{error}</div>
            )}

            {/* ── Per-kind editors ── */}
            <div className="flex flex-col gap-3">
                {TASK_KINDS.map(({ kind, label, hint }) => {
                    const slots = slotsForKind(kind)
                    const isBound = !!kindPanels[kind]
                    const busy = savingKind === kind
                    return (
                        <div key={kind} className={`${meshTheme.cardClass} rounded-2xl p-4 flex flex-col gap-3`}>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-[13px] font-semibold ${meshTheme.textPrimary}`}>{label}</span>
                                <span className={`font-mono text-[10px] ${meshTheme.textMuted}`}>{hint}</span>
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${isBound
                                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                                    : 'border-slate-400/20 bg-slate-500/10 text-slate-300'}`}>
                                    {isBound ? `${kindPanels[kind]!.length} agent${kindPanels[kind]!.length === 1 ? '' : 's'}` : 'off'}
                                </span>
                            </div>

                            <div className="flex flex-col gap-2">
                                {slots.length === 0 && (
                                    <div className={`rounded-xl border p-2.5 text-[11px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                                        No agents yet — add one to enable this review type.
                                    </div>
                                )}
                                {slots.map((s, idx) => {
                                    // Provider options for THIS row: the selected node's providers
                                    // when a node is pinned, else the all-live-union-fallback set.
                                    const nodeProviders = s.nodeId ? (providersByNode[s.nodeId] ?? []) : []
                                    const providerOptions = s.nodeId
                                        ? (nodeProviders.length ? nodeProviders : allProviderCandidates)
                                        : allProviderCandidates
                                    return (
                                        <div key={idx} className={`rounded-xl border p-2.5 grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto_auto] gap-x-2 gap-y-1 items-start ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Machine</span>
                                                <select className={inputClass} value={s.nodeId} onChange={e => updateSlot(kind, idx, { nodeId: e.target.value })} title="Which machine runs this agent. Leave on “any” to let the coordinator route by tags.">
                                                    <option value="">Any machine</option>
                                                    {knownNodeIds.map(id => <option key={id} value={id}>{nodeLabelById[id] ?? id}</option>)}
                                                    {s.nodeId && !knownNodeIds.includes(s.nodeId) && <option value={s.nodeId}>{(nodeLabelById[s.nodeId] ?? s.nodeId)} (offline)</option>}
                                                </select>
                                            </label>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Provider *</span>
                                                <select className={inputClass} value={s.provider} onChange={e => updateSlot(kind, idx, { provider: e.target.value })} title="The AI agent this slot runs.">
                                                    <option value="">Select provider…</option>
                                                    {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
                                                    {s.provider && !providerOptions.includes(s.provider) && <option value={s.provider}>{s.provider}</option>}
                                                </select>
                                            </label>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Model</span>
                                                <input className={inputClass} value={s.model} placeholder="default"
                                                    list="magi-kind-model-options"
                                                    title="Optional model override (best-effort). Blank uses the provider default."
                                                    onChange={e => updateSlot(kind, idx, { model: e.target.value })} />
                                            </label>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Copies</span>
                                                <input className={`${inputClass} sm:w-16`} value={s.n} placeholder="1" inputMode="numeric"
                                                    title="How many parallel copies of this agent to run. Blank = 1."
                                                    onChange={e => updateSlot(kind, idx, { n: e.target.value })} />
                                            </label>
                                            <button type="button" className={`${btnGhost} sm:mt-[18px] inline-flex h-8 w-8 items-center justify-center p-0`} onClick={() => removeSlot(kind, idx)} aria-label="Remove agent" title="Remove agent">✕</button>
                                        </div>
                                    )
                                })}
                                <div>
                                    <button type="button" className={btnGhost} onClick={() => addSlot(kind)} disabled={!canCommand}>
                                        + Add agent
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <button type="button" className={btnPrimary} onClick={() => void handleSave(kind)} disabled={busy || !canCommand}>
                                    {busy ? 'Saving…' : 'Save'}
                                </button>
                                <button type="button" className={btnGhost} onClick={() => void handleRemove(kind)} disabled={busy || !canCommand || !isBound}
                                    title={isBound ? 'Clear this kind binding' : 'Nothing to remove — this kind is unconfigured'}>
                                    Remove binding
                                </button>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Shared model suggestion list — free text still allowed. */}
            <datalist id="magi-kind-model-options">
                {MODEL_SUGGESTIONS.map(m => <option key={m} value={m} />)}
            </datalist>
        </div>
    )
}
