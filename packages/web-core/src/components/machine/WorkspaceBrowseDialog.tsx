import { useEffect, useState } from 'react'
import { IconChevronLeft, IconFolder, IconX } from '../Icons'
import type { BrowseDirectoryEntry } from './workspaceBrowse'
import { getParentBrowsePath } from './workspaceBrowse'

interface WorkspaceBrowseDialogProps {
    title: string
    description: string
    currentPath: string
    directories: BrowseDirectoryEntry[]
    busy?: boolean
    error?: string
    confirmLabel?: string
    onClose: () => void
    onNavigate: (path: string) => void
    onConfirm: (path: string) => void
}

export default function WorkspaceBrowseDialog({
    title,
    description,
    currentPath,
    directories,
    busy = false,
    error = '',
    confirmLabel = 'Use this folder',
    onClose,
    onNavigate,
    onConfirm,
}: WorkspaceBrowseDialogProps) {
    const [pathInput, setPathInput] = useState(currentPath)

    useEffect(() => {
        setPathInput(currentPath)
    }, [currentPath])

    const parentPath = getParentBrowsePath(currentPath)
    const trimmedPathInput = pathInput.trim()

    return (
        <div
            className="fixed inset-0 z-[110] flex items-end justify-center overflow-y-auto bg-black/60 backdrop-blur-[2px] px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-browse-title"
        >
            <div className="w-full max-w-2xl max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] sm:max-h-[min(86vh,720px)] rounded-[24px] sm:rounded-2xl border border-border-subtle bg-bg-secondary shadow-xl overflow-hidden flex flex-col">
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border-subtle">
                    <div className="min-w-0">
                        <h2 id="workspace-browse-title" className="m-0 text-base font-semibold text-text-primary">
                            {title}
                        </h2>
                        <p className="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                            {description}
                        </p>
                    </div>
                    <button
                        type="button"
                        className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border-subtle bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-colors shrink-0"
                        onClick={onClose}
                        aria-label="Close folder browser"
                    >
                        <IconX size={16} />
                    </button>
                </div>

                <div className="px-5 py-3 border-b border-border-subtle bg-bg-primary/60 flex items-start gap-2">
                    <button
                        type="button"
                        className="inline-flex items-center gap-1.5 min-h-[34px] px-3 rounded-lg border border-border-subtle bg-bg-secondary text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                        onClick={() => {
                            if (!parentPath || busy) return
                            onNavigate(parentPath)
                        }}
                        disabled={!parentPath || busy}
                    >
                        <IconChevronLeft size={15} />
                        Parent
                    </button>
                    <div className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">Current folder</div>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={pathInput}
                                onChange={(event) => setPathInput(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter' || !trimmedPathInput || busy) return
                                    event.preventDefault()
                                    onNavigate(trimmedPathInput)
                                }}
                                placeholder="Type a folder path"
                                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary"
                            />
                            <button
                                type="button"
                                className="inline-flex items-center justify-center min-h-[36px] px-3 rounded-lg border border-border-subtle bg-bg-primary text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors text-xs font-semibold shrink-0"
                                onClick={() => {
                                    if (!trimmedPathInput || busy) return
                                    onNavigate(trimmedPathInput)
                                }}
                                disabled={!trimmedPathInput || busy}
                            >
                                Go
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto bg-bg-primary/40">
                    {busy ? (
                        <div className="px-5 py-5 text-sm text-text-secondary">Loading folders…</div>
                    ) : error ? (
                        <div className="px-5 py-5 text-sm text-status-error">{error}</div>
                    ) : directories.length === 0 ? (
                        <div className="px-5 py-5 text-sm text-text-secondary">No subfolders here.</div>
                    ) : (
                        <div className="p-3">
                            {directories.map((directory) => (
                                <button
                                    key={directory.path}
                                    type="button"
                                    className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left border border-transparent hover:border-border-subtle hover:bg-bg-secondary transition-colors"
                                    onClick={() => onNavigate(directory.path)}
                                >
                                    <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-accent-primary/10 text-accent-primary shrink-0">
                                        <IconFolder size={17} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium text-text-primary truncate">{directory.name}</span>
                                        <span className="block text-[11px] text-text-muted truncate">{directory.path}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 px-4 py-[calc(12px+env(safe-area-inset-bottom,0px))] sm:px-5 sm:py-4 border-t border-border-subtle bg-bg-secondary shrink-0">
                    <button
                        type="button"
                        className="machine-btn text-xs"
                        onClick={onClose}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary h-9 px-4 text-sm font-semibold"
                        onClick={() => onConfirm(trimmedPathInput || currentPath)}
                        disabled={(!trimmedPathInput && !currentPath) || busy}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}
