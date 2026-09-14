import type { SubscribeRequest, TopicUpdateEnvelope, TransportTopic, UnsubscribeRequest } from '@adhdev/daemon-core'
import { webDebugStore } from '../debug/webDebugStore'

export interface SubscriptionTransport {
    sendData?: (daemonId: string, data: SubscribeRequest | UnsubscribeRequest) => boolean
}

export type SubscriptionHandle = (() => void) & {
    initialSendAccepted: boolean
}

export interface SubscriptionOptions {
    /** If sendData returns false on initial subscribe, retry every retryIntervalMs until accepted or unsubscribed. */
    retryIntervalMs?: number
}

type TopicHandler<T extends TopicUpdateEnvelope = TopicUpdateEnvelope> = (update: T) => void

interface ActiveSubscription {
    daemonId: string
    request: SubscribeRequest
    handlers: Set<TopicHandler>
    /**
     * Each handler's own requested params. The wire request carries the UNION of
     * these (see mergeSubscriptionParams), so independent subscribers sharing one
     * topic key cannot downgrade each other.
     */
    handlerParams: Map<TopicHandler, Record<string, unknown>>
    lastUpdate?: TopicUpdateEnvelope
}

function buildSubscriptionId(topic: TransportTopic, key: string): string {
    return `${topic}:${key}`
}

/**
 * Numeric params whose "widest" direction is DOWN — a smaller value is the more
 * demanding request, so it satisfies every other subscriber. Interval-style
 * fields only; everything else numeric widens upward (see below).
 */
const MIN_WINS_PARAMS = new Set(['intervalMs'])

/**
 * Union-merge the params of every handler sharing a topic key.
 *
 * The daemon identifies a subscription by (connectionId, topic, key) — there is
 * exactly one server-side slot per key, so separate local entries cannot be
 * modelled on the wire. Previously the newest subscriber's params simply
 * overwrote the slot (last-writer-wins), which meant a subscriber asking for
 * less would silently downgrade the feed for one already asking for more.
 *
 * Merge rule, widest-wins per field:
 *  - booleans: true beats false — an opt-in from any subscriber stays opted in.
 *  - numbers:  direction depends on the field, because the two numeric params in
 *              the topic contract widen opposite ways. `intervalMs` widens DOWN
 *              (1s serves a subscriber that asked for 30s, not vice versa),
 *              while `limit` widens UP (30 rows serve a subscriber that asked
 *              for 12). Picking one direction for both would starve one of them.
 *  - anything else: first writer wins, so an unrelated later subscriber cannot
 *              clobber an established value.
 */
function mergeSubscriptionParams(
    handlerParams: Iterable<Record<string, unknown>>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    for (const params of handlerParams) {
        for (const [field, value] of Object.entries(params)) {
            if (!(field in merged) || merged[field] === undefined) {
                merged[field] = value
                continue
            }
            const current = merged[field]
            if (typeof current === 'boolean' && typeof value === 'boolean') {
                merged[field] = current || value
            } else if (typeof current === 'number' && typeof value === 'number') {
                merged[field] = MIN_WINS_PARAMS.has(field)
                    ? Math.min(current, value)
                    : Math.max(current, value)
            }
            // Otherwise keep the established value.
        }
    }
    return merged
}

function readRequestParams(request: SubscribeRequest): Record<string, unknown> {
    const params = (request as { params?: unknown }).params
    return params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {}
}

function areSubscribeRequestsEquivalent(left: SubscribeRequest, right: SubscribeRequest): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right)
    } catch {
        return false
    }
}

function shouldDebugSubscriptions(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return !!((import.meta as any).env?.DEV || window.localStorage.getItem('adhdev_mobile_debug') === '1')
    } catch {
        return false
    }
}

function logSubscriptionDebug(event: string, payload: Record<string, unknown>): void {
    if (!shouldDebugSubscriptions()) return
    console.debug(`[subscription-manager] ${event}`, payload)
}

