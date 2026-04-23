/**
 * EventManager — Centralized event/notification dispatch service
 *
 * Extracts ALL event handling logic from Dashboard.tsx into a singleton service.
 * Handles deduplication, normalization, and dispatching to registered callbacks.
 *
 * Channels:
 *   1. Toasts (in-app)
 *   2. Browser Notifications (Notification API)
 *   3. Web Push (server-side, via UserSession — not managed here)
 */

import { formatIdeType, getMachineDisplayName } from '../utils/daemon-utils'
import { shouldNotify } from '../hooks/useNotificationPrefs'
import { notify } from '../hooks/useBrowserNotifications'
import type { DaemonData, DashboardStatusEventPayload } from '../types'
import {
    buildApprovalToastDescriptors,
    buildViewRequestToastActions,
    formatApprovalToastMessage,
} from './event-manager-helpers'

// ─── Types ────────────────────────────────────────

export type StatusEventPayload = DashboardStatusEventPayload

export interface ToastAction {
    label: string
    variant: 'primary' | 'danger' | 'default'
    onClick: () => void
}

export interface ToastConfig {
    id: number
    message: string
    type: 'success' | 'info' | 'warning'
    timestamp: number
    targetKey?: string
    actions?: ToastAction[]
    duration?: number // ms before auto-dismiss (default 5000)
}

export type ToastCallback = (toast: ToastConfig) => void
export type DesktopNotificationCallback = (title: string, body: string, tag: string) => void
export type ResolveActionFn = (routeId: string, action: string, payload: Record<string, any>) => void
export type ViewRequestRespondFn = (orgId: string, requestId: string, action: 'approve' | 'reject') => Promise<any>

type KnownIdeEntry = Pick<DaemonData, 'id' | 'type' | 'daemonId' | 'machineNickname' | 'hostname' | 'machine' | 'sessionId' | 'childSessions'>

// ─── Singleton EventManager ───────────────────────

class EventManager {
    // Dedup map: key → last-seen timestamp
    private dedupMap = new Map<string, number>()
    private readonly DEDUP_WINDOW_MS = 5000
    private readonly DEDUP_MAX_SIZE = 50
    private readonly DEDUP_CLEANUP_AGE_MS = 10000

    // Registered callbacks
    private toastCallbacks: ToastCallback[] = []
    private resolveActionFn: ResolveActionFn | null = null
    private viewRequestRespondFn: ViewRequestRespondFn | null = null

    // IDE lookup (set by Dashboard)
    private ides: KnownIdeEntry[] = []

    // ─── Registration ─────────────────────────────

    /** Register a toast callback. Returns unsubscribe function. */
    onToast(callback: ToastCallback): () => void {
        this.toastCallbacks.push(callback)
        return () => {
            this.toastCallbacks = this.toastCallbacks.filter(cb => cb !== callback)
        }
    }

    /** Set the resolve action function (sendDaemonCommand wrapper) */
    setResolveAction(fn: ResolveActionFn): void {
        this.resolveActionFn = fn
    }

    /** Update known IDEs (for routeId lookup) */
    setIdes(ides: KnownIdeEntry[]): void {
        this.ides = ides
    }

    /** Set the view request respond function (for team:view_request approval/rejection) */
    setViewRequestRespond(fn: ViewRequestRespondFn): void {
        this.viewRequestRespondFn = fn
    }

    // ─── Dispatch helpers ─────────────────────────

    public emitToast(toast: ToastConfig): void {
        for (const cb of this.toastCallbacks) cb(toast)
    }

    public showToast(message: string, type: 'success' | 'info' | 'warning' = 'info', opts?: Partial<ToastConfig>): void {
        const toastId = opts?.id || Date.now()
        this.emitToast({
            id: toastId, message, type, timestamp: toastId,
            duration: 5000,
            ...opts,
        })
    }

    // ─── Deduplication ────────────────────────────

