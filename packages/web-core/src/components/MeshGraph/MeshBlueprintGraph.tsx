/**
 * MeshBlueprintGraph — the Blueprint tab's GRAPH view (owner request
 * 2026-09-26: "I want to see Blueprint as a graph"). The List view stays the
 * 0.1-second read; this view answers "what unlocks what" for both dependency
 * systems at once — queue `depends_on` chains and persistent orchestration
 * graphs with their coordinator gates (blueprintGraphModel).
 *
 *  - lanes: one per mission (else graph, else chain anchor, else ad-hoc),
 *    each laid out with ELK layered left → right (blueprintGraphLayout)
 *  - "Active only" hides lanes with nothing left to do; finished lanes that
 *    stay visible start collapsed; live lanes fold ≥ 3 completed tasks into
 *    one "N completed" chip (both toggleable per lane)
 *  - task click → the same detail modal the list rows open; gate click →
 *    a panel with the SAME Release / Abandon / Extend 24h actions
 *    (useBlueprintGateCommands + GateActionsPanel)
 *  - no polling of its own: it redraws from the props Blueprint already
 *    refreshes. ELK re-runs only when the structure key changes; the view
 *    fits once per lane-set change, never on a status poll.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Background,
    BackgroundVariant,
    Controls,
    MarkerType,
    ReactFlow,
    useReactFlow,
    useStore,
    type Edge,
} from '@xyflow/react'
import type { MeshGraphGateView, MeshGraphView, RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import type { MeshGraphTheme } from './meshGraphTheme'
import {
    applyBlueprintGraphView,
    blueprintGraphLaneKey,
    blueprintGraphStructureKey,
    buildBlueprintGraphModel,
    gateDeadlineReading,
    type BlueprintGraphEdge,
    type BlueprintGraphGateNode,
    type BlueprintGraphLane,
    type BlueprintGraphTaskNode,
} from './blueprintGraphModel'
import { BLUEPRINT_GRAPH_SIZES, layoutBlueprintGraph, narrowPaneViewport, type BlueprintGraphLaneRect, type BlueprintGraphLayout } from './blueprintGraphLayout'
import { blueprintGraphNodeTypes, GATE_TONE_STYLE, type BlueprintFlowNode, type GateNodeData, type TaskNodeData } from './BlueprintGraphNodes'
import { GateActionsPanel } from './MeshBlueprintRow'
import { useBlueprintGateCommands } from './useBlueprintGateCommands'
import { formatBlueprintAge } from './blueprintViewModel'

/** Edge stroke per reading; dashes carry the KIND (gate) independent of colour. */
const EDGE_COLORS = {
    satisfied: { dark: '#34d399', light: '#059669' },
    waiting: { dark: '#94a3b8', light: '#64748b' },
    running: { dark: '#38bdf8', light: '#0284c7' },
    dead: { dark: '#f87171', light: '#dc2626' },
    inactive: { dark: '#475569', light: '#cbd5e1' },
} as const

type EdgeTone = keyof typeof EDGE_COLORS

function edgeTone(edge: BlueprintGraphEdge): EdgeTone {
    if (edge.state === 'dead') return 'dead'
    if (edge.state === 'inactive') return 'inactive'
    if (edge.animated) return 'running'
    return edge.state === 'satisfied' ? 'satisfied' : 'waiting'
}

const EMPTY_LANE_RECTS: BlueprintGraphLaneRect[] = []

/** Tallest stack of lanes the first fit tries to show at a readable zoom. */
const FIT_FOCUS_MAX_HEIGHT = 1100

