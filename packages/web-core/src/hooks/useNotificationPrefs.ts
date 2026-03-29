/**
 * useNotificationPrefs — Hierarchical notification settings hook
 *
 * Layer 1: Global ON/OFF — master toggle for ALL notifications
 * Layer 2: Daemon disconnect alert
 * Layer 3: Per-provider (managed via daemon provider settings)
 * Layer 4: Sub-category (completion, approval, long-generating)
 *
 * Persisted to localStorage. Server sync can be added later.
 */
import { useState, useEffect, useCallback } from 'react'

const LS_KEY = 'adhdev_notification_prefs'

export interface NotificationPrefs {
    /** Layer 1: Master toggle — if false, all notifications suppressed */
    globalEnabled: boolean
    /** Layer 2: Alert when daemon connection drops */
    disconnectAlert: boolean
    /** Browser desktop notifications (Notification API) */
    browserNotifications: boolean
    /** Completion alert (agent finished) — used by useBrowserNotifications */
    completionAlert: boolean
    /** Approval alert (agent waiting) — used by useBrowserNotifications */
    approvalAlert: boolean
}

const DEFAULT_PREFS: NotificationPrefs = {
    globalEnabled: true,
    disconnectAlert: true,
    browserNotifications: true,
    completionAlert: true,
    approvalAlert: true,
}

function loadPrefs(): NotificationPrefs {
    try {
        const raw = localStorage.getItem(LS_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            return { ...DEFAULT_PREFS, ...parsed }
        }
    } catch { /* corrupt data */ }
    return { ...DEFAULT_PREFS }
}

function savePrefs(prefs: NotificationPrefs): void {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(prefs))
    } catch { /* quota exceeded */ }
}

// ─── Singleton state (shared across components in same tab) ───

let _prefs: NotificationPrefs = loadPrefs()
let _listeners: (() => void)[] = []

function notifyListeners() {
    _listeners.forEach(fn => fn())
}

/** Get current prefs (non-reactive, for one-off checks) */
export function getNotificationPrefs(): NotificationPrefs {
    return { ..._prefs }
}

/** Update prefs (non-reactive, for external usage) */
export function setNotificationPrefs(partial: Partial<NotificationPrefs>): void {
    _prefs = { ..._prefs, ...partial }
    savePrefs(_prefs)
    notifyListeners()
}

/**
 * React hook for notification preferences.
 * Reactive across all component instances using this hook.
 */
export function useNotificationPrefs(): [NotificationPrefs, (partial: Partial<NotificationPrefs>) => void] {
    const [, forceUpdate] = useState(0)

    useEffect(() => {
        const listener = () => forceUpdate(n => n + 1)
        _listeners.push(listener)
        return () => {
            _listeners = _listeners.filter(l => l !== listener)
        }
    }, [])

    const update = useCallback((partial: Partial<NotificationPrefs>) => {
        setNotificationPrefs(partial)
    }, [])

    return [{ ..._prefs }, update]
}

/** Check if a specific notification type should fire (respects hierarchy) */
export function shouldNotify(type: 'disconnect' | 'completion' | 'approval' | 'browser'): boolean {
    if (!_prefs.globalEnabled) return false
    switch (type) {
        case 'disconnect': return _prefs.disconnectAlert
        case 'completion': return _prefs.completionAlert
        case 'approval': return _prefs.approvalAlert
        case 'browser': return _prefs.browserNotifications
        default: return true
    }
}