export class SubscriptionManager {
    private active = new Map<string, ActiveSubscription>()
    private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

    subscribe<T extends TopicUpdateEnvelope>(
        transport: SubscriptionTransport,
        daemonId: string,
        request: SubscribeRequest,
        handler: TopicHandler<T>,
        options?: SubscriptionOptions,
    ): SubscriptionHandle {
        const id = buildSubscriptionId(request.topic, request.key)
        const existing = this.active.get(id)
        let initialSendAccepted = true
        if (existing) {
            existing.handlers.add(handler as TopicHandler)
            existing.handlerParams.set(handler as TopicHandler, readRequestParams(request))
            // Send the union of every sharing subscriber's params, not just this
            // caller's — otherwise a narrower subscriber downgrades the feed for
            // one that already asked for more (they share one daemon-side slot).
            const mergedRequest = {
                ...request,
                params: mergeSubscriptionParams(existing.handlerParams.values()),
            } as SubscribeRequest
            if (!areSubscribeRequestsEquivalent(existing.request, mergedRequest) || existing.daemonId !== daemonId) {
                existing.daemonId = daemonId
                existing.request = mergedRequest
                initialSendAccepted = transport.sendData?.(daemonId, mergedRequest) ?? false
                if (!initialSendAccepted && options?.retryIntervalMs) {
                    this.scheduleRetry(id, transport, options.retryIntervalMs)
                } else if (initialSendAccepted) {
                    this.clearRetry(id)
                }
                logSubscriptionDebug('subscribe_update', {
                    daemonId,
                    topic: request.topic,
                    key: request.key,
                    accepted: initialSendAccepted,
                })
            }
            if (existing.lastUpdate) {
                handler(existing.lastUpdate as T)
            }
        } else {
            const next: ActiveSubscription = {
                daemonId,
                request,
                handlers: new Set([handler as TopicHandler]),
                handlerParams: new Map([[handler as TopicHandler, readRequestParams(request)]]),
            }
            this.active.set(id, next)
            logSubscriptionDebug('subscribe', {
                daemonId,
                topic: request.topic,
                key: request.key,
            })
            initialSendAccepted = transport.sendData?.(daemonId, request) ?? false
            if (!initialSendAccepted && options?.retryIntervalMs) {
                this.scheduleRetry(id, transport, options.retryIntervalMs)
            }
        }

        let released = false
        const unsubscribe = (() => {
            // Idempotent: callers may defensively release a handle they already
            // released (or that a re-subscribe superseded). Without this guard a
            // second call would drop a handler registration it no longer owns.
            if (released) return
            released = true
            this.clearRetry(id)
            const current = this.active.get(id)
            if (!current) return
            current.handlers.delete(handler as TopicHandler)
            current.handlerParams.delete(handler as TopicHandler)
            if (current.handlers.size > 0) {
                // Others still share this key — re-send the narrowed union so the
                // daemon stops honouring params only the departing handler wanted.
                const narrowed = {
                    ...current.request,
                    params: mergeSubscriptionParams(current.handlerParams.values()),
                } as SubscribeRequest
                if (!areSubscribeRequestsEquivalent(current.request, narrowed)) {
                    current.request = narrowed
                    transport.sendData?.(current.daemonId, narrowed)
                }
                return
            }
            this.active.delete(id)
            // Address the unsubscribe to the daemon the subscription is CURRENTLY
            // bound to, not the one captured when this handle was created. A later
            // subscribe on the same topic key can retarget the entry (see the
            // `existing.daemonId = daemonId` reassignment above); using the stale
            // capture sent the unsubscribe to a daemon that no longer held the
            // subscription and left the live one streaming forever.
            const targetDaemonId = current.daemonId
            const unsubscribeRequest: UnsubscribeRequest = {
                type: 'unsubscribe',
                topic: request.topic,
                key: request.key,
            }
            logSubscriptionDebug('unsubscribe', {
                daemonId: targetDaemonId,
                topic: request.topic,
                key: request.key,
            })
            transport.sendData?.(targetDaemonId, unsubscribeRequest)
        }) as SubscriptionHandle

        unsubscribe.initialSendAccepted = initialSendAccepted
        return unsubscribe
    }

