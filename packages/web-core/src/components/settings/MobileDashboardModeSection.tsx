import { useEffect, useState } from 'react'
import { ToggleRow } from './ToggleRow'
import { IconChat } from '../Icons'

export type MobileDashboardMode = 'chat' | 'workspace'

export const MOBILE_DASHBOARD_MODE_KEY = 'adhdev_mobileDashboardMode_v1'

export function getMobileDashboardMode(): MobileDashboardMode {
    try {
        const raw = localStorage.getItem(MOBILE_DASHBOARD_MODE_KEY)
        return raw === 'workspace' ? 'workspace' : 'chat'
    } catch {
        return 'chat'
    }
}

export function setMobileDashboardMode(mode: MobileDashboardMode) {
    try {
        localStorage.setItem(MOBILE_DASHBOARD_MODE_KEY, mode)
    } catch {
        // noop
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
