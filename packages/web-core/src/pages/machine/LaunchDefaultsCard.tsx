/**
 * Launch defaults — which CLI (and optional model / thinking level) this
 * machine starts new assistant and coordinator sessions with.
 *
 * Reads `launch_defaults_get` once on mount (and after each write), writes via
 * `launch_defaults_set` with the read's document revision as the CAS token.
 * A role whose saved default no longer works still shows the saved value plus
 * the daemon's reason, so the owner can pick another CLI or clear it.
 * Hidden entirely when the daemon has no such verb (older daemon).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LaunchDefaultRole } from '@adhdev/mesh-shared'
import Card from '../../components/Card'
import { InfoTip } from '../../components/ui/InfoTip'
import type { ProviderInfo } from './types'
import { modelOptionsForProvider, thinkingOptionsForProvider } from '../../utils/provider-priority'
import {
    LAUNCH_DEFAULT_ROLE_ORDER,
    buildLaunchDefaultsSetArgs,
    formatLaunchSelection,
    parseLaunchDefaultsRead,
    parseLaunchDefaultsSetResult,
    type LaunchDefaultRoleState,
    type LaunchDefaultSelectionView,
    type LaunchDefaultsRead,
} from './launchDefaults'

interface LaunchDefaultsCardProps {
    machineId: string
    providers: ProviderInfo[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

type Outcome = { ok: true } | { ok: false; code: string }

export default function LaunchDefaultsCard({ machineId, providers, sendDaemonCommand }: LaunchDefaultsCardProps) {
    const { t } = useTranslation('common')
    const [read, setRead] = useState<LaunchDefaultsRead | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [savingRole, setSavingRole] = useState<LaunchDefaultRole | null>(null)
    const [outcomes, setOutcomes] = useState<Partial<Record<LaunchDefaultRole, Outcome>>>({})

    const load = useCallback(async () => {
        if (!machineId) return
        try {
            setRead(parseLaunchDefaultsRead(await sendDaemonCommand(machineId, 'launch_defaults_get', {})))
            setLoadError(null)
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : String(e))
        }
    }, [machineId, sendDaemonCommand])

    useEffect(() => { void load() }, [load])

    const cliTypes = useMemo(() => providers.filter(p => p.category === 'cli')
        .map(p => ({ type: p.type, label: p.displayName || p.name || p.type }))
        .sort((a, b) => a.label.localeCompare(b.label)), [providers])

    const write = useCallback(async (role: LaunchDefaultRole, draft: LaunchDefaultSelectionView | null) => {
        if (!machineId || read?.kind !== 'ok') return
        setSavingRole(role)
        let outcome: Outcome
        try {
            outcome = parseLaunchDefaultsSetResult(await sendDaemonCommand(machineId, 'launch_defaults_set',
                buildLaunchDefaultsSetArgs(role, read.state.documentRevision, draft)))
        } catch (e) {
            outcome = { ok: false, code: e instanceof Error ? e.message : String(e) }
        }
        setOutcomes(prev => ({ ...prev, [role]: outcome }))
        setSavingRole(null)
        // Re-read either way: success moves the revision, a conflict shows the current value.
        await load()
    }, [machineId, read, sendDaemonCommand, load])

    if (read?.kind === 'unsupported' || (!read && !loadError)) return null

    return (
        <Card padding="none" className="px-4.5 py-3.5" data-testid="launch-defaults-card">
            <div className="mb-2.5 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-accent-primary">
                {t('machine.launchDefaults.title')}
                <InfoTip content={t('machine.launchDefaults.description')} size={12} />
            </div>
            {loadError && <div className="text-2xs text-status-error">{t('machine.launchDefaults.loadFailed', { error: loadError })}</div>}
            {read?.kind === 'error' && <div className="text-2xs text-status-error">{t('machine.launchDefaults.loadFailed', { error: read.code })}</div>}
            {read?.kind === 'ok' && (
                <div className="flex flex-col gap-3">
                    {LAUNCH_DEFAULT_ROLE_ORDER.map(role => (
                        <LaunchDefaultRoleRow
                            key={role}
                            role={role}
                            state={read.state.roles[role]}
                            cliTypes={cliTypes}
                            providers={providers}
                            saving={savingRole === role}
                            outcome={outcomes[role]}
                            onSave={draft => void write(role, draft)}
                            onClear={() => void write(role, null)}
                        />
                    ))}
                </div>
            )}
        </Card>
    )
}

/**
 * Model / thinking level: the selected CLI's advertised options as a dropdown,
 * first entry "provider default". A saved value the list does not contain stays
 * selectable (so it is visible); a CLI that advertises nothing keeps a text box.
 */
