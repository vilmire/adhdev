/**
 * MeshBlueprintView — the "설계도면" (blueprint) tab of the mesh observability
 * surface. One place to answer: what is running, what is stuck on a human,
 * what just finished, and where would the scheduler route new work.
 *
 * Composition (P1 list redesign, owner-approved 2026-09-16 — the fused ELK
 * canvas is retired):
 *  - data plane: the live work queue plus every persistent graph from
 *    mesh_graph_overview (this component still owns both fetches)
 *  - MeshBlueprintList: sectioned rows (Running / Blocked / Recent / History)
 *    with scope chips and a status bar; graph gates surface as Blocked rows.
 *    Gate VERBS (Release / Abandon / Extend 24h) ARE exposed here as of D5
 *    (the 2026-09-25 graph orchestration simplification) — this
 *    supersedes the 2026-08-24 "coordinator-only" decision. They call the
 *    same mesh_graph_gate_release/abandon/extend daemon commands the MCP
 *    tools wrap, through the same sendDaemonCommand path every other
 *    Blueprint action (fast-forward, route preview) already uses.
 *  - on-demand mini DAG: a row backed by a graph WITH edges (or queue
 *    dependency edges) can expand a small React Flow plan (MeshMiniDag) —
 *    the only graph drawing left on this tab.
 *  - scheduling preview: mesh_route_preview (read-only) behind one compact
 *    chip + popover. The generic forecast is explicitly UNPINNED; a task
 *    pinned to a node (targetNodeId) gets its own pinned preview, rendered
 *    as a 📌 chip on its row — the only forecast a row ever shows.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeshGraphView, RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { unwrapDaemonCommandBody } from '../../utils/daemon-command-envelope'
import { IconRefresh } from '../Icons'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme } from './meshGraphTheme'
import { collectMachineQuotaGroups, machineKeyForMeshNode, resolveMachineLabel } from './MeshObservabilitySurface/meshSurfaceHelpers'
import { MeshMachineQuotaCard } from './MeshObservabilitySurface/MeshStatusTab'
import MeshBlueprintList from './MeshBlueprintList'
import { MeshOverviewDetailModal } from './MeshOverviewCards'
import {
    BLUEPRINT_GRAPH_INITIAL_LIMIT,
    BLUEPRINT_GRAPH_LOAD_MORE_STEP,
    ROUTE_PREVIEW_COMPACT_DIFFICULTY,
    ROUTE_PREVIEW_DIFFICULTIES,
    buildBlueprintGraphOverviewArgs,
    buildPinnedSlotLabels,
    buildRoutePreviewRequests,
    getBlueprintGraphPagination,
    nextBlueprintGraphLimit,
    resolveCompactRoutePreviewLabel,
    routePreviewKey,
    routePreviewNextSlotLabel,
    routePreviewSlotLabel,
} from './blueprintViewModel'

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
        bonus?: { value?: number; zeroReason?: string }
        gate?: { outcome?: string; reason?: string }
    }>
}

/** Label for one slot: `provider·model` or bare provider. */
const slotLabel = routePreviewSlotLabel


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
    const [totalGraphCount, setTotalGraphCount] = useState(0)
    const [graphsError, setGraphsError] = useState('')
    const [graphsLoading, setGraphsLoading] = useState(false)
    const [graphLimit, setGraphLimit] = useState(BLUEPRINT_GRAPH_INITIAL_LIMIT)
    /** Shared overview detail modal — task rows and gate rows both open here. */
    const [detail, setDetail] = useState<import('./MeshOverviewCards').DetailSelection | null>(null)


    const [schedDetailOpen, setSchedDetailOpen] = useState(false)
    const [schedDetailDifficulty, setSchedDetailDifficulty] = useState<'easy' | 'medium' | 'difficult' | 'freeform'>('medium')
    const [schedExpandedRow, setSchedExpandedRow] = useState<string | null>(null)
    const [schedReadonly, setSchedReadonly] = useState(false)
    const [schedLoading, setSchedLoading] = useState(false)
    const [schedError, setSchedError] = useState('')
    /** difficulty → ranked node previews (scheduler order: index 0 = next match). */
    const [schedMatrix, setSchedMatrix] = useState<Record<string, RoutePreviewNode[]> | null>(null)
    const [schedObservedAt, setSchedObservedAt] = useState('')
    /** Per-machine quota view inside the scheduling popover (owner request
     *  2026-08-24): one click answers "how much plan headroom does each
     *  machine actually have" next to the routing forecast. */
    const [schedQuotaOpen, setSchedQuotaOpen] = useState(false)

    // Escape closes the transient scheduling popover FIRST — capture phase so
    // the dialog's own Escape handler doesn't tear down the whole surface.
    useEffect(() => {
        if (!schedDetailOpen) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            setSchedDetailOpen(false)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [schedDetailOpen])
    const canCommand = Boolean(daemonId && sendDaemonCommand)

    // Machine ⊃ nodes: a node's display name is its checkout identity
    // (⎇ branch for worktrees, base otherwise); the MACHINE is a separate
    // grouping axis (machineKeyForMeshNode) used to dedupe slot/quota views.
    /** nodeId → what to print on a row that RAN there: checkout · machine. */
    const nodeLabels = useMemo(() => {
        const map: Record<string, string> = {}
        for (const node of status.nodes ?? []) {
            const worktreeBranch = (node as { worktreeBranch?: string }).worktreeBranch
            const basename = typeof node.workspace === 'string' ? node.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
            const machineKey = machineKeyForMeshNode(node)
            const machine = resolveMachineLabel(status, machineKey)
            const checkout = worktreeBranch ? `⎇ ${worktreeBranch}` : (basename || node.machineLabel || node.nodeId.slice(0, 12))
            map[node.nodeId] = machine && machine !== checkout ? `${checkout} · ${machine}` : checkout
        }
        return map
    }, [status])

    const nodeMetaById = useMemo(() => {
        const map = new Map<string, { nodeLabel: string; machineKey: string; machineLabel: string; isWorktree: boolean }>()
        for (const node of status.nodes ?? []) {
            const worktreeBranch = (node as { worktreeBranch?: string }).worktreeBranch
            const basename = typeof node.workspace === 'string' ? node.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
            const machineKey = machineKeyForMeshNode(node)
            map.set(node.nodeId, {
                nodeLabel: worktreeBranch ? `⎇ ${worktreeBranch}` : (basename || node.machineLabel || node.nodeId.slice(0, 12)),
                machineKey,
                machineLabel: resolveMachineLabel(status, machineKey),
                isWorktree: !!worktreeBranch,
            })
        }
        return map
    }, [status])

    const openMission = useCallback((missionId: string) => {
        const mission = ((status as RepoMeshStatus).missions ?? []).find(candidate => candidate.id === missionId)
        if (mission) setDetail({ kind: 'mission', mission })
    }, [status])

    // missionId → title, so mission chips and group headers read as names.
    const missionTitles = useMemo(() => {
        const map: Record<string, string> = {}
        for (const mission of (status as { missions?: Array<{ id?: string; title?: string }> }).missions ?? []) {
            if (mission?.id && typeof mission.title === 'string' && mission.title.trim()) map[mission.id] = mission.title.trim()
        }
        return map
    }, [status])

    // Terminal graphs are always requested (the old checkbox default): the
    // list renders them as rows only under the History scope, so the cost of
    // having them is a chip count, not a canvas — while their mini DAGs stay
    // one tap away on Recent/History rows.
    const refreshGraphs = useCallback(async () => {
        if (!canCommand) return
        setGraphsLoading(true)
        setGraphsError('')
        try {
            const raw = await sendDaemonCommand!(
                daemonId!,
                'mesh_graph_overview',
                buildBlueprintGraphOverviewArgs(meshId, true, graphLimit),
            )
            const body = unwrapDaemonCommandBody<{ success?: boolean; error?: string; graphs?: MeshGraphView[]; totalGraphCount?: number }>(raw)
            if (!body || body.success === false) throw new Error(body?.error || 'graph overview failed')
            const nextGraphs = Array.isArray(body.graphs) ? body.graphs : []
            setGraphs(nextGraphs)
            setTotalGraphCount(typeof body.totalGraphCount === 'number' ? body.totalGraphCount : nextGraphs.length)
        } catch (e: any) {
            setGraphsError(e?.message || String(e))
        } finally {
            setGraphsLoading(false)
        }
    }, [canCommand, daemonId, graphLimit, meshId, sendDaemonCommand])

    useEffect(() => { void refreshGraphs() }, [refreshGraphs])
    // Drop a gate detail whose graph left the list (e.g. pagination change).
    useEffect(() => {
        setDetail(current => current?.kind === 'gate' && !graphs.some(g => g.graphId === current.graph.graphId) ? null : current)
    }, [graphs])

    // Load the full difficulty matrix in one sweep — the point of the panel is
    // "which slot matches next, per difficulty, at a glance", so it must not
    // hide behind a run button. Auto-runs on mount and when read-only flips.
    // The sweep also covers one PINNED preview per pending pinned task
    // (buildRoutePreviewRequests): a task pinned to a node routes there, so
    // annotating it with the UNPINNED forecast was a misprediction.
    const previewRequests = useMemo(() => buildRoutePreviewRequests(tasks), [tasks])
    // Stable signature of the request set — `tasks` identity changes on every
    // status poll, and the sweep must re-run only when the requests actually
    // change, not on each poll.
    const previewRequestsKey = previewRequests.map(r => routePreviewKey(r.difficulty, r.targetNodeId)).join('|')
    const previewRequestsRef = useRef(previewRequests)
    previewRequestsRef.current = previewRequests
    const runRoutePreview = useCallback(async () => {
        if (!canCommand) return
        setSchedLoading(true)
        setSchedError('')
        try {
            const results = await Promise.all(previewRequestsRef.current.map(async request => {
                const raw = await sendDaemonCommand!(daemonId!, 'mesh_route_preview', {
                    meshId,
                    difficulty: request.difficulty,
                    readonly: schedReadonly,
                    ...(request.targetNodeId ? { targetNodeId: request.targetNodeId } : {}),
                })
                const body = unwrapDaemonCommandBody<{ success?: boolean; error?: string; preview?: any }>(raw)
                if (!body || body.success === false) throw new Error(body?.error || 'route preview failed')
                const nodes = Array.isArray(body.preview?.nodes) ? body.preview.nodes as RoutePreviewNode[] : []
                const observedAt = typeof body.preview?.snapshot?.observedAt === 'string' ? body.preview.snapshot.observedAt : ''
                return { key: routePreviewKey(request.difficulty, request.targetNodeId), nodes, observedAt }
            }))
            const matrix: Record<string, RoutePreviewNode[]> = {}
            for (const entry of results) matrix[entry.key] = entry.nodes
            setSchedMatrix(matrix)
            setSchedObservedAt(results.find(r => r.observedAt)?.observedAt ?? '')
        } catch (e: any) {
            setSchedError(e?.message || String(e))
            setSchedMatrix(null)
        } finally {
            setSchedLoading(false)
        }
    }, [canCommand, daemonId, meshId, schedReadonly, sendDaemonCommand])

    useEffect(() => { void runRoutePreview() }, [runRoutePreview, previewRequestsKey])

    // difficulty → next-match slot label. This is the GENERIC forecast — a
    // hypothetical dispatch with NO pin; it lives in the scheduling chip +
    // popover only, never on a task row.
    const previewNodeSuffix = useCallback((nodeId: string) => {
        const meta = nodeMetaById.get(nodeId)
        return meta?.isWorktree ? ` @ ${meta.nodeLabel}` : ''
    }, [nodeMetaById])
    const predictedSlots = useMemo(() => {
        if (!schedMatrix) return undefined
        const out: Record<string, string> = {}
        for (const difficulty of ROUTE_PREVIEW_DIFFICULTIES) {
            const label = routePreviewNextSlotLabel(schedMatrix[difficulty], previewNodeSuffix)
            if (label) out[difficulty] = label
        }
        return out
    }, [schedMatrix, previewNodeSuffix])

    // The one line the scheduling chip shows — see
    // resolveCompactRoutePreviewLabel for why medium is the one that reads.
    const compactPredictedSlot = useMemo(() => resolveCompactRoutePreviewLabel(predictedSlots), [predictedSlots])

    // taskId → predicted slot on the task's PINNED node — the forecast that
    // actually applies to a pinned task, rendered as a 📌 chip on its row.
    const pinnedSlots = useMemo(() => {
        if (!schedMatrix) return undefined
        return buildPinnedSlotLabels(tasks, schedMatrix, previewNodeSuffix)
    }, [schedMatrix, tasks, previewNodeSuffix])

    const graphPagination = getBlueprintGraphPagination(graphs.length, totalGraphCount, graphLimit)

    /** Caller chrome on the list's status-bar row: scheduling chip, graph
     *  pagination, refresh. Wrap-flex — on a phone it drops to its own line. */
    const headerExtras = (
        <>
            {predictedSlots && (
                <button
                    type="button"
                    onClick={() => {
                        setSchedDetailDifficulty(ROUTE_PREVIEW_COMPACT_DIFFICULTY)
                        setSchedDetailOpen(open => !open)
                    }}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-3xs transition-colors ${meshTheme.isDark
                        ? 'border-white/10 bg-slate-950/70 text-slate-300 hover:bg-slate-900'
                        : 'border-slate-200 bg-white/95 text-slate-600 hover:bg-slate-50'}`}
                    title={t('mesh.blueprint.schedUnpinnedTitle')}
                >
                    <span className="uppercase tracking-wide text-4xs opacity-75">{t('mesh.blueprint.schedulingShort')}</span>
                    <span className="text-green-500">→ {compactPredictedSlot ?? t('mesh.blueprint.schedNoWinner')}</span>
                </button>
            )}
            {!graphsLoading && (
                <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-3xs text-text-muted">
                    <span>{t('mesh.graphs.shown', { count: graphs.length })}</span>
                    {graphPagination.canLoadMore && (
                        <button
                            type="button"
                            onClick={() => setGraphLimit(nextBlueprintGraphLimit)}
                            className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium transition-colors ${meshTheme.isDark
                                ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                                : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                        >
                            {t('mesh.graphs.loadMore', {
                                count: Math.min(BLUEPRINT_GRAPH_LOAD_MORE_STEP, graphPagination.hiddenCount),
                            })}
                        </button>
                    )}
                    {graphPagination.atServerLimit && (
                        <span title={t('mesh.graphs.serverLimitReached')}>
                            · {t('mesh.graphs.serverLimitHidden', { count: graphPagination.hiddenCount })}
                        </span>
                    )}
                </div>
            )}
            <button type="button" className="btn btn-sm btn-secondary flex shrink-0 items-center" disabled={graphsLoading || !canCommand} onClick={() => void refreshGraphs()} title={t('mesh.graphs.refresh')} aria-label={t('mesh.graphs.refresh')}>
                <IconRefresh size={13} />
            </button>
        </>
    )

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5">
            {graphsError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{graphsError}</div>}

            {/* ── Body — the drafting-paper shell keeps the blueprint identity;
                the LIST inside scrolls vertically (no pan/zoom canvas left at
                this level). `flex-1 min-h-0` takes exactly what the dialog
                offers — see the removed canvas's height-floor history for why
                no floor of its own. ── */}
            <div className={`${meshTheme.blueprintShellClass} flex-1 min-h-0`}>
                <div className="absolute inset-0 flex flex-col p-2">
                    <MeshBlueprintList
                        tasks={tasks}
                        status={status}
                        graphs={graphs}
                        meshTheme={meshTheme}
                        nodeLabels={nodeLabels}
                        missionTitles={missionTitles}
                        pinnedSlots={pinnedSlots}
                        emptyMessage={emptyMessage}
                        onTaskOpen={task => setDetail({ kind: 'queue', task })}
                        onGateOpen={(graph, nodeId, gate) => setDetail({ kind: 'gate', graph, nodeId, gate: gate ?? null })}
                        onMissionOpen={openMission}
                        headerExtras={headerExtras}
                        daemonId={daemonId}
                        meshId={meshId}
                        sendDaemonCommand={sendDaemonCommand}
                        onGatesChanged={refreshGraphs}
                    />
                </div>

                {/* ── Scheduling popover — anchored under the header chip.
                    Point-in-time premise stated in flow (no hover-only caveats
                    — phones have no hover). ── */}
                {schedDetailOpen && schedMatrix && (
                    <div className={`absolute right-2 top-9 z-20 max-h-[45dvh] w-[min(620px,calc(100%-16px))] overflow-y-auto rounded-lg border p-2.5 text-2xs shadow-md ${meshTheme.isDark ? 'border-white/10 bg-slate-950/98' : 'border-slate-300 bg-white'}`}>
                        <div className="mb-2 flex flex-wrap items-center gap-1.5">
                            {(['easy', 'medium', 'difficult', 'freeform'] as const).map(difficulty => (
                                <button key={difficulty} type="button"
                                    className={`rounded-md px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${schedDetailDifficulty === difficulty
                                        ? (meshTheme.isDark ? 'bg-white/10 text-slate-100' : 'bg-slate-200 text-slate-800')
                                        : 'text-text-muted hover:bg-bg-glass'}`}
                                    onClick={() => { setSchedDetailDifficulty(difficulty); setSchedQuotaOpen(false) }}>
                                    {difficulty}
                                </button>
                            ))}
                            <button type="button"
                                className={`rounded-md px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${schedQuotaOpen
                                    ? (meshTheme.isDark ? 'bg-white/10 text-slate-100' : 'bg-slate-200 text-slate-800')
                                    : 'text-text-muted hover:bg-bg-glass'}`}
                                title={t('mesh.blueprint.schedQuotaButtonTitle')}
                                onClick={() => setSchedQuotaOpen(open => !open)}>
                                {t('mesh.blueprint.schedQuotaButton')}
                            </button>
                            {schedObservedAt && <span className="ml-auto text-4xs text-text-muted">{t('mesh.blueprint.schedObservedAt', { time: schedObservedAt.slice(11, 19) })}</span>}
                            <label className="flex items-center gap-1 text-3xs text-text-muted cursor-pointer">
                                <input type="checkbox" checked={schedReadonly} onChange={e => setSchedReadonly(e.target.checked)} />
                                {t('mesh.blueprint.readonlyBadge')}
                            </label>
                            <button type="button" className="btn btn-sm btn-secondary" disabled={schedLoading || !canCommand} onClick={() => void runRoutePreview()}>
                                <IconRefresh size={11} />
                            </button>
                            <button type="button" className="btn btn-sm btn-secondary" aria-label={t('common.close')} onClick={() => setSchedDetailOpen(false)}>
                                ✕
                            </button>
                        </div>
                        {schedError && <div className="text-3xs text-red-400">{schedError}</div>}
                        <div className="mb-1.5 text-4xs leading-4 text-text-muted">
                            {t('mesh.blueprint.schedUnpinnedTitle')}
                            {' · '}
                            {t('mesh.blueprint.schedPointInTime')}
                        </div>
                        {/* Per-machine plan quota at a glance — the same card the
                            Status tab renders, so the two surfaces cannot drift. */}
                        {schedQuotaOpen && (
                            <div className="flex flex-col gap-2">
                                {collectMachineQuotaGroups(status).map(machine => (
                                    <MeshMachineQuotaCard key={machine.machineKey} machine={machine} />
                                ))}
                                {collectMachineQuotaGroups(status).length === 0 && (
                                    <div className="py-2 text-3xs text-text-muted">{t('mesh.blueprint.schedNoNodes')}</div>
                                )}
                            </div>
                        )}
                        {!schedQuotaOpen && (() => {
                            const previewNodes = schedMatrix[schedDetailDifficulty] ?? []
                            // Slots/capacity/quota are MACHINE properties — a machine's
                            // worktrees share one slot set, so listing every worktree
                            // repeated identical rows. One representative per machine
                            // (scheduler order); the winner row is annotated with the
                            // TARGET checkout (⎇ branch / base) the task would land on.
                            interface MachineGroup { machineKey: string; machineLabel: string; representative: RoutePreviewNode; targetNodeLabel: string }
                            const machineGroups: MachineGroup[] = []
                            const seenMachines = new Set<string>()
                            for (const previewNode of previewNodes) {
                                const meta = nodeMetaById.get(previewNode.nodeId)
                                const machineKey = meta?.machineKey ?? previewNode.nodeId
                                if (seenMachines.has(machineKey)) continue
                                seenMachines.add(machineKey)
                                machineGroups.push({
                                    machineKey,
                                    machineLabel: meta?.machineLabel ?? previewNode.nodeId.slice(0, 12),
                                    representative: previewNode,
                                    targetNodeLabel: meta?.isWorktree ? meta.nodeLabel : '',
                                })
                            }
                            interface DetailRow {
                                nodeLabel: string
                                slot: { providerType: string; model?: string }
                                score?: RoutePreviewSlotScore
                                quotaOutcome?: string
                                quotaBonus?: number
                                quotaZeroReason?: string
                                status: 'next' | 'waiting' | 'full' | 'floor'
                                target?: string
                            }
                            const rows: DetailRow[] = []
                            machineGroups.forEach((group, machineIndex) => {
                                const node = group.representative
                                const quotaByProvider = new Map((node.quotaDiagnostics ?? []).map(q => [q.providerType, q]))
                                const ranked = node.stages?.fitness ?? []
                                ranked.forEach((score, slotIndex) => {
                                    const quota = quotaByProvider.get(score.providerType)
                                    const isNext = machineIndex === 0 && slotIndex === 0
                                    rows.push({
                                        nodeLabel: group.machineLabel,
                                        slot: score,
                                        score,
                                        quotaOutcome: quota?.gate?.outcome,
                                        quotaBonus: score.quotaBonus ?? quota?.bonus?.value,
                                        ...(quota?.bonus?.zeroReason ? { quotaZeroReason: quota.bonus.zeroReason } : {}),
                                        status: isNext ? 'next'
                                            : score.capacityAvailable === false ? 'full' : 'waiting',
                                        ...(isNext && group.targetNodeLabel ? { target: group.targetNodeLabel } : {}),
                                    })
                                })
                                for (const slot of node.stages?.difficultyFloor?.excludedSlots ?? []) {
                                    rows.push({ nodeLabel: group.machineLabel, slot, status: 'floor' })
                                }
                            })
                            const statusBadge = (row: DetailRow) => {
                                switch (row.status) {
                                    case 'next': return <span className="rounded bg-green-500/15 px-1.5 py-px text-3xs font-semibold text-green-500" title={t('mesh.blueprint.schedNextTitle')}>{t('mesh.blueprint.schedNext')}</span>
                                    case 'full': return <span className="rounded bg-amber-500/15 px-1.5 py-px text-3xs text-amber-500">{t('mesh.blueprint.schedFull')}</span>
                                    case 'floor': return <span className="rounded bg-bg-glass px-1.5 py-px text-3xs text-text-muted">{t('mesh.blueprint.schedFloorExcluded')}</span>
                                    default: return <span className="rounded bg-bg-glass px-1.5 py-px text-3xs text-text-secondary">{t('mesh.blueprint.schedWaiting')}</span>
                                }
                            }
                            const capacityLabel = (row: DetailRow) => {
                                const capacity = row.score?.capacity
                                if (!capacity) return '—'
                                const cap = capacity.slotCap ?? capacity.providerCap
                                if (capacity.available !== false) return cap != null ? `${t('mesh.blueprint.schedCapFree')} · ${cap}` : t('mesh.blueprint.schedCapFree')
                                return cap != null ? `${t('mesh.blueprint.schedFull')} (${cap})` : t('mesh.blueprint.schedFull')
                            }
                            if (rows.length === 0) return <div className="py-2 text-3xs text-text-muted">{t('mesh.blueprint.schedNoNodes')}</div>
                            const showNodeCol = machineGroups.length > 1
                            const scoreSummary = (row: DetailRow): string => {
                                if (!row.score) return '—'
                                const parts = [
                                    `${t('mesh.blueprint.schedColScore')} ${row.score.total ?? '—'}`,
                                    `base ${row.score.base ?? '—'}`,
                                    `difficulty ${row.score.difficulty ?? '—'}`,
                                    `tags ${row.score.tags ?? '—'}`,
                                    // Zero bonus names its cause (stale / no-data / …) — an
                                    // unexplained "+0" is exactly the question it provoked.
                                    `${t('mesh.blueprint.schedColQuota')} ${row.quotaBonus != null ? `+${row.quotaBonus}` : '—'}${row.quotaBonus === 0 && row.quotaZeroReason ? ` (${row.quotaZeroReason})` : ''}`,
                                ]
                                return parts.join(' · ')
                            }
                            return (
                                <div className="overflow-x-auto">
                                <table className="w-full min-w-[300px] border-collapse text-left">
                                    <thead>
                                        <tr className="text-4xs uppercase tracking-wide text-text-muted">
                                            {showNodeCol && <th className="py-1 pr-2 font-medium">{t('mesh.blueprint.schedColMachine')}</th>}
                                            <th className="py-1 pr-2 font-medium">{t('mesh.blueprint.schedColSlot')}</th>
                                            <th className="py-1 pr-2 font-medium">{t('mesh.blueprint.schedColParallel')}</th>
                                            <th className="py-1 font-medium">{t('mesh.blueprint.schedColStatus')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((row, index) => {
                                            const rowKey = `${schedDetailDifficulty}:${index}`
                                            const expanded = schedExpandedRow === rowKey
                                            const quotaGated = row.quotaOutcome === 'hard-block' || row.quotaOutcome === 'skip'
                                            return (
                                                <Fragment key={rowKey}>
                                                    <tr
                                                        className={`cursor-pointer border-t ${meshTheme.isDark ? 'border-white/5' : 'border-slate-100'} ${row.status === 'next' ? 'bg-green-500/5' : row.status === 'floor' ? 'opacity-55' : ''}`}
                                                        title={scoreSummary(row)}
                                                        onClick={() => setSchedExpandedRow(expanded ? null : rowKey)}
                                                    >
                                                        {showNodeCol && <td className="max-w-[130px] truncate py-1 pr-2 text-3xs text-text-muted" title={row.nodeLabel}>{row.nodeLabel}</td>}
                                                        <td className="py-1 pr-2 text-2xs text-text-primary">{slotLabel(row.slot)}</td>
                                                        <td className="py-1 pr-2 text-3xs text-text-secondary">{capacityLabel(row)}</td>
                                                        <td className="py-1">
                                                            <span className="flex items-center gap-1">
                                                                {statusBadge(row)}
                                                                {quotaGated && <span className="rounded bg-red-500/10 px-1.5 py-px text-3xs text-red-400" title={row.quotaOutcome}>{t('mesh.blueprint.schedQuotaGated')}</span>}
                                                                {row.target && <span className="text-3xs text-text-muted" title={t('mesh.blueprint.schedTargetWorktreeTitle')}>{row.target}</span>}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                    {expanded && (
                                                        <tr className={meshTheme.isDark ? 'border-t border-white/5' : 'border-t border-slate-100'}>
                                                            <td colSpan={showNodeCol ? 4 : 3} className="py-1 pl-2 text-3xs text-text-muted">
                                                                {scoreSummary(row)}
                                                            </td>
                                                        </tr>
                                                    )}
                                                </Fragment>
                                            )
                                        })}
                                    </tbody>
                                </table>
                                </div>
                            )
                        })()}
                    </div>
                )}
            </div>
            {detail && (
                <MeshOverviewDetailModal
                    meshTheme={meshTheme}
                    detail={detail}
                    onClose={() => setDetail(null)}
                    daemonId={daemonId}
                    meshId={meshId}
                    sendDaemonCommand={sendDaemonCommand}
                    queueTasks={tasks}
                    onOpenTask={task => setDetail({ kind: 'queue', task })}
                    missionTitles={missionTitles}
                    onOpenMission={openMission}
                    resolveNodeLabel={nodeId => (nodeId ? (nodeMetaById.get(nodeId)?.nodeLabel ?? nodeId) : '')}
                />
            )}
        </div>
    )
}
