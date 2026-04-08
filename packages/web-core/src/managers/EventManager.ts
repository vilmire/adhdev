/**
 * EventManager — Centralized event/notification dispatch service
 *
 * Extracts ALL event handling logic from Dashboard.tsx into a singleton service.
 * Handles deduplication, normalization, and dispatching to registered callbacks.
 *
 * Channels:
 *   1. Toasts (in-app)
 *   2. Browser Notifications (Notification API)
 *   3. System Chat Messages (injected into chat pane)
 *   4. Web Push (server-side, via UserSession — not managed here)
 */

import { formatIdeType, getMachineDisplayName } from '../utils/daemon-utils'
import { shouldNotify, getNotificationPrefs } from '../hooks/useNotificationPrefs'
import { notify } from '../hooks/useBrowserNotifications'

// ─── Types ────────────────────────────────────────

export interface StatusEventPayload {
    ideId?: string
    ideType?: string
    ideName?: string
    agentType?: string
    targetSessionId?: string
    instanceId?: string
    providerType?: string
    event: string
    chatTitle?: string
    duration?: number
    elapsedSec?: number
    modalMessage?: string
    modalButtons?: string[]
}

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

export interface SystemMessage {
    role: 'system'
    timestamp: number
    content: string
    _localId: string
}

export type ToastCallback = (toast: ToastConfig) => void
export type SystemMessageCallback = (targetKey: string, msg: SystemMessage) => void
export type ClearSystemMessageCallback = (targetKey: string, localIdPrefix: string) => void
export type DesktopNotificationCallback = (title: string, body: string, tag: string) => void
export type ResolveActionFn = (routeId: string, action: string, payload: Record<string, any>) => void
export type ViewRequestRespondFn = (orgId: string, requestId: string, action: 'approve' | 'reject') => Promise<any>

// ─── Singleton EventManager ───────────────────────

class EventManager {
    // Dedup map: key → last-seen timestamp
    private dedupMap = new Map<string, number>()
    private readonly DEDUP_WINDOW_MS = 5000
    private readonly DEDUP_MAX_SIZE = 50
    private readonly DEDUP_CLEANUP_AGE_MS = 10000

    // Registered callbacks
    private toastCallbacks: ToastCallback[] = []
    private systemMessageCallbacks: SystemMessageCallback[] = []
    private clearSystemMessageCallbacks: ClearSystemMessageCallback[] = []
    private resolveActionFn: ResolveActionFn | null = null
    private viewRequestRespondFn: ViewRequestRespondFn | null = null

    // IDE lookup (set by Dashboard)
    private ides: Array<{ id: string; type: string; daemonId?: string; machineNickname?: string | null; hostname?: string; machine?: { hostname?: string } }> = []

    // ─── Registration ─────────────────────────────

    /** Register a toast callback. Returns unsubscribe function. */
    onToast(callback: ToastCallback): () => void {
        this.toastCallbacks.push(callback)
        return () => {
            this.toastCallbacks = this.toastCallbacks.filter(cb => cb !== callback)
        }
    }

    /** Register a system message callback. Returns unsubscribe function. */
    onSystemMessage(callback: SystemMessageCallback): () => void {
        this.systemMessageCallbacks.push(callback)
        return () => {
            this.systemMessageCallbacks = this.systemMessageCallbacks.filter(cb => cb !== callback)
        }
    }

    /** Register callback to clear system messages by prefix. Returns unsubscribe function. */
    onClearSystemMessage(callback: ClearSystemMessageCallback): () => void {
        this.clearSystemMessageCallbacks.push(callback)
        return () => {
            this.clearSystemMessageCallbacks = this.clearSystemMessageCallbacks.filter(cb => cb !== callback)
        }
    }

    /** Set the resolve action function (sendDaemonCommand wrapper) */
    setResolveAction(fn: ResolveActionFn): void {
        this.resolveActionFn = fn
    }

