/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
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
    formatMeshGraphAheadBehindLocalized,
    MESH_GRAPH_EDGE_LABEL,
    getMeshGraphNodeCardWidth,
    getNodeSummaryForLayout,
    type MeshGraphDirection,
    type MeshGraphLayoutEdgePoint,
} from './meshGraphLayout'
import { getMeshGraphDataFingerprint, getMeshGraphLayoutFingerprint } from './meshGraphMemo'
import { formatMeshConnectionRtt, formatMeshConnectionTransport } from '../../utils/mesh-visualization'
import { sessionElapsedLabel } from './MeshObservabilitySurface/meshSurfaceHelpers'
import { IconGitBranch } from '../Icons'
import { requestOpenSessionChat } from '../../utils/session-nav'

/** Dense graph threshold: above this node count, switch to compact card mode */
const COMPACT_NODE_THRESHOLD = 7

/**
 * Max per-session rows rendered on a node card. The unbounded scrollable list
 * made busy nodes tower over the rest of the graph; overflow collapses to a
 * "+N more chats" line (full detail stays in the tooltip and the drill-down panel).
 */
const CARD_SESSION_ROW_CAP = 2

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
/**
 * True when the graph spans more than one machine. On a single-machine mesh the
 * machine label adds nothing (every card would repeat it — the "duplicate local
 * machine" smell), so cards fall back to the workspace path for context.
 */
