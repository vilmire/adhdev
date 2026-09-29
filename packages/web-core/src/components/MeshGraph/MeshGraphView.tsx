/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import {
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useTranslation } from 'react-i18next'
import {
    Background,
    BackgroundVariant,
    BaseEdge,
    Controls,
    EdgeLabelRenderer,
    MarkerType,
    MiniMap,
    ReactFlow,
    getBezierPath,
    getSmoothStepPath,
    getStraightPath,
    useNodesInitialized,
    useReactFlow,
    type Edge,
    type EdgeProps,
    type EdgeTypes,
    type Node,
    type NodeTypes,
} from '@xyflow/react';
import './meshGraph.css'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'
import {
    getMeshGraphInitialFocusNodeIds,
    getMeshGraphLayoutKey,
    getMeshGraphViewportKey,
} from '../../utils/mesh-graph-viewport'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, MESH_EDGE_LABEL_BASE, meshChipTone } from './meshGraphTheme';
import {
    buildMeshGraphLayout,
    MESH_GRAPH_EDGE_LABEL,
    estimateMeshGraphNodeHeight,
    getMeshGraphNodeCardWidth,
    type MeshGraphDirection,
    type MeshGraphLayoutEdgePoint,
} from './meshGraphLayout';
import { getMeshGraphDataFingerprint, getMeshGraphLayoutFingerprint } from './meshGraphMemo'
import { edgeColor } from './meshGraphEdgeLegend'
import { edgeDash } from './meshGraphEdgeLegend'
export { MeshGraphEdgeLegend } from './meshGraphEdgeLegend'
import { MeshGraphThemeContext, MeshGraphCompactContext, MeshGraphDirectionContext, MeshGraphMultiMachineContext, MeshNodeCard, type FlowNodeData } from './MeshNodeCard';

/** Dense graph threshold: above this node count, switch to compact card mode */
const COMPACT_NODE_THRESHOLD = 7

/**
 * Surface width (px) below which the graph is treated as mobile: vertical (TB)
 * default layout + compact cards, so a wide LR pipeline doesn't fit-zoom into
 * illegible overlap on narrow viewports. Tailwind `sm` breakpoint.
 */
const MOBILE_GRAPH_WIDTH = 640

interface MeshGraphViewProps {
    data: MeshGraphData
    selectedNodeId?: string | null
    directionPref?: 'LR' | 'TB'
    onNodeClick?: (node: MeshGraphNode) => void
    onEdgeClick?: (edge: MeshGraphEdge) => void
    onNodeHoverChange?: (node: MeshGraphNode | null) => void
    onEdgeHoverChange?: (edge: MeshGraphEdge | null) => void
}

type FlowEdgeData = Record<string, unknown> & {
    graphEdge: MeshGraphEdge
    routePoints?: MeshGraphLayoutEdgePoint[]
}

export type FlowNode = Node<FlowNodeData, 'meshNode'>
type FlowEdge = Edge<FlowEdgeData, 'meshEdge'>

const nodeTypes: NodeTypes = {
    meshNode: MeshNodeCard,
}

const ELK_ROUTE_CORNER_RADIUS = 8

