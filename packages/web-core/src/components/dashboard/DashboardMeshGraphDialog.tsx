import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeSessionStatus } from '@adhdev/mesh-shared'
import { getConversationTitle } from './conversation-presenters'
import type { ActiveConversation } from './types'
import { IconHelp, IconInfo, IconMesh, IconRefresh, IconX } from '../Icons'
import { DialogShell } from '../ui/Dialog'
import { MeshObservabilitySurface, MeshSurfaceTabControls, MeshHelpPanel, type MeshSurfaceTab } from '../MeshGraph'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'
import {
    collectSessionAliases,
    useMeshGraphMetadataSubscription,
    type MeshGraphLiveSessionStatus,
} from '../../hooks/useMeshGraphMetadataSubscription'
import { getMeshGraphTheme } from '../MeshGraph/meshGraphTheme'
import { useCoordinatorMeshStatus } from '../../hooks/useCoordinatorMeshStatus'
import type { CoordinatorMeshStatusLoader } from '../../utils/coordinator-mesh-status-store'
import { classifyDashboardMeshLoadFailure } from './dashboard-mesh-load-failure'

/** Slow backstop re-read (refresh:false) in case a revision push was missed. */
const DASHBOARD_MESH_STATUS_BACKSTOP_MS = 60_000

export {
    collectMeshGraphLiveSessionStatuses as collectDashboardLiveMeshSessionStatuses,
    getMeshGraphMetadataSignature as getDashboardMeshMetadataSignature,
    mergeMeshGraphLiveSessionStatusIntoMeshStatus as mergeDashboardLiveSessionStatusIntoMeshStatus,
} from '../../hooks/useMeshGraphMetadataSubscription'

interface DashboardMeshGraphDialogProps {
    activeConv: ActiveConversation
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
}

function buildActiveConversationLiveSessionStatus(activeConv: ActiveConversation, meshId: string | null): MeshGraphLiveSessionStatus | null {
    if (!meshId || !activeConv.sessionId) return null
    const coordinatorMeshId = activeConv.coordinator?.meshId
        ?? (typeof activeConv.settings?.meshCoordinatorFor === 'string' ? activeConv.settings.meshCoordinatorFor : null)
    const nodeMeshId = typeof activeConv.settings?.meshNodeFor === 'string' ? activeConv.settings.meshNodeFor : null
    if (coordinatorMeshId !== meshId && nodeMeshId !== meshId) return null
    const nodeId = typeof activeConv.settings?.meshNodeId === 'string' ? activeConv.settings.meshNodeId : null
    return {
        sessionId: activeConv.sessionId,
        aliases: collectSessionAliases(activeConv.sessionId, activeConv.providerSessionId, activeConv.historySessionId, activeConv.nativeSessionId),
        meshId,
        nodeId,
        providerType: activeConv.agentType,
        state: normalizeSessionStatus(activeConv.status) ?? undefined,
        chatStatus: activeConv.status,
        role: coordinatorMeshId === meshId ? 'coordinator' : 'worker',
        isSelfCoordinator: coordinatorMeshId === meshId,
        workspace: activeConv.workspacePath ?? null,
    }
}

