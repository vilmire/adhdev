/**
 * `TopicSubscriptionRegistry.oldestLastSentAt` — the read-only accessor added
 * for the host runtime's WARN-only topic-flush reconciliation (wiring-
 * unification P-II item 1, design §7f; consumer: boot/host-subscribers.ts
 * `subscribeHostTopicReconciliation`). It must never mutate registry state
 * and must return `null` for a topic with no subscribers (so the
 * reconciliation pass can skip it) and `0` for a subscriber that has never
 * been sent to (maximally stale, distinct from "no subscribers").
 */
import { describe, expect, it } from 'vitest';
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared';
import {
    TopicSubscriptionRegistry,
    type TopicSink,
} from '../../src/subscriptions/topic-registry.js';

function makeRegistry(now: () => number, sinkOverrides: Partial<TopicSink> = {}): TopicSubscriptionRegistry {
    const sink: TopicSink = {
        send: () => true,
        isDeliverable: () => true,
        isAlive: () => true,
        ...sinkOverrides,
    };
    return new TopicSubscriptionRegistry(sink, {
        now,
        sources: {
            daemonMetadataBody: () => ({ daemonId: 'd1', status: {} as any }),
        },
    });
}

describe('TopicSubscriptionRegistry.oldestLastSentAt', () => {
    it('returns null for a topic with zero subscribers', () => {
        const registry = makeRegistry(() => 1_000);
        expect(registry.oldestLastSentAt('daemon.metadata')).toBeNull();
        expect(registry.oldestLastSentAt('workspace.git')).toBeNull();
    });

    it('returns 0 for a fresh subscriber that has never been flushed', () => {
        const registry = makeRegistry(() => 1_000);
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'k1', params: {} } as any);
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(0);
    });

    it('advances to the flush timestamp once flushNow sends, and stays the OLDEST across multiple subscribers', async () => {
        let clock = 1_000;
        const registry = makeRegistry(() => clock);
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'k1', params: {} } as any);
        await registry.flushNow('daemon.metadata');
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(1_000);

        // A second, later subscriber that hasn't been flushed yet pulls the
        // oldest back down to 0 — the reconciliation pass must see the WORST
        // subscriber, not the best one.
        clock = 5_000;
        registry.subscribe('conn-2', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'k2', params: {} } as any);
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(0);

        // daemon.metadata is throttle-free but keyed: this pass SENDS conn-2
        // its snapshot, while conn-1's state is unchanged so it is sent
        // nothing (audit P0-3) — its lastSentAt stays put, and the flush PASS
        // (what reconciliation reads) still reaches both.
        await registry.flushNow('daemon.metadata');
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(1_000);
        expect(registry.oldestLastFlushedAt('daemon.metadata')).toBe(5_000);
    });

    it('drops an entry once its connection is no longer alive (lazy prune on flush)', async () => {
        let alive = true;
        let clock = 1_000;
        const registry = makeRegistry(() => clock, { isAlive: () => alive });
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'session_host.diagnostics', key: 'k1', params: {} } as any);
        // session_host.diagnostics needs a source; skip flush and just prune via hasSubscriptions/dropConnection path exercised by machine.runtime instead.
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'machine.runtime', key: 'k2', params: {} } as any);
        await registry.flushNow('machine.runtime');
        expect(registry.oldestLastSentAt('machine.runtime')).toBe(1_000);

        alive = false;
        await registry.flushNow('machine.runtime'); // lazily prunes the dead connection
        expect(registry.oldestLastSentAt('machine.runtime')).toBeNull();
    });

    it('workspace.git: mirrors the push-topic behavior through the git-subscription map', async () => {
        let clock = 2_000;
        const registry = makeRegistry(() => clock);
        expect(registry.oldestLastSentAt('workspace.git')).toBeNull();
        const subscribed = registry.subscribe('conn-1', {
            type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION,
            topic: 'workspace.git',
            key: 'k1',
            params: { workspace: '/repo', intervalMs: 1 },
        } as any);
        expect(subscribed).toBe(true);
        expect(registry.oldestLastSentAt('workspace.git')).toBe(0);
    });

    it('is read-only: calling it does not change hasSubscriptions or any entry state', () => {
        const registry = makeRegistry(() => 1_000);
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'k1', params: {} } as any);
        const before = registry.hasSubscriptions('daemon.metadata');
        registry.oldestLastSentAt('daemon.metadata');
        registry.oldestLastSentAt('daemon.metadata');
        expect(registry.hasSubscriptions('daemon.metadata')).toBe(before);
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(0);
    });

    it('refuses the retired session.modal topic (status + modal ride daemon.metadata)', () => {
        const registry = makeRegistry(() => 1_000);
        const accepted = registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'session.modal', key: 'k1', params: { targetSessionId: 's1' } } as any);
        expect(accepted).toBe(false);
        expect(registry.hasSubscriptions('session.modal' as any)).toBe(false);
    });
});

describe('TopicSubscriptionRegistry.oldestLastFlushedAt (reconciliation reads this, not lastSentAt)', () => {
    it('advances on a daemon.metadata flush that dedups to no-op, while oldestLastSentAt stays at the last real send', async () => {
        // Live false positive (2026-09-25 standalone pass): a flush that only
        // stamped `lastSentAt` when it SENT made a healthy subscriber whose
        // state had not changed look stale to the WARN-only reconciliation
        // forever. `lastFlushedAt` records every pass, sent or deduped.
        let clock = 1_000;
        const registry = makeRegistry(() => clock);
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'meta:1', params: {} } as any);
        expect(registry.oldestLastFlushedAt('daemon.metadata')).toBe(0);

        await registry.flushNow('daemon.metadata');
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(1_000);
        expect(registry.oldestLastFlushedAt('daemon.metadata')).toBe(1_000);

        // Same body again: the flush pass runs, diffs to nothing, sends nothing.
        clock = 61_000;
        await registry.flushNow('daemon.metadata');
        expect(registry.oldestLastSentAt('daemon.metadata')).toBe(1_000);
        expect(registry.oldestLastFlushedAt('daemon.metadata')).toBe(61_000);
    });

    it('returns null with no subscribers and 0 before the first flush pass', () => {
        const registry = makeRegistry(() => 1_000);
        expect(registry.oldestLastFlushedAt('daemon.metadata')).toBeNull();
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'k1', params: {} } as any);
        expect(registry.oldestLastFlushedAt('daemon.metadata')).toBe(0);
    });
});