    private isDuplicate(key: string): boolean {
        const now = Date.now()
        const lastSeen = this.dedupMap.get(key) || 0
        if (now - lastSeen < this.DEDUP_WINDOW_MS) return true
        this.dedupMap.set(key, now)

        // Periodic cleanup
        if (this.dedupMap.size > this.DEDUP_MAX_SIZE) {
            for (const [k, ts] of this.dedupMap) {
                if (now - ts > this.DEDUP_CLEANUP_AGE_MS) this.dedupMap.delete(k)
            }
        }
        return false
    }

    // ─── Daemon resolution (for machine name in toasts) ─────

    /**
     * Find the adhdev-daemon entry that owns the IDE which fired this event.
     * Strategy:
     *   1. If daemonId is present, resolve directly
     *   2. If targetSessionId is present, resolve owning session → daemon
     *   3. Fallback: if only one daemon exists, use it (single-machine case)
     */
    private resolveOwningDaemon(payload: StatusEventPayload): typeof this.ides[number] | null {
        if (payload.daemonId) {
            const daemon = this.ides.find(i => i.id === payload.daemonId && i.type === 'adhdev-daemon')
            if (daemon) return daemon
        }

        const matchedIde = payload.targetSessionId
            ? this.findOwningSession(payload.targetSessionId) || undefined
            : undefined

        // Follow daemonId to find the owning daemon
        if (matchedIde) {
            const dId = matchedIde.daemonId
            if (dId) {
                const daemon = this.ides.find(i => i.id === dId && i.type === 'adhdev-daemon')
                if (daemon) return daemon
            }
        }

        // Fallback: single daemon scenario — return the only one
        const daemons = this.ides.filter(i => i.type === 'adhdev-daemon')
        if (daemons.length === 1) return daemons[0]

        return null
    }

    // ─── Route ID resolution ──────────────────────

    private findOwningSession(targetSessionId: string): typeof this.ides[number] | null {
        for (const ide of this.ides) {
            if (ide.id === targetSessionId || ide.sessionId === targetSessionId) {
                return ide
            }
            const childSessions = Array.isArray(ide.childSessions) ? ide.childSessions : []
            if (childSessions.some((child) => child?.id === targetSessionId)) {
                return ide
            }
        }
        return null
    }

    private resolveActionRouteTarget(payload: StatusEventPayload): string | null {
        if (payload.targetSessionId) {
            const owner = this.findOwningSession(payload.targetSessionId)
            return owner?.id || owner?.daemonId || null
        }
        return payload.daemonId || null
    }

    private resolveConversationKey(payload: StatusEventPayload): string | null {
        if (payload.targetSessionId) return payload.targetSessionId
        if (payload.daemonId) return payload.daemonId
        return null
    }

    // ─── Main entry point ─────────────────────────

