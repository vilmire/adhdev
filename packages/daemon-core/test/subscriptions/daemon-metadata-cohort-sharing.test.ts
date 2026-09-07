import { describe, expect, it } from 'vitest';

import type { DaemonMetadataUpdateBody, TopicSink } from '../../src/subscriptions/topic-registry.js';
import { TopicSubscriptionRegistry } from '../../src/subscriptions/topic-registry.js';

/**
 * daemon.metadata per-pass cohort sharing (perf regression gate).
 *
 * The injected `daemonMetadataBody` source is the daemon's
 * buildDaemonMetadataBody: a full collectAllStates() + buildStatusSnapshot
 * ('metadata') over every provider/session. It was invoked once PER SUBSCRIBER,
 * so S dashboards watching one daemon each paid an independent O(N) snapshot on
 * a path that fires on every status change (measured 1.03 → 2.92 → 4.80ms for
 * S=1/3/5 at N=500).
 *
 * The body depends on exactly one input — `includeSessions` — so one flush pass
 * needs at most TWO builds no matter how many subscribers there are.
 *
 * These tests pin the properties that make the sharing safe:
 *   1. the build count per pass is bounded by the number of distinct cohorts,
 *      not by subscriber count (reverting the fix makes this red);
 *   2. cohorts do NOT bleed — an includeSessions:true subscriber never receives
 *      the body built for the false cohort, and vice versa;
 *   3. envelope fields stay per-subscription (each key keeps its own monotonic
 *      seq) even though the body object is shared;
 *   4. a later pass rebuilds — the sharing is per-pass, never a cross-pass cache
 *      that could serve a stale snapshot.
 */

interface Sent {
    connectionId: string;
    key: string;
    seq: number;
    marker: string;
    withSessions: boolean;
}

function createHarness() {
    const sent: Sent[] = [];
    const sink: TopicSink = {
        send: (connectionId, _topic, update) => {
            const u = update as unknown as {
                key: string;
                seq: number;
                daemonId: string;
                status: { marker: string; withSessions: boolean };
            };
            sent.push({
                connectionId,
                key: u.key,
                seq: u.seq,
                marker: u.status.marker,
                withSessions: u.status.withSessions,
            });
            return true;
        },
        isDeliverable: () => true,
        isAlive: () => true,
    };

    // Each build gets a unique marker so a shared body is identifiable in the
    // delivered payloads, not merely counted.
    let builds = 0;
    const buildsByCohort: boolean[] = [];
    const registry = new TopicSubscriptionRegistry(sink, {
        now: () => 1_000,
        sources: {
            daemonMetadataBody: (params) => {
                const withSessions = params?.includeSessions === true;
                builds += 1;
                buildsByCohort.push(withSessions);
                return {
                    daemonId: 'daemon_test',
                    status: { marker: `build-${builds}`, withSessions },
                } as unknown as DaemonMetadataUpdateBody;
            },
        },
    });

    const subscribe = (connectionId: string, key: string, includeSessions?: boolean) => {
        registry.subscribe(connectionId, {
            type: 'subscribe',
            topic: 'daemon.metadata',
            key,
            ...(includeSessions === undefined ? {} : { params: { includeSessions } }),
        } as never);
    };

    return { registry, sent, subscribe, buildCount: () => builds, buildsByCohort };
}

