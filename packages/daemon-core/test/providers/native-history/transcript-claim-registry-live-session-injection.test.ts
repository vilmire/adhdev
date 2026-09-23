/**
 * transcript-claim-registry's liveness probe, wired to a real bus-backed
 * LiveSessionSet (wiring-unification B4 item #12 / B4 report item #8).
 *
 * `boot/live-sessions.ts`'s `subscribeLiveSessions` keeps "which session ids
 * are registered right now" current by subscribing the lifecycle bus's
 * `registered`/`terminated` events. `bootSessionCore`
 * (boot/stages/session-core.ts) wires this set into
 * `setTranscriptClaimLivenessProbe` via `transcriptClaimOwnerIsLive`, so a
 * claim held by a still-REGISTERED session is never stolen — even past the
 * time-based CLAIM_STALE_MS fallback — while a claim held by a session the
 * registry has forgotten (terminated) is immediately reclaimable.
 *
 * This test exercises exactly that wiring end to end: a real
 * SessionLifecycleBus + subscribeLiveSessions, installed as the probe via
 * setTranscriptClaimLivenessProbe, with no mock in between.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionLifecycleBus } from '../../../src/sessions/lifecycle-bus.js';
import { subscribeLiveSessions, transcriptClaimOwnerIsLive } from '../../../src/boot/live-sessions.js';
import {
    claimTranscript,
    isTranscriptClaimedByOther,
    setTranscriptClaimLivenessProbe,
    transcriptClaimOwnerToken,
    __resetTranscriptClaimRegistry,
} from '../../../src/providers/native-history/transcript-claim-registry.js';

describe('transcript-claim-registry liveness probe ← bus-backed LiveSessionSet', () => {
    afterEach(() => {
        __resetTranscriptClaimRegistry();
    });

    it('never reclaims a claim held by a still-registered session, even past the stale window', () => {
        const bus = createSessionLifecycleBus();
        const live = subscribeLiveSessions(bus);
        setTranscriptClaimLivenessProbe((owner) => transcriptClaimOwnerIsLive(live, owner));

        bus.emit({ kind: 'registered', at: 0, sessionId: 'sess-owner', origin: 'launch' } as any);
        const owner = transcriptClaimOwnerToken('sess-owner');
        expect(claimTranscript('key-1', owner, 0)).toBe('claimed');

        // Far past CLAIM_STALE_MS (10min), but the owner is still registered on
        // the bus-backed set: a probe-confirmed live owner is never stolen.
        const farFuture = 0 + 60 * 60 * 1000;
        expect(isTranscriptClaimedByOther('key-1', transcriptClaimOwnerToken('sess-other'), farFuture)).toBe(true);
        expect(claimTranscript('key-1', transcriptClaimOwnerToken('sess-other'), farFuture)).toBe('denied');

        live.unsubscribe();
        setTranscriptClaimLivenessProbe(null);
    });

    it('reclaims immediately once the bus reports the owner terminated, with no time delay', () => {
        const bus = createSessionLifecycleBus();
        const live = subscribeLiveSessions(bus);
        setTranscriptClaimLivenessProbe((owner) => transcriptClaimOwnerIsLive(live, owner));

        bus.emit({ kind: 'registered', at: 0, sessionId: 'sess-owner', origin: 'launch' } as any);
        const owner = transcriptClaimOwnerToken('sess-owner');
        expect(claimTranscript('key-2', owner, 0)).toBe('claimed');

        // Terminate on the bus — the live set drops it synchronously.
        bus.emit({ kind: 'terminated', at: 1, sessionId: 'sess-owner', cause: 'stop_requested' } as any);

        // Reclaimed immediately (1ms later), no need to wait out CLAIM_STALE_MS.
        const other = transcriptClaimOwnerToken('sess-other');
        expect(claimTranscript('key-2', other, 1)).toBe('stale_reclaimed');

        live.unsubscribe();
        setTranscriptClaimLivenessProbe(null);
    });

    it('unsubscribing the live-session set freezes it, and clearing the probe falls back to the time-based window', () => {
        const bus = createSessionLifecycleBus();
        const live = subscribeLiveSessions(bus);
        setTranscriptClaimLivenessProbe((owner) => transcriptClaimOwnerIsLive(live, owner));

        bus.emit({ kind: 'registered', at: 0, sessionId: 'sess-owner', origin: 'launch' } as any);
        const owner = transcriptClaimOwnerToken('sess-owner');
        claimTranscript('key-3', owner, 0);

        live.unsubscribe();
        setTranscriptClaimLivenessProbe(null); // mirrors bootSessionCore's disposeLiveness()

        // No probe installed any more: falls back to the time-based stale window.
        const other = transcriptClaimOwnerToken('sess-other');
        expect(claimTranscript('key-3', other, 1)).toBe('denied'); // not stale yet
        const past10min = 0 + 10 * 60 * 1000;
        expect(claimTranscript('key-3', other, past10min)).toBe('stale_reclaimed');
    });
});
