/**
 * MeshBlueprintView — the "설계도면" (blueprint) tab of the mesh observability
 * surface. One place to answer: what orchestration graphs exist in this mesh,
 * which gates are waiting on a human, what unlocks what when something
 * completes, and where would the scheduler route new work.
 *
 * Composition:
 *  - graph picker: the live work queue (MeshTasksView, the pre-existing
 *    dependsOn DAG) plus every persistent graph from mesh_graph_overview
 *  - blueprint DAG: MeshBlueprintDagView renders the selected persistent
 *    graph; clicking a node opens a read-only detail panel. Gate VERBS are
 *    deliberately NOT exposed here (owner decision 2026-08-24): the dashboard
 *    observes, and acting on a gate is done by instructing the coordinator,
 *    whose MCP tools (mesh_gate_claim/release/abandon) are the acting surface.
 *  - scheduling preview: mesh_route_preview (read-only) shows the per-node
 *    predicted routing winner for a hypothetical task, so slot pressure is
 *    visible on the same screen as the plan
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeshGraphView, RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { unwrapDaemonCommandBody } from '../../utils/daemon-command-envelope'
import { IconRefresh } from '../Icons'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme } from './meshGraphTheme'
import MeshTaskDagView from './MeshTaskDagView'
import MeshBlueprintDagView from './MeshBlueprintDagView'

const STALE_MS = 24 * 60 * 60 * 1000

interface RoutePreviewSlotScore {
    providerType: string
    model?: string
    selectionRank?: number
    capacityAvailable?: boolean
    capacity?: { available?: boolean; slotCap?: number; providerCap?: number }
    difficultyEligible?: boolean
    quotaBonus?: number
    total?: number
    base?: number
    difficulty?: number
    tags?: number
}

interface RoutePreviewNode {
    nodeId: string
    predictedWinner?: { providerType: string; model?: string; fitnessScore?: number }
    reason?: string
    availabilityAssumption?: string
    stages?: {
        difficultyFloor?: {
            admittedSlots?: Array<{ providerType: string; model?: string }>
            excludedSlots?: Array<{ providerType: string; model?: string; reason?: string }>
        }
        fitness?: RoutePreviewSlotScore[]
    }
    quotaDiagnostics?: Array<{
        providerType: string
        bonus?: { value?: number }
        gate?: { outcome?: string; reason?: string }
    }>
}

/** Label for one slot: `provider·model` or bare provider. */
function slotLabel(slot: { providerType: string; model?: string }): string {
    return slot.model ? `${slot.providerType}·${slot.model}` : slot.providerType
}

function graphStatusChipClass(status: string): string {
    switch (status) {
        case 'completed': return 'text-green-500 bg-green-500/10'
        case 'failed': case 'compensation_required': return 'text-red-400 bg-red-500/10'
        case 'cancelled': return 'text-text-muted bg-bg-glass'
        case 'waiting_gate': return 'text-amber-500 bg-amber-500/10'
        default: return 'text-accent-primary bg-accent-primary/10'
    }
}

