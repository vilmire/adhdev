/**
 * BrowserNotificationSettings — Browser notification toggles.
 * Uses the shared useNotificationPrefs hook from web-core.
 * No server API needed — works in both cloud and standalone.
 */
import { useNotificationPrefs } from '../../hooks/useNotificationPrefs'
import { ToggleRow } from './ToggleRow'

export interface BrowserNotificationSettingsProps {
    /** Optional: called when a pref changes, for server sync (cloud only) */
    onPrefChange?: (key: string, value: boolean) => void
}

export function BrowserNotificationSettings({ onPrefChange }: BrowserNotificationSettingsProps) {
    const [prefs, updatePrefs] = useNotificationPrefs()

    const handleUpdate = (key: string, value: boolean) => {
        updatePrefs({ [key]: value })
        onPrefChange?.(key, value)
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Master toggle */}
            <ToggleRow
                label="🔔 Notifications"
                description="Master toggle for all alerts"
                checked={prefs.globalEnabled}
                onChange={v => handleUpdate('globalEnabled', v)}
            />

            {prefs.globalEnabled && <div className="border-t border-border-subtle my-0.5" />}

            {/* Browser Notifications */}
            {prefs.globalEnabled && (
                <ToggleRow
                    label="🖥️ Browser Notifications"
                    description="Desktop alerts when tab is inactive"
                    checked={prefs.browserNotifications}
                    onChange={v => handleUpdate('browserNotifications', v)}
                />
            )}

            {/* Sub-toggles */}
            {prefs.globalEnabled && prefs.browserNotifications && (
                <div className="ml-5 pl-3 border-l-2 border-border-subtle flex flex-col gap-2">
                    <ToggleRow
                        label="✅ Completion Alerts"
                        description="Notify when agent finishes a task"
                        checked={prefs.completionAlert}
                        onChange={v => handleUpdate('completionAlert', v)}
                    />
                    <ToggleRow
                        label="⚡ Approval Alerts"
                        description="Notify when agent needs approval"
                        checked={prefs.approvalAlert}
                        onChange={v => handleUpdate('approvalAlert', v)}
                    />
                    <ToggleRow
                        label="📡 Connection Alerts"
                        description="Alert when a daemon disconnects"
                        checked={prefs.disconnectAlert}
                        onChange={v => handleUpdate('disconnectAlert', v)}
                    />
                </div>
            )}

            {!prefs.globalEnabled && (
                <p className="text-[11px] text-text-muted italic">
                    All notifications are disabled. Enable the master toggle to configure individual alerts.
                </p>
            )}
        </div>
    )
}
