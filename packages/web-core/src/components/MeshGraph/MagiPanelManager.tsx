/**
 * MAGI Panel Manager — CRUD UI for machine-local MAGI panels.
 *
 * MAGI panels (`~/.adhdev/meshes.json` `magiPanels`) are backend-only config,
 * mutable until now only via the mcp-server tools. This surface lets the operator
 * list / create / edit / delete them from the dashboard. It talks to the daemon
 * through the SAME `sendDaemonCommand` seam the rest of MeshObservabilitySurface
 * uses (heal / git-log actions) — `magi_panel_list` / `magi_panel_set` /
 * `magi_panel_remove`, the daemon-core handlers added in mesh-crud.ts. Cloud
 * routes that command P2P-only (web-cloud api.ts); standalone routes it to the
 * same daemon-core router over localhost:3847. One handler set, both transports.
 *
 * Resolvability (per-member available / node-missing / provider-unavailable, and
 * the panel-level coupling badge) is computed CLIENT-SIDE in magi-panel-resolve.ts
 * against the live mesh node list, because the fan-out planner lives in mcp-server
 * and the daemon returns raw definitions only.
 *
 * NOTE: `task_kind` is a per-review argument to mesh_magi_review, NOT a panel
 * field — it is intentionally absent from this editor.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MagiPanel, MagiPanelMember, MagiPanelMap } from '@adhdev/mesh-shared'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import {
    resolveMagiPanel,
    type MagiMemberAvailability,
    type MagiResolveNode,
} from '../../utils/magi-panel-resolve'

const MAX_MAGI_PANEL_MEMBERS = 24

/**
 * Static provider fallback used when no live mesh node reports any provider
 * (offline / pre-handshake). Live providers always take precedence; this is only
 * the empty-mesh escape hatch so the dropdown / seed preset never dead-ends.
 */
const FALLBACK_PROVIDERS = ['claude-cli', 'codex-cli', 'gemini-cli', 'hermes-cli', 'antigravity-cli']

