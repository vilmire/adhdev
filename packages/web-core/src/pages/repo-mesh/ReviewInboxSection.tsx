import { useState, useCallback } from 'react'
import type { MeshReviewInboxItem } from '@adhdev/daemon-core'
import { Section } from '../../components/ui/Section'
import GitDiffPreview from '../../components/git/GitDiffPreview'
import { IconRefresh } from './icons'

interface ReviewInboxSectionProps {
    items: MeshReviewInboxItem[]
    loading: boolean
    error: string | null
    remoteNodesExcluded: boolean
    meshId: string
    activeDaemonId: string
    onRefresh: () => void
    onDismiss: (nodeId: string) => void
    onRefineNode: (nodeId: string) => void
    onRequeueLast: (nodeId: string) => void
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

function reasonLabel(reason: string): { label: string; color: string } {
    if (reason === 'refine_blocked_review') return { label: 'Blocked review', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' }
    return { label: 'Merge candidate', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' }
}

function bootstrapBadge(bootstrap: Record<string, unknown> | null | undefined): { label: string; color: string } | null {
    if (!bootstrap) return null
    const stage = typeof bootstrap.stage === 'string' ? bootstrap.stage : null
    const passed = bootstrap.passed === true
    if (!stage) return null
    const colors: Record<string, string> = {
        ran: passed ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20',
        cached: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
        failed: 'text-red-400 bg-red-500/10 border-red-500/20',
        skipped: 'text-text-muted bg-bg-secondary border-border-subtle',
        legacy: 'text-text-muted bg-bg-secondary border-border-subtle',
        not_configured: 'text-text-muted bg-bg-secondary border-border-subtle',
    }
    return { label: `bootstrap: ${stage}`, color: colors[stage] ?? 'text-text-muted bg-bg-secondary border-border-subtle' }
}

function DiffFileRow({ file }: { file: { path: string; status?: string; insertions?: number; deletions?: number } }) {
    const statusColor: Record<string, string> = {
        added: 'text-green-400',
        deleted: 'text-red-400',
        modified: 'text-amber-400',
        renamed: 'text-blue-400',
    }
    const color = statusColor[file.status ?? ''] ?? 'text-text-muted'
    return (
        <div className="flex items-center justify-between gap-2 py-0.5">
            <span className={`text-[11px] font-mono truncate flex-1 ${color}`}>{file.path}</span>
            {(file.insertions != null || file.deletions != null) && (
                <span className="text-[10px] text-text-muted shrink-0">
                    {file.insertions != null && <span className="text-green-400">+{file.insertions}</span>}
                    {file.deletions != null && <span className="text-red-400 ml-1">-{file.deletions}</span>}
                </span>
            )}
        </div>
    )
}

interface ReviewCardProps {
    item: MeshReviewInboxItem
    activeDaemonId: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
    onDismiss: (nodeId: string) => void
    onRefineNode: (nodeId: string) => void
    onRequeueLast: (nodeId: string) => void
}

function ReviewCard({ item, activeDaemonId, sendCommand, onDismiss, onRefineNode, onRequeueLast }: ReviewCardProps) {
    const [expandedFile, setExpandedFile] = useState<string | null>(null)
    const [fileDiff, setFileDiff] = useState<string | null>(null)
    const [fileDiffLoading, setFileDiffLoading] = useState(false)
    const [fileDiffError, setFileDiffError] = useState<string | null>(null)

    const { label: reasonText, color: reasonColor } = reasonLabel(item.reviewReason)
    const bootstrap = bootstrapBadge(item.evidence.bootstrap)
    const diffFiles = item.diffSummary?.files ?? []
    const baseRef = item.diffSummary?.baseRef ?? null

    const loadFileDiff = useCallback(async (filePath: string) => {
        if (!item.workspace || !activeDaemonId) return
        if (expandedFile === filePath) {
            setExpandedFile(null)
            setFileDiff(null)
            return
        }
        setExpandedFile(filePath)
        setFileDiff(null)
        setFileDiffLoading(true)
        setFileDiffError(null)
        try {
            const res: any = await sendCommand(activeDaemonId, 'git_diff_file', {
                workspace: item.workspace,
                path: filePath,
                ...(baseRef ? { base: baseRef } : {}),
            })
            if (res?.success !== false && typeof res?.diff === 'string') {
                setFileDiff(res.diff)
            } else if (res?.diff != null) {
                setFileDiff(String(res.diff))
            } else {
                setFileDiffError(res?.error || 'No diff available')
            }
        } catch (e: any) {
            setFileDiffError(e?.message || 'Failed to load diff')
        } finally {
            setFileDiffLoading(false)
        }
    }, [item.workspace, activeDaemonId, sendCommand, expandedFile, baseRef])

    return (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary p-4 space-y-3">
            {/* Header row */}
            <div className="flex flex-wrap items-start gap-2 justify-between">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-[12px] font-semibold text-text-primary font-mono truncate max-w-[240px]">
                        {item.branch ?? item.nodeId}
                    </span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${reasonColor}`}>
                        {reasonText}
                    </span>
                    {bootstrap && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${bootstrap.color}`}>
                            {bootstrap.label}
                        </span>
                    )}
                    {item.activeRefineJob && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border text-blue-400 bg-blue-500/10 border-blue-500/20">
                            refine running
                        </span>
                    )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                    <button
                        className="btn btn-primary btn-sm text-[11px]"
                        onClick={() => onRefineNode(item.nodeId)}
                        disabled={!!item.activeRefineJob}
                    >
                        Refine
                    </button>
                    <button
                        className="btn btn-secondary btn-sm text-[11px]"
                        onClick={() => onRequeueLast(item.nodeId)}
                    >
                        Requeue
                    </button>
                    <button
                        className="btn btn-secondary btn-sm text-[11px]"
                        onClick={() => onDismiss(item.nodeId)}
                    >
                        Dismiss
                    </button>
                </div>
            </div>

            {/* Workspace */}
            {item.workspace && (
                <div className="text-[10px] text-text-muted font-mono truncate">{item.workspace}</div>
            )}

            {/* Evidence summary */}
            {item.evidence.available && (
                <div className="text-[11px] text-text-secondary space-y-0.5">
                    {item.evidence.source === 'task_completion' && item.evidence.worker && (
                        <span>
                            Last task: <span className={item.evidence.worker.status === 'success' ? 'text-green-400' : 'text-red-400'}>{item.evidence.worker.status}</span>
                            {item.evidence.worker.classification && <span className="text-text-muted ml-1">({item.evidence.worker.classification})</span>}
                            {item.evidence.worker.errors.length > 0 && (
                                <span className="text-red-400 ml-1">· {item.evidence.worker.errors[0]}</span>
                            )}
                        </span>
                    )}
                    {item.evidence.source === 'refine_job' && (
                        <span>
                            Refinery: <span className="text-amber-400">{item.convergence.status}</span>
                            {item.convergence.nextStep && <span className="text-text-muted ml-1">→ {item.convergence.nextStep}</span>}
                        </span>
                    )}
                </div>
            )}

            {/* Diff summary */}
            {item.diffSummary && item.diffSummary.files.length > 0 && (
                <div className="space-y-1">
                    <div className="text-[10px] text-text-muted flex gap-3">
                        <span>{item.diffSummary.totalFiles} file{item.diffSummary.totalFiles !== 1 ? 's' : ''}</span>
                        <span className="text-green-400">+{item.diffSummary.totalInsertions}</span>
                        <span className="text-red-400">-{item.diffSummary.totalDeletions}</span>
                        {item.diffSummary.truncated && <span className="text-amber-400">truncated</span>}
                        {baseRef && <span className="font-mono">vs {baseRef}</span>}
                    </div>
                    <div className="border border-border-subtle rounded px-2 py-1 bg-bg-primary space-y-0.5">
                        {diffFiles.slice(0, 20).map(file => (
                            <div key={file.path}>
                                <button
                                    className="w-full text-left hover:bg-bg-secondary rounded px-1 transition-colors"
                                    onClick={() => loadFileDiff(file.path)}
                                >
                                    <DiffFileRow file={file} />
                                </button>
                                {expandedFile === file.path && (
                                    <div className="mt-1 mb-1">
                                        <GitDiffPreview
                                            diff={fileDiff ?? ''}
                                            loading={fileDiffLoading}
                                            error={fileDiffError ?? undefined}
                                            truncated={false}
                                            className="text-[10px]"
                                        />
                                    </div>
                                )}
                            </div>
                        ))}
                        {diffFiles.length > 20 && (
                            <div className="text-[10px] text-text-muted px-1 pt-0.5">
                                +{diffFiles.length - 20} more files
                            </div>
                        )}
                    </div>
                </div>
            )}
            {item.diffSummary?.error && (
                <div className="text-[11px] text-amber-400">Diff probe: {item.diffSummary.error}</div>
            )}
        </div>
    )
}

