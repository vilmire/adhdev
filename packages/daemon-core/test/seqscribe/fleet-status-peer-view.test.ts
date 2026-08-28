import { describe, expect, it } from 'vitest';
import type { PeerHandle, Row } from 'seqscribe';
import {
    createFleetStatusPeerViewConsumer,
    FLEET_STATUS_SUB_VIEW,
} from '../../src/seqscribe/fleet-status-peer-view.js';
import { FLEET_STATUS_ENTRY_KIND } from '../../src/seqscribe/fleet-status-shadow.js';
import { FLEET_STATUS_TOPIC } from '../../src/seqscribe/topics.js';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';

type SnapshotCb = (rows: Row[], reset: boolean) => void;
type DeltaCb = (changes: { upserts: Row[]; deletes: string[] }) => void;

function harness() {
    let snapshotCb: SnapshotCb | null = null;
    let deltaCb: DeltaCb | null = null;
    let closeCount = 0;
    let onEntryCalls = 0;
    const subscribeCalls: Array<{ peer: PeerHandle; options: unknown }> = [];
    const node = {
        onEntry() {
            onEntryCalls++;
            throw Object.assign(new Error('ring/none serve via SUB'), { code: 'ERR_MISUSE' });
        },
        subscribe(peer: PeerHandle, options: unknown) {
            subscribeCalls.push({ peer, options });
            return {
                onSnapshot(cb: SnapshotCb) { snapshotCb = cb; return () => { snapshotCb = null; }; },
                onDelta(cb: DeltaCb) { deltaCb = cb; return () => { deltaCb = null; }; },
                get cursor() { return undefined; },
                close() { closeCount++; },
            };
        },
    };
    const handle = { node } as unknown as SeqscribeNodeHandle;
    const peer = {
        peerId: 'daemon_mach_peer',
        state: () => 'ready' as const,
        onStateChange: () => () => {},
        detach: () => {},
    } satisfies PeerHandle;
    const consumer = createFleetStatusPeerViewConsumer(handle);
    return {
        consumer,
        peer,
        subscribeCalls,
        get onEntryCalls() { return onEntryCalls; },
        get closeCount() { return closeCount; },
        snapshot(rows: Row[]) { snapshotCb?.(rows, false); },
        delta(rows: Row[]) { deltaCb?.({ upserts: rows, deletes: [] }); },
    };
}

function entry(overrides: Record<string, unknown> = {}) {
    return {
        daemonId: 'daemon_mach_peer',
        at: '2026-08-28T00:00:00.000Z',
        onlineState: 'online',
        p2pActive: true,
        sessionCounts: {
            ideCount: 1,
            cliCount: 2,
            acpCount: 0,
            idleCount: 2,
            generatingCount: 1,
            waitingApprovalCount: 0,
            erroredCount: 0,
        },
        ...overrides,
    };
}

function row(seq: number, payload: unknown, overrides: Partial<Row> = {}): Row {
    return {
        key: `adhdev-peer:${seq}`,
        writer: 'adhdev-peer',
        seq,
        hlc_l: 1_700_000_000_000 + seq,
        hlc_c: 0,
        kind: FLEET_STATUS_ENTRY_KIND,
        payload: JSON.stringify(payload),
        ...overrides,
    };
}

describe('fleet.status peer view — SUB is the only ring read path', () => {
    it('attaches the built-in tail SUB and never calls durable onEntry', () => {
        const h = harness();
        expect(h.consumer.attachPeer('daemon_mach_peer', h.peer)).toBe(true);
        expect(h.subscribeCalls).toHaveLength(1);
        expect(h.subscribeCalls[0]?.options).toEqual({
            view: FLEET_STATUS_SUB_VIEW,
            params: { topic: FLEET_STATUS_TOPIC },
        });
        expect(h.onEntryCalls).toBe(0);
    });
});

describe('fleet.status peer view — latest-only replacement', () => {
    it('keeps only the newest SNAP row and replaces it with a newer DELTA', () => {
        const h = harness();
        h.consumer.attachPeer('daemon_mach_peer', h.peer);
        h.snapshot([
            row(1, entry({ onlineState: 'reconnecting' })),
            row(2, entry({ at: '2026-08-28T00:00:02.000Z', onlineState: 'online' })),
        ]);
        expect(h.consumer.snapshot().peers).toHaveLength(1);
        expect(h.consumer.snapshot().peers[0]?.at).toBe('2026-08-28T00:00:02.000Z');

        // An older delivery cannot roll the local slot backward.
        h.delta([row(1, entry({ onlineState: 'offline' }))]);
        expect(h.consumer.snapshot().peers[0]?.onlineState).toBe('online');

        h.delta([row(3, entry({ at: '2026-08-28T00:00:03.000Z', onlineState: 'reconnecting' }))]);
        const view = h.consumer.snapshot();
        expect(view.peers).toHaveLength(1);
        expect(view.peers[0]?.onlineState).toBe('reconnecting');
        expect(view.diagnostics.viewReplacements).toBe(2);
    });

    it('clears the live slot and closes the connection-scoped SUB on detach', () => {
        const h = harness();
        h.consumer.attachPeer('daemon_mach_peer', h.peer);
        h.snapshot([row(1, entry())]);
        h.consumer.detachPeer('daemon_mach_peer');
        expect(h.consumer.snapshot().peers).toEqual([]);
        expect(h.consumer.snapshot().diagnostics.subscribedPeers).toBe(0);
        expect(h.closeCount).toBe(1);
    });

    it('stop closes all SUBs, clears the snapshot and prevents reattachment', () => {
        const h = harness();
        h.consumer.attachPeer('daemon_mach_peer', h.peer);
        h.snapshot([row(1, entry())]);

        h.consumer.stop();
        h.consumer.stop();

        expect(h.consumer.snapshot().peers).toEqual([]);
        expect(h.consumer.snapshot().diagnostics.subscribedPeers).toBe(0);
        expect(h.closeCount).toBe(1);
        expect(h.consumer.attachPeer('daemon_mach_peer', h.peer)).toBe(false);
    });
});

describe('fleet.status peer view — receive boundary and comparison counters', () => {
    it('drops out-of-schema fields and rejects invalid or peer-mismatched entries', () => {
        const h = harness();
        h.consumer.attachPeer('daemon_mach_peer', h.peer);
        h.snapshot([
            row(1, entry({
                machineNickname: 'CANARY user prose',
                sessions: [{ title: 'CANARY chat title' }],
                futurePayload: { text: 'CANARY prompt text' },
            })),
            row(2, entry({ daemonId: 'daemon_mach_other' })),
            row(3, entry({ sessionCounts: { cliCount: -1 } })),
        ]);

        const view = h.consumer.snapshot();
        expect(view.peers).toHaveLength(1);
        const wire = JSON.stringify(view);
        expect(wire).not.toContain('CANARY');
        expect(view.peers[0]).not.toHaveProperty('machineNickname');
        expect(view.peers[0]).not.toHaveProperty('sessions');
        expect(view.diagnostics).toMatchObject({
            receivedEntries: 3,
            comparedEntries: 2,
            matchedEntries: 1,
            mismatchedEntries: 1,
            invalidEntries: 1,
        });
        for (const value of Object.values(view.diagnostics)) expect(typeof value).toBe('number');
    });
});
