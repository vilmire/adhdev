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

function mergeById(older: ChatAttachmentMeta[], current: ChatAttachmentMeta[]): ChatAttachmentMeta[] {
    const seen = new Set(current.map(a => a.artifactId))
    return [...older.filter(a => !seen.has(a.artifactId)), ...current]
}

/**
 * Mesh-wide artifact metadata (no file content) for the Artifacts tab. Newest page
 * first; `loadMore` walks older pages through the daemon's keyset cursor.
 */
export function useMeshArtifacts({ meshId, hostDaemonId, sendCommand, enabled, refreshToken = 0 }: UseMeshArtifactsOptions): UseMeshArtifactsResult {
    const [attachments, setAttachments] = useState<ChatAttachmentMeta[]>([])
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
        if (!enabled || !meshId || !hostDaemonId || !sendCommand) return
        const seq = ++seqRef.current
        setLoading(true)
        setError(null)
        request(null).then(page => {
            if (seqRef.current !== seq) return
            cursorRef.current = page.nextCursor
            setAttachments(page.list)
            setHasMore(page.hasMore)
        }).catch(err => {
            if (seqRef.current !== seq) return
            setError(err instanceof Error ? err.message : String(err))
        }).finally(() => {
            if (seqRef.current === seq) setLoading(false)
        })
    }, [enabled, hostDaemonId, meshId, nonce, refreshToken, request, sendCommand])

    const loadMore = useCallback(() => {
        const cursor = cursorRef.current
        if (!cursor || loadingMore) return
        const seq = seqRef.current
        setLoadingMore(true)
        request(cursor).then(page => {
            if (seqRef.current !== seq) return
            cursorRef.current = page.nextCursor
            setAttachments(current => mergeById(page.list, current))
            setHasMore(page.hasMore)
        }).catch(err => {
            if (seqRef.current === seq) setError(err instanceof Error ? err.message : String(err))
        }).finally(() => setLoadingMore(false))
    }, [loadingMore, request])

    const refresh = useCallback(() => setNonce(n => n + 1), [])
    return { attachments, loading, loadingMore, error, hasMore, refresh, loadMore }
}
