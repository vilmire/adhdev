/**
 * MeshCreateForm — the single create-a-mesh form.
 *
 * Before this component the create form existed TWICE with different required
 * fields depending on the entry point: the mesh page demanded a repo remote URL
 * or identity typed by hand, while the setup wizard sent both as empty strings
 * and let `plan_mesh_onboarding` discover them from git. Same backend call,
 * two contradictory contracts — a mesh you could create from /setup was
 * rejected from /mesh.
 *
 * The discovery flow wins: pick a workspace, the owning daemon inspects the
 * repository read-only and fills in identity/URL/name. Manual entry survives as
 * an explicitly-openable fallback, because discovery legitimately comes up
 * empty for a repo with no remote or one whose URL differs per machine — those
 * users were previously served by the mesh page's required fields and must not
 * lose the ability to create a mesh.
 *
 * Deliberately DUMB: every value and handler is a prop. The `variant` prop only
 * selects presentation (the wizard's compact inline panel vs the mesh page's
 * Section card); it never changes which fields are required.
 */
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import { FormField, Input } from '../ui/FormField'
import { AlertBanner } from '../ui/AlertBanner'
import WorkspacePicker, { PlanStatus, meshOnboardingInputCls, type WorkspaceOption } from './WorkspacePicker'

export interface MeshCreateFormProps {
    /** Presentation only — `page` renders FormField rows, `wizard` renders the compact inline panel. */
    variant?: 'page' | 'wizard'
    /** Cloud shows a machine picker; standalone has exactly one daemon. */
    showDaemonPicker: boolean
    daemons: RepoMeshDaemonEntry[]
    daemonLabel: (d: RepoMeshDaemonEntry) => string

    name: string
    onNameChange: (v: string) => void
    daemonId: string
    onDaemonIdChange: (v: string) => void
    workspace: string
    onWorkspaceChange: (v: string) => void
    workspaces: WorkspaceOption[]

    /** plan_mesh_onboarding dry-run result for the chosen workspace. */
    plan: any
    planLoading: boolean

    /**
     * Manual identity/URL fallback. Discovery fills these in; they stay
     * editable for repos where discovery cannot (no remote, per-machine URL).
     */
    repoRemoteUrl: string
    onRepoRemoteUrlChange: (v: string) => void
    repoIdentity: string
    onRepoIdentityChange: (v: string) => void
    /** Whether the manual identity/URL block is expanded. */
    manualOpen: boolean
    onManualOpenChange: (v: boolean) => void

    creating: boolean
    warning?: string | null
    onCreate: () => void
    onCancel?: () => void
}

/**
 * Whether Create should be disabled.
 *
 * Exported and pure so the rule is testable and stated once. Note what is NOT
 * here: a requirement that repoRemoteUrl or repoIdentity be non-empty. A
 * successful discovery plan supplies both, and runMeshCreateSequence prefers
 * the typed value only when present. Requiring them by hand was the mesh-page
 * behaviour this unification removes.
 */
export function isMeshCreateDisabled(opts: {
    creating: boolean
    planLoading: boolean
    plan: any
    name: string
    workspace: string
    showDaemonPicker: boolean
    daemonId: string
    repoRemoteUrl: string
    repoIdentity: string
}): boolean {
    if (opts.creating || opts.planLoading) return true
    if (!opts.name.trim()) return true
    if (opts.showDaemonPicker && !opts.daemonId) return true
    if (opts.plan?.success === false) return true
    // A workspace is how discovery happens. Without one, the only way to
    // identify the repo is a manually supplied URL or identity.
    if (!opts.workspace.trim()) {
        return !opts.repoRemoteUrl.trim() && !opts.repoIdentity.trim()
    }
    return false
}

