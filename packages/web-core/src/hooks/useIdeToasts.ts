import { useCallback, useState } from 'react'

type IdeToast = {
    id: number
    message: string
    type: 'success' | 'info' | 'warning'
    timestamp?: number
    targetKey?: string
    actions?: unknown
}

export function useIdeToasts() {
    const [toasts, setToasts] = useState<IdeToast[]>([])

    const dismissToast = useCallback((id: number) => {
        setToasts(prev => prev.filter(toast => toast.id !== id))
    }, [])

    const pushToast = useCallback((message: string, type: IdeToast['type'] = 'warning') => {
        const id = Date.now() + Math.floor(Math.random() * 1000)
        setToasts(prev => [...prev, { id, message, type }])
        window.setTimeout(() => {
            setToasts(prev => prev.filter(toast => toast.id !== id))
        }, 5000)
    }, [])

    return {
        toasts,
        setToasts,
        dismissToast,
        pushToast,
    }
}
