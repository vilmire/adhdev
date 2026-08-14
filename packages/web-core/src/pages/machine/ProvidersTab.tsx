/**
 * ProvidersTab — Dynamic provider settings with filter and inline editing.
 * Now includes Auto-Fix (AI agent script implementation) and Clone Provider modals.
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderSettingsEntry, ProviderInfo } from './types'
import { QUOTA_SUPPORTED_PROVIDERS, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'

/**
 * Providers whose quota actually carries an account label. Only codex reports
 * one today (via its own `account/read`); Claude Code exposes no account and
 * kimi's token holds an opaque id, so offering the switch there would promise
 * something those providers cannot deliver.
 */
const QUOTA_ACCOUNT_PROVIDERS = new Set(['codex-cli'])

/**
 * Providers with a shipped quota fetcher. Derived from the mesh-shared list
 * rather than re-listed here: this used to be a hand-copied literal of
 * daemon-core's REFRESHERS, which is precisely the copy that can drift out of
 * step with the fetchers. A drift gate pins the shared list to REFRESHERS
 * (daemon-core test/quota/quota-supported-providers-drift.test.ts).
 */
const QUOTA_PROVIDERS = new Set(QUOTA_SUPPORTED_PROVIDERS)
import { buildProviderSettingsEntries, extractProviderSettingsPayload } from './providerSettings'
import { extractProviderSourceConfigPayload, normalizeProviderDirInput, type ProviderSourceConfigPayload } from './providerSourceConfig'
import ProviderCloneModal from './ProviderCloneModal'
import ProviderInstallOptionsModal from './ProviderInstallOptionsModal'
import InstalledProviderRow, { type ProviderPinInfo } from './InstalledProviderRow'
import Card from '../../components/Card'
import SourcesPanel from './SourcesPanel'

