/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
    Background,
    BackgroundVariant,
    BaseEdge,
    Controls,
    EdgeLabelRenderer,
    Handle,
    MarkerType,
    MiniMap,
    Position,
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
    type NodeProps,
    type NodeTypes,
} from '@xyflow/react'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'
import {
    getMeshGraphAttentionBadge,
    getMeshGraphCalloutText,
    shouldShowMeshGraphCallout,
} from './meshGraphViewModel'
import {
    getMeshGraphInitialFocusNodeIds,
    getMeshGraphLayoutKey,
    getMeshGraphViewportKey,
} from '../../utils/mesh-graph-viewport'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme } from './meshGraphTheme'
import {
    buildMeshGraphLayout,
    MESH_GRAPH_EDGE_LABEL,
    getMeshGraphNodeCardWidth,
    getNodeSummaryForLayout,
    pickMeshGraphDirection,
    type MeshGraphDirection,
    type MeshGraphLayoutEdgePoint,
} from './meshGraphLayout'
import { getMeshGraphDataFingerprint, getMeshGraphLayoutFingerprint } from './meshGraphMemo'

/** Dense graph threshold: above this node count, switch to compact card mode */
const COMPACT_NODE_THRESHOLD = 7

interface MeshGraphViewProps {
    data: MeshGraphData
    selectedNodeId?: string | null
    onNodeClick?: (node: MeshGraphNode) => void
    onNodeHoverChange?: (node: MeshGraphNode | null) => void
    onEdgeHoverChange?: (edge: MeshGraphEdge | null) => void
}

type FlowNodeData = Record<string, unknown> & {
    graphNode: MeshGraphNode
    compact: boolean
}

type FlowEdgeData = Record<string, unknown> & {
    graphEdge: MeshGraphEdge
    routePoints?: MeshGraphLayoutEdgePoint[]
}

type FlowNode = Node<FlowNodeData, 'meshNode'>
type FlowEdge = Edge<FlowEdgeData, 'meshEdge'>

const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))
const MeshGraphCompactContext = createContext(false)
const MeshGraphDirectionContext = createContext<MeshGraphDirection>('LR')

const boundedTextStyle: CSSProperties = {
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
}

const summaryTextStyle: CSSProperties = {
    ...boundedTextStyle,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
}

const calloutTextStyle: CSSProperties = {
    ...boundedTextStyle,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 4,
    overflow: 'hidden',
}

function isNodeActive(node: MeshGraphNode): boolean {
    return node.activeSessionCount > 0
}

function isNodeStale(node: MeshGraphNode): boolean {
    return node.health === 'offline' || (node.snapshotCompleteness === 'stale' && node.activeSessionCount === 0)
}

function getHealthClasses(node: MeshGraphNode, selected: boolean, isDark: boolean): string {
    const isActive = isNodeActive(node)
    const isStale = isNodeStale(node)

    let base: string
    if (selected) {
        base = 'border-cyan-400/70 shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_24px_60px_rgba(8,145,178,0.18)]'
    } else if (isActive) {
        base = isDark
            ? 'border-emerald-400/40 shadow-[0_0_0_1px_rgba(52,211,153,0.18),0_18px_48px_rgba(3,7,18,0.22)]'
            : 'border-emerald-400/60 shadow-[0_0_0_1px_rgba(52,211,153,0.2),0_18px_48px_rgba(148,163,184,0.20)]'
    } else if (isStale) {
        base = isDark
            ? 'border-white/6 shadow-[0_12px_32px_rgba(3,7,18,0.16)] opacity-60'
            : 'border-slate-200/70 shadow-[0_12px_32px_rgba(148,163,184,0.14)] opacity-60'
    } else {
        base = isDark
            ? 'border-white/10 shadow-[0_18px_48px_rgba(3,7,18,0.22)]'
            : 'border-slate-300/90 shadow-[0_18px_48px_rgba(148,163,184,0.20)]'
    }

    const attention = getMeshGraphAttentionBadge(node)

    if (attention?.tone === 'danger') return `${base} ${isDark ? 'bg-rose-500/12' : 'bg-rose-50/95'}`
    if (attention?.tone === 'warn') return `${base} ${isDark ? 'bg-amber-500/10' : 'bg-amber-50/95'}`
    if (attention?.tone === 'info') return `${base} ${isDark ? 'bg-violet-500/10' : 'bg-violet-50/95'}`

    switch (node.health) {
        case 'online':
            return `${base} ${isDark ? (isActive ? 'bg-emerald-500/10' : 'bg-emerald-500/8') : (isActive ? 'bg-emerald-50' : 'bg-emerald-50/95')}`
        case 'dirty':
            return `${base} ${isDark ? 'bg-amber-500/8' : 'bg-amber-50/95'}`
        case 'degraded':
            return `${base} ${isDark ? 'bg-rose-500/10' : 'bg-rose-50/95'}`
        case 'wrong_branch':
            return `${base} ${isDark ? 'bg-violet-500/10' : 'bg-violet-50/95'}`
        case 'offline':
            return `${base} ${isDark ? 'bg-slate-500/10' : 'bg-slate-100/90'}`
        default:
            return `${base} ${isDark ? 'bg-slate-950/78' : 'bg-white/96'}`
    }
}

