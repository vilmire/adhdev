/**
 * daemon.metadata is the ONE dashboard state lane (data-path audit 2026-09-29
 * P0-3): a snapshot on subscribe, then keyed deltas. This pins the bytes:
 *
 *   - an unchanged daemon (only the build timestamp / per-session
 *     `lastUpdated` stamps move) sends ZERO bytes on a sample tick;
 *   - one changed session field sends a delta carrying only that session's
 *     changed field (+ its lastUpdated), never the other sessions;
 *   - a removal is explicit, and a failed send falls back to a snapshot.
 */
import { describe, expect, it } from 'vitest';

import type { DaemonMetadataUpdateBody, TopicSink } from '../../src/subscriptions/topic-registry.js';
import { TopicSubscriptionRegistry, machineRuntimeSignature } from '../../src/subscriptions/topic-registry.js';
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared';

function session(id: string, status: string, stamp: number) {
    return {
        id,
        parentId: null,
        providerType: 'claude-cli',
        providerName: 'Claude Code',
        kind: 'agent',
        transport: 'pty',
        status,
        title: `Task ${id}`,
        workspace: '/repo',
        lastMessagePreview: 'x'.repeat(200),
        capabilities: ['read_chat', 'send_message'],
        providerControls: [{ id: 'model', type: 'select', options: ['a', 'b', 'c'] }],
        lastUpdated: stamp,
    };
}

function harness() {
    const frames: Array<{ bytes: number; update: Record<string, any> }> = [];
    let deliver = true;
    const sink: TopicSink = {
        send: (_c, _t, update) => {
            if (!deliver) return false;
            frames.push({ bytes: JSON.stringify(update).length, update: update as any });
            return true;
        },
        isDeliverable: () => true,
        isAlive: () => true,
    };
    let clock = 1_000;
    const statuses: Record<string, string> = { a: 'idle', b: 'idle', c: 'idle' };
    const registry = new TopicSubscriptionRegistry(sink, {
        now: () => clock,
        sources: {
            daemonMetadataBody: () => ({
                daemonId: 'daemon_1',
                status: {
                    instanceId: 'daemon_1',
                    timestamp: clock,
                    machine: { hostname: 'h', platform: 'darwin' },
                    availableProviders: [{ type: 'claude-cli', displayName: 'Claude Code' }],
                    sessions: Object.entries(statuses).map(([id, status]) => session(id, status, clock)),
                },
            }) as unknown as DaemonMetadataUpdateBody,
        },
    });
    registry.subscribe('c1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'daemon.metadata', key: 'm', params: { includeSessions: true } });
    return {
        registry,
        frames,
        statuses,
        tick: async (ms = 5_000) => { clock += ms; await registry.flushNow('daemon.metadata'); },
        setDeliver: (value: boolean) => { deliver = value; },
    };
}

describe('daemon.metadata keyed delta — bytes per tick', () => {
    it('sends a snapshot first, then ZERO bytes for an unchanged daemon on every tick', async () => {
        const h = harness();
        await h.registry.flushNow('daemon.metadata', 'c1', 'm');
        expect(h.frames).toHaveLength(1);
        expect(h.frames[0]!.update.mode).toBe('snapshot');
        for (let i = 0; i < 10; i++) await h.tick();
        expect(h.frames).toHaveLength(1);
    });

    it('a changed field produces a delta with only that session and field', async () => {
        const h = harness();
        await h.registry.flushNow('daemon.metadata', 'c1', 'm');
        const snapshotBytes = h.frames[0]!.bytes;
        h.statuses.b = 'generating';
        await h.tick();
        expect(h.frames).toHaveLength(2);
        const delta = h.frames[1]!;
        expect(delta.update).toEqual({
            topic: 'daemon.metadata',
            key: 'm',
            mode: 'delta',
            daemonId: 'daemon_1',
            delta: { collections: { 'status.sessions': { upsert: [{ id: 'b', status: 'generating', lastUpdated: 6_000 }] } } },
            seq: 2,
            timestamp: 6_000,
        });
        expect(delta.bytes).toBeLessThan(snapshotBytes / 5);
    });

    it('makes removals explicit and re-snapshots after a failed send', async () => {
        const h = harness();
        await h.registry.flushNow('daemon.metadata', 'c1', 'm');
        delete h.statuses.c;
        await h.tick();
        expect(h.frames[1]!.update).toMatchObject({ mode: 'delta', delta: { collections: { 'status.sessions': { removed: ['c'], order: ['a', 'b'] } } } });

        h.setDeliver(false);
        h.statuses.a = 'error';
        await h.tick();
        h.setDeliver(true);
        await h.tick();
        expect(h.frames[2]!.update.mode).toBe('snapshot');
        expect(h.frames[2]!.update.seq).toBe(4);
    });
});

describe('machine.runtime change signature', () => {
    it('ignores sub-percent memory / sub-0.1 load / sub-minute uptime jitter, not real changes', () => {
        const base = { hostname: 'h', platform: 'darwin', totalMem: 1_000_000, freeMem: 500_000, loadavg: [1.21, 1, 1], uptime: 600 } as any;
        expect(machineRuntimeSignature({ ...base, freeMem: 500_900, loadavg: [1.24, 1, 1], uptime: 630 }))
            .toBe(machineRuntimeSignature(base));
        expect(machineRuntimeSignature({ ...base, freeMem: 400_000 })).not.toBe(machineRuntimeSignature(base));
        expect(machineRuntimeSignature({ ...base, uptime: 700 })).not.toBe(machineRuntimeSignature(base));
    });
});
