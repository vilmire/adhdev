import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import MeshGraphView from './MeshGraphView'
import { MeshGraphEdgeLegend } from './meshGraphEdgeLegend'
import MeshBlueprintView from './MeshBlueprintView'
import MeshOverviewCards, { queueTaskStatusLabel } from './MeshOverviewCards'
import { MeshHelpPanel, MeshHelpToggle } from './MeshHelpPanel'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import type { MeshGraphData } from './types'
import { buildMeshGraph } from '../../utils/mesh-visualization'
import { canonicalizeRepoMeshStatus, summarizeRepoMeshCanonicalNodeDebug } from '../../utils/repo-mesh-status'
import { MeshGraphThemeContext } from './MeshObservabilitySurface/meshSurfaceTheme'
import { Badge, Row } from './MeshObservabilitySurface/meshSurfacePrimitives'
import { MeshStatusTab, MeshMachineQuotaCard, MeshNodeRuntimeChips } from './MeshObservabilitySurface/MeshStatusTab'
import { SettingsTabBar } from '../ui/SettingsTabs'
import { PopoverButton, Tooltip } from '../ui/InfoTip'
import { TechnicalDetails } from '../ui/TechnicalDetails'
import { IconDashboard, IconLayers, IconMesh, IconHelp, IconWrench, IconSpinner } from '../Icons'
import { eventManager } from '../../managers/EventManager'
import { queueTaskDisplayText } from '../../utils/queue-task-label'
import { requestOpenSessionChat } from '../../utils/session-nav'
import {
    EMPTY_LEDGER_SUMMARY,
    collectMachineQuotaGroups,
    collectSessionEntries,
    describeGraphNodeSource,
    extractGitLogEntries,
    getQueueTaskNodeTarget,
    getRepoMeshStatusGraphFingerprint,
    healthTone,
    isBootstrapFallbackStatus,
    machineKeyForMeshNode,
    nodeDisplayName,
    nodeHealthText,
    resolveGitLogRequest,
    resolveSelectedGraphNodeForDetail,
    sessionElapsedLabel,
    sessionRoleText,
    sessionStatusLabel,
    sessionStatusText,
    sessionTone,
    summarizeSelectedHead,
    type AsyncRefineJob,
    type GitHistoryState,
} from './MeshObservabilitySurface/meshSurfaceHelpers'

// Re-export the pure helpers consumed by tests / external callers from their new
// home so `import { … } from './MeshObservabilitySurface'` keeps resolving after
// the split.
export {
    describeProviders,
    getQueueTaskNodeTarget,
    getQueueTaskSessionTarget,
    resolveGitLogRequest,
    resolveSelectedGraphNodeForDetail,
    summarizeNodeDrift,
    summarizeSelectedHead,
} from './MeshObservabilitySurface/meshSurfaceHelpers'

declare global {
    interface Window {
        __ADHDEV_DEBUG_MESH_GRAPH__?: boolean
    }
}

/** Same window-flag + localStorage opt-in shape as useDevRenderTrace's isTraceEnabled. */
function isMeshGraphDebugEnabled(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return window.__ADHDEV_DEBUG_MESH_GRAPH__ === true || window.localStorage.getItem('adhdev_debug_mesh_graph') === '1'
    } catch {
        return window.__ADHDEV_DEBUG_MESH_GRAPH__ === true
    }
}

type DetailSelection =
    | { kind: 'node'; nodeId: string }
    | { kind: 'edge'; edgeId: string }
    | { kind: 'session'; nodeId: string; sessionId: string }
    | { kind: 'queue'; taskId: string }

/**
 * Three tabs: Overview (approvals, missions, activity, nodes), Tasks (the
 * blueprint) and Map (topology + per-node detail; per-machine runtime and the
 * protocol/build internals live behind its Diagnostics panel).
 */
export type MeshSurfaceTab = 'overview' | 'tasks' | 'map'

export const MESH_SURFACE_TABS: readonly MeshSurfaceTab[] = ['overview', 'tasks', 'map']

/** Maps retired tab ids (status / notes / graph) onto the current three. */
export function normalizeMeshSurfaceTab(tab: string | null | undefined): MeshSurfaceTab {
    if (tab === 'tasks' || tab === 'map' || tab === 'overview') return tab
    if (tab === 'graph' || tab === 'status') return 'map'
    return 'overview'
}

interface MeshObservabilitySurfaceProps {
    status: RepoMeshStatus
    emptyMessage?: string
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    /** When true, the graph is showing bootstrap inventory data pending live peer truth. */
    bootstrapFallback?: boolean
    /**
     * Controlled tab/help state. When provided, the parent owns the tab bar and
     * the "?" help toggle (e.g. to host them in the dialog header). Leave
     * undefined for the self-managed behaviour.
     */
    activeTab?: MeshSurfaceTab
    onActiveTabChange?: (tab: MeshSurfaceTab) => void
    helpOpen?: boolean
    onHelpOpenChange?: (open: boolean) => void
    /** When true, the surface does not render its own tab/help control row — the
     *  parent is rendering the controls (via MeshSurfaceTabControls) elsewhere. */
    hideControls?: boolean
    /** Host-owned status reload — called after queue mutations (task cancel/requeue)
     *  so the surface reflects the change without waiting for a manual Refresh. */
    onRequestRefresh?: () => void
    /** Bumped by the host's single Refresh control; panels with their own
     *  fetches (the task graphs) reload when it changes. */
    refreshToken?: number
}

/**
 * The tab bar — the same underline tabs (icon + label, accent underline) as
 * every settings page. Rendered inline by MeshObservabilitySurface or hoisted
 * into a parent header (DashboardMeshGraphDialog).
 */
