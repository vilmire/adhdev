/**
 * MachinesStep — the setup wizard's only step: get a mesh with machines on it.
 *
 * Three states:
 *  - No registered machines: renders the platform-injected install/pair
 *    surface (cloud injects its DashboardOnboarding; web-core cannot import
 *    web-cloud, so it arrives as the renderInstallOnboarding prop).
 *  - Existing meshes: pick the mesh to configure; the attach form below adds
 *    more machines to it (plan_mesh_onboarding → add_mesh_node — the same
 *    command sequence as MeshNodeList's add-node flow, committed immediately).
 *  - No mesh yet: MeshCreateForm — the same create form the mesh page renders,
 *    driving runMeshCreateSequence (mesh + first node in one go).
 *
 * Deliberately DUMB: every handler and piece of state lives in the wizard
 * shell; this component only renders and reports user intent upward.
 */
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry, RepoMeshFeatures } from '../../context/RepoMeshContext'
import type { MeshEntry, MeshNode } from '../../pages/repo-mesh/types'
import MeshCreateForm from '../mesh-onboarding/MeshCreateForm'
import WorkspacePicker, { PlanStatus, type WorkspaceOption } from '../mesh-onboarding/WorkspacePicker'

export interface MachinesStepProps {
    daemons: RepoMeshDaemonEntry[]
    features: RepoMeshFeatures
    meshes: MeshEntry[]
    meshesLoading: boolean

    // Mesh selection
    selectedMeshId: string | null
    onSelectMesh: (meshId: string) => void

    // Create-new-mesh form
    createMode: boolean
    onCreateModeChange: (v: boolean) => void
    createName: string
    onCreateNameChange: (v: string) => void
    createDaemonId: string
    onCreateDaemonIdChange: (id: string) => void
    createWorkspace: string
    onCreateWorkspaceChange: (v: string) => void
    createPickerWorkspaces: WorkspaceOption[]
    createPlan: any
    createPlanLoading: boolean
    creating: boolean
    createWarning: string | null
    onCreate: () => void
    /** Manual identity fallback for repos git discovery cannot describe. */
    createRepoRemoteUrl: string
    onCreateRepoRemoteUrlChange: (v: string) => void
    createRepoIdentity: string
    onCreateRepoIdentityChange: (v: string) => void
    createManualOpen: boolean
    onCreateManualOpenChange: (v: boolean) => void

    // Attach-another-machine form (existing mesh)
    nodes: MeshNode[]
    attachableDaemons: RepoMeshDaemonEntry[]
    attachDaemonId: string
    onAttachDaemonIdChange: (id: string) => void
    attachWorkspace: string
    onAttachWorkspaceChange: (v: string) => void
    attachPickerWorkspaces: WorkspaceOption[]
    attachPlan: any
    attachPlanLoading: boolean
    attaching: boolean
    onAttach: () => void

    /** Platform-injected install/pair surface for the zero-machine state. */
    renderInstallOnboarding?: () => ReactNode
    nodeLabel: (node: MeshNode) => string
    daemonLabel: (d: RepoMeshDaemonEntry) => string
}

