/**
 * MeshGraphView — SVG-based force-directed mesh visualization
 *
 * No external libraries. Pure React + SVG.
 */

import { useMemo, useRef, useState, useCallback } from 'react'
import type { MeshGraphData, MeshGraphNode, MeshGraphEdge } from './types'

interface MeshGraphViewProps {
  data: MeshGraphData
  width?: number
  height?: number
  onNodeClick?: (node: MeshGraphNode) => void
  selectedNodeId?: string | null
}

interface SimNode extends MeshGraphNode {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
}

function healthColor(health: string): string {
  switch (health) {
    case 'online': return '#22c55e'
    case 'dirty': return '#f59e0b'
    case 'degraded': return '#ef4444'
    case 'wrong_branch': return '#a855f7'
    case 'offline': return '#6b7280'
    default: return '#9ca3af'
  }
}

function edgeColor(type: string): string {
  switch (type) {
    case 'parentBranch': return 'rgba(148,163,184,0.6)'
    case 'worktreeLink': return 'rgba(59,130,246,0.4)'
    case 'sessionLink': return 'rgba(168,85,247,0.4)'
    default: return 'rgba(148,163,184,0.3)'
  }
}

function runForceLayout(
  nodes: SimNode[],
  edges: MeshGraphEdge[],
  width: number,
  height: number,
  iterations = 120,
) {
  const centerX = width / 2
  const centerY = height / 2

  for (let i = 0; i < iterations; i++) {
    // Repulsion
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = nodes[b].x - nodes[a].x
        const dy = nodes[b].y - nodes[a].y
        let dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = 8000 / (dist * dist)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        nodes[a].vx -= fx
        nodes[a].vy -= fy
        nodes[b].vx += fx
        nodes[b].vy += fy
      }
    }

    // Attraction (edges)
    for (const edge of edges) {
      const src = nodes.find(n => n.id === edge.source)
      const tgt = nodes.find(n => n.id === edge.target)
      if (!src || !tgt) continue
      const dx = tgt.x - src.x
      const dy = tgt.y - src.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const targetDist = edge.type === 'parentBranch' ? 140 : 90
      const force = ((dist - targetDist) / dist) * 0.08
      const fx = dx * force
      const fy = dy * force
      src.vx += fx
      src.vy += fy
      tgt.vx -= fx
      tgt.vy -= fy
    }

    // Center gravity
    for (const n of nodes) {
      n.vx += (centerX - n.x) * 0.003
      n.vy += (centerY - n.y) * 0.003
    }

    // Apply velocity + damping
    for (const n of nodes) {
      n.vx *= 0.85
      n.vy *= 0.85
      n.x += n.vx
      n.y += n.vy

      // Bounds
      const margin = n.radius + 10
      n.x = Math.max(margin, Math.min(width - margin, n.x))
      n.y = Math.max(margin, Math.min(height - margin, n.y))
    }
  }
}

