/**
 * Quota reserve — how much of this machine's AI-plan quota automatic work
 * must leave for the person (design 2026-11-01-machine-quota-reserve §7).
 *
 * One machine-wide setting replaces the per-mesh thresholds and the review
 * constant: mesh routing, auto-launch, direct dispatch and idle assistant
 * review turns all judge THIS machine's quota by these numbers. Manual chat
 * and coordinator launches are never blocked — a provider under its reserve
 * only shows the "within reserve" state here and on the quota chips.
 *
 * Reads `quota_reserve_get` on mount; every field saves on blur through
 * `quota_reserve_set` (owner-only on the daemon; a refusal is shown inline).
 * Hidden entirely on a daemon without the verb. Per-account overrides appear
 * only for a provider with >= 2 known accounts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Card from '../../components/Card'
import { InfoTip } from '../../components/ui/InfoTip'
import { quotaProviderLabel } from '../../utils/quota-format'
import {
    RESERVE_DISPLAY_DEFAULTS,
    accountSuffix,
    buildReserveSetArgs,
    composeScopePolicy,
    fieldToDraft,
    parseQuotaReserveRead,
    parseQuotaReserveSet,
    providersWithMultipleAccounts,
    storedPolicyFor,
    validateReserveDraft,
    type ReserveField,
    type ReserveRow,
    type ReserveScopeTarget,
    type ReserveView,
} from './quotaReserve'

interface QuotaReserveCardProps {
    machineId: string
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

const inputCls = 'w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'
const errorInputCls = 'w-full rounded-lg border border-red-500/60 bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'

function fieldLabelKey(field: ReserveField): string {
    return `machine.quotaReserve.fields.${field}`
}

/** One numeric input; commits its scope's full policy on blur / Enter. */
function ReserveInput({ testId, field, stored, placeholder, onCommit, disabled }: {
    testId: string
    field: ReserveField
    stored: number | undefined
    placeholder: number
    onCommit: (field: ReserveField, raw: string) => void
    disabled?: boolean
}) {
    const { t } = useTranslation('common')
    const incoming = fieldToDraft(field, stored)
    const [draft, setDraft] = useState(incoming)
    const [editing, setEditing] = useState(false)
    useEffect(() => { if (!editing) setDraft(incoming) }, [incoming, editing])
    const error = validateReserveDraft(field, draft)
    const commit = () => {
        setEditing(false)
        if (error || draft.trim() === incoming) return
        onCommit(field, draft)
    }
    const shownPlaceholder = field === 'routingSessionResetImminentMs' ? placeholder / 60000 : placeholder
    return (
        <div className="flex flex-col gap-1">
            <span className="text-2xs text-text-muted">
                <label htmlFor={testId}>
                    {t(fieldLabelKey(field))} ({field === 'routingSessionResetImminentMs' ? t('machine.quotaReserve.minutes') : '%'})
                </label>
            </span>
            <input
                id={testId}
                data-testid={testId}
                type="number"
                inputMode="decimal"
                className={error ? errorInputCls : inputCls}
                value={draft}
                placeholder={String(shownPlaceholder)}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                onChange={e => { setEditing(true); setDraft(e.target.value) }}
                onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') commit() }}
            />
            {error && <span className="text-3xs text-red-400">{t(`machine.quotaReserve.errors.${error}`)}</span>}
        </div>
    )
}

