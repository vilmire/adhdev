/**
 * subscribeTranscriptProjection — the transcript publisher's ONE set of dirty
 * triggers, as lifecycle-bus subscribers (wiring-unification B4, plan §1.4g).
 *
 *  - `provider_event` agent:* / monitor:* → markDirty('status_event'). The
 *    status-transition trigger used to live in the cloud-only
 *    `DaemonStatusReporter.emitStatusEvent`; on the bus it runs in both hosts.
 *    (Only the provider event, not the paired `status` edge: both arrive for
 *    one transition and the second would queue a redundant pull.)
 *  - `command_executed{postChat}` → markDirty('post_chat').
 *  - `registered` → startPolling + warmSession (define the session's `.chat`
 *    topic now and seed its first frame — first-paint latency: a dashboard pane
 *    must not wait for the session's first PTY publish to become SUB-able);
 *    `terminated` → stopPolling + forgetSession (the per-session maps used to
 *    leak for every session that ever ended — C9). The topic's claim is
 *    released by `SessionRegistry` itself (`setTranscriptTopicRelease`).
 *  - `existingSessionIds` — sessions registered BEFORE this subscription was
 *    armed (boot order: the registry exists in S3, the projection arms in S6)
 *    get the same `registered` treatment once, so none of them is left
 *    undefined until something happens to publish.
 *
 * PTY output activity is NOT on the bus (volume) and still reaches the service
 * through the output fanout; the read_chat choke point still pushes observations.
 */

import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import type { TranscriptProjectionService } from './transcript-publisher.js';

/** Provider events that are per-session status transitions (what emitStatusEvent forwarded). */
export function isTranscriptStatusTrigger(eventName: unknown): boolean {
    return typeof eventName === 'string' && (eventName.startsWith('agent:') || eventName.startsWith('monitor:'));
}

export function subscribeTranscriptProjection(
    bus: SessionLifecycleBus,
    service: Pick<TranscriptProjectionService, 'markDirty' | 'startPolling' | 'stopPolling' | 'forgetSession' | 'warmSession'>,
    options: { readonly existingSessionIds?: Iterable<string> } = {},
): Unsubscribe {
    const unsubscribers: Unsubscribe[] = [
        bus.on('provider_event', (e) => {
            if (!isTranscriptStatusTrigger(e.event.event)) return;
            const target = typeof e.event.targetSessionId === 'string' && e.event.targetSessionId.trim()
                ? e.event.targetSessionId.trim()
                : e.sessionId;
            if (target) service.markDirty(target, 'status_event');
        }, { name: 'transcript.status-trigger' }),
        bus.on('command_executed', (e) => {
            if (e.postChat && e.sessionId) service.markDirty(e.sessionId, 'post_chat');
        }, { name: 'transcript.post-chat-trigger' }),
        bus.on('registered', (e) => {
            service.startPolling(e.sessionId);
            service.warmSession(e.sessionId);
        }, { name: 'transcript.stat-poll' }),
        bus.on('terminated', (e) => {
            service.stopPolling(e.sessionId);
            service.forgetSession(e.sessionId);
        }, { name: 'transcript.forget' }),
    ];
    for (const sessionId of options.existingSessionIds ?? []) {
        if (!sessionId) continue;
        service.startPolling(sessionId);
        service.warmSession(sessionId);
    }
    return () => {
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    };
}
