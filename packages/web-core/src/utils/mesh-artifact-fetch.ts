import type { ChatAttachmentMeta } from '@adhdev/daemon-core'
import {
    buildArtifactCacheKey,
    getCachedArtifactPayload,
    readArtifactFetchCommandResponse,
    setCachedArtifactPayload,
    type ArtifactResolvedPayload,
} from '../hooks/useArtifactRead'

export type MeshArtifactSendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export class MeshArtifactFetchError extends Error {
    constructor(message: string, readonly code: string) {
        super(message)
    }
}

/**
 * Fetch one artifact's content for the mesh Artifacts tab. The command goes to the
 * mesh host (coordinator) daemon, which serves its own records and routes
 * artifacts indexed from other daemons to their origin — the same
 * `meshCoordinatorDaemonId` contract the chat attachment bubble uses. Payloads
 * share the viewer's LRU cache, so reopening an artifact is free.
 */
export async function fetchMeshArtifactPayload(opts: {
    sendCommand: MeshArtifactSendCommand
    hostDaemonId: string
    attachment: ChatAttachmentMeta
    origin?: string | null
    /** False bypasses the shared payload LRU (thumbnails use their own small cache). Default true. */
    useSharedCache?: boolean
}): Promise<ArtifactResolvedPayload> {
    const { sendCommand, hostDaemonId, attachment } = opts
    const sessionId = (attachment.originSessionId ?? '').trim()
    if (!hostDaemonId || !sessionId) {
        throw new MeshArtifactFetchError('Session context is required to fetch this artifact.', 'missing_session_context')
    }
    const cacheKey = opts.useSharedCache === false ? null : buildArtifactCacheKey({
        origin: opts.origin ?? undefined,
        daemonId: hostDaemonId,
        sessionId,
        meshCoordinatorDaemonId: hostDaemonId,
        artifactId: attachment.artifactId,
        sha256: attachment.sha256,
        updatedAt: attachment.updatedAt,
    })
    if (cacheKey) {
        const cached = getCachedArtifactPayload(cacheKey)
        if (cached) return cached
    }
    const raw = await sendCommand(hostDaemonId, 'artifact_fetch', {
        artifactId: attachment.artifactId,
        sessionId,
        targetSessionId: sessionId,
        meshCoordinatorDaemonId: hostDaemonId,
    })
    const parsed = readArtifactFetchCommandResponse(raw, {
        artifactId: attachment.artifactId,
        sessionId,
        daemonId: hostDaemonId,
        attachment,
    })
    if (!parsed.data) {
        throw new MeshArtifactFetchError(parsed.error || 'Artifact fetch failed', parsed.errorCode ?? 'request_failed')
    }
    if (cacheKey && !parsed.data.sha256Changed) setCachedArtifactPayload(cacheKey, parsed.data)
    return parsed.data
}
