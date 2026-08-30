import { describe, expect, it } from 'vitest';
import {
    ADHDEV_AUTHORITY_ID,
    safeSessionId,
    sessionTranscriptPolicy,
    sessionTranscriptTopic,
    SESSION_TRANSCRIPT_RING,
} from '../../src/transcript-transport/topic-addressing.js';

// Known-answer vectors mirrored from `oss/packages/daemon-core/src/seqscribe/
// topics.ts#safeSessionId`'s own sanitizer regex
// (`/[^a-z0-9_-]+/g` + lowercase + trim underscores + slice(0, 64)). If
// daemon-core's sanitizer changes, THIS list must change in the same commit
// (see topic-addressing.ts's header) — that is what keeps the duplicate honest.
describe('topic-addressing (browser mirror of daemon-core topics.ts)', () => {
    it('passes an already charter-safe id through unchanged', () => {
        expect(safeSessionId('daemon_abc123')).toBe('daemon_abc123');
    });

    it('lowercases and replaces charter-unsafe characters', () => {
        expect(safeSessionId('A:B')).toBe('a_b');
        expect(safeSessionId('a.b')).toBe('a_b');
        expect(safeSessionId('ide:cursor-1')).toBe('ide_cursor-1');
    });

    it('collapses a run of unsafe characters into one underscore', () => {
        expect(safeSessionId('a::b')).toBe('a_b');
    });

    it('trims leading/trailing underscores produced by sanitization', () => {
        expect(safeSessionId(':leading')).toBe('leading');
        expect(safeSessionId('trailing:')).toBe('trailing');
    });

    it('truncates to 64 characters', () => {
        const long = 'x'.repeat(100);
        const result = safeSessionId(long);
        expect(result.length).toBe(64);
        expect(result).toBe('x'.repeat(64));
    });

    it('falls back to unknown_session for an empty/all-unsafe id', () => {
        expect(safeSessionId('')).toBe('unknown_session');
        expect(safeSessionId(':::')).toBe('unknown_session');
    });

    it('is NOT injective — a documented, expected collision (design §3.5)', () => {
        // Two distinct raw ids that sanitize to the same segment. The daemon-side
        // two-end raw-id claim (transcript-topic-claim.ts), not this function, is
        // what defends against this — see this file's header.
        expect(safeSessionId('A:B')).toBe(safeSessionId('a.b'));
    });

    it('builds the exact session.<safeSessionId>.transcript topic name', () => {
        expect(sessionTranscriptTopic('daemon_abc123')).toBe('session.daemon_abc123.transcript');
        expect(sessionTranscriptTopic('A:B')).toBe('session.a_b.transcript');
    });

    it('builds a policy matching topics.ts#sessionTranscriptPolicy exactly', () => {
        expect(sessionTranscriptPolicy()).toEqual({
            kind: 'append',
            retention: { mode: 'ring', size: SESSION_TRANSCRIPT_RING },
            replication: 'subscribe-only',
            access: 'content',
            finalityAuthority: ADHDEV_AUTHORITY_ID,
        });
    });

    it('pins the fleet-wide authority id and ring size constants', () => {
        expect(ADHDEV_AUTHORITY_ID).toBe('adhdev-coordinator');
        expect(SESSION_TRANSCRIPT_RING).toBe(500);
    });
});