function buildOrthogonalRoutePath(points: MeshGraphLayoutEdgePoint[]): { d: string; labelX: number; labelY: number } | null {
    if (points.length < 2) return null
    if (points.length === 2) {
        const [a, b] = points
        return {
            d: `M ${a.x},${a.y} L ${b.x},${b.y}`,
            labelX: (a.x + b.x) / 2,
            labelY: (a.y + b.y) / 2,
        }
    }
    const radius = ELK_ROUTE_CORNER_RADIUS
    const segments: string[] = [`M ${points[0].x},${points[0].y}`]
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1]
        const curr = points[i]
        const next = points[i + 1]
        const inDx = Math.sign(curr.x - prev.x)
        const inDy = Math.sign(curr.y - prev.y)
        const outDx = Math.sign(next.x - curr.x)
        const outDy = Math.sign(next.y - curr.y)
        const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y)
        const outLen = Math.hypot(next.x - curr.x, next.y - curr.y)
        const r = Math.min(radius, inLen / 2, outLen / 2)
        if (r < 1 || (inDx === outDx && inDy === outDy)) {
            segments.push(`L ${curr.x},${curr.y}`)
            continue
        }
        const enterX = curr.x - inDx * r
        const enterY = curr.y - inDy * r
        const exitX = curr.x + outDx * r
        const exitY = curr.y + outDy * r
        segments.push(`L ${enterX},${enterY}`)
        segments.push(`Q ${curr.x},${curr.y} ${exitX},${exitY}`)
    }
    const last = points[points.length - 1]
    segments.push(`L ${last.x},${last.y}`)
    let totalLen = 0
    const cumLens: number[] = [0]
    for (let i = 1; i < points.length; i += 1) {
        totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        cumLens.push(totalLen)
    }
    const halfway = totalLen / 2
    let labelX = points[0].x
    let labelY = points[0].y
    for (let i = 1; i < points.length; i += 1) {
        if (cumLens[i] >= halfway) {
            const segLen = cumLens[i] - cumLens[i - 1]
            const t = segLen === 0 ? 0 : (halfway - cumLens[i - 1]) / segLen
            labelX = points[i - 1].x + (points[i].x - points[i - 1].x) * t
            labelY = points[i - 1].y + (points[i].y - points[i - 1].y) * t
            break
        }
    }
    return { d: segments.join(' '), labelX, labelY }
}

function getEdgePath(args: EdgeProps<FlowEdge>): [string, number, number] {
    const routePoints = args.data?.routePoints
    if (routePoints && routePoints.length >= 2) {
        const built = buildOrthogonalRoutePath(routePoints)
        if (built) return [built.d, built.labelX, built.labelY]
    }

    const pathParams = {
        sourceX: args.sourceX,
        sourceY: args.sourceY,
        sourcePosition: args.sourcePosition,
        targetX: args.targetX,
        targetY: args.targetY,
        targetPosition: args.targetPosition,
    }
    const graphEdge = args.data?.graphEdge
    if (!graphEdge) {
        const fallback = getBezierPath(pathParams)
        return [fallback[0], fallback[1], fallback[2]]
    }

    let result: ReturnType<typeof getBezierPath>
    if (graphEdge.type === 'parentBranch') result = getStraightPath(pathParams)
    else if (graphEdge.type === 'worktreeLink' || graphEdge.type === 'submoduleLink' || graphEdge.type === 'cloneLink') result = getSmoothStepPath(pathParams)
    else result = getBezierPath(pathParams)
    return [result[0], result[1], result[2]]
}

function getEdgeLabelClasses(edge: MeshGraphEdge): string {
    // Edge labels are neutral chips; only the needs-follow-up (orphan) link —
    // the one edge type that signals attention — tints its text amber.
    return `nodrag nopan ${MESH_EDGE_LABEL_BASE} ${edge.type === 'orphanLink' ? 'text-status-warning' : meshChipTone('neutral')}`
}

function MeshGraphEdgeLine(args: EdgeProps<FlowEdge>) {
    const graphEdge = args.data?.graphEdge
    const [edgePath, labelX, labelY] = getEdgePath(args)
    const labelTitle = typeof args.label === 'string' ? args.label : undefined

    return (
        <>
            <BaseEdge
                id={args.id}
                path={edgePath}
                markerEnd={args.markerEnd}
                style={args.style}
                interactionWidth={24}
            />
            {args.label && graphEdge && (
                <EdgeLabelRenderer>
                    <div
                        className={getEdgeLabelClasses(graphEdge)}
                        title={labelTitle}
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: 'none',
                            maxWidth: MESH_GRAPH_EDGE_LABEL.maxWidth,
                        }}
                    >
                        <span className="block truncate">{args.label}</span>
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    )
}

const edgeTypes: EdgeTypes = {
    meshEdge: MeshGraphEdgeLine,
}

async function buildLayoutWithMeasuredHeights(
    data: MeshGraphData,
    meshTheme: ReturnType<typeof getMeshGraphTheme>,
    compact: boolean,
    direction: MeshGraphDirection,
    measuredHeights: Map<string, number>,
): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
    const layout = await buildMeshGraphLayout(data, compact, direction, measuredHeights)
    return buildFlowLayout(data, layout, meshTheme, compact)
}

