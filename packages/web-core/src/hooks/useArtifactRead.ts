import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactErrorCode, ArtifactKind, ChatAttachmentMeta } from '@adhdev/daemon-core'
import { useBaseDaemonActions } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import { buildConversations } from '../components/dashboard/buildConversations'
import { getCoordinatorRoutingHint, getConversationDaemonRouteId } from '../components/dashboard/conversation-selectors'
import { controllerRegistry } from '../components/dashboard/session-chat-controller'
import type { DaemonData } from '../types'
import { unwrapDaemonCommandBody } from '../utils/daemon-command-envelope'

export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
export const MAX_ARTIFACT_PREVIEW_CHARS = 600
export const MAX_ARTIFACT_CACHE_ENTRIES = 50

export const ALLOWED_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
    'markdown',
    'image',
    'diff',
    'json',
    'text',
])

/**
 * Strict allowlist of safe MIME types per artifact kind.
 * HTML, XHTML, and SVG (`text/html`, `application/xhtml+xml`, `image/svg+xml`)
 * are strictly forbidden.
 */
export const ALLOWED_ARTIFACT_MIMES: Readonly<Record<ArtifactKind, ReadonlySet<string>>> = {
    markdown: new Set(['text/markdown', 'text/plain']),
    image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    diff: new Set(['text/x-diff', 'text/plain']),
    json: new Set(['application/json', 'text/plain']),
    text: new Set(['text/plain']),
}

export interface ArtifactCacheScope {
    origin?: string | null
    daemonId: string
    sessionId: string
    artifactId: string
    sha256: string
}

export interface ResolvedArtifactSessionTarget {
    daemonId: string
    sessionId: string
    meshCoordinatorDaemonId?: string
}

export interface ResolveArtifactSessionTargetOptions {
    daemonId?: string | null
    sessionId?: string | null
    meshCoordinatorDaemonId?: string | null
    contextKey?: string | null
    ides?: readonly DaemonData[]
}

export interface ArtifactResolvedPayload {
    artifactId: string
    sessionId: string
    daemonId: string
    kind: ArtifactKind
    mime: string
    filename: string
    title: string
    relPath?: string
    sizeBytes: number
    sha256: string
    registeredSha256: string
    sha256Changed: boolean
    hashChanged: boolean
    encoding: 'utf8' | 'base64'
    content: string
    textContent: string | null
    bytes: Uint8Array
    createdAt?: number
    updatedAt?: number
}

export type FetchArtifactCommandFn = (
    daemonId: string,
    command: 'artifact_fetch',
    payload: {
        artifactId: string
        sessionId: string
        targetSessionId: string
        meshCoordinatorDaemonId?: string
    },
) => Promise<unknown>

export interface UseArtifactReadOptions {
    attachment: ChatAttachmentMeta
    daemonId?: string | null
    sessionId?: string | null
    meshCoordinatorDaemonId?: string | null
    contextKey?: string | null
    origin?: string | null
    fetchArtifact?: FetchArtifactCommandFn
}

export interface UseArtifactReadResult {
    status: 'idle' | 'loading' | 'loaded' | 'error'
    isOpen: boolean
    loading: boolean
    error: string | null
    errorCode:
        | ArtifactErrorCode
        | 'missing_session_context'
        | 'session_mismatch'
        | 'artifact_mismatch'
        | 'unsupported_kind'
        | 'unsupported_mime'
        | 'file_too_large'
        | 'file_missing'
        | 'request_failed'
        | null
    data: ArtifactResolvedPayload | null
    objectUrl: string | null
    sha256Changed: boolean
    target: ResolvedArtifactSessionTarget | null
    openViewer: () => Promise<ArtifactResolvedPayload | null>
    closeViewer: () => void
    toggleViewer: () => Promise<void>
    fetchArtifactContent: (options?: { open?: boolean; forceRefresh?: boolean }) => Promise<ArtifactResolvedPayload | null>
    downloadArtifact: () => Promise<boolean>
}

const artifactPayloadCache = new Map<string, ArtifactResolvedPayload>()

function getRuntimeOrigin(explicitOrigin?: string | null): string {
    const trimmed = typeof explicitOrigin === 'string' ? explicitOrigin.trim() : ''
    if (trimmed) return trimmed
    if (typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string' && window.location.origin) {
        return window.location.origin
    }
    return 'default-origin'
}

