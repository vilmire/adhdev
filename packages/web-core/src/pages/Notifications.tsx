/**
 * Notifications — Unified notification management page.
 *
 * Combines:
 *  1. Global master / browser notification toggles (from Settings)
 *  2. Provider-level alert settings (autoApprove, approvalAlert, longGeneratingAlert)
 *     grouped by category with bulk "Apply to All" controls.
 *
 * This replaces the scattered notification UI across Settings and ProvidersTab.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { Section } from '../components/ui/Section'
import { ToggleRow } from '../components/settings/ToggleRow'
import { useNotificationPrefs } from '../hooks/useNotificationPrefs'
import { useTransport } from '../context/TransportContext'
import type { ProviderSettingsEntry, ProviderInfo } from './machine/types'

/* ─── helpers ──────────────────────────────────────────────── */

interface DaemonMachine {
    id: string
    machineId: string
    nickname?: string
    hostname?: string
    status: string
    providers?: ProviderInfo[]
}

/* Toggle‑switch component (self-contained — small) */
function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            onClick={() => !disabled && onChange(!checked)}
            className="w-10 h-[22px] rounded-[11px] border-none relative cursor-pointer transition-colors duration-200"
            style={{ background: checked ? '#8b5cf6' : 'var(--border-subtle)', opacity: disabled ? 0.4 : 1 }}
            disabled={disabled}
        >
            <div
                className="w-4 h-4 rounded-full bg-white absolute top-[3px] transition-[left] duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                style={{ left: checked ? 21 : 3 }}
            />
        </button>
    )
}

/* ─── Category Colors ──────────────────────────────────────── */
const CAT_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    acp: { bg: 'rgba(139,92,246,0.08)', text: '#a78bfa', border: 'rgba(139,92,246,0.2)' },
    cli: { bg: 'rgba(59,130,246,0.08)', text: '#60a5fa', border: 'rgba(59,130,246,0.2)' },
    ide: { bg: 'rgba(34,197,94,0.08)', text: '#86efac', border: 'rgba(34,197,94,0.2)' },
    extension: { bg: 'rgba(245,158,11,0.08)', text: '#fbbf24', border: 'rgba(245,158,11,0.2)' },
}

/* ─── Main Component ──────────────────────────────────────── */

interface NotificationsPageProps {
    /** Connected daemon machines from DaemonContext — each has an id + providers list */
    machines: DaemonMachine[]
    /** Optional: called when browser pref changes, for server sync (cloud) */
    onBrowserPrefChange?: (key: string, value: boolean) => void
    /** Optional: extra content to render in the browser notification section (e.g. push toggles) */
    renderPushSection?: () => React.ReactNode
}