function getBadgeClasses(kind: 'health' | 'dirty' | 'conflict' | 'orphan' | 'meta' | 'submodule', isDark: boolean): string {
    switch (kind) {
        case 'health':
            return isDark
                ? 'border-white/10 bg-slate-950/60 text-slate-200'
                : 'border-slate-300 bg-white/95 text-slate-700'
        case 'dirty':
            return isDark
                ? 'border-amber-400/25 bg-amber-500/10 text-amber-200'
                : 'border-amber-300 bg-amber-50 text-amber-700'
        case 'conflict':
            return isDark
                ? 'border-rose-400/25 bg-rose-500/10 text-rose-200'
                : 'border-rose-300 bg-rose-50 text-rose-700'
        case 'orphan':
            return isDark
                ? 'border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-200'
                : 'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700'
        case 'submodule':
            return isDark
                ? 'border-violet-400/25 bg-violet-500/10 text-violet-200'
                : 'border-violet-300 bg-violet-50 text-violet-700'
        case 'meta':
        default:
            return isDark
                ? 'border-cyan-400/20 bg-cyan-500/8 text-cyan-100'
                : 'border-sky-300 bg-sky-50 text-sky-700'
    }
}

function getAttentionBadgeClasses(tone: 'good' | 'warn' | 'danger' | 'info', isDark: boolean): string {
    switch (tone) {
        case 'danger':
            return isDark
                ? 'border-rose-400/35 bg-rose-500/14 text-rose-50'
                : 'border-rose-300 bg-rose-50 text-rose-700'
        case 'warn':
            return isDark
                ? 'border-amber-400/35 bg-amber-500/14 text-amber-50'
                : 'border-amber-300 bg-amber-50 text-amber-700'
        case 'info':
            return isDark
                ? 'border-violet-400/35 bg-violet-500/14 text-violet-50'
                : 'border-violet-300 bg-violet-50 text-violet-700'
        case 'good':
        default:
            return isDark
                ? 'border-emerald-400/35 bg-emerald-500/12 text-emerald-50'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700'
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

function formatSessionStatusLabel(session: MeshGraphNode['sessionDetails'][number]): string {
    const raw = (session.chatStatus || session.state || session.lifecycle || '').trim()
    if (!raw) return 'unknown'
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized.includes('approval')) return 'awaiting approval'
    if (normalized.includes('generating') || normalized.includes('running') || normalized.includes('busy')) return 'generating'
    if (normalized.includes('failed') || normalized.includes('stopped') || normalized.includes('interrupted')) return normalized.replace(/_/g, ' ')
    if (normalized.includes('idle') || normalized.includes('ready') || normalized.includes('waiting_input')) return 'idle'
    return normalized.replace(/_/g, ' ')
}

function hasGeneratingSession(node: MeshGraphNode): boolean {
    return node.sessionDetails?.some(s => formatSessionStatusLabel(s) === 'generating') ?? false
}

function getSessionStatusBadgeClasses(session: MeshGraphNode['sessionDetails'][number], isDark: boolean): string {
    const label = formatSessionStatusLabel(session)
    if (label.includes('approval')) {
        return isDark
            ? 'border-amber-400/30 bg-amber-500/12 text-amber-100'
            : 'border-amber-300 bg-amber-50 text-amber-700'
    }
    if (label === 'generating') {
        return isDark
            ? 'border-cyan-400/30 bg-cyan-500/12 text-cyan-100'
            : 'border-sky-300 bg-sky-50 text-sky-700'
    }
    if (label === 'idle') {
        return isDark
            ? 'border-emerald-400/30 bg-emerald-500/12 text-emerald-100'
            : 'border-emerald-300 bg-emerald-50 text-emerald-700'
    }
    if (label.includes('failed') || label.includes('stopped') || label.includes('interrupted')) {
        return isDark
            ? 'border-rose-400/30 bg-rose-500/12 text-rose-100'
            : 'border-rose-300 bg-rose-50 text-rose-700'
    }
    return getBadgeClasses('health', isDark)
}

function parseSessionTimeMs(value: string | null | undefined): number | null {
    if (!value) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

function formatElapsedSince(value: string | null | undefined): string {
    const timestamp = parseSessionTimeMs(value)
    if (timestamp === null) return 'runtime age not reported'
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
    if (elapsedSeconds < 60) return `${elapsedSeconds}s`
    const minutes = Math.floor(elapsedSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h ${minutes % 60}m`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
}

function shortSessionId(sessionId: string): string {
    if (sessionId.length <= 18) return sessionId
    return `${sessionId.slice(0, 10)}...${sessionId.slice(-4)}`
}

function getSessionRoleLabel(session: MeshGraphNode['sessionDetails'][number]): string {
    if (session.isSelfCoordinator) return 'coordinator'
    const role = typeof session.role === 'string' ? session.role.trim() : ''
    return role || 'worker'
}

function getSessionSummaryLabel(node: MeshGraphNode): string | null {
    if (node.sessionDetails.length === 0) return null
    const generatingCount = node.sessionDetails.filter(session => formatSessionStatusLabel(session) === 'generating').length
    const coordinatorCount = node.sessionDetails.filter(session => session.isSelfCoordinator).length
    const workerCount = node.sessionDetails.length - coordinatorCount
    const parts = [`${node.sessionDetails.length} chat${node.sessionDetails.length === 1 ? '' : 's'}`]
    if (generatingCount > 0) parts.push(`${generatingCount} generating`)
    if (coordinatorCount > 0) parts.push(coordinatorCount === 1 ? 'coordinator attached' : `${coordinatorCount} coordinators`)
    if (workerCount > 0) parts.push(`${workerCount} worker${workerCount === 1 ? '' : 's'}`)
    if (generatingCount === 0 && coordinatorCount > 0) parts.push('sampled status')
    return parts.join(' · ')
}

function formatLocality(locality: MeshGraphNode['locality']): string {
    if (locality === 'local') return 'local'
    if (locality === 'remote') return 'remote'
    return 'machine unknown'
}

function getLocalityBadgeKind(node: MeshGraphNode): 'meta' | 'health' {
    return node.locality === 'remote' ? 'meta' : 'health'
}

function MeshNodeCard({ data, selected }: NodeProps<FlowNode>) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const compact = useContext(MeshGraphCompactContext)
    const direction = useContext(MeshGraphDirectionContext)
    const node = data.graphNode
    const isDefaultBranchNode = node.type === 'defaultBranchNode'
    const isSubmoduleNode = node.type === 'submoduleNode'
    const shouldShowCallout = shouldShowMeshGraphCallout(node)
    const subtitle = isDefaultBranchNode
        ? 'default branch anchor'
        : isSubmoduleNode
            ? node.submodulePath || 'submodule checkout'
            : [node.machineLabel, formatLocality(node.locality)].filter(Boolean).join(' · ') || node.workspace
    const shortCommit = node.submoduleCommit ? node.submoduleCommit.slice(0, 7) : null
    const attentionBadge = getMeshGraphAttentionBadge(node)
    const calloutText = getMeshGraphCalloutText(node)
    const hasActiveSession = isNodeActive(node)
    const visibleSessions = node.sessionDetails
    const visibleCardSessions = node.sessionDetails
    const sessionSummaryLabel = getSessionSummaryLabel(node)
    const sessionTooltipLines = node.sessionDetails.map(session => {
        const status = formatSessionStatusLabel(session)
        const provider = session.providerType || 'provider unknown'
        const role = getSessionRoleLabel(session)
        const startedAt = session.startedAt || session.createdAt || null
        const note = session.statusNote ? ` · ${session.statusNote}` : ''
        return `Session: ${session.sessionId} · ${provider} · ${status} · ${role} · ${formatElapsedSince(startedAt)}${note}`
    })

    if (compact) {
        return (
            <div
                className={`rounded-xl border px-3 py-2.5 backdrop-blur-sm transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}`}
                style={{ width: getMeshGraphNodeCardWidth(node, true) }}
                title={[
                    node.label,
                    node.branch ? `Branch: ${node.branch}` : null,
                    node.machineLabel ? `Machine: ${node.machineLabel}` : null,
                    node.workspace ? `Workspace: ${node.workspace}` : null,
                    attentionBadge ? `Status: ${attentionBadge.label}` : null,
                    getNodeSummaryForLayout(node),
                    ...sessionTooltipLines,
                ].filter(Boolean).join('\n')}
            >
                <Handle type="target" position={direction === 'TB' ? Position.Top : Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        <div className={`truncate text-xs font-semibold leading-4 ${meshTheme.textPrimary}`}>{node.label}</div>
                        {!isDefaultBranchNode && (
                            <div className={`truncate text-[10px] leading-3.5 ${meshTheme.textMuted}`}>{subtitle}</div>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {hasActiveSession && (
                            <span className={`h-1.5 w-1.5 rounded-full ${meshTheme.isDark ? 'bg-emerald-400' : 'bg-emerald-500'} animate-pulse`} aria-label="active session" />
                        )}
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: getHealthDot(node.health) }}
                            aria-hidden
                        />
                    </div>
                </div>
                {node.health === 'unknown' && !attentionBadge && (
                    <div className={`mt-1.5 inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-0.5 text-[9px] italic ${getBadgeClasses('health', meshTheme.isDark)}`}>
                        <span className="truncate">Connecting...</span>
                    </div>
                )}
                {attentionBadge && (
                    <div className={`mt-1.5 inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`} title={attentionBadge.label}>
                        <span className="truncate">{attentionBadge.label}</span>
                    </div>
                )}
                {!attentionBadge && node.branch && !isSubmoduleNode && node.health !== 'unknown' && (
                    <div className={`mt-1 min-w-0 max-w-full truncate text-[10px] ${getBadgeClasses('meta', meshTheme.isDark)} rounded-full border px-2 py-0.5 inline-block`} title={node.branch}>
                        {node.branch}
                    </div>
                )}
                {sessionSummaryLabel && (
                    <div className={`mt-1 min-w-0 max-w-full truncate text-[9px] ${meshTheme.isDark ? 'text-cyan-100/85' : 'text-sky-700'}`} title={sessionTooltipLines.join('\n')}>
                        {sessionSummaryLabel}
                    </div>
                )}
                {visibleCardSessions.length > 0 && (
                    <div className="mt-1.5 flex max-h-28 min-w-0 flex-col gap-1 overflow-y-auto pr-1">
                        {visibleCardSessions.map(session => (
                            <div
                                key={session.sessionId}
                                className={`min-w-0 rounded-md border px-1.5 py-1 ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/[0.055]' : 'border-sky-200 bg-white/80'}`}
                                title={[
                                    `Session ID: ${session.sessionId}`,
                                    session.providerType ? `Provider: ${session.providerType}` : null,
                                    `Status: ${formatSessionStatusLabel(session)}`,
                                    `Role: ${getSessionRoleLabel(session)}`,
                                ].filter(Boolean).join('\n')}
                            >
                                <div className="flex min-w-0 items-center justify-between gap-1.5">
                                    <span className={`min-w-0 truncate text-[9px] ${meshTheme.textMuted}`}>
                                        {session.providerType || 'provider unknown'}
                                    </span>
                                    <span className={`shrink-0 rounded-full border px-1 py-0 text-[8px] font-semibold uppercase tracking-[0.1em] ${getSessionStatusBadgeClasses(session, meshTheme.isDark)}`}>
                                        {formatSessionStatusLabel(session)}
                                    </span>
                                </div>
                                <div className={`mt-0.5 flex min-w-0 items-center gap-1.5 text-[8px] ${meshTheme.textMuted}`}>
                                    <span className="min-w-0 truncate font-mono">{shortSessionId(session.sessionId)}</span>
                                    <span className="shrink-0">{getSessionRoleLabel(session)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <Handle type="source" position={direction === 'TB' ? Position.Bottom : Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
            </div>
        )
    }

    const tooltipLines = [
        node.label,
        subtitle,
        attentionBadge ? `Status: ${attentionBadge.label}` : null,
        getNodeSummaryForLayout(node),
        node.branch ? `Branch: ${node.branch}` : null,
        node.dirty ? (isSubmoduleNode ? 'Local changes' : `${node.dirtyFiles} dirty`) : null,
        node.hasConflicts ? 'Has conflicts' : null,
        node.outOfSync ? 'Out of sync' : null,
        !isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' ? 'Upstream unverified' : null,
        node.isOrphan ? 'Needs follow-up' : null,
        shouldShowCallout && calloutText ? `Note: ${calloutText}` : null,
        ...sessionTooltipLines,
    ].filter(Boolean).join('\n')

    return (
        <div
            className={`rounded-2xl border px-4 py-3 backdrop-blur-sm transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}${hasGeneratingSession(node) ? ' mesh-node-generating' : ''}`}
            style={{ width: getMeshGraphNodeCardWidth(node) }}
            title={tooltipLines}
        >
            <Handle
                type="target"
                position={direction === 'TB' ? Position.Top : Position.Left}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{node.label}</div>
                    <div className={`truncate text-[11px] ${meshTheme.textMuted}`}>{subtitle}</div>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 shrink-0">
                    {hasActiveSession && (
                        <span className={`h-2 w-2 rounded-full ${meshTheme.isDark ? 'bg-emerald-400' : 'bg-emerald-500'} animate-pulse`} aria-label="active session" />
                    )}
                    <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: getHealthDot(node.health) }}
                        aria-hidden
                    />
                </div>
            </div>

            {attentionBadge ? (
                <div className={`mt-2 inline-flex min-w-0 max-w-full items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`} title={attentionBadge.label}>
                    <span className="truncate">{attentionBadge.label}</span>
                </div>
            ) : node.branch && !isSubmoduleNode ? (
                <div className={`mt-2 inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] ${getBadgeClasses('meta', meshTheme.isDark)}`} title={node.branch}>
                    <span className="truncate">{node.branch}</span>
                </div>
            ) : null}

            {sessionSummaryLabel && (
                <div
                    className={`mt-2 inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${meshTheme.isDark ? 'border-cyan-400/20 bg-cyan-500/8 text-cyan-100' : 'border-sky-300 bg-sky-50 text-sky-700'}`}
                    title={sessionTooltipLines.join('\n')}
                >
                    <span className="truncate">{sessionSummaryLabel}</span>
                </div>
            )}

            {visibleCardSessions.length > 0 && (
                <div className="mt-2 flex max-h-44 min-w-0 flex-col gap-1.5 overflow-y-auto pr-1">
                    {visibleCardSessions.map(session => {
                        const roleLabel = getSessionRoleLabel(session)
                        return (
                            <div
                                key={session.sessionId}
                                className={`min-w-0 rounded-lg border px-2.5 py-1.5 ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/[0.055]' : 'border-sky-200 bg-white/85'}`}
                                title={[
                                    `Session ID: ${session.sessionId}`,
                                    session.providerType ? `Provider: ${session.providerType}` : null,
                                    `Status: ${formatSessionStatusLabel(session)}`,
                                    `Role: ${roleLabel}`,
                                ].filter(Boolean).join('\n')}
                            >
                                <div className="flex min-w-0 items-center justify-between gap-2">
                                    <span className={`min-w-0 truncate text-[10px] ${meshTheme.textMuted}`}>
                                        {session.providerType || 'provider unknown'}
                                    </span>
                                    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${getSessionStatusBadgeClasses(session, meshTheme.isDark)}`}>
                                        {formatSessionStatusLabel(session)}
                                    </span>
                                </div>
                                <div className={`mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[9px] ${meshTheme.textMuted}`}>
                                    <span className="min-w-0 truncate font-mono">{shortSessionId(session.sessionId)}</span>
                                    <span>{roleLabel}</span>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            <div className="mt-3">
                <div className="flex min-w-0 flex-wrap gap-1.5 text-[10px]">
                    {node.health === 'unknown' ? (
                        <span className={`rounded-full border px-2 py-0.5 italic ${getBadgeClasses('health', meshTheme.isDark)}`}>
                            connecting...
                        </span>
                    ) : (
                        <span className={`rounded-full border px-2 py-0.5 capitalize ${getBadgeClasses('health', meshTheme.isDark)}`}>
                            {formatHealth(node.health)}
                        </span>
                    )}
                    {isSubmoduleNode && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('submodule', meshTheme.isDark)}`}>
                            submodule
                        </span>
                    )}
                    {!isDefaultBranchNode && node.health === 'unknown' && !node.locality && (
                        <span className={`rounded-full border px-2 py-0.5 italic ${getBadgeClasses('health', meshTheme.isDark)}`}>
                            ...
                        </span>
                    )}
                    {!isDefaultBranchNode && (node.health !== 'unknown' || node.locality) && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses(getLocalityBadgeKind(node), meshTheme.isDark)}`}>
                            {formatLocality(node.locality)}
                        </span>
                    )}
                    {shortCommit && isSubmoduleNode && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('meta', meshTheme.isDark)}`}>
                            {shortCommit}
                        </span>
                    )}
                    {node.dirty && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('dirty', meshTheme.isDark)}`}>
                            {isSubmoduleNode ? 'local changes' : `${node.dirtyFiles} dirty`}
                        </span>
                    )}
                    {node.outOfSync && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict', meshTheme.isDark)}`}>
                            out of sync
                        </span>
                    )}
                    {node.hasConflicts && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict', meshTheme.isDark)}`}>
                            conflicts
                        </span>
                    )}
                    {!isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('orphan', meshTheme.isDark)}`}>
                            upstream unverified
                        </span>
                    )}
                    {node.isOrphan && (
                        <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('orphan', meshTheme.isDark)}`}>
                            needs follow-up
                        </span>
                    )}
                </div>

                <div className={`mt-3 text-[11px] leading-5 ${meshTheme.textSecondary}`} style={summaryTextStyle}>
                    {getNodeSummaryForLayout(node)}
                </div>

                {visibleSessions.length > 0 && (
                    <div className="mt-3">
                        <div className={`mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>
                            Attached Chats
                        </div>
                        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
                            {visibleSessions.map(session => {
                                const startedAt = session.startedAt || session.createdAt || null
                                const roleLabel = getSessionRoleLabel(session)
                                return (
                                    <div
                                        key={session.sessionId}
                                        className={`min-w-0 rounded-lg border px-2.5 py-1.5 ${meshTheme.isDark ? 'border-white/8 bg-white/[0.035]' : 'border-slate-200 bg-white/80'}`}
                                        title={[
                                            `Session ID: ${session.sessionId}`,
                                            session.providerType ? `Provider: ${session.providerType}` : null,
                                            `Status: ${formatSessionStatusLabel(session)}`,
                                            `Role: ${roleLabel}`,
                                            startedAt ? `Started: ${startedAt}` : 'Started: not reported',
                                            session.statusNote ? `Note: ${session.statusNote}` : null,
                                        ].filter(Boolean).join('\n')}
                                    >
                                        <div className="flex min-w-0 items-center justify-between gap-2">
                                            <span className={`min-w-0 truncate font-mono text-[10px] select-text ${meshTheme.textPrimary}`}>
                                                {shortSessionId(session.sessionId)}
                                            </span>
                                            <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${getSessionStatusBadgeClasses(session, meshTheme.isDark)}`}>
                                                {formatSessionStatusLabel(session)}
                                            </span>
                                        </div>
                                        <div className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[9px] ${meshTheme.textMuted}`}>
                                            <span className="truncate">{session.providerType || 'provider unknown'}</span>
                                            <span>{roleLabel}</span>
                                            <span>{formatElapsedSince(startedAt)}</span>
                                        </div>
                                        {session.statusNote && (
                                            <div className={`mt-1 text-[9px] leading-4 ${meshTheme.textMuted}`}>
                                                {session.statusNote}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )}

                {shouldShowCallout && calloutText && (
                    <div
                        className={`mt-3 rounded-xl border px-3 py-2 text-[10px] leading-4 ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/8 text-cyan-50/90' : 'border-sky-300 bg-sky-50 text-sky-700'}`}
                        style={calloutTextStyle}
                    >
                        {calloutText}
                    </div>
                )}
            </div>
            <Handle
                type="source"
                position={direction === 'TB' ? Position.Bottom : Position.Right}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
        </div>
    )
}

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
    const routePoints = args.data.routePoints
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
    const graphEdge = args.data.graphEdge

    let result: ReturnType<typeof getBezierPath>
    if (graphEdge.type === 'parentBranch') result = getStraightPath(pathParams)
    else if (graphEdge.type === 'worktreeLink' || graphEdge.type === 'submoduleLink' || graphEdge.type === 'cloneLink') result = getSmoothStepPath(pathParams)
    else result = getBezierPath(pathParams)
    return [result[0], result[1], result[2]]
}

