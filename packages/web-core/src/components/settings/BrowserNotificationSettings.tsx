/**
 * BrowserNotificationSettings — Browser notification toggles.
 * Uses the shared useNotificationPrefs hook from web-core.
 * No server API needed — works in both cloud and standalone.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNotificationPrefs } from '../../hooks/useNotificationPrefs'
import { requestNotificationPermission } from '../../hooks/useBrowserNotifications'
import { ToggleRow } from './ToggleRow'
import { IconBell, IconMonitor, IconCheckCircle, IconZap, IconPlug } from '../Icons'

export interface BrowserNotificationSettingsProps {
    /** Optional: called when a pref changes, for server sync (cloud only) */
    onPrefChange?: (key: string, value: boolean) => void
}

export function BrowserNotificationSettings({ onPrefChange }: BrowserNotificationSettingsProps) {
    const { t } = useTranslation('common')
    const [prefs, updatePrefs] = useNotificationPrefs()
    const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() => {
        if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
        return Notification.permission
    })

    useEffect(() => {
        const refreshPermission = () => {
            if (typeof window === 'undefined' || !('Notification' in window)) {
                setBrowserPermission('unsupported')
                return
            }
            setBrowserPermission(Notification.permission)
        }

        refreshPermission()
        window.addEventListener('focus', refreshPermission)
        document.addEventListener('visibilitychange', refreshPermission)
        return () => {
            window.removeEventListener('focus', refreshPermission)
            document.removeEventListener('visibilitychange', refreshPermission)
        }
    }, [])

    const handleUpdate = (key: string, value: boolean) => {
        updatePrefs({ [key]: value })
        onPrefChange?.(key, value)
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Master toggle */}
            <ToggleRow
                label={<span className="flex items-center gap-1.5"><IconBell size={15} /> {t('notifications.masterToggleLabel')}</span>}
                description={t('notifications.masterToggleDesc')}
                checked={prefs.globalEnabled}
                onChange={v => handleUpdate('globalEnabled', v)}
            />

            {prefs.globalEnabled && <div className="border-t border-border-subtle my-0.5" />}

            {/* Browser Notifications */}
            {prefs.globalEnabled && (
                <ToggleRow
                    label={<span className="flex items-center gap-1.5"><IconMonitor size={15} /> {t('notifications.browserNotificationsLabel')}</span>}
                    description={t('notifications.browserNotificationsDesc')}
                    checked={prefs.browserNotifications}
                    onChange={v => handleUpdate('browserNotifications', v)}
                />
            )}

            {prefs.globalEnabled && (
                <div className="ml-5 pl-3 border-l-2 border-border-subtle flex flex-col gap-2">
                    <div className="text-2xs text-text-muted">
                        {t('notifications.standaloneBackgroundInfo')}
                    </div>
                    {browserPermission === 'default' && (
                        <div className="flex flex-wrap items-center gap-2 text-2xs text-status-warning">
                            <span>{t('notifications.standalonePermissionDefault')}</span>
                            <button
                                onClick={() => { void requestNotificationPermission().then(setBrowserPermission) }}
                                className="px-2 py-0.5 rounded border border-border-default bg-bg-glass text-text-secondary hover:text-text-primary transition-colors"
                            >
                                {t('notifications.allowNotifications')}
                            </button>
                        </div>
                    )}
                    {browserPermission === 'denied' && (
                        <div className="text-2xs text-status-warning">
                            {t('notifications.permissionDenied')}
                        </div>
                    )}
                    {browserPermission === 'unsupported' && (
                        <div className="text-2xs text-status-warning">
                            {t('notifications.standalonePermissionUnsupported')}
                        </div>
                    )}
                </div>
            )}

            {/* Sub-toggles */}
            {prefs.globalEnabled && prefs.browserNotifications && (
                <div className="ml-5 pl-3 border-l-2 border-border-subtle flex flex-col gap-2">
                    <ToggleRow
                        label={<span className="flex items-center gap-1.5"><IconCheckCircle size={15} /> {t('notifications.completionAlertsLabel')}</span>}
                        description={t('notifications.completionAlertsDesc')}
                        checked={prefs.completionAlert}
                        onChange={v => handleUpdate('completionAlert', v)}
                    />
                    <ToggleRow
                        label={<span className="flex items-center gap-1.5"><IconZap size={15} /> {t('notifications.approvalAlertsLabel')}</span>}
                        description={t('notifications.approvalAlertsDesc')}
                        checked={prefs.approvalAlert}
                        onChange={v => handleUpdate('approvalAlert', v)}
                    />
                    <ToggleRow
                        label={<span className="flex items-center gap-1.5"><IconPlug size={15} /> {t('notifications.connectionAlertsLabel')}</span>}
                        description={t('notifications.connectionAlertsDesc')}
                        checked={prefs.disconnectAlert}
                        onChange={v => handleUpdate('disconnectAlert', v)}
                    />
                </div>
            )}
            {!prefs.globalEnabled && (
                <p className="text-2xs text-text-muted italic">
                    {t('notifications.allDisabled')}
                </p>
            )}
        </div>
    )
}
