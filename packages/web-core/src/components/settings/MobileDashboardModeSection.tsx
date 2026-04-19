import { useEffect, useState } from 'react'
import { ToggleRow } from './ToggleRow'
import { IconChat } from '../Icons'

export type MobileDashboardMode = 'chat' | 'workspace'

export const MOBILE_DASHBOARD_MODE_KEY = 'adhdev_mobileDashboardMode_v1'
export const MOBILE_DASHBOARD_MODE_EVENT = 'adhdev:mobile-dashboard-mode-change'

/**
 * Mobile dashboard mode is a device-local preference.
 *
 * It intentionally does not participate in shared daemon/session state, but the
 * mounted dashboard should still react immediately when the user flips it in the
 * same page or another tab.
 */

export function getMobileDashboardMode(): MobileDashboardMode {
    try {
        const raw = localStorage.getItem(MOBILE_DASHBOARD_MODE_KEY)
        return raw === 'workspace' ? 'workspace' : 'chat'
    } catch {
        return 'chat'
    }
}

export function subscribeMobileDashboardMode(listener: (mode: MobileDashboardMode) => void) {
    if (typeof window === 'undefined') return () => {}

    const handleChange = (mode?: MobileDashboardMode) => {
        listener(mode ?? getMobileDashboardMode())
    }
    const handleCustomEvent = (event: Event) => {
        const nextMode = (event as CustomEvent<MobileDashboardMode>).detail
        handleChange(nextMode)
    }
    const handleStorageEvent = (event: StorageEvent) => {
        if (event.key && event.key !== MOBILE_DASHBOARD_MODE_KEY) return
        handleChange()
    }

    window.addEventListener(MOBILE_DASHBOARD_MODE_EVENT, handleCustomEvent as EventListener)
    window.addEventListener('storage', handleStorageEvent)
    return () => {
        window.removeEventListener(MOBILE_DASHBOARD_MODE_EVENT, handleCustomEvent as EventListener)
        window.removeEventListener('storage', handleStorageEvent)
    }
}

export function setMobileDashboardMode(mode: MobileDashboardMode) {
    try {
        localStorage.setItem(MOBILE_DASHBOARD_MODE_KEY, mode)
    } catch {
        // noop
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<MobileDashboardMode>(MOBILE_DASHBOARD_MODE_EVENT, { detail: mode }))
    }
}

export function MobileDashboardModeSection() {
    const [chatModeEnabled, setChatModeEnabled] = useState(true)

    useEffect(() => {
        setChatModeEnabled(getMobileDashboardMode() === 'chat')
    }, [])

    return (
        <ToggleRow
            label={<span className="flex items-center gap-1.5"><IconChat size={15} /> Mobile Inbox (Chat Mode)</span>}
            description={chatModeEnabled
                ? 'Use the chat-first mobile inbox layout. This keeps mobile closer to a messaging app.'
                : 'Use the full workspace layout on phones and tablets.'}
            checked={chatModeEnabled}
            onChange={(checked) => {
                setChatModeEnabled(checked)
                setMobileDashboardMode(checked ? 'chat' : 'workspace')
            }}
            extra={
                <span className="text-[11px] text-text-muted">
                    {chatModeEnabled ? 'Chat mode' : 'Workspace'}
                </span>
            }
        />
    )
}
