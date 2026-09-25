/**
 * ProvidersTab — Dynamic provider settings with filter and inline editing.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
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
import { buildProviderSettingsEntries, extractProviderSettingsPayload, type ProviderSettingsPayload } from './providerSettings'
import { extractProviderSourceConfigPayload, normalizeProviderDirInput, type ProviderSourceConfigPayload } from './providerSourceConfig'
import ProviderInstallOptionsModal from './ProviderInstallOptionsModal'
import InstalledProviderRow, { type ProviderPinInfo } from './InstalledProviderRow'
import { extractChannelSyncErrors, hasDigestMismatch, type ChannelSyncErrorInfo } from './providerChannelErrors'
import Card from '../../components/Card'
import SourcesPanel from './SourcesPanel'
import { IconSpinner } from '../../components/Icons'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { eventManager } from '../../managers/EventManager'
import { interpretProviderChannelSyncResult } from '../../utils/provider-channel-sync'

interface ProvidersTabProps {
    machineId: string
    providers: ProviderInfo[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    /** Machine plan quota (MachineInfo.quota) — rendered per provider row. */
    quota?: Record<string, MeshNodeFactsProviderQuota>
    /**
     * Channel staleness as read by this tab's own check_provider_updates, so
     * the machine page's tab dot stays current without an extra command.
     */
    onChannelStaleness?: (snap: { staleTypes: string[]; newTypes: string[] }) => void
}

/**
 * ★No background refetch (owner feedback 2026-09-25: "every click runs
 * something in the background"). Rules this component keeps:
 *   - `providers` changes on EVERY status tick. It is joined into the rows by
 *     a pure useMemo, never a dependency of a daemon fetch — it used to be a
 *     useCallback dep of fetchSettings, which re-sent get_provider_settings +
 *     check_provider_updates on every status update after one sync click.
 *   - A write that succeeded is applied optimistically and NOT followed by a
 *     full re-read; reconciliation re-reads only on failure.
 *   - The Refresh button is the only thing that shows a spinner. Background
 *     reconciles never touch `loading`.
 */
