import { useState } from 'react'
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { EmptyState } from '../../components/ui/EmptyState'
import { AlertBanner } from '../../components/ui/AlertBanner'
import MeshCreateForm from '../../components/mesh-onboarding/MeshCreateForm'
import { IconMesh } from '../../components/Icons'
import { IconGitBranch } from './icons'
import { Tooltip } from '../../components/ui/InfoTip'
import { formatAbsoluteTime, formatDateLocalized } from '../../utils/time'
// Lazy: the graph dialog (xyflow + elkjs) only loads when it first opens.
import DashboardMeshGraphDialog from '../../components/dashboard/LazyDashboardMeshGraphDialog'
import { buildMeshGraphLaunchConversation } from './graph-launch'
import { resolveMeshHostDaemonId } from './host-seed'
import { summarizeMeshListMachineHealth } from './mesh-list-health'
import { useMeshStatusSubscription } from '../../hooks/useMeshStatusSubscription'
import { useCoordinatorMeshStatusSnapshot } from '../../hooks/useCoordinatorMeshStatus'
import type { MeshEntry, MeshListViewFeatures } from './types'

function daemonLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}

interface Props {
    meshes: MeshEntry[]
    loading: boolean
    error: string | null
    onDismissError: () => void
    daemons: RepoMeshDaemonEntry[]
    features: MeshListViewFeatures

    // Create form state
    showCreate: boolean
    onToggleCreate: () => void
    createName: string
    onCreateNameChange: (v: string) => void
    createRepoIdentity: string
    onCreateRepoIdentityChange: (v: string) => void
    createRepoRemoteUrl: string
    onCreateRepoRemoteUrlChange: (v: string) => void
    newMeshDaemonId: string
    onNewMeshDaemonIdChange: (v: string) => void
    newMeshWorkspace: string
    onNewMeshWorkspaceChange: (v: string) => void
    createPickerWorkspaces: Array<{ id?: string; path: string; label?: string | null }>
    createOnboardingPlan: any
    createPlanLoading: boolean
    /** True while a create is in flight — blocks double-submit. */
    creating: boolean
    /**
     * Non-fatal create outcome: the mesh WAS created but attaching its first
     * workspace failed. Rendered as a warning next to the (now present) mesh, never
     * as a create failure.
     */
    createWarning: string | null
    onDismissCreateWarning: () => void

    onSelectMesh: (id: string) => void
    onCreate: () => void
    onCancelCreate: () => void
    /** Command seam for the row's "Open" (live view dialog). Without it, Open is hidden. */
    sendCommand?: (daemonId: string, command: string, payload?: any) => Promise<any>
    /** Subscription seam for each card's coordinator `mesh.status` push (machine health). */
    sendData?: (daemonId: string, data: any) => boolean
}

export function MeshListView({
    meshes,
    loading,
    error,
    onDismissError,
    daemons,
    features,
    showCreate,
    onToggleCreate,
    createName,
    onCreateNameChange,
    createRepoIdentity,
    onCreateRepoIdentityChange,
    createRepoRemoteUrl,
    onCreateRepoRemoteUrlChange,
    newMeshDaemonId,
    onNewMeshDaemonIdChange,
    newMeshWorkspace,
    onNewMeshWorkspaceChange,
    createPickerWorkspaces,
    createOnboardingPlan,
    createPlanLoading,
    creating,
    createWarning,
    onDismissCreateWarning,
    onSelectMesh,
    onCreate,
    onCancelCreate,
    sendCommand,
    sendData,
}: Props) {
    const { t } = useTranslation('common')
    // UI-only presentation state (form values stay in props). The identity/URL block is
    // an edge-case input — git discovery fills both in — so it starts collapsed behind
    // an "advanced" toggle. MeshCreateForm auto-expands it when either field already has
    // a value, so a discovered or typed value is never hidden.
    const [showAdvancedIdentity, setShowAdvancedIdentity] = useState(false)
    // The row's primary action opens the live view (graph dialog) directly;
    // settings is the secondary action.
    const [openMesh, setOpenMesh] = useState<{ meshId: string; daemonId: string; meshName: string } | null>(null)
    return (
        <AppPage
            icon={<IconMesh />}
            title={t('mesh.list.title')}
            subtitle={t('mesh.list.count', { count: meshes.length })}
            subtitleInline
            widthClassName="max-w-5xl"
            actions={<button className="btn btn-primary btn-sm" onClick={onToggleCreate}>{t('mesh.list.createMesh')}</button>}
        >
            {error && <AlertBanner variant="error" onDismiss={onDismissError} className="mb-4">{error}</AlertBanner>}
            {createWarning && <AlertBanner variant="warning" onDismiss={onDismissCreateWarning} className="mb-4">{createWarning}</AlertBanner>}

            {showCreate && (
                <Section className="mb-5 border-accent/40 animate-[fadeIn_0.3s_ease-out]">
                    {/* Single create form shared with the setup wizard. Picking a
                        workspace drives git discovery on the owning daemon, which fills in
                        name/identity/remote URL; the identity fields remain available as a
                        manual fallback for repos discovery cannot describe. */}
                    <MeshCreateForm
                        variant="page"
                        showDaemonPicker={features.createDaemonPicker}
                        daemons={daemons}
                        daemonLabel={daemonLabel}
                        name={createName}
                        onNameChange={onCreateNameChange}
                        daemonId={newMeshDaemonId}
                        onDaemonIdChange={onNewMeshDaemonIdChange}
                        workspace={newMeshWorkspace}
                        onWorkspaceChange={onNewMeshWorkspaceChange}
                        workspaces={createPickerWorkspaces}
                        plan={createOnboardingPlan}
                        planLoading={createPlanLoading}
                        repoRemoteUrl={createRepoRemoteUrl}
                        onRepoRemoteUrlChange={onCreateRepoRemoteUrlChange}
                        repoIdentity={createRepoIdentity}
                        onRepoIdentityChange={onCreateRepoIdentityChange}
                        manualOpen={showAdvancedIdentity}
                        onManualOpenChange={setShowAdvancedIdentity}
                        creating={creating}
                        onCreate={onCreate}
                        onCancel={onCancelCreate}
                    />
                </Section>
            )}

            {loading ? (
                <div className="text-sm text-text-muted p-4">{t('mesh.list.loading')}</div>
            ) : meshes.length === 0 ? (
                <EmptyState icon={<IconMesh />} title={t('mesh.list.emptyTitle')}
                    description={daemons.length > 0 ? t('mesh.list.emptyWithDaemons') : t('mesh.list.emptyNoDaemons')}
                    action={<button className="btn btn-primary btn-sm" disabled={!daemons.length} onClick={onToggleCreate}>{t('mesh.list.createFirst')}</button>} />
            ) : (
                <div className="flex flex-col gap-2.5">
                    {meshes.map(mesh => (
                        <MeshListRow
                            key={mesh.id}
                            mesh={mesh}
                            daemons={daemons}
                            sendData={sendData}
                            onSelectMesh={onSelectMesh}
                            onOpen={sendCommand ? setOpenMesh : undefined}
                        />
                    ))}
                </div>
            )}

            {openMesh && sendCommand && (
                <DashboardMeshGraphDialog
                    activeConv={buildMeshGraphLaunchConversation(openMesh)}
                    sendDaemonCommand={sendCommand}
                    onClose={() => setOpenMesh(null)}
                />
            )}
        </AppPage>
    )
}