export default function NotificationsPage({ machines, onBrowserPrefChange, renderPushSection }: NotificationsPageProps) {
    const [prefs, updatePrefs] = useNotificationPrefs()
    const { sendCommand } = useTransport()

    /* ─── Provider alert settings (from daemons) ─── */
    const [settings, setSettings] = useState<Record<string, ProviderSettingsEntry[]>>({}) // machineId → entries
    const [loading, setLoading] = useState(false)
    const [savingKey, setSavingKey] = useState<string | null>(null)

    const onlineMachines = useMemo(() => machines.filter(m => m.status === 'online'), [machines])

    // Fetch provider settings from all online machines
    const fetchAllSettings = useCallback(async () => {
        setLoading(true)
        const result: Record<string, ProviderSettingsEntry[]> = {}
        for (const m of onlineMachines) {
            try {
                const res: any = await sendCommand(m.id, 'get_provider_settings', {})
                // Unwrap flexibly — daemon responses can be wrapped differently
                const payload = res?.result || res
                const settingsMap = payload?.settings || res?.settings
                const valuesMap = payload?.values || res?.values || {}
                if (settingsMap && typeof settingsMap === 'object') {
                    const entries: ProviderSettingsEntry[] = []
                    for (const [type, schema] of Object.entries(settingsMap)) {
                        const prov = (m.providers || []).find((p: any) => p.type === type)
                        const filteredSchema = (schema as any[]).filter(s => ['autoApprove', 'approvalAlert', 'longGeneratingAlert', 'longGeneratingThresholdSec'].includes(s.key))
                        if (filteredSchema.length > 0) {
                            entries.push({
                                type,
                                displayName: prov?.displayName || type,
                                icon: prov?.icon || '',
                                category: prov?.category || 'unknown',
                                schema: filteredSchema,
                                values: valuesMap[type] || {},
                            })
                        }
                    }
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
            const label = machine?.nickname || machine?.hostname || mid.slice(0, 8)
            for (const e of entries) {
                flat.push({ ...e, machineId: mid, machineLabel: label })
            }
        }
        return flat
    }, [settings, onlineMachines])

    // Group by category
    const categories = useMemo(() => {
        const cats: Record<string, typeof allEntries> = {}
        for (const e of allEntries) {
            if (!cats[e.category]) cats[e.category] = []
            cats[e.category].push(e)
        }
        // Sort categories: acp, cli, ide, extension, then anything else
        const order = ['acp', 'cli', 'ide', 'extension', 'unknown']
        const sorted = order.filter(c => cats[c])
        // Add any categories not in the predefined order
        for (const c of Object.keys(cats)) {
            if (!sorted.includes(c)) sorted.push(c)
        }
        return sorted.map(c => ({ category: c, entries: cats[c] }))
    }, [allEntries])

    // Handler for setting a single provider setting
    const handleSet = useCallback(async (machineId: string, providerType: string, key: string, value: any) => {
        setSavingKey(`${providerType}.${key}`)
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
        setSavingKey(null)
    }, [sendCommand])

    // Bulk toggle: set key=value for all providers in a category across all machines
    const handleBulk = useCallback(async (category: string, key: string, value: boolean) => {
        const targets = allEntries.filter(e => e.category === category && e.schema.some(s => s.key === key))
        for (const t of targets) {
            await handleSet(t.machineId, t.type, key, value)
        }
    }, [allEntries, handleSet])

    // Browser pref helper
    const setBrowserPref = (key: string, value: boolean) => {
        updatePrefs({ [key]: value })
        onBrowserPrefChange?.(key, value)
    }

    const multiMachine = onlineMachines.length > 1

    return (
        <div className="flex flex-col h-full">
            <PageHeader icon="🔔" title="Notifications" subtitle="Alerts, auto-approve & provider settings" />
            <div className="page-content">

                {/* ═══ Section 1: Global / Browser ═══ */}
                <Section title="Browser alerts" className="mb-4">
                    <div className="flex flex-col gap-3">
                        <ToggleRow
                            label="🔔 Notifications"
                            description="Master toggle for all alerts"
                            checked={prefs.globalEnabled}
                            onChange={v => setBrowserPref('globalEnabled', v)}
                        />

                        {prefs.globalEnabled && <div className="border-t border-border-subtle my-0.5" />}

                        {prefs.globalEnabled && (
                            <ToggleRow
                                label="🖥️ Browser Notifications"
                                description="Desktop alerts when tab is inactive"
                                checked={prefs.browserNotifications}
                                onChange={v => setBrowserPref('browserNotifications', v)}
                            />
                        )}

                        {prefs.globalEnabled && prefs.browserNotifications && (
                            <div className="ml-5 pl-3 border-l-2 border-border-subtle flex flex-col gap-2">
                                <ToggleRow
                                    label="✅ Completion Alerts"
                                    description="Notify when agent finishes a task"
                                    checked={prefs.completionAlert}
                                    onChange={v => setBrowserPref('completionAlert', v)}
                                />
                                <ToggleRow
                                    label="⚡ Approval Alerts"
                                    description="Notify when agent needs approval"
                                    checked={prefs.approvalAlert}
                                    onChange={v => setBrowserPref('approvalAlert', v)}
                                />
                                <ToggleRow
                                    label="📡 Connection Alerts"
                                    description="Alert when a machine disconnects"
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
                            <p className="text-[11px] text-text-muted italic">
                                All notifications are disabled. Enable the master toggle to configure.
                            </p>
                        )}
                    </div>
                </Section>

                {/* ═══ Section 2: Provider Alert Rules ═══ */}
                <Section
                    title="Provider alert rules"
                    className="mb-4"
                >
                    <div className="flex justify-end mb-3 -mt-1">
                        <button onClick={fetchAllSettings} disabled={loading} className="machine-btn text-[11px]">
                            {loading ? '⏳ Loading...' : '↻ Refresh'}
                        </button>
                    </div>
                    {onlineMachines.length === 0 ? (
                        <p className="text-sm text-text-muted py-6 text-center">No online machines. Start ADHDev on a machine to configure provider alerts.</p>
                    ) : loading && allEntries.length === 0 ? (
                        <p className="text-sm text-text-muted py-6 text-center">Loading provider settings...</p>
                    ) : (
                        <div className="flex flex-col gap-5">
                            {categories.map(({ category, entries }) => {
                                const color = CAT_COLORS[category] || CAT_COLORS.cli
                                // Find common boolean alert keys across all entries in this category
                                const alertKeys = ['autoApprove', 'approvalAlert', 'longGeneratingAlert'] as const
                                const keyStats = alertKeys.map(key => {
                                    const withKey = entries.filter(e => e.schema.some(s => s.key === key))
                                    const onCount = withKey.filter(e => !!(e.values[key] ?? e.schema.find(s => s.key === key)?.default)).length
                                    return { key, label: key === 'autoApprove' ? 'Auto Approve' : key === 'approvalAlert' ? 'Approval Alert' : 'Long Gen Alert', total: withKey.length, onCount }
                                }).filter(k => k.total > 0)

                                return (
                                    <div key={category}>
                                        {/* Category header + bulk controls */}
                                        <div
                                            className="px-4 py-3 rounded-xl mb-3"
                                            style={{ background: color.bg, border: `1px solid ${color.border}` }}
                                        >
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className="px-2 py-0.5 rounded text-[10px] font-bold"
                                                        style={{ background: color.bg, color: color.text, border: `1px solid ${color.border}` }}
                                                    >{category.toUpperCase()}</span>
                                                    <span className="text-[11px] text-text-muted">{entries.length} providers</span>
                                                </div>
                                            </div>
                                            {keyStats.length > 0 && (
                                                <div className="flex flex-wrap gap-x-5 gap-y-2">
                                                    {keyStats.map(({ key, label, total, onCount }) => {
                                                        const allOn = onCount === total
                                                        const allOff = onCount === 0
                                                        return (
                                                            <div key={key} className="flex items-center gap-1.5 text-[11px]">
                                                                <span className="text-text-secondary font-medium">{label}</span>
                                                                <span className="text-[9px] text-text-muted">({onCount}/{total})</span>
                                                                <button
                                                                    onClick={() => void handleBulk(category, key, true)}
                                                                    disabled={allOn}
                                                                    className={`machine-btn text-[9px] px-1.5 py-px ${allOn ? 'opacity-40' : 'text-green-400 border-green-500/30'}`}
                                                                >All ON</button>
                                                                <button
                                                                    onClick={() => void handleBulk(category, key, false)}
                                                                    disabled={allOff}
                                                                    className={`machine-btn text-[9px] px-1.5 py-px ${allOff ? 'opacity-40' : 'text-red-400 border-red-500/30'}`}
                                                                >All OFF</button>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            )}
                                        </div>

                                        {/* Per-provider rows (collapsible) */}
                                        <ProviderCategoryDetail
                                            entries={entries}
                                            multiMachine={multiMachine}
                                            savingKey={savingKey}
                                            onSet={handleSet}
                                        />
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </Section>

            </div>
        </div>
    )
}

/* ─── Collapsible provider detail per category ─── */

function ProviderCategoryDetail({ entries, multiMachine, savingKey, onSet }: {
    entries: (ProviderSettingsEntry & { machineId: string; machineLabel: string })[]
    multiMachine: boolean
    savingKey: string | null
    onSet: (machineId: string, providerType: string, key: string, value: any) => Promise<void>
}) {
    const [expanded, setExpanded] = useState(false)

    return (
        <div>
            <button
                onClick={() => setExpanded(!expanded)}
                className="machine-btn text-[10px] mb-2"
            >
                {expanded ? '▾ Hide details' : '▸ Show per-provider details'} ({entries.length})
            </button>

            {expanded && (
                <div className="flex flex-col gap-1.5 ml-2">
                    {entries.map((prov, i) => (
                        <div
                            key={`${prov.machineId}-${prov.type}-${i}`}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-glass border border-border-subtle text-[12px]"
                        >
                            <span className="text-base shrink-0">{prov.icon}</span>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="font-medium text-text-primary truncate">{prov.displayName}</span>
                                    {multiMachine && (
                                        <span className="text-[9px] text-text-muted bg-bg-secondary px-1 py-px rounded">{prov.machineLabel}</span>
                                    )}
                                </div>
                            </div>
                            {prov.schema.filter(s => s.type === 'boolean').map(s => {
                                const val = !!(prov.values[s.key] ?? s.default)
                                const saving = savingKey === `${prov.type}.${s.key}`
                                return (
                                    <div key={s.key} className="flex items-center gap-1 shrink-0">
                                        <span className="text-[9px] text-text-muted">{s.label || s.key}</span>
                                        {saving && <span className="text-[8px] text-violet-400">...</span>}
                                        <Toggle checked={val} onChange={v => void onSet(prov.machineId, prov.type, s.key, v)} />
                                    </div>
                                )
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

/* ─── Sound Effects toggle (self-contained) ─── */

function SoundToggle() {
    const [soundEnabled, setSoundEnabled] = useState(() => {
        try { return localStorage.getItem('adhdev_sound') !== '0' } catch { return true }
    })

    const handleToggle = (v: boolean) => {
        setSoundEnabled(v)
        try { localStorage.setItem('adhdev_sound', v ? '1' : '0') } catch {}
    }

    return (
        <ToggleRow
            label="🔊 Sound Effects"
            description="Play a sound when agent completes or needs approval"
            checked={soundEnabled}
            onChange={handleToggle}
        />
    )
}