function ViewportFitter({ fitKey, focusNodeIds, laneRects }: { fitKey: string | null; focusNodeIds: string[]; laneRects: BlueprintGraphLaneRect[] }) {
    const reactFlow = useReactFlow()
    const paneWidth = useStore(state => state.width)
    const focusRef = useRef(focusNodeIds)
    focusRef.current = focusNodeIds
    const narrowRef = useRef<{ paneWidth: number; laneRects: BlueprintGraphLaneRect[] }>({ paneWidth, laneRects })
    narrowRef.current = { paneWidth, laneRects }
    const lastKey = useRef<string | null>(null)
    useEffect(() => {
        // No useNodesInitialized gate: with onlyRenderVisibleElements an
        // off-screen node is never measured, so that flag never turns true on
        // a tall board (live-found: the first fit never ran). Every flow node
        // carries explicit width/height instead, so fitView needs no DOM.
        if (!fitKey || lastKey.current === fitKey) return
        lastKey.current = fitKey
        // Two passes for ONE lane-set change: the first frame fits what is
        // measured; the settle pass re-fits once nodes added in the same
        // commit (e.g. graph lanes arriving after the queue) have dimensions.
        // Nothing else ever calls fitView, so status polls never move the view.
        // Focus the TOP lanes (live, newest first) instead of shrinking a tall
        // board to unreadable text; the rest is one pan away.
        const fit = () => {
            // Phones: fit each lane's full WIDTH (lanes stack vertically) — a
            // plain fit at zoom 1 showed one card per lane with edges cut off.
            const narrow = narrowPaneViewport(narrowRef.current.paneWidth, narrowRef.current.laneRects)
            if (narrow) { void reactFlow.setViewport(narrow, { duration: 220 }); return }
            const nodes = focusRef.current.length > 0 ? focusRef.current.map(id => ({ id })) : undefined
            void reactFlow.fitView({ ...(nodes ? { nodes } : {}), padding: 0.08, maxZoom: 1, duration: 220 })
        }
        const frame = requestAnimationFrame(fit)
        const settle = window.setTimeout(fit, 260)
        return () => { cancelAnimationFrame(frame); window.clearTimeout(settle) }
    }, [fitKey, reactFlow])
    return null
}