export default function MeshBlueprintView({ tasks, status, daemonId, sendDaemonCommand, emptyMessage }: {
    tasks: RepoMeshQueueTask[]
    status: RepoMeshStatus
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    emptyMessage?: string
}) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const meshId = status.meshId

    const [graphs, setGraphs] = useState<MeshGraphView[]>([])
    const [graphsError, setGraphsError] = useState('')
    const [graphsLoading, setGraphsLoading] = useState(false)
    const [includeTerminal, setIncludeTerminal] = useState(false)
    const [selected, setSelected] = useState<'live' | string>('live')
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)


    const [schedDetailOpen, setSchedDetailOpen] = useState(false)
    const [schedDetailDifficulty, setSchedDetailDifficulty] = useState<'easy' | 'medium' | 'difficult' | 'freeform'>('medium')
    const [schedReadonly, setSchedReadonly] = useState(false)
    const [schedLoading, setSchedLoading] = useState(false)
    const [schedError, setSchedError] = useState('')
    /** difficulty → ranked node previews (scheduler order: index 0 = next match). */
    const [schedMatrix, setSchedMatrix] = useState<Record<string, RoutePreviewNode[]> | null>(null)
    const [schedObservedAt, setSchedObservedAt] = useState('')

    const nowMs = useMemo(() => Date.now(), [graphs])
    const canCommand = Boolean(daemonId && sendDaemonCommand)

    const nodeLabelById = useMemo(() => {
        const map = new Map<string, string>()
        for (const node of status.nodes ?? []) {
            const label = node.machineLabel || (node as any).worktreeBranch
                || (typeof node.workspace === 'string' ? node.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '')
            map.set(node.nodeId, label || node.nodeId.slice(0, 12))
        }
        return map
    }, [status.nodes])

    const refreshGraphs = useCallback(async () => {
        if (!canCommand) return
        setGraphsLoading(true)
        setGraphsError('')
        try {
            const raw = await sendDaemonCommand!(daemonId!, 'mesh_graph_overview', { meshId, includeTerminal })
            const body = unwrapDaemonCommandBody<{ success?: boolean; error?: string; graphs?: MeshGraphView[] }>(raw)
            if (!body || body.success === false) throw new Error(body?.error || 'graph overview failed')
            setGraphs(Array.isArray(body.graphs) ? body.graphs : [])
        } catch (e: any) {
            setGraphsError(e?.message || String(e))
        } finally {
            setGraphsLoading(false)
        }
    }, [canCommand, daemonId, includeTerminal, meshId, sendDaemonCommand])

    useEffect(() => { void refreshGraphs() }, [refreshGraphs])

    const selectedGraph = useMemo(
        () => (selected === 'live' ? null : graphs.find(g => g.graphId === selected) ?? null),
        [graphs, selected],
    )
    // A selected graph that disappeared from the list (e.g. terminal filter) falls back to live.
    useEffect(() => {
        if (selected !== 'live' && !graphsLoading && !graphs.some(g => g.graphId === selected)) setSelected('live')
    }, [graphs, graphsLoading, selected])

    const selectedNode = useMemo(
        () => selectedGraph?.nodes.find(n => n.nodeId === selectedNodeId) ?? null,
        [selectedGraph, selectedNodeId],
    )
    const selectedGate = useMemo(
        () => (selectedNode ? selectedGraph?.gates.find(g => g.nodeId === selectedNode.nodeId) ?? null : null),
        [selectedGraph, selectedNode],
    )

    // Load the full difficulty matrix in one sweep — the point of the panel is
    // "which slot matches next, per difficulty, at a glance", so it must not
    // hide behind a run button. Auto-runs on mount and when read-only flips.
    const runRoutePreview = useCallback(async () => {
        if (!canCommand) return
        setSchedLoading(true)
        setSchedError('')
        try {
            const difficulties = ['easy', 'medium', 'difficult', 'freeform'] as const
            const results = await Promise.all(difficulties.map(async difficulty => {
                const raw = await sendDaemonCommand!(daemonId!, 'mesh_route_preview', {
                    meshId,
                    difficulty,
                    readonly: schedReadonly,
                })
                const body = unwrapDaemonCommandBody<{ success?: boolean; error?: string; preview?: any }>(raw)
                if (!body || body.success === false) throw new Error(body?.error || 'route preview failed')
                const nodes = Array.isArray(body.preview?.nodes) ? body.preview.nodes as RoutePreviewNode[] : []
                const observedAt = typeof body.preview?.snapshot?.observedAt === 'string' ? body.preview.snapshot.observedAt : ''
                return { difficulty, nodes, observedAt }
            }))
            const matrix: Record<string, RoutePreviewNode[]> = {}
            for (const entry of results) matrix[entry.difficulty] = entry.nodes
            setSchedMatrix(matrix)
            setSchedObservedAt(results.find(r => r.observedAt)?.observedAt ?? '')
        } catch (e: any) {
            setSchedError(e?.message || String(e))
            setSchedMatrix(null)
        } finally {
            setSchedLoading(false)
        }
    }, [canCommand, daemonId, meshId, schedReadonly, sendDaemonCommand])

    useEffect(() => { void runRoutePreview() }, [runRoutePreview])

    // difficulty → next-match slot label, threaded onto the live-queue DAG cards.
    const predictedSlots = useMemo(() => {
        if (!schedMatrix) return undefined
        const out: Record<string, string> = {}
        for (const difficulty of ['easy', 'medium', 'difficult', 'freeform']) {
            const nodes = schedMatrix[difficulty] ?? []
            const first = nodes[0]
            const slot = first?.stages?.fitness?.[0] ?? first?.predictedWinner
            if (!first || !slot) continue
            const nodeLabel = nodes.length > 1 ? `${nodeLabelById.get(first.nodeId) ?? first.nodeId.slice(0, 8)}/` : ''
            out[difficulty] = `${nodeLabel}${slotLabel(slot)}`
        }
        return out
    }, [schedMatrix, nodeLabelById])

    const chipBase = 'shrink-0 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-2xs transition-colors'
    const chipIdle = meshTheme.isDark
        ? 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]'
        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
    const chipActive = meshTheme.isDark
        ? 'border-cyan-300/50 bg-cyan-500/10 text-cyan-100'
        : 'border-sky-400 bg-sky-50 text-sky-800'

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            {/* ── Graph picker row ── */}
            <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1">
                    <button type="button" className={`${chipBase} ${selected === 'live' ? chipActive : chipIdle}`} onClick={() => { setSelected('live'); setSelectedNodeId(null) }}>
                        {t('meshGraph.blueprint.liveQueue')}
                    </button>
                    {graphs.map(graph => {
                        const updatedMs = Date.parse(graph.terminalAt ?? graph.createdAt)
                        const inFlight = graph.status === 'active' || graph.status === 'waiting_gate'
                        const isStale = inFlight && Number.isFinite(updatedMs) && nowMs - updatedMs > STALE_MS
                        const awaiting = graph.gates.filter(g => g.state === 'awaiting_coordinator').length
                        return (
                            <button
                                key={graph.graphId}
                                type="button"
                                className={`${chipBase} ${selected === graph.graphId ? chipActive : chipIdle} ${isStale ? 'border-amber-500/50' : ''}`}
                                onClick={() => { setSelected(graph.graphId); setSelectedNodeId(null) }}
                                title={`${graph.graphId} · ${graph.status}`}
                            >
                                <span className="font-mono">{graph.graphId.slice(0, 8)}</span>
                                <span className={`rounded px-1 py-px text-4xs font-semibold ${graphStatusChipClass(graph.status)}`}>{graph.status}</span>
                                {awaiting > 0 && <span className="rounded bg-amber-500/15 px-1 py-px text-4xs font-semibold text-amber-500">⛩{awaiting}</span>}
                            </button>
                        )
                    })}
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-2xs text-text-muted cursor-pointer">
                    <input type="checkbox" checked={includeTerminal} onChange={e => setIncludeTerminal(e.target.checked)} />
                    {t('repoMesh.graphs.includeTerminal')}
                </label>
                <button type="button" className="btn btn-sm btn-secondary flex shrink-0 items-center gap-1.5" disabled={graphsLoading || !canCommand} onClick={() => void refreshGraphs()}>
                    <IconRefresh size={13} /> {t('repoMesh.graphs.refresh')}
                </button>
            </div>

            {graphsError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{graphsError}</div>}

            {/* ── Body ── */}
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl">
                {selected === 'live' ? (
                    // The blueprint reading of the live queue is the FULL dependency
                    // DAG — the task list already lives on the overview tab, so a
                    // list here would be a duplicate, not a blueprint.
                    <div className="absolute inset-0">
                        <MeshTaskDagView tasks={tasks} emptyMessage={emptyMessage} predictedSlots={predictedSlots} initialTerminalLimit={8} />
                    </div>
                ) : selectedGraph ? (
                    <div className="absolute inset-0 flex flex-col">
                        <div className="min-h-0 flex-1">
                            <MeshBlueprintDagView graph={selectedGraph} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} />
                        </div>

                        {/* ── Selection detail — READ-ONLY. Gate verbs are deliberately
                            not exposed (owner decision 2026-08-24): acting on a gate
                            is done by instructing the coordinator, not by clicking. ── */}
                        {selectedNode && (
                            <div className={`absolute bottom-0 left-0 right-0 z-10 rounded-xl border px-3 py-2 text-2xs shadow-lg ${meshTheme.isDark ? 'border-white/10 bg-slate-950/95' : 'border-slate-200 bg-white'}`}>
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold text-text-primary">
                                        {selectedNode.kind === 'coordinator_gate' ? '⛩ ' : ''}{selectedNode.ref || selectedNode.nodeId.slice(0, 8)}
                                    </span>
                                    <span className="text-text-muted">{selectedGate ? `${selectedGate.action} · ${selectedGate.state}` : selectedNode.state}</span>
                                    {selectedNode.taskId && <span className="font-mono text-4xs text-text-muted" title={selectedNode.taskId}>task {selectedNode.taskId.slice(0, 8)}</span>}
                                    {selectedGate && selectedGate.state === 'awaiting_coordinator' && (
                                        <span className="ml-auto text-3xs text-text-muted">{t('meshGraph.blueprint.gateActsViaCoordinator')}</span>
                                    )}
                                </div>
                                {selectedGate?.instructions && <div className="mt-1.5 whitespace-pre-line text-3xs text-text-muted">{selectedGate.instructions}</div>}
                                {selectedNode.blockedReason && !selectedGate && <div className="mt-1.5 text-3xs text-amber-500">{selectedNode.blockedReason}</div>}
                                {selectedNode.failureReason && <div className="mt-1.5 text-3xs text-red-400">{selectedNode.failureReason}</div>}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-400">
                        {canCommand ? t('repoMesh.graphs.loading') : t('meshGraph.obs.planeNeedsDaemon')}
                    </div>
                )}

                {/* ── Scheduling summary — a compact in-graph badge (difficulty →
                    next slot), click for the full per-node detail. The full matrix
                    stays hidden by default: the blueprint is the star, the forecast
                    is a legend. ── */}
                {predictedSlots && (
                    <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
                        <button
                            type="button"
                            onClick={() => setSchedDetailOpen(open => !open)}
                            className={`rounded-lg border px-2 py-1 text-left text-3xs leading-4 shadow-sm ${meshTheme.isDark
                                ? 'border-white/10 bg-slate-950/85 text-slate-300 hover:bg-slate-900'
                                : 'border-slate-200 bg-white/95 text-slate-600 hover:bg-slate-50'}`}
                            title={t('meshGraph.blueprint.scheduling')}
                        >
                            {(['easy', 'medium', 'difficult', 'freeform'] as const).map(difficulty => (
                                <div key={difficulty} className="flex items-center gap-1.5">
                                    <span className="w-14 uppercase tracking-wide text-4xs opacity-60">{difficulty}</span>
                                    <span className="text-green-500">→ {predictedSlots[difficulty] ?? '—'}</span>
                                </div>
                            ))}
                        </button>

                        {schedDetailOpen && schedMatrix && (
                            <div className={`max-h-[45dvh] w-[min(620px,92vw)] overflow-y-auto rounded-xl border p-2.5 text-2xs shadow-lg ${meshTheme.isDark ? 'border-white/10 bg-slate-950/95' : 'border-slate-200 bg-white'}`}>
                                <div className="mb-2 flex items-center gap-1.5">
                                    {(['easy', 'medium', 'difficult', 'freeform'] as const).map(difficulty => (
                                        <button key={difficulty} type="button"
                                            className={`rounded-md px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${schedDetailDifficulty === difficulty
                                                ? (meshTheme.isDark ? 'bg-white/10 text-slate-100' : 'bg-slate-200 text-slate-800')
                                                : 'text-text-muted hover:bg-bg-glass'}`}
                                            onClick={() => setSchedDetailDifficulty(difficulty)}>
                                            {difficulty}
                                        </button>
                                    ))}
                                    {schedObservedAt && <span className="ml-auto text-4xs text-text-muted">{t('meshGraph.blueprint.schedObservedAt', { time: schedObservedAt.slice(11, 19) })}</span>}
                                    <label className="flex items-center gap-1 text-3xs text-text-muted cursor-pointer">
                                        <input type="checkbox" checked={schedReadonly} onChange={e => setSchedReadonly(e.target.checked)} />
                                        read-only
                                    </label>
                                    <button type="button" className="btn btn-sm btn-secondary" disabled={schedLoading || !canCommand} onClick={() => void runRoutePreview()}>
                                        <IconRefresh size={11} />
                                    </button>
                                </div>
                                {schedError && <div className="text-3xs text-red-400">{schedError}</div>}
                                {(() => {
                                    const nodes = schedMatrix[schedDetailDifficulty] ?? []
                                    interface DetailRow {
                                        nodeLabel: string
                                        slot: { providerType: string; model?: string }
                                        score?: RoutePreviewSlotScore
                                        quotaOutcome?: string
                                        quotaBonus?: number
                                        status: 'next' | 'waiting' | 'full' | 'floor'
                                    }
                                    const rows: DetailRow[] = []
                                    nodes.forEach((node, nodeIndex) => {
                                        const nodeLabel = nodeLabelById.get(node.nodeId) ?? node.nodeId.slice(0, 12)
                                        const quotaByProvider = new Map((node.quotaDiagnostics ?? []).map(q => [q.providerType, q]))
                                        const ranked = node.stages?.fitness ?? []
                                        ranked.forEach((score, slotIndex) => {
                                            const quota = quotaByProvider.get(score.providerType)
                                            rows.push({
                                                nodeLabel,
                                                slot: score,
                                                score,
                                                quotaOutcome: quota?.gate?.outcome,
                                                quotaBonus: score.quotaBonus ?? quota?.bonus?.value,
                                                status: nodeIndex === 0 && slotIndex === 0 ? 'next'
                                                    : score.capacityAvailable === false ? 'full' : 'waiting',
                                            })
                                        })
                                        for (const slot of node.stages?.difficultyFloor?.excludedSlots ?? []) {
                                            rows.push({ nodeLabel, slot, status: 'floor' })
                                        }
                                    })
                                    const statusBadge = (row: DetailRow) => {
                                        switch (row.status) {
                                            case 'next': return <span className="rounded bg-green-500/15 px-1.5 py-px text-3xs font-semibold text-green-500">{t('meshGraph.blueprint.schedNext')}</span>
                                            case 'full': return <span className="rounded bg-amber-500/15 px-1.5 py-px text-3xs text-amber-500">{t('meshGraph.blueprint.schedFull')}</span>
                                            case 'floor': return <span className="rounded bg-bg-glass px-1.5 py-px text-3xs text-text-muted">{t('meshGraph.blueprint.schedFloorExcluded')}</span>
                                            default: return <span className="rounded bg-bg-glass px-1.5 py-px text-3xs text-text-secondary">{t('meshGraph.blueprint.schedWaiting')}</span>
                                        }
                                    }
                                    const capacityLabel = (row: DetailRow) => {
                                        const capacity = row.score?.capacity
                                        if (!capacity) return '—'
                                        const cap = capacity.slotCap ?? capacity.providerCap
                                        if (capacity.available !== false) return cap != null ? `${t('meshGraph.blueprint.schedCapFree')} · ${cap}` : t('meshGraph.blueprint.schedCapFree')
                                        return cap != null ? `${t('meshGraph.blueprint.schedFull')} (${cap})` : t('meshGraph.blueprint.schedFull')
                                    }
                                    if (rows.length === 0) return <div className="py-2 text-3xs text-text-muted">{t('meshGraph.blueprint.schedNoNodes')}</div>
                                    const showNodeCol = nodes.length > 1
                                    return (
                                        <table className="w-full border-collapse text-left">
                                            <thead>
                                                <tr className="text-4xs uppercase tracking-wide text-text-muted">
                                                    {showNodeCol && <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColNode')}</th>}
                                                    <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColSlot')}</th>
                                                    <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColScore')}</th>
                                                    <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColQuota')}</th>
                                                    <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColParallel')}</th>
                                                    <th className="py-1 font-medium">{t('meshGraph.blueprint.schedColStatus')}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {rows.map((row, index) => (
                                                    <tr key={index} className={`border-t ${meshTheme.isDark ? 'border-white/5' : 'border-slate-100'} ${row.status === 'next' ? 'bg-green-500/5' : row.status === 'floor' ? 'opacity-55' : ''}`}>
                                                        {showNodeCol && <td className="max-w-[130px] truncate py-1 pr-2 text-3xs text-text-muted" title={row.nodeLabel}>{row.nodeLabel}</td>}
                                                        <td className="py-1 pr-2 text-2xs text-text-primary">{slotLabel(row.slot)}</td>
                                                        <td className="py-1 pr-2 font-mono text-3xs text-text-secondary" title={row.score ? `base ${row.score.base ?? '—'} + diff ${row.score.difficulty ?? '—'} + tags ${row.score.tags ?? '—'} + quota ${row.score.quotaBonus ?? '—'}` : undefined}>
                                                            {row.score?.total ?? '—'}
                                                        </td>
                                                        <td className="py-1 pr-2 text-3xs">
                                                            {row.quotaOutcome === 'hard-block' || row.quotaOutcome === 'skip'
                                                                ? <span className="text-red-400" title={row.quotaOutcome}>{t('meshGraph.blueprint.schedQuotaGated')}</span>
                                                                : <span className="text-text-secondary">{row.quotaBonus != null ? `+${row.quotaBonus}` : '—'}</span>}
                                                        </td>
                                                        <td className="py-1 pr-2 text-3xs text-text-secondary">{capacityLabel(row)}</td>
                                                        <td className="py-1">{statusBadge(row)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )
                                })()}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