export default function MachinesStep(props: MachinesStepProps) {
    const {
        daemons, features, meshes, meshesLoading,
        selectedMeshId, onSelectMesh,
        createMode, onCreateModeChange,
        createName, onCreateNameChange, createDaemonId, onCreateDaemonIdChange,
        createWorkspace, onCreateWorkspaceChange, createPickerWorkspaces,
        createPlan, createPlanLoading, creating, createWarning, onCreate,
        createRepoRemoteUrl, onCreateRepoRemoteUrlChange,
        createRepoIdentity, onCreateRepoIdentityChange,
        createManualOpen, onCreateManualOpenChange,
        nodes, attachableDaemons,
        attachDaemonId, onAttachDaemonIdChange, attachWorkspace, onAttachWorkspaceChange,
        attachPickerWorkspaces, attachPlan, attachPlanLoading, attaching, onAttach,
        renderInstallOnboarding, nodeLabel, daemonLabel,
    } = props
    const { t } = useTranslation('common')

    if (daemons.length === 0) {
        return (
            <div className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.machines.title')}</h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                        {t('setupWizard.machines.noMachinesDescription')}
                    </p>
                </div>
                {renderInstallOnboarding ? renderInstallOnboarding() : (
                    <p className="text-[11px] text-text-muted">{t('setupWizard.machines.noMachinesFallback')}</p>
                )}
            </div>
        )
    }

    const attachDisabled = attaching || attachPlanLoading || attachPlan?.success === false
        || !attachWorkspace.trim()
        || (features.addNodeDaemonPicker && !attachDaemonId)

    return (
        <div className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.machines.title')}</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                    {t('setupWizard.machines.description')}
                </p>
            </div>

            {/* ── Mesh choice ── */}
            <div className="flex flex-col gap-2">
                {meshes.map(mesh => {
                    const selected = !createMode && selectedMeshId === mesh.id
                    return (
                        <button
                            key={mesh.id}
                            type="button"
                            onClick={() => { onCreateModeChange(false); onSelectMesh(mesh.id) }}
                            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${selected ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-border-subtle bg-bg-secondary/60 hover:border-border-default'}`}
                        >
                            <span className="min-w-0">
                                <span className="block truncate text-sm text-text-primary">{mesh.name}</span>
                                <span className="block truncate text-[11px] text-text-muted">
                                    {mesh.repoIdentity || mesh.repoRemoteUrl || ''} · {t('setupWizard.machines.nodeCount', { count: (mesh.nodes || []).length })}
                                </span>
                            </span>
                        </button>
                    )
                })}
                <button
                    type="button"
                    onClick={() => onCreateModeChange(true)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${createMode ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-dashed border-border-subtle bg-bg-secondary/40 hover:border-border-default'}`}
                >
                    <span className="text-sm text-text-primary">+ {t('setupWizard.machines.createNew')}</span>
                </button>
                {meshesLoading && meshes.length === 0 && (
                    <p className="text-[11px] text-text-muted">{t('setupWizard.machines.loadingMeshes')}</p>
                )}
            </div>

            {/* ── Create form (shared with the mesh page) ── */}
            {createMode && (
                <MeshCreateForm
                    variant="wizard"
                    showDaemonPicker={features.createDaemonPicker}
                    daemons={daemons}
                    daemonLabel={daemonLabel}
                    name={createName}
                    onNameChange={onCreateNameChange}
                    daemonId={createDaemonId}
                    onDaemonIdChange={onCreateDaemonIdChange}
                    workspace={createWorkspace}
                    onWorkspaceChange={onCreateWorkspaceChange}
                    workspaces={createPickerWorkspaces}
                    plan={createPlan}
                    planLoading={createPlanLoading}
                    repoRemoteUrl={createRepoRemoteUrl}
                    onRepoRemoteUrlChange={onCreateRepoRemoteUrlChange}
                    repoIdentity={createRepoIdentity}
                    onRepoIdentityChange={onCreateRepoIdentityChange}
                    manualOpen={createManualOpen}
                    onManualOpenChange={onCreateManualOpenChange}
                    creating={creating}
                    warning={createWarning}
                    onCreate={onCreate}
                />
            )}

            {/* ── Attach form (existing mesh) ── */}
            {!createMode && selectedMeshId && (
                <div className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2.5">
                    {nodes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {nodes.map(node => (
                                <span key={node.id} className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] text-text-secondary">
                                    {nodeLabel(node)}
                                </span>
                            ))}
                        </div>
                    )}

                    <span className="text-[11px] font-medium text-text-secondary">{t('setupWizard.machines.attachTitle')}</span>

                    {features.addNodeDaemonPicker && (
                        attachableDaemons.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {attachableDaemons.map(d => {
                                    const selected = attachDaemonId === d.id
                                    return (
                                        <button
                                            key={d.id}
                                            type="button"
                                            onClick={() => onAttachDaemonIdChange(d.id)}
                                            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${selected ? 'border-accent-primary/60 bg-accent-primary/10 text-text-primary' : 'border-border-subtle bg-bg-secondary text-text-secondary hover:border-border-default'}`}
                                        >
                                            {daemonLabel(d)}
                                        </button>
                                    )
                                })}
                            </div>
                        ) : (
                            <p className="text-[11px] text-text-muted">{t('setupWizard.machines.allMachinesAttached')}</p>
                        )
                    )}

                    {(!features.addNodeDaemonPicker || attachDaemonId) && (
                        <>
                            <WorkspacePicker workspaces={attachPickerWorkspaces} value={attachWorkspace} onChange={onAttachWorkspaceChange} />
                            <PlanStatus plan={attachPlan} loading={attachPlanLoading} />
                            <div className="flex justify-end">
                                <button type="button" className="btn btn-secondary btn-sm" onClick={onAttach} disabled={attachDisabled}>
                                    {attaching ? t('setupWizard.machines.attaching') : t('setupWizard.machines.addMachine')}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
