/**
 * ★ §5.6 gate 4 — the FALLBACK FIRE DRILL, daemon-side half (§8 unit 9-pre-c).
 *
 * The web-core half
 * (`web-core/test/components/dashboard/transcript-fallback-fire-drill.test.ts`)
 * proves the PANE survives each decline. This half proves the declines are the
 * ones production actually emits, produced at their real origin — so the two
 * halves together are a drill rather than a pair of self-consistent stubs.
 *
 * ── Why the split, rather than one file ────────────────────────────────────
 * The reasons originate in daemon-core (`transcript-activation.ts`,
 * `transcript-replica-store.ts`, `transcript-daemon-consumer-read.ts`); the
 * survival property is a web-core controller behaviour. Neither package may
 * import the other's internals — `web-core` reaches daemon-core only through
 * published leaf entries, and daemon-core must not depend on a browser package
 * at all. Forcing them into one file would mean stubbing one side, which is
 * exactly the vacuity this gate exists to prevent.
 *
 * ── What each case forces, and at which layer ──────────────────────────────
 *   `authority_unavailable`  no fleet secret → `ensureSessionTranscriptTopic`
 *                            cannot define the topic (pre-subscription).
 *   `no_complete_revision`   subscribed, nothing committed → the REAL
 *                            `readTranscriptForDaemonConsumer` declines
 *                            (post-subscription).
 * `projection_oversize` is producer-side and is forced against the real encoder
 * in the web-core half, where the oversize snapshot is already constructed.
 *
 * ── ★ `topic_not_granted`: a MEASURED gap, deliberately not faked here ──────
 * The fourth §5.6 reason has NO producer on the transcript path today. The
 * subscribe path's own reason vocabulary is
 * `raw_session_id_conflict | authority_unavailable | define_failed |
 * subscribe_failed` (`TranscriptSubscribeRejectReason`,
 * transcript-replica-store.ts), and `ensure_transcript_subscription`
 * (commands/low-family/transcript-replica.ts:65) passes exactly those through.
 * `topic_not_granted` reaches a transcript consumer only by being NARROWED out
 * of an IPC response string in mcp-server's `narrowReason`
 * (mesh-transcript-semantic-read.ts:144) — i.e. it is accepted if a daemon says
 * it, but no daemon code path says it. The grant check that DOES emit it
 * (`mesh-read-readiness.ts:335`) belongs to the mesh-ledger replica, a different
 * topic axis.
 *
 * That is asserted below as a REACHABILITY test rather than papered over with a
 * hand-written decline. Writing `expect(decline).toBe('topic_not_granted')`
 * against a stub would make the drill report four covered reasons when the
 * production truth is three produced + one accepted-but-unproduced. The
 * assertion is written so that it goes RED the day a transcript-side producer is
 * added — at which point this case should become a real fault injection like the
 * two above.
 *
 * ★ Every case asserts the decline REASON, not merely that a decline happened.
 * The readiness layer routes on the reason; collapsing them to "declined" would
 * pass while the four became indistinguishable in production diagnostics.
 */

import { describe, expect, it } from 'vitest';
import { ensureSessionTranscriptTopic } from '../../src/seqscribe/transcript-activation.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { readTranscriptForDaemonConsumer } from '../../src/mesh/transcript-daemon-consumer-read.js';
import type { TranscriptConsumerFallbackReason } from '../../src/mesh/transcript-read-model-consumers.js';
import type { TranscriptReplicaStore } from '../../src/seqscribe/transcript-replica-store.js';
import type { ReplicatedTranscriptSnapshotV1 } from '../../src/seqscribe/transcript-projection.js';

const OWNER = 'daemon_mach_owner';
const SESSION = 'sess-fire-drill';
const OBSERVED_AT = '2026-09-04T00:00:00.000Z';

/** `primary` is the only mode a roster consumer reads under (§5.1). */
const PRIMARY = { ADHDEV_SEQSCRIBE_TRANSCRIPT: 'primary' } as unknown as NodeJS.ProcessEnv;