const MeshGraphMultiMachineContext = createContext(true)

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

    // Same card family as the task-DAG view: flat shadow-sm + ring selection.
    // The old bespoke multi-layer glows made the two graph surfaces read as
    // different design systems.
    let base: string
    if (selected) {
        base = isDark
            ? 'border-cyan-400/60 ring-2 ring-cyan-300/60 shadow-sm'
            : 'border-sky-400 ring-2 ring-sky-400/70 shadow-sm'
    } else if (isActive) {
        base = isDark ? 'border-emerald-400/40 shadow-sm' : 'border-emerald-400/60 shadow-sm'
    } else if (isStale) {
        base = isDark ? 'border-white/6 shadow-sm opacity-60' : 'border-slate-200/70 shadow-sm opacity-60'
    } else {
        base = isDark ? 'border-white/10 shadow-sm' : 'border-slate-300/90 shadow-sm'
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

function getBadgeClasses(kind: 'health' | 'dirty' | 'conflict' | 'orphan' | 'meta' | 'submodule' | 'refineDone', isDark: boolean): string {
    switch (kind) {
        case 'refineDone':
            return isDark
                ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700'
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

/**
 * SHOW-TASK-DIFFICULTY: session.difficulty is joined from the queue task the
 * session is executing (buildMeshGraph, mesh-visualization.ts) — the session
 * axis itself carries no difficulty. Mirrors getSessionStatusBadgeClasses'
 * severity coloring (emerald=cheap → rose=expensive); 'freeform' has no fixed
 * shape so it isn't a severity level and stays neutral.
 */
function getDifficultyBadgeClasses(difficulty: string, isDark: boolean): string {
    switch (difficulty) {
        case 'easy':
            return isDark
                ? 'border-emerald-400/30 bg-emerald-500/12 text-emerald-100'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700'
        case 'medium':
            return isDark
                ? 'border-amber-400/30 bg-amber-500/12 text-amber-100'
                : 'border-amber-300 bg-amber-50 text-amber-700'
        case 'difficult':
            return isDark
                ? 'border-rose-400/30 bg-rose-500/12 text-rose-100'
                : 'border-rose-300 bg-rose-50 text-rose-700'
        default:
            return getBadgeClasses('health', isDark)
    }
}

function difficultyLabel(difficulty: string, t: (key: string) => string): string {
    switch (difficulty) {
        case 'easy': return t('meshGraph.difficulty.easy')
        case 'medium': return t('meshGraph.difficulty.medium')
        case 'difficult': return t('meshGraph.difficulty.difficult')
        case 'freeform': return t('meshGraph.difficulty.freeform')
        default: return difficulty
    }
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

function getSessionSummaryLabel(node: MeshGraphNode, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
    if (node.sessionDetails.length === 0) return null
    const generatingCount = node.sessionDetails.filter(session => formatSessionStatusLabel(session) === 'generating').length
    const coordinatorCount = node.sessionDetails.filter(session => session.isSelfCoordinator).length
    const workerCount = node.sessionDetails.length - coordinatorCount
    const parts = [t('meshGraph.panel.chats', { count: node.sessionDetails.length })]
    if (generatingCount > 0) parts.push(t('meshGraph.panel.generatingCount', { count: generatingCount }))
    if (coordinatorCount > 0) parts.push(coordinatorCount === 1 ? t('meshGraph.panel.coordinatorAttached') : t('meshGraph.panel.coordinators', { count: coordinatorCount }))
    if (workerCount > 0) parts.push(t('meshGraph.panel.workers', { count: workerCount }))
    if (generatingCount === 0 && coordinatorCount > 0) parts.push(t('meshGraph.panel.sampledStatus'))
    return parts.join(' · ')
}

/**
 * Attention badge labels come from the pure view-model as canonical English
 * (tests pin them there); the render layer maps the finite label set onto i18n
 * keys. Dynamic ahead/behind drift labels are re-derived via the localized
 * formatter; anything unknown falls through untranslated.
 */
const ATTENTION_LABEL_KEYS: Record<string, string> = {
    'submodule drift': 'meshGraph.attention.submoduleDrift',
    'submodule dirty': 'meshGraph.attention.submoduleDirty',
    'conflicts present': 'meshGraph.attention.conflictsPresent',
    'dirty workspace': 'meshGraph.attention.dirtyWorkspace',
    'upstream unverified': 'meshGraph.attention.upstreamUnverified',
    'push branch': 'meshGraph.attention.pushBranch',
    'blocked review': 'meshGraph.attention.blockedReview',
    'refine failed': 'meshGraph.attention.refineFailed',
    'refining…': 'meshGraph.attention.refining',
    'needs merge': 'meshGraph.attention.needsMerge',
    'refine worktree': 'meshGraph.attention.refineWorktree',
    'needs follow-up': 'meshGraph.attention.needsFollowUp',
    'offline': 'meshGraph.attention.offline',
}

function translateAttentionLabel(label: string, node: MeshGraphNode, t: (key: string, opts?: Record<string, unknown>) => string): string {
    const key = ATTENTION_LABEL_KEYS[label]
    if (key) return t(key)
    const drift = formatMeshGraphAheadBehindLocalized(node, t)
    if (drift && /^(ahead|behind) /.test(label)) return drift
    return label
}

/** Last two path segments of a workspace — enough to identify a checkout without the noise of the full path. */
function formatWorkspaceTail(workspace: string | null | undefined): string {
    const raw = (workspace || '').trim().replace(/[\\/]+$/, '')
    if (!raw) return ''
    const segments = raw.split(/[\\/]+/).filter(Boolean)
    return segments.slice(-2).join('/')
}

function MeshNodeCard({ data, selected }: NodeProps<FlowNode>) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const compact = useContext(MeshGraphCompactContext)
    const direction = useContext(MeshGraphDirectionContext)
    const multiMachine = useContext(MeshGraphMultiMachineContext)
    const node = data.graphNode
    const isDefaultBranchNode = node.type === 'defaultBranchNode'
    const isSubmoduleNode = node.type === 'submoduleNode'
    const shouldShowCallout = shouldShowMeshGraphCallout(node)
    // Card context line. Machine identity only earns a spot when the graph spans
    // machines (single-machine meshes were repeating the same machine name on
    // every card); locality only when it is the exceptional case (remote).
    const machineContext = [node.machineLabel, node.locality === 'remote' ? t('meshGraph.panel.remote') : null].filter(Boolean).join(' · ')
    const workspaceTail = formatWorkspaceTail(node.workspace)
    const subtitle = multiMachine
        ? (machineContext || workspaceTail || node.workspace)
        : (workspaceTail || machineContext || node.workspace)
    const shortCommit = node.submoduleCommit ? node.submoduleCommit.slice(0, 7) : null

    // ── Default-branch anchor: a compact branch pill, not a machine-like card.
    //    A full card here read as "another machine named main" — the anchor is a
    //    branch concept, so it gets a visually distinct, minimal shape. ──
    if (isDefaultBranchNode) {
        const attention = getMeshGraphAttentionBadge(node)
        return (
            <div
                className={`rounded-full border px-4 py-2.5 transition-all ${meshTheme.isDark
                    ? `border-sky-400/40 bg-sky-500/10 ${selected ? 'ring-2 ring-cyan-300/60' : ''}`
                    : `border-sky-400 bg-sky-50 ${selected ? 'ring-2 ring-sky-400/70' : ''}`}`}
                style={{ width: getMeshGraphNodeCardWidth(node, compact) }}
                title={[node.label, getNodeSummaryForLayout(node, t), attention ? translateAttentionLabel(attention.label, node, t) : null].filter(Boolean).join('\n')}
            >
                <Handle type="target" position={direction === 'TB' ? Position.Top : Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
                <div className="flex min-w-0 items-center justify-center gap-2">
                    <span className={`shrink-0 text-sm ${meshTheme.isDark ? 'text-sky-200' : 'text-sky-600'}`} aria-hidden><IconGitBranch size={13} /></span>
                    <span className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{node.label}</span>
                    <span className={`shrink-0 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('meshGraph.panel.defaultBranch')}</span>
                    {attention && (
                        <span className={`shrink-0 h-2 w-2 rounded-full ${attention.tone === 'danger' ? 'bg-rose-400' : attention.tone === 'warn' ? 'bg-amber-400' : 'bg-sky-400'}`} title={translateAttentionLabel(attention.label, node, t)} aria-hidden />
                    )}
                </div>
                <Handle type="source" position={direction === 'TB' ? Position.Bottom : Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
            </div>
        )
    }

    // ── Submodule: micro card. One per parent checkout is semantically necessary
    //    (each checkout has its own submodule state), but full machine-card chrome
    //    made N checkouts × M submodules read as a wall of duplicate machines. ──
    if (isSubmoduleNode) {
        const stateLabel = node.outOfSync
            ? t('meshGraph.panel.outOfSyncBadge')
            : node.dirty
                ? t('meshGraph.panel.tooltipLocalChanges')
                : t('meshGraph.panel.submoduleSynced')
        const stateClass = node.outOfSync
            ? getBadgeClasses('conflict', meshTheme.isDark)
            : node.dirty
                ? getBadgeClasses('dirty', meshTheme.isDark)
                : getBadgeClasses('submodule', meshTheme.isDark)
        return (
            <div
                className={`rounded-xl border px-3 py-2 transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}`}
                style={{ width: getMeshGraphNodeCardWidth(node, compact) }}
                title={[
                    node.label,
                    node.submodulePath && node.submodulePath !== node.label ? node.submodulePath : null,
                    node.nextStepHint || null,
                    shortCommit ? `@ ${shortCommit}` : null,
                ].filter(Boolean).join('\n')}
            >
                <Handle type="target" position={direction === 'TB' ? Position.Top : Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: getHealthDot(node.health) }} aria-hidden />
                        <span className={`truncate text-xs font-semibold ${meshTheme.textPrimary}`}>{node.label}</span>
                    </span>
                    {shortCommit && (
                        <span className={`shrink-0 font-mono text-4xs ${meshTheme.textMuted}`}>{shortCommit}</span>
                    )}
                </div>
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                    <span className={`shrink-0 rounded-full border px-1.5 py-px text-4xs ${stateClass}`}>{stateLabel}</span>
                    {node.submodulePath && node.submodulePath !== node.label && (
                        <span className={`min-w-0 truncate text-4xs ${meshTheme.textMuted}`}>{node.submodulePath}</span>
                    )}
                </div>
                <Handle type="source" position={direction === 'TB' ? Position.Bottom : Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
            </div>
        )
    }
    // P2P connectivity is shown as per-node chips (transport: direct/relay, RTT),
    // not as a coordinator→node graph edge. Both are null for the local
    // coordinator (self/local transport) and for nodes that have not reported a
    // transport yet, so no chip renders in those cases.
    const isConnectionChipEligible = !isSubmoduleNode && !isDefaultBranchNode && node.connectionState !== 'self'
    const transportLabel = isConnectionChipEligible ? formatMeshConnectionTransport(node) : null
    const connectionTransport = transportLabel === 'local' ? null : transportLabel
    const connectionRtt = isConnectionChipEligible ? formatMeshConnectionRtt(node) : null
    const attentionBadge = getMeshGraphAttentionBadge(node)
    const calloutText = getMeshGraphCalloutText(node)
    const hasActiveSession = isNodeActive(node)
    const visibleSessions = node.sessionDetails
    const visibleCardSessions = node.sessionDetails
    const sessionSummaryLabel = getSessionSummaryLabel(node, t)
    const attentionLabel = attentionBadge ? translateAttentionLabel(attentionBadge.label, node, t) : null
    const nodeSummary = getNodeSummaryForLayout(node, t)
    const sessionTooltipLines = node.sessionDetails.map(session => {
        const status = formatSessionStatusLabel(session)
        const provider = session.providerType || 'provider unknown'
        const role = getSessionRoleLabel(session)
        const startedAt = session.startedAt || session.createdAt || null
        const difficulty = session.difficulty ? ` · ${difficultyLabel(session.difficulty, t)}` : ''
        const note = session.statusNote ? ` · ${session.statusNote}` : ''
        return `Session: ${session.sessionId} · ${provider} · ${status} · ${role}${difficulty} · ${formatElapsedSince(startedAt)}${note}`
    })

    if (compact) {
        return (
            <div
                className={`rounded-xl border px-3 py-2.5 transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}`}
                style={{ width: getMeshGraphNodeCardWidth(node, true) }}
                title={[
                    node.label,
                    node.branch ? `${t('meshGraph.panel.tooltipPrefixBranch')} ${node.branch}` : null,
                    node.machineLabel ? `Machine: ${node.machineLabel}` : null,
                    node.workspace ? `Workspace: ${node.workspace}` : null,
                    attentionBadge ? `${t('meshGraph.panel.tooltipPrefixStatus')} ${attentionLabel}` : null,
                    nodeSummary,
                    ...sessionTooltipLines,
                ].filter(Boolean).join('\n')}
            >
                <Handle type="target" position={direction === 'TB' ? Position.Top : Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        {/* Truncated labels get the full name as a hover tooltip. */}
                        <div className={`truncate text-xs font-semibold leading-4 ${meshTheme.textPrimary}`} title={node.label}>{node.label}</div>
                        {!isDefaultBranchNode && (
                            <div className={`truncate text-3xs leading-3.5 ${meshTheme.textMuted}`} title={subtitle}>{subtitle}</div>
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
                    <div className={`mt-1.5 inline-flex min-w-0 max-w-full items-center rounded-full border px-1.5 py-px text-4xs italic ${getBadgeClasses('health', meshTheme.isDark)}`}>
                        <span className="truncate">{t('meshGraph.obs.connecting')}</span>
                    </div>
                )}
                {attentionBadge && (
                    <div className={`mt-1.5 inline-flex min-w-0 max-w-full items-center rounded-full border px-1.5 py-px text-4xs font-semibold uppercase tracking-[0.14em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`} title={attentionLabel}>
                        <span className="truncate">{attentionLabel}</span>
                    </div>
                )}
                {!attentionBadge && node.branch && !isSubmoduleNode && node.health !== 'unknown' && (
                    <div className={`mt-1 min-w-0 max-w-full truncate text-3xs ${getBadgeClasses('meta', meshTheme.isDark)} rounded-full border px-1.5 py-px inline-block`} title={node.branch}>
                        {node.branch}
                    </div>
                )}
                {sessionSummaryLabel && (
                    <div className={`mt-1 min-w-0 max-w-full truncate text-4xs ${meshTheme.isDark ? 'text-cyan-100/85' : 'text-sky-700'}`} title={sessionTooltipLines.join('\n')}>
                        {sessionSummaryLabel}
                    </div>
                )}
                {visibleCardSessions.length > 0 && (
                    <div className="mt-1.5 flex min-w-0 flex-col gap-1">
                        {visibleCardSessions.slice(0, CARD_SESSION_ROW_CAP).map(session => (
                            <div
                                key={session.sessionId}
                                // Session rows double as chat links: the session-nav bus
                                // resolves the tab and closes this dialog. stopPropagation
                                // keeps the click from also selecting the node card.
                                onClick={event => { event.stopPropagation(); requestOpenSessionChat({ sessionId: session.sessionId, source: 'mesh-topology-card' }) }}
                                className={`min-w-0 cursor-pointer rounded-md border px-1.5 py-1 transition-colors ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/[0.055] hover:bg-cyan-500/[0.12]' : 'border-sky-200 bg-white/80 hover:bg-sky-50'}`}
                                title={[
                                    t('sessionNav.openChatHint'),
                                    `Session ID: ${session.sessionId}`,
                                    session.providerType ? `Provider: ${session.providerType}` : null,
                                    `${t('meshGraph.panel.tooltipPrefixStatus')} ${formatSessionStatusLabel(session)}`,
                                    `Role: ${getSessionRoleLabel(session)}`,
                                    session.difficulty ? `${t('mesh.overview.routingDifficulty')}: ${difficultyLabel(session.difficulty, t)}` : null,
                                ].filter(Boolean).join('\n')}
                            >
                                <div className="flex min-w-0 items-center justify-between gap-1.5">
                                    <span className={`min-w-0 truncate text-4xs ${meshTheme.textMuted}`}>
                                        {session.providerType || t('meshGraph.panel.providerUnknown')}
                                    </span>
                                    <span className={`shrink-0 rounded-full border px-1 py-0 text-5xs font-semibold uppercase tracking-[0.1em] ${getSessionStatusBadgeClasses(session, meshTheme.isDark)}`}>
                                        {formatSessionStatusLabel(session)}
                                    </span>
                                </div>
                                {/* Role + age — the raw session id says nothing at a glance
                                    and stays available in the tooltip above. */}
                                <div className={`mt-0.5 flex min-w-0 items-center gap-1.5 text-5xs ${meshTheme.textMuted}`}>
                                    <span className="shrink-0">{getSessionRoleLabel(session)}</span>
                                    <span className="min-w-0 truncate tabular-nums">{sessionElapsedLabel(session).includes('not reported') ? '' : sessionElapsedLabel(session)}</span>
                                </div>
                            </div>
                        ))}
                        {visibleCardSessions.length > CARD_SESSION_ROW_CAP && (
                            <div className={`text-5xs ${meshTheme.textMuted}`} title={sessionTooltipLines.join('\n')}>
                                {t('meshGraph.panel.moreChats', { count: visibleCardSessions.length - CARD_SESSION_ROW_CAP })}
                            </div>
                        )}
                    </div>
                )}
                <Handle type="source" position={direction === 'TB' ? Position.Bottom : Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
            </div>
        )
    }

    const tooltipLines = [
        node.label,
        subtitle,
        attentionBadge ? `${t('meshGraph.panel.tooltipPrefixStatus')} ${attentionLabel}` : null,
        nodeSummary,
        node.branch ? `${t('meshGraph.panel.tooltipPrefixBranch')} ${node.branch}` : null,
        node.dirty ? (isSubmoduleNode ? t('meshGraph.panel.tooltipLocalChanges') : `${node.dirtyFiles} dirty`) : null,
        node.hasConflicts ? t('meshGraph.panel.tooltipHasConflicts') : null,
        node.outOfSync ? t('meshGraph.panel.tooltipOutOfSync') : null,
        !isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' ? t('meshGraph.panel.tooltipUpstreamUnverified') : null,
        node.isOrphan ? t('meshGraph.panel.tooltipNeedsFollowUp') : null,
        shouldShowCallout && calloutText ? `${t('meshGraph.panel.tooltipPrefixNote')} ${calloutText}` : null,
        ...sessionTooltipLines,
    ].filter(Boolean).join('\n')

    return (
        <div
            className={`rounded-2xl border px-4 py-3 transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}${hasGeneratingSession(node) ? ' mesh-node-generating' : ''}`}
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
                    <div className={`truncate text-2xs ${meshTheme.textMuted}`}>{subtitle}</div>
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
                <div className={`mt-2 inline-flex min-w-0 max-w-full items-center rounded-full border px-2.5 py-0.5 text-3xs font-semibold uppercase tracking-[0.14em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`} title={attentionLabel}>
                    <span className="truncate">{attentionLabel}</span>
                </div>
            ) : node.branch && !isSubmoduleNode ? (
                <div className={`mt-2 inline-flex min-w-0 max-w-full items-center rounded-full border px-1.5 py-px text-3xs ${getBadgeClasses('meta', meshTheme.isDark)}`} title={node.branch}>
                    <span className="truncate">{node.branch}</span>
                </div>
            ) : null}

            {sessionSummaryLabel && (
                <div
                    className={`mt-2 inline-flex min-w-0 max-w-full items-center rounded-full border px-1.5 py-px text-3xs font-medium ${meshTheme.isDark ? 'border-cyan-400/20 bg-cyan-500/8 text-cyan-100' : 'border-sky-300 bg-sky-50 text-sky-700'}`}
                    title={sessionTooltipLines.join('\n')}
                >
                    <span className="truncate">{sessionSummaryLabel}</span>
                </div>
            )}

            {/* The per-session mini-list that used to render HERE was a duplicate of
                the "attached chats" list below — the same sessions appeared twice on
                one card. The summary pill above + the labeled list below remain. */}

            <div className="mt-3">
                <div className="flex min-w-0 flex-wrap gap-1 text-4xs">
                    {/* Health pill only when it says something the dot cannot: online is
                        the normal state and stays dot-only, so the badge row is quiet on
                        a healthy mesh and loud exactly where something is off. */}
                    {node.health === 'unknown' ? (
                        <span className={`rounded-full border px-1.5 py-px italic ${getBadgeClasses('health', meshTheme.isDark)}`}>
                            {t('meshGraph.obs.connecting')}
                        </span>
                    ) : node.health !== 'online' ? (
                        <span className={`rounded-full border px-1.5 py-px capitalize ${getBadgeClasses('health', meshTheme.isDark)}`}>
                            {formatHealth(node.health)}
                        </span>
                    ) : null}
                    {node.locality === 'remote' && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('meta', meshTheme.isDark)}`}>
                            remote
                        </span>
                    )}
                    {(connectionTransport || connectionRtt) && (
                        <span
                            className={`rounded-full border px-1.5 py-px ${getBadgeClasses('meta', meshTheme.isDark)}`}
                            title={connectionTransport === 'relay' ? t('meshGraph.panel.tooltipP2PRelayed') : t('meshGraph.panel.tooltipP2PRtt')}
                        >
                            {[connectionTransport, connectionRtt].filter(Boolean).join(' · ')}
                        </span>
                    )}
                    {node.dirty && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('dirty', meshTheme.isDark)}`}>
                            {`${node.dirtyFiles} dirty`}
                        </span>
                    )}
                    {node.outOfSync && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('conflict', meshTheme.isDark)}`}>
                            {t('meshGraph.panel.outOfSyncBadge')}
                        </span>
                    )}
                    {node.hasConflicts && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('conflict', meshTheme.isDark)}`}>
                            {t('meshGraph.panel.conflictBadge')}
                        </span>
                    )}
                    {!isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('orphan', meshTheme.isDark)}`}>
                            {t('meshGraph.panel.upstreamUnverified')}
                        </span>
                    )}
                    {node.isOrphan && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('orphan', meshTheme.isDark)}`}>
                            {t('meshGraph.panel.needsFollowUp')}
                        </span>
                    )}
                    {/* The attention badge above already surfaces in-progress/failed refine state;
                        the card only adds the recent-completed case it does not show. */}
                    {!isSubmoduleNode && node.refineJobStatus === 'completed' && (
                        <span className={`rounded-full border px-1.5 py-px ${getBadgeClasses('refineDone', meshTheme.isDark)}`} title={node.refineJobBranch ? t('meshGraph.panel.tooltipRefinedBranch', { branch: `${node.refineJobBranch}${node.refineJobInto ? ` → ${node.refineJobInto}` : ''}` }) : t('meshGraph.panel.tooltipRefineCompleted')}>
                            {t('meshGraph.panel.refined')}
                        </span>
                    )}
                </div>

                <div className={`mt-3 text-2xs leading-5 ${meshTheme.textSecondary}`} style={summaryTextStyle}>
                    {nodeSummary}
                </div>

                {visibleSessions.length > 0 && (
                    <div className="mt-3">
                        <div className={`mb-1.5 text-4xs font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>
                            {t('meshGraph.panel.attachedChats')}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            {visibleSessions.slice(0, CARD_SESSION_ROW_CAP).map(session => {
                                const startedAt = session.startedAt || session.createdAt || null
                                const roleLabel = getSessionRoleLabel(session)
                                return (
                                    <div
                                        key={session.sessionId}
                                        onClick={() => requestOpenSessionChat({ sessionId: session.sessionId, source: 'mesh-topology-panel' })}
                                        className={`min-w-0 cursor-pointer rounded-lg border px-2.5 py-1.5 transition-colors ${meshTheme.isDark ? 'border-white/8 bg-white/[0.035] hover:bg-white/[0.08]' : 'border-slate-200 bg-white/80 hover:bg-slate-50'}`}
                                        title={[
                                            t('sessionNav.openChatHint'),
                                            `Session ID: ${session.sessionId}`,
                                            session.providerType ? `Provider: ${session.providerType}` : null,
                                            `${t('meshGraph.panel.tooltipPrefixStatus')} ${formatSessionStatusLabel(session)}`,
                                            `Role: ${roleLabel}`,
                                            session.difficulty ? `${t('mesh.overview.routingDifficulty')}: ${difficultyLabel(session.difficulty, t)}` : null,
                                            startedAt ? `Started: ${startedAt}` : t('meshGraph.panel.tooltipStartedNotReported'),
                                            session.statusNote ? `${t('meshGraph.panel.tooltipPrefixNote')} ${session.statusNote}` : null,
                                        ].filter(Boolean).join('\n')}
                                    >
                                        <div className="flex min-w-0 items-center justify-between gap-2">
                                            <span className={`min-w-0 truncate font-mono text-3xs select-text ${meshTheme.textPrimary}`}>
                                                {shortSessionId(session.sessionId)}
                                            </span>
                                            <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-4xs font-semibold uppercase tracking-[0.12em] ${getSessionStatusBadgeClasses(session, meshTheme.isDark)}`}>
                                                {formatSessionStatusLabel(session)}
                                            </span>
                                        </div>
                                        <div className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-4xs ${meshTheme.textMuted}`}>
                                            <span className="truncate">{session.providerType || t('meshGraph.panel.providerUnknown')}</span>
                                            <span>{roleLabel}</span>
                                            <span>{formatElapsedSince(startedAt)}</span>
                                            {session.difficulty && (
                                                <span className={`shrink-0 rounded-full border px-1.5 py-0 text-5xs font-semibold uppercase tracking-[0.1em] ${getDifficultyBadgeClasses(session.difficulty, meshTheme.isDark)}`}>
                                                    {difficultyLabel(session.difficulty, t)}
                                                </span>
                                            )}
                                        </div>
                                        {session.statusNote && (
                                            <div className={`mt-1 text-4xs leading-4 ${meshTheme.textMuted}`}>
                                                {session.statusNote}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                            {visibleSessions.length > CARD_SESSION_ROW_CAP && (
                                <div className={`text-4xs ${meshTheme.textMuted}`} title={sessionTooltipLines.join('\n')}>
                                    {t('meshGraph.panel.moreChats', { count: visibleSessions.length - CARD_SESSION_ROW_CAP })}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {shouldShowCallout && calloutText && (
                    <div
                        className={`mt-3 rounded-xl border px-3 py-2 text-3xs leading-4 ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/8 text-cyan-50/90' : 'border-sky-300 bg-sky-50 text-sky-700'}`}
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

function getEdgeLabelClasses(edge: MeshGraphEdge, isDark: boolean): string {
    const base = 'nodrag nopan rounded-md border px-2 py-1 text-3xs font-semibold shadow-sm'
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

/** Legend rows in display order — only the types present in the graph render. */
const LEGEND_EDGE_ORDER: MeshGraphEdge['type'][] = [
    'parentBranch',
    'cloneLink',
    'worktreeLink',
    'submoduleLink',
    'sessionLink',
    'orphanLink',
]

const LEGEND_EDGE_LABEL_KEY: Record<MeshGraphEdge['type'], string> = {
    parentBranch: 'meshGraph.legendEdge.parentBranch',
    cloneLink: 'meshGraph.legendEdge.cloneLink',
    worktreeLink: 'meshGraph.legendEdge.worktreeLink',
    submoduleLink: 'meshGraph.legendEdge.submoduleLink',
    sessionLink: 'meshGraph.legendEdge.sessionLink',
    orphanLink: 'meshGraph.legendEdge.orphanLink',
}

const LEGEND_EDGE_DASH: Partial<Record<MeshGraphEdge['type'], string>> = {
    orphanLink: '5 4',
    submoduleLink: '4 3',
    cloneLink: '6 3',
}

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
    const showMinimap = data.nodes.length >= MINIMAP_NODE_THRESHOLD
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
    // Edge types present in the current graph — drives the in-canvas legend.
    const presentEdgeTypes = useMemo(() => {
        const types = new Set<MeshGraphEdge['type']>()
        for (const edge of data.edges) types.add(edge.type)
        return LEGEND_EDGE_ORDER.filter(type => types.has(type))
    }, [data.edges])
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
                {t('meshGraph.obs.panHint')}
            </div>
            {presentEdgeTypes.length > 0 && (
                <div className={`pointer-events-none absolute right-3 top-2 z-10 flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 rounded-xl border px-2.5 py-1.5 text-4xs ${meshTheme.isDark ? 'border-white/10 bg-slate-950/75 text-slate-300' : 'border-slate-200 bg-white/90 text-slate-600'}`}>
                    {presentEdgeTypes.map(type => (
                        <span key={type} className="flex items-center gap-1">
                            <svg width="16" height="4" aria-hidden>
                                <line
                                    x1="0" y1="2" x2="16" y2="2"
                                    stroke={edgeColor({ type } as MeshGraphEdge)}
                                    strokeWidth="2"
                                    strokeDasharray={LEGEND_EDGE_DASH[type]}
                                />
                            </svg>
                            {t(LEGEND_EDGE_LABEL_KEY[type])}
                        </span>
                    ))}
                </div>
            )}
            <div className="w-full min-w-0 flex-1" style={{ height: '100%' }}>
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
                            nodeStrokeWidth={3}
                            className={meshTheme.isDark ? 'overflow-hidden rounded-xl border border-white/10 bg-slate-950/85' : 'overflow-hidden rounded-xl border border-slate-200 bg-white/95'}
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
