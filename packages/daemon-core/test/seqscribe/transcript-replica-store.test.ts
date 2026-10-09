import { describe, expect, it, vi } from 'vitest';
import type { PeerHandle, Row } from 'seqscribe';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionChatTopic } from '../../src/seqscribe/topics.js';
import {
    TRANSCRIPT_REPLICA_BASE_REQUEST_AFTER,
    TRANSCRIPT_REPLICA_SUB_VIEW,
    TranscriptReplicaStore,
} from '../../src/seqscribe/transcript-replica-store.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import { DAEMON, FrameDriver, SESSION, observation, ordOf } from './keyed-chat-fixtures.js';

/**
 * Subscriber-side `TranscriptReplicaStore` over the keyed chat topic (design
 * 2026-09-28 §5.2). A fake node hands back a controllable onSnapshot/onDelta
 * pair so SUB rows are driven directly; the real two-node path is
 * transcript-keyed-live.test.ts.
 */

type SnapshotCb = (rows: Row[]) => void;
type DeltaCb = (changes: { upserts: Row[]; deletes: string[] }) => void;

function toSubRows(driver: FrameDriver, frame: NonNullable<ReturnType<FrameDriver['step']>>): Row[] {
    return driver.rowsOf(frame).map((r) => ({ key: `${r.writer}:${r.seq}`, writer: r.writer, seq: r.seq, kind: r.kind, payload: JSON.stringify(r.payload) }));
}

function harness(hooks: ConstructorParameters<typeof TranscriptReplicaStore>[2] = {}) {
    let snapshotCb: SnapshotCb | null = null;
    let deltaCb: DeltaCb | null = null;
    let closeCount = 0;
    const subscribeCalls: Array<{ options: unknown }> = [];
    const definedTopics: string[] = [];
    const node = {
        defineTopic(topic: string) { definedTopics.push(topic); },
        subscribe(_peer: PeerHandle, options: unknown) {
            subscribeCalls.push({ options });
            return {
                onSnapshot(cb: SnapshotCb) { snapshotCb = cb; return () => { snapshotCb = null; }; },
                onDelta(cb: DeltaCb) { deltaCb = cb; return () => { deltaCb = null; }; },
                close() { closeCount++; },
            };
        },
    };
    const handle = {
        node: node as unknown as SeqscribeNodeHandle['node'],
        writerId: 'adhdev-writer-subscriber',
        daemonId: 'daemon_mach_subscriber',
        dbPath: ':memory:',
        topics: [],
        authorityEnabled: true,
        finalityLoop: null,
        onClose: () => {},
        close: async () => {},
    } as unknown as SeqscribeNodeHandle;
    const peer = { peerId: 'daemon_mach_test', state: () => 'ready' as const, onStateChange: () => () => {}, detach: () => {} } as unknown as PeerHandle;
    const store = new TranscriptReplicaStore(handle, new TranscriptTopicClaimRegistry(), hooks);
    return {
        store,
        peer,
        subscribeCalls,
        definedTopics,
        get closeCount() { return closeCount; },
        snapshot(rows: Row[]) { snapshotCb?.(rows); },
        delta(rows: Row[]) { deltaCb?.({ upserts: rows, deletes: [] }); },
    };
}

const KEY = { ownerDaemonId: DAEMON, rawSessionId: SESSION };
const bubbles = (suffix = '') => [0, 1, 2].map((i) => ({ id: `d.r.${i + 1}`, ord: ordOf(i), text: `b${i}${suffix}` }));

