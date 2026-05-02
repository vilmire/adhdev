import { useCallback, useState } from 'react'
import type { GitDiffSummary, GitFileChange } from '@adhdev/daemon-core'
import { useTransport } from '../../context/TransportContext'
import { useGitRemoteUrl } from '../../hooks/useGitRemoteUrl'
import { useWorkspaceGitStatus } from '../../hooks/useWorkspaceGitStatus'
import { IconX } from '../Icons'
import GitChangeList from './GitChangeList'
import GitDiffPreview from './GitDiffPreview'

export interface GitStatusDialogProps {
    daemonId: string
    workspace: string
    onClose: () => void
}

interface FileDiffState {
    path: string
    diff: string
    binary: boolean
    truncated: boolean
    loading: boolean
    error: string | null
}

type ActionKind = 'checkpoint' | 'stash' | 'stash_pop' | 'checkout_files' | null

function buildPRSummary(branch: string | null, diffSummary: GitDiffSummary): string {
    const parts = [`Branch: ${branch || 'unknown'}`]
    parts.push(`Changed: ${diffSummary.files.length} file(s) +${diffSummary.totalInsertions}/-${diffSummary.totalDeletions}`)
    const byStatus: Record<string, string[]> = {}
    for (const f of diffSummary.files) {
        if (!byStatus[f.status]) byStatus[f.status] = []
        byStatus[f.status].push(f.path)
    }
    for (const [status, paths] of Object.entries(byStatus)) {
        parts.push(`${status}: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`)
    }
    return parts.join('\n')
}

