/**
 * QuotaPolicyStep — the setup wizard's quota-aware routing step.
 *
 * Edits RepoMeshPolicy.quotaRouting: the thresholds the coordinator's launch
 * GATE and fitness SPREAD apply to reported provider quota
 * (mesh/mesh-quota-routing.ts). The daemon persists them per mesh through
 * mesh_quota_routing_set; this component only produces the overrides object
 * and hands it to onSave.
 *
 * Deliberately DUMB: no context, no command calls, no daemon imports beyond
 * `import type`. The wizard shell owns the mesh id, the save transport and the
 * result toast — this step owns the form and its validation only.
 *
 * Two properties of the underlying policy shape the UI:
 *  - Every field is OPTIONAL and resolves to a shipped default when unset. So a
 *    blank input is a real, meaningful state ("use the default"), not an error,
 *    and it renders the default as placeholder rather than pre-filling it. Only
 *    fields the user actually typed are emitted, matching the writer's
 *    overrides-only persistence.
 *  - The gate FAILS OPEN on missing/stale data, so a bad threshold degrades
 *    routing rather than wedging it — but a typo can still make a mesh refuse
 *    work it should accept. The same bounds the daemon-side writer enforces
 *    (percent 0..100, durations >= 0) are enforced here so the user sees a
 *    field-level message instead of a rejected round-trip.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshQuotaRoutingPolicy } from '@adhdev/daemon-core'

/** Editable draft — every field a string so a cleared input stays cleared. */
interface QuotaPolicyDraft {
    sessionMinRemainingPercent: string
    weeklyMinRemainingPercent: string
    sessionResetImminentMinutes: string
    staleAfterMinutes: string
    spreadBonusMax: string
    sessionAxisWeeklyHeadroomPercent: string
}

/**
 * Defaults mirrored for DISPLAY ONLY (placeholders + the "reset to defaults"
 * affordance). They are intentionally not written into the draft: the daemon's
 * DEFAULT_QUOTA_ROUTING_POLICY stays the single source of truth for what an
 * unset field resolves to, and emitting a value equal to the default would just
 * be dropped by the writer's persistence economy anyway.
 */
const DISPLAY_DEFAULTS = {
    sessionMinRemainingPercent: 10,
    weeklyMinRemainingPercent: 15,
    sessionResetImminentMinutes: 5,
    staleAfterMinutes: 30,
    spreadBonusMax: 30,
    sessionAxisWeeklyHeadroomPercent: 40,
} as const

const MS_PER_MINUTE = 60 * 1000

function msToMinutes(ms: number | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) return ''
    return String(ms / MS_PER_MINUTE)
}

function policyToDraft(policy: RepoMeshQuotaRoutingPolicy | null | undefined): QuotaPolicyDraft {
    const p = policy ?? {}
    return {
        sessionMinRemainingPercent: p.sessionMinRemainingPercent !== undefined ? String(p.sessionMinRemainingPercent) : '',
        weeklyMinRemainingPercent: p.weeklyMinRemainingPercent !== undefined ? String(p.weeklyMinRemainingPercent) : '',
        sessionResetImminentMinutes: msToMinutes(p.sessionResetImminentMs),
        staleAfterMinutes: msToMinutes(p.staleAfterMs),
        spreadBonusMax: p.spreadBonusMax !== undefined ? String(p.spreadBonusMax) : '',
        sessionAxisWeeklyHeadroomPercent: p.sessionAxisWeeklyHeadroomPercent !== undefined ? String(p.sessionAxisWeeklyHeadroomPercent) : '',
    }
}

type FieldKey = keyof QuotaPolicyDraft

/**
 * Validate one field. Returns an error key (i18n) or null. Blank is always
 * valid — it means "inherit the default".
 */
function validateField(key: FieldKey, raw: string): string | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const num = Number(trimmed)
    if (!Number.isFinite(num)) return 'notANumber'
    const isPercent = key === 'sessionMinRemainingPercent' || key === 'weeklyMinRemainingPercent' || key === 'sessionAxisWeeklyHeadroomPercent'
    if (isPercent && (num < 0 || num > 100)) return 'percentRange'
    if (!isPercent && num < 0) return 'negative'
    return null
}