export default function MeshGraphView({ data, width = 800, height = 500, onNodeClick, selectedNodeId }: MeshGraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)

  const simNodes = useMemo(() => {
    const list: SimNode[] = data.nodes.map((n, i) => ({
      ...n,
      x: width / 2 + Math.cos((i / Math.max(data.nodes.length, 1)) * Math.PI * 2) * 120,
      y: height / 2 + Math.sin((i / Math.max(data.nodes.length, 1)) * Math.PI * 2) * 120,
      vx: 0,
      vy: 0,
      radius: n.type === 'defaultBranchNode' ? 28 : 20,
    }))
    runForceLayout(list, data.edges, width, height, 120)
    return list
  }, [data, width, height])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(z => Math.max(0.3, Math.min(3, z * delta)))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    }
    setDragging(true)
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return
    const d = dragRef.current
    setPan({
      x: d.panX + (e.clientX - d.startX),
      y: d.panY + (e.clientY - d.startY),
    })
  }, [])

  const handleMouseUp = useCallback(() => {
    dragRef.current = null
    setDragging(false)
  }, [])

  return (
    <div
      className="relative rounded-xl border border-border-subtle bg-bg-panel overflow-hidden"
      style={{ width, height }}
    >
      {/* Stats bar */}
      <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-2">
        <span className="px-2 py-0.5 rounded bg-bg-glass text-[10px] text-text-muted border border-border-subtle">
          Nodes: {data.stats.totalNodes}
        </span>
        <span className="px-2 py-0.5 rounded bg-green-500/10 text-[10px] text-green-400 border border-green-500/20">
          Online: {data.stats.onlineNodes}
        </span>
        {data.stats.dirtyNodes > 0 && (
          <span className="px-2 py-0.5 rounded bg-yellow-500/10 text-[10px] text-yellow-400 border border-yellow-500/20">
            Dirty: {data.stats.dirtyNodes}
          </span>
        )}
        {data.stats.orphanNodes > 0 && (
          <span className="px-2 py-0.5 rounded bg-red-500/10 text-[10px] text-red-400 border border-red-500/20">
            Orphan: {data.stats.orphanNodes}
          </span>
        )}
        {data.stats.totalActiveSessions > 0 && (
          <span className="px-2 py-0.5 rounded bg-blue-500/10 text-[10px] text-blue-400 border border-blue-500/20">
            Sessions: {data.stats.totalActiveSessions}
          </span>
        )}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-2 right-2 z-10 flex flex-col gap-1">
        <button
          className="w-7 h-7 rounded bg-bg-glass border border-border-subtle text-text-muted hover:text-text-primary flex items-center justify-center text-xs"
          onClick={() => setZoom(z => Math.min(3, z * 1.2))}
        >+</button>
        <button
          className="w-7 h-7 rounded bg-bg-glass border border-border-subtle text-text-muted hover:text-text-primary flex items-center justify-center text-xs"
          onClick={() => setZoom(z => Math.max(0.3, z / 1.2))}
        >-</button>
        <button
          className="w-7 h-7 rounded bg-bg-glass border border-border-subtle text-text-muted hover:text-text-primary flex items-center justify-center text-[9px]"
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}
        >⟲</button>
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 max-w-[200px]">
          {data.warnings.map((w, i) => (
            <div key={i} className="px-2 py-0.5 rounded bg-red-500/10 text-[10px] text-red-400 border border-red-500/20">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}

      <svg
        ref={svgRef}
        width={width}
        height={height}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Edges */}
          {data.edges.map(edge => {
            const src = simNodes.find(n => n.id === edge.source)
            const tgt = simNodes.find(n => n.id === edge.target)
            if (!src || !tgt) return null
            return (
              <g key={edge.id}>
                <line
                  x1={src.x}
                  y1={src.y}
                  x2={tgt.x}
                  y2={tgt.y}
                  stroke={edgeColor(edge.type)}
                  strokeWidth={edge.type === 'parentBranch' ? 2 : 1}
                  strokeDasharray={edge.type === 'worktreeLink' ? '4 3' : undefined}
                />
                {edge.label && (
                  <text
                    x={(src.x + tgt.x) / 2}
                    y={(src.y + tgt.y) / 2 - 4}
                    fill="#94a3b8"
                    fontSize={9}
                    textAnchor="middle"
                  >{edge.label}</text>
                )}
              </g>
            )
          })}

          {/* Nodes */}
          {simNodes.map(node => (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => onNodeClick?.(node)}
              style={{ cursor: 'pointer' }}
            >
              {/* Glow for conflicts */}
              {node.hasConflicts && (
                <circle r={node.radius + 6} fill="none" stroke="#ef4444" strokeWidth={1.5} opacity={0.5}>
                  <animate attributeName="r" values={`${node.radius + 4};${node.radius + 8};${node.radius + 4}`} dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0.2;0.6" dur="2s" repeatCount="indefinite" />
                </circle>
              )}

              {/* Main circle */}
              <circle
                r={node.radius}
                fill={healthColor(node.health)}
                opacity={node.health === 'offline' ? 0.4 : 0.9}
                stroke={selectedNodeId === node.id ? "#38bdf8" : "#0f172a"}
                strokeWidth={selectedNodeId === node.id ? 3 : 2}
              />

              {/* Inner ring for dirty */}
              {node.dirty && (
                <circle
                  r={node.radius - 4}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={selectedNodeId === node.id ? 3 : 2}
                  strokeDasharray="3 2"
                />
              )}

              {/* Label */}
              <text
                y={node.radius + 14}
                fill="#e2e8f0"
                fontSize={10}
                textAnchor="middle"
                fontWeight={600}
              >{node.label}</text>

              {/* Branch label */}
              {node.branch && (
                <text
                  y={node.radius + 26}
                  fill="#94a3b8"
                  fontSize={9}
                  textAnchor="middle"
                >{node.branch}</text>
              )}

              {/* Ahead/Behind badge */}
              {(node.ahead > 0 || node.behind > 0) && (
                <g transform={`translate(${node.radius - 6}, -${node.radius - 6})`}>
                  <circle r={10} fill="#0f172a" stroke="#334155" strokeWidth={1} />
                  <text y={3} fill="#e2e8f0" fontSize={8} textAnchor="middle">
                    {node.ahead > 0 ? `+${node.ahead}` : `-${node.behind}`}
                  </text>
                </g>
              )}

              {/* Session count badge */}
              {node.activeSessionCount > 0 && (
                <g transform={`translate(-${node.radius - 6}, -${node.radius - 6})`}>
                  <circle r={10} fill="#0f172a" stroke="#3b82f6" strokeWidth={1} />
                  <text y={3} fill="#60a5fa" fontSize={8} textAnchor="middle">{node.activeSessionCount}</text>
                </g>
              )}
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}
