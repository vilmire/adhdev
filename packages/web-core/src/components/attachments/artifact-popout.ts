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
    sha256Changed?: boolean
    /** Driver bundles only: machines the opener can install on (see ARTIFACT_VIEWER_DRIVER_INSTALL). */
    driverMachines?: DriverInstallMachine[]
}

export interface DriverInstallMachine { id: string; label: string }
export interface DriverInstallOutcome { ok: boolean; code?: string }
/** Opener-side installer handed to openArtifactInNewWindow for a driver-bundle artifact. */
export interface PopoutDriverInstall {
    machines: DriverInstallMachine[]
    install: (targetId: string) => Promise<DriverInstallOutcome>
}

/** pop-out -> opener: install the bundle the opener served onto `targetId`. The bundle text never travels back. */
export const ARTIFACT_VIEWER_DRIVER_INSTALL = 'adhdev-artifact-viewer-driver-install'
/** opener -> pop-out: the result of that request. */
export const ARTIFACT_VIEWER_DRIVER_RESULT = 'adhdev-artifact-viewer-driver-result'
const DRIVER_INSTALL_TIMEOUT_MS = 60_000

const KINDS = new Set(['markdown', 'diff', 'json', 'text', 'image'])

export function isArtifactPopoutWirePayload(value: unknown): value is ArtifactPopoutWirePayload {
    if (!value || typeof value !== 'object') return false
    const v = value as Record<string, unknown>
    return typeof v.title === 'string'
        && typeof v.filename === 'string'
        && typeof v.kind === 'string' && KINDS.has(v.kind)
        && typeof v.mime === 'string'
        && typeof v.sizeBytes === 'number'
        && (v.sha256Changed === undefined || typeof v.sha256Changed === 'boolean')
        && (v.driverMachines === undefined || (Array.isArray(v.driverMachines) && v.driverMachines.every(m => !!m && typeof (m as any).id === 'string' && typeof (m as any).label === 'string')))
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
export function openArtifactInNewWindow(payload: ArtifactResolvedPayload | ArtifactViewerItem, options?: { driverInstall?: PopoutDriverInstall }): boolean {
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
        if (event.origin !== origin || event.source !== win) return
        const driverInstall = options?.driverInstall
        const req = event.data as { type?: unknown; requestId?: unknown; targetId?: unknown } | null
        if (req && req.type === ARTIFACT_VIEWER_DRIVER_INSTALL && driverInstall && typeof req.requestId === 'string' && typeof req.targetId === 'string') {
            // Only machines the opener listed are valid targets; the bundle is the opener's own copy.
            const requestId = req.requestId
            const targetId = req.targetId
            const done = (outcome: DriverInstallOutcome) => win.postMessage({ type: ARTIFACT_VIEWER_DRIVER_RESULT, requestId, ...outcome }, origin)
            if (!driverInstall.machines.some(m => m.id === targetId)) { done({ ok: false, code: 'unknown_target' }); return }
            void driverInstall.install(targetId).then(done, error => done({ ok: false, code: error instanceof Error ? error.message : String(error) }))
            return
        }
        if (!isArtifactViewerReadyMessage(event.data)) return
        const wire: ArtifactPopoutWirePayload = { ...item, ...(options?.driverInstall ? { driverMachines: options.driverInstall.machines } : {}) }
        win.postMessage({ type: ARTIFACT_VIEWER_PAYLOAD, payload: wire }, origin)
    }
    window.addEventListener('message', onMessage)
    // Keep answering (the child may reload) until the window is closed.
    timer = setInterval(() => { if (win.closed) stop() }, 2000)
    return true
}

/** Pop-out side: ask the opener (which holds the daemon connection) to install the served bundle. */
export function requestDriverInstallViaOpener(targetId: string): Promise<DriverInstallOutcome> {
    const opener = typeof window === 'undefined' ? null : window.opener as Window | null
    if (!opener || opener.closed) return Promise.resolve({ ok: false, code: 'opener_closed' })
    const requestId = `drv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<DriverInstallOutcome>(resolve => {
        const finish = (outcome: DriverInstallOutcome) => { window.removeEventListener('message', onMessage); clearTimeout(timer); resolve(outcome) }
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.source !== opener) return
            const d = event.data as { type?: unknown; requestId?: unknown; ok?: unknown; code?: unknown } | null
            if (!d || d.type !== ARTIFACT_VIEWER_DRIVER_RESULT || d.requestId !== requestId) return
            finish({ ok: d.ok === true, ...(typeof d.code === 'string' ? { code: d.code } : {}) })
        }
        const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), DRIVER_INSTALL_TIMEOUT_MS)
        window.addEventListener('message', onMessage)
        try { opener.postMessage({ type: ARTIFACT_VIEWER_DRIVER_INSTALL, requestId, targetId }, window.location.origin) }
        catch { finish({ ok: false, code: 'opener_closed' }) }
    })
}
