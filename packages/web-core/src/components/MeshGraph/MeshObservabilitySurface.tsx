import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import MeshGraphView from './MeshGraphView'
import MeshBlueprintView from './MeshBlueprintView'
import MeshOverviewCards from './MeshOverviewCards'
import { MeshHelpPanel, MeshHelpToggle } from './MeshHelpPanel'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import type { MeshGraphData } from './types'
import { buildMeshGraph } from '../../utils/mesh-visualization'
import { canonicalizeRepoMeshStatus, summarizeRepoMeshCanonicalNodeDebug } from '../../utils/repo-mesh-status'
import { MeshGraphThemeContext } from './MeshObservabilitySurface/meshSurfaceTheme'
import { Badge, Row } from './MeshObservabilitySurface/meshSurfacePrimitives'
import { MeshStatusTab } from './MeshObservabilitySurface/MeshStatusTab'
import { MeshNotesTab } from './MeshObservabilitySurface/MeshNotesTab'
import { MeshHealthPanel } from './MeshObservabilitySurface/MeshHealthPanel'
import {
    EMPTY_LEDGER_SUMMARY,
    collectSessionEntries,
    connectionTone,
    describeConnection,
    describeGraphNodeSource,
    edgeDirectionLabel,
    edgeTypeLabel,
    extractGitLogEntries,
    getQueueTaskNodeTarget,
    getRepoMeshStatusGraphFingerprint,
    healthTone,
    isBootstrapFallbackStatus,
    resolveGitLogRequest,
    resolveSelectedGraphNodeForDetail,
    sessionElapsedLabel,
    sessionRoleLabel,
    sessionStatusLabel,
    sessionTone,
    shortSessionId,
    summarizeSelectedHead,
    type AsyncRefineJob,
    type GitHistoryState,
    type HealPreviewState,
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

type DetailSelection =
    | { kind: 'node'; nodeId: string }
    | { kind: 'edge'; edgeId: string }
    | { kind: 'session'; nodeId: string; sessionId: string }
    | { kind: 'queue'; taskId: string }

export type MeshSurfaceTab = 'overview' | 'tasks' | 'status' | 'notes' | 'graph'

interface MeshObservabilitySurfaceProps {
    status: RepoMeshStatus
    emptyMessage?: string
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    /** When true, the graph is showing bootstrap inventory data pending live peer truth. */
    bootstrapFallback?: boolean
    /**
     * Controlled tab/help state. When provided, the parent owns the Overview↔Graph
     * toggle and the "?" help toggle (e.g. to host them in the dialog header to save
     * a vertical row). Leave undefined for the standalone, self-managed behaviour.
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
}

/**
 * Overview↔Graph tab toggle + "?" help toggle. Extracted so it can be rendered
 * either inline by MeshObservabilitySurface (standalone use) or hoisted into a
 * parent header row (e.g. DashboardMeshGraphDialog) to save vertical space.
 */
export function MeshSurfaceTabControls({
    meshTheme,
    activeTab,
    onActiveTabChange,
    helpOpen,
    onHelpOpenChange,
}: {
    meshTheme: MeshGraphTheme
    activeTab: MeshSurfaceTab
    onActiveTabChange: (tab: MeshSurfaceTab) => void
    helpOpen: boolean
    onHelpOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation('common')
    const tabButtonClass = (active: boolean) => active
        ? (meshTheme.isDark
            ? 'rounded-lg px-3.5 py-1.5 text-xs font-semibold text-slate-100 bg-white/[0.08] border border-white/12'
            : 'rounded-lg px-3.5 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 shadow-sm')
        : `rounded-lg px-3.5 py-1.5 text-xs font-medium ${meshTheme.textSecondary} border border-transparent hover:bg-white/[0.04]`
    return (
        <div className="flex items-center gap-2">
            <div className={`inline-flex w-fit items-center gap-1 rounded-xl border p-1 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`} role="tablist" aria-label="Mesh view">
                <button type="button" role="tab" aria-selected={activeTab === 'overview'} className={tabButtonClass(activeTab === 'overview')} onClick={() => onActiveTabChange('overview')}>{t('meshGraph.obs.tabOverview')}</button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'tasks'}
                    className={tabButtonClass(activeTab === 'tasks')}
                    onClick={() => onActiveTabChange('tasks')}
                >
                    {t('meshGraph.obs.tabTasks')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'status'}
                    className={tabButtonClass(activeTab === 'status')}
                    onClick={() => onActiveTabChange('status')}
                >
                    {t('meshGraph.obs.tabStatus')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'notes'}
                    className={tabButtonClass(activeTab === 'notes')}
                    onClick={() => onActiveTabChange('notes')}
                >
                    {t('meshGraph.notes.tab')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'graph'}
                    className={tabButtonClass(activeTab === 'graph')}
                    onClick={() => onActiveTabChange('graph')}
                >
                    {t('meshGraph.obs.tabGraph')}
                </button>
            </div>
            <MeshHelpToggle meshTheme={meshTheme} open={helpOpen} onToggle={() => onHelpOpenChange(!helpOpen)} />
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
}: MeshObservabilitySurfaceProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const branchConvergenceLabel = useMemo<Record<string, string>>(() => ({
        merged_to_main: t('meshGraph.obs.convergenceMergedToMain'),
        pushed_feature_branch_needs_merge: t('meshGraph.obs.convergenceNeedsMerge'),
        blocked_review: t('meshGraph.obs.convergenceBlockedReview'),
        cleanup_candidate: t('meshGraph.obs.convergenceCleanup'),
        not_mergeable: t('meshGraph.obs.convergenceNotMergeable'),
    }), [t])
    const resolvedEmptyMessage = emptyMessage ?? t('meshGraph.obs.emptyGraph')
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
    const activeTab = controlledActiveTab ?? internalActiveTab
    const helpOpen = controlledHelpOpen ?? internalHelpOpen
    const setActiveTab = useCallback((tab: MeshSurfaceTab) => {
        if (onActiveTabChange) onActiveTabChange(tab)
        else setInternalActiveTab(tab)
    }, [onActiveTabChange])
    const setHelpOpen = useCallback((next: boolean) => {
        if (onHelpOpenChange) onHelpOpenChange(next)
        else setInternalHelpOpen(next)
    }, [onHelpOpenChange])
    // Lazy-mount the graph: only build/render React Flow once the graph tab has
    // been opened, so the default overview tab stays cheap. Drive it off activeTab
    // so the lazy-mount works whether the tab is toggled internally or from a
    // controlled parent header.
    const [graphMounted, setGraphMounted] = useState(false)
    useEffect(() => {
        if (activeTab === 'graph') setGraphMounted(true)
    }, [activeTab])
    // Same lazy-mount treatment for the task-DAG tab: React Flow + ELK stay
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
    const [gitHistoryByWorkspace, setGitHistoryByWorkspace] = useState<Record<string, GitHistoryState>>({})
    const [healPreview, setHealPreview] = useState<HealPreviewState | null>(null)
    const { confirm, confirmDialog } = useConfirmDialog()
    const [healingNodeId, setHealingNodeId] = useState<string | null>(null)

    const nodeStatusById = useMemo(() => new Map(canonicalStatus.nodes.map(node => [node.nodeId, node])), [canonicalStatus.nodes])
    const graphNodeById = useMemo(() => new Map(canonicalGraph.nodes.map(node => [node.id, node])), [canonicalGraph.nodes])
    const queueSummary = canonicalStatus.queue?.summary ?? null
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const sessionEntries = useMemo(() => collectSessionEntries(canonicalStatus), [canonicalStatus])
    const stateCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const entry of sessionEntries) {
            const label = sessionStatusLabel(entry.session)
            counts.set(label, (counts.get(label) ?? 0) + 1)
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }, [sessionEntries])
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
        if (!selectedNodeId) return
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
    const selectedHealDaemonId = selectedGraphNode?.daemonId ?? selectedNodeStatus?.daemonId ?? daemonId ?? null
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
        setHealPreview(null)
    }, [])

    useEffect(() => {
        setHealPreview(null)
    }, [selectedNodeId])

    const handleHealSelectedNode = useCallback(async () => {
        if (!selectedGraphNode || !selectedHealDaemonId || !sendDaemonCommand || !canHealSelectedNode) return
        setHealingNodeId(selectedGraphNode.id)
        setHealPreview(null)
        const healWorkspace = selectedNodeStatus?.workspace ?? selectedGraphNode.workspace ?? ''
        try {
            const dryRunRaw = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                workspace: healWorkspace,
                // Match the coordinator mesh_fast_forward_node path: after a clean superproject
                // ff that changes gitlinks, run `git submodule update --init --recursive` so the
                // worktree doesn't drift. Without this the Heal button ff's the superproject but
                // leaves submodules out-of-sync.
                updateSubmodules: true,
                dryRun: true,
                execute: false,
            })
            // Cloud wraps the daemon response in { success, result }; standalone returns it directly.
            const dryRun = dryRunRaw?.result ?? dryRunRaw
            setHealPreview({
                phase: 'dry_run',
                code: typeof dryRun?.code === 'string' ? dryRun.code : undefined,
                error: typeof dryRun?.operationError === 'string' ? dryRun.operationError : null,
                executed: dryRun?.executed === true,
            })
            if (!dryRun?.success || dryRun.code !== 'fast_forward_available') return
            const ok = await confirm({
                title: t('meshGraph.obs.fastForwardConfirmTitle', { label: selectedGraphNode.label }),
                confirmLabel: t('meshGraph.obs.fastForwardConfirmLabel'),
            })
            if (!ok) return
            const executedRaw = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                workspace: healWorkspace,
                updateSubmodules: true,
                dryRun: false,
                execute: true,
            })
            const executed = executedRaw?.result ?? executedRaw
            setHealPreview({
                phase: 'execute',
                code: typeof executed?.code === 'string' ? executed.code : undefined,
                error: typeof executed?.operationError === 'string' ? executed.operationError : null,
                executed: executed?.executed === true,
            })
        } catch (error) {
            setHealPreview({
                phase: 'dry_run',
                error: error instanceof Error ? error.message : 'fast-forward failed',
            })
        } finally {
            setHealingNodeId(null)
        }
    }, [canHealSelectedNode, canonicalStatus.meshId, confirm, selectedGraphNode, selectedHealDaemonId, sendDaemonCommand, t])

    useEffect(() => {
        if (!selectedGraphNode && !selectedGraphEdge) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeGraphDetail()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [closeGraphDetail, selectedGraphEdge, selectedGraphNode])

    useEffect(() => {
        if (!selectedGitRequest || !sendDaemonCommand) return
        const { daemonId: targetDaemonId, workspace } = selectedGitRequest
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

        void sendDaemonCommand(targetDaemonId, 'git_log', { workspace, limit: 5 })
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
    }, [gitHistoryByWorkspace, selectedGitRequest, sendDaemonCommand])

    const statusWarnings = [
        ...(canonicalGraph.warnings ?? []),
        ...(canonicalStatus.nodes.filter(node => node.machineStatus && node.machineStatus !== 'online').map(node => `${node.machineLabel}: ${node.machineStatus}`)),
    ]
    const hasSnapshotGaps = canonicalGraph.stats.incompleteSnapshotNodes > 0
    const headlineLabel = canonicalGraph.stats.followUpNodes > 0
        ? t('meshGraph.obs.headlineFollowUp', { count: canonicalGraph.stats.followUpNodes })
        : hasSnapshotGaps
            ? t('meshGraph.obs.headlineIncomplete')
            : t('meshGraph.obs.headlineConverged')
    const headlineTone = canonicalGraph.stats.followUpNodes > 0 ? 'danger' : hasSnapshotGaps ? 'warn' : 'good'

    // 'auto' (not 'LR'): an explicit direction prop suppresses MeshGraphView's
    // narrow-viewport TB fallback, so a hard 'LR' default forced phones into the
    // wide horizontal pipeline. Auto keeps LR on desktop (heuristic) and lets
    // mobile fall back to vertical.
    const [directionPref, setDirectionPref] = useState<'auto' | 'LR' | 'TB'>('auto')

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
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* ── Tab bar: Overview (cards) ↔ Graph — with the single consolidated help toggle.
                 Hidden when a parent (e.g. the dialog header) renders these controls itself. ── */}
            {!hideControls && (
                <div className="shrink-0 flex items-center justify-end">
                    <MeshSurfaceTabControls
                        meshTheme={meshTheme}
                        activeTab={activeTab}
                        onActiveTabChange={setActiveTab}
                        helpOpen={helpOpen}
                        onHelpOpenChange={setHelpOpen}
                    />
                </div>
            )}

            {/* ── Consolidated help panel — spans both tabs, in flow so it never clips the header ── */}
            {helpOpen && <MeshHelpPanel meshTheme={meshTheme} onClose={() => setHelpOpen(false)} />}

            {/* ── Overview tab: text/card surface (own scroll region) ──
                 The cards can exceed the dialog body height, so this wrapper is the
                 bounded scroll container (min-h-0 + flex-1 + overflow-y-auto). Without
                 it the cards get clipped by the dialog shell's overflow-hidden and the
                 dashboard "full view" cannot scroll down to the lower cards. */}
            <div className={`${activeTab === 'overview' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col gap-3 overflow-y-auto`}>
                {activeTab === 'overview' && (
                    <MeshOverviewCards
                        status={canonicalStatus}
                        daemonId={daemonId}
                        meshId={canonicalStatus.meshId}
                        sendDaemonCommand={sendDaemonCommand}
                    />
                )}
                {/* MAGI named-panels overview removed — the named-panel surface (magi_panel_*)
                    was deleted; only the task_kind / magi_kind_panel_* surface remains. */}
            </div>

            {/* ── Tasks tab: work-queue dependency DAG (lazily mounted) ── */}
            <div className={`${activeTab === 'tasks' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>
                <div className={`${meshTheme.cardClass} relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px]`} style={{ minHeight: 420 }}>
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
                            />
                        </div>
                    ) : (
                        <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">{t('meshGraph.obs.loadingGraph')}</div>
                    )}
                </div>
            </div>

            {/* ── Status / Runtime tab: scheduling + per-node runtime (own scroll region) ── */}
            <div className={`${activeTab === 'status' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col overflow-y-auto`}>
                {activeTab === 'status' && <MeshStatusTab canonicalStatus={canonicalStatus} />}
            </div>

            {/* ── Notes tab: manual coordinator operating-note CRUD (own scroll region) ── */}
            <div className={`${activeTab === 'notes' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col overflow-y-auto`}>
                {activeTab === 'notes' && (
                    <MeshNotesTab
                        meshId={canonicalStatus.meshId}
                        daemonId={daemonId}
                        sendDaemonCommand={sendDaemonCommand}
                    />
                )}
            </div>

            {/* ── Graph tab: existing topology card (lazily mounted) ── */}
            <div className={`${activeTab === 'graph' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col gap-4`}>
            {/* ── Card: header + graph + detail panel ── */}
            <div className={`${meshTheme.cardClass} relative flex min-h-0 flex-1 flex-col rounded-[28px]`} style={{ minHeight: 480 }}>

                {/* Header — stays in normal flow on every breakpoint so the badge
                    column pushes the canvas down instead of floating over it (and
                    intercepting the top band of graph touches on mobile). */}
                <div className={`relative z-30 max-h-[42dvh] overflow-y-auto sm:max-h-none sm:mb-3 sm:overflow-visible shrink-0 flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-2.5 border-b ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                    {/* Mobile: take a full row (basis-full) and WRAP. Previously this was
                        `flex-1 flex-nowrap overflow-x-auto`, which shared the row with the
                        shrink-0 controls block on the right — the controls claimed ~380px of
                        a 500px row, leaving the badges ~112px to hold ~712px of content, i.e.
                        a 6.4x horizontal scroller clipping the headline badge mid-word. The
                        badges wrap onto their own line(s) below sm and share the row again
                        from sm up, where there is width for both. */}
                    <div className={`flex w-full min-w-0 basis-full flex-wrap gap-2 text-xs sm:w-auto sm:flex-1 sm:basis-auto ${meshTheme.textSecondary}`}>
                        <Badge label={headlineLabel} tone={headlineTone} className="shrink-0" />
                        {canonicalGraph.stats.blockedReviewNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeBlocked', { count: canonicalGraph.stats.blockedReviewNodes })} title={t('meshGraph.obs.badgeBlockedTitle', { count: canonicalGraph.stats.blockedReviewNodes })} tone="danger" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.notMergeableNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeNotMergeable', { count: canonicalGraph.stats.notMergeableNodes })} tone="danger" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.mergeReadyNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeNeedMerge', { count: canonicalGraph.stats.mergeReadyNodes })} tone="warn" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.cleanupCandidateNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeCleanup', { count: canonicalGraph.stats.cleanupCandidateNodes })} title={t('meshGraph.obs.badgeCleanupTitle', { count: canonicalGraph.stats.cleanupCandidateNodes })} tone="info" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.offlineNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeOffline', { count: canonicalGraph.stats.offlineNodes })} tone="danger" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.incompleteSnapshotNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeIncomplete', { count: canonicalGraph.stats.incompleteSnapshotNodes })} title={t('meshGraph.obs.badgeIncompleteTitle', { count: canonicalGraph.stats.incompleteSnapshotNodes })} tone="warn" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.missingGitSnapshotNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeNoGit', { count: canonicalGraph.stats.missingGitSnapshotNodes })} title={t('meshGraph.obs.badgeNoGitTitle', { count: canonicalGraph.stats.missingGitSnapshotNodes })} tone="warn" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.missingSubmoduleSnapshotNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeNoSubmod', { count: canonicalGraph.stats.missingSubmoduleSnapshotNodes })} title={t('meshGraph.obs.badgeNoSubmodTitle', { count: canonicalGraph.stats.missingSubmoduleSnapshotNodes })} tone="warn" className="shrink-0" />
                        )}
                        {canonicalGraph.stats.staleGitSnapshotNodes > 0 && (
                            <Badge label={t('meshGraph.obs.badgeStale', { count: canonicalGraph.stats.staleGitSnapshotNodes })} title={t('meshGraph.obs.badgeStaleTitle', { count: canonicalGraph.stats.staleGitSnapshotNodes })} tone="warn" className="shrink-0" />
                        )}
                        {(queueSummary?.active ?? 0) > 0 && (
                            <Badge label={t('meshGraph.obs.badgeActiveQueue', { count: queueSummary?.active ?? 0 })} tone="info" className="shrink-0 hidden sm:inline-flex" />
                        )}
                        <Badge label={t('meshGraph.obs.badgeNodes', { count: canonicalGraph.stats.totalNodes })} tone="default" className="shrink-0 hidden sm:inline-flex" />
                        {canonicalGraph.stats.totalActiveSessions > 0 && (
                            <Badge label={t('meshGraph.obs.badgeAttachedChats', { count: canonicalGraph.stats.totalActiveSessions })} tone="info" className="shrink-0 hidden sm:inline-flex" />
                        )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {/* Direction toggle */}
                        <div
                            className={meshTheme.isDark
                                ? 'flex items-center gap-0.5 rounded-md border border-white/10 bg-slate-950/40 p-0.5 text-3xs'
                                : 'flex items-center gap-0.5 rounded-md border border-slate-300 bg-white/70 p-0.5 text-3xs'}
                            role="group"
                            aria-label="Graph layout direction"
                        >
                            <button type="button" onClick={() => setDirectionPref('auto')} className={directionToggleButtonClass(directionPref === 'auto')} title={t('meshGraph.obs.directionAutoTitle')}>{t('meshGraph.obs.directionAuto')}</button>
                            <button type="button" onClick={() => setDirectionPref('LR')} className={directionToggleButtonClass(directionPref === 'LR')} title={t('meshGraph.obs.directionLRTitle')}>LR</button>
                            <button type="button" onClick={() => setDirectionPref('TB')} className={directionToggleButtonClass(directionPref === 'TB')} title={t('meshGraph.obs.directionTBTitle')}>TB</button>
                        </div>
                        {/* Health panel button */}
                        <div className="relative">
                            <details className={`rounded-xl px-3 py-1.5 text-xs ${meshTheme.isDark ? 'border border-white/10 bg-white/[0.03] text-slate-300' : 'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                                <summary className={`cursor-pointer list-none font-medium ${meshTheme.textSecondary} [&::-webkit-details-marker]:hidden`}>
                                    {(() => {
                                        const failedRefine = ((canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined)?.filter(j => j.status === 'failed').length ?? 0
                                        const recentFail = ledgerSummary.recentFailures
                                        if (failedRefine > 0) return <span className={meshTheme.isDark ? 'text-rose-300' : 'text-rose-600'}>{t('meshGraph.obs.healthRefineFailed', { count: failedRefine })}</span>
                                        if (recentFail > 0) return <span className={meshTheme.isDark ? 'text-amber-300' : 'text-amber-600'}>{t('meshGraph.obs.healthFailures', { count: recentFail })}</span>
                                        return t('meshGraph.obs.health')
                                    })()}
                                </summary>
                                {/* Mobile: the header is a scroll container, so an absolutely-
                                    positioned dropdown gets CLIPPED into invisibility — anchor to
                                    the viewport (fixed) below sm and to the trigger on desktop. */}
                                <div className={`fixed inset-x-4 top-28 z-50 max-h-[70dvh] overflow-y-auto rounded-xl border p-4 shadow-xl backdrop-blur-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-72 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/96' : 'border-slate-200 bg-white/98 shadow-slate-900/10'}`}>
                                    <MeshHealthPanel
                                        canonicalStatus={canonicalStatus}
                                        queueSummary={queueSummary}
                                        ledgerSummary={ledgerSummary}
                                        isBootstrapMode={isBootstrapMode}
                                        meshTheme={meshTheme}
                                        sessionEntries={sessionEntries}
                                        inlineMode
                                    />
                                </div>
                            </details>
                        </div>
                        <div className="relative">
                            <details className={`rounded-xl px-3 py-1.5 text-xs ${meshTheme.isDark ? 'border border-white/10 bg-white/[0.03] text-slate-300' : 'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                                <summary className={`cursor-pointer list-none font-medium ${meshTheme.textSecondary} [&::-webkit-details-marker]:hidden`}>
                                    {t('meshGraph.obs.legend')}
                                </summary>
                                <div className={`fixed inset-x-4 top-28 z-50 max-h-[70dvh] overflow-y-auto rounded-xl border p-3 shadow-xl backdrop-blur-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-72 sm:max-h-none sm:overflow-visible ${meshTheme.isDark ? 'border-white/10 bg-slate-950/96' : 'border-slate-200 bg-white/98 shadow-slate-900/10'}`}>
                                    <div className="flex flex-col gap-3">
                                        <div className="flex flex-wrap gap-2">
                                            <Badge label={t('meshGraph.obs.legendDirty', { count: canonicalGraph.stats.dirtyNodes })} tone={canonicalGraph.stats.dirtyNodes > 0 ? 'warn' : 'good'} />
                                            <Badge label={t('meshGraph.obs.legendOrphan', { count: canonicalGraph.stats.orphanNodes })} tone={canonicalGraph.stats.orphanNodes > 0 ? 'warn' : 'good'} />
                                            <Badge label={t('meshGraph.obs.legendRecentFailures', { count: ledgerSummary.recentFailures })} tone={ledgerSummary.recentFailures > 0 ? 'danger' : 'good'} />
                                            {stateCounts.length === 0 ? (
                                                <Badge label={t('meshGraph.obs.legendNoSessionMeta')} />
                                            ) : stateCounts.slice(0, 2).map(([label, count]) => (
                                                <Badge key={label} label={`${count} ${label}`} tone={sessionTone(label)} />
                                            ))}
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Badge label={t('meshGraph.obs.legendAnchor')} tone="info" />
                                            <Badge label={t('meshGraph.obs.legendPeerLink')} tone="default" />
                                            <Badge label={t('meshGraph.obs.legendSubmoduleLink')} tone="warn" />
                                        </div>
                                        {statusWarnings.length > 0 && (
                                            <div className="flex flex-wrap gap-2">
                                                {statusWarnings.map(warning => (
                                                    <span key={warning} className={meshTheme.isDark ? 'rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-100' : 'rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700'}>{warning}</span>
                                                ))}
                                            </div>
                                        )}
                                        <div className={`text-xs ${meshTheme.textMuted}`}>
                                            {t('meshGraph.obs.legendClickHint')}
                                        </div>
                                    </div>
                                </div>
                            </details>
                        </div>
                    </div>
                </div>

                {/* Bootstrap banner */}
                {isBootstrapMode && canonicalGraph.nodes.length > 0 && (
                    <div className={`shrink-0 mx-4 mt-2 flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs ${meshTheme.isDark ? 'border-amber-400/20 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                        <span className={`h-2 w-2 shrink-0 rounded-full animate-pulse ${meshTheme.isDark ? 'bg-amber-400' : 'bg-amber-500'}`} aria-hidden />
                        <span>{t('meshGraph.obs.bootstrapBanner')}</span>
                    </div>
                )}

                {/* Graph canvas + right detail panel */}
                <div className="relative flex flex-1 min-w-0" style={{ minHeight: 360 }}>
                    {/* Graph */}
                    <div className="flex-1 min-w-0">
                        {!graphMounted ? (
                            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">{t('meshGraph.obs.loadingGraph')}</div>
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
                                    setSelectedNodeId(null)
                                    setSelectedEdgeId(edge.id)
                                    setDetailSelection({ kind: 'edge', edgeId: edge.id })
                                }}
                            />
                        ) : (
                            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">{resolvedEmptyMessage}</div>
                        )}
                    </div>

                    {/* Right sidebar — selected node detail */}
                    {selectedGraphNode && detailSelection?.kind === 'node' && (
                        <div role="dialog" className={`absolute inset-x-3 bottom-3 top-20 z-20 rounded-2xl border shadow-2xl sm:relative sm:inset-auto sm:z-auto sm:w-72 sm:shrink-0 sm:rounded-none sm:border-0 sm:border-l sm:shadow-none overflow-y-auto p-4 ${meshTheme.isDark ? 'border-white/10 bg-slate-950 sm:bg-transparent' : 'border-slate-200 bg-white sm:bg-transparent'}`}>
                            <div className={`mb-2 text-3xs font-semibold uppercase tracking-wide ${meshTheme.textMuted}`}>{t('meshGraph.obs.selectedNode')}</div>
                            <div className="mb-3 flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphNode.label}</div>
                                    <div className={`mt-0.5 font-mono text-2xs ${meshTheme.textMuted}`}>{selectedGraphNode.id.slice(0, 16)}</div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    {selectedGraphNode.behind > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => { void handleHealSelectedNode() }}
                                            disabled={!canHealSelectedNode || healingNodeId === selectedGraphNode.id}
                                            className={meshTheme.isDark ? 'rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-45' : 'rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-45'}
                                        >
                                            {healingNodeId === selectedGraphNode.id ? t('meshGraph.obs.checking') : t('meshGraph.obs.heal')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={closeGraphDetail}
                                        aria-label="Close detail panel"
                                        className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs text-slate-200 transition hover:bg-white/[0.08]' : 'rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-50'}
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                            <div className="mb-3 flex flex-wrap gap-1.5">
                                {(() => {
                                    const h = selectedNodeStatus?.health ?? selectedGraphNode.health
                                    return h === 'unknown'
                                        ? <Badge label={t('meshGraph.obs.connecting')} tone="default" />
                                        : <Badge label={h} tone={healthTone(h)} />
                                })()}
                                {selectedGraphNode.branch && <Badge label={selectedGraphNode.branch} tone="default" />}
                                {selectedGraphNode.ahead > 0 && <Badge label={`ahead ${selectedGraphNode.ahead}`} tone="warn" />}
                                {selectedGraphNode.behind > 0 && <Badge label={`behind ${selectedGraphNode.behind}`} tone="warn" />}
                                {selectedGraphNode.dirtyFiles > 0 && <Badge label={`${selectedGraphNode.dirtyFiles} dirty`} tone="warn" />}
                                {selectedNodeStatus?.connection && selectedNodeStatus.connection.state !== 'unknown' && (
                                    <Badge label={describeConnection(selectedNodeStatus)} tone={connectionTone(selectedNodeStatus.connection)} />
                                )}
                                {selectedNodeStatus?.connection?.state === 'unknown' && (
                                    <Badge label={t('meshGraph.obs.meshConnecting')} tone="warn" />
                                )}
                                {selectedNodeSessionEntries.length > 0 && <Badge label={`${selectedNodeSessionEntries.length} sessions`} tone="info" />}
                            </div>
                            <div className="grid gap-1.5 text-xs">
                                {selectedGraphNode.machineLabel && (
                                    <Row label={t('meshGraph.obs.fieldMachine')} value={selectedGraphNode.machineLabel} />
                                )}
                                {selectedGraphNode.locality && selectedGraphNode.locality !== 'unknown' && (
                                    <Row label={t('meshGraph.obs.fieldLocality')} value={selectedGraphNode.locality} />
                                )}
                                <Row label={t('meshGraph.obs.fieldWorkspace')} value={selectedNodeStatus?.workspace ?? selectedGraphNode.workspace} />
                                {selectedHeadSummary && (
                                    <Row label={t('meshGraph.obs.fieldHead')} value={selectedHeadSummary} />
                                )}
                                {(selectedGraphNode.dirtyFiles > 0 || selectedGraphNode.ahead > 0 || selectedGraphNode.behind > 0) && (
                                    <Row label={t('meshGraph.obs.fieldDirtyAheadBehind')} value={`${selectedGraphNode.dirtyFiles}/${selectedGraphNode.ahead}/${selectedGraphNode.behind}`} />
                                )}
                                {selectedNodeSessionEntries.length > 0 && (
                                    <Row label={t('meshGraph.obs.fieldSessions')} value={String(selectedNodeSessionEntries.length)} />
                                )}
                                {selectedGraphNode.upstream && (
                                    <Row label={t('meshGraph.obs.fieldUpstream')} value={selectedGraphNode.upstream} />
                                )}
                                {(() => {
                                    const src = selectedNodeStatus?.connection?.source ?? describeGraphNodeSource(selectedGraphNode)
                                    return src && src !== 'unknown' ? <Row label={t('meshGraph.obs.fieldSource')} value={String(src)} /> : null
                                })()}
                                {(() => {
                                    const transport = selectedNodeStatus?.connection?.transport
                                    return transport && transport !== 'unknown' ? <Row label={t('meshGraph.obs.fieldTransport')} value={transport} /> : null
                                })()}
                                {(() => {
                                    const mid = selectedGraphNode.machineId ?? selectedNodeStatus?.machineId
                                    return mid ? <Row label={t('meshGraph.obs.fieldMachineId')} value={mid} /> : null
                                })()}
                                {(() => {
                                    const did = selectedGraphNode.daemonId ?? selectedNodeStatus?.daemonId
                                    return did ? <Row label={t('meshGraph.obs.fieldDaemonId')} value={did} /> : null
                                })()}
                            </div>
                            {selectedNodeSessionEntries.length > 0 && (
                                <div className="mt-3">
                                    <div className={`mb-1.5 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('meshGraph.obs.activeSessions')}</div>
                                    <div className="flex flex-col gap-1.5">
                                        {selectedNodeSessionEntries.map(entry => (
                                            <div key={entry.session.sessionId} className={`rounded-lg border px-2.5 py-1.5 text-2xs ${meshTheme.isDark ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-slate-50/80'}`}>
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className={`min-w-0 truncate font-mono select-text ${meshTheme.textMuted}`} title={entry.session.sessionId}>{shortSessionId(entry.session.sessionId)}</span>
                                                    <Badge label={sessionStatusLabel(entry.session)} tone={sessionTone(sessionStatusLabel(entry.session))} />
                                                </div>
                                                <div className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 ${meshTheme.textMuted}`}>
                                                    <span className="truncate">{entry.session.providerType || t('meshGraph.obs.providerUnknown')}</span>
                                                    <span>{sessionRoleLabel(entry.session)}</span>
                                                    <span>{sessionElapsedLabel(entry.session)}</span>
                                                </div>
                                                {entry.session.statusNote && (
                                                    <div className={`mt-1 text-3xs leading-4 ${meshTheme.textMuted}`}>
                                                        {entry.session.statusNote}
                                                    </div>
                                                )}
                                                <div className={`mt-0.5 truncate ${meshTheme.textMuted}`} title={entry.session.workspace || entry.workspace}>
                                                    {(entry.session.workspace || entry.workspace).slice(0, 38)}{entry.branch ? ` · ${entry.branch}` : ''}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="mt-3">
                                <div className={`mb-1.5 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('meshGraph.obs.ledger')}</div>
                                <div className="grid grid-cols-2 gap-1.5">
                                    <Row label={t('meshGraph.obs.fieldCompleted')} value={String(ledgerSummary.taskCompleted)} />
                                    <Row label={t('meshGraph.obs.fieldFailed')} value={<span className={ledgerSummary.taskFailed > 0 ? (meshTheme.isDark ? 'text-rose-300' : 'text-rose-600') : ''}>{ledgerSummary.taskFailed}</span>} />
                                    <Row label={t('meshGraph.obs.fieldLaunched')} value={String(ledgerSummary.sessionLaunched)} />
                                    <Row label={t('meshGraph.obs.fieldRecentFailures')} value={<span className={ledgerSummary.recentFailures > 0 ? (meshTheme.isDark ? 'text-amber-300' : 'text-amber-600') : ''}>{ledgerSummary.recentFailures}</span>} />
                                </div>
                            </div>
                            {(() => {
                                const queueTasks = (canonicalStatus.queue as any)?.tasks ?? (canonicalStatus.queue as any)?.items ?? null
                                if (!Array.isArray(queueTasks) || queueTasks.length === 0) return null
                                const nodeTasks = (queueTasks as RepoMeshQueueTask[]).filter(task => getQueueTaskNodeTarget(task) === selectedNodeId).slice(0, 3)
                                if (nodeTasks.length === 0) return null
                                return (
                                    <div className="mt-3">
                                        <div className={`mb-1.5 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('meshGraph.obs.queueTasks')}</div>
                                        <div className="flex flex-col gap-1.5">
                                            {nodeTasks.map(task => (
                                                <div key={task.id} className={`rounded-lg border px-2.5 py-1.5 text-2xs ${meshTheme.isDark ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-slate-50/80'}`}>
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className={`font-mono ${meshTheme.textMuted}`}>{task.id.slice(0, 12)}</span>
                                                        <Badge label={task.status ?? 'unknown'} tone={sessionTone(task.status)} />
                                                    </div>
                                                    {task.message && (
                                                        <div className={`mt-0.5 truncate ${meshTheme.textMuted}`}>{task.message.slice(0, 48)}</div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )
                            })()}
                            {selectedGraphNode.snapshotWarnings.length > 0 && (
                                <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100' : 'mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800'}>
                                    <div className="font-medium">{t('meshGraph.obs.keyWarning')}</div>
                                    <div className="mt-1">{selectedGraphNode.snapshotWarnings[0]}</div>
                                </div>
                            )}
                            {selectedGraphNode.branchConvergence && (selectedGraphNode.branchConvergence.reason || selectedGraphNode.branchConvergence.nextStep) && (
                                <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-sky-400/20 bg-sky-500/10 p-3 text-xs text-sky-100' : 'mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-800'}>
                                    <div className="font-medium">{t('meshGraph.obs.followUpLabel', { status: branchConvergenceLabel[selectedGraphNode.branchConvergence.status] ?? selectedGraphNode.branchConvergence.status })}</div>
                                    {selectedGraphNode.branchConvergence.reason && (
                                        <div className="mt-1">{selectedGraphNode.branchConvergence.reason}</div>
                                    )}
                                    {selectedGraphNode.branchConvergence.nextStep && (
                                        <div className={`${selectedGraphNode.branchConvergence.reason ? 'mt-1.5 pt-1.5 border-t border-sky-400/20' : 'mt-1'}`}>{selectedGraphNode.branchConvergence.nextStep}</div>
                                    )}
                                </div>
                            )}
                            {healPreview && (
                                <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-xs text-emerald-100' : 'mt-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800'}>
                                    <div className="font-medium">{healPreview.phase === 'execute' ? t('meshGraph.obs.healResult') : t('meshGraph.obs.healPreview')}</div>
                                    <div className="mt-1">{healPreview.code ?? healPreview.error ?? t('meshGraph.obs.noResultCode')}</div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Selected edge detail — pinned by clicking an edge (replaces the
                        old hover preview; click is the primary drill-down path). */}
                    {selectedGraphEdge && detailSelection?.kind === 'edge' && (
                        <div role="dialog" className={`absolute inset-x-3 bottom-3 top-20 z-20 rounded-2xl border shadow-2xl sm:relative sm:inset-auto sm:z-auto sm:w-72 sm:shrink-0 sm:rounded-none sm:border-0 sm:border-l sm:shadow-none overflow-y-auto p-4 ${meshTheme.isDark ? 'border-white/10 bg-slate-950 sm:bg-transparent' : 'border-slate-200 bg-white sm:bg-transparent'}`}>
                            <div className={`mb-2 text-3xs font-semibold uppercase tracking-wide ${meshTheme.textMuted}`}>{t('meshGraph.obs.selectedEdge')}</div>
                            <div className="mb-3 flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphEdge.label || edgeTypeLabel(selectedGraphEdge)}</div>
                                    <div className={`mt-0.5 break-all font-mono text-2xs ${meshTheme.textMuted}`}>{selectedGraphEdge.id}</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={closeGraphDetail}
                                    aria-label="Close detail panel"
                                    className={meshTheme.isDark ? 'shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs text-slate-200 transition hover:bg-white/[0.08]' : 'shrink-0 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-50'}
                                >
                                    ✕
                                </button>
                            </div>
                            <div className="mb-3 flex flex-wrap gap-1.5">
                                <Badge label={edgeTypeLabel(selectedGraphEdge)} tone="default" />
                                <Badge label={edgeDirectionLabel(selectedGraphEdge)} tone="info" />
                            </div>
                            <div className="grid gap-1.5 text-xs">
                                <Row label={t('meshGraph.obs.fieldFrom')} value={selectedEdgeSource?.label ?? selectedGraphEdge.source} />
                                <Row label={t('meshGraph.obs.fieldTo')} value={selectedEdgeTarget?.label ?? selectedGraphEdge.target} />
                                <Row label={t('meshGraph.obs.fieldLabel')} value={selectedGraphEdge.label ?? 'none'} />
                            </div>
                        </div>
                    )}
                </div>
            </div>
            </div>

            {confirmDialog}
        </div>
        </MeshGraphThemeContext.Provider>
    )
}
