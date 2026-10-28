import type { ArtifactKind } from '@adhdev/daemon-core'
import { toArtifactViewerItem, type ArtifactViewerItem } from './artifact-viewer-item'
import type { ArtifactResolvedPayload } from '../../hooks/useArtifactRead'

/**
 * Pop-out handshake. The new window never talks to a daemon (a cloud tab costs a P2P
 * slot and a re-auth): the opener already holds the fetched content and hands it over
 * by same-origin postMessage once the child says it is ready.
 */
export const ARTIFACT_VIEWER_PATH = '/artifact-view'
export const ARTIFACT_VIEWER_READY = 'adhdev-artifact-viewer-ready'
export const ARTIFACT_VIEWER_PAYLOAD = 'adhdev-artifact-viewer-payload'

export interface ArtifactPopoutWirePayload {
    title: string
    filename: string
    kind: ArtifactKind
    mime: string
    sizeBytes: number
    text: string | null
    /** Structured-cloneable Blob (never an object URL — those are origin/window scoped). */
    blob: Blob | null
}

const KINDS = new Set(['markdown', 'diff', 'json', 'text', 'image'])

export function isArtifactPopoutWirePayload(value: unknown): value is ArtifactPopoutWirePayload {
    if (!value || typeof value !== 'object') return false
    const v = value as Record<string, unknown>
    return typeof v.title === 'string'
        && typeof v.filename === 'string'
        && typeof v.kind === 'string' && KINDS.has(v.kind)
        && typeof v.mime === 'string'
        && typeof v.sizeBytes === 'number'
        && (v.text === null || typeof v.text === 'string')
        && (v.blob === null || (typeof Blob !== 'undefined' && v.blob instanceof Blob))
}

export function isArtifactViewerReadyMessage(data: unknown): boolean {
    return !!data && typeof data === 'object' && (data as { type?: unknown }).type === ARTIFACT_VIEWER_READY
}

export function parseArtifactViewerPayloadMessage(data: unknown): ArtifactViewerItem | null {
    if (!data || typeof data !== 'object') return null
    const m = data as { type?: unknown; payload?: unknown }
    if (m.type !== ARTIFACT_VIEWER_PAYLOAD || !isArtifactPopoutWirePayload(m.payload)) return null
    return m.payload
}

export function artifactItemFromPayload(payload: ArtifactResolvedPayload | ArtifactViewerItem): ArtifactViewerItem {
    return 'bytes' in payload ? toArtifactViewerItem(payload) : payload
}

/**
 * Open `/artifact-view` in a pop-up window and serve the content to it.
 * Returns false when the browser blocked the window.
 */
export function openArtifactInNewWindow(payload: ArtifactResolvedPayload | ArtifactViewerItem): boolean {
    if (typeof window === 'undefined') return false
    const item = artifactItemFromPayload(payload)
    const win = window.open(ARTIFACT_VIEWER_PATH, '_blank', 'popup,width=1100,height=860')
    if (!win) return false
    const origin = window.location.origin
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
        window.removeEventListener('message', onMessage)
        if (timer) clearInterval(timer)
    }
    function onMessage(event: MessageEvent) {
        if (event.origin !== origin || event.source !== win || !isArtifactViewerReadyMessage(event.data)) return
        const wire: ArtifactPopoutWirePayload = { ...item }
        win.postMessage({ type: ARTIFACT_VIEWER_PAYLOAD, payload: wire }, origin)
    }
    window.addEventListener('message', onMessage)
    // Keep answering (the child may reload) until the window is closed.
    timer = setInterval(() => { if (win.closed) stop() }, 2000)
    return true
}