export default function DashboardMeshGraphDialog({ activeConv, sendDaemonCommand, onClose }: DashboardMeshGraphDialogProps) {
    const meshId = activeConv.coordinator?.meshId
        ?? (typeof activeConv.settings?.meshCoordinatorFor === 'string' ? activeConv.settings.meshCoordinatorFor : null)
    const daemonId = activeConv.daemonId ?? null
    const { t } = useTranslation('common')
    const meshOverrides = useDashboardMeshOverrides()
    const { sendData } = useTransport()
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    // Hoisted from MeshObservabilitySurface so the Overview/Graph toggle + "?" help
    // controls can live in the dialog header row instead of taking their own row.
    const [activeTab, setActiveTab] = useState<MeshSurfaceTab>('overview')
    const [helpOpen, setHelpOpen] = useState(false)
    const activeConversationLiveSession = useMemo(
        () => buildActiveConversationLiveSessionStatus(activeConv, meshId),
        [
            activeConv.agentType,
            activeConv.coordinator?.meshId,
            activeConv.sessionId,
            activeConv.settings?.meshCoordinatorFor,
            activeConv.settings?.meshNodeFor,
            activeConv.settings?.meshNodeId,
            activeConv.status,
            activeConv.workspacePath,
            meshId,
        ],
    )
    // On mobile the header otherwise stacks 5 rows (title, repo path, tabs,
    // status chips, Refresh) and pushes the Missions/Ledger content far down.
    // Collapse the secondary metadata (repo path + status chips) behind a
    // disclosure toggle by default; the core actions (tabs/Refresh/close)
    // stay pinned in the sticky header. Desktop ignores this and always
    // shows everything (md: utilities below).
    const [showHeaderMeta, setShowHeaderMeta] = useState(false)

    // ONE shared coordinator status per mesh (utils/coordinator-mesh-status-store):
    // the /mesh page, this dialog and the session info dialog read the same held
    // answer. Triggers: open → refresh:false, coordinator revision advance →
    // refresh:false, slow backstop → refresh:false, the Refresh button → refresh:true.
    // No pending-git retry loop — each node reports its own freshness
    // (gitObservation / heldRuntime: age, refreshing, unreachable).
    const loadStatus = useCallback<CoordinatorMeshStatusLoader>((targetDaemonId, targetMeshId, options) => (
        meshOverrides?.loadMeshStatus
            ? meshOverrides.loadMeshStatus(targetDaemonId, targetMeshId, { refresh: options.refresh })
            : sendDaemonCommand(targetDaemonId, 'mesh_status', { meshId: targetMeshId, refresh: options.refresh })
    ), [meshOverrides, sendDaemonCommand])
    const {
        status: meshStatus,
        loading: storeLoading,
        refreshing,
        error: loadError,
        loadedAt,
        refresh: refreshMeshStatus,
    } = useCoordinatorMeshStatus({
        meshId,
        daemonId,
        load: daemonId && meshId ? loadStatus : null,
        sendData,
        backstopMs: DASHBOARD_MESH_STATUS_BACKSTOP_MS,
    })
    const loading = storeLoading && !meshStatus
    // A read the user explicitly asked for (Refresh) that fails is the page-level
    // banner. A background read failing while a graph is on screen is a quiet
    // subtitle hint — the graph and its per-node age/unreachable markers are still
    // the coordinator's last answer (classifyDashboardMeshLoadFailure).
    const [manualRefreshFailed, setManualRefreshFailed] = useState(false)
    const loadGraph = useCallback(() => {
        setManualRefreshFailed(false)
        void refreshMeshStatus().then(result => { if (!result) setManualRefreshFailed(true) })
    }, [refreshMeshStatus])
    const failureSurface = classifyDashboardMeshLoadFailure({ background: !manualRefreshFailed, hasGraph: meshStatus !== null })
    const error = !daemonId || !meshId
        ? t('mesh.dialog.errorNoMeshId')
        : (loadError && failureSurface === 'banner' ? loadError : null)
    const quietRefreshError = loadError && failureSurface === 'quiet' ? loadError : null
    const lastLoadedAt = meshStatus?.refreshedAt || (loadedAt ? new Date(loadedAt).toISOString() : null)

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const detailLabel = meshStatus?.meshName || meshId || 'Repo Mesh'
    // The active conversation's own live state is merged only because it is the
    // coordinator's own session (meshId above comes from its coordinator stamp).
    const extraLiveSessions = useMemo(
        () => activeConversationLiveSession?.isSelfCoordinator ? [activeConversationLiveSession] : [],
        [activeConversationLiveSession],
    )
    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshStatus,
        daemonId,
        meshId,
        sendData,
        extraLiveSessions,
    })
    const lastLoadedLabel = lastLoadedAt ? new Date(lastLoadedAt).toLocaleTimeString() : null
    const emptyMessage = useMemo(
        () => (loading ? t('mesh.dialog.loadingStatus') : t('mesh.dialog.noGraph')),
        [loading, t],
    )

    return (
        // Shared dialog shell (portal into <body> + backdrop-click close);
        // the mesh-themed overlay/shell visuals ride through verbatim via
        // chrome={false}. Escape stays handled by this component's own
        // bubble-phase window listener above (closeOnEsc={false}) — the
        // capture-phase inner layers (scheduling popover, DetailModal via
        // installTopModalEscapeHandler) depend on that exact ordering.
        <DialogShell
            chrome={false}
            onClose={onClose}
            closeOnEsc={false}
            overlayClassName={meshTheme.dialogOverlayClass}
            surfaceClassName={meshTheme.dialogShellClass}
        >
                <div className={`relative ${meshTheme.dialogHeaderClass}`}>
                    {/* Close — anchored to the header's top-right corner so it never
                        wraps below the chip row on mobile (where the row flex-wraps).
                        On desktop it sits at the far-right, vertically centered. */}
                    {/* Refresh (icon) + Close — one compact corner strip. The old
                        full-width "새로 고침" text button ate a whole row on mobile
                        for a single action; an icon beside the close keeps the
                        header to one visual line. */}
                    <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 md:right-5 md:top-1/2 md:-translate-y-1/2">
                        <button
                            type="button"
                            onClick={() => setHelpOpen(prev => !prev)}
                            aria-expanded={helpOpen}
                            aria-label={t('mesh.help.toggleAria')}
                            title={t('mesh.help.toggleTitle')}
                            className={helpOpen
                                ? (meshTheme.isDark
                                    ? 'inline-flex h-9 w-9 items-center justify-center rounded-xl border border-sky-400/40 bg-sky-500/15 text-sky-100 transition'
                                    : 'inline-flex h-9 w-9 items-center justify-center rounded-xl border border-sky-400 bg-sky-100 text-sky-800 transition')
                                : meshTheme.dialogCloseButtonClass}
                        >
                            <IconHelp size={15} />
                        </button>
                        <button
                            type="button"
                            onClick={loadGraph}
                            disabled={loading || refreshing}
                            className={meshTheme.dialogCloseButtonClass}
                            aria-label={t('mesh.dialog.refreshTitle')}
                            title={t('mesh.dialog.refreshTitle')}
                        >
                            <IconRefresh size={15} className={loading || refreshing ? 'animate-spin' : undefined} />
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className={meshTheme.dialogCloseButtonClass}
                            aria-label={t('common.close')}
                        >
                            <IconX size={16} />
                        </button>
                    </div>
                    <div className="min-w-0 flex-1 pr-32 md:pr-0">
                        <div className="flex items-center gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-500/12 text-sky-200 shadow-[0_12px_30px_rgba(14,165,233,0.18)]">
                                <IconMesh size={18} />
                            </span>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className={meshTheme.dialogTitleClass}>{detailLabel}</h2>
                                    {/* Mobile-only disclosure toggle for the secondary
                                        metadata (repo path + status chips). Sits right
                                        beside the observability badge; hidden on desktop
                                        where the header has room to show everything. */}
                                    <button
                                        type="button"
                                        onClick={() => setShowHeaderMeta(prev => !prev)}
                                        aria-expanded={showHeaderMeta}
                                        aria-label={showHeaderMeta ? t('mesh.dialog.hideDetails') : t('mesh.dialog.showDetails')}
                                        className="btn btn-secondary btn-sm rounded-lg px-1.5 py-1 md:hidden"
                                        title={showHeaderMeta ? t('mesh.dialog.hideDetails') : t('mesh.dialog.showDetails')}
                                    >
                                        <IconInfo size={14} />
                                    </button>
                                </div>
                                {/* Repo path is secondary detail — collapsed on mobile
                                    unless the user expands the metadata disclosure;
                                    always visible on desktop where space allows. */}
                                <p
                                    className={`${meshTheme.dialogSubtitleClass} ${showHeaderMeta ? 'block' : 'hidden'} md:block`}
                                >
                                    {getConversationTitle(activeConv)}
                                    {activeConv.workspaceName ? ` · ${activeConv.workspaceName}` : ''}
                                    {meshStatus?.repoIdentity ? ` · ${meshStatus.repoIdentity}` : ''}
                                    {/* Refresh/live state lives HERE (secondary line), not
                                        beside the tab controls: variable-width chips next to
                                        the tabs shifted the whole tab group on every refresh
                                        cycle, so a tab click could land on the wrong tab. */}
                                    {lastLoadedLabel ? ` · ${t('mesh.dialog.refreshedAt', { time: lastLoadedLabel })}` : ''}
                                    {!refreshing && meshStatus ? ` · ${sendData && !error ? t('mesh.dialog.liveMetadata') : t('mesh.dialog.metadataUnavailable')}` : ''}
                                    {quietRefreshError ? ` · ${t('mesh.dialog.refreshFailedQuiet')}` : ''}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:justify-end md:pr-36">
                        {/* Core actions — always pinned in the sticky shrink-0 header so
                            they stay reachable no matter how long the body content is.
                            The row scrolls horizontally instead of wrapping tab labels
                            onto two lines on narrow screens. */}
                        <MeshSurfaceTabControls
                            meshTheme={meshTheme}
                            activeTab={activeTab}
                            onActiveTabChange={setActiveTab}
                            helpOpen={helpOpen}
                            onHelpOpenChange={setHelpOpen}
                            hideHelpToggle
                        />
                    </div>
                </div>

                {error && (
                    <div className={meshTheme.isDark ? 'shrink-0 border-b border-rose-400/20 bg-rose-500/12 px-4 py-2 text-sm text-rose-200 md:px-5' : 'shrink-0 border-b border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700 md:px-5'}>
                        {error}
                    </div>
                )}

                <div className={meshTheme.dialogBodyClass}>
                    {displayedMeshStatus ? (
                        <MeshObservabilitySurface
                            status={displayedMeshStatus}
                            emptyMessage={emptyMessage}
                            daemonId={daemonId}
                            sendDaemonCommand={sendDaemonCommand}
                            activeTab={activeTab}
                            onActiveTabChange={setActiveTab}
                            helpOpen={helpOpen}
                            onHelpOpenChange={setHelpOpen}
                            hideControls
                            onRequestRefresh={loadGraph}
                        />
                    ) : (
                        <div className={meshTheme.dialogEmptyClass}>
                            {emptyMessage}
                        </div>
                    )}
                </div>
                {/* G5-5: the "?" help toggle in the header above sets helpOpen even
                    in this empty-state branch, but MeshHelpPanel used to live only
                    inside MeshObservabilitySurface — which isn't mounted here — so
                    clicking "?" while empty silently did nothing. */}
                {helpOpen && !displayedMeshStatus && (
                    <MeshHelpPanel meshTheme={meshTheme} onClose={() => setHelpOpen(false)} />
                )}
        </DialogShell>
    )
}
