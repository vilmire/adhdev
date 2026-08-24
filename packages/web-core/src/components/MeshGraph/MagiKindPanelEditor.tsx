/**
 * MAGI kind → panel binding editor — CRUD UI for the per-task_kind panel bindings.
 *
 * Each MAGI `task_kind` (rca / design / claim_audit / freeform) can be bound to a
 * list of slots, where each slot = (machine nodeId + provider [+ model]). Bindings
 * are PER MESH (stored machine-locally under that mesh's meshes.json entry), so
 * every command carries the edited mesh's id — editing mesh A never touches mesh B's
 * binding for the same kind. A bare
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
import { useTranslation } from 'react-i18next'
import type { MagiSlot, MagiKindPanelMap, MagiTaskKind } from '@adhdev/mesh-shared'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { buildProviderOptionMap, type AvailableCliProviderOption } from '../../utils/provider-priority'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { isWorktreeNode } from '../../pages/repo-mesh/MeshNodeList'
import { nodeDisplayName } from './MeshObservabilitySurface/meshSurfaceHelpers'

/**
 * Static provider fallback used when no live mesh node reports any provider
 * (offline / pre-handshake). Live providers always take precedence; this is only
 * the empty-mesh escape hatch so the dropdown never dead-ends.
 */
const FALLBACK_PROVIDERS = ['claude-cli', 'codex-cli', 'gemini-cli', 'hermes-cli', 'antigravity-cli']

/**
 * The four task_kinds surfaced by the editor, in a stable display order. `hint`
 * is the raw kind code (shown in mono, not translated); `labelKey` resolves the
 * human label from the i18n catalog at render.
 */
const TASK_KINDS: { kind: MagiTaskKind; labelKey: string; hint: string }[] = [
    { kind: 'rca', labelKey: 'meshGraph.magiKind.kindRca', hint: 'rca' },
    { kind: 'design', labelKey: 'meshGraph.magiKind.kindDesign', hint: 'design' },
    { kind: 'claim_audit', labelKey: 'meshGraph.magiKind.kindClaimAudit', hint: 'claim_audit' },
    { kind: 'freeform', labelKey: 'meshGraph.magiKind.kindFreeform', hint: 'freeform' },
]

interface MagiKindPanelEditorProps {
    status: RepoMeshStatus | null
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    /**
     * Detected CLI providers with their advisory modelOptions. Drives the
     * per-slot Model suggestion list so the datalist offers the models the
     * slot's *own* provider actually supports (codex → gpt-*, claude → opus/…)
     * instead of a hardcoded opus/sonnet/haiku list that made no sense for
     * codex or antigravity.
     */
    availableProviders?: AvailableCliProviderOption[]
}

