import { describe, expect, it } from 'vitest';
import { onTopicActivated } from '../../src/seqscribe/mesh-dual-write.js';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import {
    __resetTranscriptActivationCacheForTests,
    ensureSessionTranscriptTopic,
    releaseSessionTranscriptTopic,
} from '../../src/seqscribe/transcript-activation.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';

/**
 * §8 unit 3 — "dynamic transcript activation + daemon replica store".
 *
 * Design §3.1: both ends define the topic on demand, push it into
 * `handle.topics`, then announce it through the SAME P14/P15 mechanism the
 * mesh events/handoff topics use (mesh-dual-write.ts). This file pins that
 * this module reuses that exact registry (a listener attached via
 * `onTopicActivated` fires for a TRANSCRIPT topic activation, not just a mesh
 * one) rather than reimplementing a parallel one, and pins the fail-closed
 * claim + authority/define-failure paths design §3.5/§7.2 require.
 */

function fakeNode(overrides: Partial<{ authorityEnabled: boolean; defineTopic: (topic: string, policy: unknown) => void }> = {}): SeqscribeNodeHandle {
    // `handle.node.defineTopic` is the seqscribe LIBRARY call — it does not
    // touch `handle.topics`, which is daemon-core's own bookkeeping array
    // that `ensureSessionTranscriptTopic` pushes to explicitly (mirroring
    // mesh-dual-write.ts#ensureTopic). Keeping these separate here matches
    // the real SeqscribeNodeHandle shape (node.ts) and catches a fixture bug
    // that would otherwise double-count topics.
    const node = {
        defineTopic: overrides.defineTopic ?? (() => {}),
    };
    return {
        node: node as unknown as SeqscribeNodeHandle['node'],
        writerId: 'adhdev-writer-1',
        daemonId: 'daemon_mach_owner',
        dbPath: ':memory:',
        topics: [] as unknown as SeqscribeNodeHandle['topics'],
        authorityEnabled: overrides.authorityEnabled ?? true,
        finalityLoop: null,
        onClose: () => {},
        close: async () => {},
    };
}

describe('ensureSessionTranscriptTopic — define + claim + announce (design §3.1/§3.5)', () => {
    it('defines the topic with the exact session-transcript policy and announces activation', () => {
        const node = fakeNode();
        const claims = new TranscriptTopicClaimRegistry();
        const announced: string[] = [];
        const unsub = onTopicActivated(node, (topic) => announced.push(topic));

        const result = ensureSessionTranscriptTopic(node, claims, 'A:B', 'daemon_mach_owner');

        expect(result).toEqual({ ok: true, topic: 'session.a_b.transcript' });
        expect(node.topics).toEqual([{ topic: 'session.a_b.transcript', policy: sessionTranscriptPolicy() }]);
        expect(announced).toEqual(['session.a_b.transcript']);
        unsub();
    });

    it('is idempotent: a second call for the SAME session does not redefine or re-announce', () => {
        const node = fakeNode();
        const claims = new TranscriptTopicClaimRegistry();
        const announced: string[] = [];
        onTopicActivated(node, (topic) => announced.push(topic));

        ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');
        const second = ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');

        expect(second).toEqual({ ok: true, topic: sessionTranscriptTopic('sess-1') });
        expect(node.topics).toHaveLength(1);
        expect(announced).toEqual([sessionTranscriptTopic('sess-1')]);
    });

    it('fail-closed: a colliding raw session id is rejected and the topic is not redefined', () => {
        const node = fakeNode();
        const claims = new TranscriptTopicClaimRegistry();

        const first = ensureSessionTranscriptTopic(node, claims, 'A:B', 'daemon_mach_owner');
        expect(first.ok).toBe(true);

        // 'a.b' sanitizes to the same topic segment as 'A:B' (design §3.5 fixture).
        const second = ensureSessionTranscriptTopic(node, claims, 'a.b', 'daemon_mach_owner');
        expect(second).toEqual({
            ok: false,
            reason: 'raw_session_id_conflict',
            existing: { topic: 'session.a_b.transcript', rawSessionId: 'A:B', ownerDaemonId: 'daemon_mach_owner' },
        });
        expect(node.topics).toHaveLength(1);
    });

    it('authority_unavailable when the node has no fleet secret — not cached as a permanent failure', () => {
        const node = fakeNode({ authorityEnabled: false });
        const claims = new TranscriptTopicClaimRegistry();

        const attempt1 = ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');
        expect(attempt1).toEqual({ ok: false, reason: 'authority_unavailable' });

        // Simulate a later auth_ok delivery enabling authority — the SAME node
        // handle can now succeed without needing a cache reset, because
        // `authority_unavailable` must never be latched permanently.
        (node as { authorityEnabled: boolean }).authorityEnabled = true;
        const attempt2 = ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');
        expect(attempt2).toEqual({ ok: true, topic: sessionTranscriptTopic('sess-1') });
    });

    it('define_failed is cached — a second attempt does not retry defineTopic', () => {
        let calls = 0;
        const node = fakeNode({
            defineTopic: () => {
                calls++;
                throw new Error('boom');
            },
        });
        const claims = new TranscriptTopicClaimRegistry();

        const attempt1 = ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');
        expect(attempt1).toEqual({ ok: false, reason: 'define_failed' });
        const attempt2 = ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');
        expect(attempt2).toEqual({ ok: false, reason: 'define_failed' });
        expect(calls).toBe(1);
    });

    it('adopts an already-defined topic (e.g. from a prior activation on the same handle) without redefining', () => {
        const node = fakeNode();
        node.topics.push({ topic: sessionTranscriptTopic('sess-1'), policy: sessionTranscriptPolicy() });
        let defineCalls = 0;
        (node.node as unknown as { defineTopic: () => void }).defineTopic = () => { defineCalls++; };
        const claims = new TranscriptTopicClaimRegistry();

        const result = ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner');
        expect(result).toEqual({ ok: true, topic: sessionTranscriptTopic('sess-1') });
        expect(defineCalls).toBe(0);
    });

    it('releaseSessionTranscriptTopic lifts the claim so a colliding raw id can claim the topic afterward', () => {
        const node = fakeNode();
        const claims = new TranscriptTopicClaimRegistry();

        expect(ensureSessionTranscriptTopic(node, claims, 'A:B', 'daemon_mach_owner').ok).toBe(true);
        releaseSessionTranscriptTopic(claims, 'A:B');

        const result = ensureSessionTranscriptTopic(node, claims, 'a.b', 'daemon_mach_owner');
        expect(result.ok).toBe(true);
    });
});

describe('__resetTranscriptActivationCacheForTests', () => {
    it('clears the per-node definition cache, allowing a failed define to be retried', () => {
        let shouldFail = true;
        const node = fakeNode({
            defineTopic: () => {
                if (shouldFail) throw new Error('boom');
            },
        });
        const claims = new TranscriptTopicClaimRegistry();

        expect(ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner').ok).toBe(false);
        shouldFail = false;
        __resetTranscriptActivationCacheForTests(node);
        expect(ensureSessionTranscriptTopic(node, claims, 'sess-1', 'daemon_mach_owner').ok).toBe(true);
    });
});
