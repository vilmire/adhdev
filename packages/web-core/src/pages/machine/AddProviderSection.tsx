/**
 * AddProviderSection — registry catalog browser for the Burrow > Providers tab.
 *
 * The user picks which providers their daemon should support. Clicking
 * Install sends `install_provider_manifest` (over the same sendDaemonCommand
 * channel ProvidersTab already uses), which writes the manifest to
 * ~/.adhdev/marketplace/{category}/{type}/provider.json on the daemon's
 * machine. After install the daemon reloads its provider list, and the
 * provider appears in the Installed section above this one (parent component
 * refetches on the onInstalled callback).
 *
 * Layout matches the existing ProvidersTab tokens:
 *   - rounded-xl
 *   - bg-bg-secondary / border-border-subtle
 *   - text-text-primary / text-text-muted
 *   - machine-btn class for action buttons
 *
 * Discovery: search + category filter + sort (popular / newest / name) +
 * paginated list. The registry endpoint is determined at runtime — in dev the
 * vite proxy `/registry/*` forwards to production; in production builds the
 * env var REGISTRY_BASE can override; otherwise falls back to the production
 * URL.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'

interface ProviderMeta {
    id: string
    type: string
    category: string
    version: string
    name: string
    displayName: string
    tier: 'verified' | 'declarative-only' | 'extended' | 'extended-legacy'
    taintLevel: 'clean' | 'elevated' | 'hostile'
    schemaValid: boolean
    checksum: string
    publishedAt: string
    downloadCount?: number
    manifest: ProviderManifest
}

interface ProviderManifest {
    icon?: string
    status?: string
    details?: string
    binary?: string
    links?: {
        homepage?: string; repo?: string; docs?: string; install?: string; issues?: string
    }
    [k: string]: unknown
}

type Category = 'all' | 'cli' | 'ide' | 'extension' | 'acp'
type Sort = 'popular' | 'newest' | 'name'

const PAGE_SIZE = 24

const TIER_LABELS: Record<string, string> = {
    'verified': 'Verified',
    'declarative-only': 'Declarative',
    'extended': 'Extended',
    'extended-legacy': 'Legacy',
}

const CATEGORY_LABEL: Record<string, string> = {
    cli: 'CLI', ide: 'IDE', extension: 'EXT', acp: 'ACP',
}

interface AddProviderSectionProps {
    machineId: string
    /**
     * Same send function ProvidersTab uses. We invoke
     * `install_provider_manifest` over it. Returns the standard
     * `{ success, ...payload }` envelope.
     */
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    /**
     * Types already installed on the daemon (from list_installed_providers
     * or the parent's existing providers prop). Used to grey out cards that
     * are already installed.
     */
    installedTypes: Set<string>
    /**
     * Called after a successful install/uninstall so the parent can refetch
     * its settings + provider list.
     */
    onInstalled?: () => void
}

function getRegistryBase(): string {
    if (typeof window === 'undefined') return 'https://api.adhf.dev/api/v1/registry'
    const host = window.location.hostname
    const port = window.location.port
    // Standalone daemon serves the UI itself on port 3847 (or whatever was
    // configured) and does NOT proxy /registry. Detect it explicitly and go
    // straight to the production registry over CORS. Without this check we
    // hit the SPA's catch-all index.html and JSON.parse blows up with
    // "The string did not match the expected pattern" — which is what users
    // were seeing when they clicked Add Provider in standalone mode.
    if (port === '3847') return 'https://api.adhf.dev/api/v1/registry'
    // Cloud dev (vite proxy at :3000): /registry → upstream API.
    if (host === 'localhost' || host === '127.0.0.1') return '/registry'
    // Production cloud dashboard → production API.
    if (host === 'adhf.dev' || host === 'adhdev-web.pages.dev') {
        return 'https://api.adhf.dev/api/v1/registry'
    }
    // Preview cloud dashboard (dev.adhf.dev) and any other host → preview API.
    // Keeps preview isolated from production data and avoids cross-origin
    // failure when the dashboard is served from a non-production host.
    return 'https://api-preview.adhf.dev/api/v1/registry'
}

