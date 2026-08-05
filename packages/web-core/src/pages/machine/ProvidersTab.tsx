/**
 * ProvidersTab — Dynamic provider settings with filter and inline editing.
 * Now includes Auto-Fix (AI agent script implementation) and Clone Provider modals.
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderSettingsEntry, ProviderInfo } from './types'

/**
 * Providers whose quota actually carries an account label. Only codex reports
 * one today (via its own `account/read`); Claude Code exposes no account and
 * kimi's token holds an opaque id, so offering the switch there would promise
 * something those providers cannot deliver.
 */
const QUOTA_ACCOUNT_PROVIDERS = new Set(['codex-cli'])
import { buildProviderSettingsEntries, extractProviderSettingsPayload } from './providerSettings'
import { extractProviderSourceConfigPayload, normalizeProviderDirInput, type ProviderSourceConfigPayload } from './providerSourceConfig'
import ProviderCloneModal from './ProviderCloneModal'
import InstalledProviderRow from './InstalledProviderRow'
import Card from '../../components/Card'
import SourcesPanel from './SourcesPanel'

interface ProvidersTabProps {
    machineId: string
    providers: ProviderInfo[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export default function ProvidersTab({ machineId, providers, sendDaemonCommand }: ProvidersTabProps) {
    const { t } = useTranslation('common')
    const [settings, setSettings] = useState<ProviderSettingsEntry[]>([])
    // Quota account label — machine-level config, so it has its own read/write
    // pair (get/set_quota_account_label) rather than riding the provider-manifest
    // settings payload. Rendered on the provider whose quota carries the label.
    const [quotaAccountLabel, setQuotaAccountLabel] = useState<boolean | undefined>(undefined)
    const [loading, setLoading] = useState(false)
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [filter, setFilter] = useState<'all' | 'acp' | 'cli' | 'ide' | 'extension'>('all')
    const [showClone, setShowClone] = useState(false)
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

    useEffect(() => {
        if (settings.length === 0) fetchSettings()
        if (!sourceConfig) fetchSourceConfig()
        if (quotaAccountLabel === undefined) fetchQuotaAccountLabel()
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

    const handleMachineProviderEnable = async (providerType: string, enabled: boolean) => {
        await handleSetSetting(providerType, 'enabled', enabled)
        await fetchSettings()
    }

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
                    {(['all', 'acp', 'cli', 'ide', 'extension'] as const).map(cat => (
                        <button
                            key={cat}
                            onClick={() => setFilter(cat)}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${
                                filter === cat ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
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
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-400">{t('machine.providers.sourceConfigTitle')}</div>
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
                            className="machine-btn text-[10px] bg-violet-500/[0.08] border-violet-500/20 text-violet-300 hover:bg-violet-500/[0.14]"
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
                        />
                    ))}
                </div>
            )}

            {/* Modals */}
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
