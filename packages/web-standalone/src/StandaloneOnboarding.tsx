/**
 * StandaloneOnboarding — first-boot dialog for selecting which providers to
 * install on a fresh daemon.
 *
 * Trigger: shown once when the daemon has 0 installed providers AND
 * localStorage.adhdev_onboarding_done is unset. The user can also dismiss
 * to come back later via Burrow > Providers > Add provider.
 *
 * Default selection: the 4 officially supported CLI providers — Claude Code,
 * Codex, Antigravity, Hermes. Everything else stays unchecked.
 *
 * Install uses the daemon's install_provider_manifest command (POSTed
 * through the localhost HTTP API, same path /api/v1/providers/install
 * the curl test surface uses).
 */
import { useState, useEffect, useCallback } from 'react'

const DEFAULTS = ['claude-cli', 'codex-cli', 'antigravity-cli', 'hermes-cli']

interface RegistryProvider {
    type: string
    category: string
    displayName: string
    manifest?: { icon?: string; details?: string }
}

interface InstallResult {
    type: string
    ok: boolean
    error?: string
}

interface StandaloneOnboardingProps {
    /** Called after the dialog is dismissed (success or skip). */
    onDone: () => void
}

const STORAGE_KEY = 'adhdev_onboarding_done'

type CategoryFilter = 'all' | 'cli' | 'ide' | 'extension' | 'acp'

const CATEGORY_TABS: { key: CategoryFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'cli', label: 'CLI' },
    { key: 'ide', label: 'IDE' },
    { key: 'extension', label: 'Extension' },
    { key: 'acp', label: 'ACP' },
]

const CATEGORY_GROUP_LABEL: Record<string, string> = {
    cli: 'CLI providers',
    ide: 'IDE providers',
    extension: 'Editor extensions',
    acp: 'ACP providers',
}