interface ProvidersTabProps {
    machineId: string
    providers: ProviderInfo[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    /** Machine plan quota (MachineInfo.quota) — rendered per provider row. */
    quota?: Record<string, MeshNodeFactsProviderQuota>
}

export default function ProvidersTab({ machineId, providers, sendDaemonCommand, quota }: ProvidersTabProps) {
    const { t } = useTranslation('common')
    const [settings, setSettings] = useState<ProviderSettingsEntry[]>([])
    // Quota account label — machine-level config, so it has its own read/write
    // pair (get/set_quota_account_label) rather than riding the provider-manifest
    // settings payload. Rendered on the provider whose quota carries the label.
    const [quotaAccountLabel, setQuotaAccountLabel] = useState<boolean | undefined>(undefined)
    // Per-provider quota probe switch — machine-level config like the account
    // label, so it rides its own get/set_quota_provider_enabled pair. Keys are
    // QUOTA_PROVIDERS members; a missing key renders as ON (absent = enabled).
    const [quotaEnabled, setQuotaEnabled] = useState<Record<string, boolean>>({})
    const [pins, setPins] = useState<Record<string, ProviderPinInfo>>({})
    // Verified-channel types never activated/installed on this machine (kimi class).
    const [channelNewTypes, setChannelNewTypes] = useState<string[]>([])
    const [installingNewType, setInstallingNewType] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [filter, setFilter] = useState<'all' | 'acp' | 'cli' | 'ide' | 'extension'>('cli')
    const [showClone, setShowClone] = useState(false)
    // Provider type whose install-options modal is open, or null. Set when a
    // provider is switched ON; nothing is persisted until it is confirmed.
    const [installOptionsFor, setInstallOptionsFor] = useState<string | null>(null)
    const [showSources, setShowSources] = useState(false)
    const [showSourceConfig, setShowSourceConfig] = useState(false)
    const [sourceConfig, setSourceConfig] = useState<ProviderSourceConfigPayload | null>(null)
    const [sourceModeInput, setSourceModeInput] = useState<'normal' | 'no-upstream'>('normal')
    const [providerDirInput, setProviderDirInput] = useState('')
    const [sourceSaving, setSourceSaving] = useState(false)

    const fetchSourceConfig = useCallback(async () => {
        if (!machineId) return
        try {
            const res = await sendDaemonCommand(machineId, 'get_provider_source_config', {})
            const payload = extractProviderSourceConfigPayload(res)
            if (payload) {
                setSourceConfig(payload)
                setSourceModeInput(payload.sourceMode)
                setProviderDirInput(payload.explicitProviderDir || '')
            }
        } catch { }
    }, [machineId, sendDaemonCommand])

    const fetchSettings = useCallback(async () => {
        if (!machineId) return
        setLoading(true)
        try {
            const res = await sendDaemonCommand(machineId, 'get_provider_settings', {})
            const payload = extractProviderSettingsPayload(res)
            if (payload) {
                const entries: ProviderSettingsEntry[] = buildProviderSettingsEntries(payload, providers, {
                    filterSchema: (schema) => schema.filter((setting) => setting.key !== 'enabled'),
                })
                entries.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName))
                setSettings(entries)
            }
        } catch { }
        setLoading(false)
    }, [machineId, providers, sendDaemonCommand])

    const fetchQuotaAccountLabel = useCallback(async () => {
        if (!machineId) return
        try {
            const res = await sendDaemonCommand(machineId, 'get_quota_account_label', {})
            // Standalone returns the raw response, cloud wraps it as
            // { success, result } — accept both, as the transport docs require.
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { enabled?: unknown } | undefined
            if (typeof body?.enabled === 'boolean') setQuotaAccountLabel(body.enabled)
        } catch { /* leave undefined — the toggle stays hidden rather than lying */ }
    }, [machineId, sendDaemonCommand])

    const handleQuotaAccountLabelToggle = useCallback(async (enabled: boolean) => {
        if (!machineId) return
        setQuotaAccountLabel(enabled) // optimistic: the switch responds immediately
        try {
            await sendDaemonCommand(machineId, 'set_quota_account_label', { enabled })
        } finally {
            // Reconcile with what the daemon actually stored.
            await fetchQuotaAccountLabel()
        }
    }, [machineId, sendDaemonCommand, fetchQuotaAccountLabel])

    const fetchQuotaEnabled = useCallback(async () => {
        if (!machineId) return
        await Promise.all([...QUOTA_PROVIDERS].map(async (providerType) => {
            try {
                const res = await sendDaemonCommand(machineId, 'get_quota_provider_enabled', { providerType })
                // Standalone returns the raw response, cloud wraps it as
                // { success, result } — accept both, as the transport docs require.
                const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { enabled?: unknown } | undefined
                if (typeof body?.enabled === 'boolean') {
                    setQuotaEnabled(prev => ({ ...prev, [providerType]: body.enabled as boolean }))
                }
            } catch { /* leave unset — renders as ON, which is also the config default */ }
        }))
    }, [machineId, sendDaemonCommand])

    const handleQuotaToggle = useCallback(async (providerType: string, enabled: boolean) => {
        if (!machineId) return
        setQuotaEnabled(prev => ({ ...prev, [providerType]: enabled })) // optimistic: the switch responds immediately
        try {
            const res = await sendDaemonCommand(machineId, 'set_quota_provider_enabled', { providerType, enabled })
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { success?: boolean; error?: unknown } | undefined
            if (body?.success === false && typeof body.error === 'string') console.warn(`set_quota_provider_enabled failed: ${body.error}`)
        } finally {
            // Reconcile with what the daemon actually stored.
            await fetchQuotaEnabled()
        }
    }, [machineId, sendDaemonCommand, fetchQuotaEnabled])

    /**
     * Verified-channel pins + what the channel currently offers.
     *
     * `check_provider_updates` is READ-ONLY (it reports; it does not activate),
     * so it is safe to call on mount. Activation is a separate explicit
     * command behind a button.
     */
    const fetchPins = useCallback(async () => {
        if (!machineId) return
        try {
            const res = await sendDaemonCommand(machineId, 'check_provider_updates', {})
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as
                { providers?: Array<Record<string, any>>; channelStaleness?: { newTypes?: string[] } } | undefined
            const next: Record<string, ProviderPinInfo> = {}
            for (const row of body?.providers ?? []) {
                if (typeof row?.type !== 'string') continue
                next[row.type] = {
                    activeVersion: row.activeVersion ?? null,
                    latestVersion: row.latestVersion ?? null,
                    stale: row.stale === true,
                    digest: row.digest ?? null,
                    activatedAt: row.activatedAt ?? null,
                    previousVersion: row.previousVersion ?? null,
                }
            }
            setPins(next)
            // Channel types this machine has never activated nor installed —
            // the kimi class: without this list there is NO dashboard path to
            // install a type first published after bootstrap.
            setChannelNewTypes(Array.isArray(body?.channelStaleness?.newTypes) ? body.channelStaleness.newTypes : [])
        } catch { /* leave empty — rows then show no pin rather than a wrong one */ }
    }, [machineId, sendDaemonCommand])

    const handleInstallNewType = useCallback(async (providerType: string) => {
        if (!machineId) return
        setInstallingNewType(providerType)
        try {
            // activate_provider_updates {types} unions the never-activated type
            // into the verified-channel sync target set (digest-verified,
            // atomic pointer flip — same machinery as updates).
            await sendDaemonCommand(machineId, 'activate_provider_updates', { types: [providerType] })
        } finally {
            setInstallingNewType(null)
            await fetchPins()
            await fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins])

    const handleActivatePins = useCallback(async () => {
        if (!machineId) return
        try {
            await sendDaemonCommand(machineId, 'activate_provider_updates', {})
        } finally {
            // Report what actually moved, not what we hoped would.
            await fetchPins()
            await fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins])

    const handleRollbackPin = useCallback(async (providerType: string) => {
        if (!machineId) return
        try {
            await sendDaemonCommand(machineId, 'rollback_provider_update', { providerType })
        } finally {
            await fetchPins()
            await fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins])

    useEffect(() => {
        if (settings.length === 0) fetchSettings()
        if (!sourceConfig) fetchSourceConfig()
        if (quotaAccountLabel === undefined) fetchQuotaAccountLabel()
        fetchQuotaEnabled()
        fetchPins()
    }, [])

    const handleSetSetting = async (providerType: string, key: string, value: unknown) => {
        setSavingKey(`${providerType}.${key}`)
        // Optimistic update
        setSettings(prev => prev.map(p =>
            p.type === providerType ? { ...p, values: { ...p.values, [key]: value } } : p
        ))
        try {
            const res = await sendDaemonCommand(machineId, 'set_provider_setting', { providerType, key, value })
            if (!res?.success) fetchSettings()
        } catch {
            fetchSettings()
        }
        setSavingKey(null)
    }

    /**
     * Enabling a provider is the INSTALL moment, so it asks for the two options
     * that were previously only discoverable after the fact — quota tracking
     * and auto-approve. Disabling never asks: there is nothing to configure
     * about a provider being turned off.
     *
     * Nothing is written until the modal is confirmed, including the enable
     * itself. Cancelling therefore leaves the provider disabled, which is what
     * a cancelled install should mean — a half-applied state (enabled, options
     * skipped) would be the worse outcome.
     */
    const handleMachineProviderEnable = async (providerType: string, enabled: boolean) => {
        if (enabled) {
            setInstallOptionsFor(providerType)
            return
        }
        await handleSetSetting(providerType, 'enabled', false)
        await fetchSettings()
    }

    /**
     * Apply the confirmed install options, THEN enable.
     *
     * Order matters: `enabled` is what makes the provider claimable and
     * launchable, so writing the options first means there is no window in
     * which the provider is live under defaults the user just declined.
     *
     * Each write goes through the same command the standing surfaces use, so
     * this stores nothing new — see ProviderInstallOptionsModal's header.
     */
    const handleInstallOptionsConfirm = useCallback(async (
        providerType: string,
        options: { quotaEnabled?: boolean; autoApprove: boolean },
    ) => {
        setInstallOptionsFor(null)
        setSavingKey(`${providerType}.enabled`)
        try {
            // Quota is only written when the provider actually supports it;
            // `undefined` means the modal never offered the row.
            if (options.quotaEnabled !== undefined) {
                await sendDaemonCommand(machineId, 'set_quota_provider_enabled', {
                    providerType,
                    enabled: options.quotaEnabled,
                })
            }
            // Written explicitly even when it matches the manifest default, so
            // the stored value records a choice the user actually made rather
            // than inheriting whatever the default later becomes.
            await sendDaemonCommand(machineId, 'set_provider_setting', {
                providerType,
                key: 'autoApprove',
                value: options.autoApprove,
            })
            await sendDaemonCommand(machineId, 'set_provider_setting', {
                providerType,
                key: 'enabled',
                value: true,
            })
        } finally {
            setSavingKey(null)
            await fetchSettings()
            await fetchQuotaEnabled()
        }
    }, [machineId, sendDaemonCommand, fetchSettings, fetchQuotaEnabled])

    const handleDetectProvider = async (providerType: string) => {
        setSavingKey(`${providerType}.detect`)
        try {
            await sendDaemonCommand(machineId, 'detect_provider', { providerType })
        } finally {
            await fetchSettings()
            setSavingKey(null)
        }
    }

    const handleResetProviderCommand = async (providerType: string) => {
        await handleSetSetting(providerType, 'executablePath', '')
        await handleSetSetting(providerType, 'executableArgs', '')
        await fetchSettings()
    }

    const handleApplySourceConfig = async () => {
        setSourceSaving(true)
        try {
            const res = await sendDaemonCommand(machineId, 'set_provider_source_config', {
                providerSourceMode: sourceModeInput,
                providerDir: normalizeProviderDirInput(providerDirInput),
            })
            const payload = extractProviderSourceConfigPayload(res)
            if (payload) {
                setSourceConfig(payload)
                setSourceModeInput(payload.sourceMode)
                setProviderDirInput(payload.explicitProviderDir || '')
            } else {
                await fetchSourceConfig()
            }
            await fetchSettings()
        } catch {
            await fetchSourceConfig()
        }
        setSourceSaving(false)
    }

    const filteredSettings = settings.filter(p => filter === 'all' || p.category === filter)

    return (
        <div className="flex flex-col gap-3">
            {/* Toolbar: filter + create + refresh + advanced toggle */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex gap-1 items-center">
                    <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mr-2">{t('machine.providers.filter')}</span>
                    {(['cli', 'ide', 'acp', 'extension', 'all'] as const).map(cat => (
                        <button
                            key={cat}
                            onClick={() => setFilter(cat)}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                filter === cat ? 'bg-accent-primary/15 border-accent-primary/40 text-accent-primary' : ''
                            }`}
                        >{cat.toUpperCase()}</button>
                    ))}
                </div>
                <div className="flex gap-1.5">
                    <button
                        onClick={() => setShowSources(v => !v)}
                        className={`machine-btn text-[10px] ${showSources ? 'bg-sky-500/[0.10] border-sky-500/30 text-sky-300' : ''}`}
                        title="Manage 3rd-party provider sources"
                    >{t('machine.providers.sources')}</button>
                    <button
                        onClick={() => setShowClone(true)}
                        className="machine-btn text-[10px]"
                        title="Create a new provider from an existing one"
                    >{t('machine.providers.create')}</button>
                    <button onClick={fetchSettings} disabled={loading} className="machine-btn text-[10px]">
                        {loading ? '⏳' : '↻'} {t('machine.providers.refresh')}
                    </button>
                    <button
                        onClick={() => setShowSourceConfig(v => !v)}
                        className="machine-btn text-[10px]"
                        title="Show source configuration (advanced)"
                    >{t('machine.providers.advanced')}</button>
                </div>
            </div>

            {/* Verified-channel types never installed on this machine (kimi
                class: first published AFTER this machine bootstrapped, so no
                pin, nothing in .upstream — invisible to every targeted sync
                and, before this section, uninstallable from the dashboard). */}
            {channelNewTypes.length > 0 && (
                <Card padding="none" className="px-4.5 py-3.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-accent-primary">{t('machine.providers.newChannelTypesTitle')}</div>
                    <div className="text-[11px] text-text-muted mt-1 mb-2.5">{t('machine.providers.newChannelTypesDesc')}</div>
                    <div className="flex flex-col gap-1.5">
                        {channelNewTypes.map((providerType) => (
                            <div key={providerType} className="flex items-center justify-between gap-3 text-[13px]">
                                <span className="font-mono text-text-primary">{providerType}</span>
                                <button
                                    onClick={() => { void handleInstallNewType(providerType) }}
                                    disabled={installingNewType !== null}
                                    className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25 disabled:opacity-50"
                                >
                                    {installingNewType === providerType ? '⏳' : t('machine.providers.installNewType')}
                                </button>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            {/* External provider sources (3rd-party git URLs) */}
            {showSources && (
                <SourcesPanel
                    machineId={machineId}
                    sendDaemonCommand={sendDaemonCommand}
                    onChange={() => { void fetchSettings() }}
                />
            )}

            {/* Advanced: provider source config (collapsed by default) */}
            {showSourceConfig && (
                <Card padding="none" className="px-4.5 py-3.5">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-accent-primary">{t('machine.providers.sourceConfigTitle')}</div>
                            <div className="text-[11px] text-text-muted mt-1">{t('machine.providers.sourceConfigDesc')}</div>
                        </div>
                        <button onClick={fetchSourceConfig} className="machine-btn text-[10px]">↻ Refresh</button>
                    </div>
                    <div className="grid md:grid-cols-[180px_1fr_auto] gap-3 items-end">
                        <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                            <span className="font-medium text-text-primary">{t('machine.providers.sourceMode')}</span>
                            <select
                                value={sourceModeInput}
                                onChange={e => setSourceModeInput(e.target.value as 'normal' | 'no-upstream')}
                                className="machine-input text-[11px]"
                            >
                                <option value="normal">normal</option>
                                <option value="no-upstream">no-upstream</option>
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                            <span className="font-medium text-text-primary">{t('machine.providers.explicitProviderDir')}</span>
                            <input
                                type="text"
                                value={providerDirInput}
                                onChange={e => setProviderDirInput(e.target.value)}
                                placeholder={t('machine.providers.providerDirPlaceholder')}
                                className="machine-input text-[11px]"
                            />
                        </label>
                        <button
                            onClick={() => void handleApplySourceConfig()}
                            disabled={sourceSaving}
                            className="machine-btn text-[10px] bg-accent-primary/[0.08] border-accent-primary/20 text-accent-primary hover:bg-accent-primary/[0.14]"
                        >{sourceSaving ? t('machine.providers.applying') : t('machine.providers.applyReload')}</button>
                    </div>
                    <div className="mt-3 grid gap-1 text-[10px] text-text-muted">
                        <div><span className="text-text-secondary font-medium">{t('machine.providers.userRoot')}</span> {sourceConfig?.userDir || '—'}</div>
                        <div><span className="text-text-secondary font-medium">{t('machine.providers.upstreamRoot')}</span> {sourceConfig?.upstreamDir || '—'}</div>
                        <div><span className="text-text-secondary font-medium">{t('machine.providers.providerRoots')}</span> {sourceConfig?.providerRoots?.join(' → ') || '—'}</div>
                    </div>
                </Card>
            )}

            {/* Installed providers list */}
            {loading && settings.length === 0 ? (
                <div className="p-10 text-center text-text-muted">{t('machine.providers.loadingSettings')}</div>
            ) : filteredSettings.length === 0 ? (
                <Card padding="none" className="px-4.5 py-8 text-center">
                    <div className="text-[12px] text-text-muted">
                        {filter === 'all'
                            ? t('machine.providers.noProviders')
                            : t('machine.providers.noFilteredProviders', { filter: filter.toUpperCase() })}
                    </div>
                </Card>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {filteredSettings.map(prov => (
                        <InstalledProviderRow
                            quota={quota?.[prov.type]}
                            key={prov.type}
                            prov={prov}
                            providerInfo={providers.find(p => p.type === prov.type)}
                            savingKey={savingKey}
                            onSetSetting={handleSetSetting}
                            onEnableToggle={handleMachineProviderEnable}
                            onDetect={handleDetectProvider}
                            onResetCommand={handleResetProviderCommand}
                            quotaAccountLabelEnabled={QUOTA_ACCOUNT_PROVIDERS.has(prov.type) ? quotaAccountLabel : undefined}
                            onQuotaAccountLabelToggle={QUOTA_ACCOUNT_PROVIDERS.has(prov.type) ? handleQuotaAccountLabelToggle : undefined}
                            quotaEnabled={QUOTA_PROVIDERS.has(prov.type) ? (quotaEnabled[prov.type] ?? true) : undefined}
                            onQuotaToggle={QUOTA_PROVIDERS.has(prov.type) ? handleQuotaToggle : undefined}
                            pin={pins[prov.type]}
                            onActivateUpdate={handleActivatePins}
                            onRollbackUpdate={() => handleRollbackPin(prov.type)}
                        />
                    ))}
                </div>
            )}

            {/* Modals */}
            {installOptionsFor && (
                <ProviderInstallOptionsModal
                    providerType={installOptionsFor}
                    displayName={settings.find(s => s.type === installOptionsFor)?.displayName || installOptionsFor}
                    supportsQuota={QUOTA_PROVIDERS.has(installOptionsFor)}
                    quotaInstallsClaudeStatusline={installOptionsFor === 'claude-cli'}
                    onCancel={() => setInstallOptionsFor(null)}
                    onConfirm={(options) => { void handleInstallOptionsConfirm(installOptionsFor, options) }}
                />
            )}
            {showClone && (
                <ProviderCloneModal
                    machineId={machineId}
                    providers={providers}
                    sendDaemonCommand={sendDaemonCommand}
                    onClose={() => setShowClone(false)}
                    onCreated={() => { setShowClone(false); fetchSettings(); }}
                />
            )}
        </div>
    )
}
