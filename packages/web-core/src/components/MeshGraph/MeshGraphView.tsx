/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import { useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'

interface MeshGraphViewProps {
  data: MeshGraphData
  selectedNodeId?: string | null
  onNodeClick?: (node: MeshGraphNode) => void
}

type FlowNodeData = Record<string, unknown> & {
  graphNode: MeshGraphNode
}

type FlowNode = Node<FlowNodeData, 'meshNode'>
type FlowEdge = Edge

const COLUMN_GAP = 280
const ROW_GAP = 170

function getHealthClasses(health: MeshGraphNode['health'], selected: boolean): string {
  const base = selected
    ? 'border-cyan-400/70 shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_24px_60px_rgba(8,145,178,0.18)]'
    : 'border-border-subtle shadow-[0_18px_48px_rgba(3,7,18,0.22)]'

  switch (health) {
    case 'online':
      return `${base} bg-emerald-500/8`
    case 'dirty':
      return `${base} bg-amber-500/8`
    case 'degraded':
      return `${base} bg-rose-500/10`
    case 'wrong_branch':
      return `${base} bg-violet-500/10`
    case 'offline':
      return `${base} bg-slate-500/12`
    default:
      return `${base} bg-bg-panel`
  }
}

function getBadgeClasses(kind: 'health' | 'dirty' | 'conflict' | 'orphan' | 'meta'): string {
  switch (kind) {
    case 'health':
      return 'border-white/10 bg-white/6 text-text-secondary'
    case 'dirty':
      return 'border-amber-400/25 bg-amber-500/10 text-amber-200'
    case 'conflict':
      return 'border-rose-400/25 bg-rose-500/10 text-rose-200'
    case 'orphan':
      return 'border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-200'
    case 'meta':
    default:
      return 'border-cyan-400/20 bg-cyan-500/8 text-cyan-100'
  }
}

function getHealthDot(health: MeshGraphNode['health']): string {
  switch (health) {
    case 'online':
      return '#34d399'
    case 'dirty':
      return '#fbbf24'
    case 'degraded':
      return '#fb7185'
    case 'wrong_branch':
      return '#a78bfa'
    case 'offline':
      return '#94a3b8'
    default:
      return '#64748b'
  }
}

function formatHealth(health: MeshGraphNode['health']): string {
  return health.replace(/_/g, ' ')
}

function MeshNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const node = data.graphNode
  const subtitle = node.type === 'defaultBranchNode'
    ? 'default branch anchor'
    : node.machineLabel || node.workspace

  return (
    <div
      className={`w-[240px] rounded-2xl border px-4 py-3 backdrop-blur-sm transition-all ${getHealthClasses(node.health, selected)}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none' }}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text-primary">{node.label}</div>
          <div className="truncate text-[11px] text-text-muted">{subtitle}</div>
        </div>
        <span
          className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: getHealthDot(node.health) }}
          aria-hidden
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
        <span className={`rounded-full border px-2 py-0.5 capitalize ${getBadgeClasses('health')}`}>
          {formatHealth(node.health)}
        </span>
        {node.branch && (
          <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('meta')}`}>
            {node.branch}
          </span>
        )}
        {node.dirty && (
          <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('dirty')}`}>
            {node.dirtyFiles} dirty
          </span>
        )}
        {node.hasConflicts && (
          <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict')}`}>
            conflicts
          </span>
        )}
        {node.isOrphan && (
          <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('orphan')}`}>
            needs attention
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-secondary">
        <div className="rounded-xl border border-white/6 bg-black/10 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">Sessions</div>
          <div className="mt-1 font-medium text-text-primary">{node.activeSessionCount}</div>
        </div>
        <div className="rounded-xl border border-white/6 bg-black/10 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">Git drift</div>
          <div className="mt-1 font-medium text-text-primary">
            +{node.ahead} / -{node.behind}
          </div>
        </div>
      </div>

      {node.nextStepHint && (
        <div className="mt-3 rounded-xl border border-cyan-400/15 bg-cyan-500/8 px-3 py-2 text-[10px] leading-4 text-cyan-50/90">
          {node.nextStepHint}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  )
}

const nodeTypes: NodeTypes = {
  meshNode: MeshNodeCard,
}

function compareNodes(a: MeshGraphNode, b: MeshGraphNode): number {
  if (a.type === 'defaultBranchNode' && b.type !== 'defaultBranchNode') return -1
  if (b.type === 'defaultBranchNode' && a.type !== 'defaultBranchNode') return 1
  if (a.branch && b.branch && a.branch !== b.branch) return a.branch.localeCompare(b.branch)
  if (a.branch && !b.branch) return -1
  if (!a.branch && b.branch) return 1
  return a.label.localeCompare(b.label)
}

function buildLayout(data: MeshGraphData): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const sortedNodes = [...data.nodes].sort(compareNodes)
  const defaultAnchor = sortedNodes.find(node => node.type === 'defaultBranchNode') ?? null
  const nonDefaultNodes = sortedNodes.filter(node => node.id !== defaultAnchor?.id)
  const branchGroups = new Map<string, MeshGraphNode[]>()
  const orphanNodes: MeshGraphNode[] = []

  for (const node of nonDefaultNodes) {
    if (node.isOrphan || !node.branch) {
      orphanNodes.push(node)
      continue
    }
    const key = node.branch
    const bucket = branchGroups.get(key) ?? []
    bucket.push(node)
    branchGroups.set(key, bucket)
  }

  const orderedGroups = [...branchGroups.entries()].sort(([a], [b]) => {
    if (defaultAnchor?.branch && a === defaultAnchor.branch && b !== defaultAnchor.branch) return -1
    if (defaultAnchor?.branch && b === defaultAnchor.branch && a !== defaultAnchor.branch) return 1
    return a.localeCompare(b)
  })

  if (orphanNodes.length > 0) {
    orderedGroups.push(['__orphans__', [...orphanNodes].sort(compareNodes)])
  }

  if (orderedGroups.length === 0) {
    orderedGroups.push(['__nodes__', []])
  }

  const flowNodes: FlowNode[] = []
  const groupCount = orderedGroups.length
  const totalWidth = Math.max(1, groupCount - 1) * COLUMN_GAP
  const topRowY = defaultAnchor ? 0 : 80
  const contentRowStartY = defaultAnchor ? ROW_GAP : 0

  if (defaultAnchor) {
    flowNodes.push({
      id: defaultAnchor.id,
      type: 'meshNode',
      position: { x: totalWidth / 2, y: topRowY },
      data: { graphNode: defaultAnchor },
      selected: false,
      draggable: false,
      selectable: true,
    })
  }

  orderedGroups.forEach(([groupKey, groupNodes], columnIndex) => {
    const x = columnIndex * COLUMN_GAP
    const nodesForColumn = groupNodes.length > 0
      ? groupNodes
      : nonDefaultNodes.length > 0
        ? nonDefaultNodes
        : []

    nodesForColumn.forEach((node, rowIndex) => {
      const y = contentRowStartY + rowIndex * ROW_GAP
      flowNodes.push({
        id: node.id,
        type: 'meshNode',
        position: { x, y },
        data: { graphNode: node },
        selected: false,
        draggable: false,
        selectable: true,
      })
    })

    if (groupKey === '__nodes__' && nonDefaultNodes.length === 0 && defaultAnchor) {
      flowNodes.push({
        id: `${defaultAnchor.id}__placeholder`,
        type: 'meshNode',
        position: { x, y: contentRowStartY },
        data: {
          graphNode: {
            id: `${defaultAnchor.id}__placeholder`,
            type: 'worktreeNode',
            label: 'No active worktrees',
            workspace: data.repoIdentity,
            branch: defaultAnchor.branch,
            machineLabel: null,
            health: 'unknown',
            ahead: 0,
            behind: 0,
            dirty: false,
            dirtyFiles: 0,
            hasConflicts: false,
            activeSessionCount: 0,
            activeSessions: [],
            providers: [],
            isOrphan: false,
            orphanReasons: [],
            nextStepHint: 'Waiting for worktree nodes to report live mesh status.',
            source: {
              nodeId: `${defaultAnchor.id}__placeholder`,
              machineLabel: null,
              workspace: data.repoIdentity,
              health: 'unknown',
              providers: [],
              activeSessions: [],
            },
          },
        },
        selected: false,
        draggable: false,
        selectable: false,
      })
    }
  })

  const flowEdges: FlowEdge[] = data.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: edge.type === 'worktreeLink' ? 'smoothstep' : 'bezier',
    animated: edge.type === 'orphanLink',
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 18,
      height: 18,
      color: edgeColor(edge),
    },
    style: {
      stroke: edgeColor(edge),
      strokeWidth: edge.type === 'orphanLink' ? 2.25 : edge.type === 'worktreeLink' ? 1.8 : 2,
      strokeDasharray: edge.type === 'orphanLink' ? '5 4' : undefined,
    },
    labelStyle: {
      fill: 'var(--text-secondary, #cbd5e1)',
      fontSize: 10,
      fontWeight: 600,
    },
    labelBgStyle: {
      fill: 'rgba(2, 6, 23, 0.86)',
      fillOpacity: 1,
      stroke: 'rgba(148, 163, 184, 0.2)',
    },
    labelBgPadding: [5, 3],
    labelBgBorderRadius: 6,
  }))

  return { nodes: flowNodes, edges: flowEdges }
}

function edgeColor(edge: MeshGraphEdge): string {
  switch (edge.type) {
    case 'parentBranch':
      return '#38bdf8'
    case 'worktreeLink':
      return '#a78bfa'
    case 'sessionLink':
      return '#34d399'
    case 'orphanLink':
      return '#f97316'
    default:
      return '#64748b'
  }
}

export default function MeshGraphView({ data, selectedNodeId = null, onNodeClick }: MeshGraphViewProps) {
  const layout = useMemo(() => buildLayout(data), [data])

  const nodes = useMemo(
    () => layout.nodes.map(node => ({ ...node, selected: node.id === selectedNodeId })),
    [layout.nodes, selectedNodeId],
  )

  return (
    <div className="relative h-full min-h-[480px] overflow-hidden rounded-2xl border border-border-subtle bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_rgba(15,23,42,0.98)_42%,_rgba(2,6,23,1))]">
      <div className="absolute left-4 top-4 z-10 flex flex-wrap gap-2 text-[11px] text-text-secondary">
        <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1">
          {data.stats.totalNodes} node{data.stats.totalNodes === 1 ? '' : 's'}
        </span>
        <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1">
          {data.stats.totalActiveSessions} active session{data.stats.totalActiveSessions === 1 ? '' : 's'}
        </span>
        {data.stats.orphanNodes > 0 && (
          <span className="rounded-full border border-orange-400/25 bg-orange-500/12 px-3 py-1 text-orange-100">
            {data.stats.orphanNodes} need attention
          </span>
        )}
      </div>
      <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}
        className="h-full w-full"
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap
          pannable
          zoomable
          className="!bottom-4 !right-4 !bg-slate-950/85 !border !border-white/10 !rounded-xl"
          nodeColor={currentNode => getHealthDot((currentNode.data as FlowNodeData).graphNode.health)}
        />
        <Controls className="!bottom-4 !left-4 !shadow-lg" showInteractive={false} />
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="rgba(148, 163, 184, 0.22)" />
      </ReactFlow>
    </div>
  )
}
