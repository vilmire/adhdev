/**
 * WorkspacePicker — a select over a daemon's known workspaces with a
 * free-text escape hatch.
 *
 * Extracted verbatim from the setup wizard's MachinesStep so the mesh page's
 * create/add-node forms render the same control. Pure presentation: the
 * committed value always flows through `value`/`onChange`; the only local
 * state is whether the custom-path input is showing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
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
                        className="self-start text-3xs text-accent-primary hover:underline"
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

/** True when a successful plan targets an already-existing compatible mesh rather than creating a new one. */
export function planTargetsExistingMesh(plan: any): boolean {
    return !!plan?.success && plan?.plan?.kind !== undefined && plan.plan.kind !== 'create_mesh_and_onboard'
}

/**
 * Debounces the ON edge of a loading flag, not the OFF edge: `loading` must
 * stay true for `delayMs` before this reports true, but the moment `loading`
 * goes false it reports false immediately. This is what keeps the "Checking
 * the workspace..." text from flashing on screen for a probe that resolves in
 * a handful of milliseconds (e.g. a cache hit, or a probe effect that re-fires
 * and immediately settles) — a real in-flight check still shows the message,
 * it just doesn't appear for a check that was never actually visible to a human.
 */
export function useSettledLoading(loading: boolean, delayMs: number): boolean {
    const [settled, setSettled] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => {
        if (loading) {
            timerRef.current = setTimeout(() => setSettled(true), delayMs)
        } else {
            setSettled(false)
        }
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [loading, delayMs])
    return loading && settled
}

/**
 * Plan-probe status line (plan_mesh_onboarding dry-run result). Reserves a fixed
 * height (one line) at every state so a workspace pick never shifts the layout
 * below it — the "flickering" complaint was as much this box appearing/
 * disappearing as it was the text inside it changing. The loading text itself
 * is further debounced (see useSettledLoading) so a probe that re-fires and
 * resolves quickly doesn't flash "Checking..." over the previous result.
 */
export function PlanStatus({ plan, loading }: { plan: any; loading: boolean }) {
    const { t } = useTranslation('common')
    const showLoading = useSettledLoading(loading, 250)
    let content: ReactNode = null
    let className = 'text-2xs text-text-muted'
    if (showLoading) {
        content = t('setupWizard.machines.planChecking')
    } else if (plan?.success === false) {
        className = 'text-2xs text-red-400'
        content = <>{plan.error}{plan.action ? ` ${plan.action}` : ''}</>
    } else if (planTargetsExistingMesh(plan)) {
        className = 'text-2xs text-amber-400'
        content = plan.plan?.summary || t('setupWizard.machines.planExists')
    } else if (plan) {
        className = 'text-2xs text-emerald-400'
        content = t('setupWizard.machines.planOk', { identity: plan.discovery?.repoIdentity || plan.discovery?.repoRoot || '' })
    }
    return <p className={`${className} min-h-[1.4em]`}>{content}</p>
}
