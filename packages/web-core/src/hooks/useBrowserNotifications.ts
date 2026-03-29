/**
 * useBrowserNotifications — Browser Notification API hook
 *
 * Monitors agent messages and sends desktop notifications for:
 * - Approval requests (waiting_approval)
 * - Agent errors
 * - Agent task completion (generating → idle transition)
 *
 * Works on localhost and HTTPS. Browser tab must be open (background OK).
 */
import { useEffect, useRef, useCallback } from 'react'
import { shouldNotify } from './useNotificationPrefs'

interface NotificationOptions {
    /** Enable/disable notifications globally */
    enabled: boolean
    /** Notify on approval requests */
    onApproval?: boolean
    /** Notify when agent finishes (generating → idle) */
    onComplete?: boolean
    /** Notify on errors */
    onError?: boolean
    /** Minimum interval between notifications (ms) */
    throttleMs?: number
}

interface AgentState {
    id: string
    name?: string
    status?: string
    activeModal?: { message?: string; buttons?: string[] } | null
}

const DEFAULT_OPTS: Required<NotificationOptions> = {
    enabled: true,
    onApproval: true,
    onComplete: true,
    onError: true,
    throttleMs: 5000,
}

/** Request notification permission if not already granted */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) return 'denied'
    if (Notification.permission === 'granted') return 'granted'
    if (Notification.permission === 'denied') return 'denied'
    return Notification.requestPermission()
}

/** Check if notifications are supported and permitted */
export function canNotify(): boolean {
    return 'Notification' in window && Notification.permission === 'granted'
}

/**
 * Check if a Service Worker Push subscription is already active (cloud PWA).
 * If so, the server handles push notifications — we should skip browser-level ones.
 */
let _pushSubscriptionActive: boolean | null = null
async function checkPushSubscription(): Promise<boolean> {
    if (_pushSubscriptionActive !== null) return _pushSubscriptionActive
    try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            _pushSubscriptionActive = false
            return false
        }
        const reg = await navigator.serviceWorker.getRegistration()
        if (!reg) { _pushSubscriptionActive = false; return false }
        const sub = await reg.pushManager.getSubscription()
        _pushSubscriptionActive = !!sub
        return _pushSubscriptionActive
    } catch {
        _pushSubscriptionActive = false
        return false
    }
}

/** Send a browser notification */
export function notify(title: string, body: string, tag?: string) {
    if (!canNotify()) return
    try {
        const n = new Notification(title, {
            body,
            icon: '/otter-logo.png',
            tag: tag || `adhdev-${Date.now()}`,
            silent: false,
        })
        // Auto-close after 8 seconds
        setTimeout(() => n.close(), 8000)
        // Focus window on click
        n.onclick = () => {
            window.focus()
            n.close()
        }
    } catch { /* silent — e.g. Service Worker required on some browsers */ }
}

/**
 * Hook that monitors agent states and triggers browser notifications.
 *
 * @param agents - Array of current agent states (from dashboard polling)
 * @param options - Notification configuration
 */
export function useBrowserNotifications(
    agents: AgentState[],
    options: Partial<NotificationOptions> = {},
) {
    const opts = { ...DEFAULT_OPTS, ...options }
    const prevStates = useRef<Map<string, string>>(new Map())
    const lastNotifyTime = useRef(0)
    const pushActive = useRef<boolean | null>(null)

    // Check once if PWA push is active (cloud) — skip browser notifications if so
    useEffect(() => {
        checkPushSubscription().then(active => { pushActive.current = active })
    }, [])

    const throttledNotify = useCallback((title: string, body: string, tag?: string) => {
        const now = Date.now()
        if (now - lastNotifyTime.current < opts.throttleMs) return
        lastNotifyTime.current = now
        notify(title, body, tag)
    }, [opts.throttleMs])

    useEffect(() => {
        if (!opts.enabled || !canNotify()) return
        // Respect global notification preference
        if (!shouldNotify('browser')) return
        // Skip if PWA push notifications are active (cloud handles it)
        if (pushActive.current === true) return
        // Don't notify if page is focused (user is already looking)
        if (document.hasFocus()) {
            // Still track state changes
            for (const agent of agents) {
                prevStates.current.set(agent.id, agent.status || 'idle')
            }
            return
        }

        for (const agent of agents) {
            const prev = prevStates.current.get(agent.id)
            const curr = agent.status || 'idle'
            const name = agent.name || agent.id

            // Approval request
            if (opts.onApproval && shouldNotify('approval') && curr === 'waiting_approval' && prev !== 'waiting_approval') {
                const msg = agent.activeModal?.message || 'Action requires your approval'
                throttledNotify(
                    `🔔 ${name} — Approval needed`,
                    msg.slice(0, 120),
                    `approval-${agent.id}`,
                )
            }

            // Task complete (generating → idle)
            if (opts.onComplete && shouldNotify('completion') && prev === 'generating' && curr === 'idle') {
                throttledNotify(
                    `✅ ${name} — Task complete`,
                    'Agent has finished working',
                    `complete-${agent.id}`,
                )
            }

            // Error
            if (opts.onError && curr === 'error' && prev !== 'error') {
                throttledNotify(
                    `⚠️ ${name} — Error`,
                    'Agent encountered an error',
                    `error-${agent.id}`,
                )
            }

            prevStates.current.set(agent.id, curr)
        }
    }, [agents, opts.enabled, opts.onApproval, opts.onComplete, opts.onError, throttledNotify])
}
