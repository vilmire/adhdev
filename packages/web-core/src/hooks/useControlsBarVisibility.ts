import { useCallback, useEffect, useState } from 'react'

export const CONTROLS_BAR_VISIBILITY_STORAGE_KEY = 'adhdev_controls_bar_visible'
const CONTROLS_BAR_VISIBILITY_EVENT = 'adhdev:controlsbarvisibilitychange'

export function getStoredControlsBarVisibility(
    storage?: Pick<Storage, 'getItem'> | null,
): boolean {
    if (!storage) return false
    try {
        return storage.getItem(CONTROLS_BAR_VISIBILITY_STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

function setStoredControlsBarVisibility(
    visible: boolean,
    storage?: Pick<Storage, 'setItem'> | null,
) {
    if (!storage) return
    try {
        storage.setItem(CONTROLS_BAR_VISIBILITY_STORAGE_KEY, visible ? '1' : '0')
    } catch {
        /* noop */
    }
}

function emitControlsBarVisibilityChange(visible: boolean) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(CONTROLS_BAR_VISIBILITY_EVENT, {
        detail: { visible },
    }))
}

export function useControlsBarVisibility() {
    const [isVisible, setIsVisible] = useState<boolean>(() => (
        typeof window === 'undefined'
            ? false
            : getStoredControlsBarVisibility(window.localStorage)
    ))

    useEffect(() => {
        const handleControlsBarVisibilityEvent = (event: Event) => {
            const detail = (event as CustomEvent<{ visible?: boolean }>).detail
            if (typeof detail?.visible === 'boolean') {
                setIsVisible(detail.visible)
                return
            }
            setIsVisible(getStoredControlsBarVisibility(window.localStorage))
        }

        const handleStorage = (event: StorageEvent) => {
            if (event.key !== CONTROLS_BAR_VISIBILITY_STORAGE_KEY) return
            setIsVisible(getStoredControlsBarVisibility(window.localStorage))
        }

        window.addEventListener(CONTROLS_BAR_VISIBILITY_EVENT, handleControlsBarVisibilityEvent as EventListener)
        window.addEventListener('storage', handleStorage)
        return () => {
            window.removeEventListener(CONTROLS_BAR_VISIBILITY_EVENT, handleControlsBarVisibilityEvent as EventListener)
            window.removeEventListener('storage', handleStorage)
        }
    }, [])

    const setVisibility = useCallback((visible: boolean) => {
        setIsVisible(visible)
        if (typeof window !== 'undefined') {
            setStoredControlsBarVisibility(visible, window.localStorage)
        }
        emitControlsBarVisibilityChange(visible)
    }, [])

    const toggleVisibility = useCallback(() => {
        setIsVisible(current => {
            const next = !current
            if (typeof window !== 'undefined') {
                setStoredControlsBarVisibility(next, window.localStorage)
            }
            emitControlsBarVisibilityChange(next)
            return next
        })
    }, [])

    return { isVisible, setVisibility, toggleVisibility }
}