interface MagiPanelManagerProps {
    status: RepoMeshStatus
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

// ─── Draft editor state (string-form for inputs) ────────────────────────────

interface MemberDraft {
    provider: string
    nodeId: string
    capabilityTags: string
    n: string
}

interface PanelDraft {
    /** Original key — empty for a new panel; set when editing an existing one. */
    originalName: string
    name: string
    description: string
    defaultN: string
    members: MemberDraft[]
}

function emptyMember(): MemberDraft {
    return { provider: '', nodeId: '', capabilityTags: '', n: '' }
}

function newPanelDraft(): PanelDraft {
    return { originalName: '', name: '', description: '', defaultN: '', members: [emptyMember()] }
}

/**
 * Seed an independent 2-member draft from the live mesh: pick two distinct
 * providers (preferring two distinct nodes that offer them) so the panel starts
 * independent. Falls back to static example providers when the live mesh has
 * fewer than two — the user can still edit, so the button is never a dead-end.
 */
function seedIndependentDraft(nodes: MagiResolveNode[]): PanelDraft {
    const nodeProviders = (n: MagiResolveNode): string[] =>
        n.providers?.length ? n.providers.filter(Boolean) : (n.providerPriority ?? []).filter(Boolean)

    // Try to pick two members on two different nodes with two different providers.
    let memberA: MemberDraft | null = null
    let memberB: MemberDraft | null = null
    outer: for (let i = 0; i < nodes.length; i++) {
        for (const pa of nodeProviders(nodes[i])) {
            for (let j = 0; j < nodes.length; j++) {
                if (j === i) continue
                for (const pb of nodeProviders(nodes[j])) {
                    if (pb === pa) continue
                    memberA = { provider: pa, nodeId: nodes[i].nodeId, capabilityTags: '', n: '' }
                    memberB = { provider: pb, nodeId: nodes[j].nodeId, capabilityTags: '', n: '' }
                    break outer
                }
            }
        }
    }

    // No two distinct (node, provider) pairs — fall back to two distinct providers
    // (tag-routed, no pinned node) from the live set, then to static examples.
    if (!memberA || !memberB) {
        const liveProviders = [...new Set(nodes.flatMap(nodeProviders))]
        const [pa, pb] = liveProviders.length >= 2 ? liveProviders : FALLBACK_PROVIDERS
        memberA = { provider: pa, nodeId: '', capabilityTags: '', n: '' }
        memberB = { provider: pb, nodeId: '', capabilityTags: '', n: '' }
    }

    return { originalName: '', name: 'design-review', description: '', defaultN: '', members: [memberA, memberB] }
}

function panelToDraft(name: string, panel: MagiPanel): PanelDraft {
    return {
        originalName: name,
        name,
        description: panel.description ?? '',
        defaultN: panel.defaultN != null ? String(panel.defaultN) : '',
        members: (panel.members ?? []).map(m => ({
            provider: m.provider ?? '',
            nodeId: m.nodeId ?? '',
            capabilityTags: (m.capabilityTags ?? []).join(', '),
            n: m.n != null ? String(m.n) : '',
        })),
    }
}

/** Build the `panel` payload from a draft. Returns null + reason when invalid client-side. */
function draftToPanel(draft: PanelDraft): { panel: MagiPanel } | { error: string } {
    const members: MagiPanelMember[] = []
    for (let i = 0; i < draft.members.length; i++) {
        const m = draft.members[i]
        const provider = m.provider.trim()
        if (!provider) return { error: `Member ${i + 1}: provider is required` }
        const nodeId = m.nodeId.trim()
        const tags = m.capabilityTags.split(',').map(t => t.trim()).filter(Boolean)
        const nRaw = m.n.trim()
        let n: number | undefined
        if (nRaw) {
            const parsed = Number(nRaw)
            if (!Number.isFinite(parsed) || parsed < 1) return { error: `Member ${i + 1}: replica count must be ≥ 1` }
            n = Math.floor(parsed)
        }
        members.push({
            provider,
            ...(nodeId ? { nodeId } : {}),
            ...(tags.length ? { capabilityTags: tags } : {}),
            ...(n !== undefined ? { n } : {}),
        })
    }
    if (members.length === 0) return { error: 'A panel needs at least one member' }
    if (members.length > MAX_MAGI_PANEL_MEMBERS) return { error: `Too many members (max ${MAX_MAGI_PANEL_MEMBERS})` }
    const description = draft.description.trim()
    const dnRaw = draft.defaultN.trim()
    let defaultN: number | undefined
    if (dnRaw) {
        const parsed = Number(dnRaw)
        if (!Number.isFinite(parsed) || parsed < 1) return { error: 'Default replicas must be ≥ 1' }
        defaultN = Math.floor(parsed)
    }
    return {
        panel: {
            ...(description ? { description } : {}),
            members,
            ...(defaultN !== undefined ? { defaultN } : {}),
        },
    }
}

// ─── Availability badge ──────────────────────────────────────────────────────

const AVAILABILITY_LABEL: Record<MagiMemberAvailability, string> = {
    available: 'available',
    node_missing: 'node missing',
    provider_unavailable: 'provider unavailable',
    unknown: 'unknown',
}

function availabilityTone(a: MagiMemberAvailability): string {
    switch (a) {
        case 'available': return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
        case 'node_missing':
        case 'provider_unavailable': return 'border-rose-400/30 bg-rose-500/10 text-rose-300'
        default: return 'border-slate-400/20 bg-slate-500/10 text-slate-300'
    }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MagiPanelManager({ status, daemonId, sendDaemonCommand }: MagiPanelManagerProps) {
    const { theme } = useTheme()
    const meshTheme: MeshGraphTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const [panels, setPanels] = useState<MagiPanelMap>({})
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [editing, setEditing] = useState<PanelDraft | null>(null)
    const [saving, setSaving] = useState(false)

    const liveNodes: MagiResolveNode[] = useMemo(
        () => status.nodes.map(n => ({ nodeId: n.nodeId, providers: n.providers, providerPriority: n.providerPriority })),
        [status.nodes],
    )
    const knownNodeIds = useMemo(() => status.nodes.map(n => n.nodeId), [status.nodes])

    // Provider candidates for the (creatable) dropdown: every provider any live
    // node reports. Falls back to a static enum when the mesh reports none, so the
    // dropdown always offers something. Free-text entry is preserved regardless.
    const providerCandidates = useMemo(() => {
        const live = [...new Set(liveNodes.flatMap(n => (n.providers?.length ? n.providers : (n.providerPriority ?? []))).filter(Boolean))]
        return live.length ? live.sort() : FALLBACK_PROVIDERS
    }, [liveNodes])

    // Live independence assessment for the draft currently being edited — reuses
    // the SAME resolveMagiPanel the list badges use, so the editor shows the exact
    // coupled/independent verdict the saved panel will get.
    const draftResolution = useMemo(() => {
        if (!editing) return null
        const built = draftToPanel(editing)
        if ('error' in built) return null
        return resolveMagiPanel(built.panel, liveNodes)
    }, [editing, liveNodes])

    const canCommand = !!daemonId && !!sendDaemonCommand

    const unwrap = (raw: any) => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

    const loadPanels = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        setLoading(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_panel_list', {})
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to load MAGI panels')
            setPanels((result?.panels && typeof result.panels === 'object') ? result.panels : {})
        } catch (e: any) {
            setError(e?.message || 'Failed to load MAGI panels')
        } finally {
            setLoading(false)
        }
    }, [daemonId, sendDaemonCommand])

