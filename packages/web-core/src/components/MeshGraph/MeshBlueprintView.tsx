/**
 * MeshBlueprintView — the "설계도면" (blueprint) tab of the mesh observability
 * surface. One place to answer: what orchestration graphs exist in this mesh,
 * which gates are waiting on a human, what unlocks what when something
 * completes, and where would the scheduler route new work.
 *
 * Composition:
 *  - graph picker: the live work queue (MeshTasksView, the pre-existing
 *    dependsOn DAG) plus every persistent graph from mesh_graph_overview
 *  - ONE fused canvas (owner call 2026-08-25): every persistent graph's
 *    gates and planned steps render INSIDE the live-queue DAG — materialized
 *    steps fuse onto their live task cards, gates sit between them as ⛩
 *    nodes with the graph's edges. Clicking a gate opens a read-only detail
 *    panel; gate VERBS are deliberately NOT exposed (owner decision
 *    2026-08-24) — acting on a gate is done by instructing the coordinator,
 *    whose MCP tools (mesh_gate_claim/release/abandon) are the acting surface.
 *  - scheduling preview: mesh_route_preview (read-only) shows the per-node
 *    predicted routing winner for a hypothetical task, so slot pressure is
 *    visible on the same screen as the plan. The generic forecast is
 *    explicitly UNPINNED; a task pinned to a node (targetNodeId) gets its
 *    own pinned preview, rendered as a distinct 📌 chip on its card.
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
import MeshTaskDagView from './MeshTaskDagView'
import { MeshOverviewDetailModal } from './MeshOverviewCards'
import {
    BLUEPRINT_GRAPH_INITIAL_LIMIT,
    BLUEPRINT_GRAPH_LOAD_MORE_STEP,
    ROUTE_PREVIEW_DIFFICULTIES,
    buildBlueprintGraphOverviewArgs,
    buildPinnedSlotLabels,
    buildRoutePreviewRequests,
    getBlueprintGraphPagination,
    nextBlueprintGraphLimit,
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
    // Default ON (owner call 2026-08-25): finished graphs are part of the
    // record the blueprint tells — their settled gates/steps render muted, so
    // showing them costs little and hiding them made the canvas read empty.
    const [includeTerminal, setIncludeTerminal] = useState(true)
    const [graphLimit, setGraphLimit] = useState(BLUEPRINT_GRAPH_INITIAL_LIMIT)
    /** Shared overview detail modal — task cards and ⛩ gate nodes both open
     *  here (owner call 2026-08-25: gates present like tasks, not as a footer
     *  panel). */
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
    /** Picker-row host for the live queue's stats chips — MeshTaskDagView
     *  portals them here so they share the row with the graph picker instead
     *  of floating over the canvas's top edge. */
    const [statsHost, setStatsHost] = useState<HTMLDivElement | null>(null)

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
    /** nodeId → what to print on a card that RAN there: checkout · machine. */
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

    const [focusMission, setFocusMission] = useState<{ missionId: string; token: number } | null>(null)
    const openMission = useCallback((missionId: string) => {
        const mission = ((status as RepoMeshStatus).missions ?? []).find(candidate => candidate.id === missionId)
        if (mission) setDetail({ kind: 'mission', mission })
    }, [status])

    // missionId → title, so mission chips on the canvas read as names.
    const missionTitles = useMemo(() => {
        const map: Record<string, string> = {}
        for (const mission of (status as { missions?: Array<{ id?: string; title?: string }> }).missions ?? []) {
            if (mission?.id && typeof mission.title === 'string' && mission.title.trim()) map[mission.id] = mission.title.trim()
        }
        return map
    }, [status])

    const refreshGraphs = useCallback(async () => {
        if (!canCommand) return
        setGraphsLoading(true)
        setGraphsError('')
        try {
            const raw = await sendDaemonCommand!(
                daemonId!,
                'mesh_graph_overview',
                buildBlueprintGraphOverviewArgs(meshId, includeTerminal, graphLimit),
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
    }, [canCommand, daemonId, graphLimit, includeTerminal, meshId, sendDaemonCommand])

    useEffect(() => { void refreshGraphs() }, [refreshGraphs])
    // Drop a gate detail whose graph left the list (e.g. terminal filter flip).
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

    // difficulty → next-match slot label, threaded onto the live-queue DAG cards.
    // This is the GENERIC forecast — a hypothetical dispatch with NO pin; the
    // overlay labels that premise (schedUnpinned) so it can't be mistaken for
    // a pinned task's actual route.
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

    // taskId → predicted slot on the task's PINNED node — the forecast that
    // actually applies to a pinned task, rendered distinctly on its card.
    const pinnedSlots = useMemo(() => {
        if (!schedMatrix) return undefined
        return buildPinnedSlotLabels(tasks, schedMatrix, previewNodeSuffix)
    }, [schedMatrix, tasks, previewNodeSuffix])

    // Owner call 2026-08-24: the blueprint canvas renders as LARGE as the
    // dialog allows — no content-count tiers (unlike topology's
    // getGraphMinHeightClass).
    //
    // It must claim that space WITHOUT a height floor of its own (2026-09-02).
    // Two floors were tried and both clipped the graph, because this element
    // sits in a padded flex parent and `overflow-hidden` turns any excess into
    // a hard cut rather than a scroll:
    //   - `min-h-[min(760px,66dvh)]` measured the VIEWPORT, so in a dialog
    //     shorter than 66dvh it overflowed by hundreds of px (18 of 28 nodes
    //     rendered outside the clip box, unreachable — the canvas pans, it
    //     does not scroll). Adding `max-h-full` does not help: CSS resolves
    //     `min-height` after `max-height`, so the floor just wins.
    //   - `min-h-[320px]` matched the parent's own floor, so the element came
    //     out 320px + its padding and spilled by exactly that padding (39px) —
    //     the "sliced off at the bottom" edge the owner spotted.
    // `flex-1 min-h-0` takes exactly what the parent offers and no more, which
    // is what "as large as the dialog allows" actually means.
    const bodyMinHeightClass = 'flex-1 min-h-0'
    const graphPagination = getBlueprintGraphPagination(graphs.length, totalGraphCount, graphLimit)

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5">
            {/* ── Header row — ONE canvas now (owner call 2026-08-25): gates and
                planned steps of every orchestration graph fuse INTO the live
                queue instead of hiding behind per-graph picker chips, so the
                row carries only the queue stats, the terminal-graph toggle and
                refresh.

                `flex-wrap` (2026-09-03, owner-reported narrow-viewport bug):
                the task stats cluster (portaled from MeshTaskDagView) scrolls
                horizontally and can shrink, but the graphs cluster is
                `shrink-0` with its own load-more button — with no wrap, a
                narrow viewport had nowhere to put that button's text except
                to squeeze it, and un-nowrapped text squeezed below its own
                natural width wraps letter-by-letter ("Load 50 more" →
                "Loa"/"50"/"mor" stacked), which also collapsed its clickable
                width to near zero. Wrapping lets the graphs cluster + toggle
                + refresh drop to their own line instead of being crushed. ── */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {/* `w-max` (2026-09-03): the chips inside are `shrink-0`,
                        but this host was `min-w-0` inside the scroller — a
                        min-w-0 flex child adopts the SCROLLER's width, so the
                        row had no room for the last chip and `overflow-x-auto`
                        clipped it mid-word ("1 assigned" → "1 as") instead of
                        becoming scrollable. `w-max` sizes the host to its
                        content, which is what makes the row actually scroll. */}
                    <div ref={setStatsHost} className="flex w-max items-center gap-1.5" />
                </div>
                {includeTerminal && !graphsLoading && (
                    <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-3xs text-text-muted">
                        <span>{t('repoMesh.graphs.shown', { count: graphs.length })}</span>
                        {graphPagination.canLoadMore && (
                            <button
                                type="button"
                                onClick={() => setGraphLimit(nextBlueprintGraphLimit)}
                                className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium transition-colors ${meshTheme.isDark
                                    ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                                    : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                            >
                                {t('repoMesh.graphs.loadMore', {
                                    count: Math.min(BLUEPRINT_GRAPH_LOAD_MORE_STEP, graphPagination.hiddenCount),
                                })}
                            </button>
                        )}
                        {graphPagination.atServerLimit && (
                            <span title={t('repoMesh.graphs.serverLimitReached')}>
                                · {t('repoMesh.graphs.serverLimitHidden', { count: graphPagination.hiddenCount })}
                            </span>
                        )}
                    </div>
                )}
                <label className="hidden sm:flex shrink-0 items-center gap-1.5 text-2xs text-text-muted cursor-pointer">
                    <input type="checkbox" checked={includeTerminal} onChange={e => {
                        const checked = e.target.checked
                        setIncludeTerminal(checked)
                        if (checked) setGraphLimit(BLUEPRINT_GRAPH_INITIAL_LIMIT)
                    }} />
                    {t('repoMesh.graphs.includeTerminal')}
                </label>
                <button type="button" className="btn btn-sm btn-secondary flex shrink-0 items-center" disabled={graphsLoading || !canCommand} onClick={() => void refreshGraphs()} title={t('repoMesh.graphs.refresh')} aria-label={t('repoMesh.graphs.refresh')}>
                    <IconRefresh size={13} />
                </button>
            </div>

            {graphsError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{graphsError}</div>}

            {/* ── Body — same height floors as the topology canvas (its
                getGraphMinHeightClass tiers): the blueprint pane used to sit
                visibly shorter than 구성, and both are pan/zoom canvases so
                they share the "grow with content, cap by viewport, never
                scroll the dialog" rule. ── */}
            <div className={`${meshTheme.blueprintShellClass} ${bodyMinHeightClass}`}>
                {/* THE blueprint: live queue cards + every graph's gates and
                    planned steps on one canvas (fusion happens inside
                    MeshTaskDagView). Terminal graphs join via the toggle. */}
                <div className="absolute inset-0">
                    <MeshTaskDagView
                        tasks={tasks}
                        nodeLabels={nodeLabels}
                        emptyMessage={emptyMessage}
                        predictedSlots={predictedSlots}
                        pinnedSlots={pinnedSlots}
                        initialTerminalLimit={8}
                        onTaskOpen={task => setDetail({ kind: 'queue', task })}
                        statsContainer={statsHost}
                        graphs={graphs}
                        onGateOpen={(graph, nodeId, gate) => setDetail({ kind: 'gate', graph, nodeId, gate: gate ?? null })}
                        missionTitles={missionTitles}
                        onMissionOpen={openMission}
                        focusMission={focusMission}
                    />
                </div>

                {/* ── Scheduling forecast — a vertical 4-row overlay on the LEFT of
                    the canvas (owner call 2026-08-24: overlaying expresses more than
                    an in-flow row, and it returns that row's height to the graph).
                    Clicking a difficulty opens the per-machine detail right below.
                    Offset below the live queue's in-flow stats row.

                    HIDDEN on narrow viewports (2026-09-02): at 375px the overlay
                    is as tall as the canvas itself and sits on top of every node,
                    so the forecast — the least urgent thing here — was covering
                    the graph it annotates. The same numbers stay reachable on the
                    Status tab. ── */}
                {predictedSlots && (
                    <div className="pointer-events-none absolute left-2 top-2 z-10 hidden max-h-[calc(100%-3rem)] flex-col items-start gap-1 sm:flex">
                        <div className={`pointer-events-auto flex flex-col rounded-md border text-3xs leading-4 ${meshTheme.isDark
                            ? 'border-white/10 bg-slate-950/85 text-slate-300'
                            : 'border-slate-200 bg-white/95 text-slate-600'}`}
                        >
                            {/* Premise of the generic forecast: a hypothetical
                                dispatch with NO pin. Pinned tasks carry their
                                own 📌 forecast on their cards. */}
                            <div className="px-2 pt-1 text-4xs uppercase tracking-wide opacity-60" title={t('meshGraph.blueprint.schedUnpinnedTitle')}>
                                {t('meshGraph.blueprint.schedUnpinned')}
                            </div>
                            {(['easy', 'medium', 'difficult', 'freeform'] as const).map(difficulty => (
                                <button
                                    key={difficulty}
                                    type="button"
                                    onClick={() => {
                                        setSchedDetailDifficulty(difficulty)
                                        setSchedDetailOpen(open => !open || schedDetailDifficulty !== difficulty)
                                    }}
                                    className={`flex items-center gap-1.5 px-2 py-0.5 text-left transition-colors ${meshTheme.isDark ? 'hover:bg-slate-900' : 'hover:bg-slate-50'} ${schedDetailOpen && schedDetailDifficulty === difficulty ? (meshTheme.isDark ? 'bg-white/[0.06]' : 'bg-slate-100') : ''}`}
                                    title={t('meshGraph.blueprint.scheduling')}
                                >
                                    <span className="w-14 uppercase tracking-wide text-4xs opacity-60">{difficulty}</span>
                                    <span className="text-green-500">→ {predictedSlots[difficulty] ?? '—'}</span>
                                </button>
                            ))}
                        </div>
                        {schedDetailOpen && schedMatrix && (
                            <div className={`pointer-events-auto max-h-[45dvh] w-[min(620px,80vw)] overflow-y-auto rounded-lg border p-2.5 text-2xs shadow-md ${meshTheme.isDark ? 'border-white/10 bg-slate-950/98' : 'border-slate-300 bg-white'}`}>
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
                                        title={t('meshGraph.blueprint.schedQuotaButtonTitle')}
                                        onClick={() => setSchedQuotaOpen(open => !open)}>
                                        {t('meshGraph.blueprint.schedQuotaButton')}
                                    </button>
                                    {schedObservedAt && <span className="ml-auto text-4xs text-text-muted">{t('meshGraph.blueprint.schedObservedAt', { time: schedObservedAt.slice(11, 19) })}</span>}
                                    <label className="flex items-center gap-1 text-3xs text-text-muted cursor-pointer">
                                        <input type="checkbox" checked={schedReadonly} onChange={e => setSchedReadonly(e.target.checked)} />
                                        read-only
                                    </label>
                                    <button type="button" className="btn btn-sm btn-secondary" disabled={schedLoading || !canCommand} onClick={() => void runRoutePreview()}>
                                        <IconRefresh size={11} />
                                    </button>
                                    <button type="button" className="btn btn-sm btn-secondary" aria-label="Close scheduling detail" onClick={() => setSchedDetailOpen(false)}>
                                        ✕
                                    </button>
                                </div>
                                {schedError && <div className="text-3xs text-red-400">{schedError}</div>}
                                {/* Per-machine plan quota at a glance — the same card the
                                    Status tab renders, so the two surfaces cannot drift. */}
                                {schedQuotaOpen && (
                                    <div className="flex flex-col gap-2">
                                        {collectMachineQuotaGroups(status).map(machine => (
                                            <MeshMachineQuotaCard key={machine.machineKey} machine={machine} />
                                        ))}
                                        {collectMachineQuotaGroups(status).length === 0 && (
                                            <div className="py-2 text-3xs text-text-muted">{t('meshGraph.blueprint.schedNoNodes')}</div>
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
                                            case 'next': return <span className="rounded bg-green-500/15 px-1.5 py-px text-3xs font-semibold text-green-500" title={t('meshGraph.blueprint.schedNextTitle')}>{t('meshGraph.blueprint.schedNext')}</span>
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
                                    const showNodeCol = machineGroups.length > 1
                                    const scoreSummary = (row: DetailRow): string => {
                                        if (!row.score) return '—'
                                        const parts = [
                                            `${t('meshGraph.blueprint.schedColScore')} ${row.score.total ?? '—'}`,
                                            `base ${row.score.base ?? '—'}`,
                                            `difficulty ${row.score.difficulty ?? '—'}`,
                                            `tags ${row.score.tags ?? '—'}`,
                                            // Zero bonus names its cause (stale / no-data / …) — an
                                            // unexplained "+0" is exactly the question it provoked.
                                            `${t('meshGraph.blueprint.schedColQuota')} ${row.quotaBonus != null ? `+${row.quotaBonus}` : '—'}${row.quotaBonus === 0 && row.quotaZeroReason ? ` (${row.quotaZeroReason})` : ''}`,
                                        ]
                                        return parts.join(' · ')
                                    }
                                    return (
                                        <div className="overflow-x-auto">
                                        <table className="w-full min-w-[300px] border-collapse text-left">
                                            <thead>
                                                <tr className="text-4xs uppercase tracking-wide text-text-muted">
                                                    {showNodeCol && <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColMachine')}</th>}
                                                    <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColSlot')}</th>
                                                    <th className="py-1 pr-2 font-medium">{t('meshGraph.blueprint.schedColParallel')}</th>
                                                    <th className="py-1 font-medium">{t('meshGraph.blueprint.schedColStatus')}</th>
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
                                                                        {quotaGated && <span className="rounded bg-red-500/10 px-1.5 py-px text-3xs text-red-400" title={row.quotaOutcome}>{t('meshGraph.blueprint.schedQuotaGated')}</span>}
                                                                        {row.target && <span className="text-3xs text-text-muted" title={t('meshGraph.blueprint.schedTargetWorktreeTitle')}>{row.target}</span>}
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
                    onShowMission={missionId => {
                        setDetail(null)
                        setFocusMission({ missionId, token: Date.now() })
                    }}
                    resolveNodeLabel={nodeId => (nodeId ? (nodeMetaById.get(nodeId)?.nodeLabel ?? nodeId) : '')}
                />
            )}
        </div>
    )
}
