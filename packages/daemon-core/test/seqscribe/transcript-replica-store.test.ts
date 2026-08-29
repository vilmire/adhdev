import { describe, expect, it } from 'vitest';
import type { PeerHandle, Row } from 'seqscribe';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import {
    TRANSCRIPT_REPLICA_SUB_VIEW,
    TranscriptReplicaStore,
} from '../../src/seqscribe/transcript-replica-store.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';

/**
 * §8 unit 3 — subscriber-side `TranscriptReplicaStore` (design §3.7).
 *
 * Same fake-node harness shape `fleet-status-peer-view.test.ts` uses:
 * `node.node.subscribe` is mocked to hand back a controllable
 * onSnapshot/onDelta pair, so the test drives SUB rows directly instead of
 * standing up a real two-node seqscribe transport (this level of test is the
 * daemon-core fast suite's job; the real cross-process fixtures live in
 * `test:seqscribe-asymmetric`, design §6.3).
 */

const IDENTITY: TranscriptRevisionIdentity = {
    sessionId: 'sess-raw-1',
    producerDaemonId: 'daemon_mach_owner',
    producerWriterId: 'adhdev-writer-owner',
    producerEpoch: 'epoch-1',
    revision: 1,
};

function candidate(overrides: Partial<TranscriptSnapshotCandidate> = {}): TranscriptSnapshotCandidate {
    return {
        sessionId: IDENTITY.sessionId,
        providerType: 'claude-code',
        producerDaemonId: IDENTITY.producerDaemonId,
        producerWriterId: IDENTITY.producerWriterId,
        producerEpoch: IDENTITY.producerEpoch,
        revision: IDENTITY.revision,
        observedAt: '2026-08-29T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content: 'hi' }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
        ...overrides,
    };
}

/** Encode a valid revision and return it as SUB `Row[]` (payload JSON-stringified, per Row's wire shape). */
function subRowsFor(identity: TranscriptRevisionIdentity, snapshotCandidate: TranscriptSnapshotCandidate): Row[] {
    const snapshot = encodeTranscriptSnapshot(snapshotCandidate);
    const encoded = encodeTranscriptRevision(snapshot, identity);
    if (!encoded.ok) throw new Error('fixture encode failed');
    const rows: Row[] = [
        { key: `${identity.producerWriterId}:1`, writer: identity.producerWriterId, seq: 1, kind: TRANSCRIPT_REVISION_BEGIN_KIND, payload: JSON.stringify(encoded.begin) },
    ];
    encoded.chunks.forEach((chunk, i) => {
        rows.push({ key: `${identity.producerWriterId}:${2 + i}`, writer: identity.producerWriterId, seq: 2 + i, kind: TRANSCRIPT_REVISION_CHUNK_KIND, payload: JSON.stringify(chunk) });
    });
    rows.push({
        key: `${identity.producerWriterId}:${2 + encoded.chunks.length}`,
        writer: identity.producerWriterId,
        seq: 2 + encoded.chunks.length,
        kind: TRANSCRIPT_REVISION_COMMIT_KIND,
        payload: JSON.stringify(encoded.commit),
    });
    return rows;
}

type SnapshotCb = (rows: Row[]) => void;
type DeltaCb = (changes: { upserts: Row[]; deletes: string[] }) => void;

