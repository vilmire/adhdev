/**
 * LiveSessionSet — "which session ids are registered right now", kept by bus
 * subscription (wiring-unification B4, plan §2 #12).
 *
 * Replaces the transcript-claim liveness closure that re-read the registry:
 * a claim held by a session that is no longer registered is demonstrably dead
 * and reclaimable; a claim held by a REGISTERED session is never stolen, even
 * past the time-based stale window. `registered`/`terminated` are emitted
 * synchronously inside `register`/`terminate`, so this set is exactly as fresh
 * as the registry itself.
 */

import type { SessionLifecycleBus } from '../sessions/lifecycle-bus.js';

export interface LiveSessionSet {
    has(sessionId: string): boolean;
    readonly size: number;
    /** Stop tracking (the set keeps its last contents). */
    unsubscribe(): void;
}

export function subscribeLiveSessions(bus: SessionLifecycleBus, seed: Iterable<string> = []): LiveSessionSet {
    const live = new Set<string>(seed);
    const offRegistered = bus.on('registered', (e) => { live.add(e.sessionId); }, { name: 'sessions.live-set.add' });
    const offTerminated = bus.on('terminated', (e) => { live.delete(e.sessionId); }, { name: 'sessions.live-set.delete' });
    return {
        has: (sessionId) => live.has(sessionId),
        get size() { return live.size; },
        unsubscribe() {
            offRegistered();
            offTerminated();
        },
    };
}

/**
 * The transcript-claim liveness predicate over a live-session set. Owner
 * tokens are `iid:<sessionId>`; any other form is treated as live (never stolen).
 */
export function transcriptClaimOwnerIsLive(live: Pick<LiveSessionSet, 'has'>, owner: string): boolean {
    const match = /^iid:(.+)$/.exec(owner);
    if (!match) return true;
    return live.has(match[1]);
}
