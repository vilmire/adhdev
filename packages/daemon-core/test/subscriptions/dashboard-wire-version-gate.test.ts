/**
 * One dashboard wire format per release (mesh-shared protocol/dashboard-wire-version.ts):
 * a subscribe that states another version — or none (a pre-versioning page) — is
 * answered with an explicit `protocol_mismatch` and NO state; a matching one gets
 * its snapshot, stamped with the daemon's version.
 */
import { describe, expect, it } from 'vitest';
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared';

import type { TopicSink } from '../../src/subscriptions/topic-registry.js';
import { TopicSubscriptionRegistry } from '../../src/subscriptions/topic-registry.js';

function harness() {
    const frames: Array<{ connectionId: string; topic: string; update: any }> = [];
    const sink: TopicSink = {
        send: (connectionId, topic, update) => { frames.push({ connectionId, topic, update }); return true; },
        isDeliverable: () => true,
        isAlive: () => true,
    };
    const registry = new TopicSubscriptionRegistry(sink, {
        now: () => 5_000,
        sources: { daemonMetadataBody: () => ({ daemonId: 'daemon_1', status: { instanceId: 'daemon_1', timestamp: 1, sessions: [] } as any }) },
    });
    return { frames, registry };
}

describe('dashboard wire-version gate', () => {
    it('a page without a version (pre-versioning bundle) gets protocol_mismatch, never state', async () => {
        const h = harness();
        expect(h.registry.subscribe('c1', { type: 'subscribe', topic: 'daemon.metadata', key: 'm', params: {} } as any)).toBe(false);
        await h.registry.flushNow('daemon.metadata', 'c1', 'm');
        expect(h.frames).toEqual([{
            connectionId: 'c1',
            topic: 'daemon.metadata',
            update: { topic: 'daemon.metadata', key: 'm', mode: 'protocol_mismatch', daemonWireVersion: DASHBOARD_WIRE_VERSION, pageWireVersion: null, seq: 0, timestamp: 5_000 },
        }]);
    });

    it('a page speaking another version is refused the same way (either direction)', () => {
        const h = harness();
        h.registry.subscribe('c1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION + 1, topic: 'mesh.status', key: 'k', params: { meshId: 'm' } });
        h.registry.subscribe('c2', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION - 1, topic: 'machine.runtime', key: 'k', params: {} } as any);
        expect(h.frames.map((f) => [f.update.mode, f.update.pageWireVersion])).toEqual([
            ['protocol_mismatch', DASHBOARD_WIRE_VERSION + 1],
            ['protocol_mismatch', DASHBOARD_WIRE_VERSION - 1],
        ]);
    });

    it('a matching page gets its snapshot, stamped with the daemon wire version', async () => {
        const h = harness();
        expect(h.registry.subscribe('c1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'm', params: {} })).toBe(true);
        await h.registry.flushNow('daemon.metadata', 'c1', 'm');
        expect(h.frames).toHaveLength(1);
        expect(h.frames[0]!.update).toMatchObject({ mode: 'snapshot', wireVersion: DASHBOARD_WIRE_VERSION, daemonId: 'daemon_1' });
    });
});
