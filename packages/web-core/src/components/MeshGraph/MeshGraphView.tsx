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
import './meshGraph.css'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'
import {
    getMeshGraphAttentionBadge,
    localizeMeshGraphHint,
    getMeshGraphObservationHint,
    shouldShowMeshGraphCallout,
    type MeshGraphObservationHint,
} from './meshGraphViewModel'
import { formatRelativeTime } from '../../utils/time'
import {
    getMeshGraphInitialFocusNodeIds,
    getMeshGraphLayoutKey,
    getMeshGraphViewportKey,
} from '../../utils/mesh-graph-viewport'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, MESH_CHIP_BASE, MESH_EDGE_LABEL_BASE, meshChipTone } from './meshGraphTheme'
import {
    buildMeshGraphLayout,
    formatMeshGraphAheadBehindLocalized,
    MESH_GRAPH_EDGE_LABEL,
    estimateMeshGraphNodeHeight,
    getMeshGraphNodeCardWidth,
    getNodeSummaryForLayout,
    type MeshGraphDirection,
    type MeshGraphLayoutEdgePoint,
} from './meshGraphLayout'
import { getMeshGraphDataFingerprint, getMeshGraphLayoutFingerprint } from './meshGraphMemo'
import { formatMeshConnectionRtt, formatMeshConnectionTransport } from '../../utils/mesh-visualization'
import { sessionElapsedLabel, sessionRoleText, sessionStatusLabel, sessionStatusText } from './MeshObservabilitySurface/meshSurfaceHelpers'
import { formatElapsedCompact } from '../../utils/time'
import { edgeColor } from './meshGraphEdgeLegend'
import { edgeDash } from './meshGraphEdgeLegend'
export { MeshGraphEdgeLegend } from './meshGraphEdgeLegend'
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

function getHealthClasses(node: MeshGraphNode, selected: boolean): string {
    const isStale = isNodeStale(node)
    // One neutral card surface for every node (the app's --bg-card), a 1px
    // border, no tinted fills and no glow. Selection = the single accent;
    // failure / attention colour only the thin border. Health itself is the
    // dot in the card header; liveness is the pulsing active-session dot.
    const surface = 'bg-bg-card'
    if (selected) return `${surface} border-accent ring-1 ring-accent/50`
    const attention = getMeshGraphAttentionBadge(node)
    const stale = isStale ? ' opacity-60' : ''
    if (attention?.tone === 'danger' || node.health === 'degraded') return `${surface} border-status-error/40${stale}`
    if (attention?.tone === 'warn') return `${surface} border-status-warning/40${stale}`
    if (isStale) return `${surface} border-border-subtle opacity-60`
    return `${surface} border-border-default`
}

function getBadgeClasses(kind: 'health' | 'dirty' | 'conflict' | 'orphan' | 'meta' | 'submodule' | 'refineDone'): string {
    switch (kind) {
        case 'refineDone': return meshChipTone('good')
        case 'dirty': return meshChipTone('warn')
        case 'conflict': return meshChipTone('danger')
        case 'orphan': return meshChipTone('warn')
        case 'health':
        case 'submodule':
        case 'meta':
        default: return meshChipTone('neutral')
    }
}

function getAttentionBadgeClasses(tone: 'good' | 'warn' | 'danger' | 'info'): string {
    switch (tone) {
        case 'danger': return meshChipTone('danger')
        case 'warn': return meshChipTone('warn')
        case 'good': return meshChipTone('good')
        case 'info':
        default: return meshChipTone('neutral')
    }
}

/** Health dot colour — theme status tokens (resolved as CSS vars in `style`). */
function getHealthDot(health: MeshGraphNode['health']): string {
    switch (health) {
        case 'online':
            return 'var(--status-online)'
        case 'dirty':
        case 'wrong_branch':
            return 'var(--status-warning)'
        case 'degraded':
            return 'var(--status-error)'
        case 'offline':
            return 'var(--status-offline)'
        default:
            return 'var(--text-muted)'
    }
}

function formatHealth(health: MeshGraphNode['health']): string {
    return health.replace(/_/g, ' ')
}

// Thin alias: this file's session status rows render through the shared
// meshSurfaceHelpers bucket logic (see that file for the failed/stopped/
// interrupted branch, which folds into the same fallback here as before).
const formatSessionStatusLabel = sessionStatusLabel

function hasGeneratingSession(node: MeshGraphNode): boolean {
    return node.sessionDetails?.some(s => formatSessionStatusLabel(s) === 'generating') ?? false
}

