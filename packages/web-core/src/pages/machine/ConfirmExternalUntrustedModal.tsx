/**
 * ConfirmExternalUntrustedModal — gated confirmation before launching a
 * provider whose manifest came from a 3rd-party git URL and ships JS the
 * daemon hasn't audited. Mirrors the `untrusted_external_provider` error
 * the daemon returns from `launch_cli` when `confirmExternalUntrusted`
 * isn't set.
 *
 * The dashboard renders this modal once per provider/session; on confirm
 * the parent resends the original launch with `confirmExternalUntrusted:
 * true`. Cancel just dismisses.
 */
import { useEffect, useRef } from 'react'

interface ConfirmExternalUntrustedModalProps {
    /** Provider type the user is trying to activate. */
    providerType: string
    /** Source the manifest came from, if known (e.g. "@vendor-foo"). */
    sourceName: string | null
    /** Daemon-side description from list_provider_availability.trustDescription. */
    description?: string
    onConfirm: () => void
    onCancel: () => void
}

export default function ConfirmExternalUntrustedModal({
    providerType,
    sourceName,
    description,
    onConfirm,
    onCancel,
}: ConfirmExternalUntrustedModalProps) {
    const cancelRef = useRef<HTMLButtonElement | null>(null)

    useEffect(() => { cancelRef.current?.focus() }, [])
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm untrusted external provider"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={onCancel}
            style={{ pointerEvents: 'auto' }}
        >
            <div
                className="bg-[var(--surface-primary)] text-text-primary border border-amber-500/40 rounded-lg shadow-xl max-w-lg w-full"
                onClick={e => e.stopPropagation()}
            >
                <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
                    <span aria-hidden className="text-amber-400 text-base">⚠</span>
                    <h2 className="text-sm font-semibold">Activate untrusted external provider?</h2>
                </div>
                <div className="px-4 py-3 text-[12px] flex flex-col gap-3">
                    <p>
                        You're about to activate <span className="font-mono">{providerType}</span>
                        {sourceName ? <> from <span className="font-mono">{sourceName}</span></> : null}.
                    </p>
                    <p className="text-text-secondary">
                        {description ?? 'This manifest ships JavaScript that the daemon will execute. Treat as untrusted code — review the source before enabling.'}
                    </p>
                    <p className="text-text-secondary">
                        Only proceed if you trust the source URL you added and have reviewed the manifest.
                    </p>
                </div>
                <div className="px-4 py-2 border-t border-border-subtle flex justify-end gap-2">
                    <button
                        ref={cancelRef}
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1 text-sm rounded border border-border-default hover:bg-surface-secondary"
                    >Cancel</button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="px-3 py-1 text-sm rounded bg-amber-500 text-black font-semibold hover:opacity-90"
                    >Activate</button>
                </div>
            </div>
        </div>
    )
}