/**
 * Build a collision-proof cache key scoped by web origin, owning daemonId,
 * sessionId, artifactId, and sha256. Returns null if any identity part is missing.
 */
export function buildArtifactCacheKey(scope: ArtifactCacheScope): string | null {
    const daemonId = typeof scope.daemonId === 'string' ? scope.daemonId.trim() : ''
    const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId.trim() : ''
    const artifactId = typeof scope.artifactId === 'string' ? scope.artifactId.trim() : ''
    const sha256 = typeof scope.sha256 === 'string' ? scope.sha256.trim() : ''
    if (!daemonId || !sessionId || !artifactId || !sha256) return null
    const origin = getRuntimeOrigin(scope.origin)
    return `${origin}::${daemonId}::${sessionId}::${artifactId}::${sha256}`
}

function setCachedArtifactPayload(key: string, payload: ArtifactResolvedPayload): void {
    if (artifactPayloadCache.has(key)) {
        artifactPayloadCache.delete(key)
    } else if (artifactPayloadCache.size >= MAX_ARTIFACT_CACHE_ENTRIES) {
        const oldestKey = artifactPayloadCache.keys().next().value
        if (typeof oldestKey === 'string') {
            artifactPayloadCache.delete(oldestKey)
        }
    }
    artifactPayloadCache.set(key, payload)
}

function getCachedArtifactPayload(key: string): ArtifactResolvedPayload | undefined {
    const existing = artifactPayloadCache.get(key)
    if (!existing) return undefined
    // Refresh LRU order
    artifactPayloadCache.delete(key)
    artifactPayloadCache.set(key, existing)
    return existing
}

export function clearArtifactReadCache(): void {
    artifactPayloadCache.clear()
}

export function getArtifactReadCacheSize(): number {
    return artifactPayloadCache.size
}

export function clampArtifactPreviewText(previewText: string | undefined | null): string {
    if (typeof previewText !== 'string' || !previewText) return ''
    if (previewText.length <= MAX_ARTIFACT_PREVIEW_CHARS) return previewText
    return previewText.slice(0, MAX_ARTIFACT_PREVIEW_CHARS)
}

export function decodeBase64Bytes(base64: string): Uint8Array {
    const cleaned = base64.replace(/\s+/g, '')
    if (!cleaned) return new Uint8Array(0)
    if (typeof atob === 'function') {
        const binary = atob(cleaned)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i) & 0xff
        }
        return bytes
    }
    const globalBuffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer
    if (globalBuffer && typeof globalBuffer.from === 'function') {
        return new Uint8Array(globalBuffer.from(cleaned, 'base64'))
    }
    throw new Error('Base64 decoder unavailable')
}

export function isAllowedArtifactKindAndMime(kind: unknown, mime: unknown): kind is ArtifactKind {
    if (typeof kind !== 'string' || !ALLOWED_ARTIFACT_KINDS.has(kind as ArtifactKind)) {
        return false
    }
    if (typeof mime !== 'string') return false
    const normalizedMime = mime.split(';')[0]?.trim().toLowerCase() || ''
    if (!normalizedMime) return false
    if (normalizedMime === 'text/html' || normalizedMime === 'application/xhtml+xml' || normalizedMime === 'image/svg+xml') {
        return false
    }
    return ALLOWED_ARTIFACT_MIMES[kind as ArtifactKind].has(normalizedMime)
}

/**
 * Deterministically resolve the exact `(daemonId, sessionId, meshCoordinatorDaemonId)`
 * for an artifact bubble. Fails closed (returns null) rather than guessing or
 * targeting an arbitrary session.
 */
