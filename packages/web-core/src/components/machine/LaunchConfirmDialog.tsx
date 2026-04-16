import { IconPlay, IconX } from '../Icons'
import type { LaunchWorkspaceOption } from '../../pages/machine/types'

interface LaunchConfirmDialogProps {
    title: string
    description: string
    details: Array<{ label: string; value: string }>
    workspaceOptions?: LaunchWorkspaceOption[]
    selectedWorkspaceKey?: string
    onWorkspaceChange?: (key: string) => void
    confirmLabel?: string
    busyLabel?: string
    busy?: boolean
    showArgsInput?: boolean
    argsValue?: string
    onArgsChange?: (val: string) => void
    showModelInput?: boolean
    modelValue?: string
    onModelChange?: (val: string) => void
    historyProviderNode?: React.ReactNode
    onConfirm: () => void
    onCancel: () => void
}

export default function LaunchConfirmDialog({
    title,
    description,
    details,
    workspaceOptions,
    selectedWorkspaceKey,
    onWorkspaceChange,
    confirmLabel = 'Launch',
    busyLabel = 'Launching…',
    busy = false,
    showArgsInput,
    argsValue,
    onArgsChange,
    showModelInput,
    modelValue,
    onModelChange,
    historyProviderNode,
    onConfirm,
    onCancel,
}: LaunchConfirmDialogProps) {
    const selectedWorkspace = workspaceOptions?.find(option => option.key === selectedWorkspaceKey)

    return (
        <div
            className="fixed inset-0 z-[110] flex items-end justify-center overflow-y-auto bg-black/60 backdrop-blur-[2px] px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="launch-confirm-title"
        >
            <div className="w-full max-w-lg max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] sm:max-h-[min(88vh,720px)] rounded-[24px] sm:rounded-2xl border border-border-subtle bg-bg-secondary shadow-xl overflow-hidden flex flex-col">
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border-subtle">
                    <div className="min-w-0">
                        <h2 id="launch-confirm-title" className="m-0 text-base font-semibold text-text-primary">
                            {title}
                        </h2>
                        <p className="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                            {description}
                        </p>
                    </div>
                    <button
                        type="button"
                        className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border-subtle bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-colors shrink-0"
                        onClick={onCancel}
                        aria-label="Close launch confirmation"
                    >
                        <IconX size={16} />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4 flex flex-col gap-3">
                    {workspaceOptions && workspaceOptions.length > 0 && onWorkspaceChange && (
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">
                                Workspace
                            </div>
                            <select
                                value={selectedWorkspaceKey || ''}
                                onChange={(event) => onWorkspaceChange(event.target.value)}
                                className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                disabled={busy}
                            >
                                {workspaceOptions.map(option => (
                                    <option key={option.key} value={option.key}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            {selectedWorkspace?.description && (
                                <div className="mt-2 text-[11px] text-text-muted break-all">
                                    {selectedWorkspace.description}
                                </div>
                            )}
                        </div>
                    )}
                    {historyProviderNode}
                    {details.map((detail) => (
                        <div key={`${detail.label}:${detail.value}`} className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">
                                {detail.label}
                            </div>
                            <div className="text-sm text-text-primary break-all">
                                {detail.value}
                            </div>
                        </div>
                    ))}
                    {showModelInput && onModelChange && (
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">
                                Language Model (Optional)
                            </div>
                            <input
                                type="text"
                                value={modelValue || ''}
                                onChange={(e) => onModelChange(e.target.value)}
                                placeholder="Auto-detect or default"
                                className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm placeholder:text-text-muted"
                                disabled={busy}
                            />
                        </div>
                    )}
                    {showArgsInput && onArgsChange && (
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">
                                CLI Arguments (Optional)
                            </div>
                            <input
                                type="text"
                                value={argsValue || ''}
                                onChange={(e) => onArgsChange(e.target.value)}
                                placeholder="e.g. --experimental"
                                className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm placeholder:text-text-muted"
                                disabled={busy}
                            />
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 px-4 py-[calc(12px+env(safe-area-inset-bottom,0px))] sm:px-5 sm:py-4 border-t border-border-subtle bg-bg-secondary shrink-0">
                    <button
                        type="button"
                        className="machine-btn text-xs"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary h-9 px-4 text-sm font-semibold inline-flex items-center gap-2"
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        <IconPlay size={14} />
                        {busy ? busyLabel : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}
