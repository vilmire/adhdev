/**
 * SourcesPanel — manage external provider sources from the dashboard.
 *
 * Lists the user-added 3rd-party git URLs (via `list_provider_sources`),
 * surfaces per-source provider counts, flags type-level conflicts when
 * 2+ sources expose the same provider type, and exposes an add/remove
 * affordance. Sits inside ProvidersTab between the official catalog
 * and the installed-providers list.
 */
import { useCallback, useEffect, useState } from 'react'

interface Source {
    name: string
    url: string
    ref: string
    addedAt: string
    providers: Record<string, string[]>
}

interface Conflict {
    type: string
    category: string
    candidates: string[]
    active: string | null
}

interface SourcesPanelProps {
    machineId: string
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onChange?: () => void
}

function unwrap(raw: any) {
    return (raw && typeof raw === 'object' && raw.result && typeof raw.result === 'object') ? raw.result : raw
}

export default function SourcesPanel({ machineId, sendDaemonCommand, onChange }: SourcesPanelProps) {
    const [sources, setSources] = useState<Source[]>([])
    const [conflicts, setConflicts] = useState<Conflict[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [addOpen, setAddOpen] = useState(false)
    const [addUrl, setAddUrl] = useState('')
    const [addRef, setAddRef] = useState('main')
    const [addName, setAddName] = useState('')
    const [adding, setAdding] = useState(false)
    const [removingName, setRemovingName] = useState<string | null>(null)
    const [settingActive, setSettingActive] = useState<string | null>(null)

    const load = useCallback(async () => {
        if (!machineId) return
        setLoading(true)
        setError(null)
        try {
            const r = unwrap(await sendDaemonCommand(machineId, 'list_provider_sources', {}))
            if (!r?.success) {
                setError(r?.error || 'Failed to load sources')
                return
            }
            setSources(r.sources || [])
            setConflicts(r.conflicts || [])
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setLoading(false)
        }
    }, [machineId, sendDaemonCommand])

    useEffect(() => { void load() }, [load])

    const add = async () => {
        if (!addUrl.trim()) return
        setAdding(true)
        setError(null)
        try {
            const r = unwrap(await sendDaemonCommand(machineId, 'add_provider_source', {
                url: addUrl.trim(),
                ref: addRef.trim() || 'main',
                ...(addName.trim() ? { name: addName.trim() } : {}),
            }))
            if (!r?.success) {
                setError(r?.error || 'Failed to add source')
            } else {
                setAddOpen(false); setAddUrl(''); setAddRef('main'); setAddName('')
                await load()
                onChange?.()
            }
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setAdding(false)
        }
    }

    const remove = async (name: string) => {
        if (!confirm(`Remove provider source ${name}? This deletes the cloned manifests and clears any active-source entries that pointed here.`)) return
        setRemovingName(name)
        setError(null)
        try {
            const r = unwrap(await sendDaemonCommand(machineId, 'remove_provider_source', { name }))
            if (!r?.success) setError(r?.error || 'Failed to remove source')
            else { await load(); onChange?.() }
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setRemovingName(null)
        }
    }

    const setActive = async (type: string, sourceName: string) => {
        setSettingActive(`${type}:${sourceName}`)
        setError(null)
        try {
            const r = unwrap(await sendDaemonCommand(machineId, 'set_active_provider_source', { type, sourceName }))
            if (!r?.success) setError(r?.error || 'Failed to set active source')
            else { await load(); onChange?.() }
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setSettingActive(null)
        }
    }

    return (
        <div className="px-4.5 py-3.5 rounded-xl bg-bg-secondary border border-border-subtle">
            <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-sky-400">External sources</div>
                    <div className="text-[11px] text-text-muted mt-1">
                        3rd-party git URLs you've added. Providers here may ship JavaScript the daemon will execute — activation requires a confirmation.
                    </div>
                </div>
                <div className="flex gap-1.5">
                    <button onClick={() => void load()} disabled={loading} className="machine-btn text-[10px]">{loading ? '⏳' : '↻'} Refresh</button>
                    <button onClick={() => setAddOpen(true)} className="machine-btn text-[10px] bg-sky-500/[0.08] border-sky-500/20 text-sky-300 hover:bg-sky-500/[0.14]">+ Add source</button>
                </div>
            </div>

            {error && <div className="mb-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">{error}</div>}

            {sources.length === 0 ? (
                <div className="text-[11px] text-text-muted italic">No external sources registered. Use "+ Add source" to register a 3rd-party provider git URL.</div>
            ) : (
                <ul className="flex flex-col gap-2">
                    {sources.map(s => (
                        <li key={s.name} className="rounded border border-border-subtle bg-bg-primary/40 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="font-mono text-[12px] text-text-primary">{s.name}</div>
                                    <div className="text-[10px] text-text-muted truncate">{s.url} <span className="opacity-60">@ {s.ref}</span></div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void remove(s.name)}
                                    disabled={removingName === s.name}
                                    className="machine-btn text-[10px] text-red-400 hover:bg-red-500/[0.10]"
                                >{removingName === s.name ? '…' : 'Remove'}</button>
                            </div>
                            <div className="mt-1.5 text-[10px] text-text-muted">
                                {Object.entries(s.providers).map(([cat, types]) => (
                                    <span key={cat} className="mr-3"><span className="text-text-secondary">{cat}:</span> {types.length}</span>
                                ))}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {conflicts.length > 0 && (
                <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
                    <div className="text-[11px] font-semibold text-amber-300 mb-1.5">Conflicts</div>
                    <div className="text-[10px] text-text-muted mb-2">
                        Multiple sources expose the same provider type. Pick which source's copy should be active.
                    </div>
                    <ul className="flex flex-col gap-1.5">
                        {conflicts.map(c => (
                            <li key={c.type} className="flex items-center justify-between gap-2">
                                <div className="font-mono text-[11px]">{c.type} <span className="text-text-muted">({c.category})</span></div>
                                <div className="flex gap-1.5 flex-wrap">
                                    {c.candidates.map(cand => (
                                        <button
                                            key={cand}
                                            type="button"
                                            onClick={() => void setActive(c.type, cand)}
                                            disabled={settingActive === `${c.type}:${cand}`}
                                            className={`text-[10px] px-2 py-0.5 rounded border ${
                                                c.active === cand
                                                    ? 'bg-amber-500/[0.18] border-amber-500/40 text-amber-200'
                                                    : 'border-border-subtle text-text-secondary hover:bg-amber-500/[0.06]'
                                            }`}
                                            title={c.active === cand ? 'Active' : `Switch active to ${cand}`}
                                        >
                                            {c.active === cand ? '● ' : ''}{cand}
                                        </button>
                                    ))}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {addOpen && (
                <div className="mt-3 rounded border border-sky-500/30 bg-sky-500/[0.06] px-3 py-3">
                    <div className="text-[11px] font-semibold text-sky-300 mb-2">Add external source</div>
                    <div className="grid md:grid-cols-3 gap-2">
                        <label className="flex flex-col gap-1 text-[10px] text-text-secondary md:col-span-3">
                            <span>Git URL</span>
                            <input
                                type="text"
                                value={addUrl}
                                onChange={e => setAddUrl(e.target.value)}
                                placeholder="https://github.com/vendor/extra-providers"
                                className="machine-input text-[11px] font-mono"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] text-text-secondary">
                            <span>Ref (branch/tag)</span>
                            <input
                                type="text"
                                value={addRef}
                                onChange={e => setAddRef(e.target.value)}
                                placeholder="main"
                                className="machine-input text-[11px]"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] text-text-secondary md:col-span-2">
                            <span>Name (optional, auto-derived from URL)</span>
                            <input
                                type="text"
                                value={addName}
                                onChange={e => setAddName(e.target.value)}
                                placeholder="@vendor-extra-providers"
                                className="machine-input text-[11px] font-mono"
                            />
                        </label>
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                        <button type="button" onClick={() => setAddOpen(false)} className="machine-btn text-[10px]">Cancel</button>
                        <button
                            type="button"
                            onClick={() => void add()}
                            disabled={adding || !addUrl.trim()}
                            className="machine-btn text-[10px] bg-sky-500/[0.10] border-sky-500/30 text-sky-200 hover:bg-sky-500/[0.18]"
                        >{adding ? 'Cloning…' : 'Clone + register'}</button>
                    </div>
                </div>
            )}
        </div>
    )
}