/**
 * Draft → the overrides object the daemon persists. Blank fields are omitted
 * (not zeroed), and the two duration fields convert back from the minutes the
 * form shows to the milliseconds the policy stores.
 */
export function quotaPolicyDraftToOverrides(draft: QuotaPolicyDraft): RepoMeshQuotaRoutingPolicy {
    const out: RepoMeshQuotaRoutingPolicy = {}
    const num = (raw: string): number | undefined => {
        const trimmed = raw.trim()
        if (!trimmed) return undefined
        const n = Number(trimmed)
        return Number.isFinite(n) ? n : undefined
    }
    const sessionMin = num(draft.sessionMinRemainingPercent)
    if (sessionMin !== undefined) out.sessionMinRemainingPercent = sessionMin
    const weeklyMin = num(draft.weeklyMinRemainingPercent)
    if (weeklyMin !== undefined) out.weeklyMinRemainingPercent = weeklyMin
    const resetImminent = num(draft.sessionResetImminentMinutes)
    if (resetImminent !== undefined) out.sessionResetImminentMs = resetImminent * MS_PER_MINUTE
    const stale = num(draft.staleAfterMinutes)
    if (stale !== undefined) out.staleAfterMs = stale * MS_PER_MINUTE
    const spread = num(draft.spreadBonusMax)
    if (spread !== undefined) out.spreadBonusMax = spread
    const sessionAxisWeeklyHeadroom = num(draft.sessionAxisWeeklyHeadroomPercent)
    if (sessionAxisWeeklyHeadroom !== undefined) out.sessionAxisWeeklyHeadroomPercent = sessionAxisWeeklyHeadroom
    return out
}

export interface QuotaPolicyStepProps {
    /** Current persisted overrides (overrides only — absent fields = default). */
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null
    /** True while the parent's save is in flight. */
    saving?: boolean
    /** Save failure surfaced by the parent (e.g. `invalid_quota_routing: …`). */
    error?: string | null
    /** Emits the overrides object; `{}` clears every override. */
    onSave: (quotaRouting: RepoMeshQuotaRoutingPolicy) => void
}

const inputCls = 'w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'
const errorInputCls = 'w-full rounded-lg border border-red-500/60 bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'