export function ReviewInboxSection({
    items,
    loading,
    error,
    remoteNodesExcluded,
    meshId: _meshId,
    activeDaemonId,
    onRefresh,
    onDismiss,
    onRefineNode,
    onRequeueLast,
    sendCommand,
}: ReviewInboxSectionProps) {
    return (
        <Section
            title="Review Inbox"
            description="Local worktree nodes that need review: merge candidates and Refinery-blocked results. Click a file to preview its diff."
        >
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    {items.length > 0 && (
                        <span className="text-[12px] font-semibold text-accent-primary">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                    )}
                    {remoteNodesExcluded && (
                        <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded border border-border-subtle bg-bg-secondary">
                            remote nodes excluded
                        </span>
                    )}
                </div>
                <button
                    className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
                    onClick={onRefresh}
                    disabled={loading}
                >
                    <IconRefresh size={12} />
                    {loading ? 'Loading...' : 'Refresh'}
                </button>
            </div>

            {error && (
                <div className="mb-3 text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    {error}
                </div>
            )}

            {!loading && !error && items.length === 0 && (
                <div className="text-[12px] text-text-muted rounded-lg border border-border-subtle bg-bg-secondary px-3 py-3">
                    No local nodes require review.
                    {remoteNodesExcluded && ' Remote nodes are excluded in this view.'}
                </div>
            )}

            <div className="space-y-3">
                {items.map(item => (
                    <ReviewCard
                        key={item.nodeId}
                        item={item}
                        activeDaemonId={activeDaemonId}
                        sendCommand={sendCommand}
                        onDismiss={onDismiss}
                        onRefineNode={onRefineNode}
                        onRequeueLast={onRequeueLast}
                    />
                ))}
            </div>
        </Section>
    )
}