    publish(update: TopicUpdateEnvelope): void {
        const id = buildSubscriptionId(update.topic, update.key)
        const subscription = this.active.get(id)
        if (!subscription) return
        // An update arriving means the subscription is live — cancel any pending initial retry.
        this.clearRetry(id)
        subscription.lastUpdate = update
        webDebugStore.record({
            interactionId: typeof (update as { interactionId?: unknown }).interactionId === 'string' ? (update as { interactionId?: string }).interactionId : undefined,
            kind: 'subscription.publish',
            topic: update.topic,
            payload: { key: update.key },
        })
        subscription.handlers.forEach((handler) => {
            handler(update)
            webDebugStore.record({
                interactionId: typeof (update as { interactionId?: unknown }).interactionId === 'string' ? (update as { interactionId?: string }).interactionId : undefined,
                kind: 'subscription.handler_invoked',
                topic: update.topic,
                payload: { key: update.key },
            })
        })
    }

    updateParams(topic: TransportTopic, key: string, params: Record<string, unknown>): void {
        const id = buildSubscriptionId(topic, key)
        const existing = this.active.get(id)
        if (!existing) return
        existing.request = { ...existing.request, params: { ...existing.request.params, ...params } } as SubscribeRequest
        // Fold the override into every handler's contribution too, so the next
        // subscribe() on this key re-derives the union from params that already
        // include it instead of silently discarding the override.
        for (const [handler, handlerParams] of existing.handlerParams) {
            existing.handlerParams.set(handler, { ...handlerParams, ...params })
        }
    }

    resubscribeAll(transport: SubscriptionTransport): void {
        logSubscriptionDebug('resubscribe_all', {
            count: this.active.size,
            subscriptions: Array.from(this.active.values()).map((subscription) => ({
                daemonId: subscription.daemonId,
                topic: subscription.request.topic,
                key: subscription.request.key,
            })),
        })
        for (const subscription of this.active.values()) {
            transport.sendData?.(subscription.daemonId, subscription.request)
        }
    }

    resubscribeForDaemon(daemonId: string, transport: SubscriptionTransport): void {
        const subscriptions = Array.from(this.active.values()).filter((subscription) => subscription.daemonId === daemonId)
        logSubscriptionDebug('resubscribe_daemon', {
            daemonId,
            count: subscriptions.length,
            subscriptions: subscriptions.map((subscription) => ({
                topic: subscription.request.topic,
                key: subscription.request.key,
            })),
        })
        for (const subscription of subscriptions) {
            transport.sendData?.(subscription.daemonId, subscription.request)
        }
    }

    private scheduleRetry(id: string, transport: SubscriptionTransport, intervalMs: number): void {
        if (this.retryTimers.has(id)) return
        const timer = setTimeout(() => {
            this.retryTimers.delete(id)
            const subscription = this.active.get(id)
            if (!subscription) return
            const accepted = transport.sendData?.(subscription.daemonId, subscription.request) ?? false
            logSubscriptionDebug('subscribe_retry', {
                id,
                accepted,
                topic: subscription.request.topic,
                key: subscription.request.key,
            })
            if (!accepted) {
                this.scheduleRetry(id, transport, intervalMs)
            }
        }, intervalMs)
        this.retryTimers.set(id, timer)
    }

    private clearRetry(id: string): void {
        const timer = this.retryTimers.get(id)
        if (timer !== undefined) {
            clearTimeout(timer)
            this.retryTimers.delete(id)
        }
    }
}

export const subscriptionManager = new SubscriptionManager()
