import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ArtifactFullscreenViewer from '../components/attachments/ArtifactFullscreenViewer'
import { trArtifact } from '../components/attachments/artifact-i18n'
import { ARTIFACT_HANDOFF_PARAM, consumeArtifactHandoff, isHandoffHandle, sweepArtifactHandoffs } from '../components/attachments/artifact-handoff'
import {
    ARTIFACT_VIEWER_READY,
    goBackToDashboard,
    isArtifactPopoutWirePayload,
    parseArtifactViewerPayloadMessage,
} from '../components/attachments/artifact-popout'
import type { ArtifactViewerItem } from '../components/attachments/artifact-viewer-item'

export const ARTIFACT_POPOUT_TIMEOUT_MS = 5000

function readHandle(): string | null {
    try {
        const h = new URLSearchParams(window.location.search).get(ARTIFACT_HANDOFF_PARAM)
        return isHandoffHandle(h) ? h : null
    } catch { return null }
}

/**
 * `/artifact-view` — receives an already-fetched artifact from its opener by same-origin
 * postMessage, or (when the opener is gone — the window replaced the opener's tab, or an
 * embedded browser dropped it) from a one-shot IndexedDB handoff named by `?h=`, and renders it. Deliberately has no daemon/transport/auth dependency, so it
 * must be mounted OUTSIDE the daemon providers (it would otherwise cost a P2P slot).
 */
export default function ArtifactViewerPage({ timeoutMs = ARTIFACT_POPOUT_TIMEOUT_MS }: { timeoutMs?: number }) {
    const { t, i18n } = useTranslation('common')
    const [item, setItem] = useState<ArtifactViewerItem | null>(null)
    const [timedOut, setTimedOut] = useState(false)

    useEffect(() => {
        const opener = window.opener as Window | null
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return
            // Without an opener the handoff record is the only legitimate source.
            if (!opener || event.source !== opener) return
            const parsed = parseArtifactViewerPayloadMessage(event.data)
            if (parsed) {
                setItem(parsed)
                setTimedOut(false)
            }
        }
        window.addEventListener('message', onMessage)
        if (opener) {
            try { opener.postMessage({ type: ARTIFACT_VIEWER_READY }, window.location.origin) } catch { /* opener gone */ }
        }
        void sweepArtifactHandoffs()
        const handle = readHandle()
        let cancelled = false
        if (handle) {
            // Consumed on read; an opener payload that arrives later still wins (it carries the driver-install machines).
            void consumeArtifactHandoff(handle).then(record => {
                if (cancelled) return
                if (isArtifactPopoutWirePayload(record)) { setItem(prev => prev ?? record); setTimedOut(false) }
                else if (!opener) setTimedOut(true)
            })
        }
        // No opener and no handle: nothing can ever arrive, resolve at once. With a handle and no
        // opener the read above decides; with an opener, give its payload `timeoutMs`.
        const timer = (opener || !handle) ? window.setTimeout(() => setTimedOut(true), opener ? timeoutMs : 0) : null
        return () => {
            cancelled = true
            window.removeEventListener('message', onMessage)
            if (timer !== null) window.clearTimeout(timer)
        }
    }, [timeoutMs])

    useEffect(() => {
        if (item) document.title = item.title || item.filename
    }, [item])

    if (item) {
        // Without an opener this window may be the user's own tab (it replaced the dashboard): offer the way back.
        return <ArtifactFullscreenViewer item={item} mode="page" onBack={window.opener ? undefined : () => goBackToDashboard()} />
    }

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg-primary px-6 text-center text-sm text-text-muted">
            <div data-testid="artifact-viewer-page-status">
                {timedOut ? trArtifact(t, i18n.language, 'artifact.popoutNoPayload') : trArtifact(t, i18n.language, 'artifact.popoutWaiting')}
            </div>
            {timedOut && (
                <button type="button" data-testid="artifact-viewer-page-back" onClick={() => goBackToDashboard()}
                    className="inline-flex min-h-[36px] items-center rounded-lg border border-border-subtle bg-bg-secondary px-3 font-semibold text-text-primary">
                    {trArtifact(t, i18n.language, 'artifact.backToDashboard')}
                </button>
            )}
        </div>
    )
}