function getSessionStatusBadgeClasses(session: MeshGraphNode['sessionDetails'][number]): string {
    const label = formatSessionStatusLabel(session)
    if (label.includes('approval')) return meshChipTone('warn')
    if (label === 'generating') return 'border-accent/40 text-accent'
    if (label.includes('failed') || label.includes('stopped') || label.includes('interrupted')) return meshChipTone('danger')
    return meshChipTone('neutral')
}

/**
 * SHOW-TASK-DIFFICULTY: session.difficulty is joined from the queue task the
 * session is executing (buildMeshGraph, mesh-visualization.ts) — the session
 * axis itself carries no difficulty. Difficulty is a routing attribute, not a
 * state, so it renders as a neutral chip (the label carries the level).
 */
function getDifficultyBadgeClasses(): string {
    return meshChipTone('neutral')
}

function difficultyLabel(difficulty: string, t: (key: string) => string): string {
    switch (difficulty) {
        case 'easy': return t('mesh.difficulty.easy')
        case 'medium': return t('mesh.difficulty.medium')
        case 'difficult': return t('mesh.difficulty.difficult')
        case 'freeform': return t('mesh.difficulty.freeform')
        default: return difficulty
    }
}

function parseSessionTimeMs(value: string | null | undefined): number | null {
    if (!value) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** Elapsed runtime, or '' when the daemon did not report a start time. */
function formatElapsedSince(value: string | null | undefined): string {
    const timestamp = parseSessionTimeMs(value)
    if (timestamp === null) return ''
    return formatElapsedCompact(Math.max(0, Date.now() - timestamp))
}

function getSessionSummaryLabel(node: MeshGraphNode, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
    if (node.sessionDetails.length === 0) return null
    const generatingCount = node.sessionDetails.filter(session => formatSessionStatusLabel(session) === 'generating').length
    const coordinatorCount = node.sessionDetails.filter(session => session.isSelfCoordinator).length
    const workerCount = node.sessionDetails.length - coordinatorCount
    const parts = [t('mesh.panel.chats', { count: node.sessionDetails.length })]
    if (generatingCount > 0) parts.push(t('mesh.panel.generatingCount', { count: generatingCount }))
    if (coordinatorCount > 0) parts.push(coordinatorCount === 1 ? t('mesh.panel.coordinatorAttached') : t('mesh.panel.coordinators', { count: coordinatorCount }))
    if (workerCount > 0) parts.push(t('mesh.panel.workers', { count: workerCount }))
    if (generatingCount === 0 && coordinatorCount > 0) parts.push(t('mesh.panel.sampledStatus'))
    return parts.join(' · ')
}

/**
 * Attention badge labels come from the pure view-model as canonical English
 * (tests pin them there); the render layer maps the finite label set onto i18n
 * keys. Dynamic ahead/behind drift labels are re-derived via the localized
 * formatter; anything unknown falls through untranslated.
 */
const ATTENTION_LABEL_KEYS: Record<string, string> = {
    'submodule drift': 'mesh.attention.submoduleDrift',
    'submodule dirty': 'mesh.attention.submoduleDirty',
    'conflicts present': 'mesh.attention.conflictsPresent',
    'dirty workspace': 'mesh.attention.dirtyWorkspace',
    'upstream unverified': 'mesh.attention.upstreamUnverified',
    'push branch': 'mesh.attention.pushBranch',
    'blocked review': 'mesh.attention.blockedReview',
    'refine failed': 'mesh.attention.refineFailed',
    'refining…': 'mesh.attention.refining',
    'needs merge': 'mesh.attention.needsMerge',
    'refine worktree': 'mesh.attention.refineWorktree',
    'needs follow-up': 'mesh.attention.needsFollowUp',
    'offline': 'mesh.attention.offline',
}

/** Localized per-node freshness hint (coordinator-held state age / refresh / unreachable). */
function formatObservationHint(hint: MeshGraphObservationHint, t: (key: string, opts?: Record<string, unknown>) => string): string {
    const age = (at: number) => formatRelativeTime(at, { nowLabel: '<1m' })
    switch (hint.kind) {
        case 'fetching':
            return t('mesh.graph.observationFetching')
        case 'refreshing':
            return t('mesh.graph.observationRefreshing', { age: age(hint.observedAt) })
        case 'aged':
            return t('mesh.graph.observationAsOf', { age: age(hint.observedAt) })
        case 'unreachable':
            return hint.observedAt === null
                ? t('mesh.graph.observationUnreachableNoState')
                : t('mesh.graph.observationUnreachable', { age: age(hint.observedAt) })
    }
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

/** Exported for render tests (card content: badges, per-node freshness hint). */
export function MeshNodeCard({ data, selected }: NodeProps<FlowNode>) {
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
    const machineContext = [node.machineLabel, node.locality === 'remote' ? t('mesh.panel.remote') : null].filter(Boolean).join(' · ')
    const workspaceTail = formatWorkspaceTail(node.workspace)
    const subtitle = multiMachine
        ? (machineContext || workspaceTail || node.workspace)
        : (workspaceTail || machineContext || node.workspace)
    const shortCommit = node.submoduleCommit ? node.submoduleCommit.slice(0, 7) : null
    const observationHint = getMeshGraphObservationHint(node)
    const observationLabel = observationHint ? formatObservationHint(observationHint, t) : null
    const observationPillClass = observationHint?.kind === 'unreachable'
        ? getBadgeClasses('dirty')
        : getBadgeClasses('meta')
    // Fresh / fetching / refreshing say nothing on the card — only a degraded
    // observation earns a chip ("Stale" / "Unreachable"); its age is the tooltip.
    const showObservationPill = !!observationLabel && (observationHint?.kind === 'aged' || observationHint?.kind === 'unreachable')
    const observationChipLabel = observationHint?.kind === 'unreachable'
        ? t('mesh.graph.observationUnreachableChip')
        : t('mesh.graph.observationStaleChip')

    // ── Default-branch anchor: a compact branch pill, not a machine-like card.
    //    A full card here read as "another machine named main" — the anchor is a
    //    branch concept, so it gets a visually distinct, minimal shape. ──
    if (isDefaultBranchNode) {
        const attention = getMeshGraphAttentionBadge(node)
        return (
            <div
                className={`rounded-lg border bg-bg-card px-3 py-2 transition-colors ${selected ? 'border-accent ring-1 ring-accent/50' : 'border-border-default'}`}
                style={{ width: getMeshGraphNodeCardWidth(node, compact) }}
                title={[node.label, getNodeSummaryForLayout(node, t), attention ? translateAttentionLabel(attention.label, node, t) : null].filter(Boolean).join('\n')}
            >
                <Handle type="target" position={direction === 'TB' ? Position.Top : Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
                <div className="flex min-w-0 items-center justify-center gap-2">
                    <span className={`flex shrink-0 items-center ${meshTheme.textMuted}`} aria-hidden><IconGitBranch size={13} /></span>
                    <span className={`truncate text-sm font-semibold leading-5 ${meshTheme.textPrimary}`}>{node.label}</span>
                    <span className={`${MESH_CHIP_BASE} ${meshChipTone('neutral')}`}>{t('mesh.panel.defaultBranch')}</span>
                    {attention && (
                        <span className={`shrink-0 h-2 w-2 rounded-full ${attention.tone === 'danger' ? 'bg-status-error' : attention.tone === 'warn' ? 'bg-status-warning' : 'bg-text-muted'}`} title={translateAttentionLabel(attention.label, node, t)} aria-hidden />
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
            ? t('mesh.panel.outOfSyncBadge')
            : node.dirty
                ? t('mesh.panel.tooltipLocalChanges')
                : t('mesh.panel.submoduleSynced')
        const stateClass = node.outOfSync
            ? getBadgeClasses('conflict')
            : node.dirty
                ? getBadgeClasses('dirty')
                : getBadgeClasses('submodule')
        return (
            <div
                className={`rounded-lg border px-3 py-2 transition-colors ${getHealthClasses(node, selected)}`}
                style={{ width: getMeshGraphNodeCardWidth(node, compact) }}
                title={[
                    node.label,
                    node.submodulePath && node.submodulePath !== node.label ? node.submodulePath : null,
                    localizeMeshGraphHint(node, t)?.text || null,
                    shortCommit ? `@ ${shortCommit}` : null,
                    observationLabel,
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
                    <span className={`${MESH_CHIP_BASE} ${stateClass}`}>{stateLabel}</span>
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
    const calloutHint = localizeMeshGraphHint(node, t)
    const calloutText = calloutHint?.text ?? null
    const hasActiveSession = isNodeActive(node)
    const visibleSessions = node.sessionDetails
    const visibleCardSessions = node.sessionDetails
    const sessionSummaryLabel = getSessionSummaryLabel(node, t)
    const attentionLabel = attentionBadge ? translateAttentionLabel(attentionBadge.label, node, t) : null
    const nodeSummary = getNodeSummaryForLayout(node, t)
    const sessionTooltipLines = node.sessionDetails.map(session => {
        const status = sessionStatusText(session, t)
        const provider = session.providerType || t('mesh.panel.providerUnknown')
        const role = sessionRoleText(session, t)
        const startedAt = session.startedAt || session.createdAt || null
        const difficulty = session.difficulty ? difficultyLabel(session.difficulty, t) : null
        return [provider, status, role, difficulty, formatElapsedSince(startedAt) || null, session.statusNote || null].filter(Boolean).join(' · ')
    })

    if (compact) {
        return (
            <div
                className={`rounded-lg border px-3 py-2.5 transition-colors ${getHealthClasses(node, selected)}`}
                style={{ width: getMeshGraphNodeCardWidth(node, true) }}
                title={[
                    node.label,
                    node.branch ? `${t('mesh.panel.tooltipPrefixBranch')} ${node.branch}` : null,
                    node.machineLabel ? `Machine: ${node.machineLabel}` : null,
                    node.workspace ? `Workspace: ${node.workspace}` : null,
                    attentionBadge ? `${t('mesh.panel.tooltipPrefixStatus')} ${attentionLabel}` : null,
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
                            <span className="h-1.5 w-1.5 rounded-full bg-status-online animate-pulse" aria-label={t('mesh.graph.activeSessionAria')} />
                        )}
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: getHealthDot(node.health) }}
                            aria-hidden
                        />
                    </div>
                </div>
                {/* One chip row: every chip shares MESH_CHIP_BASE (same height,
                    centred) inside a single wrapping flex row, so e.g. "Stale"
                    and the branch chip sit on one centre line instead of two
                    inline boxes with different fonts/margins. */}
                {(node.health === 'unknown' && !attentionBadge) || attentionBadge || showObservationPill || (!attentionBadge && node.branch && !isSubmoduleNode && node.health !== 'unknown') ? (
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                        {node.health === 'unknown' && !attentionBadge && (
                            <span className={`${MESH_CHIP_BASE} italic ${getBadgeClasses('health')}`}>
                                <span className="truncate">{t('mesh.obs.connecting')}</span>
                            </span>
                        )}
                        {attentionBadge && (
                            <span className={`${MESH_CHIP_BASE} ${getAttentionBadgeClasses(attentionBadge.tone)}`} title={attentionLabel ?? undefined}>
                                <span className="truncate">{attentionLabel}</span>
                            </span>
                        )}
                        {showObservationPill && (
                            <span className={`${MESH_CHIP_BASE} ${observationPillClass}`} title={observationLabel ?? undefined}>
                                <span className="truncate">{observationChipLabel}</span>
                            </span>
                        )}
                        {!attentionBadge && node.branch && !isSubmoduleNode && node.health !== 'unknown' && (
                            <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('meta')}`} title={node.branch}>
                                <span className="truncate">{node.branch}</span>
                            </span>
                        )}
                    </div>
                ) : null}
                {sessionSummaryLabel && (
                    <div className={`mt-1 min-w-0 max-w-full truncate text-4xs ${meshTheme.textSecondary}`} title={sessionTooltipLines.join('\n')}>
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
                                className="min-w-0 cursor-pointer rounded-md border border-border-subtle bg-bg-glass px-1.5 py-1 transition-colors hover:bg-bg-glass-hover"
                                title={[
                                    t('sessionNav.openChatHint'),
                                    `${t('mesh.panel.tooltipPrefixStatus')} ${sessionStatusText(session, t)}`,
                                    [session.providerType, sessionRoleText(session, t)].filter(Boolean).join(' · '),
                                    session.difficulty ? `${t('mesh.overview.routingDifficulty')}: ${difficultyLabel(session.difficulty, t)}` : null,
                                ].filter(Boolean).join('\n')}
                            >
                                <div className="flex min-w-0 items-center justify-between gap-1.5">
                                    <span className={`min-w-0 truncate text-4xs ${meshTheme.textMuted}`}>
                                        {session.providerType || t('mesh.panel.providerUnknown')}
                                    </span>
                                    <span className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-5xs font-medium leading-none ${getSessionStatusBadgeClasses(session)}`}>
                                        {sessionStatusText(session, t)}
                                    </span>
                                </div>
                                {/* Role + age — the raw session id says nothing at a glance
                                    and stays available in the tooltip above. */}
                                <div className={`mt-0.5 flex min-w-0 items-center gap-1.5 text-5xs ${meshTheme.textMuted}`}>
                                    <span className="shrink-0">{sessionRoleText(session, t)}</span>
                                    <span className="min-w-0 truncate tabular-nums">{sessionElapsedLabel(session).includes('not reported') ? '' : sessionElapsedLabel(session)}</span>
                                </div>
                            </div>
                        ))}
                        {visibleCardSessions.length > CARD_SESSION_ROW_CAP && (
                            <div className={`text-5xs ${meshTheme.textMuted}`} title={sessionTooltipLines.join('\n')}>
                                {t('mesh.panel.moreChats', { count: visibleCardSessions.length - CARD_SESSION_ROW_CAP })}
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
        attentionBadge ? `${t('mesh.panel.tooltipPrefixStatus')} ${attentionLabel}` : null,
        nodeSummary,
        node.branch ? `${t('mesh.panel.tooltipPrefixBranch')} ${node.branch}` : null,
        node.dirty ? (isSubmoduleNode ? t('mesh.panel.tooltipLocalChanges') : t('mesh.drift.changed', { count: node.dirtyFiles })) : null,
        node.hasConflicts ? t('mesh.panel.tooltipHasConflicts') : null,
        node.outOfSync ? t('mesh.panel.tooltipOutOfSync') : null,
        !isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' ? t('mesh.panel.tooltipUpstreamUnverified') : null,
        node.isOrphan ? t('mesh.panel.tooltipNeedsFollowUp') : null,
        observationLabel,
        shouldShowCallout && calloutText ? `${t('mesh.panel.tooltipPrefixNote')} ${calloutText}` : null,
        shouldShowCallout && calloutHint?.detail ? calloutHint.detail : null,
        ...sessionTooltipLines,
    ].filter(Boolean).join('\n')

    return (
        <div
            className={`rounded-xl border px-4 py-3 transition-colors ${getHealthClasses(node, selected)}${hasGeneratingSession(node) ? ' mesh-node-generating' : ''}`}
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
                        <span className="h-2 w-2 rounded-full bg-status-online animate-pulse" aria-label={t('mesh.graph.activeSessionAria')} />
                    )}
                    <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: getHealthDot(node.health) }}
                        aria-hidden
                    />
                </div>
            </div>

            {(attentionBadge || (node.branch && !isSubmoduleNode) || sessionSummaryLabel) && (
                <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
                    {attentionBadge ? (
                        <span className={`${MESH_CHIP_BASE} ${getAttentionBadgeClasses(attentionBadge.tone)}`} title={attentionLabel ?? undefined}>
                            <span className="truncate">{attentionLabel}</span>
                        </span>
                    ) : node.branch && !isSubmoduleNode ? (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('meta')}`} title={node.branch}>
                            <span className="truncate">{node.branch}</span>
                        </span>
                    ) : null}
                    {sessionSummaryLabel && (
                        <span
                            className={`${MESH_CHIP_BASE} ${meshChipTone('neutral')}`}
                            title={sessionTooltipLines.join('\n')}
                        >
                            <span className="truncate">{sessionSummaryLabel}</span>
                        </span>
                    )}
                </div>
            )}

            {/* The per-session mini-list that used to render HERE was a duplicate of
                the "attached chats" list below — the same sessions appeared twice on
                one card. The summary pill above + the labeled list below remain. */}

            <div className="mt-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                    {/* Health pill only when it says something the dot cannot: online is
                        the normal state and stays dot-only, so the badge row is quiet on
                        a healthy mesh and loud exactly where something is off. */}
                    {node.health === 'unknown' ? (
                        <span className={`${MESH_CHIP_BASE} italic ${getBadgeClasses('health')}`}>
                            {t('mesh.obs.connecting')}
                        </span>
                    ) : node.health !== 'online' ? (
                        <span className={`${MESH_CHIP_BASE} capitalize ${getBadgeClasses('health')}`}>
                            {formatHealth(node.health)}
                        </span>
                    ) : null}
                    {node.locality === 'remote' && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('meta')}`}>
                            {t('mesh.graph.remoteBadge')}
                        </span>
                    )}
                    {showObservationPill && (
                        <span className={`${MESH_CHIP_BASE} ${observationPillClass}`} title={observationLabel ?? undefined}>
                            {observationChipLabel}
                        </span>
                    )}
                    {/* Direct links are the normal case and say nothing. A
                        relayed link is the only one worth a chip. */}
                    {connectionTransport === 'relay' && (
                        <span
                            className={`${MESH_CHIP_BASE} ${getBadgeClasses('meta')}`}
                            title={[t('mesh.panel.tooltipP2PRelayed'), connectionRtt].filter(Boolean).join(' · ')}
                        >
                            {t('mesh.graph.slowLinkChip')}
                        </span>
                    )}
                    {node.dirty && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('dirty')}`}>
                            {t('mesh.drift.changed', { count: node.dirtyFiles })}
                        </span>
                    )}
                    {node.outOfSync && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('conflict')}`}>
                            {t('mesh.panel.outOfSyncBadge')}
                        </span>
                    )}
                    {node.hasConflicts && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('conflict')}`}>
                            {t('mesh.panel.conflictBadge')}
                        </span>
                    )}
                    {!isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('orphan')}`}>
                            {t('mesh.panel.upstreamUnverified')}
                        </span>
                    )}
                    {node.isOrphan && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('orphan')}`}>
                            {t('mesh.panel.needsFollowUp')}
                        </span>
                    )}
                    {/* The attention badge above already surfaces in-progress/failed refine state;
                        the card only adds the recent-completed case it does not show. */}
                    {!isSubmoduleNode && node.refineJobStatus === 'completed' && (
                        <span className={`${MESH_CHIP_BASE} ${getBadgeClasses('refineDone')}`} title={node.refineJobBranch ? t('mesh.panel.tooltipRefinedBranch', { branch: `${node.refineJobBranch}${node.refineJobInto ? ` → ${node.refineJobInto}` : ''}` }) : t('mesh.panel.tooltipRefineCompleted')}>
                            {t('mesh.panel.refined')}
                        </span>
                    )}
                </div>

                <div className={`mt-3 text-2xs leading-5 ${meshTheme.textSecondary}`} style={summaryTextStyle}>
                    {nodeSummary}
                </div>

                {visibleSessions.length > 0 && (
                    <div className="mt-3">
                        <div className={`mb-1.5 text-3xs font-medium ${meshTheme.textMuted}`}>
                            {t('mesh.panel.attachedChats')}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            {visibleSessions.slice(0, CARD_SESSION_ROW_CAP).map(session => {
                                const startedAt = session.startedAt || session.createdAt || null
                                const roleLabel = sessionRoleText(session, t)
                                return (
                                    <div
                                        key={session.sessionId}
                                        onClick={() => requestOpenSessionChat({ sessionId: session.sessionId, source: 'mesh-topology-panel' })}
                                        className="min-w-0 cursor-pointer rounded-lg border border-border-subtle bg-bg-glass px-2.5 py-1.5 transition-colors hover:bg-bg-glass-hover"
                                        title={[
                                            t('sessionNav.openChatHint'),
                                            `${t('mesh.panel.tooltipPrefixStatus')} ${sessionStatusText(session, t)}`,
                                            [session.providerType, roleLabel].filter(Boolean).join(' · '),
                                            session.difficulty ? `${t('mesh.overview.routingDifficulty')}: ${difficultyLabel(session.difficulty, t)}` : null,
                                            session.statusNote ? `${t('mesh.panel.tooltipPrefixNote')} ${session.statusNote}` : null,
                                        ].filter(Boolean).join('\n')}
                                    >
                                        <div className="flex min-w-0 items-center justify-between gap-2">
                                            <span className={`min-w-0 truncate text-3xs ${meshTheme.textPrimary}`}>
                                                {session.providerType || t('mesh.panel.providerUnknown')}
                                            </span>
                                            <span className={`${MESH_CHIP_BASE} ${getSessionStatusBadgeClasses(session)}`}>
                                                {sessionStatusText(session, t)}
                                            </span>
                                        </div>
                                        <div className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-4xs ${meshTheme.textMuted}`}>
                                            <span>{roleLabel}</span>
                                            {formatElapsedSince(startedAt) && <span>{formatElapsedSince(startedAt)}</span>}
                                            {session.difficulty && (
                                                <span className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-5xs font-medium leading-none ${getDifficultyBadgeClasses()}`}>
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
                                    {t('mesh.panel.moreChats', { count: visibleSessions.length - CARD_SESSION_ROW_CAP })}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {shouldShowCallout && calloutText && (
                    <div
                        className={`mt-3 rounded-lg border border-border-subtle bg-bg-glass px-3 py-2 text-3xs leading-4 ${meshTheme.textSecondary}`}
                        style={calloutTextStyle}
                        data-testid="mesh-node-callout"
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
