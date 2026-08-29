import { describe, expect, it } from 'vitest';
import { ADHDEV_AUTHORITY_ID } from '../../src/seqscribe/authority.js';
import { safeSessionId, sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import {
    TranscriptTopicClaimRegistry,
    type TranscriptTopicClaim,
} from '../../src/seqscribe/transcript-topic-claim.js';

/**
 * §8 unit 1 — "transcript topic identity + projection contract".
 *
 * `safeSessionId` (topics.ts) and `sessionTranscriptTopic`/`sessionTranscriptPolicy`
 * already existed before this unit (Phase 0 topic table). What this unit adds
 * is the fail-closed collision defense design §3.5 requires around them: a
 * known-answer/collision fixture proving the sanitizer really does collapse
 * distinct raw ids, and a claim registry that turns that collision into a
 * fail-closed rejection instead of silent content mixing.
 */
describe('safeSessionId — known answer + collision (design §3.5)', () => {
    it('known answer: charter-safe ids pass through unchanged', () => {
        expect(safeSessionId('abc-123_session')).toBe('abc-123_session');
    });

    it('known answer: uppercase and `:`/`.` separators are folded to `_`', () => {
        expect(safeSessionId('IDE:Cursor.1')).toBe('ide_cursor_1');
    });

    it('collision: distinct raw ids collapse onto the same topic segment', () => {
        // This is NOT a regression to fix — design §3.5 documents it as a known,
        // accepted property of the unchanged sanitizer (owner decision §9.1: no
        // SHA-256 suffix). The fixture exists so the claim-registry test below
        // has a real collision to defend against, not a hypothetical one.
        const collidingRawIds = ['A:B', 'a.b', 'a_b'];
        const segments = collidingRawIds.map(safeSessionId);
        expect(new Set(segments).size).toBe(1);
        expect(segments[0]).toBe('a_b');
    });

    it('sessionTranscriptTopic interpolates the sanitized segment', () => {
        expect(sessionTranscriptTopic('A:B')).toBe('session.a_b.transcript');
        expect(sessionTranscriptTopic('a.b')).toBe('session.a_b.transcript');
    });

    it('sessionTranscriptPolicy is ring(500)/subscribe-only/content/adhdev-coordinator', () => {
        const policy = sessionTranscriptPolicy();
        expect(policy).toEqual({
            kind: 'append',
            retention: { mode: 'ring', size: 500 },
            replication: 'subscribe-only',
            access: 'content',
            finalityAuthority: ADHDEV_AUTHORITY_ID,
        });
    });
});

describe('TranscriptTopicClaimRegistry — fail-closed on raw id collision (design §3.5)', () => {
    function claimOf(rawSessionId: string, ownerDaemonId = 'daemon-a'): TranscriptTopicClaim {
        return { topic: sessionTranscriptTopic(rawSessionId), rawSessionId, ownerDaemonId };
    }

    it('claims a fresh topic', () => {
        const registry = new TranscriptTopicClaimRegistry();
        const result = registry.claim(claimOf('A:B'));
        expect(result).toEqual({ ok: true });
        expect(registry.get('session.a_b.transcript')).toEqual({
            topic: 'session.a_b.transcript',
            rawSessionId: 'A:B',
            ownerDaemonId: 'daemon-a',
        });
    });

    it('re-claiming with the SAME raw session id is idempotent (owner handoff)', () => {
        const registry = new TranscriptTopicClaimRegistry();
        expect(registry.claim(claimOf('A:B', 'daemon-a'))).toEqual({ ok: true });
        // Same raw id, new owner — the normal owner-move path (design §3.4).
        expect(registry.claim(claimOf('A:B', 'daemon-c'))).toEqual({ ok: true });
        expect(registry.get('session.a_b.transcript')?.ownerDaemonId).toBe('daemon-c');
    });

    it('fail-closed: a colliding DIFFERENT raw session id is rejected, not silently swapped', () => {
        const registry = new TranscriptTopicClaimRegistry();
        const first = claimOf('A:B'); // sanitizes to session.a_b.transcript
        const second = claimOf('a.b'); // same topic, different raw id — the collision

        expect(registry.claim(first)).toEqual({ ok: true });

        const result = registry.claim(second);
        expect(result).toEqual({
            ok: false,
            reason: 'raw_session_id_conflict',
            existing: first,
        });

        // The original claim must be untouched — the second (rejected) caller's
        // identity must never overwrite it.
        expect(registry.get('session.a_b.transcript')).toEqual(first);
    });

    it('release() frees a topic so a later distinct raw id may claim it', () => {
        const registry = new TranscriptTopicClaimRegistry();
        const topic = sessionTranscriptTopic('A:B');
        registry.claim(claimOf('A:B'));
        registry.release(topic);
        expect(registry.get(topic)).toBeUndefined();
        expect(registry.claim(claimOf('a.b'))).toEqual({ ok: true });
    });
});
