/**
 * ApprovalsStep — the setup wizard's approval/safety step.
 *
 * Two surfaces, matching the mesh detail page:
 *  1. Mesh-policy approval selects — the same config-array rows as
 *     MeshDetailView's "Safety & Git" section, but STAGED into the wizard
 *     draft (applied at final commit via update_mesh).
 *
 *     There is no destructive-git approval toggle here (or in MeshDetailView):
 *     the policy field that used to back one (`requireApprovalForDestructiveGit`)
 *     was removed — it had no daemon-side enforcement reader, so the toggle
 *     could silently do nothing. The coordinator prompt's "ask before
 *     destructive git ops" rule is now unconditional prose, not a
 *     policy-gated setting, so there is nothing for a wizard step to stage.
 *
 *  2. MeshProviderAutoApproveSection — reused unchanged when the target
 *     mesh has a resolvable host node. It keeps its existing immediate-save
 *     semantics (repo mesh.json defaults + machine authorization), independent
 *     of the wizard's staged draft.
 */
import { useTranslation } from 'react-i18next'
import { FormField } from '../ui/FormField'
import { MeshProviderAutoApproveSection } from '../../pages/repo-mesh/MeshProviderAutoApproveSection'

export interface ApprovalsStepAutoApproveProps {
    hostDaemonId: string
    hostOnline: boolean
    hostWorkspace: string
    meshProviders: any[]
    unreportedNodeCount?: number
    machineAutoApproveEnabled: boolean
    machineDangerousAllowed: boolean
    onUpdatePolicy: (patch: Record<string, unknown>) => void
    savingPolicy?: boolean
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

export interface ApprovalsStepProps {
    /** Current persisted policy (readMeshPolicy output). */
    policy: Record<string, any>
    /** Staged approval changes (win over policy for display). */
    stagedPatch: Record<string, unknown>
    /** Stage approval-policy changes into the wizard draft. */
    onStage: (patch: Record<string, unknown>) => void
    /** Provider auto-approve surface; null when no host node is resolvable. */
    autoApprove?: ApprovalsStepAutoApproveProps | null
    disabled?: boolean
}

export default function ApprovalsStep({ policy, stagedPatch, onStage, autoApprove, disabled }: ApprovalsStepProps) {
    const { t } = useTranslation('common')

    const current = (key: string) => (key in stagedPatch ? stagedPatch[key] : policy[key])

    // Same row config as MeshDetailView's Safety & Git selects (there is no
    // destructive-git approval row — see header).
    const rows: Array<{ label: string; key: string; opts: Array<[string, string]>; val: (v: any) => string; parse: (v: string) => unknown }> = [
        { label: t('repoMesh.detail.checkpointBefore'), key: 'requirePreTaskCheckpoint', opts: [['no', 'No'], ['yes', 'Yes']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
        { label: t('repoMesh.detail.checkpointAfter'), key: 'requirePostTaskCheckpoint', opts: [['yes', 'Yes'], ['no', 'No']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
        { label: t('repoMesh.detail.pushApproval'), key: 'requireApprovalForPush', opts: [['required', t('repoMesh.detail.requireApprovalBeforePush')], ['not_required', t('repoMesh.detail.doNotRequireApproval')]], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
        { label: t('repoMesh.detail.uncommittedChanges'), key: 'dirtyWorkspaceBehavior', opts: [['warn', t('repoMesh.detail.warnAndContinue')], ['block', t('repoMesh.detail.blockTask')], ['checkpoint_then_continue', t('repoMesh.detail.checkpointThenContinue')]], val: (v: any) => v || 'warn', parse: (v: string) => v },
    ]

    return (
        <div className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.approvals.title')}</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                    {t('setupWizard.approvals.description')}
                </p>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {rows.map(({ label, key, opts, val, parse }) => (
                    <FormField key={key} label={label}>
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={val(current(key))}
                            onChange={e => onStage({ [key]: parse(e.target.value) })}
                            disabled={disabled}
                        >
                            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </FormField>
                ))}
            </div>

            <p className="text-[10px] leading-relaxed text-text-muted">
                {t('setupWizard.stagedNote')}
            </p>

            {autoApprove && (
                <div className="mt-2 border-t border-border-subtle pt-3">
                    <MeshProviderAutoApproveSection
                        hostDaemonId={autoApprove.hostDaemonId}
                        hostOnline={autoApprove.hostOnline}
                        hostWorkspace={autoApprove.hostWorkspace}
                        meshProviders={autoApprove.meshProviders}
                        unreportedNodeCount={autoApprove.unreportedNodeCount}
                        machineAutoApproveEnabled={autoApprove.machineAutoApproveEnabled}
                        machineDangerousAllowed={autoApprove.machineDangerousAllowed}
                        onUpdatePolicy={autoApprove.onUpdatePolicy}
                        savingPolicy={autoApprove.savingPolicy}
                        sendCommand={autoApprove.sendCommand}
                    />
                </div>
            )}
        </div>
    )
}
