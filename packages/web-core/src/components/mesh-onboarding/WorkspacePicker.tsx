/**
 * WorkspacePicker — a select over a daemon's known workspaces with a
 * free-text escape hatch.
 *
 * Extracted verbatim from the setup wizard's MachinesStep so the mesh page's
 * create/add-node forms render the same control. Pure presentation: the
 * committed value always flows through `value`/`onChange`; the only local
 * state is whether the custom-path input is showing.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface WorkspaceOption {
    id?: string
    path: string
    label?: string | null
}

export const meshOnboardingInputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'

export interface WorkspacePickerProps {
    workspaces: WorkspaceOption[]
    value: string
    onChange: (v: string) => void
    autoFocus?: boolean
}

export default function WorkspacePicker({ workspaces, value, onChange, autoFocus }: WorkspacePickerProps) {
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
                    className={meshOnboardingInputCls}
                    value={value}
                    autoFocus={autoFocus}
                    placeholder={t('setupWizard.machines.workspacePlaceholder')}
                    onChange={e => onChange(e.target.value)}
                />
                {workspaces.length > 0 && (
                    <button
                        type="button"
                        className="self-start text-[10px] text-accent-primary hover:underline"
                        onClick={() => setCustom(false)}
                    >
                        {t('setupWizard.machines.pickFromKnown')}
                    </button>
                )}
            </div>
        )
    }
    return (
        <select
            className={meshOnboardingInputCls}
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
export function PlanStatus({ plan, loading }: { plan: any; loading: boolean }) {
    const { t } = useTranslation('common')
    if (loading) return <p className="text-[11px] text-text-muted">{t('setupWizard.machines.planChecking')}</p>
    if (!plan) return null
    if (plan.success === false) {
        return <p className="text-[11px] text-red-400">{plan.error}{plan.action ? ` ${plan.action}` : ''}</p>
    }
    const identity = plan.discovery?.repoIdentity || plan.discovery?.repoRoot || ''
    return <p className="text-[11px] text-emerald-400">{t('setupWizard.machines.planOk', { identity })}</p>
}