export default function MeshBlueprintGraph({ tasks, status, graphs, meshTheme, nodeLabels, missionTitles, emptyMessage, onTaskOpen, onGateOpen, onMissionOpen, headerExtras, daemonId, meshId, sendDaemonCommand, onGatesChanged }: {
    tasks: RepoMeshQueueTask[]
    status: RepoMeshStatus
    graphs: MeshGraphView[]
    meshTheme: MeshGraphTheme
    nodeLabels?: Record<string, string>
    missionTitles?: Record<string, string>
    emptyMessage?: string
    onTaskOpen: (task: RepoMeshQueueTask) => void
    onGateOpen: (graph: MeshGraphView, nodeId: string, gate?: MeshGraphGateView) => void
    onMissionOpen?: (missionId: string) => void
    headerExtras?: React.ReactNode
    daemonId?: string | null
    meshId?: string
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    onGatesChanged?: () => void
}) {
    const { t } = useTranslation('common')
    const [activeOnly, setActiveOnly] = useState(true)
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
    const [folded, setFolded] = useState<Record<string, boolean>>({})
    const [selectedGateId, setSelectedGateId] = useState<string | null>(null)
    const gateCommands = useBlueprintGateCommands({ daemonId, meshId, sendDaemonCommand, onGatesChanged })

    const [nowMs, setNowMs] = useState(() => Date.now())
    useEffect(() => {
        const timer = window.setInterval(() => { if (!document.hidden) setNowMs(Date.now()) }, 30_000)
        return () => window.clearInterval(timer)
    }, [])

    const model = useMemo(() => buildBlueprintGraphModel(tasks, graphs, status, missionTitles), [tasks, graphs, status, missionTitles])
    const view = useMemo(() => applyBlueprintGraphView(model, { activeOnly, collapsed, folded }), [model, activeOnly, collapsed, folded])
    const structureKey = useMemo(() => blueprintGraphStructureKey(view), [view])
    const laneKey = useMemo(() => blueprintGraphLaneKey(view), [view])

    /* ELK runs only when the structure key changes. The latest view rides a
     * ref so a status-only poll (same key, new object) never re-triggers it. */
    const [layout, setLayout] = useState<{ key: string; value: BlueprintGraphLayout } | null>(null)
    const [layoutError, setLayoutError] = useState('')
    const viewRef = useRef(view)
    viewRef.current = view
    useEffect(() => {
        let cancelled = false
        layoutBlueprintGraph(viewRef.current)
            .then(value => { if (!cancelled) { setLayout({ key: structureKey, value }); setLayoutError('') } })
            .catch((error: unknown) => { if (!cancelled) setLayoutError(error instanceof Error ? error.message : String(error)) })
        return () => { cancelled = true }
    }, [structureKey])
    const layoutReady = layout?.key === structureKey
    const fitFocusNodeIds = useMemo(() => {
        const ids: string[] = []
        let height = 0
        for (const rect of layout?.value.lanes ?? []) {
            if (ids.length > 0 && height + rect.height > FIT_FOCUS_MAX_HEIGHT) break
            ids.push(`lane:${rect.key}`)
            height += rect.height
        }
        return ids
    }, [layout])

    const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks])
    const graphById = useMemo(() => new Map(graphs.map(graph => [graph.graphId, graph])), [graphs])

    const toggleCollapsed = useCallback((lane: BlueprintGraphLane) => {
        setCollapsed(current => ({ ...current, [lane.group.key]: !lane.collapsed }))
    }, [])
    const toggleFolded = useCallback((lane: BlueprintGraphLane) => {
        setFolded(current => ({ ...current, [lane.group.key]: !lane.folded }))
    }, [])

    const laneTitle = useCallback((lane: BlueprintGraphLane): { title: string; tooltip?: string; open?: () => void } => {
        const group = lane.group
        if (group.kind === 'mission' && group.missionId) {
            const missionId = group.missionId
            return {
                title: `⚑ ${group.title || missionId.slice(0, 10)}`,
                tooltip: missionId,
                ...(onMissionOpen ? { open: () => onMissionOpen(missionId) } : {}),
            }
        }
        if (group.kind === 'chain') {
            const anchor = group.anchorTaskId ? taskById.get(group.anchorTaskId) : undefined
            return {
                title: `⛓ ${t('mesh.blueprint.list.chainGroup', { title: group.title })}`,
                tooltip: group.anchorTaskId,
                ...(anchor ? { open: () => onTaskOpen(anchor) } : {}),
            }
        }
        if (group.kind === 'graph' && group.graphId) {
            return { title: t('mesh.blueprint.graph.laneGraph', { id: group.graphId.slice(0, 8) }), tooltip: group.graphId }
        }
        return { title: t('mesh.blueprint.graph.laneAdhoc') }
    }, [onMissionOpen, onTaskOpen, t, taskById])

    const taskTooltip = useCallback((node: BlueprintGraphTaskNode): string => {
        const lines = [node.fullTitle, '']
        if (node.taskId) lines.push(t('mesh.blueprint.graph.tooltipTask', { id: node.taskId }))
        if (node.missionId) lines.push(t('mesh.blueprint.graph.tooltipMission', { id: node.missionId }))
        if (node.graphId) lines.push(t('mesh.blueprint.graph.tooltipGraph', { id: node.graphId, ref: node.ref ?? node.graphNodeId ?? '' }))
        lines.push(t('mesh.blueprint.graph.tooltipStatus', { status: node.rawStatus }))
        if (node.deadReason) lines.push(t(node.deadReason === 'direct' ? 'mesh.blueprint.graph.deadDirect' : 'mesh.blueprint.graph.deadTransitive'))
        if (node.missingDeps.length > 0) lines.push(`${t('mesh.taskDag.missingDeps', { count: node.missingDeps.length })}: ${node.missingDeps.join(', ')}`)
        return lines.join('\n')
    }, [t])
    const gateTooltip = useCallback((node: BlueprintGraphGateNode): string => {
        const lines = [node.ref, '']
        if (node.gate?.gateId) lines.push(t('mesh.blueprint.graph.tooltipGate', { id: node.gate.gateId }))
        lines.push(t('mesh.blueprint.graph.tooltipGraph', { id: node.graphId, ref: node.gateNodeId }))
        lines.push(t('mesh.blueprint.graph.tooltipStatus', { status: node.state }))
        if (node.gate?.instructions) lines.push('', node.gate.instructions)
        return lines.join('\n')
    }, [t])

    const flowNodes = useMemo<BlueprintFlowNode[]>(() => {
        if (!layout) return []
        const { positions, lanes: laneRects } = layout.value
        const out: BlueprintFlowNode[] = []
        const rectByKey = new Map(laneRects.map(rect => [rect.key, rect]))
        for (const lane of view.lanes) {
            const rect = rectByKey.get(lane.group.key)
            if (!rect) continue
            const heading = laneTitle(lane)
            out.push({
                id: `lane:${lane.group.key}`,
                type: 'bpLane',
                position: { x: rect.x, y: rect.y },
                width: rect.width,
                height: rect.height,
                zIndex: -1,
                selectable: false,
                focusable: false,
                draggable: false,
                // The backdrop must not eat pans or edge hovers — only its header buttons are live.
                style: { pointerEvents: 'none' },
                data: {
                    lane,
                    theme: meshTheme,
                    title: heading.title,
                    ...(heading.tooltip ? { titleTooltip: heading.tooltip } : {}),
                    width: rect.width,
                    height: rect.height,
                    ...(heading.open ? { onOpen: heading.open } : {}),
                    onToggleCollapsed: () => toggleCollapsed(lane),
                    onToggleFolded: () => toggleFolded(lane),
                },
            })
        }
        for (const node of view.nodes) {
            const position = positions.get(node.id)
            if (!position) continue
            if (node.kind === 'task') {
                const label = node.assignedNodeId ? nodeLabels?.[node.assignedNodeId] ?? node.assignedNodeId.slice(0, 12) : undefined
                out.push({ id: node.id, type: 'bpTask', position, ...BLUEPRINT_GRAPH_SIZES.task, draggable: false, data: { node, theme: meshTheme, nowMs, ...(label ? { nodeLabel: label } : {}), tooltip: taskTooltip(node) } })
            } else if (node.kind === 'gate') {
                out.push({ id: node.id, type: 'bpGate', position, ...BLUEPRINT_GRAPH_SIZES.gate, draggable: false, data: { node, theme: meshTheme, nowMs, selected: selectedGateId === node.id, tooltip: gateTooltip(node) } })
            } else {
                out.push({ id: node.id, type: 'bpFold', position, ...BLUEPRINT_GRAPH_SIZES.fold, draggable: false, data: { node, theme: meshTheme } })
            }
        }
        return out
    }, [layout, view, meshTheme, nowMs, nodeLabels, selectedGateId, laneTitle, taskTooltip, gateTooltip, toggleCollapsed, toggleFolded])

    const flowEdges = useMemo<Edge[]>(() => view.edges.map(edge => {
        const tone = edgeTone(edge)
        const stroke = meshTheme.isDark ? EDGE_COLORS[tone].dark : EDGE_COLORS[tone].light
        return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            // Motion only into running tasks; index.css stops it under prefers-reduced-motion.
            animated: edge.animated,
            style: {
                stroke,
                strokeWidth: tone === 'dead' ? 2.2 : 1.5,
                ...(edge.kind === 'gate' ? { strokeDasharray: '7 5' } : {}),
                ...(tone === 'inactive' ? { opacity: 0.55 } : {}),
            },
            markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
        }
    }), [view.edges, meshTheme])

    /* Honest legend — only what is on screen. */
    const legend = useMemo(() => {
        const items: Array<{ key: string; label: string; color: string; dash?: string }> = []
        const color = (tone: EdgeTone) => (meshTheme.isDark ? EDGE_COLORS[tone].dark : EDGE_COLORS[tone].light)
        if (view.edges.some(edge => edge.kind === 'depends')) items.push({ key: 'depends', label: t('mesh.blueprint.graph.legendDepends'), color: color('waiting') })
        if (view.edges.some(edge => edge.kind === 'gate')) items.push({ key: 'gate', label: t('mesh.blueprint.graph.legendGate'), color: color('waiting'), dash: '4 3' })
        if (view.edges.some(edge => edge.animated)) items.push({ key: 'running', label: t('mesh.blueprint.graph.legendRunning'), color: color('running') })
        if (view.edges.some(edge => edge.state === 'dead')) items.push({ key: 'dead', label: t('mesh.blueprint.graph.legendDead'), color: color('dead') })
        return items
    }, [view.edges, meshTheme, t])

    const selectedGate = useMemo(() => {
        if (!selectedGateId) return null
        const node = model.nodes.find(candidate => candidate.id === selectedGateId)
        return node && node.kind === 'gate' ? node : null
    }, [model, selectedGateId])
    useEffect(() => {
        if (selectedGateId && !selectedGate) setSelectedGateId(null)
    }, [selectedGate, selectedGateId])

    const onNodeClick = useCallback((_event: unknown, flowNode: BlueprintFlowNode) => {
        if (flowNode.type === 'bpTask') {
            const taskId = (flowNode.data as TaskNodeData).node.taskId
            const task = taskId ? taskById.get(taskId) : undefined
            if (task) onTaskOpen(task)
            return
        }
        if (flowNode.type === 'bpGate') {
            const id = (flowNode.data as GateNodeData).node.id
            setSelectedGateId(current => (current === id ? null : id))
        }
    }, [onTaskOpen, taskById])

    const gatePanel = selectedGate ? (() => {
        const graph = graphById.get(selectedGate.graphId)
        const handlers = selectedGate.blocking
            ? gateCommands.handlersFor(selectedGate.id, selectedGate.gate?.gateId, selectedGate.ref)
            : undefined
        const deadline = gateDeadlineReading(selectedGate, nowMs)
        const tone = GATE_TONE_STYLE[selectedGate.tone]
        return (
            <div
                data-testid="bp-graph-gate-panel"
                className={`absolute bottom-2 left-2 right-2 z-20 flex max-h-[55%] flex-col gap-1.5 overflow-y-auto rounded-xl border p-2.5 text-2xs shadow-lg md:left-auto md:w-[380px] ${meshTheme.isDark ? 'border-white/10 bg-slate-950/95 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-semibold" title={selectedGate.ref}>{selectedGate.ref}</span>
                    <span className="shrink-0 text-4xs uppercase tracking-wide opacity-80">{t(`mesh.blueprint.graph.gateTone.${selectedGate.tone}`)}</span>
                    <button type="button" className="shrink-0 rounded px-1 text-text-muted hover:text-text-primary" aria-label={t('common.close')} onClick={() => setSelectedGateId(null)}>✕</button>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-4xs text-text-muted">
                    {selectedGate.gate?.action && <span>{selectedGate.gate.action}</span>}
                    {deadline && (
                        <span className={deadline.overdue ? (meshTheme.isDark ? 'text-rose-300' : 'text-rose-700') : ''} title={selectedGate.gate?.deadlineAt}>
                            {deadline.overdue
                                ? t('mesh.blueprint.graph.deadlineOverdue', { age: formatBlueprintAge(deadline.ms) })
                                : t('mesh.blueprint.graph.deadlineIn', { age: formatBlueprintAge(deadline.ms) })}
                        </span>
                    )}
                    {selectedGate.gate?.blocking?.length ? <span>{t('mesh.taskDag.gate.holding', { count: selectedGate.gate.blocking.length })}</span> : null}
                    {selectedGate.gate?.leaseExpired && <span>{t('mesh.blueprint.leaseExpired')}</span>}
                </div>
                {selectedGate.gate?.instructions && <div className="whitespace-pre-wrap text-3xs leading-4 opacity-90">{selectedGate.gate.instructions}</div>}
                {handlers && (
                    <div className="-ml-4">
                        <GateActionsPanel radioGroupId={selectedGate.id} actions={handlers} meshTheme={meshTheme} busy={gateCommands.busyGateKey === selectedGate.id} />
                    </div>
                )}
                {graph && (
                    <button type="button" className="self-start text-4xs text-text-muted underline decoration-dotted underline-offset-2 hover:text-text-primary" onClick={() => onGateOpen(graph, selectedGate.gateNodeId, selectedGate.gate)}>
                        {t('mesh.blueprint.graph.gateDetails')}
                    </button>
                )}
            </div>
        )
    })() : null

    const nothingAtAll = model.nodes.length === 0
    const allHidden = !nothingAtAll && view.lanes.length === 0

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5" data-testid="bp-graph">
            {gateCommands.confirmDialog}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                    type="button"
                    aria-pressed={activeOnly}
                    onClick={() => setActiveOnly(value => !value)}
                    title={t('mesh.blueprint.graph.activeOnlyTitle')}
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-3xs font-medium transition-colors ${activeOnly
                        ? (meshTheme.isDark ? 'border-sky-400/40 bg-sky-500/15 text-sky-100' : 'border-sky-300 bg-sky-50 text-sky-700')
                        : (meshTheme.isDark ? 'border-white/10 bg-white/[0.03] text-slate-300' : 'border-slate-200 bg-white text-slate-600')}`}
                >
                    {activeOnly ? '● ' : '○ '}{t('mesh.blueprint.graph.activeOnly')}
                </button>
                {view.hiddenLaneCount > 0 && (
                    <span className="shrink-0 text-3xs text-text-muted">{t('mesh.blueprint.graph.hiddenLanes', { count: view.hiddenLaneCount })}</span>
                )}
                {legend.length > 0 && (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-4xs text-text-muted" data-testid="bp-graph-legend">
                        {legend.map(item => (
                            <span key={item.key} className="flex items-center gap-1">
                                <svg width="16" height="4" aria-hidden>
                                    <line x1="0" y1="2" x2="16" y2="2" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} />
                                </svg>
                                {item.label}
                            </span>
                        ))}
                    </span>
                )}
                {headerExtras && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">{headerExtras}</div>}
            </div>
            {layoutError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-3xs text-red-400">{t('mesh.blueprint.graph.layoutFailed', { error: layoutError })}</div>}
            <div className="relative min-h-[320px] w-full min-w-0 flex-1 overflow-hidden">
                {nothingAtAll ? (
                    <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-slate-400">
                        {emptyMessage ?? t('mesh.taskDag.empty')}
                    </div>
                ) : allHidden ? (
                    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
                        <span>{t('mesh.blueprint.graph.emptyActive')}</span>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setActiveOnly(false)}>{t('mesh.blueprint.graph.showFinished')}</button>
                    </div>
                ) : (
                    <ReactFlow<BlueprintFlowNode, Edge>
                        className="h-full w-full"
                        nodes={flowNodes}
                        edges={flowEdges}
                        nodeTypes={blueprintGraphNodeTypes}
                        onNodeClick={onNodeClick}
                        onPaneClick={() => setSelectedGateId(null)}
                        minZoom={0.15}
                        maxZoom={1.4}
                        nodesDraggable={false}
                        nodesConnectable={false}
                        elementsSelectable={false}
                        panOnDrag
                        panOnScroll
                        zoomOnScroll={false}
                        zoomOnPinch
                        zoomOnDoubleClick={false}
                        selectionOnDrag={false}
                        onlyRenderVisibleElements
                        proOptions={{ hideAttribution: true }}
                        colorMode={meshTheme.flowColorMode}
                    >
                        <ViewportFitter fitKey={layoutReady ? laneKey : null} focusNodeIds={fitFocusNodeIds} laneRects={layout?.value.lanes ?? EMPTY_LANE_RECTS} />
                        {/* Top-right: bottom-left sat on the first lane column, and the gate panel owns the bottom edge. */}
                        <Controls position="top-right" showZoom showFitView showInteractive={false} />
                        <Background variant={BackgroundVariant.Lines} gap={24} color={meshTheme.blueprintGridFineColor} />
                    </ReactFlow>
                )}
                {gatePanel}
            </div>
        </div>
    )
}
