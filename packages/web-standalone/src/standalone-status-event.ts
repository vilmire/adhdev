/**
 * Standalone `status_event` routing (wiring-unification B5, checklist item 3).
 *
 * The standalone daemon now broadcasts `{type:'status_event', payload, timestamp}`
 * over its dashboard WS — the same allow-listed projection web-cloud receives
 * over P2P (daemon-core status/status-event.ts). Before B5 there was no producer
 * and no consumer, so a tool-approval / completion toast never reached a
 * standalone dashboard as an event. This routes it into web-core's event
 * manager exactly like web-cloud's `p2pManager.onStatusEvent` handler does.
 */
import type { DashboardStatusEventPayload } from '@adhdev/web-core'

export interface StatusEventSink {
    handleRawEvent(payload: DashboardStatusEventPayload, source: 'ws' | 'p2p'): void
}

/** Returns true when `msg` was a status_event (handled or dropped as malformed). */
export function routeStandaloneStatusEvent(msg: unknown, daemonId: string | null | undefined, sink: StatusEventSink): boolean {
    if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'status_event') return false
    const payload = (msg as { payload?: unknown }).payload
    if (!payload || typeof payload !== 'object' || typeof (payload as { event?: unknown }).event !== 'string') return true
    sink.handleRawEvent({ ...(payload as Record<string, unknown>), daemonId: daemonId || 'standalone' } as DashboardStatusEventPayload, 'ws')
    return true
}
