import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { EmptyState } from '../../components/ui/EmptyState'
import { AlertBanner } from '../../components/ui/AlertBanner'
import MeshCreateForm from '../../components/mesh-onboarding/MeshCreateForm'
import { IconMesh } from '../../components/Icons'
import { IconGitBranch } from './icons'
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
}: Props) {
    const { t } = useTranslation('common')
    const atMeshLimit = features.maxMeshes != null && meshes.length >= features.maxMeshes
    // UI-only presentation state (form values stay in props). The identity/URL block is
    // an edge-case input — git discovery fills both in — so it starts collapsed behind
    // an "advanced" toggle. MeshCreateForm auto-expands it when either field already has
    // a value, so a discovered or typed value is never hidden.
    const [showAdvancedIdentity, setShowAdvancedIdentity] = useState(false)
    return (
        <AppPage
            icon={<IconMesh />}
            title={t('repoMesh.list.title')}
            subtitle={t('repoMesh.list.count', { count: meshes.length })}
            widthClassName="max-w-5xl"
            actions={<button className="btn btn-primary btn-sm" onClick={onToggleCreate} disabled={atMeshLimit} title={atMeshLimit ? t('repoMesh.list.meshLimitReached', { max: features.maxMeshes }) : undefined}>{t('repoMesh.list.createMesh')}</button>}
        >
            {atMeshLimit && (
                <AlertBanner variant="info" className="mb-4">
                    {t('repoMesh.list.meshLimitBanner', { max: features.maxMeshes })}
                </AlertBanner>
            )}
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
                <div className="text-sm text-text-muted p-4">{t('repoMesh.list.loading')}</div>
            ) : meshes.length === 0 ? (
                <EmptyState icon={<IconMesh />} title={t('repoMesh.list.emptyTitle')}
                    description={daemons.length > 0 ? t('repoMesh.list.emptyWithDaemons') : t('repoMesh.list.emptyNoDaemons')}
                    action={<button className="btn btn-primary btn-sm" disabled={!daemons.length} onClick={onToggleCreate}>{t('repoMesh.list.createFirst')}</button>} />
            ) : (
                <div className="flex flex-col gap-2.5">
                    {meshes.map(mesh => (
                        <button key={mesh.id} type="button" onClick={() => onSelectMesh(mesh.id)}
                            className="w-full text-left bg-bg-glass border border-border-subtle rounded-xl px-5 py-4 transition-colors hover:border-border-default hover:bg-bg-secondary/70">
                            <div className="flex justify-between items-start">
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <IconMesh size={16} />
                                        <span className="font-bold text-sm">{mesh.name}</span>
                                    </div>
                                    <div className="text-[12px] text-text-muted flex items-center gap-2">
                                        <span className="font-mono">{mesh.repoIdentity || (mesh as any).repo_identity || t('repoMesh.list.noRepoIdentity')}</span>
                                        {(mesh.defaultBranch || (mesh as any).default_branch) && (
                                            <span className="inline-flex items-center gap-1"><IconGitBranch size={11} />{mesh.defaultBranch || (mesh as any).default_branch}</span>
                                        )}
                                    </div>
                                </div>
                                <div className="text-right text-[11px] text-text-muted shrink-0 ml-4">
                                    <div>{new Date(mesh.createdAt || (mesh as any).created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                                    <div className="text-text-muted/60">{mesh.nodes?.length ?? (mesh as any).nodeCount ?? 0} {t('repoMesh.list.nodesSuffix')}</div>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </AppPage>
    )
}
