import { useCallback, useEffect, useRef, useState } from 'react'

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
    const isVisibleRef = useRef(isVisible)

    const applyVisibility = useCallback((visible: boolean, emit = true) => {
        isVisibleRef.current = visible
        setIsVisible(visible)
        if (typeof window !== 'undefined') {
            setStoredControlsBarVisibility(visible, window.localStorage)
        }
        if (emit) emitControlsBarVisibilityChange(visible)
    }, [])

    useEffect(() => {
        const handleControlsBarVisibilityEvent = (event: Event) => {
            const detail = (event as CustomEvent<{ visible?: boolean }>).detail
            const next = typeof detail?.visible === 'boolean'
                ? detail.visible
                : getStoredControlsBarVisibility(window.localStorage)
            isVisibleRef.current = next
            setIsVisible(next)
        }

        const handleStorage = (event: StorageEvent) => {
            if (event.key !== CONTROLS_BAR_VISIBILITY_STORAGE_KEY) return
            const next = getStoredControlsBarVisibility(window.localStorage)
            isVisibleRef.current = next
            setIsVisible(next)
        }

        window.addEventListener(CONTROLS_BAR_VISIBILITY_EVENT, handleControlsBarVisibilityEvent as EventListener)
        window.addEventListener('storage', handleStorage)
        return () => {
            window.removeEventListener(CONTROLS_BAR_VISIBILITY_EVENT, handleControlsBarVisibilityEvent as EventListener)
            window.removeEventListener('storage', handleStorage)
        }
    }, [])

    const setVisibility = useCallback((visible: boolean) => {
        applyVisibility(visible)
    }, [applyVisibility])

    const toggleVisibility = useCallback(() => {
        applyVisibility(!isVisibleRef.current)
    }, [applyVisibility])

    return { isVisible, setVisibility, toggleVisibility }
}