export function resolveArtifactSessionTarget(
    options: ResolveArtifactSessionTargetOptions,
): ResolvedArtifactSessionTarget | null {
    const explicitDaemonId = typeof options.daemonId === 'string' ? options.daemonId.trim() : ''
    const explicitSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
    const explicitCoordinatorId = typeof options.meshCoordinatorDaemonId === 'string'
        ? options.meshCoordinatorDaemonId.trim()
        : ''
    const ides = Array.isArray(options.ides) ? (options.ides as DaemonData[]) : []

    if (explicitDaemonId && explicitSessionId) {
        if (explicitCoordinatorId) {
            return {
                daemonId: explicitDaemonId,
                sessionId: explicitSessionId,
                meshCoordinatorDaemonId: explicitCoordinatorId,
            }
        }
        if (ides.length > 0) {
            const conversations = buildConversations(ides, ides)
            const matched = conversations.find(
                (conv) => getConversationDaemonRouteId(conv) === explicitDaemonId
                    && (conv.sessionId === explicitSessionId || conv.nativeSessionId === explicitSessionId),
            )
            const hint = matched ? getCoordinatorRoutingHint(matched).meshCoordinatorDaemonId : undefined
            return {
                daemonId: explicitDaemonId,
                sessionId: explicitSessionId,
                ...(hint ? { meshCoordinatorDaemonId: hint } : {}),
            }
        }
        return { daemonId: explicitDaemonId, sessionId: explicitSessionId }
    }

    const contextKey = typeof options.contextKey === 'string' ? options.contextKey.trim() : ''
    if (!contextKey || contextKey === 'unknown') return null

    if (ides.length > 0) {
        const conversations = buildConversations(ides, ides)
        const tabMatches = conversations.filter((conv) => conv.tabKey === contextKey)
        const exactConv = tabMatches.length === 1
            ? tabMatches[0]
            : (() => {
                const routeMatches = conversations.filter((conv) => conv.routeId === contextKey)
                return routeMatches.length === 1 ? routeMatches[0] : undefined
            })()
        if (exactConv) {
            const daemonId = getConversationDaemonRouteId(exactConv).trim()
            const sessionId = String(exactConv.sessionId || exactConv.nativeSessionId || '').trim()
            if (daemonId && sessionId) {
                const hint = getCoordinatorRoutingHint(exactConv).meshCoordinatorDaemonId
                return {
                    daemonId,
                    sessionId,
                    ...(hint ? { meshCoordinatorDaemonId: hint } : {}),
                }
            }
        }
    }

    for (const controller of controllerRegistry.values()) {
        const id = controller.getIdentity()
        if (`${id.daemonId}:${id.sessionId}` === contextKey || id.sessionId === contextKey) {
            if (id.daemonId && id.sessionId) {
                return { daemonId: id.daemonId, sessionId: id.sessionId }
            }
        }
    }

    const colonIndex = contextKey.indexOf(':')
    if (colonIndex > 0 && colonIndex < contextKey.length - 1) {
        const daemonId = contextKey.slice(0, colonIndex).trim()
        const sessionId = contextKey.slice(colonIndex + 1).trim()
        if (daemonId && sessionId && !sessionId.includes(':')) {
            return { daemonId, sessionId }
        }
    }

    return null
}