async function buildLayout(data: MeshGraphData, meshTheme = getMeshGraphTheme('dark'), compact = false, direction: MeshGraphDirection = 'LR'): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
    const layout = await buildMeshGraphLayout(data, compact, direction)
    return buildFlowLayout(data, layout, meshTheme, compact)
}

function buildFlowLayout(
    data: MeshGraphData,
    layout: Awaited<ReturnType<typeof buildMeshGraphLayout>>,
    meshTheme: ReturnType<typeof getMeshGraphTheme>,
    compact = false,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
    const layoutNodeIds = new Set(layout.nodes.map(node => node.id))
    const flowNodes: FlowNode[] = layout.nodes.map(node => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: { graphNode: node.graphNode, compact },
        // Controlled nodes never receive `measured` back (no onNodesChange), so
        // without an initial size the MiniMap skipped every node and drew an
        // empty grey box with only the viewport rectangle. initialWidth/Height
        // feed the minimap + fitView without being applied as inline size.
        initialWidth: getMeshGraphNodeCardWidth(node.graphNode, compact),
        initialHeight: estimateMeshGraphNodeHeight(node.graphNode, compact),
        selected: node.selected,
        draggable: node.draggable,
        selectable: node.selectable,
    }))

    const eligibleEdges = data.edges.filter(edge => layoutNodeIds.has(edge.source) && layoutNodeIds.has(edge.target))
    const visibleLabelIds = pickVisibleEdgeLabels(eligibleEdges)
    const flowEdges: FlowEdge[] = eligibleEdges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: visibleLabelIds.has(edge.id) ? edge.label : undefined,
        type: 'meshEdge',
        data: { graphEdge: edge, routePoints: layout.edgeRoutes.get(edge.id)?.points },
        // No marching-ants: the orphan link is a static state, not live activity.
        animated: false,
        markerEnd: edge.direction === 'directed'
            ? {
                type: MarkerType.ArrowClosed,
                width: 14,
                height: 14,
                color: edgeColor(edge),
            }
            : undefined,
        style: {
            stroke: edgeColor(edge),
            // Neutral 1px lines; the dash pattern (shared with the legend) is what
            // tells edge kinds apart, not a per-kind hue.
            strokeWidth: 1,
            strokeDasharray: edgeDash(edge.type),
        },
        labelStyle: {
            fill: meshTheme.edgeLabelTextColor,
            fontSize: 10,
            fontWeight: 600,
        },
        labelBgStyle: {
            fill: meshTheme.edgeLabelBackgroundColor,
            fillOpacity: 1,
            stroke: meshTheme.edgeLabelBorderColor,
        },
        labelBgPadding: [6, 4],
        labelBgBorderRadius: 7,
    }))

    return { nodes: flowNodes, edges: flowEdges }
}

const EDGE_LABEL_FANOUT_THRESHOLD = 3
const EDGE_LABEL_VISIBLE_PER_SOURCE = 2

function edgeLabelPriority(edge: MeshGraphEdge): number {
    switch (edge.type) {
        case 'orphanLink': return 5
        case 'parentBranch': return 4
        case 'submoduleLink': return 3
        case 'cloneLink': return 2
        case 'worktreeLink': return 1
        case 'sessionLink': return 0
        default: return 0
    }
}

function pickVisibleEdgeLabels(edges: MeshGraphEdge[]): Set<string> {
    const visible = new Set<string>()
    const bySource = new Map<string, MeshGraphEdge[]>()
    for (const edge of edges) {
        if (!edge.label) continue
        const bucket = bySource.get(edge.source)
        if (bucket) bucket.push(edge)
        else bySource.set(edge.source, [edge])
    }
    for (const bucket of bySource.values()) {
        if (bucket.length < EDGE_LABEL_FANOUT_THRESHOLD) {
            for (const edge of bucket) visible.add(edge.id)
            continue
        }
        const sorted = [...bucket].sort((a, b) => {
            const diff = edgeLabelPriority(b) - edgeLabelPriority(a)
            if (diff !== 0) return diff
            return a.id.localeCompare(b.id)
        })
        for (const edge of sorted.slice(0, EDGE_LABEL_VISIBLE_PER_SOURCE)) {
            visible.add(edge.id)
        }
    }
    return visible
}