export default function MeshCreateForm(props: MeshCreateFormProps) {
    const {
        variant = 'page',
        showDaemonPicker, daemons, daemonLabel,
        name, onNameChange,
        daemonId, onDaemonIdChange,
        workspace, onWorkspaceChange, workspaces,
        plan, planLoading,
        repoRemoteUrl, onRepoRemoteUrlChange,
        repoIdentity, onRepoIdentityChange,
        manualOpen, onManualOpenChange,
        creating, warning, onCreate, onCancel,
    } = props
    const { t } = useTranslation('common')

    const disabled = isMeshCreateDisabled({
        creating, planLoading, plan, name, workspace,
        showDaemonPicker, daemonId, repoRemoteUrl, repoIdentity,
    })

    // Auto-expand so a discovered or typed value is never hidden behind the toggle.
    const manualExpanded = manualOpen || !!repoRemoteUrl.trim() || !!repoIdentity.trim()

    const machinePicker = showDaemonPicker && daemons.length > 0 && (
        <select
            className={variant === 'wizard' ? meshOnboardingInputCls : 'input w-full'}
            value={daemonId}
            onChange={e => onDaemonIdChange(e.target.value)}
        >
            <option value="">{t('setupWizard.machines.machineSelectPlaceholder')}</option>
            {daemons.map(d => <option key={d.id} value={d.id}>{daemonLabel(d)}</option>)}
        </select>
    )

    const manualBlock = manualExpanded ? (
        <>
            <FormField label={t('repoMesh.list.remoteUrl')} hint={t('repoMesh.list.remoteUrlHint')}>
                <Input value={repoRemoteUrl} onChange={e => onRepoRemoteUrlChange(e.target.value)} placeholder="https://github.com/user/repo" />
            </FormField>
            <FormField label={t('repoMesh.list.repoIdentity')} hint={t('repoMesh.list.repoIdentityHint')}>
                <Input value={repoIdentity} onChange={e => onRepoIdentityChange(e.target.value)} placeholder="github.com/user/repo" />
            </FormField>
        </>
    ) : (
        <button
            type="button"
            className="self-start text-xs text-text-muted hover:text-text-primary underline underline-offset-2 mb-3 bg-transparent border-none cursor-pointer p-0"
            onClick={() => onManualOpenChange(true)}
        >
            {t('repoMesh.list.advancedIdentityToggle')}
        </button>
    )

    if (variant === 'wizard') {
        return (
            <div className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2.5">
                <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">{t('setupWizard.machines.meshName')}</span>
                    <input type="text" className={meshOnboardingInputCls} value={name} onChange={e => onNameChange(e.target.value)} />
                </label>

                {showDaemonPicker && daemons.length > 1 && (
                    <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-muted">{t('setupWizard.machines.machine')}</span>
                        {machinePicker}
                    </label>
                )}

                <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">{t('setupWizard.machines.workspace')}</span>
                    <WorkspacePicker workspaces={workspaces} value={workspace} onChange={onWorkspaceChange} />
                </label>

                <PlanStatus plan={plan} loading={planLoading} />
                {warning && <p className="text-[11px] text-amber-400">{warning}</p>}

                <div className="flex justify-end">
                    <button type="button" className="btn btn-primary btn-sm" onClick={onCreate} disabled={disabled}>
                        {creating ? t('setupWizard.machines.creating') : t('setupWizard.machines.create')}
                    </button>
                </div>
            </div>
        )
    }

    return (
        <>
            <h3 className="text-base font-bold mb-4">{t('repoMesh.list.createTitle')}</h3>

            {showDaemonPicker && (
                <FormField label={t('repoMesh.list.createOnMachine')} hint={t('repoMesh.list.createOnMachineHint')}>
                    {daemons.length === 0
                        ? <select className="input w-full" disabled><option value="">{t('repoMesh.list.noConnectedDaemon')}</option></select>
                        : machinePicker}
                </FormField>
            )}

            <FormField label={t('repoMesh.list.workspace')} hint={t('repoMesh.list.workspaceHint')}>
                <WorkspacePicker workspaces={workspaces} value={workspace} onChange={onWorkspaceChange} />
            </FormField>

            {(planLoading || plan) && (
                <AlertBanner variant={plan?.success === false ? 'error' : 'info'} className="mb-4">
                    {planLoading
                        ? t('setupWizard.machines.planChecking')
                        : plan?.success
                            ? `${plan.plan?.summary || 'Git repository detected.'} No changes will be made until you click Create.`
                            : `${plan?.code || 'onboarding_blocked'}: ${plan?.error || 'Git discovery failed'} ${plan?.action || ''}`}
                </AlertBanner>
            )}

            <FormField label={t('repoMesh.list.name')}>
                <Input value={name} onChange={e => onNameChange(e.target.value)} placeholder="my-project-mesh" autoFocus />
            </FormField>

            <div className="flex flex-col">{manualBlock}</div>

            <div className="flex gap-2 mt-3">
                <button className="btn btn-primary btn-sm" onClick={onCreate} disabled={disabled}>
                    {creating ? t('repoMesh.list.creating') : t('repoMesh.list.create')}
                </button>
                {onCancel && (
                    <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={creating}>
                        {t('repoMesh.list.cancel')}
                    </button>
                )}
            </div>
        </>
    )
}
