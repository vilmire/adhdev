import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatAttachmentMeta } from '@adhdev/daemon-core'
import {
    clampArtifactPreviewText,
    useArtifactRead,
    type FetchArtifactCommandFn,
} from '../../hooks/useArtifactRead'
import { formatBytes } from '../../utils/daemon-utils'
import { formatTime } from '../ChatMessageList/chatMessageHelpers'
import { CopyButton } from '../ui/TechnicalDetails'
import { ArtifactContentRenderer } from './ArtifactContentRenderers'
import { getArtifactErrorCopy, getArtifactKindLabel, trArtifact } from './artifact-i18n'

export { formatBytes }

export interface AttachmentBubbleProps {
    attachment: ChatAttachmentMeta
    timestamp?: number | null
    contextKey?: string | null
    daemonId?: string | null
    sessionId?: string | null
    meshCoordinatorDaemonId?: string | null
    origin?: string | null
    fetchArtifact?: FetchArtifactCommandFn
    className?: string
}

export function AttachmentBubble({
    attachment,
    timestamp,
    contextKey,
    daemonId,
    sessionId,
    meshCoordinatorDaemonId,
    origin,
    fetchArtifact,
    className,
}: AttachmentBubbleProps) {
    const { t, i18n } = useTranslation('common')
    const [downloading, setDownloading] = useState(false)

    const {
        status,
        isOpen,
        loading,
        error,
        errorCode,
        data,
        objectUrl,
        sha256Changed,
        openViewer,
        toggleViewer,
        downloadArtifact,
    } = useArtifactRead({
        attachment,
        daemonId,
        sessionId,
        meshCoordinatorDaemonId,
        contextKey,
        origin,
        fetchArtifact,
    })

    const previewText = clampArtifactPreviewText(attachment.previewText)
    const displayTitle = attachment.title || attachment.filename
    const showFilename = Boolean(attachment.filename && attachment.filename !== displayTitle)
    const formattedSize = formatBytes(attachment.sizeBytes)
    const kindLabel = getArtifactKindLabel(t, i18n.language, attachment.kind)
    const artifactBadgeLabel = trArtifact(t, i18n.language, 'chat.artifact')
    const viewFullLabel = trArtifact(t, i18n.language, 'artifact.viewFull')
    const viewFullTitle = trArtifact(t, i18n.language, 'artifact.viewFullTitle')
    const collapseLabel = trArtifact(t, i18n.language, 'artifact.collapse')
    const downloadLabel = trArtifact(t, i18n.language, 'artifact.download')
    const downloadingLabel = trArtifact(t, i18n.language, 'artifact.downloading')
    const copyLabel = trArtifact(t, i18n.language, 'artifact.copyContent')
    const loadingLabel = trArtifact(t, i18n.language, 'artifact.loading')
    const retryLabel = trArtifact(t, i18n.language, 'artifact.retry')
    const hashWarningTitle = trArtifact(t, i18n.language, 'artifact.hashChangedWarning')
    const hashWarningDetail = trArtifact(t, i18n.language, 'artifact.hashChangedDetail')

    const copyValue = data?.textContent ?? (previewText || attachment.filename || displayTitle)

    const handleDownload = async () => {
        if (downloading) return
        setDownloading(true)
        try {
            await downloadArtifact()
        } finally {
            setDownloading(false)
        }
    }

    return (
        <div
            className={`chat-bubble self-start chat-bubble-agent chat-msg-artifact w-full max-w-full min-w-0 ${className || ''}`.trim()}
            data-chat-surface="chat"
            data-chat-kind="artifact"
            data-artifact-id={attachment.artifactId}
            data-artifact-kind={attachment.kind}
            data-artifact-sha256={attachment.sha256}
            data-testid="attachment-bubble"
        >
            <div className="chat-bubble-meta flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className="shrink-0 text-xs">📎</span>
                    <span className="chat-sender truncate font-semibold text-text-primary">{artifactBadgeLabel}</span>
                    <span className="rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 text-3xs font-medium text-text-secondary">
                        {kindLabel}
                    </span>
                </div>
                {timestamp != null && timestamp > 0 && (
                    <span className="chat-time shrink-0 text-text-muted">{formatTime(timestamp)}</span>
                )}
            </div>

            <div className="mt-1.5 flex min-w-0 flex-col gap-2 rounded-lg border border-border-subtle bg-bg-secondary/60 p-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        <div
                            className="truncate text-xs font-semibold text-text-primary"
                            data-testid="artifact-title"
                            title={displayTitle}
                        >
                            {displayTitle}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-3xs text-text-muted">
                            <span
                                className="max-w-full truncate"
                                data-testid="artifact-filename"
                                title={attachment.filename}
                            >
                                {attachment.filename}
                            </span>
                            {showFilename && <span aria-hidden="true">·</span>}
                            <span data-testid="artifact-size">{formattedSize}</span>
                            <span aria-hidden="true">·</span>
                            <span>{attachment.mime}</span>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                        {copyValue && (
                            <CopyButton
                                value={copyValue}
                                label={copyLabel}
                                className="min-h-[26px] px-2 py-0.5"
                            />
                        )}
                        <button
                            type="button"
                            onClick={handleDownload}
                            disabled={downloading}
                            data-testid="artifact-download-button"
                            aria-label={`${downloadLabel}: ${attachment.filename}`}
                            title={`${downloadLabel} (${attachment.filename})`}
                            className="inline-flex min-h-[26px] shrink-0 items-center rounded-md border border-border-subtle bg-transparent px-2 py-0.5 text-3xs font-medium text-text-secondary transition-colors hover:border-border-default hover:text-text-primary disabled:opacity-50"
                        >
                            {downloading ? downloadingLabel : downloadLabel}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void toggleViewer()
                            }}
                            data-testid="artifact-view-full-button"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? collapseLabel : viewFullTitle}
                            title={isOpen ? collapseLabel : viewFullTitle}
                            className="inline-flex min-h-[26px] shrink-0 items-center rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2.5 py-0.5 text-3xs font-semibold text-accent-primary transition-colors hover:bg-accent-primary/20"
                        >
                            {isOpen ? collapseLabel : viewFullLabel}
                        </button>
                    </div>
                </div>

                {!isOpen && previewText && (
                    <pre
                        data-testid="artifact-preview-text"
                        className="max-h-36 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-border-subtle/70 bg-bg-primary/50 p-2 font-mono text-2xs leading-relaxed text-text-secondary"
                    >
                        {previewText}
                    </pre>
                )}

                {isOpen && (
                    <div className="mt-1 flex flex-col gap-2" data-testid="artifact-viewer-panel">
                        {sha256Changed && (
                            <div
                                role="status"
                                data-testid="artifact-hash-changed-warning"
                                className="flex flex-col gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-2xs text-amber-800 dark:text-amber-200"
                            >
                                <span className="font-semibold">{hashWarningTitle}</span>
                                <span className="text-3xs text-amber-700 dark:text-amber-200/85">{hashWarningDetail}</span>
                            </div>
                        )}

                        {loading && (
                            <div
                                data-testid="artifact-loading"
                                className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary/40 px-3 py-3 text-xs text-text-muted"
                            >
                                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-primary" />
                                <span>{loadingLabel}</span>
                            </div>
                        )}

                        {status === 'error' && (
                            <div
                                role="alert"
                                data-testid="artifact-error"
                                data-error-code={errorCode || 'request_failed'}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200"
                            >
                                <span className="min-w-0 flex-1 break-words">
                                    {getArtifactErrorCopy(t, i18n.language, errorCode, error)}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void openViewer()
                                    }}
                                    data-testid="artifact-retry-button"
                                    className="inline-flex min-h-[26px] shrink-0 items-center rounded-md border border-rose-500/40 bg-rose-500/20 px-2.5 py-0.5 text-3xs font-semibold text-rose-900 dark:text-rose-100 hover:bg-rose-500/30"
                                >
                                    {retryLabel}
                                </button>
                            </div>
                        )}

                        {status === 'loaded' && data && (
                            <ArtifactContentRenderer payload={data} objectUrl={objectUrl} />
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

export default AttachmentBubble
