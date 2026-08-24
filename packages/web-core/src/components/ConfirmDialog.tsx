/**
 * ConfirmDialog — in-app replacement for window.confirm.
 *
 * Native confirm() is silently auto-dismissed (returns false without ever
 * rendering) in embedded browsers and webviews, which turns any button gated
 * on it into a no-op there. Destructive or consequential actions should render
 * this dialog instead.
 */
import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface ConfirmDialogProps {
    title: string
    description?: string
    confirmLabel: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
    busy?: boolean
    onConfirm: () => void
    onCancel: () => void
}

export default function ConfirmDialog({
    title,
    description,
    confirmLabel,
    cancelLabel,
    tone = 'default',
    busy = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const { t } = useTranslation('common')

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onCancel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [onCancel])

    const tree = (
        <div
            className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}
        >
            <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-bg-secondary shadow-xl overflow-hidden">
                <div className="px-5 py-4">
                    <div id="confirm-dialog-title" className="text-sm font-semibold text-text-primary">{title}</div>
                    {description && (
                        <div className="mt-1.5 text-xs text-text-secondary whitespace-pre-line break-words">{description}</div>
                    )}
                </div>
                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
                    <button
                        type="button"
                        className="btn btn-secondary h-9 px-4 text-sm"
                        disabled={busy}
                        onClick={onCancel}
                    >{cancelLabel ?? t('common.cancel')}</button>
                    <button
                        type="button"
                        autoFocus
                        className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'} h-9 px-4 text-sm font-semibold`}
                        disabled={busy}
                        onClick={onConfirm}
                    >{confirmLabel}</button>
                </div>
            </div>
        </div>
    )

    return createPortal(tree, document.body)
}