export function readArtifactFetchCommandResponse(
    raw: unknown,
    expected: {
        artifactId: string
        sessionId: string
        daemonId: string
        attachment: ChatAttachmentMeta
    },
): {
    data: ArtifactResolvedPayload | null
    error: string | null
    errorCode: UseArtifactReadResult['errorCode']
} {
    const body = unwrapDaemonCommandBody<Record<string, unknown>>(raw)
    if (!body || typeof body !== 'object') {
        return { data: null, error: 'Empty artifact response', errorCode: 'request_failed' }
    }
    if (body.success === false) {
        const code = typeof body.error === 'string' && body.error.trim()
            ? (body.error.trim() as UseArtifactReadResult['errorCode'])
            : 'request_failed'
        const msg = typeof body.message === 'string' && body.message.trim()
            ? body.message.trim()
            : typeof body.error === 'string' && body.error.trim()
                ? body.error.trim()
                : 'Artifact fetch failed'
        return { data: null, error: msg, errorCode: code }
    }

    const returnedArtifactId = typeof body.artifactId === 'string' ? body.artifactId.trim() : ''
    if (!returnedArtifactId || returnedArtifactId !== expected.artifactId) {
        return { data: null, error: 'Artifact ID mismatch in response', errorCode: 'artifact_mismatch' }
    }

    const returnedSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!returnedSessionId || returnedSessionId !== expected.sessionId) {
        return { data: null, error: 'Session ID mismatch in response', errorCode: 'session_mismatch' }
    }

    const kind = body.kind
    const rawMime = typeof body.mime === 'string' ? body.mime.split(';')[0]?.trim().toLowerCase() : ''
    if (!isAllowedArtifactKindAndMime(kind, rawMime)) {
        return {
            data: null,
            error: 'Unsupported artifact kind or MIME type',
            errorCode: typeof kind === 'string' && !ALLOWED_ARTIFACT_KINDS.has(kind as ArtifactKind)
                ? 'unsupported_kind'
                : 'unsupported_mime',
        }
    }

    const encoding = body.encoding === 'base64' ? 'base64' : body.encoding === 'utf8' ? 'utf8' : null
    if (!encoding || typeof body.content !== 'string') {
        return { data: null, error: 'Invalid artifact content encoding', errorCode: 'request_failed' }
    }

    const declaredSize = typeof body.sizeBytes === 'number' && Number.isFinite(body.sizeBytes)
        ? body.sizeBytes
        : expected.attachment.sizeBytes
    if (declaredSize > MAX_ARTIFACT_BYTES) {
        return { data: null, error: 'Artifact exceeds 4 MiB limit', errorCode: 'file_too_large' }
    }

    let bytes: Uint8Array
    let textContent: string | null = null
    try {
        if (encoding === 'base64') {
            bytes = decodeBase64Bytes(body.content)
            if (kind !== 'image') {
                textContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            }
        } else {
            textContent = body.content
            bytes = new TextEncoder().encode(body.content)
        }
    } catch {
        return { data: null, error: 'Failed to decode artifact content', errorCode: 'request_failed' }
    }

    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
        return { data: null, error: 'Artifact exceeds 4 MiB limit', errorCode: 'file_too_large' }
    }

    const sha256 = typeof body.sha256 === 'string' && body.sha256.trim()
        ? body.sha256.trim()
        : expected.attachment.sha256
    const registeredSha256 = typeof body.registeredSha256 === 'string' && body.registeredSha256.trim()
        ? body.registeredSha256.trim()
        : expected.attachment.sha256
    const sha256Changed = Boolean(
        body.sha256Changed === true
        || body.hashChanged === true
        || (sha256 && registeredSha256 && sha256 !== registeredSha256)
        || (sha256 && expected.attachment.sha256 && sha256 !== expected.attachment.sha256),
    )

    const recordObj = body.artifact && typeof body.artifact === 'object'
        ? (body.artifact as Record<string, unknown>)
        : null
    const attachmentObj = body.attachment && typeof body.attachment === 'object'
        ? (body.attachment as Record<string, unknown>)
        : null

    const filename = (typeof body.filename === 'string' && body.filename.trim())
        || (typeof attachmentObj?.filename === 'string' && attachmentObj.filename.trim())
        || (typeof recordObj?.filename === 'string' && recordObj.filename.trim())
        || expected.attachment.filename
    const title = (typeof body.title === 'string' && body.title.trim())
        || (typeof attachmentObj?.title === 'string' && attachmentObj.title.trim())
        || (typeof recordObj?.title === 'string' && recordObj.title.trim())
        || expected.attachment.title
        || filename

    return {
        data: {
            artifactId: returnedArtifactId,
            sessionId: returnedSessionId,
            daemonId: expected.daemonId,
            kind,
            mime: rawMime,
            filename,
            title,
            relPath: typeof body.relPath === 'string' ? body.relPath : undefined,
            sizeBytes: bytes.byteLength || declaredSize,
            sha256,
            registeredSha256,
            sha256Changed,
            hashChanged: sha256Changed,
            encoding,
            content: body.content,
            textContent,
            bytes,
            createdAt: typeof body.createdAt === 'number' ? body.createdAt : expected.attachment.createdAt,
            updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : expected.attachment.updatedAt,
        },
        error: null,
        errorCode: null,
    }
}

function createArtifactObjectUrl(payload: ArtifactResolvedPayload): string | null {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
    const copy = new Uint8Array(payload.bytes.byteLength)
    copy.set(payload.bytes)
    const blob = new Blob([copy.buffer], { type: payload.mime })
    return URL.createObjectURL(blob)
}

function safeRevokeObjectUrl(url: string | null | undefined): void {
    if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
    try {
        URL.revokeObjectURL(url)
    } catch {
        // Ignore revoke errors in non-browser environments
    }
}