export default function ProvidersTab({ machineId, providers, sendDaemonCommand, quota, onChannelStaleness }: ProvidersTabProps) {
    const { t } = useTranslation('common')
    // Raw daemon payload; the rows are DERIVED from it + `providers` below.
    const [settingsPayload, setSettingsPayload] = useState<ProviderSettingsPayload | null>(null)
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
    /** Providers whose model list is discoverable but whose last read failed. */
    const [modelStaleTypes, setModelStaleTypes] = useState<string[]>([])
    const [installingNewType, setInstallingNewType] = useState<string | null>(null)
    // Provider types whose per-row Update is in flight.
    const [updatingTypes, setUpdatingTypes] = useState<Record<string, true>>({})
    const [updatingAll, setUpdatingAll] = useState(false)
    // Why a channel install failed, per provider type. The daemon already
    // returns the typed channelSync errors (DIGEST_MISMATCH, TRANSPORT_FAILED,
    // …); before this they were dropped on the floor, so a refusing install
    // just silently did nothing and the user had no way to tell a digest
    // mismatch from a network failure.
    const [installErrors, setInstallErrors] = useState<Record<string, ChannelSyncErrorInfo[]>>({})
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [filter, setFilter] = useState<'all' | 'acp' | 'cli' | 'ide' | 'extension'>('cli')
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
        } catch (e: any) {
            setLoadError(t('machine.providers.loadFailed', { error: e?.message || String(e) }))
        }
    }, [machineId, sendDaemonCommand, t])

    /**
     * Re-read the provider settings payload. `explicit` (the Refresh button,
     * and the very first load) is the only case that shows the spinner.
     */
    const fetchSettings = useCallback(async (opts?: { explicit?: boolean }) => {
        if (!machineId) return
        if (opts?.explicit) setLoading(true)
        try {
            const res = await sendDaemonCommand(machineId, 'get_provider_settings', {})
            const payload = extractProviderSettingsPayload(res)
            if (payload) {
                setSettingsPayload(payload)
                setLoadError(null)
            }
        } catch (e: any) {
            setLoadError(t('machine.providers.loadFailed', { error: e?.message || String(e) }))
        } finally {
            if (opts?.explicit) setLoading(false)
        }
    }, [machineId, sendDaemonCommand, t])

    // Pure join — re-runs on status churn, sends nothing.
    const settings = useMemo<ProviderSettingsEntry[]>(() => {
        if (!settingsPayload) return []
        const entries = buildProviderSettingsEntries(settingsPayload, providers, {
            filterSchema: (schema) => schema.filter((setting) => setting.key !== 'enabled'),
        })
        entries.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName))
        return entries
    }, [settingsPayload, providers])

    /** Optimistically patch one stored value in the payload. */
    const patchSettingValue = useCallback((providerType: string, key: string, value: unknown) => {
        setSettingsPayload(prev => prev
            ? { ...prev, values: { ...prev.values, [providerType]: { ...(prev.values[providerType] || {}), [key]: value } } }
            : prev)
    }, [])

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
            const res = await sendDaemonCommand(machineId, 'set_quota_account_label', { enabled })
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { success?: boolean } | undefined
            // Reconcile with what the daemon actually stored — only on failure.
            if (body?.success === false) await fetchQuotaAccountLabel()
        } catch {
            await fetchQuotaAccountLabel()
        }
    }, [machineId, sendDaemonCommand, fetchQuotaAccountLabel])

    /** Read one provider's quota probe switch. */
    const fetchQuotaEnabledOne = useCallback(async (providerType: string) => {
        if (!machineId) return
        try {
            const res = await sendDaemonCommand(machineId, 'get_quota_provider_enabled', { providerType })
            // Standalone returns the raw response, cloud wraps it as
            // { success, result } — accept both, as the transport docs require.
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { enabled?: unknown } | undefined
            if (typeof body?.enabled === 'boolean') {
                setQuotaEnabled(prev => ({ ...prev, [providerType]: body.enabled as boolean }))
            }
        } catch { /* leave unset — renders as ON, which is also the config default */ }
    }, [machineId, sendDaemonCommand])

    /** Mount-time read of every quota provider's switch (one fan-out). */
    const fetchQuotaEnabled = useCallback(async () => {
        await Promise.all([...QUOTA_PROVIDERS].map((providerType) => fetchQuotaEnabledOne(providerType)))
    }, [fetchQuotaEnabledOne])

    const handleQuotaToggle = useCallback(async (providerType: string, enabled: boolean) => {
        if (!machineId) return
        setQuotaEnabled(prev => ({ ...prev, [providerType]: enabled })) // optimistic: the switch responds immediately
        try {
            const res = await sendDaemonCommand(machineId, 'set_quota_provider_enabled', { providerType, enabled })
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { success?: boolean; error?: unknown } | undefined
            if (body?.success === false) {
                setLoadError(t('machine.providers.quotaToggleFailed', { provider: providerType, error: typeof body.error === 'string' ? body.error : 'unknown error' }))
                // Reconcile THIS provider with what the daemon actually stored.
                await fetchQuotaEnabledOne(providerType)
            }
        } catch (e: any) {
            setLoadError(t('machine.providers.quotaToggleFailed', { provider: providerType, error: e?.message || String(e) }))
            await fetchQuotaEnabledOne(providerType)
        }
    }, [machineId, sendDaemonCommand, fetchQuotaEnabledOne, t])

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
                {
                    providers?: Array<Record<string, any>>
                    channelStaleness?: { staleTypes?: string[]; newTypes?: string[]; error?: string }
                    modelStaleness?: { staleTypes?: string[] }
                } | undefined
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
            const staleness = body?.channelStaleness
            if (onChannelStaleness && staleness && !staleness.error) {
                onChannelStaleness({
                    staleTypes: Array.isArray(staleness.staleTypes) ? staleness.staleTypes : [],
                    newTypes: Array.isArray(staleness.newTypes) ? staleness.newTypes : [],
                })
            }
            // Model-list axis: only "discovery is supported but the last read
            // FAILED" is shown. Providers that cannot be enumerated at all
            // (daemon `cannotVerifyTypes`) are deliberately not rendered —
            // owner decision 2026-09-25; an outdated list surfaces as an issue.
            setModelStaleTypes(Array.isArray(body?.modelStaleness?.staleTypes) ? body.modelStaleness.staleTypes : [])
        } catch { /* leave empty — rows then show no pin rather than a wrong one */ }
    }, [machineId, sendDaemonCommand, onChannelStaleness])

    const handleInstallNewType = useCallback(async (providerType: string) => {
        if (!machineId) return
        setInstallingNewType(providerType)
        // Clear any previous failure for this type so a retry does not show a
        // stale reason next to a fresh attempt.
        setInstallErrors(prev => {
            if (!(providerType in prev)) return prev
            const next = { ...prev }
            delete next[providerType]
            return next
        })
        try {
            // activate_provider_updates {types} unions the never-activated type
            // into the verified-channel sync target set (digest-verified,
            // atomic pointer flip — same machinery as updates).
            const res = await sendDaemonCommand(machineId, 'activate_provider_updates', { types: [providerType] })
            // Report why it refused. The daemon returns typed channelSync
            // errors; dropping them is what made a DIGEST_MISMATCH look like
            // a no-op button.
            const errors = extractChannelSyncErrors(res)
            if (errors.length > 0) {
                setInstallErrors(prev => ({ ...prev, [providerType]: errors }))
            }
        } catch (e) {
            setInstallErrors(prev => ({
                ...prev,
                [providerType]: [{ code: 'COMMAND_FAILED', message: e instanceof Error ? e.message : String(e) }],
            }))
        } finally {
            setInstallingNewType(null)
            await fetchPins()
            // A newly activated spec can change the settings schema.
            void fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins, fetchSettings])

    /** "Update all" — every stale pin (no types: the default target set). */
    const handleActivatePins = useCallback(async () => {
        if (!machineId) return
        setUpdatingAll(true)
        try {
            const res = await sendDaemonCommand(machineId, 'activate_provider_updates', {})
            const outcome = interpretProviderChannelSyncResult(res)
            if ('error' in outcome) {
                eventManager.showToast(t('machine.detail.providerSyncFailed', { error: outcome.error }), 'warning')
            } else {
                eventManager.showToast(
                    outcome.activatedCount > 0
                        ? t('machine.detail.providerSyncSuccess', { count: outcome.activatedCount })
                        : t('machine.detail.providerSyncAlreadyCurrent'),
                    'success',
                )
            }
        } catch (e) {
            eventManager.showToast(t('machine.detail.providerSyncFailed', { error: e instanceof Error ? e.message : String(e) }), 'warning')
        } finally {
            setUpdatingAll(false)
            // Report what actually moved, not what we hoped would.
            await fetchPins()
            void fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins, fetchSettings, t])

    const handleRollbackPin = useCallback(async (providerType: string) => {
        if (!machineId) return
        try {
            await sendDaemonCommand(machineId, 'rollback_provider_update', { providerType })
        } finally {
            await fetchPins()
            void fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins, fetchSettings])

    /**
     * Per-provider inline "Update" (owner feedback 2026-09-25: a button next
     * to the provider, not a number badge). `only: true` restricts the daemon
     * sync to THIS type — without it `types` is unioned into the default
     * target set and one row's button would move every stale pin. An older
     * daemon ignores `only`; the toast still reports what really moved.
     */
    const handleUpdateProvider = useCallback(async (providerType: string) => {
        if (!machineId) return
        setUpdatingTypes(prev => ({ ...prev, [providerType]: true }))
        try {
            const res = await sendDaemonCommand(machineId, 'activate_provider_updates', { types: [providerType], only: true })
            const outcome = interpretProviderChannelSyncResult(res)
            const errors = extractChannelSyncErrors(res)
            if ('error' in outcome || errors.length > 0) {
                const error = 'error' in outcome ? outcome.error : errors.map(e => e.message || e.code).join('; ')
                eventManager.showToast(t('machine.detail.providerSyncFailed', { error }), 'warning')
            } else {
                eventManager.showToast(
                    outcome.activatedCount > 0
                        ? t('machine.detail.providerSyncSuccess', { count: outcome.activatedCount })
                        : t('machine.detail.providerSyncAlreadyCurrent'),
                    'success',
                )
            }
        } catch (e) {
            eventManager.showToast(t('machine.detail.providerSyncFailed', { error: e instanceof Error ? e.message : String(e) }), 'warning')
        } finally {
            setUpdatingTypes(prev => {
                const next = { ...prev }
                delete next[providerType]
                return next
            })
            await fetchPins()
            void fetchSettings()
        }
    }, [machineId, sendDaemonCommand, fetchPins, fetchSettings, t])

    useEffect(() => {
        if (!settingsPayload) void fetchSettings({ explicit: true })
        if (!sourceConfig) fetchSourceConfig()
        if (quotaAccountLabel === undefined) fetchQuotaAccountLabel()
        fetchQuotaEnabled()
        fetchPins()
    }, [])

    const handleSetSetting = async (providerType: string, key: string, value: unknown) => {
        setSavingKey(`${providerType}.${key}`)
        // Optimistic update; re-read only when the write did not land.
        patchSettingValue(providerType, key, value)
        try {
            const res = await sendDaemonCommand(machineId, 'set_provider_setting', { providerType, key, value })
            if (!res?.success) void fetchSettings()
        } catch {
            void fetchSettings()
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
            const autoApproveRes = await sendDaemonCommand(machineId, 'set_provider_setting', {
                providerType,
                key: 'autoApprove',
                value: options.autoApprove,
            })
            const enableRes = await sendDaemonCommand(machineId, 'set_provider_setting', {
                providerType,
                key: 'enabled',
                value: true,
            })
            if (autoApproveRes?.success === false || enableRes?.success === false) {
                throw new Error('set_provider_setting refused')
            }
            // All writes landed — apply them locally, no re-read.
            patchSettingValue(providerType, 'autoApprove', options.autoApprove)
            patchSettingValue(providerType, 'enabled', true)
            if (options.quotaEnabled !== undefined) {
                setQuotaEnabled(prev => ({ ...prev, [providerType]: options.quotaEnabled as boolean }))
            }
        } catch {
            // Something refused mid-way: reconcile with what was stored.
            void fetchSettings()
            void fetchQuotaEnabledOne(providerType)
        } finally {
            setSavingKey(null)
        }
    }, [machineId, sendDaemonCommand, fetchSettings, fetchQuotaEnabledOne, patchSettingValue])

    // Detection results arrive through the status broadcast
    // (providerInfo.machineStatus) — settings do not change, so no re-read.
    const handleDetectProvider = async (providerType: string) => {
        setSavingKey(`${providerType}.detect`)
        try {
            const res = await sendDaemonCommand(machineId, 'detect_provider', { providerType })
            const body = (res && typeof res === 'object' && 'result' in (res as any) ? (res as any).result : res) as { success?: boolean; error?: unknown } | undefined
            if (body?.success === false) {
                setLoadError(t('machine.providers.loadFailed', { error: typeof body.error === 'string' ? body.error : 'detect failed' }))
            }
        } catch (e: any) {
            setLoadError(t('machine.providers.loadFailed', { error: e?.message || String(e) }))
        } finally {
            setSavingKey(null)
        }
    }

    const handleResetProviderCommand = async (providerType: string) => {
        await handleSetSetting(providerType, 'executablePath', '')
        await handleSetSetting(providerType, 'executableArgs', '')
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
            // Source mode genuinely reloads providers — background re-read.
            void fetchSettings()
        } catch {
            await fetchSourceConfig()
        }
        setSourceSaving(false)
    }

    const filteredSettings = settings.filter(p => filter === 'all' || p.category === filter)
    const stalePinCount = Object.values(pins).filter(p => p.stale).length

    return (
        <div className="flex flex-col gap-3">
            {/* Toolbar: filter + create + refresh + advanced toggle */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex gap-1 items-center">
                    <span className="text-2xs text-text-muted font-semibold uppercase tracking-wider mr-2">{t('machine.providers.filter')}</span>
                    {(['cli', 'ide', 'acp', 'extension', 'all'] as const).map(cat => (
                        <button
                            key={cat}
                            onClick={() => setFilter(cat)}
                            className={`machine-btn text-3xs px-2 py-0.5 ${
                                filter === cat ? 'bg-accent-primary/15 border-accent-primary/40 text-accent-primary' : ''
                            }`}
                        >{cat.toUpperCase()}</button>
                    ))}
                </div>
                <div className="flex gap-1.5">
                    <button
                        onClick={() => setShowSources(v => !v)}
                        className={`machine-btn text-3xs ${showSources ? 'bg-sky-500/[0.10] border-sky-500/30 text-sky-300' : ''}`}
                        title="Manage 3rd-party provider sources"
                    >{t('machine.providers.sources')}</button>
                    {/* "Update all" only when more than one provider is behind —
                        a single stale provider has its own inline Update. */}
                    {stalePinCount >= 2 && (
                        <button
                            onClick={() => { void handleActivatePins() }}
                            disabled={updatingAll}
                            className="machine-btn text-3xs text-amber-400 border-amber-500/25"
                        >
                            {updatingAll ? <IconSpinner size={11} /> : null} {t('machine.providers.updateAll')}
                        </button>
                    )}
                    <button
                        onClick={() => { void fetchSettings({ explicit: true }); void fetchPins() }}
                        disabled={loading}
                        className="machine-btn text-3xs"
                    >
                        {loading ? <IconSpinner size={11} /> : '↻'} {t('machine.providers.refresh')}
                    </button>
                    <button
                        onClick={() => setShowSourceConfig(v => !v)}
                        className="machine-btn text-3xs"
                        title="Show source configuration (advanced)"
                    >{t('machine.providers.advanced')}</button>
                </div>
            </div>

            {loadError && (
                <AlertBanner variant="error" onDismiss={() => setLoadError(null)}>
                    {loadError}
                </AlertBanner>
            )}

            {/* Verified-channel types never installed on this machine (kimi
                class: first published AFTER this machine bootstrapped, so no
                pin, nothing in .upstream — invisible to every targeted sync
                and, before this section, uninstallable from the dashboard). */}
            {channelNewTypes.length > 0 && (
                <Card padding="none" className="px-4.5 py-3.5">
                    <div className="text-2xs font-semibold uppercase tracking-wider text-accent-primary">{t('machine.providers.newChannelTypesTitle')}</div>
                    <div className="text-2xs text-text-muted mt-1 mb-2.5">{t('machine.providers.newChannelTypesDesc')}</div>
                    <div className="flex flex-col gap-1.5">
                        {channelNewTypes.map((providerType) => {
                            const errors = installErrors[providerType] ?? []
                            return (
                                <div key={providerType} className="flex flex-col gap-1">
                                    <div className="flex items-center justify-between gap-3 text-xxs">
                                        <span className="font-mono text-text-primary">{providerType}</span>
                                        <button
                                            onClick={() => { void handleInstallNewType(providerType) }}
                                            disabled={installingNewType !== null}
                                            className="px-2.5 py-1 rounded-md text-xs font-medium bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25 disabled:opacity-50"
                                        >
                                            {installingNewType === providerType ? <IconSpinner size={11} /> : t('machine.providers.installNewType')}
                                        </button>
                                    </div>
                                    {errors.length > 0 && (
                                        <div className="rounded-md border border-red-500/30 bg-red-500/[0.07] px-2.5 py-1.5">
                                            <div className="text-3xs font-semibold uppercase tracking-wider text-red-300">
                                                {t('machine.providers.installFailedTitle')}
                                            </div>
                                            {/* DIGEST_MISMATCH is not user-retryable — say so plainly
                                                instead of leaving only the raw daemon string. */}
                                            {hasDigestMismatch(errors) && (
                                                <div className="text-3xs text-red-200/90 mt-1">
                                                    {t('machine.providers.installFailedDigestMismatch')}
                                                </div>
                                            )}
                                            {/* Every error, not just the first: a sync can refuse for
                                                more than one reason and a truncated list hides the
                                                one that actually explains the failure. */}
                                            <ul className="mt-1 flex flex-col gap-0.5">
                                                {errors.map((err, i) => (
                                                    <li key={`${err.code}-${i}`} className="text-3xs text-text-muted font-mono break-all">
                                                        <span className="text-red-300/90">{err.code}</span>
                                                        {err.providerType ? ` [${err.providerType}]` : ''}
                                                        {err.message ? `: ${err.message}` : ''}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </Card>
            )}

            {/* Model lists that COULD be discovered but whose last read failed
                (signed out, offline, unparseable) — the manifest list is in
                force and may be wrong. Providers that cannot be enumerated at
                all are intentionally not listed (owner decision 2026-09-25). */}
            {modelStaleTypes.length > 0 && (
                <Card padding="none" className="px-4.5 py-3.5">
                    <div className="text-2xs font-semibold uppercase tracking-wider text-text-secondary">{t('machine.providers.modelListTitle')}</div>
                    <div className="text-2xs text-text-muted mt-1 mb-2">{t('machine.providers.modelListStaleDesc')}</div>
                    <div className="flex flex-wrap gap-1.5">
                        {modelStaleTypes.map((providerType) => (
                            <span key={providerType} className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-2 py-0.5">
                                <span className="font-mono text-xxs text-text-primary">{providerType}</span>
                                <span className="text-3xs uppercase tracking-wider text-amber-300/90">{t('machine.providers.modelListStaleBadge')}</span>
                            </span>
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
                            <div className="text-2xs font-semibold uppercase tracking-wider text-accent-primary">{t('machine.providers.sourceConfigTitle')}</div>
                            <div className="text-2xs text-text-muted mt-1">{t('machine.providers.sourceConfigDesc')}</div>
                        </div>
                        <button onClick={fetchSourceConfig} className="machine-btn text-3xs">↻ Refresh</button>
                    </div>
                    <div className="grid md:grid-cols-[180px_1fr_auto] gap-3 items-end">
                        <label className="flex flex-col gap-1 text-2xs text-text-secondary">
                            <span className="font-medium text-text-primary">{t('machine.providers.sourceMode')}</span>
                            <select
                                value={sourceModeInput}
                                onChange={e => setSourceModeInput(e.target.value as 'normal' | 'no-upstream')}
                                className="machine-input text-2xs"
                            >
                                <option value="normal">normal</option>
                                <option value="no-upstream">no-upstream</option>
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-2xs text-text-secondary">
                            <span className="font-medium text-text-primary">{t('machine.providers.explicitProviderDir')}</span>
                            <input
                                type="text"
                                value={providerDirInput}
                                onChange={e => setProviderDirInput(e.target.value)}
                                placeholder={t('machine.providers.providerDirPlaceholder')}
                                className="machine-input text-2xs"
                            />
                        </label>
                        <button
                            onClick={() => void handleApplySourceConfig()}
                            disabled={sourceSaving}
                            className="machine-btn text-3xs bg-accent-primary/[0.08] border-accent-primary/20 text-accent-primary hover:bg-accent-primary/[0.14]"
                        >{sourceSaving ? t('machine.providers.applying') : t('machine.providers.applyReload')}</button>
                    </div>
                    <div className="mt-3 grid gap-1 text-3xs text-text-muted">
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
                    <div className="text-xs text-text-muted">
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
                            onUpdate={() => handleUpdateProvider(prov.type)}
                            updating={updatingTypes[prov.type] === true}
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
        </div>
    )
}