function getEdgeLabelClasses(edge: MeshGraphEdge, isDark: boolean): string {
    const base = 'nodrag nopan rounded-md border px-2 py-1 text-[10px] font-semibold shadow-sm backdrop-blur-sm'
    switch (edge.type) {
        case 'orphanLink':
            return isDark
                ? `${base} border-orange-400/35 bg-orange-500/14 text-orange-100`
                : `${base} border-orange-300 bg-orange-50 text-orange-700`
        case 'submoduleLink':
            return isDark
                ? `${base} border-violet-400/30 bg-violet-500/14 text-violet-100`
                : `${base} border-violet-300 bg-violet-50 text-violet-700`
        case 'sessionLink':
            return isDark
                ? `${base} border-emerald-400/30 bg-emerald-500/14 text-emerald-100`
                : `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
        case 'cloneLink':
            return isDark
                ? `${base} border-teal-400/30 bg-teal-500/14 text-teal-100`
                : `${base} border-teal-300 bg-teal-50 text-teal-700`
        default:
            return isDark
                ? `${base} border-sky-400/25 bg-slate-950/78 text-sky-100`
                : `${base} border-sky-300 bg-white/95 text-sky-700`
    }
}

function MeshGraphEdgeLine(args: EdgeProps<FlowEdge>) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const graphEdge = args.data.graphEdge
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
            {args.label && (
                <EdgeLabelRenderer>
                    <div
                        className={getEdgeLabelClasses(graphEdge, meshTheme.isDark)}
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

async function buildLayout(data: MeshGraphData, meshTheme = getMeshGraphTheme('dark'), compact = false, direction: MeshGraphDirection = 'LR'): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
    const layout = await buildMeshGraphLayout(data, compact, direction)
    const layoutNodeIds = new Set(layout.nodes.map(node => node.id))
    const flowNodes: FlowNode[] = layout.nodes.map(node => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: { graphNode: node.graphNode, compact },
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
        animated: edge.type === 'orphanLink',
        markerEnd: edge.direction === 'directed'
            ? {
                type: MarkerType.ArrowClosed,
                width: edge.type === 'submoduleLink' ? 16 : 18,
                height: edge.type === 'submoduleLink' ? 16 : 18,
                color: edgeColor(edge),
            }
            : undefined,
        style: {
            stroke: edgeColor(edge),
            strokeWidth: edge.type === 'orphanLink' ? 2.25 : edge.type === 'submoduleLink' ? 1.7 : edge.type === 'worktreeLink' ? 1.8 : edge.type === 'cloneLink' ? 1.6 : 2,
            strokeDasharray: edge.type === 'orphanLink' ? '5 4' : edge.type === 'submoduleLink' ? '4 3' : edge.type === 'cloneLink' ? '6 3' : undefined,
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
        case 'submoduleLink':
            return '#c084fc'
        case 'cloneLink':
            return '#2dd4bf'
        default:
            return '#64748b'
    }
}

function minimapNodeColor(node: FlowNode): string {
    const graphNode = node.data.graphNode
    if (graphNode.locality === 'local') return '#38bdf8'
    switch (graphNode.health) {
        case 'online':
            return '#34d399'
        case 'dirty':
            return '#fbbf24'
        case 'degraded':
        case 'offline':
            return '#fb7185'
        case 'wrong_branch':
            return '#a78bfa'
        default:
            return '#94a3b8'
    }
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
            const shouldFocusSubset = initialFocusNodeIds.length > 0 && initialFocusNodeIds.length < data.nodes.length
            void reactFlow.fitView({
                nodes: shouldFocusSubset ? initialFocusNodeIds.map(id => ({ id })) : undefined,
                padding: shouldFocusSubset ? 0.24 : 0.2,
                maxZoom: shouldFocusSubset ? 0.98 : 0.9,
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

function getGraphMinHeightClass(nodeCount: number): string {
    if (nodeCount >= 16) return 'min-h-[720px]'
    if (nodeCount >= 10) return 'min-h-[580px]'
    return 'min-h-[460px]'
}

type DirectionPref = 'auto' | 'LR' | 'TB'

const MINIMAP_NODE_THRESHOLD = 12

export default function MeshGraphView({
    data,
    selectedNodeId = null,
    onNodeClick,
    onNodeHoverChange,
    onEdgeHoverChange,
}: MeshGraphViewProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const dataFingerprint = useMemo(() => getMeshGraphDataFingerprint(data), [data])
    const layoutFingerprint = useMemo(() => getMeshGraphLayoutFingerprint(data), [data])
    const compact = data.nodes.length >= COMPACT_NODE_THRESHOLD
    const [directionPref, setDirectionPref] = useState<DirectionPref>('LR')
    const direction: MeshGraphDirection = useMemo(
        () => (directionPref === 'auto' ? pickMeshGraphDirection(data) : directionPref),
        [directionPref, dataFingerprint, data],
    )
    const showMinimap = data.nodes.length >= MINIMAP_NODE_THRESHOLD
    const [layout, setLayout] = useState<{ nodes: FlowNode[]; edges: FlowEdge[] }>({ nodes: [], edges: [] })
    const surfaceRef = useRef<HTMLDivElement | null>(null)
    const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
    const viewportKey = useMemo(
        () => `${getMeshGraphViewportKey(data, surfaceSize.width, surfaceSize.height)}::${direction}`,
        [dataFingerprint, data, surfaceSize.height, surfaceSize.width, direction],
    )

    useEffect(() => {
        let cancelled = false
        void buildLayout(data, meshTheme, compact, direction).then(nextLayout => {
            if (!cancelled) setLayout(nextLayout)
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

    const graphMinHeightClass = getGraphMinHeightClass(data.nodes.length)

    const directionToggleButtonClass = (active: boolean) =>
        active
            ? meshTheme.isDark
                ? 'rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 py-0.5 text-cyan-100'
                : 'rounded-md border border-sky-400 bg-sky-100 px-2 py-0.5 text-sky-800'
            : meshTheme.isDark
                ? 'rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-slate-400 hover:text-slate-200'
                : 'rounded-md border border-slate-300 bg-white/80 px-2 py-0.5 text-slate-500 hover:text-slate-800'

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <MeshGraphCompactContext.Provider value={compact}>
        <MeshGraphDirectionContext.Provider value={direction}>
        <div ref={surfaceRef} className={meshTheme.graphShellClass}>
            <div className={`shrink-0 flex flex-wrap items-center justify-between gap-2 px-3 pt-3 pb-2 text-[11px] ${meshTheme.textSecondary}`}>
                <div className="flex flex-wrap gap-2">
                    <span className={meshTheme.graphStatChipClass}>
                        {data.stats.totalNodes} node{data.stats.totalNodes === 1 ? '' : 's'}
                    </span>
                    {data.stats.totalActiveSessions > 0 && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-emerald-400/25 bg-emerald-500/12 px-3 py-1 text-emerald-100' : 'rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-emerald-700'}>
                            {data.stats.totalActiveSessions} active session{data.stats.totalActiveSessions === 1 ? '' : 's'}
                        </span>
                    )}
                    {data.stats.orphanNodes > 0 && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-orange-400/25 bg-orange-500/12 px-3 py-1 text-orange-100' : 'rounded-full border border-orange-300 bg-orange-50 px-3 py-1 text-orange-700'}>
                            {data.stats.orphanNodes} need attention
                        </span>
                    )}
                    {compact && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-slate-400' : 'rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1 text-slate-500'}>
                            dense view · hover for details
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <div
                        className={meshTheme.isDark
                            ? 'flex items-center gap-0.5 rounded-md border border-white/10 bg-slate-950/40 p-0.5 text-[10px]'
                            : 'flex items-center gap-0.5 rounded-md border border-slate-300 bg-white/70 p-0.5 text-[10px]'}
                        role="group"
                        aria-label="Graph layout direction"
                    >
                        <button type="button" onClick={() => setDirectionPref('auto')} className={directionToggleButtonClass(directionPref === 'auto')} title={`Auto (currently ${direction === 'TB' ? 'top-bottom' : 'left-right'})`}>
                            Auto
                        </button>
                        <button type="button" onClick={() => setDirectionPref('LR')} className={directionToggleButtonClass(directionPref === 'LR')} title="Left to right">
                            LR
                        </button>
                        <button type="button" onClick={() => setDirectionPref('TB')} className={directionToggleButtonClass(directionPref === 'TB')} title="Top to bottom">
                            TB
                        </button>
                    </div>
                    <div className={meshTheme.graphHintChipClass}>
                        {compact ? 'drag or scroll to pan' : 'drag or scroll to pan'}
                    </div>
                </div>
            </div>
            <div className={`w-full min-w-0 flex-1 min-h-0 ${graphMinHeightClass}`}>
                <ReactFlow<FlowNode, FlowEdge>
                    nodes={nodes}
                    edges={layout.edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    minZoom={0.18}
                    maxZoom={1.35}
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
                    onNodeMouseEnter={(_, node) => onNodeHoverChange?.(node.data.graphNode)}
                    onNodeMouseLeave={() => onNodeHoverChange?.(null)}
                    onEdgeMouseEnter={(_, edge) => onEdgeHoverChange?.(edge.data?.graphEdge ?? null)}
                    onEdgeMouseLeave={() => onEdgeHoverChange?.(null)}
                    className="h-full w-full"
                    colorMode={meshTheme.flowColorMode}
                    proOptions={{ hideAttribution: true }}
                >
                    <MeshViewportController data={data} viewportKey={viewportKey} />
                    <Controls className={meshTheme.graphControlsClass} position="bottom-left" showZoom showFitView showInteractive={false} />
                    {showMinimap && (
                        <MiniMap
                            position="bottom-right"
                            pannable
                            zoomable
                            nodeColor={minimapNodeColor}
                            nodeClassName={minimapNodeClassName}
                            nodeStrokeWidth={3}
                            className={meshTheme.isDark ? 'overflow-hidden rounded-xl border border-white/10 bg-slate-950/85' : 'overflow-hidden rounded-xl border border-slate-200 bg-white/95'}
                        />
                    )}
                    <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color={meshTheme.graphBackgroundDotColor} />
                </ReactFlow>
            </div>
        </div>
        </MeshGraphDirectionContext.Provider>
        </MeshGraphCompactContext.Provider>
        </MeshGraphThemeContext.Provider>
    )
}