function minimapNodeColor(node: FlowNode): string {
    // Minimap blocks are neutral; only a failing (degraded) node gets colour.
    return node.data.graphNode.health === 'degraded' ? 'var(--status-error)' : 'var(--text-muted)'
}

function minimapNodeClassName(node: FlowNode): string {
    const graphNode = node.data.graphNode
    return [
        'mesh-minimap-node',
        `mesh-minimap-node--${graphNode.type}`,
        `mesh-minimap-node--${graphNode.health}`,
        graphNode.isOrphan ? 'mesh-minimap-node--attention' : null,
        graphNode.dirty ? 'mesh-minimap-node--dirty' : null,
        graphNode.outOfSync ? 'mesh-minimap-node--out-of-sync' : null,
    ].filter(Boolean).join(' ')
}

function MeshViewportController({ data, viewportKey }: { data: MeshGraphData; viewportKey: string }) {
    const nodesInitialized = useNodesInitialized()
    const reactFlow = useReactFlow<FlowNode, FlowEdge>()
    const lastViewportKeyRef = useRef<string | null>(null)
    const layoutKey = useMemo(() => getMeshGraphLayoutKey(data), [data])
    const initialFocusNodeIds = useMemo(() => getMeshGraphInitialFocusNodeIds(data), [data])

    useEffect(() => {
        if (!nodesInitialized || data.nodes.length === 0) return
        if (lastViewportKeyRef.current === viewportKey) return

        let cancelled = false
        const frame = requestAnimationFrame(() => {
            if (cancelled) return
            // Subset-focus is a big-graph affordance; on small graphs it hid nodes
            // that would have fit anyway (the task tab always fits everything, so
            // the graph tab cutting nodes off read as a defect, not a choice).
            const shouldFocusSubset = data.nodes.length > 8
                && initialFocusNodeIds.length > 0 && initialFocusNodeIds.length < data.nodes.length
            void reactFlow.fitView({
                nodes: shouldFocusSubset ? initialFocusNodeIds.map(id => ({ id })) : undefined,
                padding: shouldFocusSubset ? 0.24 : 0.2,
                // maxZoom 1 (not 0.9): a sub-1 cap FORCES a fractional transform scale,
                // and Chrome rasterizes then scales text layers — permanently fuzzy
                // cards even when the graph would fit at a crisp 1.0 (Safari
                // re-rasterizes under transform, which is why it looked fine there).
                maxZoom: 1,
                duration: 260,
            })
            lastViewportKeyRef.current = viewportKey
        })

        return () => {
            cancelled = true
            cancelAnimationFrame(frame)
        }
    }, [data.nodes.length, initialFocusNodeIds, layoutKey, nodesInitialized, reactFlow, viewportKey])

    return null
}

const MINIMAP_NODE_THRESHOLD = 12
/** Below this canvas width the overview box covers cards and edges (tablet
 *  split view / phone) — the map pans instead. */
const MINIMAP_MIN_SURFACE_WIDTH = 900

function getGraphMinHeightClass(nodeCount: number): string {
    // Height floors are capped by viewport height: the canvas is pan/zoomable,
    // so on a short window a smaller canvas beats forcing the dialog body to
    // scroll (the graph tab should never scroll — the graph pans instead).
    if (nodeCount >= 16) return 'min-h-[min(720px,62dvh)]'
    if (nodeCount >= 10) return 'min-h-[min(580px,58dvh)]'
    return 'min-h-[min(460px,52dvh)]'
}

