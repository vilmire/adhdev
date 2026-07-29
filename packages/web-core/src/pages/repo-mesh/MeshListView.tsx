import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { EmptyState } from '../../components/ui/EmptyState'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField, Input } from '../../components/ui/FormField'
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
    onSelectMesh,
    onCreate,
    onCancelCreate,
}: Props) {
    const { t } = useTranslation('common')
    const atMeshLimit = features.maxMeshes != null && meshes.length >= features.maxMeshes
    // UI-only presentation state (form values stay in props). The identity field is an
    // edge-case input — the primary URL field auto-derives the identity — so it starts
    // collapsed behind an "advanced" toggle. Auto-expand when identity already has a
    // value so a pre-populated/typed value is never hidden.
    const [showAdvancedIdentity, setShowAdvancedIdentity] = useState(false)
    const advancedIdentityOpen = showAdvancedIdentity || !!createRepoIdentity.trim()
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

            {showCreate && (
                <Section className="mb-5 border-accent/40 animate-[fadeIn_0.3s_ease-out]">
                    <h3 className="text-base font-bold mb-4">{t('repoMesh.list.createTitle')}</h3>

                    {features.createDaemonPicker && (
                        <FormField label={t('repoMesh.list.createOnMachine')} hint={t('repoMesh.list.createOnMachineHint')}>
                            <select className="input w-full" value={newMeshDaemonId} onChange={e => onNewMeshDaemonIdChange(e.target.value)} disabled={!daemons.length}>
                                {daemons.length === 0
                                    ? <option value="">{t('repoMesh.list.noConnectedDaemon')}</option>
                                    : daemons.map(d => <option key={d.id} value={d.id}>{daemonLabel(d)}</option>)}
                            </select>
                        </FormField>
                    )}

                    {features.createDaemonPicker && (createPlanLoading || createOnboardingPlan) && (
                        <AlertBanner
                            variant={createOnboardingPlan?.success === false ? 'error' : 'info'}
                            className="mb-4"
                        >
                            {createPlanLoading
                                ? 'Inspecting Git repository (read-only)…'
                                : createOnboardingPlan?.success
                                    ? `${createOnboardingPlan.plan?.summary || 'Git repository detected.'} No changes will be made until you click Create.`
                                    : `${createOnboardingPlan?.code || 'onboarding_blocked'}: ${createOnboardingPlan?.error || 'Git discovery failed'} ${createOnboardingPlan?.action || ''}`}
                        </AlertBanner>
                    )}

                    {features.createDaemonPicker && (
                        <FormField label={t('repoMesh.list.workspace')} hint={t('repoMesh.list.workspaceHint')}>
                            <select className="input w-full" value={newMeshWorkspace} onChange={e => onNewMeshWorkspaceChange(e.target.value)} disabled={!newMeshDaemonId || !createPickerWorkspaces.length}>
                                {!newMeshDaemonId ? <option value="">{t('repoMesh.list.selectMachineFirst')}</option>
                                    : createPickerWorkspaces.length === 0 ? <option value="">{t('repoMesh.list.noRegisteredWorkspaces')}</option>
                                    : createPickerWorkspaces.map(w => (
                                        <option key={w.id || w.path} value={w.path}>
                                            {w.label ? `${w.label} · ${w.path}` : w.path}
                                        </option>
                                    ))}
                            </select>
                        </FormField>
                    )}

                    <FormField label={t('repoMesh.list.name')}>
                        <Input value={createName} onChange={e => onCreateNameChange(e.target.value)} placeholder="my-project-mesh" autoFocus />
                    </FormField>
                    <FormField label={t('repoMesh.list.remoteUrl')} hint={t('repoMesh.list.remoteUrlHint')}>
                        <Input value={createRepoRemoteUrl} onChange={e => onCreateRepoRemoteUrlChange(e.target.value)} placeholder="https://github.com/user/repo" />
                    </FormField>

                    {/* Identity is auto-derived from the URL above; it's only needed for a
                        repo with no remote or a per-machine-differing URL. Collapsed behind an
                        advanced toggle by default so new users see one clear field. The
                        one-of-required validation (URL OR identity) is unchanged — see the
                        create button's disabled predicate below. */}
                    {advancedIdentityOpen ? (
                        <FormField label={t('repoMesh.list.repoIdentity')} hint={t('repoMesh.list.repoIdentityHint')}>
                            <Input value={createRepoIdentity} onChange={e => onCreateRepoIdentityChange(e.target.value)} placeholder="github.com/user/repo" />
                        </FormField>
                    ) : (
                        <button
                            type="button"
                            className="text-xs text-text-muted hover:text-text-primary underline underline-offset-2 mb-5"
                            onClick={() => setShowAdvancedIdentity(true)}
                        >
                            {t('repoMesh.list.advancedIdentityToggle')}
                        </button>
                    )}

                    <div className="flex gap-2 mt-3">
                        <button className="btn btn-primary btn-sm" onClick={onCreate}
                            disabled={createPlanLoading || createOnboardingPlan?.success === false || (createOnboardingPlan?.success === true && createOnboardingPlan?.plan?.kind !== 'create_mesh_and_onboard') || !createName.trim() || (!createRepoRemoteUrl.trim() && !createRepoIdentity.trim()) || (features.createDaemonPicker && (!newMeshDaemonId || !newMeshWorkspace))}>
                            {t('repoMesh.list.create')}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={onCancelCreate}>{t('repoMesh.list.cancel')}</button>
                    </div>
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
