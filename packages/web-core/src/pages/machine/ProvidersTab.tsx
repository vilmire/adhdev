/**
 * ProvidersTab — Dynamic provider settings with filter and inline editing.
 * Now includes Auto-Fix (AI agent script implementation) and Clone Provider modals.
 */
import { useState, useEffect, useCallback } from 'react'
import type { ProviderSettingsEntry, ProviderInfo } from './types'
import { buildProviderSettingsEntries, extractProviderSettingsPayload } from './providerSettings'
import ProviderFixModal from './ProviderFixModal'
import ProviderCloneModal from './ProviderCloneModal'

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
    const [fixTarget, setFixTarget] = useState<ProviderInfo | null>(null)
    const [showClone, setShowClone] = useState(false)

    const fetchSettings = useCallback(async () => {
        if (!machineId) return
        setLoading(true)
        try {
            const res = await sendDaemonCommand(machineId, 'get_provider_settings', {})
            const payload = extractProviderSettingsPayload(res)
            if (payload) {
                const entries: ProviderSettingsEntry[] = buildProviderSettingsEntries(payload, providers)
                entries.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName))
                setSettings(entries)
            }
        } catch { }
        setLoading(false)
    }, [machineId, providers, sendDaemonCommand])

    useEffect(() => {
        if (settings.length === 0) fetchSettings()
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

    return (
        <div>
            <div className="flex justify-between items-center mb-4">
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
                        className="machine-btn text-[10px] bg-green-500/[0.06] border-green-500/20 text-green-400 hover:bg-green-500/[0.12]"
                    >✨ Create Provider</button>
                    <button onClick={fetchSettings} disabled={loading} className="machine-btn">
                        {loading ? '⏳ Loading...' : '↻ Refresh'}
                    </button>
                </div>
            </div>

            {/* Bulk Actions — only when filtering by category */}
            {filter !== 'all' && settings.filter(p => p.category === filter).length > 1 && (() => {
                const filtered = settings.filter(p => p.category === filter)
                // Find common boolean settings across all filtered providers
                const boolKeys = new Map<string, { label: string; onCount: number; total: number }>()
                for (const prov of filtered) {
                    for (const s of prov.schema) {
                        if (s.type !== 'boolean') continue
                        const existing = boolKeys.get(s.key)
                        const isOn = !!(prov.values[s.key] ?? s.default)
                        if (existing) {
                            existing.onCount += isOn ? 1 : 0
                            existing.total += 1
                        } else {
                            boolKeys.set(s.key, { label: s.label || s.key, onCount: isOn ? 1 : 0, total: 1 })
                        }
                    }
                }
                // Only show settings that exist in all filtered providers
                const commonKeys = [...boolKeys.entries()].filter(([, v]) => v.total === filtered.length)
                if (commonKeys.length === 0) return null

                const handleBulkToggle = async (key: string, value: boolean) => {
                    for (const prov of filtered) {
                        await handleSetSetting(prov.type, key, value)
                    }
                }

                return (
                    <div className="px-4 py-3 rounded-xl bg-violet-500/[0.04] border border-violet-500/10 mb-4">
                        <div className="text-[10px] text-violet-400 font-semibold uppercase tracking-wider mb-2">
                            Bulk — Apply to all {filter.toUpperCase()} providers ({filtered.length})
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {commonKeys.map(([key, info]) => {
                                const allOn = info.onCount === info.total
                                const allOff = info.onCount === 0
                                return (
                                    <div key={key} className="flex items-center gap-1.5 text-[11px]">
                                        <span className="text-text-secondary font-medium">{info.label}</span>
                                        <span className="text-[9px] text-text-muted">({info.onCount}/{info.total})</span>
                                        <button
                                            onClick={() => void handleBulkToggle(key, true)}
                                            disabled={allOn}
                                            className={`machine-btn text-[9px] px-1.5 py-px ${allOn ? 'opacity-40' : 'text-green-400 border-green-500/30'}`}
                                        >All ON</button>
                                        <button
                                            onClick={() => void handleBulkToggle(key, false)}
                                            disabled={allOff}
                                            className={`machine-btn text-[9px] px-1.5 py-px ${allOff ? 'opacity-40' : 'text-red-400 border-red-500/30'}`}
                                        >All OFF</button>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )
            })()}

            {loading && settings.length === 0 ? (
                <div className="p-10 text-center text-text-muted">Loading provider settings...</div>
            ) : (
                <div className="flex flex-col gap-2">
                    {settings
                        .filter(p => filter === 'all' || p.category === filter)
                        .map(prov => (
                        <div key={prov.type} className="px-4.5 py-3.5 rounded-xl bg-bg-secondary border border-border-subtle">
                            <div className="flex items-center gap-2 mb-2.5">
                                <span className="text-lg">{prov.icon}</span>
                                <span className="font-semibold text-[13px] text-text-primary">{prov.displayName}</span>
                                <span
                                    className="px-1.5 py-px rounded text-[9px] font-semibold"
                                    style={{
                                        background: prov.category === 'acp' ? 'rgba(139,92,246,0.08)' : prov.category === 'cli' ? 'rgba(59,130,246,0.08)' : prov.category === 'ide' ? 'rgba(34,197,94,0.08)' : 'color-mix(in srgb, var(--status-warning) 8%, transparent)',
                                        color: prov.category === 'acp' ? '#a78bfa' : prov.category === 'cli' ? '#60a5fa' : prov.category === 'ide' ? '#86efac' : 'var(--status-warning)',
                                    }}
                                >{prov.category}</span>
                                {prov.category === 'ide' && (
                                    <button
                                        onClick={() => setFixTarget(providers.find(p => p.type === prov.type) || {
                                            type: prov.type,
                                            name: prov.displayName,
                                            displayName: prov.displayName,
                                            icon: prov.icon,
                                            category: prov.category as 'ide' | 'cli' | 'acp' | 'extension',
                                        })}
                                        className="ml-auto machine-btn text-[9px] px-2 py-0.5 bg-violet-500/[0.06] border-violet-500/20 text-violet-400 hover:bg-violet-500/[0.12]"
                                    >🔧 Auto-Fix</button>
                                )}
                            </div>
                            <div className="flex flex-col gap-2">
                                {prov.schema.map(s => (
                                    <div key={s.key} className="flex items-center justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-text-primary">
                                                {s.label || s.key}
                                                {savingKey === `${prov.type}.${s.key}` && (
                                                    <span className="ml-1.5 text-[9px] text-violet-500">saving...</span>
                                                )}
                                            </div>
                                            {s.description && <div className="text-[10px] text-text-muted mt-px">{s.description}</div>}
                                        </div>
                                        <div className="shrink-0">
                                            {s.type === 'boolean' ? (
                                                <button
                                                    onClick={() => handleSetSetting(prov.type, s.key, !(prov.values[s.key] ?? s.default))}
                                                    className="w-10 h-[22px] rounded-[11px] border-none relative cursor-pointer transition-colors duration-200"
                                                    style={{ background: (prov.values[s.key] ?? s.default) ? '#8b5cf6' : 'var(--border-subtle)' }}
                                                >
                                                    <div
                                                        className="w-4 h-4 rounded-full bg-white absolute top-[3px] transition-[left] duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                                                        style={{ left: (prov.values[s.key] ?? s.default) ? 21 : 3 }}
                                                    />
                                                </button>
                                            ) : s.type === 'number' ? (
                                                <input
                                                    type="number"
                                                    value={Number(prov.values[s.key] ?? s.default ?? 0) || 0}
                                                    min={s.min}
                                                    max={s.max}
                                                    onChange={e => {
                                                        const v = parseInt(e.target.value) || 0;
                                                        if (s.min !== undefined && v < s.min) return;
                                                        if (s.max !== undefined && v > s.max) return;
                                                        handleSetSetting(prov.type, s.key, v);
                                                    }}
                                                    className="machine-input w-20 text-center text-[11px]"
                                                />
                                            ) : s.type === 'select' && s.options ? (
                                                <select
                                                    value={String(prov.values[s.key] ?? s.default ?? '')}
                                                    onChange={e => handleSetSetting(prov.type, s.key, e.target.value)}
                                                    className="machine-input text-[11px]"
                                                >
                                                    {s.options.map(o => <option key={o} value={o}>{o}</option>)}
                                                </select>
                                            ) : (
                                                <input
                                                    type="text"
                                                    value={String(prov.values[s.key] ?? s.default ?? '')}
                                                    onBlur={e => handleSetSetting(prov.type, s.key, e.target.value)}
                                                    className="machine-input w-[120px] text-[11px]"
                                                />
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Modals */}
            {fixTarget && (
                <ProviderFixModal
                    machineId={machineId}
                    provider={fixTarget}
                    sendDaemonCommand={sendDaemonCommand}
                    onClose={() => setFixTarget(null)}
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