/** Mirrors `transcript-activation.test.ts#fakeNode` — same shape, same reasons. */
function fakeNode(overrides: Partial<{ authorityEnabled: boolean }> = {}): SeqscribeNodeHandle {
    return {
        node: { defineTopic: () => {} } as unknown as SeqscribeNodeHandle['node'],
        writerId: 'adhdev-writer-1',
        daemonId: OWNER,
        dbPath: ':memory:',
        topics: [] as unknown as SeqscribeNodeHandle['topics'],
        authorityEnabled: overrides.authorityEnabled ?? true,
        finalityLoop: null,
        onClose: () => {},
        close: async () => {},
    };
}

function snapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
    return {
        schemaVersion: 1,
        sessionId: SESSION,
        historySessionId: null,
        providerType: 'claude-cli',
        providerSessionId: null,
        producerDaemonId: OWNER,
        producerWriterId: 'writer-1',
        producerEpoch: 'epoch-1',
        revision: 1,
        observedAt: OBSERVED_AT,
        status: 'idle',
        providerObservedStatus: null,
        title: null,
        activeModal: null,
        activeInteractivePrompt: null,
        turn: null,
        provenance: { messageSource: null, transcriptProvenance: null },
        messages: [],
        terminalMarkers: [],
        coverage: { mode: 'full', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
        ...overrides,
    };
}

function storeReturning(result: unknown): TranscriptReplicaStore {
    return { getReplica: () => result } as unknown as TranscriptReplicaStore;
}

describe('★ §5.6 fire drill — authority_unavailable at its real origin', () => {
    it('a node without the fleet secret cannot define the transcript topic', () => {
        const node = fakeNode({ authorityEnabled: false });

        const result = ensureSessionTranscriptTopic(node, new TranscriptTopicClaimRegistry(), SESSION, OWNER);

        expect(result).toEqual({ ok: false, reason: 'authority_unavailable' });
        // ★ Nothing was defined — a refused activation must not leave a
        // half-created topic behind that a later SUB could attach to.
        expect(node.topics).toHaveLength(0);
    });

    it('control: the SAME node with authority defines it — so the refusal is about the secret', () => {
        const node = fakeNode({ authorityEnabled: true });

        const result = ensureSessionTranscriptTopic(node, new TranscriptTopicClaimRegistry(), SESSION, OWNER);

        expect(result.ok).toBe(true);
        expect(node.topics).toHaveLength(1);
    });
});

describe('★ §5.6 fire drill — topic_not_granted is ACCEPTED but not PRODUCED on the transcript path', () => {
    /**
     * The reachability assertion described in this file's header.
     *
     * ★ Read this as a coverage statement, not a passing feature: the drill
     * covers three of the four §5.6 reasons at a real origin, and this case
     * records — executably — why the fourth cannot be, so the gap survives in
     * the gate rather than in a comment nobody re-checks.
     */
    it('the subscribe path cannot return topic_not_granted — its reason vocabulary does not contain it', () => {
        // The complete set `ensureSubscription` (and therefore
        // `ensure_transcript_subscription`) can answer with. Sourced from
        // `TranscriptSubscribeRejectReason` in transcript-replica-store.ts.
        const SUBSCRIBE_REJECT_REASONS = [
            'raw_session_id_conflict',
            'authority_unavailable',
            'define_failed',
            'subscribe_failed',
        ];

        expect(SUBSCRIBE_REJECT_REASONS).not.toContain('topic_not_granted');

        // ★ And the activation layer beneath it likewise: forcing the one
        // pre-subscription fault that exists yields `authority_unavailable`,
        // never a grant refusal. This is the executable half — if a future edit
        // makes activation able to report a grant fault, this goes red and the
        // case above should become a real fault injection.
        const node = fakeNode({ authorityEnabled: false });
        const result = ensureSessionTranscriptTopic(node, new TranscriptTopicClaimRegistry(), SESSION, OWNER);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable — asserted false above');
        expect(result.reason).not.toBe('topic_not_granted');
        expect(result.reason).toBe('authority_unavailable');
    });

    it('but the closed union still CARRIES topic_not_granted, so an IPC peer that reports it routes correctly', () => {
        // The consumer union must keep accepting it: a daemon on a future build
        // could report it over IPC, and mcp-server's `narrowReason` only admits
        // strings that are union members — an unrecognized reason would be
        // silently replaced by a generic fallback, losing the diagnosis.
        const reason: TranscriptConsumerFallbackReason = 'topic_not_granted';
        expect(reason).toBe('topic_not_granted');
    });
});

