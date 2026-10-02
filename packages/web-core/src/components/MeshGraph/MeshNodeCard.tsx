/**
 * The mesh graph's node card (the React Flow custom node): health / attention
 * badges, branch and drift summary, session rows and the workspace tail, rendered
 * against the shared mesh theme. Read by MeshGraphView through the theme / compact /
 * direction / multi-machine contexts it provides.
 */
import type { MeshGraphNode } from './types';
import { createContext, useContext, type CSSProperties } from 'react';
import { getMeshGraphTheme, meshChipTone, MESH_CHIP_BASE } from './meshGraphTheme';
import { formatMeshGraphAheadBehindLocalized, getMeshGraphNodeCardWidth, getNodeSummaryForLayout, type MeshGraphDirection } from './meshGraphLayout';
import { getMeshGraphAttentionBadge, shouldShowMeshGraphCallout, getMeshGraphObservationHint, localizeMeshGraphHint, type MeshGraphObservationHint } from './meshGraphViewModel';
import { sessionStatusLabel, sessionStatusText, sessionRoleText, sessionElapsedLabel } from './MeshObservabilitySurface/meshSurfaceHelpers';
import { formatElapsedCompact, formatRelativeTime } from '../../utils/time';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode } from './MeshGraphView';
import { useTranslation } from 'react-i18next';
import { IconGitBranch } from '../Icons';
import { formatMeshConnectionTransport, formatMeshConnectionRtt } from '../../utils/mesh-visualization';
import { requestOpenSessionChat } from '../../utils/session-nav';

/**
 * Max per-session rows rendered on a node card. The unbounded scrollable list
 * made busy nodes tower over the rest of the graph; overflow collapses to a
 * "+N more chats" line (full detail stays in the tooltip and the drill-down panel).
 */
const CARD_SESSION_ROW_CAP = 2

export type FlowNodeData = Record<string, unknown> & {
    graphNode: MeshGraphNode
    compact: boolean
}

export const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))
export const MeshGraphCompactContext = createContext(false)
export const MeshGraphDirectionContext = createContext<MeshGraphDirection>('LR')
/**
 * True when the graph spans more than one machine. On a single-machine mesh the
 * machine label adds nothing (every card would repeat it — the "duplicate local
 * machine" smell), so cards fall back to the workspace path for context.
 */
export const MeshGraphMultiMachineContext = createContext(true)

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
    'working': 'mesh.attention.working',
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
