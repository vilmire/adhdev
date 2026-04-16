import type { SubscribeRequest, TopicUpdateEnvelope, TransportTopic, UnsubscribeRequest } from '@adhdev/daemon-core'
import { webDebugStore } from '../debug/webDebugStore'

export interface SubscriptionTransport {
    sendData?: (daemonId: string, data: SubscribeRequest | UnsubscribeRequest) => boolean
}

export type SubscriptionHandle = (() => void) & {
    initialSendAccepted: boolean
}

type TopicHandler<T extends TopicUpdateEnvelope = TopicUpdateEnvelope> = (update: T) => void

interface ActiveSubscription {
    daemonId: string
    request: SubscribeRequest
    handlers: Set<TopicHandler>
    lastUpdate?: TopicUpdateEnvelope
}

function buildSubscriptionId(topic: TransportTopic, key: string): string {
    return `${topic}:${key}`
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

    subscribe<T extends TopicUpdateEnvelope>(
        transport: SubscriptionTransport,
        daemonId: string,
        request: SubscribeRequest,
        handler: TopicHandler<T>,
    ): SubscriptionHandle {
        const id = buildSubscriptionId(request.topic, request.key)
        const existing = this.active.get(id)
        let initialSendAccepted = true
        if (existing) {
            existing.handlers.add(handler as TopicHandler)
            if (existing.lastUpdate) {
                handler(existing.lastUpdate as T)
            }
        } else {
            const next: ActiveSubscription = {
                daemonId,
                request,
                handlers: new Set([handler as TopicHandler]),
            }
            this.active.set(id, next)
            logSubscriptionDebug('subscribe', {
                daemonId,
                topic: request.topic,
                key: request.key,
            })
            initialSendAccepted = transport.sendData?.(daemonId, request) ?? false
        }

        const unsubscribe = (() => {
            const current = this.active.get(id)
            if (!current) return
            current.handlers.delete(handler as TopicHandler)
            if (current.handlers.size > 0) return
            this.active.delete(id)
            const unsubscribeRequest: UnsubscribeRequest = {
                type: 'unsubscribe',
                topic: request.topic,
                key: request.key,
            }
            logSubscriptionDebug('unsubscribe', {
                daemonId,
                topic: request.topic,
                key: request.key,
            })
            transport.sendData?.(daemonId, unsubscribeRequest)
        }) as SubscriptionHandle

        unsubscribe.initialSendAccepted = initialSendAccepted
        return unsubscribe
    }

    publish(update: TopicUpdateEnvelope): void {
        const id = buildSubscriptionId(update.topic, update.key)
        const subscription = this.active.get(id)
        if (!subscription) return
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
}

export const subscriptionManager = new SubscriptionManager()