function harness() {
    let snapshotCb: SnapshotCb | null = null;
    let deltaCb: DeltaCb | null = null;
    let closeCount = 0;
    const subscribeCalls: Array<{ peer: PeerHandle; options: unknown }> = [];
    const definedTopics: string[] = [];
    const node = {
        defineTopic(topic: string) { definedTopics.push(topic); },
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
    const handle: SeqscribeNodeHandle = {
        node: node as unknown as SeqscribeNodeHandle['node'],
        writerId: 'adhdev-writer-subscriber',
        daemonId: 'daemon_mach_subscriber',
        dbPath: ':memory:',
        topics: [] as unknown as SeqscribeNodeHandle['topics'],
        authorityEnabled: true,
        finalityLoop: null,
        onClose: () => {},
        close: async () => {},
    };
    const peer: PeerHandle = {
        peerId: 'daemon_mach_owner',
        state: () => 'ready' as const,
        onStateChange: () => () => {},
        detach: () => {},
    };
    const claims = new TranscriptTopicClaimRegistry();
    const store = new TranscriptReplicaStore(handle, claims);
    return {
        store,
        peer,
        claims,
        subscribeCalls,
        definedTopics,
        get closeCount() { return closeCount; },
        snapshot(rows: Row[]) { snapshotCb?.(rows); },
        delta(rows: Row[]) { deltaCb?.({ upserts: rows, deletes: [] }); },
    };
}

const KEY = { ownerDaemonId: IDENTITY.producerDaemonId, rawSessionId: IDENTITY.sessionId };

describe('TranscriptReplicaStore.ensureSubscription — SUB is the only ring read path', () => {
    it('defines the topic locally and attaches the built-in tail SUB', () => {
        const h = harness();
        const result = h.store.ensureSubscription(KEY, h.peer);
        expect(result).toEqual({ ok: true, alreadySubscribed: false });
        expect(h.definedTopics).toEqual([sessionTranscriptTopic(IDENTITY.sessionId)]);
        expect(h.subscribeCalls).toHaveLength(1);
        expect(h.subscribeCalls[0]?.options).toEqual({
            view: TRANSCRIPT_REPLICA_SUB_VIEW,
            params: { topic: sessionTranscriptTopic(IDENTITY.sessionId) },
        });
    });

    it('is idempotent for the same key — a second call does not re-subscribe', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        const second = h.store.ensureSubscription(KEY, h.peer);
        expect(second).toEqual({ ok: true, alreadySubscribed: true });
        expect(h.subscribeCalls).toHaveLength(1);
    });

    it('fail-closed: a colliding raw session id is rejected before any subscribe attempt', () => {
        const h = harness();
        // 'A:B' and 'a.b' sanitize to the SAME topic segment (design §3.5
        // fixture, transcript-topic-identity.test.ts) — the collision this
        // test defends against.
        expect(h.store.ensureSubscription({ ownerDaemonId: KEY.ownerDaemonId, rawSessionId: 'A:B' }, h.peer).ok).toBe(true);
        const colliding = h.store.ensureSubscription({ ownerDaemonId: KEY.ownerDaemonId, rawSessionId: 'a.b' }, h.peer);
        expect(colliding.ok).toBe(false);
        if (!colliding.ok) expect(colliding.reason).toBe('raw_session_id_conflict');
        expect(h.subscribeCalls).toHaveLength(1);
    });
});

describe('TranscriptReplicaStore — assembles a complete revision from SUB rows', () => {
    it('a full snapshot delivered via onSnapshot becomes readable through getReplica', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        h.snapshot(subRowsFor(IDENTITY, candidate()));

        const read = h.store.getReplica(KEY);
        expect(read.available).toBe(true);
        if (read.available) {
            expect(read.snapshot.sessionId).toBe(IDENTITY.sessionId);
            expect(read.snapshot.messages).toHaveLength(1);
            expect(read.identity).toEqual(IDENTITY);
        }
    });

    it('a revision delivered piecemeal via onDelta assembles the same way', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        for (const row of subRowsFor(IDENTITY, candidate({ status: 'idle' }))) {
            h.delta([row]);
        }
        const read = h.store.getReplica(KEY);
        expect(read.available).toBe(true);
        if (read.available) expect(read.snapshot.status).toBe('idle');
    });

    it('no_subscription before ensureSubscription is called', () => {
        const h = harness();
        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_subscription' });
    });

    it('no_complete_revision when only a partial (begin, no commit) has arrived', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        const rows = subRowsFor(IDENTITY, candidate());
        h.snapshot(rows.slice(0, rows.length - 1)); // drop the commit row
        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_complete_revision' });
    });
});

describe('TranscriptReplicaStore — store-level owner/session re-check (design §3.5)', () => {
    it('discards a complete revision whose producerDaemonId does not match the subscribed owner', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        const wrongOwnerIdentity: TranscriptRevisionIdentity = { ...IDENTITY, producerDaemonId: 'daemon_mach_impostor' };
        h.snapshot(subRowsFor(wrongOwnerIdentity, candidate({ producerDaemonId: 'daemon_mach_impostor' })));

        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_complete_revision' });
        expect(h.store.diagnostics(KEY).lastRejectReason).toBe('owner_mismatch');
    });
});

describe('TranscriptReplicaStore.detachSubscription / stop', () => {
    it('detachSubscription closes the SUB and clears the replica', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        h.snapshot(subRowsFor(IDENTITY, candidate()));
        h.store.detachSubscription(KEY);

        expect(h.closeCount).toBe(1);
        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_subscription' });
    });

    it('stop closes every SUB and prevents further reads', () => {
        const h = harness();
        h.store.ensureSubscription(KEY, h.peer);
        h.snapshot(subRowsFor(IDENTITY, candidate()));
        h.store.stop();
        h.store.stop();

        expect(h.closeCount).toBe(1);
        expect(h.store.getReplica(KEY)).toEqual({ available: false, reason: 'no_subscription' });
        // Further ensureSubscription calls after stop() are refused, not resurrected.
        expect(h.store.ensureSubscription(KEY, h.peer)).toEqual({ ok: false, reason: 'subscribe_failed' });
    });
});