export default function AddProviderSection({
    machineId,
    sendDaemonCommand,
    installedTypes,
    onInstalled,
}: AddProviderSectionProps) {
    const [expanded, setExpanded] = useState(false)
    const [providers, setProviders] = useState<ProviderMeta[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [category, setCategory] = useState<Category>('all')
    const [search, setSearch] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [sort, setSort] = useState<Sort>('popular')
    const [offset, setOffset] = useState(0)
    const [installing, setInstalling] = useState<Set<string>>(new Set())
    const [installError, setInstallError] = useState<{ type: string; message: string } | null>(null)
    const sentinelRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search), 250)
        return () => clearTimeout(t)
    }, [search])

    useEffect(() => { setOffset(0) }, [category, sort, debouncedSearch])

    const buildUrl = useCallback((nextOffset: number) => {
        const base = getRegistryBase()
        const url = new URL(`${base}/providers`, window.location.origin)
        if (category !== 'all') url.searchParams.set('category', category)
        if (debouncedSearch) url.searchParams.set('search', debouncedSearch)
        url.searchParams.set('sort', sort)
        url.searchParams.set('limit', String(PAGE_SIZE))
        url.searchParams.set('offset', String(nextOffset))
        return url.toString()
    }, [category, debouncedSearch, sort])

    useEffect(() => {
        if (!expanded) return
        setLoading(true); setError(null)
        let cancelled = false
        fetch(buildUrl(0))
            .then(async r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                // The dashboard's SPA fallback returns index.html on any
                // unknown route, so an HTML response here means the request
                // went to the daemon's static-file server (or any other
                // non-registry origin) instead of an actual registry.
                // JSON.parse on HTML would surface as the deeply unhelpful
                // "did not match the expected pattern" Safari/Webkit message.
                const ct = r.headers.get('content-type') || ''
                if (!ct.includes('json')) {
                    throw new Error(`registry returned ${ct || 'unknown'} (expected JSON). Check that the registry endpoint is reachable from this host.`)
                }
                return r.json()
            })
            .then((data: { providers: ProviderMeta[]; total?: number }) => {
                if (cancelled) return
                setProviders(data.providers ?? [])
                setTotal(data.total ?? (data.providers?.length ?? 0))
                setOffset(PAGE_SIZE)
            })
            .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [buildUrl, expanded])

    useEffect(() => {
        if (!expanded) return
        const node = sentinelRef.current
        if (!node) return
        const obs = new IntersectionObserver(async (entries) => {
            if (!entries[0]?.isIntersecting) return
            if (loading || loadingMore) return
            if (providers.length >= total) return
            setLoadingMore(true)
            try {
                const resp = await fetch(buildUrl(offset))
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
                const ct = resp.headers.get('content-type') || ''
                if (!ct.includes('json')) throw new Error(`registry returned ${ct || 'unknown'}`)
                const data = await resp.json() as { providers: ProviderMeta[]; total?: number }
                setProviders(prev => [...prev, ...(data.providers ?? [])])
                setTotal(data.total ?? total)
                setOffset(o => o + PAGE_SIZE)
            } catch { /* silent */ }
            finally { setLoadingMore(false) }
        }, { rootMargin: '200px' })
        obs.observe(node)
        return () => obs.disconnect()
    }, [expanded, buildUrl, offset, providers.length, total, loading, loadingMore])

    const handleInstall = useCallback(async (provider: ProviderMeta) => {
        if (installing.has(provider.type)) return
        setInstallError(null)
        setInstalling(prev => new Set(prev).add(provider.type))
        try {
            const res = await sendDaemonCommand(machineId, 'install_provider_manifest', { type: provider.type })
            const ok = res?.success ?? res?.result?.success
            if (!ok) {
                const msg = res?.error ?? res?.result?.error ?? 'install failed'
                throw new Error(msg)
            }
            onInstalled?.()
        } catch (e) {
            setInstallError({ type: provider.type, message: e instanceof Error ? e.message : String(e) })
        } finally {
            setInstalling(prev => {
                const next = new Set(prev)
                next.delete(provider.type)
                return next
            })
        }
    }, [installing, machineId, sendDaemonCommand, onInstalled])

    const categories: { key: Category; label: string }[] = [
        { key: 'all', label: 'All' },
        { key: 'cli', label: 'CLI' },
        { key: 'ide', label: 'IDE' },
        { key: 'extension', label: 'Extension' },
        { key: 'acp', label: 'ACP' },
    ]
    const sorts: { key: Sort; label: string }[] = [
        { key: 'popular', label: 'Popular' },
        { key: 'newest', label: 'Newest' },
        { key: 'name', label: 'Name' },
    ]

    const visible = useMemo(() => providers, [providers])

    return (
        <div className="px-4.5 py-3.5 rounded-xl bg-bg-secondary border border-border-subtle mb-4">
            <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center justify-between w-full text-left gap-3"
            >
                <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-400">Add provider</div>
                    <div className="text-[11px] text-text-muted mt-1">
                        Browse the registry and install provider manifests on this daemon.
                    </div>
                </div>
                <span className="text-text-muted text-xs">{expanded ? '▾' : '▸'}</span>
            </button>

            {expanded && (
                <div className="mt-3 flex flex-col gap-3">
                    {/* Filters */}
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex gap-1 flex-wrap">
                            {categories.map(c => (
                                <button
                                    key={c.key}
                                    onClick={() => setCategory(c.key)}
                                    className={`machine-btn text-[10px] px-2 py-0.5 ${
                                        category === c.key ? 'bg-violet-500/15 border-violet-500/40 text-violet-400' : ''
                                    }`}
                                >{c.label}</button>
                            ))}
                        </div>
                        <div className="flex gap-1.5 sm:ml-auto items-center">
                            <select
                                value={sort}
                                onChange={e => setSort(e.target.value as Sort)}
                                className="machine-input text-[11px]"
                            >
                                {sorts.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                            </select>
                            <input
                                type="text"
                                placeholder="Search…"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="machine-input text-[11px] min-w-[140px]"
                            />
                        </div>
                    </div>

                    {/* Status line */}
                    {loading && (
                        <div className="text-text-muted text-[11px] py-6 text-center">Loading registry…</div>
                    )}
                    {!loading && error && (
                        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-400">
                            Failed to load registry: {error}
                        </div>
                    )}
                    {!loading && !error && visible.length === 0 && (
                        <div className="text-text-muted text-[11px] py-6 text-center">
                            {debouncedSearch ? `No providers matching "${debouncedSearch}".` : 'No providers found.'}
                        </div>
                    )}

                    {/* Grid */}
                    {!loading && !error && visible.length > 0 && (
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                            {visible.map(p => {
                                const installed = installedTypes.has(p.type)
                                const busy = installing.has(p.type)
                                const m = p.manifest
                                const icon = typeof m.icon === 'string' ? m.icon : '📦'
                                const details = typeof m.details === 'string' ? m.details : ''
                                const links = m.links ?? {}
                                const primaryLink = links.docs || links.homepage || links.repo
                                return (
                                    <div
                                        key={p.id}
                                        className="rounded-xl border border-border-subtle bg-bg-glass px-3 py-2.5 flex flex-col gap-2"
                                    >
                                        <div className="flex items-start gap-2">
                                            <span className="text-base shrink-0">{icon}</span>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[12px] font-semibold text-text-primary truncate">
                                                    {p.displayName}
                                                </div>
                                                {details && (
                                                    <div className="text-[10px] text-text-muted truncate">{details}</div>
                                                )}
                                            </div>
                                            <div className="shrink-0">
                                                {installed ? (
                                                    <span className="text-[9px] px-1.5 py-px rounded border bg-green-500/10 border-green-500/25 text-green-400 font-semibold">
                                                        Installed
                                                    </span>
                                                ) : (
                                                    <button
                                                        onClick={() => void handleInstall(p)}
                                                        disabled={busy}
                                                        className="machine-btn text-[10px] px-2 py-0.5 bg-violet-500/[0.08] border-violet-500/30 text-violet-300 hover:bg-violet-500/[0.16]"
                                                    >{busy ? '…' : 'Install'}</button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-1 items-center text-[9px]">
                                            <span className="px-1.5 py-px rounded border border-border-subtle text-text-muted">{CATEGORY_LABEL[p.category] ?? p.category}</span>
                                            <span className="px-1.5 py-px rounded border border-border-subtle text-text-muted">{TIER_LABELS[p.tier] ?? p.tier}</span>
                                            <span className="text-text-muted">v{p.version}</span>
                                            <span className="text-text-muted ml-auto">⬇ {(p.downloadCount ?? 0).toLocaleString()}</span>
                                            {primaryLink && (
                                                <a
                                                    href={primaryLink}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-violet-400 hover:text-violet-300 ml-1"
                                                    onClick={(e) => e.stopPropagation()}
                                                >↗</a>
                                            )}
                                        </div>
                                        {installError?.type === p.type && (
                                            <div className="text-[10px] text-red-400 break-all">{installError.message}</div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    {/* Sentinel + footer */}
                    {!loading && !error && (
                        <>
                            <div ref={sentinelRef} className="h-1" />
                            <div className="text-[10px] text-text-muted text-center">
                                {loadingMore
                                    ? 'Loading more…'
                                    : `${visible.length} of ${total} provider${total !== 1 ? 's' : ''}`}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