    handleRawEvent(payload: StatusEventPayload, _source: 'ws' | 'p2p'): void {
        const conversationKey = this.resolveConversationKey(payload)
        const eventTimestamp = Number.isFinite(payload.timestamp) ? Number(payload.timestamp) : Date.now()
        const dedupTarget = conversationKey || payload.daemonId || ''
        const dedupDetail = payload.requestId || payload.targetName || payload.requesterName || payload.modalMessage || String(eventTimestamp)
        const dedupKey = `${dedupTarget}:${payload.event}:${dedupDetail}`
        if (this.isDuplicate(dedupKey)) return

        const owningEntry = payload.targetSessionId
            ? this.findOwningSession(payload.targetSessionId)
            : null
        const entryType = owningEntry?.type || ''
        let ideLabel = formatIdeType(entryType)
        const owningDaemon = this.resolveOwningDaemon(payload)
        if (owningDaemon) {
            const machineName = getMachineDisplayName(owningDaemon, { fallbackId: owningDaemon.id })
            if (machineName) {
                ideLabel = !entryType || entryType === 'adhdev-daemon'
                    ? machineName
                    : `${machineName}/${ideLabel}`
            }
        }
        let msg = ''
        let type: 'success' | 'info' | 'warning' = 'info'

        if (payload.event === 'agent:generating_completed') {
            const dur = payload.duration ? ` (${payload.duration}s)` : ''
            msg = `✅ ${ideLabel} agent task completed${dur}`
            type = 'success'

            // Sound
            try {
                new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAB/f39/').play().catch(() => {})
            } catch {}

        // ── agent:generating_started ──
        } else if (payload.event === 'agent:generating_started') {
        } else if (payload.event === 'agent:waiting_approval') {
            msg = `⚡ ${ideLabel} approval needed`
            type = 'warning'

            // Inline action toast with modal buttons
            if (payload.modalButtons?.length && this.resolveActionFn) {
                const routeId = this.resolveActionRouteTarget(payload)
                if (!routeId) return
                const resolveAction = this.resolveActionFn
                const actions: ToastAction[] = buildApprovalToastDescriptors(payload.modalButtons).map((descriptor) => ({
                    label: descriptor.label,
                    variant: descriptor.variant,
                    onClick: () => {
                        resolveAction(routeId, 'resolve_action', {
                            action: descriptor.action,
                            button: descriptor.button,
                            buttonIndex: descriptor.buttonIndex,
                            ...(payload.targetSessionId && { targetSessionId: payload.targetSessionId }),
                        })
                    },
                }))

                const contextMsg = formatApprovalToastMessage(ideLabel, payload.modalMessage, msg)

                const toastId = Date.now()
                this.emitToast({
                    id: toastId, message: contextMsg, type, timestamp: toastId,
                    targetKey: conversationKey || routeId, actions, duration: 15000,
                })
                msg = '' // skip default toast
            }

        // ── monitor:long_generating ──
        } else if (payload.event === 'monitor:long_generating') {
            const dur = payload.elapsedSec ? ` (${Math.round(payload.elapsedSec / 60)}m)` : ''
            msg = `⚠️ ${ideLabel} agent is taking a long time${dur}`
            type = 'warning'

            // Browser desktop notification (only if unfocused)
            if (shouldNotify('browser') && !document.hasFocus()) {
                notify(
                    `⚠️ ${ideLabel} — Long Running`,
                    `Agent has been generating for over ${dur.replace(/[()]/g, '')}`,
                    `long-${payload.targetSessionId || payload.daemonId || 'daemon'}`,
                )
            }

        // ── team:view_request (incoming request to view YOUR session) ──
        } else if (payload.event === 'team:view_request') {
            const requesterName = payload.requesterName || 'A team member'
            const requestId = payload.requestId
            const orgId = payload.orgId

            msg = `👁️ ${requesterName} wants to view your session`
            type = 'warning'

            // Show actionable toast with Approve/Decline
            if (requestId && orgId && this.viewRequestRespondFn) {
                const toastId = Date.now()
                const actions: ToastAction[] = buildViewRequestToastActions(
                    orgId,
                    requestId,
                    this.viewRequestRespondFn,
                    (action, error) => console.error(`[EventManager] ${action} view request failed:`, error),
                )
                this.emitToast({
                    id: toastId, message: msg, type, timestamp: toastId,
                    actions, duration: 30000, // 30s before auto-dismiss
                })
                msg = '' // skip default toast
            }

            // Browser notification if not focused
            if (shouldNotify('browser') && !document.hasFocus()) {
                notify(
                    `👁️ View Request`,
                    `${requesterName} wants to view your session`,
                    `view-request-${requestId}`,
                )
            }

        // ── team:view_request_approved (your request was approved) ──
        } else if (payload.event === 'team:view_request_approved') {
            msg = `✅ View request approved`
            type = 'success'

        // ── team:view_request_rejected (your request was declined) ──
        } else if (payload.event === 'team:view_request_rejected') {
            const targetName = payload.targetName || 'Team member'
            msg = `❌ ${targetName} declined your view request`
            type = 'warning'
        }

        // Default toast (if msg was set and not overridden)
        if (msg) {
            const toastId = Date.now()
            this.emitToast({
                id: toastId, message: msg, type, timestamp: toastId,
                targetKey: conversationKey || payload.daemonId, duration: 5000,
            })
        }
    }
}

/** Singleton instance */
export const eventManager = new EventManager()