export default function StandaloneOnboarding({ onDone }: StandaloneOnboardingProps) {
    const [providers, setProviders] = useState<RegistryProvider[]>([])
    const [selected, setSelected] = useState<Set<string>>(new Set(DEFAULTS))
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [installing, setInstalling] = useState(false)
    const [results, setResults] = useState<InstallResult[] | null>(null)
    const [filter, setFilter] = useState<CategoryFilter>('all')

    // Load the full registry catalog (all categories). Defaults stay CLI-only
    // (claude/codex/antigravity/hermes); IDE / ACP / extension entries are
    // off by default and the user opts in.
    useEffect(() => {
        let cancelled = false
        const REGISTRY = window.location.hostname === 'localhost'
            ? '/registry'
            : 'https://api.adhf.dev/api/v1/registry'
        fetch(`${REGISTRY}/providers?sort=popular&limit=100`)
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
            .then((data: { providers: RegistryProvider[] }) => {
                if (cancelled) return
                setProviders(data.providers ?? [])
            })
            .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    // Filtered + grouped view of the catalog.
    const visible = providers.filter(p => filter === 'all' || p.category === filter)
    const groups = (['cli', 'ide', 'extension', 'acp'] as const)
        .map(cat => ({ category: cat, items: visible.filter(p => p.category === cat) }))
        .filter(g => g.items.length > 0)

    const toggle = useCallback((type: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(type)) next.delete(type)
            else next.add(type)
            return next
        })
    }, [])

    const handleInstall = useCallback(async () => {
        if (selected.size === 0) {
            // Nothing to install — dismiss
            localStorage.setItem(STORAGE_KEY, '1')
            onDone()
            return
        }
        setInstalling(true)
        const out: InstallResult[] = []
        for (const type of selected) {
            try {
                const res = await fetch('/api/v1/providers/install', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type }),
                })
                const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
                out.push({ type, ok: !!body.success, error: body.error })
            } catch (e) {
                out.push({ type, ok: false, error: e instanceof Error ? e.message : String(e) })
            }
        }
        setResults(out)
        setInstalling(false)
        // If all succeeded, persist and dismiss. If some failed, keep dialog
        // open so user can retry; clicking Done from there will close.
        if (out.every(r => r.ok)) {
            localStorage.setItem(STORAGE_KEY, '1')
        }
    }, [selected, onDone])

    const handleSkip = useCallback(() => {
        localStorage.setItem(STORAGE_KEY, '1')
        onDone()
    }, [onDone])

    const handleClose = useCallback(() => {
        // Only fully close after a successful install or explicit skip.
        if (results && results.every(r => r.ok)) {
            onDone()
        } else if (!installing) {
            handleSkip()
        }
    }, [results, installing, onDone, handleSkip])

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={handleClose}>
            <div
                className="bg-bg-secondary border border-border-subtle rounded-2xl max-w-2xl w-full p-6 flex flex-col gap-5 max-h-[85vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div>
                    <div className="text-lg font-semibold text-text-primary">Welcome to ADHDev</div>
                    <div className="text-[12px] text-text-muted mt-1">
                        Pick the providers you want to use. Defaults to the four officially supported CLI
                        providers; you can install IDE, ACP, or extension providers from the tabs below or
                        later from <span className="text-text-secondary">Burrow → Providers → Add provider</span>.
                    </div>
                </div>

                {/* Category tabs */}
                {!loading && !error && providers.length > 0 && (
                    <div className="flex gap-1 flex-wrap border-b border-border-subtle pb-2">
                        {CATEGORY_TABS.map(t => {
                            const count = t.key === 'all'
                                ? providers.length
                                : providers.filter(p => p.category === t.key).length
                            if (count === 0 && t.key !== 'all') return null
                            return (
                                <button
                                    key={t.key}
                                    onClick={() => setFilter(t.key)}
                                    className={`machine-btn text-[10px] px-2 py-0.5 ${
                                        filter === t.key ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                                    }`}
                                >{t.label} <span className="opacity-60">({count})</span></button>
                            )
                        })}
                    </div>
                )}

                {/* Catalog */}
                {loading && (
                    <div className="text-text-muted text-[12px] py-8 text-center">Loading registry…</div>
                )}
                {!loading && error && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-400">
                        Failed to load registry: {error}
                    </div>
                )}
                {!loading && !error && visible.length === 0 && (
                    <div className="text-text-muted text-[12px] py-8 text-center">No providers in this category.</div>
                )}
                {!loading && !error && visible.length > 0 && (
                    <div className="flex flex-col gap-4">
                        {groups.map(group => (
                            <div key={group.category}>
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
                                    {CATEGORY_GROUP_LABEL[group.category] ?? group.category}
                                </div>
                                <div className="grid gap-1.5">
                                    {group.items.map(p => {
                                        const isSelected = selected.has(p.type)
                                        const result = results?.find(r => r.type === p.type)
                                        const icon = p.manifest?.icon ?? '📦'
                                        const details = p.manifest?.details ?? ''
                                        return (
                                            <label
                                                key={p.type}
                                                className={`flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                                                    isSelected
                                                        ? 'bg-violet-500/[0.06] border-violet-500/30'
                                                        : 'bg-bg-glass border-border-subtle hover:bg-bg-glass-hover'
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => toggle(p.type)}
                                                    disabled={installing}
                                                    className="shrink-0"
                                                />
                                                <span className="text-base shrink-0">{icon}</span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[13px] font-medium text-text-primary truncate">{p.displayName}</div>
                                                    {details && (
                                                        <div className="text-[10px] text-text-muted truncate">{details}</div>
                                                    )}
                                                </div>
                                                {result && (
                                                    <span className={`text-[10px] font-semibold ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
                                                        {result.ok ? '✓ installed' : `✗ ${result.error ?? 'failed'}`}
                                                    </span>
                                                )}
                                            </label>
                                        )
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2 border-t border-border-subtle">
                    <div className="text-[11px] text-text-muted">
                        {selected.size} provider{selected.size !== 1 ? 's' : ''} selected
                    </div>
                    <div className="ml-auto flex gap-2">
                        <button
                            onClick={handleSkip}
                            disabled={installing}
                            className="machine-btn text-[11px] px-3 py-1"
                        >Skip</button>
                        <button
                            onClick={() => {
                                if (results) {
                                    // Already installed; just close.
                                    localStorage.setItem(STORAGE_KEY, '1')
                                    onDone()
                                } else {
                                    void handleInstall()
                                }
                            }}
                            disabled={installing || (!results && selected.size === 0)}
                            className="machine-btn text-[11px] px-3 py-1 bg-violet-500/15 border-violet-500/40 text-violet-400 hover:bg-violet-500/25"
                        >
                            {installing ? 'Installing…' : results ? 'Done' : `Install ${selected.size}`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export function hasCompletedOnboarding(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}
