/**
 * SchedulingStep — the setup wizard's distribution-mode step.
 *
 * Reuses the Smart / In order 2-mode façade from MeshDetailView (same
 * DISTRIBUTION_OPTIONS, same radio markup) but writes into the wizard draft
 * instead of firing update_mesh directly: onChange only STAGES the choice, the
 * shell maps it to the raw schedulingStrategy at final commit
 * (distributionToStrategy in wizardCommit.ts).
 */
import { useTranslation } from 'react-i18next'
import { DISTRIBUTION_OPTIONS, type MeshDistribution } from '../../pages/repo-mesh/types'

export interface SchedulingStepProps {
    /** Currently staged (or persisted) distribution mode. */
    value: MeshDistribution
    /** Stage a new mode into the wizard draft. */
    onChange: (value: MeshDistribution) => void
    /** Mode to badge as recommended (e.g. 'smart' when any node has slots). */
    recommended?: MeshDistribution | null
    disabled?: boolean
}

export default function SchedulingStep({ value, onChange, recommended, disabled }: SchedulingStepProps) {
    const { t } = useTranslation('common')
    return (
        <div className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.scheduling.title')}</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                    {t('setupWizard.scheduling.description')}
                </p>
            </div>

            {/* Markup mirrors MeshDetailView's distribution radio group so both
                surfaces read and behave identically. */}
            <fieldset className="border-none p-0 m-0">
                <legend className="text-[13px] font-medium text-text-secondary mb-2">{t('repoMesh.detail.distribution')}</legend>
                <div className="flex flex-col gap-2">
                    {DISTRIBUTION_OPTIONS.map(opt => {
                        const selected = value === opt.value
                        return (
                            <label key={opt.value}
                                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${selected ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-border-subtle bg-bg-secondary/60 hover:border-border-default'}`}>
                                <input type="radio" name="setup-wizard-distribution" className="mt-0.5 accent-[var(--accent-primary)]"
                                    value={opt.value} checked={selected} disabled={disabled}
                                    onChange={() => onChange(opt.value)} />
                                <span className="min-w-0">
                                    <span className="flex items-center gap-2 text-sm text-text-primary">
                                        {opt.label}
                                        {recommended === opt.value && (
                                            <span className="rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-primary">{t('repoMesh.detail.recommended')}</span>
                                        )}
                                    </span>
                                    <span className="block text-[12px] text-text-muted">{opt.description}</span>
                                </span>
                            </label>
                        )
                    })}
                </div>
            </fieldset>

            <p className="text-[10px] leading-relaxed text-text-muted">
                {t('setupWizard.stagedNote')}
            </p>
        </div>
    )
}