/** Remaining bar with a tick at the routing floor. */
function ReserveBar({ remaining, reserve, within }: { remaining: number | null; reserve: number; within: boolean }) {
    const pct = remaining === null ? 0 : Math.max(0, Math.min(100, remaining))
    return (
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/10" role="img" data-testid="quota-reserve-bar" data-within={within ? 'true' : 'false'}>
            <div className={`h-full ${within ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
            <div className="absolute top-0 h-full w-px bg-text-primary" style={{ left: `${Math.max(0, Math.min(100, reserve))}%` }} />
        </div>
    )
}

export default function QuotaReserveCard({ machineId, sendDaemonCommand }: QuotaReserveCardProps) {
    const { t } = useTranslation('common')
    const [view, setView] = useState<ReserveView | null>(null)
    const [state, setState] = useState<'loading' | 'ready' | 'unsupported' | 'error'>('loading')
    const [message, setMessage] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        if (!machineId) return
        try {
            const read = parseQuotaReserveRead(await sendDaemonCommand(machineId, 'quota_reserve_get', {}))
            if (read.kind === 'ok') { setView(read.view); setState('ready'); setMessage(null) }
            else if (read.kind === 'unsupported') setState('unsupported')
            else { setState('error'); setMessage(read.message) }
        } catch (e) {
            setState('error'); setMessage(e instanceof Error ? e.message : String(e))
        }
    }, [machineId, sendDaemonCommand])
    useEffect(() => { void load() }, [load])

    const commit = useCallback(async (target: ReserveScopeTarget, field: ReserveField, raw: string) => {
        if (!view) return
        const policy = composeScopePolicy(storedPolicyFor(view.raw, target), field, raw)
        setSaving(true)
        try {
            const result = parseQuotaReserveSet(await sendDaemonCommand(machineId, 'quota_reserve_set', buildReserveSetArgs(target, policy)))
            if (result.ok) { setView(result.view); setMessage(null) }
            else setMessage((result as { message: string }).message)
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e))
        } finally {
            setSaving(false)
        }
    }, [machineId, sendDaemonCommand, view])

    const resetScope = useCallback(async (target: ReserveScopeTarget) => {
        setSaving(true)
        try {
            const result = parseQuotaReserveSet(await sendDaemonCommand(machineId, 'quota_reserve_set', { ...target, policy: null }))
            if (result.ok) { setView(result.view); setMessage(null) } else setMessage((result as { message: string }).message)
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e))
        } finally {
            setSaving(false)
        }
    }, [machineId, sendDaemonCommand])

    const multiAccountProviders = useMemo(() => view ? providersWithMultipleAccounts(view.accounts) : [], [view])

    if (state === 'unsupported' || state === 'loading') return null
    if (state === 'error' || !view) {
        return (
            <Card padding="lg" className="mb-5">
                <p className="text-xs text-red-400" data-testid="quota-reserve-error">{t('machine.quotaReserve.loadFailed', { error: message ?? '' })}</p>
            </Card>
        )
    }

    const defaultsTarget: ReserveScopeTarget = { scope: 'defaults' }
    const storedDefaults = storedPolicyFor(view.raw, defaultsTarget)
    const migration = view.raw?.migration
    const rows = view.rows.filter(r => r.remaining.tightest !== null || storedPolicyFor(view.raw, { scope: 'pool', key: r.poolKey }))

    return (
        <Card padding="lg" className="mb-5" data-testid="quota-reserve-card">
            <div className="mb-1 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-text-muted">
                {t('machine.quotaReserve.title')}
                <InfoTip content={t('machine.quotaReserve.usedBy')} size={12} />
            </div>
            <p className="mb-3 text-xs text-text-secondary">{t('machine.quotaReserve.subtitle')}</p>

            {migration && (
                <p className="mb-3 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-2xs text-text-muted" data-testid="quota-reserve-migration">
                    {t('machine.quotaReserve.migrated', { count: migration.fromMeshes.length })}
                </p>
            )}

            <div className="mb-1 text-xs font-medium text-text-primary">{t('machine.quotaReserve.machineDefault')}</div>
            <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {(['routingSessionMinPercent', 'routingLongMinPercent', 'routingSessionResetImminentMs', 'assistantReviewMinPercent'] as ReserveField[]).map(field => (
                    <ReserveInput
                        key={field}
                        testId={`quota-reserve-defaults-${field}`}
                        field={field}
                        stored={storedDefaults?.[field]}
                        placeholder={RESERVE_DISPLAY_DEFAULTS[field]}
                        disabled={saving}
                        onCommit={(f, raw) => void commit(defaultsTarget, f, raw)}
                    />
                ))}
            </div>

            {rows.length > 0 && (
                <div className="flex flex-col gap-3">
                    <div className="text-xs font-medium text-text-primary">{t('machine.quotaReserve.perProvider')}</div>
                    {rows.map(row => <ProviderRow key={row.poolKey} row={row} view={view} saving={saving} commit={commit} resetScope={resetScope} />)}
                </div>
            )}

            {multiAccountProviders.map(provider => (
                <details key={provider} className="mt-3 rounded-lg border border-border-subtle px-3 py-2" data-testid={`quota-reserve-accounts-${provider}`}>
                    <summary className="cursor-pointer text-xs text-text-secondary">
                        {t('machine.quotaReserve.accountOverrides', { provider: quotaProviderLabel(provider) })}
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                        {view.accounts[provider].map(accountKey => {
                            const target: ReserveScopeTarget = { scope: 'account', key: provider, accountKey }
                            const stored = storedPolicyFor(view.raw, target)
                            return (
                                <div key={accountKey} className="grid grid-cols-2 gap-2">
                                    <div className="col-span-2 text-2xs text-text-muted">{t('machine.quotaReserve.accountLabel', { suffix: accountSuffix(accountKey) })}</div>
                                    {(['routingSessionMinPercent', 'routingLongMinPercent'] as ReserveField[]).map(field => (
                                        <ReserveInput
                                            key={field}
                                            testId={`quota-reserve-account-${accountKey.slice(-8)}-${field}`}
                                            field={field}
                                            stored={stored?.[field]}
                                            placeholder={RESERVE_DISPLAY_DEFAULTS[field]}
                                            disabled={saving}
                                            onCommit={(f, raw) => void commit(target, f, raw)}
                                        />
                                    ))}
                                </div>
                            )
                        })}
                    </div>
                </details>
            ))}

            {message && <p className="mt-3 text-2xs text-red-400" data-testid="quota-reserve-set-error">{message}</p>}
            <p className="mt-3 text-3xs text-text-muted">{saving ? t('machine.quotaReserve.saving') : t('machine.quotaReserve.blankMeansDefault')}</p>
        </Card>
    )
}

function ProviderRow({ row, view, saving, commit, resetScope }: {
    row: ReserveRow
    view: ReserveView
    saving: boolean
    commit: (target: ReserveScopeTarget, field: ReserveField, raw: string) => Promise<void>
    resetScope: (target: ReserveScopeTarget) => Promise<void>
}) {
    const { t } = useTranslation('common')
    const target: ReserveScopeTarget = { scope: 'pool', key: row.poolKey }
    const stored = storedPolicyFor(view.raw, target)
    const name = row.pool ? `${quotaProviderLabel(row.provider)} · ${row.pool}` : quotaProviderLabel(row.provider)
    const reserve = row.withinReserveWindow === 'long' ? row.policy.routingLongMinPercent : row.policy.routingSessionMinPercent
    return (
        <div className="rounded-lg border border-border-subtle p-3" data-testid={`quota-reserve-row-${row.poolKey}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="min-w-[92px] text-xs text-text-primary">{name}</span>
                {row.withinReserve ? (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-3xs text-amber-500" data-testid="quota-reserve-within">
                        {t('machine.quotaReserve.withinReserve', { remaining: row.remaining.tightest ?? 0, reserve })}
                    </span>
                ) : row.remaining.tightest !== null ? (
                    <span className="text-3xs text-text-muted">{t('machine.quotaReserve.remaining', { remaining: row.remaining.tightest })}</span>
                ) : (
                    <span className="text-3xs text-text-muted">{t('machine.quotaReserve.noReading')}</span>
                )}
                {stored && (
                    <button type="button" className="ml-auto text-3xs text-text-secondary underline" disabled={saving} onClick={() => void resetScope(target)}>
                        {t('machine.quotaReserve.resetRow')}
                    </button>
                )}
            </div>
            <ReserveBar remaining={row.remaining.tightest} reserve={reserve} within={row.withinReserve} />
            <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                {(['routingSessionMinPercent', 'routingLongMinPercent', 'assistantReviewMinPercent'] as ReserveField[]).map(field => (
                    <ReserveInput
                        key={field}
                        testId={`quota-reserve-${row.poolKey}-${field}`}
                        field={field}
                        stored={stored?.[field]}
                        placeholder={row.policy[field]}
                        disabled={saving}
                        onCommit={(f, raw) => void commit(target, f, raw)}
                    />
                ))}
            </div>
        </div>
    )
}