export default function QuotaPolicyStep({ quotaRouting, saving, error, onSave }: QuotaPolicyStepProps) {
    const { t } = useTranslation('common')
    const [draft, setDraft] = useState<QuotaPolicyDraft>(() => policyToDraft(quotaRouting))

    const update = useCallback((key: FieldKey, value: string) => {
        setDraft(prev => ({ ...prev, [key]: value }))
    }, [])

    const errors = useMemo(() => {
        const out: Partial<Record<FieldKey, string>> = {}
        for (const key of Object.keys(draft) as FieldKey[]) {
            const err = validateField(key, draft[key])
            if (err) out[key] = err
        }
        return out
    }, [draft])

    const hasErrors = Object.keys(errors).length > 0

    const dirty = useMemo(
        () => JSON.stringify(quotaPolicyDraftToOverrides(draft)) !== JSON.stringify(policyToOverrides(quotaRouting)),
        [draft, quotaRouting],
    )

    const save = useCallback(() => {
        if (hasErrors) return
        onSave(quotaPolicyDraftToOverrides(draft))
    }, [draft, hasErrors, onSave])

    const resetToDefaults = useCallback(() => {
        setDraft(policyToDraft(null))
    }, [])

    const fields: Array<{ key: FieldKey; label: string; hint: string; placeholder: number; unit: string }> = [
        {
            key: 'sessionMinRemainingPercent',
            label: t('setupWizard.quotaPolicy.sessionMin'),
            hint: t('setupWizard.quotaPolicy.sessionMinHint'),
            placeholder: DISPLAY_DEFAULTS.sessionMinRemainingPercent,
            unit: '%',
        },
        {
            key: 'weeklyMinRemainingPercent',
            label: t('setupWizard.quotaPolicy.weeklyMin'),
            hint: t('setupWizard.quotaPolicy.weeklyMinHint'),
            placeholder: DISPLAY_DEFAULTS.weeklyMinRemainingPercent,
            unit: '%',
        },
        {
            key: 'sessionResetImminentMinutes',
            label: t('setupWizard.quotaPolicy.resetImminent'),
            hint: t('setupWizard.quotaPolicy.resetImminentHint'),
            placeholder: DISPLAY_DEFAULTS.sessionResetImminentMinutes,
            unit: t('setupWizard.quotaPolicy.minutes'),
        },
        {
            key: 'staleAfterMinutes',
            label: t('setupWizard.quotaPolicy.staleAfter'),
            hint: t('setupWizard.quotaPolicy.staleAfterHint'),
            placeholder: DISPLAY_DEFAULTS.staleAfterMinutes,
            unit: t('setupWizard.quotaPolicy.minutes'),
        },
        {
            key: 'spreadBonusMax',
            label: t('setupWizard.quotaPolicy.spreadBonus'),
            hint: t('setupWizard.quotaPolicy.spreadBonusHint'),
            placeholder: DISPLAY_DEFAULTS.spreadBonusMax,
            unit: '',
        },
        {
            key: 'sessionAxisWeeklyHeadroomPercent',
            label: t('setupWizard.quotaPolicy.sessionAxisWeeklyHeadroom'),
            hint: t('setupWizard.quotaPolicy.sessionAxisWeeklyHeadroomHint'),
            placeholder: DISPLAY_DEFAULTS.sessionAxisWeeklyHeadroomPercent,
            unit: '%',
        },
    ]

    return (
        <div className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.quotaPolicy.title')}</h3>
                <p className="mt-1 text-2xs leading-relaxed text-text-muted">
                    {t('setupWizard.quotaPolicy.description')}
                </p>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {fields.map(f => {
                    const fieldError = errors[f.key]
                    return (
                        <label key={f.key} className="flex flex-col gap-1">
                            <span className="text-2xs text-text-muted">
                                {f.label}{f.unit ? ` (${f.unit})` : ''}
                            </span>
                            <input
                                type="number"
                                inputMode="decimal"
                                className={fieldError ? errorInputCls : inputCls}
                                value={draft[f.key]}
                                placeholder={String(f.placeholder)}
                                onChange={e => update(f.key, e.target.value)}
                            />
                            <span className={`text-3xs leading-snug ${fieldError ? 'text-red-400' : 'text-text-muted'}`}>
                                {fieldError ? t(`setupWizard.quotaPolicy.errors.${fieldError}`) : f.hint}
                            </span>
                        </label>
                    )
                })}
            </div>

            <p className="text-3xs leading-relaxed text-text-muted">
                {t('setupWizard.quotaPolicy.blankMeansDefault')}
            </p>

            {error ? (
                <p className="text-2xs text-red-400">{error}</p>
            ) : null}

            <div className="flex items-center gap-2">
                <button type="button" className="btn btn-secondary btn-sm" onClick={resetToDefaults}>
                    {t('setupWizard.quotaPolicy.useDefaults')}
                </button>
                <button
                    type="button"
                    className="btn btn-primary btn-sm ml-auto"
                    onClick={save}
                    disabled={!!saving || hasErrors || !dirty}
                >
                    {saving ? t('setupWizard.quotaPolicy.saving') : t('setupWizard.quotaPolicy.save')}
                </button>
            </div>
        </div>
    )
}

/**
 * Normalize the incoming policy the same way the draft round-trip does, so the
 * dirty check compares like with like (an incoming `{}` and a fully blank form
 * must read as clean).
 */
function policyToOverrides(policy: RepoMeshQuotaRoutingPolicy | null | undefined): RepoMeshQuotaRoutingPolicy {
    return quotaPolicyDraftToOverrides(policyToDraft(policy))
}