export function MeshSurfaceTabControls({
    meshTheme,
    activeTab,
    onActiveTabChange,
    helpOpen,
    onHelpOpenChange,
    hideHelpToggle = false,
    className,
}: {
    meshTheme: MeshGraphTheme
    activeTab: MeshSurfaceTab
    onActiveTabChange: (tab: MeshSurfaceTab) => void
    helpOpen: boolean
    onHelpOpenChange: (open: boolean) => void
    /** The dialog hosts its own corner-strip help button — skip the inline one. */
    hideHelpToggle?: boolean
    className?: string
}) {
    const { t } = useTranslation('common')
    return (
        <div className={`flex min-w-0 items-end gap-2 ${className ?? ''}`}>
            <SettingsTabBar
                variant="underline"
                ariaLabel={t('mesh.obs.viewAria')}
                tabIdPrefix="mesh-surface-tab"
                activeKey={activeTab}
                onSelect={key => onActiveTabChange(normalizeMeshSurfaceTab(key))}
                className="min-w-0 flex-1 border-b-0 px-0 md:px-0"
                tabs={[
                    { key: 'overview', label: t('mesh.obs.tabOverview'), icon: <IconDashboard size={14} /> },
                    { key: 'tasks', label: t('mesh.obs.tabTasks'), icon: <IconLayers size={14} /> },
                    { key: 'map', label: t('mesh.obs.tabMap'), icon: <IconMesh size={14} /> },
                ]}
            />
            {!hideHelpToggle && <MeshHelpToggle meshTheme={meshTheme} open={helpOpen} onToggle={() => onHelpOpenChange(!helpOpen)} />}
        </div>
    )
}

