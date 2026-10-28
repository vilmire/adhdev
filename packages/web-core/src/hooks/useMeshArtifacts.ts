import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachmentMeta } from '@adhdev/daemon-core'
import { unwrapDaemonCommandBody } from '../utils/daemon-command-envelope'
import type { MeshArtifactSendCommand } from '../utils/mesh-artifact-fetch'

export const MESH_ARTIFACTS_PAGE_SIZE = 100

export interface UseMeshArtifactsOptions {
    meshId: string | null | undefined
    /** The mesh host (coordinator) daemon — the owner `artifact_list { meshId }` target. */
    hostDaemonId: string | null | undefined
    sendCommand: MeshArtifactSendCommand | null | undefined
    /** Load only while the tab is visible. */
    enabled: boolean
    /** Bumped by the host's Refresh control. */
    refreshToken?: number
}

export interface UseMeshArtifactsResult {
    attachments: ChatAttachmentMeta[]
    loading: boolean
    loadingMore: boolean
    error: string | null
    hasMore: boolean
    refresh: () => void
    loadMore: () => void
}

const EMPTY: ChatAttachmentMeta[] = []

function mergeById(older: ChatAttachmentMeta[], current: ChatAttachmentMeta[]): ChatAttachmentMeta[] {
    const seen = new Set(current.map(a => a.artifactId))
    return [...older.filter(a => !seen.has(a.artifactId)), ...current]
}

/**
 * Mesh-wide artifact metadata (no file content) for the Artifacts tab. Newest page
 * first; `loadMore` walks older pages through the daemon's keyset cursor.
 */
export function useMeshArtifacts({ meshId, hostDaemonId, sendCommand, enabled, refreshToken = 0 }: UseMeshArtifactsOptions): UseMeshArtifactsResult {
    // The list carries the scope (host+mesh) it was loaded for, so a different mesh's
    // artifacts are never rendered — not even for one frame before the reset effect runs.
    const scope = `${hostDaemonId ?? ''}|${meshId ?? ''}`
    const [data, setData] = useState<{ scope: string; list: ChatAttachmentMeta[] }>({ scope, list: [] })
    const attachments = data.scope === scope ? data.list : EMPTY
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [hasMore, setHasMore] = useState(false)
    const [nonce, setNonce] = useState(0)
    const cursorRef = useRef<string | null>(null)
    const seqRef = useRef(0)

    const request = useCallback(async (cursor: string | null) => {
        if (!meshId || !hostDaemonId || !sendCommand) throw new Error('no_host')
        const raw = await sendCommand(hostDaemonId, 'artifact_list', {
            meshId,
            limit: MESH_ARTIFACTS_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
        })
        const body = unwrapDaemonCommandBody<Record<string, unknown>>(raw)
        if (!body || body.success === false) {
            const reason = typeof body?.error === 'string' ? body.error : typeof body?.code === 'string' ? body.code : 'request_failed'
            throw new Error(reason)
        }
        const list = Array.isArray(body.attachments) ? (body.attachments as ChatAttachmentMeta[]) : []
        return {
            list,
            hasMore: body.hasMore === true,
            nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
        }
    }, [hostDaemonId, meshId, sendCommand])

    useEffect(() => {
        // Mesh/host switched: drop the previous list, errors and any in-flight page.
        seqRef.current += 1
        cursorRef.current = null
        setData({ scope, list: [] })
        setError(null)
        setHasMore(false)
        setLoading(false)
        setLoadingMore(false)
    }, [scope])

    useEffect(() => {
        if (!enabled || !meshId || !hostDaemonId || !sendCommand) return
        const seq = ++seqRef.current
        setLoading(true)
        setError(null)
        request(null).then(page => {
            if (seqRef.current !== seq) return
            cursorRef.current = page.nextCursor
            setData({ scope, list: page.list })
            setHasMore(page.hasMore)
        }).catch(err => {
            if (seqRef.current !== seq) return
            setError(err instanceof Error ? err.message : String(err))
        }).finally(() => {
            if (seqRef.current === seq) setLoading(false)
        })
    }, [enabled, hostDaemonId, meshId, nonce, refreshToken, request, scope, sendCommand])

    const loadMore = useCallback(() => {
        const cursor = cursorRef.current
        if (!cursor || loadingMore) return
        const seq = seqRef.current
        setLoadingMore(true)
        request(cursor).then(page => {
            if (seqRef.current !== seq) return
            cursorRef.current = page.nextCursor
            setData(current => (current.scope === scope ? { scope, list: mergeById(page.list, current.list) } : current))
            setHasMore(page.hasMore)
        }).catch(err => {
            if (seqRef.current === seq) setError(err instanceof Error ? err.message : String(err))
        }).finally(() => setLoadingMore(false))
    }, [loadingMore, request, scope])

    const refresh = useCallback(() => setNonce(n => n + 1), [])
    return { attachments, loading, loadingMore, error, hasMore, refresh, loadMore }
}
