/**
 * useConfirmDialog — promise-based in-app replacement for window.confirm.
 *
 * Native confirm() is silently auto-dismissed (returns false without ever
 * rendering) in embedded browsers and webviews, turning any gate built on it
 * into a no-op there. This hook keeps the imperative call shape:
 *
 *   const { confirm, confirmDialog } = useConfirmDialog()
 *   ...
 *   if (!(await confirm({ title, description, confirmLabel }))) return
 *
 * Render {confirmDialog} once in the component's JSX. A new confirm() while
 * one is pending cancels the previous request (resolves it false).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

export interface ConfirmDialogRequest {
    title: string
    description?: string
    confirmLabel: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
}

export function useConfirmDialog() {
    const [pending, setPending] = useState<ConfirmDialogRequest | null>(null)
    const resolveRef = useRef<((confirmed: boolean) => void) | null>(null)

    const settle = useCallback((confirmed: boolean) => {
        setPending(null)
        const resolve = resolveRef.current
        resolveRef.current = null
        resolve?.(confirmed)
    }, [])

    const confirm = useCallback((request: ConfirmDialogRequest): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            resolveRef.current?.(false)
            resolveRef.current = resolve
            setPending(request)
        })
    }, [])

    // Unmount while pending → the caller's await must not hang forever.
    useEffect(() => () => { resolveRef.current?.(false) }, [])

    const confirmDialog = pending ? (
        <ConfirmDialog
            title={pending.title}
            description={pending.description}
            confirmLabel={pending.confirmLabel}
            cancelLabel={pending.cancelLabel}
            tone={pending.tone}
            onConfirm={() => settle(true)}
            onCancel={() => settle(false)}
        />
    ) : null

    return { confirm, confirmDialog }
}