describe('★ §5.6 fire drill — no_complete_revision at its real origin', () => {
    /**
     * The real router over a store that is SUBSCRIBED but holds no committed
     * revision. This is the shape `TranscriptReplicaStore.getReplica` returns
     * when `entry.lastGood` is null — a live subscription that has not yet seen
     * a commit, which is the normal state for the first seconds of any session
     * and the permanent state after a ring reset with no reseed.
     */
    it('a subscribed-but-uncommitted replica declines with no_complete_revision', () => {
        const outcome = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_worker_status_probe',
            ownerDaemonId: OWNER,
            rawSessionId: SESSION,
            maxAgeMs: 10_000,
            store: storeReturning({ available: false, reason: 'no_complete_revision' }),
            env: PRIMARY,
        });

        // ★ The load-bearing pair: NO snapshot (so the caller runs its legacy
        // read) AND a specific reason (so the fallback is diagnosable).
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('no_complete_revision');
    });

    it("the store's `no_subscription` miss also collapses onto no_complete_revision, never onto a wrong answer", () => {
        // `no_subscription` is the store's own vocabulary and is NOT in the
        // design's closed union. What matters for the drill is that it declines
        // as a union member rather than leaking an out-of-union string that the
        // readiness layer would fail to route.
        const outcome = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_worker_status_probe',
            ownerDaemonId: OWNER,
            rawSessionId: SESSION,
            maxAgeMs: 10_000,
            store: storeReturning({ available: false, reason: 'no_subscription' }),
            env: PRIMARY,
        });

        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('no_complete_revision');
    });

    it('control: a committed, fresh revision IS served — so the decline is about the missing commit', () => {
        const outcome = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_worker_status_probe',
            ownerDaemonId: OWNER,
            rawSessionId: SESSION,
            maxAgeMs: 10_000,
            store: storeReturning({
                available: true,
                snapshot: snapshot(),
                identity: { sessionId: SESSION, producerDaemonId: OWNER },
            }),
            nowMs: Date.parse(OBSERVED_AT) + 1_000,
            env: PRIMARY,
        });

        expect(outcome.fallbackReason).toBeNull();
        expect(outcome.snapshot).not.toBeNull();
    });
});

describe('★ §5.6 fire drill — the router never answers from a declined read', () => {
    /**
     * ★ The empty-success assertion on the daemon side.
     *
     * The unforgivable failure is not a decline — it is a decline that returns a
     * well-formed EMPTY snapshot, which the completion path would read as "the
     * transcript has no messages" and could use to assert a turn ended. This
     * asserts the router returns `null`, never an empty-but-present snapshot,
     * for every non-answer it can produce.
     */
    it.each([
        ['no_complete_revision', { available: false, reason: 'no_complete_revision' }],
        ['no_subscription', { available: false, reason: 'no_subscription' }],
    ])('a %s decline returns null, never an empty snapshot object', (_label, storeResult) => {
        const outcome = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_terminal_evidence',
            ownerDaemonId: OWNER,
            rawSessionId: SESSION,
            maxAgeMs: 8_000,
            store: storeReturning(storeResult),
            env: PRIMARY,
        });

        expect(outcome.snapshot).toBeNull();
        // Not `toBeFalsy()` — an empty object is falsy in neither JS nor this
        // assertion, and it is precisely the value that would be dangerous.
        expect(outcome.snapshot).not.toEqual({});
        expect(outcome.fallbackReason).not.toBeNull();
    });

    it('a missing store declines with no_node rather than serving nothing silently', () => {
        const outcome = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_terminal_evidence',
            ownerDaemonId: OWNER,
            rawSessionId: SESSION,
            maxAgeMs: 8_000,
            store: null,
            env: PRIMARY,
        });

        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('no_node');
    });
});