export default function MeshGraphView({
    data,
    selectedNodeId = null,
    directionPref: directionPrefProp,
    onNodeClick,
    onEdgeClick,
    onNodeHoverChange,
    onEdgeHoverChange,
}: MeshGraphViewProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const dataFingerprint = useMemo(() => getMeshGraphDataFingerprint(data), [data])
    const layoutFingerprint = useMemo(() => getMeshGraphLayoutFingerprint(data), [data])
    const surfaceRef = useRef<HTMLDivElement | null>(null)
    const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
    // Narrow viewports (mobile) must fall back to a vertical, compact layout so the
    // wide LR pipeline of 256px cards does not get fit-zoomed into illegible overlap.
    // width === 0 means the surface has not measured yet — treat as desktop until known.
    const isNarrowViewport = surfaceSize.width > 0 && surfaceSize.width < MOBILE_GRAPH_WIDTH
    const compact = data.nodes.length >= COMPACT_NODE_THRESHOLD || isNarrowViewport
    /* Direction: the caller's explicit choice, else TB. The former 'auto' mode
     * derived it from the data, so the same mesh could flip orientation as it
     * changed; TB is also what the narrow-viewport fallback below wanted, so a
     * TB default makes the two agree instead of fighting. `data` is no longer
     * an input here — only the heuristic ever read it. */
    const direction: MeshGraphDirection = useMemo(
        () => {
            if (directionPrefProp === 'LR' || directionPrefProp === 'TB') return directionPrefProp
            // No explicit choice: vertical on narrow viewports so a wide LR
            // pipeline is not fit-zoomed into overlap.
            if (isNarrowViewport) return 'TB'
            return 'TB'
        },
        [directionPrefProp, isNarrowViewport],
    )
    const showMinimap = data.nodes.length >= MINIMAP_NODE_THRESHOLD && surfaceSize.width >= MINIMAP_MIN_SURFACE_WIDTH
    // `pass` tracks which layout generation is on screen: the estimated first pass
    // or the measured-heights refinement. The viewport controller re-fits once per
    // pass, so the refined layout can no longer drift outside the fitted viewport
    // (the old behavior fit only the estimated pass — cards then jumped after the
    // measured re-layout and ended up clipped at the canvas edge).
    const [layout, setLayout] = useState<{ nodes: FlowNode[]; edges: FlowEdge[]; pass: 'estimated' | 'measured' }>({ nodes: [], edges: [], pass: 'estimated' })
    const viewportKey = useMemo(
        () => `${getMeshGraphViewportKey(data, surfaceSize.width, surfaceSize.height)}::${direction}`,
        [dataFingerprint, data, surfaceSize.height, surfaceSize.width, direction],
    )
    // True when the graph spans more than one machine — single-machine meshes
    // suppress the per-card machine label (it repeated the same name everywhere).
    const multiMachine = useMemo(() => {
        const machineKeys = new Set(
            data.nodes
                .filter(node => node.type === 'worktreeNode' || node.type === 'orphanNode')
                .map(node => node.machineId || node.machineLabel || ''),
        )
        machineKeys.delete('')
        return machineKeys.size > 1
    }, [data.nodes])
    // Transient pan affordance hint — fades away instead of permanently floating
    // over the canvas.
    const [showPanHint, setShowPanHint] = useState(true)
    useEffect(() => {
        const timer = setTimeout(() => setShowPanHint(false), 5000)
        return () => clearTimeout(timer)
    }, [])

    useEffect(() => {
        let cancelled = false
        void buildLayout(data, meshTheme, compact, direction).then(firstLayout => {
            if (cancelled) return
            setLayout({ ...firstLayout, pass: 'estimated' })
            // 2nd pass: after React paints, read actual DOM heights and re-run ELK
            // so edge endpoints land at the real bottom of variable-height cards (TB mode)
            const raf = requestAnimationFrame(() => {
                if (cancelled) return
                const root = surfaceRef.current
                if (!root) return
                const measuredHeights = new Map<string, number>()
                for (const n of firstLayout.nodes) {
                    const el = root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`)
                    if (el && el.offsetHeight > 0) measuredHeights.set(n.id, el.offsetHeight)
                }
                if (measuredHeights.size === 0) return
                void buildLayoutWithMeasuredHeights(data, meshTheme, compact, direction, measuredHeights).then(refined => {
                    if (!cancelled) setLayout({ ...refined, pass: 'measured' })
                })
            })
            return () => cancelAnimationFrame(raf)
        })
        return () => {
            cancelled = true
        }
    }, [data, layoutFingerprint, meshTheme, compact, direction])

    const nodes = useMemo(
        () => layout.nodes.map(node => ({ ...node, selected: node.id === selectedNodeId })),
        [layout.nodes, selectedNodeId],
    )

    useEffect(() => {
        const element = surfaceRef.current
        if (!element) return

        const updateSize = () => {
            const nextWidth = Math.max(0, Math.round(element.clientWidth))
            const nextHeight = Math.max(0, Math.round(element.clientHeight))
            setSurfaceSize(prev => (
                prev.width === nextWidth && prev.height === nextHeight
                    ? prev
                    : { width: nextWidth, height: nextHeight }
            ))
        }

        updateSize()
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateSize())
            : null
        resizeObserver?.observe(element)
        window.addEventListener('resize', updateSize)

        return () => {
            resizeObserver?.disconnect()
            window.removeEventListener('resize', updateSize)
        }
    }, [])

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <MeshGraphCompactContext.Provider value={compact}>
        <MeshGraphDirectionContext.Provider value={direction}>
        <MeshGraphMultiMachineContext.Provider value={multiMachine}>
        <div ref={surfaceRef} className={`${meshTheme.graphShellClass} ${getGraphMinHeightClass(data.nodes.length)}`} style={{ height: '100%' }}>
            <div
                className={`pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 px-3 py-1 text-3xs transition-opacity duration-700 ${meshTheme.graphStatChipClass} ${showPanHint ? 'opacity-100' : 'opacity-0'}`}
                aria-hidden={!showPanHint}
            >
                {t('mesh.obs.panHint')}
            </div>
            <div className="mesh-flow w-full min-w-0 flex-1" style={{ height: '100%' }}>
                <ReactFlow<FlowNode, FlowEdge>
                    nodes={nodes}
                    edges={layout.edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    // Same floor on every viewport: the old 0.3 mobile floor stopped
                    // fitView from ever showing the WHOLE graph on a phone (the task
                    // DAG had no such floor — the parity gap users noticed).
                    minZoom={0.18}
                    maxZoom={1.35}
                    // Baseline auto-fit (same as the task DAG): React Flow fits once
                    // nodes initialize even if the controller's keyed fit misfires
                    // (e.g. a dialog that mounts the pane mid-animation on mobile).
                    fitView
                    fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable
                    panOnDrag
                    panOnScroll
                    zoomOnScroll={false}
                    zoomOnPinch
                    zoomOnDoubleClick={false}
                    selectionOnDrag={false}
                    onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}
                    onEdgeClick={(_, edge) => { const e = edge.data?.graphEdge; if (e) onEdgeClick?.(e) }}
                    onNodeMouseEnter={(_, node) => onNodeHoverChange?.(node.data.graphNode)}
                    onNodeMouseLeave={() => onNodeHoverChange?.(null)}
                    onEdgeMouseEnter={(_, edge) => onEdgeHoverChange?.(edge.data?.graphEdge ?? null)}
                    onEdgeMouseLeave={() => onEdgeHoverChange?.(null)}
                    className="h-full w-full"
                    colorMode={meshTheme.flowColorMode}
                    proOptions={{ hideAttribution: true }}
                >
                    {/* One fit per layout pass: the measured-heights re-layout gets its own
                        re-fit so the refined positions stay inside the viewport. */}
                    <MeshViewportController data={data} viewportKey={`${viewportKey}::${layout.pass}`} />
                    <Controls className={meshTheme.graphControlsClass} position="bottom-left" showZoom showFitView showInteractive={false} />
                    {showMinimap && (
                        <MiniMap
                            position="bottom-right"
                            pannable
                            zoomable
                            nodeColor={minimapNodeColor}
                            nodeClassName={minimapNodeClassName}
                            nodeStrokeWidth={0}
                            nodeBorderRadius={2}
                            ariaLabel={t('mesh.obs.tabMap')}
                            style={{ width: 168, height: 112 }}
                        />
                    )}
                    <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color={meshTheme.graphBackgroundDotColor} />
                </ReactFlow>
            </div>
        </div>
        </MeshGraphMultiMachineContext.Provider>
        </MeshGraphDirectionContext.Provider>
        </MeshGraphCompactContext.Provider>
        </MeshGraphThemeContext.Provider>
    )
}