export default function MeshObservabilitySurface({
    status,
    emptyMessage,
    daemonId = null,
    sendDaemonCommand = null,
    bootstrapFallback,
    activeTab: controlledActiveTab,
    onActiveTabChange,
    helpOpen: controlledHelpOpen,
    onHelpOpenChange,
    hideControls = false,
    refreshToken,
}: MeshObservabilitySurfaceProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const branchConvergenceLabel = useMemo<Record<string, string>>(() => ({
        merged_to_main: t('mesh.obs.convergenceMergedToMain'),
        pushed_feature_branch_needs_merge: t('mesh.obs.convergenceNeedsMerge'),
        blocked_review: t('mesh.obs.convergenceBlockedReview'),
        cleanup_candidate: t('mesh.obs.convergenceCleanup'),
        not_mergeable: t('mesh.obs.convergenceNotMergeable'),
    }), [t])
    const resolvedEmptyMessage = emptyMessage ?? t('mesh.obs.emptyGraph')
    // Canonicalize once at the boundary; everything below consumes canonicalStatus
    // (nodes guaranteed an array) rather than the raw prop, so no consumer re-guards
    // against a null/missing nodes array (MESH-PAGE-NULL-NODES-CRASH class).
    const canonicalStatus = useMemo(() => canonicalizeRepoMeshStatus(status), [status])
    const isBootstrapMode = bootstrapFallback ?? isBootstrapFallbackStatus(canonicalStatus)
    const statusGraphFingerprint = useMemo(() => getRepoMeshStatusGraphFingerprint(canonicalStatus), [canonicalStatus])
    const canonicalGraph = useMemo(() => buildMeshGraph(canonicalStatus), [statusGraphFingerprint]) as MeshGraphData
    // Tab / help state can be owned by the parent (controlled) or self-managed.
    const [internalActiveTab, setInternalActiveTab] = useState<MeshSurfaceTab>('overview')
    const [internalHelpOpen, setInternalHelpOpen] = useState(false)
    const activeTab = normalizeMeshSurfaceTab(controlledActiveTab ?? internalActiveTab)
    const helpOpen = controlledHelpOpen ?? internalHelpOpen
    const setActiveTab = useCallback((tab: MeshSurfaceTab) => {
        if (onActiveTabChange) onActiveTabChange(tab)
        else setInternalActiveTab(tab)
    }, [onActiveTabChange])
    const setHelpOpen = useCallback((next: boolean) => {
        if (onHelpOpenChange) onHelpOpenChange(next)
        else setInternalHelpOpen(next)
    }, [onHelpOpenChange])
    // Lazy-mount the map: only build/render React Flow once the Map tab has
    // been opened, so the default overview tab stays cheap. Drive it off activeTab
    // so the lazy-mount works whether the tab is toggled internally or from a
    // controlled parent header.
    const [graphMounted, setGraphMounted] = useState(false)
    useEffect(() => {
        if (activeTab === 'map') setGraphMounted(true)
    }, [activeTab])
    // Same lazy-mount treatment for the Tasks tab: React Flow + ELK stay
    // unloaded until the user first opens it.
    const [taskDagMounted, setTaskDagMounted] = useState(false)
    useEffect(() => {
        if (activeTab === 'tasks') setTaskDagMounted(true)
    }, [activeTab])
    // Queue rows for the task DAG — the status snapshot carries raw queue entries
    // (dependsOn included) under queue.tasks; legacy payloads used queue.items.
    const queueTasks = useMemo<RepoMeshQueueTask[]>(() => {
        const raw = (canonicalStatus.queue as any)?.tasks ?? (canonicalStatus.queue as any)?.items ?? null
        return Array.isArray(raw) ? (raw as RepoMeshQueueTask[]) : []
    }, [canonicalStatus.queue])
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
    const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null)
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
    const [gitHistoryByWorkspace, setGitHistoryByWorkspace] = useState<Record<string, GitHistoryState>>({})
    const [healingNodeId, setHealingNodeId] = useState<string | null>(null)

    const nodeStatusById = useMemo(() => new Map(canonicalStatus.nodes.map(node => [node.nodeId, node])), [canonicalStatus.nodes])
    const graphNodeById = useMemo(() => new Map(canonicalGraph.nodes.map(node => [node.id, node])), [canonicalGraph.nodes])
    const queueSummary = canonicalStatus.queue?.summary ?? null
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const sessionEntries = useMemo(() => collectSessionEntries(canonicalStatus), [canonicalStatus])
    const machineGroups = useMemo(() => collectMachineQuotaGroups(canonicalStatus), [canonicalStatus])
    const previewVersion = typeof canonicalStatus.previewFreshness?.previewVersion === 'string' ? canonicalStatus.previewFreshness.previewVersion : undefined
    const stateCounts = useMemo(() => {
        const counts = new Map<string, { label: string; count: number }>()
        for (const entry of sessionEntries) {
            const key = sessionStatusLabel(entry.session)
            const current = counts.get(key)
            if (current) current.count += 1
            else counts.set(key, { label: sessionStatusText(entry.session, t), count: 1 })
        }
        return [...counts.values()].sort((a, b) => b.count - a.count)
    }, [sessionEntries, t])
    useEffect(() => {
        if (!selectedNodeId) return
        if (graphNodeById.has(selectedNodeId)) return
        setSelectedNodeId(null)
        setDetailSelection(current => {
            if (!current) return null
            if ('nodeId' in current && current.nodeId === selectedNodeId) return null
            return current
        })
    }, [graphNodeById, selectedNodeId])

    const selectedNodeStatus = selectedNodeId ? nodeStatusById.get(selectedNodeId) ?? null : null
    const selectedGraphNode = resolveSelectedGraphNodeForDetail(canonicalGraph, selectedNodeId)
    const selectedGraphEdge = detailSelection?.kind === 'edge' && selectedEdgeId
        ? canonicalGraph.edges.find(edge => edge.id === selectedEdgeId) ?? null
        : null
    const selectedEdgeSource = selectedGraphEdge
        ? canonicalGraph.nodes.find(node => node.id === selectedGraphEdge.source) ?? null
        : null
    const selectedEdgeTarget = selectedGraphEdge
        ? canonicalGraph.nodes.find(node => node.id === selectedGraphEdge.target) ?? null
        : null

    useEffect(() => {
        // G5-4: this used to log unconditionally on every selected-node change
        // (re-fires on any poll tick that changes selectedGraphNode/
        // selectedNodeStatus identity while a node stays selected, not just on
        // click) — gate it the same way useDevRenderTrace gates render traces.
        if (!selectedNodeId || !isMeshGraphDebugEnabled()) return
        try {
            console.info('[RepoMeshGraphDebug]', {
                event: 'selected_canonical_node',
                meshId: canonicalStatus.meshId,
                selectedNodeId,
                canonicalNode: summarizeRepoMeshCanonicalNodeDebug(selectedNodeStatus),
                graphNode: selectedGraphNode ? {
                    id: selectedGraphNode.id,
                    branch: selectedGraphNode.branch,
                    upstream: selectedGraphNode.upstream,
                    headCommit: selectedGraphNode.submoduleCommit,
                    submoduleCount: selectedNodeStatus?.git?.submodules?.length ?? 0,
                    snapshotCompleteness: selectedGraphNode.snapshotCompleteness,
                    snapshotWarnings: selectedGraphNode.snapshotWarnings,
                    branchConvergence: selectedGraphNode.branchConvergence?.status ?? null,
                } : null,
            })
        } catch {
            // Debug logging must never affect rendering.
        }
    }, [canonicalStatus.meshId, selectedGraphNode, selectedNodeId, selectedNodeStatus])
    const selectedSessionEntry = detailSelection?.kind === 'session'
        ? sessionEntries.find(entry => entry.nodeId === detailSelection.nodeId && entry.session.sessionId === detailSelection.sessionId) ?? null
        : null
    const selectedNodeSessionEntries = useMemo(
        () => sessionEntries.filter(entry => entry.nodeId === selectedNodeId),
        [selectedNodeId, sessionEntries],
    )
    const selectedGitRequest = resolveGitLogRequest({
        coordinatorDaemonId: daemonId,
        selectedNodeStatus,
        selectedSessionEntry,
        selectedGraphNode,
    })
    const selectedGitWorkspace = selectedGitRequest?.workspace ?? null
    const selectedGitHistory = selectedGitWorkspace ? gitHistoryByWorkspace[selectedGitWorkspace] ?? null : null
    const selectedHeadSummary = summarizeSelectedHead(selectedNodeStatus, selectedGitHistory?.entries ?? [])
    // The selected node's machine — its plan quota and version consensus are a
    // MACHINE property shown once in the node panel (formerly the Status tab).
    const selectedMachineGroup = selectedNodeStatus
        ? machineGroups.find(group => group.machineKey === machineKeyForMeshNode(selectedNodeStatus)) ?? null
        : null
    // Heal goes to the selected COORDINATOR, which forwards fast_forward_mesh_node to
    // the node's own daemon — the dashboard never addresses a remote node directly.
    // Without a coordinator there is no heal (never the node's own daemon).
    const selectedHealDaemonId = daemonId || null
    const canHealSelectedNode = !!(
        selectedGraphNode
        && sendDaemonCommand
        && selectedHealDaemonId
        && selectedGraphNode.type !== 'submoduleNode'
        && selectedGraphNode.behind > 0
        && selectedGraphNode.ahead === 0
        && selectedGraphNode.dirtyFiles === 0
        && !selectedGraphNode.dirty
        && !selectedGraphNode.hasConflicts
        && selectedGraphNode.upstreamStatus === 'fresh'
    )

    const closeGraphDetail = useCallback(() => {
        setSelectedNodeId(null)
        setSelectedEdgeId(null)
        setDetailSelection(null)
    }, [])

    /* "Update" = one click. The button is only offered for a clean node that is
     * strictly behind a verified upstream (canHealSelectedNode), i.e. exactly
     * the case a fast-forward cannot lose work in, so the old dry-run + confirm
     * round trip added a dialog without adding safety — the daemon re-checks
     * the same preconditions before it moves anything. The outcome is a toast. */
    const handleHealSelectedNode = useCallback(async () => {
        if (!selectedGraphNode || !selectedHealDaemonId || !sendDaemonCommand || !canHealSelectedNode) return
        const label = selectedGraphNode.label
        setHealingNodeId(selectedGraphNode.id)
        const healWorkspace = selectedNodeStatus?.workspace ?? selectedGraphNode.workspace ?? ''
        try {
            const executedRaw = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                workspace: healWorkspace,
                // Match the coordinator mesh_fast_forward_node path: after a clean superproject
                // ff that changes gitlinks, run `git submodule update --init --recursive` so the
                // worktree doesn't drift. Without this the Update button ff's the superproject but
                // leaves submodules out-of-sync.
                updateSubmodules: true,
                dryRun: false,
                execute: true,
            })
            // Cloud wraps the daemon response in { success, result }; standalone returns it directly.
            const executed = executedRaw?.result ?? executedRaw
            if (executed?.executed === true) {
                eventManager.showToast(t('mesh.obs.healDone', { label }), 'success')
            } else {
                const reason = (typeof executed?.operationError === 'string' && executed.operationError)
                    || (typeof executed?.code === 'string' && executed.code)
                    || t('mesh.obs.noResultCode')
                eventManager.showToast(t('mesh.obs.healFailed', { label, reason }), 'warning')
            }
        } catch (error) {
            eventManager.showToast(t('mesh.obs.healFailed', { label, reason: error instanceof Error ? error.message : String(error) }), 'warning')
        } finally {
            setHealingNodeId(null)
        }
    }, [canHealSelectedNode, canonicalStatus.meshId, selectedGraphNode, selectedHealDaemonId, selectedNodeStatus?.workspace, sendDaemonCommand, t])

    useEffect(() => {
        if (!selectedGraphNode && !selectedGraphEdge && !diagnosticsOpen) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            closeGraphDetail()
            setDiagnosticsOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [closeGraphDetail, diagnosticsOpen, selectedGraphEdge, selectedGraphNode])

    useEffect(() => {
        if (!selectedGitRequest || !sendDaemonCommand) return
        const { daemonId: targetDaemonId, workspace, nodeId: gitNodeId } = selectedGitRequest
        const meshIdForGitLog = canonicalStatus.meshId
        if (!meshIdForGitLog) return
        const existing = gitHistoryByWorkspace[workspace]
        if (existing?.loading || (existing && (existing.entries.length > 0 || existing.error))) return

        let cancelled = false
        setGitHistoryByWorkspace(current => ({
            ...current,
            [workspace]: {
                loading: true,
                error: null,
                entries: current[workspace]?.entries ?? [],
            },
        }))

        // Through the coordinator: mesh_node_git_log serves a local node itself and
        // forwards a remote node's read over the mesh channel.
        void sendDaemonCommand(targetDaemonId, 'mesh_node_git_log', { meshId: meshIdForGitLog, nodeId: gitNodeId, limit: 5 })
            .then(response => {
                if (cancelled) return
                setGitHistoryByWorkspace(current => ({
                    ...current,
                    [workspace]: {
                        loading: false,
                        error: null,
                        entries: extractGitLogEntries(response),
                    },
                }))
            })
            .catch(error => {
                if (cancelled) return
                setGitHistoryByWorkspace(current => ({
                    ...current,
                    [workspace]: {
                        loading: false,
                        error: error instanceof Error ? error.message : 'git_log failed',
                        entries: [],
                    },
                }))
            })

        return () => {
            cancelled = true
        }
    }, [canonicalStatus.meshId, gitHistoryByWorkspace, selectedGitRequest, sendDaemonCommand])

    const stats = canonicalGraph.stats
    const statusWarnings = [
        ...(canonicalGraph.warnings ?? []),
        ...(canonicalStatus.nodes.filter(node => node.machineStatus && node.machineStatus !== 'online').map(node => `${nodeDisplayName(node)}: ${node.machineStatus}`)),
    ]
    const hasSnapshotGaps = stats.incompleteSnapshotNodes > 0
    const failedRefineJobs = ((canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined)?.filter(j => j.status === 'failed').length ?? 0
    const providerSkewCount = Array.isArray(canonicalStatus.providerVersionSkew) ? canonicalStatus.providerVersionSkew.length : 0
    const headlineLabel = stats.followUpNodes > 0
        ? t('mesh.obs.headlineFollowUp', { count: stats.followUpNodes })
        : hasSnapshotGaps
            ? t('mesh.obs.headlineIncomplete')
            : t('mesh.obs.headlineConverged')
    const headlineTone = stats.followUpNodes > 0 ? 'danger' : hasSnapshotGaps ? 'warn' : 'good'
    // Everything the old badge row + Health popover showed, as one tooltip on
    // the headline chip. Only non-zero facts are listed.
    const headlineDetail = [
        t('mesh.obs.badgeNodes', { count: stats.totalNodes }),
        stats.totalActiveSessions > 0 ? t('mesh.obs.badgeAttachedChats', { count: stats.totalActiveSessions }) : null,
        ...stateCounts.slice(0, 3).map(entry => `${entry.count} ${entry.label}`),
        (queueSummary?.active ?? 0) > 0 ? t('mesh.obs.badgeActiveQueue', { count: queueSummary?.active ?? 0 }) : null,
        (queueSummary?.pending ?? 0) > 0 ? `${t('mesh.health.statPending')}: ${queueSummary?.pending}` : null,
        (queueSummary?.failed ?? 0) > 0 ? `${t('mesh.health.statFailed')}: ${queueSummary?.failed}` : null,
        ledgerSummary.recentFailures > 0 ? t('mesh.obs.legendRecentFailures', { count: ledgerSummary.recentFailures }) : null,
        failedRefineJobs > 0 ? t('mesh.obs.healthRefineFailed', { count: failedRefineJobs }) : null,
        stats.cleanupCandidateNodes > 0 ? t('mesh.obs.badgeCleanupTitle', { count: stats.cleanupCandidateNodes }) : null,
        stats.dirtyNodes > 0 ? t('mesh.obs.legendDirty', { count: stats.dirtyNodes }) : null,
        stats.orphanNodes > 0 ? t('mesh.obs.legendOrphan', { count: stats.orphanNodes }) : null,
        stats.incompleteSnapshotNodes > 0 ? t('mesh.obs.badgeIncompleteTitle', { count: stats.incompleteSnapshotNodes }) : null,
        stats.missingGitSnapshotNodes > 0 ? t('mesh.obs.badgeNoGitTitle', { count: stats.missingGitSnapshotNodes }) : null,
        stats.missingSubmoduleSnapshotNodes > 0 ? t('mesh.obs.badgeNoSubmodTitle', { count: stats.missingSubmoduleSnapshotNodes }) : null,
        stats.staleGitSnapshotNodes > 0 ? t('mesh.obs.badgeStaleTitle', { count: stats.staleGitSnapshotNodes }) : null,
        ...statusWarnings,
    ].filter(Boolean).join('\n')

    /* Direction is the USER's choice, defaulting to TB (owner call 2026-09-02).
     * The former 'auto' mode picked a direction from the data, so the same mesh
     * could flip orientation as it changed — the layout appeared to move on its
     * own. A stable default the user can override reads as a tool; a layout that
     * re-decides for you does not.
     *
     * TB is also why the old caveat here no longer bites: an explicit direction
     * prop suppresses MeshGraphView's narrow-viewport TB fallback, which made a
     * hard 'LR' default force phones into the wide horizontal pipeline. TB is
     * what that fallback wanted anyway. */
    const [directionPref, setDirectionPref] = useState<'LR' | 'TB'>('TB')

    // Theme-token chrome: pressed = the app accent, idle = neutral outline.
    const directionToggleButtonClass = (active: boolean) =>
        active
            ? 'rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent'
            : 'rounded-md border border-border-default bg-transparent px-2 py-0.5 text-text-muted hover:text-text-primary'
    const headerButtonClass = 'inline-flex h-7 items-center gap-1.5 rounded-lg border border-border-default bg-bg-glass px-2.5 text-xs font-medium text-text-secondary transition hover:bg-bg-glass-hover hover:text-text-primary'
    const panelClass = 'absolute inset-x-3 bottom-3 top-3 z-20 overflow-y-auto rounded-xl border border-border-default bg-surface-primary p-4 shadow-lg sm:relative sm:inset-auto sm:z-auto sm:shrink-0 sm:rounded-none sm:border-0 sm:border-l sm:border-border-subtle sm:bg-transparent sm:shadow-none'
    const closeButtonClass = 'shrink-0 rounded-full border border-border-default bg-bg-glass px-2 py-0.5 text-xs text-text-secondary transition hover:bg-bg-glass-hover hover:text-text-primary'
    const sectionLabelClass = `mb-1.5 text-3xs font-medium ${meshTheme.textMuted}`

    const legendContent = (
        <div className="flex w-64 max-w-full flex-col gap-3 text-xs">
            <div className="flex items-center justify-between gap-2">
                <span className="text-text-muted">{t('mesh.obs.layoutDirectionAria')}</span>
                <div className="flex items-center gap-0.5 text-3xs" role="group" aria-label={t('mesh.obs.layoutDirectionAria')}>
                    <button type="button" aria-pressed={directionPref === 'LR'} onClick={() => setDirectionPref('LR')} className={directionToggleButtonClass(directionPref === 'LR')} title={t('mesh.obs.directionLRTitle')}>{t('mesh.obs.directionLRShort')}</button>
                    <button type="button" aria-pressed={directionPref === 'TB'} onClick={() => setDirectionPref('TB')} className={directionToggleButtonClass(directionPref === 'TB')} title={t('mesh.obs.directionTBTitle')}>{t('mesh.obs.directionTBShort')}</button>
                </div>
            </div>
            <div className="flex flex-col gap-1 text-2xs text-text-secondary">
                <span>{t('mesh.obs.legendAnchor')}</span>
                <span>{t('mesh.obs.legendPeerLink')}</span>
                <span>{t('mesh.obs.legendSubmoduleLink')}</span>
            </div>
            <MeshGraphEdgeLegend edges={canonicalGraph.edges} />
        </div>
    )

    const openDiagnostics = () => {
        closeGraphDetail()
        setDiagnosticsOpen(open => !open)
    }

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* ── Tab bar — hidden when a parent (the dialog header) renders it. ── */}
            {!hideControls && (
                <div className="shrink-0">
                    <MeshSurfaceTabControls
                        meshTheme={meshTheme}
                        activeTab={activeTab}
                        onActiveTabChange={setActiveTab}
                        helpOpen={helpOpen}
                        onHelpOpenChange={setHelpOpen}
                    />
                </div>
            )}

            {/* ── Consolidated help panel — spans every tab, in flow so it never clips the header ── */}
            {helpOpen && <MeshHelpPanel meshTheme={meshTheme} onClose={() => setHelpOpen(false)} />}

            {/* ── Overview tab: text/card surface (own scroll region) ──
                 The cards can exceed the dialog body height, so this wrapper is the
                 bounded scroll container (min-h-0 + flex-1 + overflow-y-auto). Without
                 it the cards get clipped by the dialog shell's overflow-hidden and the
                 dashboard "full view" cannot scroll down to the lower cards. */}
            <div id="mesh-surface-panel-overview" role="tabpanel" aria-labelledby="mesh-surface-tab-overview" className={`${activeTab === 'overview' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col gap-3 overflow-y-auto`}>
                {activeTab === 'overview' && (
                    <MeshOverviewCards
                        status={canonicalStatus}
                        daemonId={daemonId}
                        meshId={canonicalStatus.meshId}
                        sendDaemonCommand={sendDaemonCommand}
                    />
                )}
            </div>

            {/* ── Tasks tab: the blueprint (lazily mounted) ── */}
            <div id="mesh-surface-panel-tasks" role="tabpanel" aria-labelledby="mesh-surface-tab-tasks" className={`${activeTab === 'tasks' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ minHeight: 320 }}>
                    {taskDagMounted ? (
                        // absolute-fill so the embedded per-mission React Flow gets a
                        // CONCRETE height — a percentage height through the flex chain
                        // resolves to 0 when the card only has a min-height.
                        <div className="absolute inset-0 flex flex-col">
                            <MeshBlueprintView
                                tasks={queueTasks}
                                status={canonicalStatus}
                                daemonId={daemonId}
                                sendDaemonCommand={sendDaemonCommand}
                                refreshToken={refreshToken}
                            />
                        </div>
                    ) : (
                        <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-text-muted">{t('mesh.obs.loadingGraph')}</div>
                    )}
                </div>
            </div>

            {/* ── Map tab: topology + node side panel + Diagnostics (lazily mounted) ── */}
            <div id="mesh-surface-panel-map" role="tabpanel" aria-labelledby="mesh-surface-tab-map" className={`${activeTab === 'map' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col gap-4`}>
            <div className="relative flex min-h-0 flex-1 flex-col" style={{ minHeight: 320 }}>

                {/* Header — one headline chip (details in its tooltip), chips only
                    for states a user can act on, then Diagnostics + Legend. */}
                <div className="relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 pt-1 pb-2 sm:mb-1">
                    <div className={`flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs ${meshTheme.textSecondary}`}>
                        <Badge label={headlineLabel} tone={headlineTone} title={headlineDetail} className="shrink-0" />
                        {stats.blockedReviewNodes + stats.notMergeableNodes > 0 && (
                            <Badge
                                label={t('mesh.obs.badgeBlocked', { count: stats.blockedReviewNodes + stats.notMergeableNodes })}
                                title={[
                                    stats.blockedReviewNodes > 0 ? t('mesh.obs.badgeBlockedTitle', { count: stats.blockedReviewNodes }) : null,
                                    stats.notMergeableNodes > 0 ? t('mesh.obs.badgeNotMergeable', { count: stats.notMergeableNodes }) : null,
                                ].filter(Boolean).join('\n')}
                                tone="danger"
                                className="shrink-0"
                            />
                        )}
                        {stats.mergeReadyNodes > 0 && (
                            <Badge label={t('mesh.obs.badgeNeedMerge', { count: stats.mergeReadyNodes })} tone="warn" className="shrink-0" />
                        )}
                        {stats.offlineNodes > 0 && (
                            <Badge label={t('mesh.obs.badgeOffline', { count: stats.offlineNodes })} tone="danger" className="shrink-0" />
                        )}
                        {providerSkewCount > 0 && (
                            <Badge label={t('mesh.statusTab.providerSkew', { count: providerSkewCount })} title={t('mesh.statusTab.providerSkewHint')} tone="warn" className="shrink-0" />
                        )}
                        {isBootstrapMode && canonicalGraph.nodes.length > 0 && (
                            <span className={`inline-flex items-center gap-1.5 text-2xs ${meshTheme.textMuted}`} role="status">
                                <IconSpinner size={11} />
                                {t('connection.loadingShort')}
                            </span>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={openDiagnostics}
                            aria-pressed={diagnosticsOpen}
                            className={`${headerButtonClass} ${diagnosticsOpen ? '!border-accent/50 !text-accent' : ''}`}
                        >
                            <IconWrench size={12} />
                            {t('common.diagnostics')}
                        </button>
                        <PopoverButton label={t('mesh.obs.legend')} content={legendContent} className={headerButtonClass}>
                            <IconHelp size={12} />
                            {t('mesh.obs.legend')}
                        </PopoverButton>
                    </div>
                </div>

                {/* Graph canvas + right side panel (node / edge / diagnostics) */}
                <div className="relative flex flex-1 min-w-0" style={{ minHeight: 360 }}>
                    {/* Graph */}
                    <div className="flex-1 min-w-0">
                        {!graphMounted ? (
                            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-text-muted">{t('mesh.obs.loadingGraph')}</div>
                        ) : canonicalGraph.nodes.length > 0 ? (
                            <MeshGraphView
                                data={canonicalGraph}
                                selectedNodeId={selectedNodeId}
                                directionPref={directionPref}
                                onNodeClick={node => {
                                    const shouldCollapse = detailSelection?.kind === 'node' && selectedNodeId === node.id
                                    if (shouldCollapse) {
                                        closeGraphDetail()
                                        return
                                    }
                                    setDiagnosticsOpen(false)
                                    setSelectedEdgeId(null)
                                    setSelectedNodeId(node.id)
                                    setDetailSelection({ kind: 'node', nodeId: node.id })
                                }}
                                onEdgeClick={edge => {
                                    const shouldCollapse = detailSelection?.kind === 'edge' && selectedEdgeId === edge.id
                                    if (shouldCollapse) {
                                        closeGraphDetail()
                                        return
                                    }
                                    setDiagnosticsOpen(false)
                                    setSelectedNodeId(null)
                                    setSelectedEdgeId(edge.id)
                                    setDetailSelection({ kind: 'edge', edgeId: edge.id })
                                }}
                            />
                        ) : (
                            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-text-muted">{resolvedEmptyMessage}</div>
                        )}
                    </div>

                    {/* Diagnostics — per-machine runtime, scheduling, protocol and
                        version internals (what the old Status tab showed). */}
                    {diagnosticsOpen && (
                        <div role="dialog" aria-label={t('common.diagnostics')} className={`${panelClass} sm:w-96`}>
                            <div className="mb-2 flex items-center justify-between gap-2">
                                <div className={`text-sm font-semibold ${meshTheme.textPrimary}`}>{t('common.diagnostics')}</div>
                                <button type="button" onClick={() => setDiagnosticsOpen(false)} aria-label={t('mesh.obs.closeDetailAria')} className={closeButtonClass}>✕</button>
                            </div>
                            <MeshStatusTab canonicalStatus={canonicalStatus} />
                        </div>
                    )}

                    {/* Right sidebar — selected node detail */}
                    {selectedGraphNode && detailSelection?.kind === 'node' && (() => {
                        const machineId = selectedGraphNode.machineId ?? selectedNodeStatus?.machineId
                        const nodeDaemonId = selectedGraphNode.daemonId ?? selectedNodeStatus?.daemonId
                        const source = selectedNodeStatus?.connection?.source ?? describeGraphNodeSource(selectedGraphNode)
                        const transport = selectedNodeStatus?.connection?.transport
                        const health = selectedNodeStatus?.health ?? selectedGraphNode.health
                        const connectionState = selectedNodeStatus?.connection?.state
                        const nodeTasks = queueTasks.filter(task => getQueueTaskNodeTarget(task) === selectedNodeId).slice(0, 3)
                        return (
                        <div role="dialog" aria-label={selectedGraphNode.label} className={`${panelClass} sm:w-80`}>
                            <div className="mb-3 flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphNode.label}</div>
                                    {selectedGraphNode.machineLabel && (
                                        <div className={`mt-0.5 truncate text-2xs ${meshTheme.textMuted}`}>{selectedGraphNode.machineLabel}</div>
                                    )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    {selectedGraphNode.behind > 0 && (
                                        <Tooltip content={canHealSelectedNode ? t('mesh.obs.healHint') : t('mesh.obs.healUnavailableHint')}>
                                            <button
                                                type="button"
                                                onClick={() => { void handleHealSelectedNode() }}
                                                disabled={!canHealSelectedNode || healingNodeId === selectedGraphNode.id}
                                                className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
                                            >
                                                {healingNodeId === selectedGraphNode.id ? t('mesh.obs.checking') : t('mesh.obs.heal')}
                                            </button>
                                        </Tooltip>
                                    )}
                                    <button
                                        type="button"
                                        onClick={closeGraphDetail}
                                        aria-label={t('mesh.obs.closeDetailAria')}
                                        className={closeButtonClass}
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                            <div className="mb-3 flex flex-wrap gap-1.5">
                                <Badge label={nodeHealthText(health, t)} tone={health === 'unknown' ? 'default' : healthTone(health)} />
                                {selectedGraphNode.branch && <Badge label={selectedGraphNode.branch} tone="default" />}
                                {selectedGraphNode.ahead > 0 && <Badge label={t('mesh.obs.aheadCount', { count: selectedGraphNode.ahead })} tone="warn" />}
                                {selectedGraphNode.behind > 0 && <Badge label={t('mesh.obs.behindCount', { count: selectedGraphNode.behind })} tone="warn" />}
                                {selectedGraphNode.dirtyFiles > 0 && <Badge label={t('mesh.drift.changed', { count: selectedGraphNode.dirtyFiles })} tone="warn" />}
                                {connectionState && connectionState !== 'connected' && connectionState !== 'self' && connectionState !== 'unknown' && (
                                    <Badge label={t('mesh.nodeHealth.degraded')} title={t('mesh.nodeHealth.degradedHint')} tone="danger" />
                                )}
                                {transport === 'relay' && <Badge label={t('mesh.graph.slowLinkChip')} title={t('mesh.panel.tooltipP2PRelayed')} tone="info" />}
                            </div>
                            <div className="grid gap-1.5 text-xs">
                                <Row label={t('mesh.obs.fieldWorkspace')} value={selectedNodeStatus?.workspace ?? selectedGraphNode.workspace} />
                                {selectedHeadSummary && (
                                    <Row label={t('mesh.obs.fieldHead')} value={selectedHeadSummary} />
                                )}
                                {selectedGraphNode.upstream && (
                                    <Row label={t('mesh.obs.fieldUpstream')} value={selectedGraphNode.upstream} />
                                )}
                            </div>
                            {selectedNodeStatus && (
                                <div className="mt-3">
                                    <MeshNodeRuntimeChips node={selectedNodeStatus} previewVersion={previewVersion} hideHealth />
                                </div>
                            )}
                            {selectedNodeSessionEntries.length > 0 && (
                                <div className="mt-3">
                                    <div className={sectionLabelClass}>{t('mesh.obs.activeSessions')}</div>
                                    <div className="flex flex-col gap-1.5">
                                        {selectedNodeSessionEntries.map(entry => {
                                            const elapsed = sessionElapsedLabel(entry.session)
                                            return (
                                                <button
                                                    type="button"
                                                    key={entry.session.sessionId}
                                                    onClick={() => requestOpenSessionChat({ sessionId: entry.session.sessionId, source: 'mesh-topology-panel' })}
                                                    title={t('sessionNav.openChatHint')}
                                                    className="w-full rounded-lg border border-border-subtle bg-bg-glass px-2.5 py-1.5 text-left text-2xs transition hover:bg-bg-glass-hover"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className={`min-w-0 truncate ${meshTheme.textPrimary}`}>{entry.session.providerType || t('mesh.obs.providerUnknown')}</span>
                                                        <Badge label={sessionStatusText(entry.session, t)} tone={sessionTone(sessionStatusLabel(entry.session))} />
                                                    </div>
                                                    <div className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 ${meshTheme.textMuted}`}>
                                                        <span>{sessionRoleText(entry.session, t)}</span>
                                                        {!elapsed.includes('not reported') && <span>{elapsed}</span>}
                                                    </div>
                                                    {entry.session.statusNote && (
                                                        <div className={`mt-1 text-3xs leading-4 ${meshTheme.textMuted}`}>
                                                            {entry.session.statusNote}
                                                        </div>
                                                    )}
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}
                            {nodeTasks.length > 0 && (
                                <div className="mt-3">
                                    <div className={sectionLabelClass}>{t('mesh.obs.queueTasks')}</div>
                                    <div className="flex flex-col gap-1.5">
                                        {nodeTasks.map(task => (
                                            <div key={task.id} className="rounded-lg border border-border-subtle bg-bg-glass px-2.5 py-1.5 text-2xs">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className={`min-w-0 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{queueTaskDisplayText(task.message) || task.id.slice(0, 12)}</span>
                                                    <Badge label={task.status ? queueTaskStatusLabel(task.status, t) : t('sessionStatus.unknown')} tone={sessionTone(task.status)} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {selectedMachineGroup && (
                                <div className="mt-3">
                                    <div className={sectionLabelClass}>{t('mesh.obs.machineSection')}</div>
                                    <MeshMachineQuotaCard machine={selectedMachineGroup} />
                                </div>
                            )}
                            {selectedGraphNode.snapshotWarnings.length > 0 && (
                                <div className="mt-3 rounded-lg border border-status-warning/35 p-3 text-xs text-text-primary">
                                    <div className="font-medium text-status-warning">{t('mesh.obs.keyWarning')}</div>
                                    <div className="mt-1">{selectedGraphNode.snapshotWarnings[0]}</div>
                                </div>
                            )}
                            {selectedGraphNode.branchConvergence && (selectedGraphNode.branchConvergence.reason || selectedGraphNode.branchConvergence.nextStep) && (
                                <div className="mt-3 rounded-lg border border-border-default bg-bg-glass p-3 text-xs text-text-primary">
                                    <div className="font-medium">{t('mesh.obs.followUpLabel', { status: branchConvergenceLabel[selectedGraphNode.branchConvergence.status] ?? selectedGraphNode.branchConvergence.status })}</div>
                                    {selectedGraphNode.branchConvergence.reason && (
                                        <div className="mt-1">{selectedGraphNode.branchConvergence.reason}</div>
                                    )}
                                    {selectedGraphNode.branchConvergence.nextStep && (
                                        <div className={`${selectedGraphNode.branchConvergence.reason ? 'mt-1.5 pt-1.5 border-t border-border-subtle' : 'mt-1'}`}>{selectedGraphNode.branchConvergence.nextStep}</div>
                                    )}
                                </div>
                            )}
                            <TechnicalDetails
                                className="mt-3"
                                summaryClassName={meshTheme.textMuted}
                                rows={[
                                    { label: t('mesh.obs.fieldNodeId'), value: selectedGraphNode.id },
                                    { label: t('mesh.obs.fieldMachineId'), value: machineId ?? null },
                                    { label: t('mesh.obs.fieldDaemonId'), value: nodeDaemonId ?? null },
                                    { label: t('mesh.obs.fieldSource'), value: source && source !== 'unknown' ? String(source) : null, copyable: false },
                                    { label: t('mesh.obs.fieldTransport'), value: transport && transport !== 'unknown' ? transport : null, copyable: false },
                                    { label: t('mesh.obs.fieldLocality'), value: selectedGraphNode.locality && selectedGraphNode.locality !== 'unknown' ? selectedGraphNode.locality : null, copyable: false },
                                    { label: t('mesh.obs.fieldHealthRaw'), value: health, copyable: false },
                                    ...selectedNodeSessionEntries.map(entry => ({ label: t('mesh.overview.detailLabelSessionId'), value: entry.session.sessionId })),
                                ]}
                            />
                        </div>
                        )
                    })()}

                    {/* Selected edge detail — pinned by clicking an edge (replaces the
                        old hover preview; click is the primary drill-down path). */}
                    {selectedGraphEdge && detailSelection?.kind === 'edge' && (
                        <div role="dialog" aria-label={t('mesh.obs.selectedEdge')} className={`${panelClass} sm:w-72`}>
                            <div className={`mb-2 text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.obs.selectedEdge')}</div>
                            <div className="mb-3 flex items-start justify-between gap-2">
                                <div className={`min-w-0 truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{t(`mesh.legendEdge.${selectedGraphEdge.type}`)}</div>
                                <button
                                    type="button"
                                    onClick={closeGraphDetail}
                                    aria-label={t('mesh.obs.closeDetailAria')}
                                    className={closeButtonClass}
                                >
                                    ✕
                                </button>
                            </div>
                            <div className="grid gap-1.5 text-xs">
                                <Row label={t('mesh.obs.fieldFrom')} value={selectedEdgeSource?.label ?? selectedGraphEdge.source} />
                                <Row label={t('mesh.obs.fieldTo')} value={selectedEdgeTarget?.label ?? selectedGraphEdge.target} />
                                {selectedGraphEdge.label && <Row label={t('mesh.obs.fieldLabel')} value={selectedGraphEdge.label} />}
                            </div>
                            <TechnicalDetails
                                className="mt-3"
                                summaryClassName={meshTheme.textMuted}
                                rows={[{ label: t('mesh.obs.fieldEdgeId'), value: selectedGraphEdge.id }]}
                            />
                        </div>
                    )}
                </div>
            </div>
            </div>
        </div>
        </MeshGraphThemeContext.Provider>
    )
}
