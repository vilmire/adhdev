/**
 * ProvidersTab — Dynamic provider settings with filter and inline editing.
 * Now includes Auto-Fix (AI agent script implementation) and Clone Provider modals.
 */
import { useState, useEffect, useCallback } from 'react'
import type { ProviderSettingsEntry, ProviderInfo } from './types'
import { buildProviderSettingsEntries, extractProviderSettingsPayload } from './providerSettings'
import { extractProviderSourceConfigPayload, normalizeProviderDirInput, type ProviderSourceConfigPayload } from './providerSourceConfig'
import ProviderCloneModal from './ProviderCloneModal'
import AddProviderSection from './AddProviderSection'
import InstalledProviderRow from './InstalledProviderRow'

interface ProvidersTabProps {
    machineId: string
    providers: ProviderInfo[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export default function ProvidersTab({ machineId, providers, sendDaemonCommand }: ProvidersTabProps) {
    const [settings, setSettings] = useState<ProviderSettingsEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [filter, setFilter] = useState<'all' | 'acp' | 'cli' | 'ide' | 'extension'>('all')
    const [showClone, setShowClone] = useState(false)
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

    useEffect(() => {
        if (settings.length === 0) fetchSettings()
        if (!sourceConfig) fetchSourceConfig()
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

    const handleUninstall = async (providerType: string, category: string) => {
        if (!confirm(`Uninstall ${providerType}? This removes the manifest from ~/.adhdev/marketplace/.`)) return
        try {
            await sendDaemonCommand(machineId, 'uninstall_provider_manifest', { type: providerType, category })
        } finally {
            await fetchSettings()
        }
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
            {/* Add provider — registry catalog browser (collapsible) */}
            <AddProviderSection
                machineId={machineId}
                sendDaemonCommand={sendDaemonCommand}
                installedTypes={new Set(settings.map(s => s.type))}
                onInstalled={() => { void fetchSettings() }}
            />

            {/* Toolbar: filter + create + refresh + advanced toggle */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex gap-1 items-center">
                    <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mr-2">Filter</span>
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
                        onClick={() => setShowClone(true)}
                        className="machine-btn text-[10px]"
                        title="Create a new provider from an existing one"
                    >✨ Create</button>
                    <button onClick={fetchSettings} disabled={loading} className="machine-btn text-[10px]">
                        {loading ? '⏳' : '↻'} Refresh
                    </button>
                    <button
                        onClick={() => setShowSourceConfig(v => !v)}
                        className="machine-btn text-[10px]"
                        title="Show source configuration (advanced)"
                    >⚙ Advanced</button>
                </div>
            </div>

            {/* Advanced: provider source config (collapsed by default) */}
            {showSourceConfig && (
                <div className="px-4.5 py-3.5 rounded-xl bg-bg-secondary border border-border-subtle">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-400">Provider source config</div>
                            <div className="text-[11px] text-text-muted mt-1">Where the daemon looks for provider manifests. Affects resolution and reloads.</div>
                        </div>
                        <button onClick={fetchSourceConfig} className="machine-btn text-[10px]">↻ Refresh</button>
                    </div>
                    <div className="grid md:grid-cols-[180px_1fr_auto] gap-3 items-end">
                        <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                            <span className="font-medium text-text-primary">Source mode</span>
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
                            <span className="font-medium text-text-primary">Explicit providerDir</span>
                            <input
                                type="text"
                                value={providerDirInput}
                                onChange={e => setProviderDirInput(e.target.value)}
                                placeholder="Leave blank to use ~/.adhdev/providers"
                                className="machine-input text-[11px]"
                            />
                        </label>
                        <button
                            onClick={() => void handleApplySourceConfig()}
                            disabled={sourceSaving}
                            className="machine-btn text-[10px] bg-violet-500/[0.08] border-violet-500/20 text-violet-300 hover:bg-violet-500/[0.14]"
                        >{sourceSaving ? 'Applying…' : 'Apply + Reload'}</button>
                    </div>
                    <div className="mt-3 grid gap-1 text-[10px] text-text-muted">
                        <div><span className="text-text-secondary font-medium">User root:</span> {sourceConfig?.userDir || '—'}</div>
                        <div><span className="text-text-secondary font-medium">Upstream root:</span> {sourceConfig?.upstreamDir || '—'}</div>
                        <div><span className="text-text-secondary font-medium">Provider roots:</span> {sourceConfig?.providerRoots?.join(' → ') || '—'}</div>
                    </div>
                </div>
            )}

            {/* Installed providers list */}
            {loading && settings.length === 0 ? (
                <div className="p-10 text-center text-text-muted">Loading provider settings…</div>
            ) : filteredSettings.length === 0 ? (
                <div className="px-4.5 py-8 rounded-xl border border-border-subtle bg-bg-secondary text-center">
                    <div className="text-[12px] text-text-muted">
                        {filter === 'all'
                            ? 'No providers installed yet. Open "Add provider" above to install one.'
                            : `No ${filter.toUpperCase()} providers installed.`}
                    </div>
                </div>
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
                            onUninstall={handleUninstall}
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