/**
 * One mesh card. Machine health is read from the coordinator's mesh_status (the
 * same shared store and `mesh.status` push the detail view uses), so a remote
 * member counts as online when the coordinator reaches it even though this
 * dashboard's own daemon list (standalone: just the local daemon) never lists it.
 */
function MeshListRow({
    mesh,
    daemons,
    sendData,
    onSelectMesh,
    onOpen,
}: {
    mesh: MeshEntry
    daemons: RepoMeshDaemonEntry[]
    sendData?: (daemonId: string, data: any) => boolean
    onSelectMesh: (id: string) => void
    onOpen?: (target: { meshId: string; daemonId: string; meshName: string }) => void
}) {
    const { t } = useTranslation('common')
    const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : []
    const hostDaemonId = resolveMeshHostDaemonId(mesh as any, daemons)
    const hostConnected = !!hostDaemonId && daemons.some(d => daemonIdsEquivalent(d.id, hostDaemonId) && (d.status === undefined || d.status === 'online'))
    // Push-only: subscribing shares the detail view's `mesh.status` slot; an
    // offline host is not subscribed (the daemon-list fallback answers instead).
    useMeshStatusSubscription({ meshId: mesh.id, daemonId: hostConnected ? hostDaemonId : null, sendData })
    const statusSnapshot = useCoordinatorMeshStatusSnapshot(mesh.id)
    const { total: machineCount, online: onlineCount } = summarizeMeshListMachineHealth({
        nodes,
        daemons,
        statusNodes: statusSnapshot?.status?.nodes ?? null,
        hostDaemonId,
    })
    const createdAt = mesh.createdAt || (mesh as any).created_at
    const healthTone = machineCount === 0
        ? 'bg-neutral-500'
        : onlineCount === machineCount ? 'bg-green-400' : onlineCount === 0 ? 'bg-red-400' : 'bg-amber-400'
    return (
        <div
            className="flex w-full flex-col gap-3 rounded-xl border border-border-subtle bg-bg-glass px-4 py-3.5 transition-colors hover:border-border-default sm:flex-row sm:items-center">
            <button type="button" onClick={() => onSelectMesh(mesh.id)} className="min-w-0 flex-1 cursor-pointer border-none bg-transparent p-0 text-left">
                <div className="mb-1 flex items-center gap-2">
                    <IconMesh size={16} />
                    <span className="truncate text-sm font-bold text-text-primary">{mesh.name}</span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${healthTone}`} />
                        {machineCount > 0
                            ? t('mesh.list.machinesOnline', { online: onlineCount, total: machineCount })
                            : t('mesh.list.nodeCount', { count: nodes.length || (mesh as any).nodeCount || 0 })}
                    </span>
                    <span className="truncate font-mono">{mesh.repoIdentity || (mesh as any).repo_identity || t('mesh.list.noRepoIdentity')}</span>
                    {(mesh.defaultBranch || (mesh as any).default_branch) && (
                        <span className="inline-flex items-center gap-1"><IconGitBranch size={11} />{mesh.defaultBranch || (mesh as any).default_branch}</span>
                    )}
                    {createdAt && (
                        <Tooltip content={formatAbsoluteTime(createdAt)}>
                            <span>{formatDateLocalized(createdAt)}</span>
                        </Tooltip>
                    )}
                </div>
            </button>
            <div className="flex shrink-0 items-center gap-2">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSelectMesh(mesh.id)}>
                    {t('mesh.list.settings')}
                </button>
                {onOpen && (
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!hostConnected}
                        title={hostConnected ? undefined : t('mesh.detail.observabilityDisabledTitle')}
                        onClick={() => onOpen({ meshId: mesh.id, daemonId: hostDaemonId, meshName: mesh.name })}
                    >
                        {t('mesh.list.open')}
                    </button>
                )}
            </div>
        </div>
    )
}
