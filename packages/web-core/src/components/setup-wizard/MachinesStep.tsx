/**
 * MachinesStep — the setup wizard's machine-selection step.
 *
 * Three states:
 *  - No registered machines: renders the platform-injected install/pair
 *    surface (cloud injects its DashboardOnboarding; web-core cannot import
 *    web-cloud, so it arrives as the renderInstallOnboarding prop).
 *  - Existing meshes: pick the mesh to configure; the attach form below adds
 *    more machines to it (plan_mesh_onboarding → add_mesh_node — the same
 *    command sequence as MeshNodeList's add-node flow, committed immediately
 *    so later steps see real node ids).
 *  - No mesh yet: the create form (name + machine + workspace) drives
 *    runMeshCreateSequence — mesh + first node in one go.
 *
 * Deliberately DUMB: every handler and piece of state lives in the wizard
 * shell; this component only renders and reports user intent upward.
 */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry, RepoMeshFeatures } from '../../context/RepoMeshContext'
import type { MeshEntry, MeshNode } from '../../pages/repo-mesh/types'

interface WorkspaceOption { id?: string; path: string; label?: string | null }

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

const inputCls = 'w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'

/** Workspace picker: a select over the daemon's known workspaces, with a custom-path escape hatch. */
function WorkspacePicker({ workspaces, value, onChange }: {
    workspaces: WorkspaceOption[]
    value: string
    onChange: (v: string) => void
}) {
    const { t } = useTranslation('common')
    // Pure UI state: whether the free-text input is shown. The committed value
    // always flows through `value`.
    const [custom, setCustom] = useState(false)
    const knownPaths = new Set(workspaces.map(w => w.path))
    const selectValue = custom ? '__custom' : (knownPaths.has(value) ? value : '')

    if (workspaces.length === 0 || custom) {
        return (
            <div className="flex flex-col gap-1">
                <input
                    type="text"
                    className={inputCls}
                    value={value}
                    placeholder={t('setupWizard.machines.workspacePlaceholder')}
                    onChange={e => onChange(e.target.value)}
                />
                {workspaces.length > 0 && (
                    <button type="button" className="self-start text-[10px] text-accent-primary hover:underline" onClick={() => setCustom(false)}>
                        {t('setupWizard.machines.pickFromKnown')}
                    </button>
                )}
            </div>
        )
    }
    return (
        <select
            className={inputCls}
            value={selectValue}
            onChange={e => {
                if (e.target.value === '__custom') {
                    setCustom(true)
                    onChange('')
                } else {
                    onChange(e.target.value)
                }
            }}
        >
            <option value="">{t('setupWizard.machines.workspaceSelectPlaceholder')}</option>
            {workspaces.map(w => <option key={w.path} value={w.path}>{w.label || w.path}</option>)}
            <option value="__custom">{t('setupWizard.machines.workspaceCustom')}</option>
        </select>
    )
}

/** Plan-probe status line (plan_mesh_onboarding dry-run result). */
function PlanStatus({ plan, loading }: { plan: any; loading: boolean }) {
    const { t } = useTranslation('common')
    if (loading) return <p className="text-[11px] text-text-muted">{t('setupWizard.machines.planChecking')}</p>
    if (!plan) return null
    if (plan.success === false) {
        return <p className="text-[11px] text-red-400">{plan.error}{plan.action ? ` ${plan.action}` : ''}</p>
    }
    const identity = plan.discovery?.repoIdentity || plan.discovery?.repoRoot || ''
    return <p className="text-[11px] text-emerald-400">{t('setupWizard.machines.planOk', { identity })}</p>
}

export default function MachinesStep(props: MachinesStepProps) {
    const {
        daemons, features, meshes, meshesLoading,
        selectedMeshId, onSelectMesh,
        createMode, onCreateModeChange,
        createName, onCreateNameChange, createDaemonId, onCreateDaemonIdChange,
        createWorkspace, onCreateWorkspaceChange, createPickerWorkspaces,
        createPlan, createPlanLoading, creating, createWarning, onCreate,
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

    const createDisabled = creating || createPlanLoading || createPlan?.success === false
        || !createName.trim() || !createWorkspace.trim()
        || (features.createDaemonPicker && !createDaemonId)
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

            {/* ── Create form ── */}
            {createMode && (
                <div className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2.5">
                    <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-muted">{t('setupWizard.machines.meshName')}</span>
                        <input type="text" className={inputCls} value={createName} onChange={e => onCreateNameChange(e.target.value)} />
                    </label>

                    {features.createDaemonPicker && daemons.length > 1 && (
                        <label className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-muted">{t('setupWizard.machines.machine')}</span>
                            <select className={inputCls} value={createDaemonId} onChange={e => onCreateDaemonIdChange(e.target.value)}>
                                <option value="">{t('setupWizard.machines.machineSelectPlaceholder')}</option>
                                {daemons.map(d => <option key={d.id} value={d.id}>{daemonLabel(d)}</option>)}
                            </select>
                        </label>
                    )}

                    <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-muted">{t('setupWizard.machines.workspace')}</span>
                        <WorkspacePicker workspaces={createPickerWorkspaces} value={createWorkspace} onChange={onCreateWorkspaceChange} />
                    </label>

                    <PlanStatus plan={createPlan} loading={createPlanLoading} />
                    {createWarning && <p className="text-[11px] text-amber-400">{createWarning}</p>}

                    <div className="flex justify-end">
                        <button type="button" className="btn btn-primary btn-sm" onClick={onCreate} disabled={createDisabled}>
                            {creating ? t('setupWizard.machines.creating') : t('setupWizard.machines.create')}
                        </button>
                    </div>
                </div>
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
