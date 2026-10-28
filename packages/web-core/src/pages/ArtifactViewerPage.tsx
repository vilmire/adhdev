import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ArtifactFullscreenViewer from '../components/attachments/ArtifactFullscreenViewer'
import { trArtifact } from '../components/attachments/artifact-i18n'
import {
    ARTIFACT_VIEWER_READY,
    parseArtifactViewerPayloadMessage,
} from '../components/attachments/artifact-popout'
import type { ArtifactViewerItem } from '../components/attachments/artifact-viewer-item'

export const ARTIFACT_POPOUT_TIMEOUT_MS = 5000

/**
 * `/artifact-view` — receives an already-fetched artifact from its opener by same-origin
 * postMessage and renders it. Deliberately has no daemon/transport/auth dependency, so it
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
            if (opener && event.source !== opener) return
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
        const timer = window.setTimeout(() => setTimedOut(true), opener ? timeoutMs : 0)
        return () => {
            window.removeEventListener('message', onMessage)
            window.clearTimeout(timer)
        }
    }, [timeoutMs])

    useEffect(() => {
        if (item) document.title = item.title || item.filename
    }, [item])

    if (item) return <ArtifactFullscreenViewer item={item} mode="page" />

    return (
        <div className="flex min-h-screen items-center justify-center bg-bg-primary px-6 text-center text-sm text-text-muted" data-testid="artifact-viewer-page-status">
            {timedOut ? trArtifact(t, i18n.language, 'artifact.popoutNoPayload') : trArtifact(t, i18n.language, 'artifact.popoutWaiting')}
        </div>
    )
}