function OptionField({ field, label, value, options, onChange }: {
    field: 'model' | 'thinkingLevel'
    label: string
    value: string
    options: string[]
    onChange: (value: string) => void
}) {
    const { t } = useTranslation('common')
    const list = value && !options.includes(value) ? [...options, value] : options
    return (
        <label className="flex flex-col gap-1 text-2xs text-text-secondary">
            <span className="font-medium text-text-primary">{label}</span>
            {options.length > 0 ? (
                <select value={value} onChange={e => onChange(e.target.value)} className="machine-input text-2xs" data-launch-default-field={field}>
                    <option value="">{t('machine.launchDefaults.providerDefault')}</option>
                    {list.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
            ) : (
                <input type="text" value={value} onChange={e => onChange(e.target.value)}
                    placeholder={t('machine.launchDefaults.providerDefault')} className="machine-input text-2xs" data-launch-default-field={field} />
            )}
        </label>
    )
}

function LaunchDefaultRoleRow({ role, state, cliTypes, providers, saving, outcome, onSave, onClear }: {
    role: LaunchDefaultRole
    state: LaunchDefaultRoleState | undefined
    cliTypes: Array<{ type: string; label: string }>
    providers: ProviderInfo[]
    saving: boolean
    outcome?: Outcome
    onSave: (draft: LaunchDefaultSelectionView) => void
    onClear: () => void
}) {
    const { t } = useTranslation('common')
    const stored = state?.stored ?? null
    const [provider, setProvider] = useState(stored?.provider ?? '')
    const [model, setModel] = useState(stored?.model ?? '')
    const [thinkingLevel, setThinkingLevel] = useState(stored?.thinkingLevel ?? '')
    // Follow the saved value when it changes (after a write or another dashboard's edit).
    const storedKey = stored ? formatLaunchSelection(stored) : ''
    useEffect(() => {
        setProvider(stored?.provider ?? '')
        setModel(stored?.model ?? '')
        setThinkingLevel(stored?.thinkingLevel ?? '')
    }, [storedKey]) // eslint-disable-line react-hooks/exhaustive-deps

    const modelOptions = useMemo(() => modelOptionsForProvider(providers, provider), [providers, provider])
    const thinkingOptions = useMemo(() => thinkingOptionsForProvider(providers, provider), [providers, provider])
    // Switching CLI drops a model / level the new CLI does not offer.
    const changeProvider = (next: string) => {
        setProvider(next)
        const nextModels = modelOptionsForProvider(providers, next)
        const nextLevels = thinkingOptionsForProvider(providers, next)
        if (model && nextModels.length > 0 && !nextModels.includes(model)) setModel('')
        if (thinkingLevel && nextLevels.length > 0 && !nextLevels.includes(thinkingLevel)) setThinkingLevel('')
    }

    // A saved provider that is no longer listed stays selectable, so it is visible.
    const options = stored && !cliTypes.some(c => c.type === stored.provider)
        ? [...cliTypes, { type: stored.provider, label: stored.provider }]
        : cliTypes
    const effective = state?.effective
    const ready = effective && 'selection' in effective ? effective.selection : null
    const failure = effective && 'code' in effective ? effective : null
    const unset = !stored && failure?.code === 'launch_default_required'
    const failedCode = outcome && 'code' in outcome ? outcome.code : null

    return (
        <div className="flex flex-col gap-1.5" data-launch-default-role={role}>
            <div className="flex flex-wrap items-baseline gap-2 text-2xs">
                <span className="font-semibold text-text-primary">{t(`machine.launchDefaults.role.${role}`)}</span>
                {unset && <span className="text-text-muted" data-launch-default-status="unset">{t('machine.launchDefaults.notSet')}</span>}
                {ready && (
                    <span className="font-mono text-text-secondary" data-launch-default-status="ok">
                        {t('machine.launchDefaults.nextLaunch', { selection: formatLaunchSelection(ready) })}
                    </span>
                )}
                {failure && !unset && (
                    <span className="text-status-error" data-launch-default-status={failure.code}>
                        {t('machine.launchDefaults.unusable', { code: failure.code, reason: failure.reason || '—' })}
                    </span>
                )}
            </div>
            <div className="grid gap-2 items-end md:grid-cols-[minmax(140px,1fr)_minmax(110px,1fr)_minmax(110px,1fr)_auto]">
                <label className="flex flex-col gap-1 text-2xs text-text-secondary">
                    <span className="font-medium text-text-primary">{t('machine.launchDefaults.provider')}</span>
                    <select value={provider} onChange={e => changeProvider(e.target.value)} className="machine-input text-2xs" data-launch-default-field="provider">
                        <option value="">{t('machine.launchDefaults.chooseProvider')}</option>
                        {options.map(c => <option key={c.type} value={c.type}>{c.label}</option>)}
                    </select>
                </label>
                <OptionField field="model" label={t('machine.launchDefaults.model')} value={model} options={modelOptions} onChange={setModel} />
                <OptionField field="thinkingLevel" label={t('machine.launchDefaults.thinking')} value={thinkingLevel} options={thinkingOptions} onChange={setThinkingLevel} />
                <div className="flex gap-1">
                    <button
                        type="button"
                        disabled={saving || !provider}
                        onClick={() => onSave({ provider, model, thinkingLevel })}
                        className="machine-btn text-3xs bg-accent-primary/[0.08] border-accent-primary/20 text-accent-primary hover:bg-accent-primary/[0.14]"
                        data-launch-default-action="save"
                    >{t('machine.launchDefaults.save')}</button>
                    <button
                        type="button"
                        disabled={saving || !stored}
                        onClick={onClear}
                        className="machine-btn text-3xs"
                        data-launch-default-action="clear"
                    >{t('machine.launchDefaults.clear')}</button>
                </div>
            </div>
            {outcome && (
                <div className={failedCode ? 'text-2xs text-status-error' : 'text-2xs text-text-muted'} data-launch-default-outcome={failedCode ?? 'ok'}>
                    {failedCode === 'COMMAND_SOURCE_REJECTED'
                        // A password-less standalone dashboard is trusted only as a local client,
                        // so owner-only writes are refused there by design; say what to do instead.
                        ? t('machine.launchDefaults.ownerRequired')
                        : failedCode ? t('machine.launchDefaults.saveFailed', { code: failedCode }) : t('machine.launchDefaults.saved')}
                </div>
            )}
        </div>
    )
}