    useEffect(() => { void loadPanels() }, [loadPanels])

    const panelEntries = useMemo(() => Object.entries(panels).sort((a, b) => a[0].localeCompare(b[0])), [panels])

    const handleSave = useCallback(async () => {
        if (!editing || !daemonId || !sendDaemonCommand) return
        const name = editing.name.trim()
        if (!name) { setError('Panel name is required'); return }
        const built = draftToPanel(editing)
        if ('error' in built) { setError(built.error); return }
        // Overwrite when editing an existing panel (same key), or when the new
        // name collides with one already present — the editor is the operator's
        // explicit intent to replace.
        const overwrite = editing.originalName === name || Object.prototype.hasOwnProperty.call(panels, name)
        setSaving(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_panel_set', { name, panel: built.panel, overwrite })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to save panel')
            // Renamed: drop the old key (set writes the new one; old lingers).
            if (editing.originalName && editing.originalName !== name) {
                await sendDaemonCommand(daemonId, 'magi_panel_remove', { name: editing.originalName }).catch(() => {})
            }
            setEditing(null)
            await loadPanels()
        } catch (e: any) {
            setError(e?.message || 'Failed to save panel')
        } finally {
            setSaving(false)
        }
    }, [editing, daemonId, sendDaemonCommand, panels, loadPanels])

    const handleRemove = useCallback(async (name: string) => {
        if (!daemonId || !sendDaemonCommand) return
        if (!confirm(`Remove MAGI panel "${name}"?`)) return
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_panel_remove', { name })
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to remove panel')
            await loadPanels()
        } catch (e: any) {
            setError(e?.message || 'Failed to remove panel')
        }
    }, [daemonId, sendDaemonCommand, loadPanels])

    // ─── Member-row editor helpers ───────────────────────────────────────────
    const updateMember = (idx: number, patch: Partial<MemberDraft>) => {
        setEditing(d => d ? { ...d, members: d.members.map((m, i) => i === idx ? { ...m, ...patch } : m) } : d)
    }
    const addMember = () => setEditing(d => d ? { ...d, members: [...d.members, emptyMember()] } : d)
    const removeMember = (idx: number) => setEditing(d => d ? { ...d, members: d.members.filter((_, i) => i !== idx) } : d)

    const inputClass = `w-full rounded-lg border px-2.5 py-1.5 text-xs ${meshTheme.isDark ? 'border-white/10 bg-slate-950/40 text-slate-100 placeholder:text-slate-500' : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400'}`
    const btnPrimary = 'rounded-lg px-3 py-1.5 text-xs font-semibold bg-sky-500/90 text-white hover:bg-sky-500 disabled:opacity-50'
    const btnGhost = `rounded-lg px-3 py-1.5 text-xs font-medium ${meshTheme.textSecondary} border ${meshTheme.isDark ? 'border-white/10 hover:bg-white/[0.05]' : 'border-slate-300 hover:bg-slate-50'}`

    const helperClass = `text-[10px] leading-4 ${meshTheme.textMuted}`

    return (
        <div className="flex flex-col gap-3 p-1">
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>MAGI panels</span>
                <span className={`text-[11px] ${meshTheme.textSecondary}`}>
                    Reusable (node × provider) cross-verification quorums — machine-local config.
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <button type="button" className={btnGhost} onClick={() => void loadPanels()} disabled={loading || !canCommand}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                    <button type="button" className={btnGhost} onClick={() => { setError(null); setEditing(seedIndependentDraft(liveNodes)) }} disabled={!canCommand}
                        title="Pre-fill an independent 2-member panel (two different AIs, ideally on two machines) you can tweak.">
                        Start with an independent 2-member panel
                    </button>
                    <button type="button" className={btnPrimary} onClick={() => { setError(null); setEditing(newPanelDraft()) }} disabled={!canCommand}>
                        New panel
                    </button>
                </div>
            </div>

            {/* ── Explainer banner ── */}
            <div className={`rounded-xl border p-3 text-[11px] leading-5 ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
                A <span className={`font-semibold ${meshTheme.textPrimary}`}>MAGI panel</span> is a saved team of independent AI agents that
                answer the same question in parallel for cross-verification. Mixing different AI providers and different machines raises
                confidence; when they disagree, that disagreement flags what to double-check. Create one once and reuse it across investigations.
                <div className="mt-2">
                    <span className={`font-semibold ${meshTheme.textPrimary}`}>Independent</span> = the panel spans 2+ different AIs <em>and</em> 2+
                    different machines. <span className={`font-semibold ${meshTheme.textPrimary}`}>Coupled</span> = it collapses to one AI or one
                    machine (two copies of the same AI repeat the same mistakes, so agreement doesn&apos;t add confidence). To make it independent:
                    give members different Providers, and ideally different Nodes.
                </div>
            </div>

            {!canCommand && (
                <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    Connect to a coordinator daemon to manage MAGI panels.
                </div>
            )}

            {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{error}</div>
            )}

            {/* ── Editor ── */}
            {editing && (
                <div className={`${meshTheme.cardClass} rounded-2xl p-4 flex flex-col gap-3`}>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>
                            {editing.originalName ? `Edit panel "${editing.originalName}"` : 'New panel'}
                        </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1">
                            <span className={`text-[10px] uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>Name</span>
                            <input className={inputClass} value={editing.name} placeholder="design-review"
                                onChange={e => setEditing(d => d ? { ...d, name: e.target.value } : d)} />
                            <span className={helperClass}>What to call this team. You&apos;ll invoke it by this name later. e.g. design-review</span>
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className={`text-[10px] uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>Default replicas (n)</span>
                            <input className={inputClass} value={editing.defaultN} placeholder="1" inputMode="numeric"
                                onChange={e => setEditing(d => d ? { ...d, defaultN: e.target.value } : d)} />
                            <span className={helperClass}>How many times to run each member by default (optional, blank = 1). Adding more members is usually better than replicating one.</span>
                        </label>
                    </div>
                    <label className="flex flex-col gap-1">
                        <span className={`text-[10px] uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>Description</span>
                        <input className={inputClass} value={editing.description} placeholder="optional label"
                            onChange={e => setEditing(d => d ? { ...d, description: e.target.value } : d)} />
                        <span className={helperClass}>Optional note on when to use this team.</span>
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className={`text-[10px] uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>Members — (node × provider) targets</span>
                        <span className={helperClass}>Each member is one machine × one AI. Mixing different AIs and machines makes cross-verification stronger.</span>
                        {editing.members.map((m, idx) => (
                            <div key={idx} className={`rounded-xl border p-2.5 grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto_auto] gap-2 items-end ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                                <label className="flex flex-col gap-1">
                                    <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Provider *</span>
                                    <input className={inputClass} value={m.provider} placeholder="claude-cli"
                                        list="magi-provider-options"
                                        onChange={e => updateMember(idx, { provider: e.target.value })} />
                                    <span className={helperClass}>The AI this member runs. e.g. claude-cli, codex-cli, gemini-cli. Pick from the list or type your own.</span>
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Node (optional)</span>
                                    <select className={inputClass} value={m.nodeId} onChange={e => updateMember(idx, { nodeId: e.target.value })}>
                                        <option value="">(any — route by tags)</option>
                                        {knownNodeIds.map(id => <option key={id} value={id}>{id}</option>)}
                                        {m.nodeId && !knownNodeIds.includes(m.nodeId) && <option value={m.nodeId}>{m.nodeId} (not in live mesh)</option>}
                                    </select>
                                    <span className={helperClass}>Pin to a specific machine (optional). Blank = auto-assign to any machine that has this AI.</span>
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>Capability tags</span>
                                    <input className={inputClass} value={m.capabilityTags} placeholder="os=darwin, gpu"
                                        onChange={e => updateMember(idx, { capabilityTags: e.target.value })} />
                                    <span className={helperClass}>Routing filter, used only when Node is blank. e.g. os=darwin. Ignored if Node is set.</span>
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className={`text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`}>n</span>
                                    <input className={`${inputClass} sm:w-16`} value={m.n} placeholder="—" inputMode="numeric"
                                        onChange={e => updateMember(idx, { n: e.target.value })} />
                                    <span className={helperClass}>Replicas for just this member (optional, blank = the default above / 1).</span>
                                </label>
                                <button type="button" className={btnGhost} onClick={() => removeMember(idx)} disabled={editing.members.length <= 1} title="Remove member">✕</button>
                            </div>
                        ))}
                        {/* Shared provider candidate list — live mesh providers, static fallback when empty. Free text still allowed. */}
                        <datalist id="magi-provider-options">
                            {providerCandidates.map(p => <option key={p} value={p} />)}
                        </datalist>
                        <div>
                            <button type="button" className={btnGhost} onClick={addMember} disabled={editing.members.length >= MAX_MAGI_PANEL_MEMBERS}>
                                + Add member
                            </button>
                        </div>
                    </div>

                    {/* Live independence hint — same resolveMagiPanel verdict the saved panel gets. */}
                    {draftResolution && (
                        <div
                            className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-5 ${draftResolution.coupled
                                ? 'border-amber-400/30 bg-amber-500/10 text-amber-300'
                                : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'}`}
                        >
                            {draftResolution.coupled
                                ? `Current: coupled · ${draftResolution.distinctProviders}p × ${draftResolution.distinctNodes}m — ${draftResolution.distinctProviders < 2
                                    ? 'add a different Provider to make it independent.'
                                    : 'spread members across a different Node to make it independent.'}`
                                : `Current: independent · ${draftResolution.distinctProviders}p × ${draftResolution.distinctNodes}m ✓`}
                            {draftResolution.meshEmpty && ' (mesh offline — assessed from the declaration only.)'}
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <button type="button" className={btnPrimary} onClick={() => void handleSave()} disabled={saving}>
                            {saving ? 'Saving…' : 'Save panel'}
                        </button>
                        <button type="button" className={btnGhost} onClick={() => { setEditing(null); setError(null) }}>Cancel</button>
                    </div>
                </div>
            )}

            {/* ── List ── */}
            {panelEntries.length === 0 && !loading ? (
                <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    No MAGI panels configured on this machine yet.
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {panelEntries.map(([name, panel]) => (
                        <MagiPanelRow
                            key={name}
                            name={name}
                            panel={panel}
                            liveNodes={liveNodes}
                            meshTheme={meshTheme}
                            onEdit={() => { setError(null); setEditing(panelToDraft(name, panel)) }}
                            onRemove={() => void handleRemove(name)}
                            disabled={!canCommand}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function MagiPanelRow({
    name, panel, liveNodes, meshTheme, onEdit, onRemove, disabled,
}: {
    name: string
    panel: MagiPanel
    liveNodes: MagiResolveNode[]
    meshTheme: MeshGraphTheme
    onEdit: () => void
    onRemove: () => void
    disabled: boolean
}) {
    const resolution = useMemo(() => resolveMagiPanel(panel, liveNodes), [panel, liveNodes])
    const btnGhost = `rounded-lg px-2.5 py-1 text-[11px] font-medium ${meshTheme.textSecondary} border ${meshTheme.isDark ? 'border-white/10 hover:bg-white/[0.05]' : 'border-slate-300 hover:bg-slate-50'} disabled:opacity-50`
    return (
        <div className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`min-w-0 truncate text-[12px] font-semibold ${meshTheme.textPrimary}`} title={panel.description || name}>{name}</span>
                {panel.description && <span className={`min-w-0 truncate text-[11px] ${meshTheme.textSecondary}`}>{panel.description}</span>}
                <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-white/10 text-slate-300' : 'border-slate-300 text-slate-600'}`}>
                    {resolution.members.length} member{resolution.members.length === 1 ? '' : 's'} · {resolution.totalReplicas} replica{resolution.totalReplicas === 1 ? '' : 's'}
                </span>
                {/* Coupling badge — same independence rule as the live MAGI activity surface. */}
                <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${resolution.coupled ? 'border-amber-400/30 bg-amber-500/10 text-amber-300' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'}`}
                    title={resolution.coupled
                        ? 'Panel collapses to a single provider or machine — eventual agreements would be flagged source-coupled by MAGI synthesis.'
                        : 'Panel spans ≥2 providers and ≥2 machines — agreements would be independent.'}
                >
                    {resolution.coupled
                        ? `coupled · ${resolution.distinctProviders}p × ${resolution.distinctNodes}m`
                        : `independent · ${resolution.distinctProviders}p × ${resolution.distinctNodes}m`}
                </span>
                {resolution.meshEmpty && (
                    <span className={`text-[10px] ${meshTheme.textSecondary}`} title="No live mesh nodes reported — resolvability assessed against the raw definition.">
                        (mesh offline — declaration only)
                    </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                    <button type="button" className={btnGhost} onClick={onEdit} disabled={disabled}>Edit</button>
                    <button type="button" className={btnGhost} onClick={onRemove} disabled={disabled}>Delete</button>
                </div>
            </div>
            <div className="mt-2 flex flex-col gap-1">
                {resolution.members.map((mr, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className={`font-mono ${meshTheme.textPrimary}`}>{mr.member.provider}</span>
                        {mr.member.nodeId
                            ? <span className={meshTheme.textSecondary}>@ {mr.member.nodeId}</span>
                            : <span className={meshTheme.textSecondary}>@ any{mr.member.capabilityTags?.length ? ` [${mr.member.capabilityTags.join(', ')}]` : ''}</span>}
                        <span className={meshTheme.textSecondary}>× {mr.replicas}</span>
                        <span className={`rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${availabilityTone(mr.availability)}`}
                            title={mr.availability === 'available' && mr.matchingNodeIds.length ? `Resolves to: ${mr.matchingNodeIds.join(', ')}` : undefined}>
                            {AVAILABILITY_LABEL[mr.availability]}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}
