/**
 * Notifications — alert toggles only.
 *
 *  1. Global master / browser notification toggles (+ cloud push, injected).
 *  2. Agent alerts: "Approval needed" and "No progress", applied to every
 *     provider on every online machine. Per-provider fine-tuning lives in
 *     Machine → Providers (linked), and auto-approve is NOT a notification —
 *     it is configured in Provider settings, New Session → Advanced, and the
 *     mesh's Advanced settings.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/ui/PageHeader'
import { Section } from '../components/ui/Section'
import { ToggleRow } from '../components/settings/ToggleRow'
import { InfoTip } from '../components/ui/InfoTip'
import { RefreshButton } from '../components/ui/RefreshButton'
import { Link, useInRouterContext } from 'react-router-dom'
import { useNotificationPrefs } from '../hooks/useNotificationPrefs'
import { requestNotificationPermission } from '../hooks/useBrowserNotifications'
import { useTransport } from '../context/TransportContext'
import type { ProviderSettingsEntry, ProviderInfo } from './machine/types'
import { buildProviderSettingsEntries, extractProviderSettingsPayload } from './machine/providerSettings'
import { IconBell, IconMonitor, IconCheckCircle, IconZap, IconPlug, IconVolume, IconClock } from '../components/Icons'
import { getMachineDisplayName } from '../utils/daemon-utils'

/* ─── helpers ──────────────────────────────────────────────── */

interface DaemonMachine {
    id: string
    machineId?: string | null
    nickname?: string
    hostname?: string
    status: string
    providers?: ProviderInfo[]
}

// 'longGeneratingAlert'/'longGeneratingThresholdSec' are legacy aliases for the renamed
// 'noProgressAlert'/'noProgressThresholdSec' keys; both are recognized for backward compat.
const NOTIFICATION_SETTING_KEYS = new Set(['approvalAlert', 'noProgressAlert', 'noProgressThresholdSec', 'longGeneratingAlert', 'longGeneratingThresholdSec'])

/** The agent alerts this page controls, each mapped to its provider setting key(s). */
export const AGENT_ALERT_ROWS = [
    { id: 'approval', keys: ['approvalAlert'] },
    { id: 'noProgress', keys: ['noProgressAlert', 'longGeneratingAlert'] },
] as const

function filterNotificationSettings(schema: ProviderSettingsEntry['schema']): ProviderSettingsEntry['schema'] {
    return schema.filter((setting) => NOTIFICATION_SETTING_KEYS.has(setting.key))
}

function MachineProvidersLinkInRouter({ machineId, children }: { machineId: string; children: React.ReactNode }) {
    return (
        <Link to={`/machines/${machineId}`} state={{ initialMachineTab: 'providers' }} className="text-accent-primary hover:underline">
            {children}
        </Link>
    )
}

/** Link to one machine's Providers tab (router-aware; plain anchor outside a router). */
function MachineProvidersLink({ machineId, children }: { machineId: string; children: React.ReactNode }) {
    const inRouter = useInRouterContext()
    if (inRouter) return <MachineProvidersLinkInRouter machineId={machineId}>{children}</MachineProvidersLinkInRouter>
    return <a href={`/machines/${machineId}`} className="text-accent-primary hover:underline">{children}</a>
}

/* ─── Main Component ──────────────────────────────────────── */

interface NotificationsPageProps {
    /** Connected daemon machines from DaemonContext — each has an id + providers list */
    machines: DaemonMachine[]
    /** Optional: called when browser pref changes, for server sync (cloud) */
    onBrowserPrefChange?: (key: string, value: boolean) => void
    /** Optional: extra content to render in the browser notification section (e.g. push toggles) */
    renderPushSection?: () => React.ReactNode
    /**
     * Whether the daemon list backing `machines` has actually arrived yet.
     *
     * `machines` is derived from a context array that starts empty, so
     * `onlineMachines.length === 0` is indistinguishable from "not loaded yet"
     * — rendering "no online machines" on that alone tells a user with four
     * connected machines that they have none, until the first state lands.
     *
     * Defaults to `true` so hosts that render this page only after their data
     * is ready (and any caller predating this prop) keep their current
     * behavior; only a host that genuinely has a pre-load window needs to
     * thread its real flag through.
     */
    initialLoaded?: boolean
}