describe('TranscriptReplicaStore', () => {
    it('defines the chat topic locally and attaches the built-in tail SUB', () => {
        const h = harness();
        expect(h.store.ensureSubscription(KEY, h.peer)).toEqual({ ok: true, alreadySubscribed: false });
        expect(h.definedTopics).toEqual([sessionChatTopic(SESSION)]);
        expect(h.subscribeCalls[0]!.options).toEqual({ view: TRANSCRIPT_REPLICA_SUB_VIEW, params: { topic: sessionChatTopic(SESSION) } });
        expect(h.store.ensureSubscription(KEY, h.peer)).toEqual({ ok: true, alreadySubscribed: true });
    });

    it('no view until a commit verifies; then serves the folded view + commit identity; DELTA frames update it', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_complete_revision' });
        const driver = new FrameDriver();
        const first = toSubRows(driver, driver.step(observation(bubbles()))!);
        h.snapshot(first.slice(0, -1));
        expect(h.store.getReplica(KEY).available).toBe(false);
        h.delta(first.slice(-1));
        const read = h.store.getReplica(KEY);
        if (!read.available) throw new Error('expected a view');
        expect(read.view.schemaVersion).toBe(2);
        expect(read.view.messages.map((m) => m.content)).toEqual(['b0', 'b1', 'b2']);
        expect(read.identity).toMatchObject({ sessionId: SESSION, producerDaemonId: DAEMON, epoch: 'epoch-a', frame: 1 });

        h.delta(toSubRows(driver, driver.step(observation(bubbles('!')))!));
        const next = h.store.getReplica(KEY);
        expect(next.available && next.view.messages.map((m) => m.content)).toEqual(['b0!', 'b1!', 'b2!']);
    });

    it('a commit from another owner never becomes visible', () => {
        const h = harness();
        h.store.ensureSubscription({ ownerDaemonId: 'daemon_mach_other', rawSessionId: SESSION }, h.peer);
        const driver = new FrameDriver();
        h.snapshot(toSubRows(driver, driver.step(observation(bubbles()))!));
        expect(h.store.getReplica({ ownerDaemonId: 'daemon_mach_other', rawSessionId: SESSION }).available).toBe(false);
    });

    it('a digest mismatch keeps the last good view, resubscribes, and after repeated failures asks the owner for a base frame', async () => {
        const requestBase = vi.fn();
        const h = harness({ requestBase });
        h.store.ensureSubscription(KEY, h.peer);
        const driver = new FrameDriver();
        h.snapshot(toSubRows(driver, driver.step(observation(bubbles()))!));
        const bad = () => {
            const rows = toSubRows(driver, driver.step(observation(bubbles(`#${Math.random()}`)))!);
            const commit = rows.at(-1)!;
            commit.payload = JSON.stringify({ ...JSON.parse(commit.payload as string), digest: '0'.repeat(64) });
            return rows;
        };
        for (let i = 0; i < TRANSCRIPT_REPLICA_BASE_REQUEST_AFTER; i += 1) {
            h.delta(bad());
            const read = h.store.getReplica(KEY);
            expect(read.available && read.view.messages[0]!.content).toBe('b0');
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(h.subscribeCalls.length).toBeGreaterThanOrEqual(2);
        expect(h.store.getCounters()).toMatchObject({ digestMismatches: TRANSCRIPT_REPLICA_BASE_REQUEST_AFTER, baseRequests: 1 });
        expect(requestBase).toHaveBeenCalledWith(KEY);
    });

    it('detach and stop close the SUB', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        h.store.detachSubscription(KEY);
        expect(h.closeCount).toBe(1);
        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_subscription' });
        h.store.ensureSubscription(KEY, h.peer);
        h.store.stop();
        expect(h.closeCount).toBe(2);
        expect(h.store.ensureSubscription(KEY, h.peer)).toEqual({ ok: false, reason: 'subscribe_failed' });
    });

    // Live 2026-10-09 (1.0.79-rc.2): the owner daemon restarted while a worker
    // session was generating. The mesh peer detached and a NEW seqscribe
    // PeerHandle attached ~100 s later, but `ensureSubscription` answered
    // `alreadySubscribed` for the key bound to the DEAD handle — the SUB was
    // never re-attached, so the coordinator's `read_chat` kept serving the
    // pre-restart "generating" view forever while the worker had long finished.
    it('★ re-attaches the SUB when the peer handle for a key changes (owner restart / redial)', () => {
        const h = harness();
        let firstState: 'ready' | 'closed' = 'ready';
        const first = { peerId: 'daemon_mach_test', state: () => firstState, onStateChange: () => () => {}, detach: () => {} } as unknown as PeerHandle;
        expect(h.store.ensureSubscription(KEY, first)).toEqual({ ok: true, alreadySubscribed: false });
        const before = new FrameDriver();
        h.snapshot(toSubRows(before, before.step(observation(bubbles()))!));
        const live = h.store.getReplica(KEY);
        expect(live.available && live.view.messages.map((m) => m.content)).toEqual(['b0', 'b1', 'b2']);
        expect(live.available && live.stale).toBeUndefined();

        // Owner restart: the old handle closes. The view is still served, but
        // flagged — it can no longer advance on this SUB.
        firstState = 'closed';
        const frozen = h.store.getReplica(KEY);
        expect(frozen.available && frozen.stale).toBe(true);

        // The old transport is gone; the router now hands out a different handle.
        const replacement = { peerId: 'daemon_mach_test', state: () => 'ready' as const, onStateChange: () => () => {}, detach: () => {} } as unknown as PeerHandle;
        expect(h.store.ensureSubscription(KEY, replacement)).toEqual({ ok: true, alreadySubscribed: false });
        expect(h.subscribeCalls).toHaveLength(2);
        expect(h.closeCount).toBe(1);
        // The last verified view keeps serving until the new SNAP verifies.
        const bridging = h.store.getReplica(KEY);
        expect(bridging.available && bridging.view.messages.map((m) => m.content)).toEqual(['b0', 'b1', 'b2']);

        // The restarted producer publishes under a fresh epoch; the new SUB's
        // reset SNAP carries it and the view moves on.
        const after = new FrameDriver(undefined, 'epoch-b');
        const grown = [...bubbles(), { id: 'd.r.4', ord: ordOf(3), text: 'final reply' }];
        h.snapshot(toSubRows(after, after.step(observation(grown))!));
        const read = h.store.getReplica(KEY);
        expect(read.available && read.view.messages.map((m) => m.content)).toEqual(['b0', 'b1', 'b2', 'final reply']);
        expect(read.available && read.identity.epoch).toBe('epoch-b');
        expect(read.available && read.stale).toBeUndefined();
        expect(h.store.getCounters()).toMatchObject({ peerRebinds: 1 });

        // Same handle again → still idempotent.
        expect(h.store.ensureSubscription(KEY, replacement)).toEqual({ ok: true, alreadySubscribed: true });
        expect(h.subscribeCalls).toHaveLength(2);
    });
});