    /** Update known IDEs (for routeId lookup) */
    setIdes(ides: Array<{ id: string; type: string; daemonId?: string; machineNickname?: string | null; hostname?: string; machine?: { hostname?: string } }>): void {
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

    private emitSystemMessage(targetKey: string, msg: SystemMessage): void {
        for (const cb of this.systemMessageCallbacks) cb(targetKey, msg)
    }

    private emitClearSystemMessage(targetKey: string, prefix: string): void {
        for (const cb of this.clearSystemMessageCallbacks) cb(targetKey, prefix)
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
     *   1. If ideId is resolved, find its IDE entry → follow daemonId → find the daemon entry
     *   2. If instanceId matches an IDE, same lookup
     *   3. Fallback: if only one daemon exists, use it (single-machine case)
     */
    private resolveOwningDaemon(payload: StatusEventPayload): typeof this.ides[number] | null {
        // Direct match: if ideType is adhdev-daemon, the event IS from a daemon
        if (payload.ideType === 'adhdev-daemon' && payload.ideId) {
            const directDaemon = this.ides.find(i => i.id === payload.ideId && i.type === 'adhdev-daemon')
            if (directDaemon) return directDaemon
        }

        // Find the IDE entry this event belongs to
        let matchedIde: typeof this.ides[number] | undefined
        if (payload.targetSessionId) {
            matchedIde = this.findOwningSession(payload.targetSessionId) || undefined
        }
        if (payload.ideId) {
            matchedIde = matchedIde || this.ides.find(i => i.id === payload.ideId)
        }
        if (!matchedIde && payload.instanceId) {
            matchedIde = this.ides.find(i =>
                i.id.endsWith(`:ide:${payload.instanceId}`) ||
                i.id.endsWith(`:cli:${payload.instanceId}`)
            )
        }

        // Follow daemonId to find the owning daemon
        if (matchedIde) {
            const dId = (matchedIde as any).daemonId
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

    private resolveRouteId(rawIdeId: string, agentType: string): string {
        for (const ide of this.ides) {
            if (ide.id.startsWith(rawIdeId) && (!agentType || agentType === ide.type)) {
                return ide.id
            }
        }
        return rawIdeId
    }

    private findOwningSession(targetSessionId: string): typeof this.ides[number] | null {
        for (const ide of this.ides) {
            if (ide.id === targetSessionId || (ide as any).sessionId === targetSessionId) {
                return ide
            }
            const childSessions = Array.isArray((ide as any).childSessions) ? (ide as any).childSessions : []
            if (childSessions.some((child: any) => child?.id === targetSessionId)) {
                return ide
            }
        }
        return null
    }

    private resolveActionRouteTarget(payload: StatusEventPayload): string | null {
        if (payload.ideId) {
            const agentType = payload.agentType || payload.ideType || ''
            return this.resolveRouteId(payload.ideId, agentType)
        }
        if (payload.targetSessionId) {
            const owner = this.findOwningSession(payload.targetSessionId)
            return owner?.id || owner?.daemonId || null
        }
        return null
    }

    private resolveConversationKey(payload: StatusEventPayload): string | null {
        if (payload.targetSessionId) return payload.targetSessionId
        if (!payload.ideId) return null
        return payload.ideId
    }

    // ─── Main entry point ─────────────────────────

    handleRawEvent(payload: StatusEventPayload, _source: 'ws' | 'p2p'): void {
        // Resolve ideId from instanceId if not present
        // instanceId from daemon is like 'antigravity' or 'cursor_remote_vs'
        // Frontend ideId is like '{doId}:ide:{instanceId}'
        if (!payload.ideId && payload.instanceId) {
            for (const ide of this.ides) {
                if (ide.id.endsWith(`:ide:${payload.instanceId}`) || ide.id.endsWith(`:cli:${payload.instanceId}`)) {
                    payload.ideId = ide.id
                    break
                }
            }
        }

        const conversationKey = this.resolveConversationKey(payload)
        const dedupTarget = conversationKey || payload.instanceId || payload.ideType || payload.providerType || ''
        const dedupKey = `${dedupTarget}:${payload.event}:${payload.chatTitle || ''}`
        if (this.isDuplicate(dedupKey)) return

        // Resolve ideLabel: find the owning daemon for this event's IDE
        let ideLabel = formatIdeType(payload.ideType || '')
        const owningDaemon = this.resolveOwningDaemon(payload)
        if (owningDaemon) {
            const machineName = getMachineDisplayName(owningDaemon, { fallbackId: owningDaemon.id })
            if (machineName) {
                ideLabel = payload.ideType === 'adhdev-daemon'
                    ? machineName                         // daemon event → show machine name only
                    : `${machineName}/${ideLabel}`         // IDE event → "MachineName/Cursor" for clarity
            }
        }
        let msg = ''
        let type: 'success' | 'info' | 'warning' = 'info'

        // ── agent:generating_completed ──
        if (payload.event === 'agent:generating_completed') {
            const dur = payload.duration ? ` (${payload.duration}s)` : ''
            msg = `✅ ${ideLabel} agent task completed${dur}`
            type = 'success'

            // Sound
            try {
                new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAB/f39/').play().catch(() => {})
            } catch {}

            // System message
            if (conversationKey && getNotificationPrefs().chatTaskCompletionBubble) {
                this.emitSystemMessage(conversationKey, {
                    role: 'system',
                    timestamp: Date.now(),
                    content: `✅ Task completed${dur}`,
                    _localId: `sys_complete_${Date.now()}`,
                })
            }

        // ── agent:generating_started ──
        } else if (payload.event === 'agent:generating_started') {
            // Clear previous completion messages
            if (conversationKey) {
                this.emitClearSystemMessage(conversationKey, 'sys_complete_')
            }

        // ── agent:waiting_approval ──
        } else if (payload.event === 'agent:waiting_approval') {
            msg = `⚡ ${ideLabel} approval needed`
            type = 'warning'

            // Approval banner already renders the modal/buttons in chat.
            // Keep the system bubble only as a fallback when no actionable buttons exist.
            if (conversationKey && !payload.modalButtons?.length) {
                const modalText = payload.modalMessage || 'Approval requested'
                const buttons = payload.modalButtons?.length
                    ? payload.modalButtons.map(b => `[${b}]`).join(' ')
                    : '[Approve] [Reject]'
                this.emitSystemMessage(conversationKey, {
                    role: 'system',
                    timestamp: Date.now(),
                    content: `⚡ Approval requested: ${modalText}\n${buttons}`,
                    _localId: `sys_approval_${Date.now()}`,
                })
            }

            // Inline action toast with modal buttons
            if (payload.modalButtons?.length && this.resolveActionFn) {
                const routeId = this.resolveActionRouteTarget(payload)
                if (!routeId) return
                const agentType = payload.agentType || payload.ideType || ''
                const ideType = payload.ideType || ''
                const modalBtns = payload.modalButtons

                const cleanBtnText = (text: string) =>
                    text.replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '')
                        .replace(/\s*(Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)(\+\s*\w+)*/gi, '')
                        .trim()

                const resolveAction = this.resolveActionFn
                const actions: ToastAction[] = modalBtns.map((btnText, idx) => {
                    const clean = cleanBtnText(btnText).toLowerCase()
                    const isPrimary = /^(run|approve|accept|yes|allow|always)/.test(clean)
                    const isDanger = /^(reject|deny|delete|remove|abort|cancel|no)/.test(clean)
                    return {
                        label: cleanBtnText(btnText),
                        variant: (isPrimary ? 'primary' : isDanger ? 'danger' : 'default') as 'primary' | 'danger' | 'default',
                        onClick: () => {
                            const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean)
                            resolveAction(routeId, 'resolve_action', {
                                action: isApprove ? 'approve' : 'reject',
                                button: btnText,
                                buttonIndex: idx,
                                agentType,
                                ideType,
                                ...(payload.targetSessionId && { targetSessionId: payload.targetSessionId }),
                            })
                        },
                    }
                })

                const contextMsg = payload.modalMessage
                    ? `⚡ ${ideLabel}: ${payload.modalMessage.replace(/[\n\r]+/g, ' ').slice(0, 80)}`
                    : msg

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
                    `long-${payload.ideId || payload.agentType}`,
                )
            }

        // ── team:view_request (incoming request to view YOUR session) ──
        } else if (payload.event === 'team:view_request') {
            const requesterName = (payload as any).requesterName || 'A team member'
            const requestId = (payload as any).requestId
            const orgId = (payload as any).orgId

            msg = `👁️ ${requesterName} wants to view your session`
            type = 'warning'

            // Show actionable toast with Approve/Decline
            if (requestId && orgId && this.viewRequestRespondFn) {
                const respondFn = this.viewRequestRespondFn
                const toastId = Date.now()
                const actions: ToastAction[] = [
                    {
                        label: 'Approve',
                        variant: 'primary',
                        onClick: () => {
                            respondFn(orgId, requestId, 'approve').catch((e: any) =>
                                console.error('[EventManager] approve view request failed:', e)
                            )
                        },
                    },
                    {
                        label: 'Decline',
                        variant: 'danger',
                        onClick: () => {
                            respondFn(orgId, requestId, 'reject').catch((e: any) =>
                                console.error('[EventManager] reject view request failed:', e)
                            )
                        },
                    },
                ]
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
            const targetName = (payload as any).targetName || 'Team member'
            msg = `❌ ${targetName} declined your view request`
            type = 'warning'
        }

        // Default toast (if msg was set and not overridden)
        if (msg) {
            const toastId = Date.now()
            this.emitToast({
                id: toastId, message: msg, type, timestamp: toastId,
                targetKey: conversationKey || payload.ideId, duration: 5000,
            })
        }
    }
}

/** Singleton instance */
export const eventManager = new EventManager()