describe('daemon.metadata cohort sharing', () => {
    it('builds the body once per pass for many same-cohort subscribers', async () => {
        const { registry, sent, subscribe, buildCount } = createHarness();

        // Five dashboards on the same daemon, all in the includeSessions:false
        // cohort — the shape that previously cost five full snapshots.
        for (let i = 0; i < 5; i++) subscribe(`conn-${i}`, `meta:${i}`, false);

        await registry.flushNow('daemon.metadata');

        expect(sent).toHaveLength(5);
        // ★ The regression assertion. Reverting to a per-subscriber `source(...)`
        // call makes this 5.
        expect(buildCount()).toBe(1);
        // All five received the SAME body — sharing, not five coincidentally
        // equal builds.
        expect(new Set(sent.map((s) => s.marker))).toEqual(new Set(['build-1']));
    });

    it('keeps the two cohorts separate and builds at most one body each', async () => {
        const { registry, sent, subscribe, buildCount, buildsByCohort } = createHarness();

        subscribe('conn-a', 'meta:a', false);
        subscribe('conn-b', 'meta:b', true);
        subscribe('conn-c', 'meta:c', false);
        subscribe('conn-d', 'meta:d', true);

        await registry.flushNow('daemon.metadata');

        expect(sent).toHaveLength(4);
        // Two distinct cohorts → exactly two builds, regardless of subscriber
        // count. Reverting makes this 4.
        expect(buildCount()).toBe(2);
        expect(new Set(buildsByCohort)).toEqual(new Set([true, false]));

        // No bleed: each subscriber's payload matches ITS OWN cohort. A cohort
        // key bug would surface here even if the build count happened to be right.
        const byKey = new Map(sent.map((s) => [s.key, s]));
        expect(byKey.get('meta:a')!.withSessions).toBe(false);
        expect(byKey.get('meta:c')!.withSessions).toBe(false);
        expect(byKey.get('meta:b')!.withSessions).toBe(true);
        expect(byKey.get('meta:d')!.withSessions).toBe(true);
        // The two false-cohort subscribers share one body; the true-cohort pair
        // share the other; the two bodies are different objects.
        expect(byKey.get('meta:a')!.marker).toBe(byKey.get('meta:c')!.marker);
        expect(byKey.get('meta:b')!.marker).toBe(byKey.get('meta:d')!.marker);
        expect(byKey.get('meta:a')!.marker).not.toBe(byKey.get('meta:b')!.marker);
    });

    it('never builds a body when there are no subscribers', async () => {
        const { registry, buildCount } = createHarness();
        await registry.flushNow('daemon.metadata');
        expect(buildCount()).toBe(0);
    });

    it('builds only the cohort that actually has subscribers', async () => {
        const { registry, subscribe, buildCount, buildsByCohort } = createHarness();
        // Only cheap-cohort subscribers → the expensive sessions-inclusive body
        // must never be built.
        subscribe('conn-a', 'meta:a', false);
        subscribe('conn-b', 'meta:b', false);
        await registry.flushNow('daemon.metadata');
        expect(buildCount()).toBe(1);
        expect(buildsByCohort).toEqual([false]);
    });

    it('preserves per-subscription monotonic seq despite the shared body', async () => {
        const { registry, sent, subscribe } = createHarness();

        subscribe('conn-a', 'meta:a', false);
        subscribe('conn-b', 'meta:b', false);

        await registry.flushNow('daemon.metadata');
        await registry.flushNow('daemon.metadata');

        // Each key advances its own seq 1 → 2; sharing the body must not make
        // one subscriber inherit the other's counter.
        expect(sent.filter((s) => s.key === 'meta:a').map((s) => s.seq)).toEqual([1, 2]);
        expect(sent.filter((s) => s.key === 'meta:b').map((s) => s.seq)).toEqual([1, 2]);
    });

    it('rebuilds on a later pass — sharing is per-pass, not a cross-pass cache', async () => {
        const { registry, sent, subscribe, buildCount } = createHarness();

        subscribe('conn-a', 'meta:a', false);
        subscribe('conn-b', 'meta:b', false);

        await registry.flushNow('daemon.metadata');
        expect(buildCount()).toBe(1);

        // A second pass must produce FRESH state. Serving the first pass's body
        // again would publish a stale daemon snapshot — the one outcome that
        // would make this optimization a correctness bug.
        await registry.flushNow('daemon.metadata');
        expect(buildCount()).toBe(2);
        expect(sent.filter((s) => s.marker === 'build-2')).toHaveLength(2);
    });
});