export function useArtifactRead({
    attachment,
    daemonId,
    sessionId,
    meshCoordinatorDaemonId,
    contextKey,
    origin,
    fetchArtifact: customFetchArtifact,
}: UseArtifactReadOptions): UseArtifactReadResult {
    const { sendCommand } = useTransport()
    const { getIdes } = useBaseDaemonActions()

    const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
    const [isOpen, setIsOpen] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [errorCode, setErrorCode] = useState<UseArtifactReadResult['errorCode']>(null)
    const [data, setData] = useState<ArtifactResolvedPayload | null>(null)
    const [objectUrl, setObjectUrl] = useState<string | null>(null)

    const requestSeqRef = useRef(0)
    const activeObjectUrlRef = useRef<string | null>(null)
    const pendingDownloadUrlsRef = useRef<Set<string>>(new Set())

    const replaceObjectUrl = useCallback((nextUrl: string | null) => {
        if (activeObjectUrlRef.current && activeObjectUrlRef.current !== nextUrl) {
            safeRevokeObjectUrl(activeObjectUrlRef.current)
        }
        activeObjectUrlRef.current = nextUrl
        setObjectUrl(nextUrl)
    }, [])

    const resolveTarget = useCallback((): ResolvedArtifactSessionTarget | null => {
        return resolveArtifactSessionTarget({
            daemonId,
            sessionId,
            meshCoordinatorDaemonId,
            contextKey,
            ides: getIdes(),
        })
    }, [contextKey, daemonId, getIdes, meshCoordinatorDaemonId, sessionId])

    const target = useMemo(() => resolveTarget(), [resolveTarget])

    // Reset state and revoke any active objectUrl when artifact identity, hash, timestamp, or session changes.
    // Deliberately does NOT auto-fetch during chat or inbox render.
    const identitySignature = `${daemonId ?? ''}::${sessionId ?? ''}::${contextKey ?? ''}::${attachment.artifactId}::${attachment.sha256}::${attachment.updatedAt}`
    const prevIdentityRef = useRef(identitySignature)
    useEffect(() => {
        if (prevIdentityRef.current === identitySignature) return
        prevIdentityRef.current = identitySignature
        requestSeqRef.current += 1
        replaceObjectUrl(null)
        setData(null)
        setError(null)
        setErrorCode(null)
        setStatus('idle')
        setIsOpen(false)
    }, [identitySignature, replaceObjectUrl])

    // Unmount cleanup: invalidate in-flight requests and revoke all object URLs.
    useEffect(() => {
        const downloadUrls = pendingDownloadUrlsRef.current
        return () => {
            requestSeqRef.current += 1
            if (activeObjectUrlRef.current) {
                safeRevokeObjectUrl(activeObjectUrlRef.current)
                activeObjectUrlRef.current = null
            }
            for (const url of downloadUrls) {
                safeRevokeObjectUrl(url)
            }
            downloadUrls.clear()
        }
    }, [])

    const fetchArtifactContent = useCallback(
        async (options?: { open?: boolean; forceRefresh?: boolean }): Promise<ArtifactResolvedPayload | null> => {
            const shouldOpen = options?.open ?? true
            const forceRefresh = options?.forceRefresh === true
            if (shouldOpen) {
                setIsOpen(true)
            }

            const resolved = resolveTarget()
            if (!resolved) {
                setStatus('error')
                setError('Session context is required to fetch this artifact.')
                setErrorCode('missing_session_context')
                return null
            }

            const cacheKey = buildArtifactCacheKey({
                origin,
                daemonId: resolved.daemonId,
                sessionId: resolved.sessionId,
                artifactId: attachment.artifactId,
                sha256: attachment.sha256,
            })

            if (!forceRefresh && cacheKey) {
                const cached = getCachedArtifactPayload(cacheKey)
                if (cached) {
                    setData(cached)
                    setError(null)
                    setErrorCode(null)
                    setStatus('loaded')
                    if (shouldOpen && cached.kind === 'image') {
                        replaceObjectUrl(createArtifactObjectUrl(cached))
                    }
                    return cached
                }
            }

            const requestSeq = requestSeqRef.current + 1
            requestSeqRef.current = requestSeq
            setStatus('loading')
            setError(null)
            setErrorCode(null)

            try {
                const commandPayload = {
                    artifactId: attachment.artifactId,
                    sessionId: resolved.sessionId,
                    targetSessionId: resolved.sessionId,
                    ...(resolved.meshCoordinatorDaemonId
                        ? { meshCoordinatorDaemonId: resolved.meshCoordinatorDaemonId }
                        : {}),
                }
                const rawResponse = customFetchArtifact
                    ? await customFetchArtifact(resolved.daemonId, 'artifact_fetch', commandPayload)
                    : await sendCommand(resolved.daemonId, 'artifact_fetch', commandPayload)

                if (requestSeqRef.current !== requestSeq) return null

                const parsed = readArtifactFetchCommandResponse(rawResponse, {
                    artifactId: attachment.artifactId,
                    sessionId: resolved.sessionId,
                    daemonId: resolved.daemonId,
                    attachment,
                })

                if (!parsed.data || parsed.error) {
                    replaceObjectUrl(null)
                    setData(null)
                    setStatus('error')
                    setError(parsed.error || 'Artifact fetch failed')
                    setErrorCode(parsed.errorCode ?? 'request_failed')
                    return null
                }

                // Cache under both the requested attachment sha256 (if unchanged) and the actual sha256
                const actualCacheKey = buildArtifactCacheKey({
                    origin,
                    daemonId: resolved.daemonId,
                    sessionId: resolved.sessionId,
                    artifactId: attachment.artifactId,
                    sha256: parsed.data.sha256,
                })
                if (actualCacheKey) {
                    setCachedArtifactPayload(actualCacheKey, parsed.data)
                }
                if (cacheKey && !parsed.data.sha256Changed) {
                    setCachedArtifactPayload(cacheKey, parsed.data)
                } else if (cacheKey && parsed.data.sha256Changed) {
                    // Evict stale hash entry when file on disk changed since registration
                    artifactPayloadCache.delete(cacheKey)
                }

                setData(parsed.data)
                setError(null)
                setErrorCode(null)
                setStatus('loaded')
                if (shouldOpen && parsed.data.kind === 'image') {
                    replaceObjectUrl(createArtifactObjectUrl(parsed.data))
                }
                return parsed.data
            } catch (err) {
                if (requestSeqRef.current !== requestSeq) return null
                replaceObjectUrl(null)
                setData(null)
                setStatus('error')
                setError(err instanceof Error ? err.message : 'Artifact fetch failed')
                setErrorCode('request_failed')
                return null
            }
        },
        [attachment, customFetchArtifact, origin, replaceObjectUrl, resolveTarget, sendCommand],
    )

    const openViewer = useCallback(async (): Promise<ArtifactResolvedPayload | null> => {
        return fetchArtifactContent({ open: true })
    }, [fetchArtifactContent])

    const closeViewer = useCallback(() => {
        requestSeqRef.current += 1
        replaceObjectUrl(null)
        setIsOpen(false)
        if (status === 'loading') {
            setStatus(data ? 'loaded' : 'idle')
        }
    }, [data, replaceObjectUrl, status])

    const toggleViewer = useCallback(async () => {
        if (isOpen) {
            closeViewer()
            return
        }
        await openViewer()
    }, [closeViewer, isOpen, openViewer])

    const downloadArtifact = useCallback(async (): Promise<boolean> => {
        let payload = data
        if (!payload) {
            payload = await fetchArtifactContent({ open: isOpen })
        }
        if (!payload) return false
        if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            return false
        }
        const url = createArtifactObjectUrl(payload)
        if (!url) return false
        pendingDownloadUrlsRef.current.add(url)
        try {
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = payload.filename || attachment.filename || 'artifact'
            anchor.rel = 'noopener'
            anchor.style.display = 'none'
            document.body.appendChild(anchor)
            anchor.click()
            document.body.removeChild(anchor)
            return true
        } finally {
            pendingDownloadUrlsRef.current.delete(url)
            safeRevokeObjectUrl(url)
        }
    }, [attachment.filename, data, fetchArtifactContent, isOpen])

    return {
        status,
        isOpen,
        loading: status === 'loading',
        error,
        errorCode,
        data,
        objectUrl,
        sha256Changed: Boolean(data?.sha256Changed),
        target,
        openViewer,
        closeViewer,
        toggleViewer,
        fetchArtifactContent,
        downloadArtifact,
    }
}

export const useArtifactFetch = useArtifactRead
