/**
 * Dashboard access to release objects (design 2026-11-01-release-objects §7). One hook per mesh
 * Overview: it lists the mesh's releases through the hosting daemon's `release_list`, exposes
 * the writes (`release_upsert` / `release_scope` / ...), and shares a mission -> release map with
 * the mission rows through a context so a mission card can show its release badge without a
 * request of its own. An older daemon (no `release_list`) leaves `list` null and the UI hidden.
 *
 * Membership is only ever what a person set here or a coordinator set through the tools: nothing
 * in the dashboard adds a mission on its own — suggestions carry an explicit "Add" button.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseReleaseDetail, parseReleaseList, type ReleaseDetailView, type ReleaseListView } from './releases-model'

type Send = (daemonId: string, type: string, data?: Record<string, unknown>) => Promise<any>

export interface ReleasesApi {
    /** null = not loaded or the daemon has no release support (hide the UI). */
    list: ReleaseListView | null
    busy: boolean
    error: string | null
    reload: () => Promise<void>
    loadDetail: (releaseId: string, include?: string[]) => Promise<ReleaseDetailView | null>
    create: (name: string, channel: 'preview' | 'stable') => Promise<boolean>
    setStatus: (releaseId: string, status: string) => Promise<boolean>
    scope: (releaseId: string, change: { add?: string[]; remove?: string[]; move?: Array<{ missionId: string; toReleaseId: string }> }) => Promise<boolean>
    draft: (releaseId: string) => Promise<ReleaseDetailView | null>
}

function failureText(raw: unknown): string | null {
    const body = raw && typeof raw === 'object' ? ((raw as any).result ?? raw) as Record<string, any> : null
    if (!body) return 'no answer'
    return body.success === false ? String(body.error ?? body.code ?? 'failed').slice(0, 200) : null
}

export function useReleases(target: { daemonId?: string | null; meshId?: string | null; send?: Send | null }): ReleasesApi {
    const { daemonId, meshId } = target
    const sendRef = useRef(target.send ?? null)
    sendRef.current = target.send ?? null
    const [list, setList] = useState<ReleaseListView | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const seq = useRef(0)

    const call = useCallback(async (type: string, data: Record<string, unknown>): Promise<unknown> => {
        if (!daemonId || !meshId || !sendRef.current) throw new Error('no daemon connection')
        return sendRef.current(daemonId, type, { meshId, ...data })
    }, [daemonId, meshId])

    const reload = useCallback(async () => {
        if (!daemonId || !meshId || !sendRef.current) return
        const mine = ++seq.current
        try {
            const raw = await call('release_list', {})
            if (mine === seq.current) setList(parseReleaseList(raw))
        } catch {
            if (mine === seq.current) setList(null) // older daemon / offline: the card simply stays hidden
        }
    }, [call, daemonId, meshId])
    useEffect(() => { void reload() }, [reload])

    const write = useCallback(async (type: string, data: Record<string, unknown>): Promise<boolean> => {
        setBusy(true)
        setError(null)
        try {
            const raw = await call(type, data)
            const failed = failureText(raw)
            if (failed) { setError(failed); return false }
            await reload()
            return true
        } catch (e: any) {
            setError(String(e?.message ?? e).slice(0, 200))
            return false
        } finally {
            setBusy(false)
        }
    }, [call, reload])

    return useMemo<ReleasesApi>(() => ({
        list, busy, error, reload,
        loadDetail: async (releaseId, include = ['git', 'changelog']) => {
            try { return parseReleaseDetail(await call('release_list', { releaseId, include })) } catch { return null }
        },
        create: (name, channel) => write('release_upsert', { name, channel }),
        setStatus: (releaseId, status) => write('release_upsert', { releaseId, status }),
        scope: (releaseId, change) => write('release_scope', { releaseId, ...change }),
        draft: async (releaseId) => {
            setBusy(true)
            setError(null)
            try {
                const raw = await call('release_changelog_draft', { releaseId })
                const failed = failureText(raw)
                if (failed) { setError(failed); return null }
                return parseReleaseDetail(await call('release_list', { releaseId, include: ['git', 'changelog'] }))
            } catch (e: any) {
                setError(String(e?.message ?? e).slice(0, 200))
                return null
            } finally {
                setBusy(false)
            }
        },
    }), [list, busy, error, reload, call, write])
}

const ReleasesContext = createContext<ReleasesApi | null>(null)

export function ReleasesProvider({ value, children }: { value: ReleasesApi; children: ReactNode }) {
    return <ReleasesContext.Provider value={value}>{children}</ReleasesContext.Provider>
}

/** The release API shared by the Overview, or null outside a provider / on an older daemon. */
export function useReleasesContext(): ReleasesApi | null {
    return useContext(ReleasesContext)
}