export default function NotificationsPage({ machines, onBrowserPrefChange, renderPushSection, initialLoaded = true }: NotificationsPageProps) {
    const { t } = useTranslation('common')
    const [prefs, updatePrefs] = useNotificationPrefs()
    const { sendCommand } = useTransport()
    const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() => {
        if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
        return Notification.permission
    })

    /* ─── Provider alert settings (from daemons) ─── */
    const [settings, setSettings] = useState<Record<string, ProviderSettingsEntry[]>>({}) // machineId → entries
    const [loading, setLoading] = useState(false)

    const onlineMachines = useMemo(() => machines.filter(m => m.status === 'online'), [machines])

    useEffect(() => {
        const refreshPermission = () => {
            if (typeof window === 'undefined' || !('Notification' in window)) {
                setBrowserPermission('unsupported')
                return
            }
            setBrowserPermission(Notification.permission)
        }

        refreshPermission()
        window.addEventListener('focus', refreshPermission)
        document.addEventListener('visibilitychange', refreshPermission)
        return () => {
            window.removeEventListener('focus', refreshPermission)
            document.removeEventListener('visibilitychange', refreshPermission)
        }
    }, [])

    // Fetch provider settings from all online machines
    const fetchAllSettings = useCallback(async () => {
        setLoading(true)
        const result: Record<string, ProviderSettingsEntry[]> = {}
        for (const m of onlineMachines) {
            try {
                const res = await sendCommand(m.id, 'get_provider_settings', {})
                const payload = extractProviderSettingsPayload(res)
                if (payload) {
                    const entries = buildProviderSettingsEntries(payload, m.providers || [], {
                        filterSchema: filterNotificationSettings,
                    })
                    if (entries.length > 0) result[m.id] = entries
                }
            } catch (e) {
                console.warn('[Notifications] Failed to fetch settings from', m.id, e)
            }
        }
        setSettings(result)
        setLoading(false)
    }, [onlineMachines, sendCommand])

    useEffect(() => {
        if (onlineMachines.length > 0) fetchAllSettings()
    }, [onlineMachines.length]) // eslint-disable-line react-hooks/exhaustive-deps

    // Flatten all provider entries across machines
    const allEntries = useMemo(() => {
        const flat: (ProviderSettingsEntry & { machineId: string; machineLabel: string })[] = []
        for (const [mid, entries] of Object.entries(settings)) {
            const machine = onlineMachines.find(m => m.id === mid)
            const label = machine ? getMachineDisplayName(machine, { fallbackId: mid }) : mid.slice(0, 8)
            for (const e of entries) {
                flat.push({ ...e, machineId: mid, machineLabel: label })
            }
        }
        return flat
    }, [settings, onlineMachines])

    // Handler for setting a single provider setting
    const handleSet = useCallback(async (machineId: string, providerType: string, key: string, value: unknown) => {
        // Optimistic update
        setSettings(prev => {
            const next = { ...prev }
            next[machineId] = (next[machineId] || []).map(p =>
                p.type === providerType ? { ...p, values: { ...p.values, [key]: value } } : p
            )
            return next
        })
        try {
            await sendCommand(machineId, 'set_provider_setting', { providerType, key, value })
        } catch { /* rollback on next refresh */ }
    }, [sendCommand])

    // One switch per alert, applied to every provider (all machines) that has it.
    const alertStats = useMemo(() => AGENT_ALERT_ROWS.map(row => {
        const withKey = allEntries
            .map(entry => ({ entry, key: row.keys.find(key => entry.schema.some(s => s.key === key)) }))
            .filter((item): item is { entry: typeof allEntries[number]; key: typeof row.keys[number] } => !!item.key)
        const onCount = withKey.filter(({ entry, key }) => !!(entry.values[key] ?? entry.schema.find(s => s.key === key)?.default)).length
        return { id: row.id, targets: withKey, total: withKey.length, onCount }
    }).filter(stat => stat.total > 0), [allEntries])

    const handleAlertToggle = useCallback(async (id: string, value: boolean) => {
        const stat = alertStats.find(item => item.id === id)
        if (!stat) return
        for (const { entry, key } of stat.targets) {
            await handleSet(entry.machineId, entry.type, key, value)
        }
    }, [alertStats, handleSet])

    // Browser pref helper
    const setBrowserPref = (key: string, value: boolean) => {
        updatePrefs({ [key]: value })
        onBrowserPrefChange?.(key, value)
    }


    return (
        <div className="flex flex-col h-full">
            <PageHeader icon={<IconBell className="text-text-primary" />} title={t('notifications.title')} subtitle={t('notifications.subtitle')} />
            <div className="page-content">

                {/* ═══ Section 1: Global / Browser ═══ */}
                <Section title={t('notifications.sectionBrowserAlerts')} className="mb-4">
                    <div className="flex flex-col gap-3">
                        <ToggleRow
                            label={<span className="flex items-center gap-1.5"><IconBell size={15} /> {t('notifications.masterToggleLabel')}</span>}
                            description={t('notifications.masterToggleDesc')}
                            checked={prefs.globalEnabled}
                            onChange={v => setBrowserPref('globalEnabled', v)}
                        />

                        {prefs.globalEnabled && <div className="border-t border-border-subtle my-0.5" />}

                        {prefs.globalEnabled && (
                            <ToggleRow
                                label={<span className="flex items-center gap-1.5"><IconMonitor size={15} /> {t('notifications.browserNotificationsLabel')}</span>}
                                description={t('notifications.browserNotificationsDesc')}
                                checked={prefs.browserNotifications}
                                onChange={v => setBrowserPref('browserNotifications', v)}
                            />
                        )}

                        {prefs.globalEnabled && (
                            <div className="ml-5 pl-3 border-l-2 border-border-subtle flex flex-wrap items-center gap-2" data-testid="browser-permission-row">
                                {/* Status chip + one ⓘ; the long explanations live in the popover. */}
                                {browserPermission === 'granted' && (
                                    <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-3xs font-semibold text-emerald-400">
                                        {t('notifications.permissionAllowedChip')}
                                    </span>
                                )}
                                {browserPermission === 'default' && (
                                    <>
                                        <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-3xs font-semibold text-amber-400">
                                            {t('notifications.permissionNeededChip')}
                                        </span>
                                        <button
                                            onClick={() => { void requestNotificationPermission().then(setBrowserPermission) }}
                                            className="px-2 py-0.5 rounded border border-border-default bg-bg-glass text-2xs text-text-secondary hover:text-text-primary transition-colors"
                                        >
                                            {t('notifications.allowNotifications')}
                                        </button>
                                    </>
                                )}
                                {browserPermission === 'denied' && (
                                    <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-3xs font-semibold text-amber-400">
                                        {t('notifications.permissionBlockedChip')}
                                    </span>
                                )}
                                {browserPermission === 'unsupported' && (
                                    <span className="inline-flex items-center rounded-full border border-border-subtle bg-bg-glass px-2 py-0.5 text-3xs font-semibold text-text-muted">
                                        {t('notifications.permissionUnsupportedChip')}
                                    </span>
                                )}
                                <InfoTip
                                    content={[
                                        renderPushSection ? t('notifications.browserBackgroundInfoWithPush') : t('notifications.browserBackgroundInfo'),
                                        browserPermission === 'default' ? t('notifications.permissionDefault')
                                            : browserPermission === 'denied' ? t('notifications.permissionDenied')
                                                : browserPermission === 'unsupported' ? t('notifications.permissionUnsupported')
                                                    : '',
                                    ].filter(Boolean).join('\n\n')}
                                />
                            </div>
                        )}

                        {prefs.globalEnabled && prefs.browserNotifications && (
                            <div className="ml-5 pl-3 border-l-2 border-border-subtle flex flex-col gap-2">
                                <ToggleRow
                                    label={<span className="flex items-center gap-1.5"><IconCheckCircle size={15} /> {t('notifications.completionAlertsLabel')}</span>}
                                    description={t('notifications.completionAlertsDesc')}
                                    checked={prefs.completionAlert}
                                    onChange={v => setBrowserPref('completionAlert', v)}
                                />
                                <ToggleRow
                                    label={<span className="flex items-center gap-1.5"><IconZap size={15} /> {t('notifications.approvalAlertsLabel')}</span>}
                                    description={t('notifications.approvalAlertsDesc')}
                                    checked={prefs.approvalAlert}
                                    onChange={v => setBrowserPref('approvalAlert', v)}
                                />
                                <ToggleRow
                                    label={<span className="flex items-center gap-1.5"><IconPlug size={15} /> {t('notifications.connectionAlertsLabel')}</span>}
                                    description={t('notifications.connectionAlertsDesc')}
                                    checked={prefs.disconnectAlert}
                                    onChange={v => setBrowserPref('disconnectAlert', v)}
                                />
                            </div>
                        )}

                        {/* Push section (cloud-only, injected) */}
                        {prefs.globalEnabled && renderPushSection?.()}

                        {prefs.globalEnabled && (
                            <>
                                <div className="border-t border-border-subtle my-0.5" />
                                <SoundToggle />
                            </>
                        )}

                        {!prefs.globalEnabled && (
                            <p className="text-2xs text-text-muted italic">
                                {t('notifications.allDisabled')}
                            </p>
                        )}
                    </div>
                </Section>

                {/* ═══ Section 2: Agent alerts ═══ */}
                <Section
                    title={t('notifications.sectionProviderAlerts')}
                    description={t('notifications.agentAlertsDesc')}
                    action={<RefreshButton onClick={() => { void fetchAllSettings() }} refreshing={loading} label={t('notifications.refresh')} />}
                    className="mb-4"
                >
                    {!initialLoaded ? (
                        /* Daemon list still in flight — "no online machines" would be a
                         * claim we cannot make yet (see the initialLoaded prop docs). */
                        <p className="text-sm text-text-muted py-6 text-center">{t('notifications.loading')}</p>
                    ) : onlineMachines.length === 0 ? (
                        <p className="text-sm text-text-muted py-6 text-center">{t('notifications.noOnlineMachines')}</p>
                    ) : loading && allEntries.length === 0 ? (
                        <p className="text-sm text-text-muted py-6 text-center">{t('notifications.loadingProviderSettings')}</p>
                    ) : (
                        <div className="flex flex-col gap-3" data-testid="agent-alert-toggles">
                            {alertStats.map(({ id, total, onCount }) => (
                                <ToggleRow
                                    key={id}
                                    label={
                                        <span className="flex items-center gap-1.5">
                                            {id === 'approval' ? <IconZap size={15} /> : <IconClock size={15} />}
                                            <span>{t(`notifications.agentAlert.${id}`)}</span>
                                            {onCount > 0 && onCount < total && (
                                                <span className="text-3xs text-text-muted">{t('notifications.mixed')}</span>
                                            )}
                                        </span>
                                    }
                                    description={t(`notifications.agentAlert.${id}Desc`)}
                                    checked={onCount === total}
                                    onChange={v => void handleAlertToggle(id, v)}
                                />
                            ))}
                            {/* Per-provider alerts (and auto-approve) are edited where the
                                provider lives: Machine → Providers. */}
                            <div className="border-t border-border-subtle pt-3 text-2xs text-text-muted" data-testid="per-provider-link">
                                {t('notifications.perProviderIntro')}{' '}
                                {onlineMachines.map((machine, index) => (
                                    <span key={machine.id}>
                                        {index > 0 ? ', ' : ''}
                                        <MachineProvidersLink machineId={machine.id}>
                                            {onlineMachines.length > 1
                                                ? getMachineDisplayName(machine, { fallbackId: machine.id })
                                                : t('notifications.machineProviders')}
                                        </MachineProvidersLink>
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </Section>

            </div>
        </div>
    )
}

/* ─── Sound Effects toggle (self-contained) ─── */

function SoundToggle() {
    const { t } = useTranslation('common')
    const [soundEnabled, setSoundEnabled] = useState(() => {
        try { return localStorage.getItem('adhdev_sound') !== '0' } catch { return true }
    })

    const handleToggle = (v: boolean) => {
        setSoundEnabled(v)
        try { localStorage.setItem('adhdev_sound', v ? '1' : '0') } catch {}
    }

    return (
        <ToggleRow
            label={<span className="flex items-center gap-1.5"><IconVolume size={15} /> {t('notifications.soundEffectsLabel')}</span>}
            description={t('notifications.soundEffectsDesc')}
            checked={soundEnabled}
            onChange={handleToggle}
        />
    )
}
