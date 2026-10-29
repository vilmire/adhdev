import type { ArtifactKind } from '@adhdev/daemon-core'
import type { ArtifactResolvedPayload } from '../../hooks/useArtifactRead'

/** Display-ready artifact content for the fullscreen viewer / pop-out window. */
export interface ArtifactViewerItem {
    title: string
    filename: string
    kind: ArtifactKind
    mime: string
    sizeBytes: number
    /** Decoded text for markdown/diff/json/text kinds. */
    text: string | null
    /** Raw bytes for images (and download of any kind). */
    blob: Blob | null
    /** The workspace file changed after the artifact was registered. */
    sha256Changed?: boolean
    /** Pop-out only: machines the opener can install a driver bundle on (the pop-out has no daemon connection). */
    driverMachines?: Array<{ id: string; label: string }>
}

export function toArtifactViewerItem(payload: ArtifactResolvedPayload): ArtifactViewerItem {
    const copy = new Uint8Array(payload.bytes.byteLength)
    copy.set(payload.bytes)
    return {
        title: payload.title || payload.filename,
        filename: payload.filename,
        kind: payload.kind,
        mime: payload.mime,
        sizeBytes: payload.sizeBytes,
        text: payload.kind === 'image' ? null : (payload.textContent ?? payload.content ?? ''),
        sha256Changed: payload.sha256Changed === true,
        blob: typeof Blob === 'undefined' ? null : new Blob([copy.buffer], { type: payload.mime }),
    }
}

export const DOWNLOAD_REVOKE_DELAY_MS = 30_000

/** Save the item through a transient object URL anchor. Returns false when unavailable. */
export function downloadArtifactViewerItem(item: ArtifactViewerItem): boolean {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const blob = item.blob ?? new Blob([item.text ?? ''], { type: item.mime || 'text/plain' })
    const url = URL.createObjectURL(blob)
    let started = false
    try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = item.filename || 'artifact'
        anchor.rel = 'noopener'
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        started = true
        return true
    } finally {
        // Revoking right after click() can cancel the download in Safari/Firefox, so a
        // started download keeps its URL for a while; a failed one is released now.
        if (started) setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS)
        else URL.revokeObjectURL(url)
    }
}

/** Markdown headings (level 1-4) outside fenced code, in document order. */
export function extractMarkdownHeadings(markdown: string): Array<{ level: number; text: string }> {
    const headings: Array<{ level: number; text: string }> = []
    let fence: string | null = null
    for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
        const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line)
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1]![0]!
            else if (fenceMatch[1]![0] === fence) fence = null
            continue
        }
        if (fence) continue
        const m = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line)
        if (m) headings.push({ level: m[1]!.length, text: m[2]!.replace(/[`*_]/g, '') })
    }
    return headings
}