export default function GitStatusDialog({ daemonId, workspace, onClose }: GitStatusDialogProps) {
    const { sendCommand } = useTransport()
    const { status, diffSummary, loading, error, refresh } = useWorkspaceGitStatus({
        daemonId,
        workspace,
        includeDiffSummary: true,
    })
    const [selectedFile, setSelectedFile] = useState<FileDiffState | null>(null)
    const [pendingAction, setPendingAction] = useState<ActionKind>(null)
    const [actionMessage, setActionMessage] = useState('')
    const [includeUntracked, setIncludeUntracked] = useState(false)
    const [actionLoading, setActionLoading] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const [actionSuccess, setActionSuccess] = useState<string | null>(null)
    const { githubUrl } = useGitRemoteUrl(daemonId, workspace)

    const handleFileClick = useCallback(async (file: GitFileChange) => {
        if (selectedFile?.path === file.path && !selectedFile.loading) return
        setSelectedFile({ path: file.path, diff: '', binary: false, truncated: false, loading: true, error: null })
        try {
            const res = await sendCommand(daemonId, 'git_diff_file', {
                workspace,
                path: file.path,
                staged: file.staged,
            })
            const body = res?.result ?? res
            if (body?.success === false || body?.error) {
                setSelectedFile({ path: file.path, diff: '', binary: false, truncated: false, loading: false, error: body?.error ?? 'Failed to load diff' })
                return
            }
            setSelectedFile({
                path: file.path,
                diff: body?.diff ?? '',
                binary: body?.binary ?? false,
                truncated: body?.truncated ?? false,
                loading: false,
                error: null,
            })
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load diff'
            setSelectedFile({ path: file.path, diff: '', binary: false, truncated: false, loading: false, error: msg })
        }
    }, [daemonId, sendCommand, selectedFile, workspace])

    const openAction = useCallback((kind: ActionKind) => {
        setActionMessage('')
        setIncludeUntracked(false)
        setActionError(null)
        setActionSuccess(null)
        setPendingAction(kind)
    }, [])

    const cancelAction = useCallback(() => {
        setPendingAction(null)
        setActionError(null)
        setActionLoading(false)
    }, [])

    const confirmAction = useCallback(async () => {
        if (!pendingAction) return
        setActionLoading(true)
        setActionError(null)
        try {
            let res: any
            if (pendingAction === 'checkpoint') {
                res = await sendCommand(daemonId, 'git_checkpoint', {
                    workspace,
                    message: actionMessage,
                    includeUntracked,
                })
            } else if (pendingAction === 'stash') {
                res = await sendCommand(daemonId, 'git_stash_push', {
                    workspace,
                    message: actionMessage,
                    includeUntracked,
                })
            } else if (pendingAction === 'stash_pop') {
                res = await sendCommand(daemonId, 'git_stash_pop', {
                    workspace,
                })
            } else if (pendingAction === 'checkout_files' && selectedFile) {
                res = await sendCommand(daemonId, 'git_checkout_files', {
                    workspace,
                    paths: [selectedFile.path],
                })
            }
            const body = res?.result ?? res
            if (body?.success === false || body?.error) {
                setActionError(body?.error ?? 'Action failed')
                setActionLoading(false)
                return
            }
            if (pendingAction === 'checkpoint') {
                setActionSuccess(`Checkpoint created: ${body?.checkpoint?.commit?.slice(0, 7) ?? 'done'}`)
            } else if (pendingAction === 'stash') {
                setActionSuccess(`Stashed as ${body?.stash?.stashRef ?? 'stash@{0}'}`)
            } else if (pendingAction === 'stash_pop') {
                setActionSuccess('Stash restored')
            } else {
                setActionSuccess('File reverted')
                setSelectedFile(null)
            }
            setPendingAction(null)
            await refresh()
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Action failed')
        } finally {
            setActionLoading(false)
        }
    }, [pendingAction, sendCommand, daemonId, workspace, actionMessage, includeUntracked, selectedFile, refresh])

    const hasConflicts = Boolean(status?.hasConflicts)

    const totalChanged = status
        ? status.staged + status.modified + status.untracked + status.deleted + status.renamed
        : null

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
            <div className="relative flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
                {/* Header */}
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
                    <span aria-hidden="true" className="text-sm">⑂</span>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-text-primary">
                            {status?.branch ?? 'Git Status'}
                        </p>
                        <p className="truncate text-xs text-text-secondary">{workspace}</p>
                        {githubUrl && (
                            <a
                                href={`${githubUrl}/tree/${status?.branch || 'main'}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="truncate text-[10px] text-text-secondary hover:text-sky-400 underline"
                                title="Open on GitHub"
                            >
                                GitHub ↗
                            </a>
                        )}
                    </div>
                    <button
                        onClick={refresh}
                        disabled={loading}
                        className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                        title="Refresh"
                    >
                        ↺
                    </button>
                    <button
                        onClick={onClose}
                        className="rounded p-1 text-text-secondary hover:text-text-primary"
                        aria-label="Close"
                    >
                        <IconX className="h-4 w-4" />
                    </button>
                </div>

                {/* Status summary strip */}
                {status && (
                    <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-border/50 px-4 py-2 text-xs text-text-secondary">
                        {status.headCommit && (
                            <span title={status.headMessage ?? undefined}>
                                <span className="font-mono">{status.headCommit.slice(0, 7)}</span>
                                {status.headMessage && <span className="ml-1 truncate">{status.headMessage.slice(0, 60)}</span>}
                            </span>
                        )}
                        {status.ahead > 0 && <span className="text-orange-400">↑{status.ahead} ahead</span>}
                        {status.behind > 0 && <span className="text-orange-400">↓{status.behind} behind</span>}
                        {status.staged > 0 && <span className="text-emerald-400">{status.staged} staged</span>}
                        {status.modified > 0 && <span>{status.modified} modified</span>}
                        {status.untracked > 0 && <span>{status.untracked} untracked</span>}
                        {status.deleted > 0 && <span className="text-red-400">{status.deleted} deleted</span>}
                        {status.stashCount > 0 && <span>{status.stashCount} stashed</span>}
                        {status.hasConflicts && <span className="font-bold text-red-400">conflicts</span>}
                        {totalChanged === 0 && !status.error && <span className="text-emerald-500">clean</span>}
                        {diffSummary && diffSummary.files.length > 0 && (
                            <span className="text-text-secondary">
                                {diffSummary.files.length} file{diffSummary.files.length !== 1 ? 's' : ''}
                                {diffSummary.totalInsertions > 0 && <span className="text-emerald-500"> +{diffSummary.totalInsertions}</span>}
                                {diffSummary.totalDeletions > 0 && <span className="text-red-400"> -{diffSummary.totalDeletions}</span>}
                            </span>
                        )}
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="shrink-0 border-b border-border/50 bg-red-500/10 px-4 py-2 text-xs text-red-400">
                        {error}
                    </div>
                )}

                {/* Body */}
                <div className="flex min-h-0 flex-1">
                    {/* File list */}
                    <div className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border/50">
                        {loading && !diffSummary && (
                            <p className="px-3 py-4 text-xs text-text-secondary">Loading…</p>
                        )}
                        {diffSummary && (
                            <GitChangeList
                                files={diffSummary.files}
                                truncated={diffSummary.truncated}
                                selectedPath={selectedFile?.path ?? null}
                                onFileClick={handleFileClick}
                            />
                        )}
                        {!loading && !diffSummary && !error && (
                            <p className="px-3 py-4 text-xs text-text-secondary">No diff data.</p>
                        )}
                    </div>

                    {/* Diff pane */}
                    <div className="min-w-0 flex-1 overflow-hidden">
                        {selectedFile ? (
                            <GitDiffPreview
                                diff={selectedFile.diff}
                                binary={selectedFile.binary}
                                truncated={selectedFile.truncated}
                                loading={selectedFile.loading}
                                error={selectedFile.error}
                                className="h-full"
                            />
                        ) : (
                            <div className="flex h-full items-center justify-center text-xs text-text-secondary">
                                Select a file to view diff
                            </div>
                        )}
                    </div>
                </div>

                {/* Action success banner */}
                {actionSuccess && (
                    <div className="shrink-0 border-t border-border/50 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-400 flex items-center justify-between">
                        <span>{actionSuccess}</span>
                        <button onClick={() => setActionSuccess(null)} className="ml-2 text-emerald-400 hover:text-text-primary">&times;</button>
                    </div>
                )}

                {/* Action bar */}
                <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
                    <button
                        onClick={() => openAction('checkpoint')}
                        disabled={hasConflicts}
                        title={hasConflicts ? 'Resolve conflicts before checkpointing' : 'Create a git commit checkpoint'}
                        className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed border border-border/50 hover:border-border"
                    >
                        Checkpoint
                    </button>
                    <button
                        onClick={() => openAction('stash')}
                        disabled={hasConflicts}
                        title={hasConflicts ? 'Resolve conflicts before stashing' : 'Stash current changes'}
                        className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed border border-border/50 hover:border-border"
                    >
                        Stash
                    </button>
                    <button
                        onClick={() => openAction('stash_pop')}
                        disabled={hasConflicts || !status?.stashCount}
                        title={
                            hasConflicts
                                ? 'Resolve conflicts before restoring a stash'
                                : status?.stashCount
                                    ? 'Restore the latest stash'
                                    : 'No stashes to restore'
                        }
                        className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed border border-border/50 hover:border-border"
                    >
                        Pop stash
                    </button>
                    <button
                        onClick={() => openAction('checkout_files')}
                        disabled={!selectedFile}
                        title={selectedFile ? `Revert changes to ${selectedFile.path}` : 'Select a file to revert'}
                        className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed border border-border/50 hover:border-border"
                    >
                        Checkout selected
                    </button>
                    {diffSummary && diffSummary.files.length > 0 && (
                        <button
                            onClick={() => {
                                const text = buildPRSummary(status?.branch ?? null, diffSummary)
                                void navigator.clipboard.writeText(text)
                                setActionSuccess('Copied to clipboard')
                                setTimeout(() => setActionSuccess(null), 2000)
                            }}
                            className="rounded border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                        >
                            Copy summary
                        </button>
                    )}
                </div>

                {/* Confirmation overlay (inline, no portal) */}
                {pendingAction && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
                    <div className="flex w-80 flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-xl">
                        <p className="text-sm font-semibold text-text-primary">
                            {pendingAction === 'checkpoint' && 'Create checkpoint commit'}
                            {pendingAction === 'stash' && 'Stash changes'}
                            {pendingAction === 'stash_pop' && 'Restore latest stash?'}
                            {pendingAction === 'checkout_files' && `Revert changes to ${selectedFile?.path ?? 'file'}?`}
                        </p>

                        {(pendingAction === 'checkpoint' || pendingAction === 'stash') && (
                            <>
                                <input
                                    type="text"
                                    value={actionMessage}
                                    onChange={(e) => setActionMessage(e.target.value)}
                                    maxLength={200}
                                    placeholder="Message (required)"
                                    className="rounded border border-border bg-surface-alt px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-border"
                                    autoFocus
                                />
                                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={includeUntracked}
                                        onChange={(e) => setIncludeUntracked(e.target.checked)}
                                    />
                                    Include untracked files
                                </label>
                            </>
                        )}

                        {actionError && (
                            <p className="text-xs text-red-400">{actionError}</p>
                        )}

                        <div className="flex justify-end gap-2">
                            <button
                                onClick={cancelAction}
                                disabled={actionLoading}
                                className="rounded px-3 py-1 text-xs text-text-secondary hover:text-text-primary border border-border/50 disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmAction}
                                disabled={actionLoading || ((pendingAction === 'checkpoint' || pendingAction === 'stash') && !actionMessage.trim())}
                                className="rounded px-3 py-1 text-xs text-text-primary bg-border hover:bg-border/80 disabled:opacity-40"
                            >
                                {actionLoading ? 'Working…' : 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            </div>
        </div>
    )
}