/** Slim live-node view, matching the (nodeId, providers, providerPriority) axis. */
interface LiveNode {
    nodeId: string
    machineLabel?: string
    providers?: string[]
    providerPriority?: string[]
    isLocalWorktree?: boolean
    worktreeBranch?: string
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

/**
 * Client-side validation error, returned as a structured code + slot index so the
 * component can render a localized message.
 */
type DraftsToSlotsError =
    | { code: 'provider_required'; slot: number }
    | { code: 'replica_min'; slot: number }
    | { code: 'no_slot' }

/** Build the `slots` payload from drafts. Returns a structured error when invalid client-side. */
function draftsToSlots(drafts: SlotDraft[]): { slots: MagiSlot[] } | { error: DraftsToSlotsError } {
    const slots: MagiSlot[] = []
    for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i]
        const provider = d.provider.trim()
        if (!provider) return { error: { code: 'provider_required', slot: i + 1 } }
        const nodeId = d.nodeId.trim()
        const model = d.model.trim()
        const nRaw = d.n.trim()
        let n: number | undefined
        if (nRaw) {
            const parsed = Number(nRaw)
            if (!Number.isFinite(parsed) || parsed < 1) return { error: { code: 'replica_min', slot: i + 1 } }
            n = Math.floor(parsed)
        }
        slots.push({
            provider,
            ...(nodeId ? { nodeId } : {}),
            ...(model ? { model } : {}),
            ...(n !== undefined ? { n } : {}),
        })
    }
    if (slots.length === 0) return { error: { code: 'no_slot' } }
    return { slots }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MagiKindPanelEditor({ status, daemonId, sendDaemonCommand, availableProviders }: MagiKindPanelEditorProps) {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const meshTheme: MeshGraphTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    // provider type → advisory {models, thinking} — shared lookup, same source
    // the slot editor and New-session dialog read. Drives the per-slot Model
    // datalist so each slot suggests its own provider's models (codex → gpt-*)
    // instead of a hardcoded cross-provider list.
    const optionsByProvider = useMemo(() => buildProviderOptionMap(availableProviders), [availableProviders])

    const [kindPanels, setKindPanels] = useState<MagiKindPanelMap>({})
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Per-kind draft slot lists. A kind absent from this map has never been edited
    // in this session (its rendered slots come from kindPanels).
    const [drafts, setDrafts] = useState<Partial<Record<MagiTaskKind, SlotDraft[]>>>({})
    const [savingKind, setSavingKind] = useState<MagiTaskKind | null>(null)

    const liveNodes: LiveNode[] = useMemo(
        () => (status?.nodes ?? []).map(n => ({
            nodeId: n.nodeId,
            machineLabel: n.machineLabel,
            providers: n.providers,
            providerPriority: n.providerPriority,
            isLocalWorktree: n.isLocalWorktree,
            worktreeBranch: n.worktreeBranch,
        })),
        [status?.nodes],
    )
    const knownNodeIds = useMemo(() => (status?.nodes ?? []).map(n => n.nodeId), [status?.nodes])
    // Ephemeral worktree nodes are excluded from MAGI slot assignment (kind→panel
    // bindings are a persistent config concept; a worktree can vanish on cleanup).
    // Kept SELECTABLE-disabled rather than removed from the list: an operator must
    // still be able to see (and clear) a slot that was assigned to one before this
    // guard existed, and a hidden option would make an already-bound worktree nodeId
    // look unresolvable in the dropdown.
    const worktreeNodeIds = useMemo(
        () => new Set(liveNodes.filter(isWorktreeNode).map(n => n.nodeId)),
        [liveNodes],
    )
    const worktreeBranchByNodeId = useMemo(
        () => Object.fromEntries(liveNodes.filter(isWorktreeNode).map(n => [n.nodeId, n.worktreeBranch])),
        [liveNodes],
    )

    // Friendly display label per nodeId (raw id stays the option value). Falls back
    // to the raw nodeId when the normalized machineLabel is unavailable.
    const nodeLabelById = useMemo(
        () => Object.fromEntries((status?.nodes ?? []).map(n => [n.nodeId, nodeDisplayName(n) || n.nodeId])),
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

    // Kind-panels are stored PER MESH, so every call names the mesh being edited.
    // Without it the daemon falls back to "the sole mesh", which is only correct on a
    // single-mesh machine — on a two-mesh machine an unscoped write used to clobber
    // the other mesh's binding for the same kind.
    const meshId = status?.meshId

    const loadKindPanels = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        setLoading(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_kind_panel_list', { ...(meshId ? { meshId } : {}) })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || t('meshGraph.magiKind.errorLoad'))
            setKindPanels((result?.kindPanels && typeof result.kindPanels === 'object') ? result.kindPanels : {})
            // Reset drafts to the freshly loaded state.
            setDrafts({})
        } catch (e: any) {
            setError(e?.message || t('meshGraph.magiKind.errorLoad'))
        } finally {
            setLoading(false)
        }
    }, [daemonId, sendDaemonCommand, meshId, t])

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
        if ('error' in built) {
            const err = built.error
            const reason = err.code === 'provider_required'
                ? t('meshGraph.magiKind.errorSlotProvider', { slot: err.slot })
                : err.code === 'replica_min'
                    ? t('meshGraph.magiKind.errorSlotReplica', { slot: err.slot })
                    : t('meshGraph.magiKind.errorNoSlot')
            setError(`${kind}: ${reason}`)
            return
        }
        setSavingKind(kind)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_kind_panel_set', { kind, slots: built.slots, ...(meshId ? { meshId } : {}) })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || t('meshGraph.magiKind.errorSave'))
            await loadKindPanels()
        } catch (e: any) {
            setError(e?.message || t('meshGraph.magiKind.errorSave'))
        } finally {
            setSavingKind(null)
        }
    }, [daemonId, sendDaemonCommand, slotsForKind, loadKindPanels, meshId, t])

    const handleRemove = useCallback(async (kind: MagiTaskKind) => {
        if (!daemonId || !sendDaemonCommand) return
        if (!confirm(t('meshGraph.magiKind.removeConfirm', { kind }))) return
        setSavingKind(kind)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_kind_panel_remove', { kind, ...(meshId ? { meshId } : {}) })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || t('meshGraph.magiKind.errorRemove'))
            await loadKindPanels()
        } catch (e: any) {
            setError(e?.message || t('meshGraph.magiKind.errorRemove'))
        } finally {
            setSavingKind(null)
        }
    }, [daemonId, sendDaemonCommand, loadKindPanels, meshId, t])

    const inputClass =`w-full rounded-lg border px-2.5 py-1.5 text-xs ${meshTheme.isDark ? 'border-white/10 bg-slate-950/40 text-slate-100 placeholder:text-slate-500' : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400'}`
    // Use the app design-system buttons so MAGI matches the rest of the mesh UI
    // (the old ad-hoc bg-sky-500 primary was the lone off-theme blue button).
    const btnPrimary = 'btn btn-primary btn-sm'
    const btnGhost = 'btn btn-secondary btn-sm'

    return (
        <div className="flex flex-col gap-3 p-1">
            <div className="flex flex-wrap items-center gap-2">
                <p className={`text-[12px] ${meshTheme.textSecondary}`}>
                    {t('meshGraph.magiKind.intro')}
                </p>
                <div className="ml-auto flex items-center gap-2">
                    <button type="button" className={btnGhost} onClick={() => void loadKindPanels()} disabled={loading || !canCommand}>
                        {loading ? t('meshGraph.magiKind.loading') : t('meshGraph.magiKind.refresh')}
                    </button>
                </div>
            </div>

            {!canCommand && (
                <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    {t('meshGraph.magiKind.connectPrompt')}
                </div>
            )}

            {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{error}</div>
            )}

            {/* ── Per-kind editors ── */}
            <div className="flex flex-col gap-3">
                {TASK_KINDS.map(({ kind, labelKey, hint }) => {
                    const slots = slotsForKind(kind)
                    const isBound = !!kindPanels[kind]
                    const busy = savingKind === kind
                    return (
                        <div key={kind} className={`${meshTheme.cardClass} rounded-2xl p-4 flex flex-col gap-3`}>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-[13px] font-semibold ${meshTheme.textPrimary}`}>{t(labelKey)}</span>
                                <span className={`font-mono text-3xs ${meshTheme.textMuted}`}>{hint}</span>
                                <span className={`rounded-full border px-2 py-0.5 text-3xs uppercase tracking-[0.14em] ${isBound
                                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                                    : 'border-slate-400/20 bg-slate-500/10 text-slate-300'}`}>
                                    {isBound ? t('meshGraph.magiKind.agentCount', { count: kindPanels[kind]!.length }) : t('meshGraph.magiKind.off')}
                                </span>
                            </div>

                            <div className="flex flex-col gap-2">
                                {slots.length === 0 && (
                                    <div className={`rounded-xl border p-2.5 text-2xs ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                                        {t('meshGraph.magiKind.noAgents')}
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
                                                <span className={`text-4xs uppercase tracking-wide ${meshTheme.textSecondary}`}>{t('meshGraph.magiKind.machine')}</span>
                                                <select className={inputClass} value={s.nodeId} onChange={e => updateSlot(kind, idx, { nodeId: e.target.value })} title={t('meshGraph.magiKind.machineTitle')}>
                                                    <option value="">{t('meshGraph.magiKind.anyMachine')}</option>
                                                    {knownNodeIds.map(id => {
                                                        const isWorktree = worktreeNodeIds.has(id)
                                                        const label = isWorktree
                                                            ? t('meshGraph.magiKind.worktreeSuffix', { label: nodeLabelById[id] ?? id, branch: worktreeBranchByNodeId[id] || t('meshGraph.magiKind.worktreeUnknownBranch') })
                                                            : (nodeLabelById[id] ?? id)
                                                        // Ephemeral worktree nodes are disabled (not removed) so a slot
                                                        // already assigned to one still renders correctly; disabled
                                                        // options only block NEW selection, browsers keep a disabled
                                                        // selected <option> visible and its value submits normally.
                                                        return <option key={id} value={id} disabled={isWorktree} title={isWorktree ? t('meshGraph.magiKind.worktreeDisabledTitle') : undefined}>{label}</option>
                                                    })}
                                                    {s.nodeId && !knownNodeIds.includes(s.nodeId) && <option value={s.nodeId}>{t('meshGraph.magiKind.offlineSuffix', { label: nodeLabelById[s.nodeId] ?? s.nodeId })}</option>}
                                                </select>
                                            </label>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-4xs uppercase tracking-wide ${meshTheme.textSecondary}`}>{t('meshGraph.magiKind.provider')} *</span>
                                                <select className={inputClass} value={s.provider} onChange={e => updateSlot(kind, idx, { provider: e.target.value })} title={t('meshGraph.magiKind.providerTitle')}>
                                                    <option value="">{t('meshGraph.magiKind.selectProvider')}</option>
                                                    {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
                                                    {s.provider && !providerOptions.includes(s.provider) && <option value={s.provider}>{s.provider}</option>}
                                                </select>
                                            </label>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-4xs uppercase tracking-wide ${meshTheme.textSecondary}`}>{t('meshGraph.magiKind.model')}</span>
                                                {(() => {
                                                    // Same control as the slot editor / New-session dialog: a
                                                    // provider-scoped dropdown when the provider declares models
                                                    // (with a Custom… escape to free text), else a plain input.
                                                    // A model the provider doesn't list reads as custom.
                                                    const models = (s.provider ? optionsByProvider.get(s.provider)?.models : undefined) ?? []
                                                    // A truthy model not in the list (incl. the ' ' custom-entry
                                                    // marker) means the operator picked Custom… — show free text.
                                                    const modelIsCustom = !!s.model && models.length > 0 && !models.includes(s.model)
                                                    return models.length > 0 && !modelIsCustom ? (
                                                        <select className={inputClass} value={models.includes(s.model) ? s.model : ''}
                                                            title={t('meshGraph.magiKind.modelTitle')}
                                                            onChange={e => updateSlot(kind, idx, { model: e.target.value === '__custom__' ? ' ' : e.target.value })}>
                                                            <option value="">{t('meshGraph.magiKind.modelDefault')}</option>
                                                            {models.map(m => <option key={m} value={m}>{m}</option>)}
                                                            <option value="__custom__">{t('meshGraph.magiKind.modelCustom')}</option>
                                                        </select>
                                                    ) : (
                                                        <>
                                                            <input className={inputClass} value={s.model.trim()} placeholder={t('meshGraph.magiKind.modelDefault')}
                                                                title={t('meshGraph.magiKind.modelTitle')}
                                                                onChange={e => updateSlot(kind, idx, { model: e.target.value })} />
                                                            {/* Back to the dropdown — only when the provider has a list to go back to. */}
                                                            {models.length > 0 && (
                                                                <button type="button"
                                                                    className={`self-start bg-transparent border-none cursor-pointer p-0 text-3xs ${meshTheme.textSecondary} hover:underline`}
                                                                    onClick={() => updateSlot(kind, idx, { model: '' })}>
                                                                    {t('meshGraph.magiKind.backToModelList')}
                                                                </button>
                                                            )}
                                                        </>
                                                    )
                                                })()}
                                            </label>
                                            <label className="flex flex-col gap-1">
                                                <span className={`text-4xs uppercase tracking-wide ${meshTheme.textSecondary}`}>{t('meshGraph.magiKind.copies')}</span>
                                                <input className={`${inputClass} sm:w-16`} value={s.n} placeholder="1" inputMode="numeric"
                                                    title={t('meshGraph.magiKind.copiesTitle')}
                                                    onChange={e => updateSlot(kind, idx, { n: e.target.value })} />
                                            </label>
                                            <button type="button" className={`${btnGhost} sm:mt-[18px] inline-flex h-8 w-8 items-center justify-center p-0`} onClick={() => removeSlot(kind, idx)} aria-label={t('meshGraph.magiKind.removeAgent')} title={t('meshGraph.magiKind.removeAgent')}>✕</button>
                                        </div>
                                    )
                                })}
                                <div>
                                    <button type="button" className={btnGhost} onClick={() => addSlot(kind)} disabled={!canCommand}>
                                        {t('meshGraph.magiKind.addAgent')}
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <button type="button" className={btnPrimary} onClick={() => void handleSave(kind)} disabled={busy || !canCommand}>
                                    {busy ? t('meshGraph.magiKind.saving') : t('meshGraph.magiKind.save')}
                                </button>
                                <button type="button" className={btnGhost} onClick={() => void handleRemove(kind)} disabled={busy || !canCommand || !isBound}
                                    title={isBound ? t('meshGraph.magiKind.removeBindingTitle') : t('meshGraph.magiKind.removeBindingDisabledTitle')}>
                                    {t('meshGraph.magiKind.removeBinding')}
                                </button>
                            </div>
                        </div>
                    )
                })}
            </div>

        </div>
    )
}
