import { describe, expect, it } from 'vitest';
import {
    canonicalizeTranscriptSnapshot,
    encodeTranscriptSnapshot,
    hashTranscriptSnapshot,
    type TranscriptSnapshotCandidate,
} from '../../src/seqscribe/transcript-projection.js';

/**
 * §8 unit 1 — `ReplicatedTranscriptSnapshotV1` closed allow-list encoder
 * (design §2.4). The behaviour under test is the allow-list property itself:
 * a candidate carrying content-boundary-violating fields (sourcePath,
 * workspace, secrets, arbitrary meta) must have NOTHING of them survive
 * encoding — not "these specific fields get deleted" (a deny-list), but "only
 * named fields are ever read" (an allow-list). The canary assertions below
 * fail RED without the encoder (there is no `undefined` result to compare
 * against a canary) and fail RED again if the encoder is ever rewritten as a
 * deny-list that misses a new upstream field, because the test greps the
 * canonical JSON string rather than the TypeScript type.
 */

const BASE_CANDIDATE: TranscriptSnapshotCandidate = {
    sessionId: 'sess-raw-1',
    providerType: 'claude-code',
    producerDaemonId: 'daemon-a',
    producerWriterId: 'adhdev-writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
    observedAt: '2026-08-29T00:00:00.000Z',
    status: 'generating',
    messages: [
        {
            role: 'assistant',
            kind: 'standard',
            content: 'hello world',
            receivedAt: 1000,
            bubbleState: 'final',
            meta: { streaming: false },
        },
    ],
    coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
};

describe('encodeTranscriptSnapshot — allow-list (design §2.4)', () => {
    it('drops fields not on the allow-list, at every level', () => {
        const CANARY = 'CONTENT_BOUNDARY_CANARY_SHOULD_NEVER_TRAVEL';
        const candidate: TranscriptSnapshotCandidate = {
            ...BASE_CANDIDATE,
            // top-level unlisted fields
            sourcePath: `/Users/x/${CANARY}/repo`,
            workspace: CANARY,
            apiKey: CANARY,
            debug: { raw: CANARY },
            messages: [
                {
                    role: 'assistant',
                    kind: 'standard',
                    content: 'hello world',
                    // unlisted message-level fields
                    exception: CANARY,
                    debugPayload: { trace: CANARY },
                    meta: { streaming: false, arbitraryExtra: CANARY },
                },
            ],
            provenance: {
                // (REPLICA-PROVENANCE-SCALAR-LOSS) The REAL shape. This fixture
                // used to pass the string 'assistant_text', which no producer
                // ever emits — `buildCliMessageSourceProvenance`
                // (commands/read-chat-source-decision.ts) returns an OBJECT.
                // That fiction is precisely why the production case, where the
                // object collapsed to null through `stringField`, was never
                // caught here. Keep this an object.
                messageSource: {
                    selected: 'native-history',
                    provider: 'claude-cli',
                    providerType: 'claude-cli',
                    identityStatus: 'safe',
                    ptyStatusApprovalOnly: true,
                    // Path/workspace keys live on the producer object and must
                    // NOT survive the projection.
                    sourcePath: CANARY,
                    sessionWorkspace: CANARY,
                    nativeHandle: CANARY,
                    staleness: { sourceMtimeMs: 1, sourceMtimeAgeMs: 2, freshEnough: true },
                    coverage: { nativeMessageCount: 1, ptyMessageCount: 0, returnedMessageCount: 1 },
                },
                transcriptProvenance: 'provider-native',
                sourcePath: CANARY,
                workspace: CANARY,
            },
        };

        const encoded = encodeTranscriptSnapshot(candidate);
        const json = canonicalizeTranscriptSnapshot(encoded);

        expect(json).not.toContain(CANARY);
        // Sanity: the allow-listed content this test DID intend to carry is present,
        // proving the canary's absence is the allow-list at work, not an empty output.
        expect(json).toContain('hello world');
        expect(json).toContain('provider-native');
        // The one scalar extracted from the producer's object survives...
        expect(encoded.provenance.messageSource).toBe('native-history');
        // ...as a STRING. Widening the wire type to carry the object would
        // violate §2.4 and smuggle sourcePath/workspace across the boundary.
        expect(typeof encoded.provenance.messageSource).toBe('string');
    });

    it('★ extracts messageSource.selected from the producer OBJECT, never null (REPLICA-PROVENANCE-SCALAR-LOSS)', () => {
        // Regression: `stringField` returned null for the object, wiping the one
        // field the consumer shrink-defense reads and wedging the chat pane
        // mid-generation. See transcript-projection.ts `messageSourceField`.
        const encoded = encodeTranscriptSnapshot({
            ...BASE_CANDIDATE,
            provenance: {
                messageSource: { selected: 'pty-parser', fallbackReason: 'native_history_not_checked' },
                transcriptProvenance: 'pty',
            },
        });
        expect(encoded.provenance.messageSource).toBe('pty-parser');
    });

    it('keeps the plain-string messageSource form working', () => {
        const encoded = encodeTranscriptSnapshot({
            ...BASE_CANDIDATE,
            provenance: { messageSource: 'native-history', transcriptProvenance: null },
        });
        expect(encoded.provenance.messageSource).toBe('native-history');
    });

    it('yields null for an object with no usable `selected`', () => {
        const encoded = encodeTranscriptSnapshot({
            ...BASE_CANDIDATE,
            provenance: { messageSource: { provider: 'claude-cli' }, transcriptProvenance: null },
        });
        expect(encoded.provenance.messageSource).toBeNull();
    });

    it('normalizes an absent/invalid enum to a safe default rather than passing it through', () => {
        const candidate: TranscriptSnapshotCandidate = {
            ...BASE_CANDIDATE,
            messages: [{ role: 'assistant', kind: 'standard', content: 'x', bubbleState: 'not-a-real-state' }],
            coverage: { mode: 'not-a-real-mode', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
        };
        const encoded = encodeTranscriptSnapshot(candidate);
        expect(encoded.messages[0]?.bubbleState).toBeNull();
        expect(encoded.coverage.mode).toBe('tail');
    });

    it('preserves message order and count', () => {
        const candidate: TranscriptSnapshotCandidate = {
            ...BASE_CANDIDATE,
            messages: [
                { role: 'user', kind: 'standard', content: 'first' },
                { role: 'assistant', kind: 'standard', content: 'second' },
            ],
        };
        const encoded = encodeTranscriptSnapshot(candidate);
        expect(encoded.messages.map((m) => m.content)).toEqual(['first', 'second']);
    });
});

/**
 * `sequence` on the wire — the ONE per-MESSAGE identity field.
 *
 * `turnKey` is turn-grained and so cannot distinguish bubbles within a turn;
 * `providerUnitKey` is deliberately withheld because it embeds a content hash.
 * `sequence` is a bare integer, which is why it is the field that crosses.
 *
 * The `null`-means-UNKNOWN rule is the mixed-version contract: a pre-widening
 * producer omits the field, and a consumer that read absence as `0` would treat
 * every legacy message as ordinal zero — silently mis-ordering or mis-seaming a
 * fleet running two daemon versions.
 */
describe('encodeTranscriptMessage — sequence (per-message ordinal)', () => {
    const withMessage = (message: Record<string, unknown>): TranscriptSnapshotCandidate => ({
        ...BASE_CANDIDATE,
        messages: [{ content: 'x', ...message } as TranscriptSnapshotCandidate['messages'][number]],
    });

    it('carries a numeric sequence through to the wire', () => {
        const encoded = encodeTranscriptSnapshot(withMessage({ sequence: 42 }));
        expect(encoded.messages[0].sequence).toBe(42);
    });

    it('encodes a MISSING sequence as null (unknown), never 0', () => {
        const encoded = encodeTranscriptSnapshot(withMessage({}));
        // The distinction that matters: `null` is "this producer told us
        // nothing", `0` would be a real ordinal. Collapsing them makes a legacy
        // daemon's messages all claim position zero.
        expect(encoded.messages[0].sequence).toBeNull();
        expect(encoded.messages[0].sequence).not.toBe(0);
    });

    it('encodes a non-numeric sequence as null rather than coercing it', () => {
        for (const bogus of ['7', true, {}, [], NaN]) {
            const encoded = encodeTranscriptSnapshot(withMessage({ sequence: bogus }));
            expect(encoded.messages[0].sequence).toBeNull();
        }
    });

    it('preserves a legitimate sequence of 0', () => {
        // 0 is a valid ordinal when the producer actually asserts it — the
        // null/0 distinction must not degrade into "falsy means unknown".
        const encoded = encodeTranscriptSnapshot(withMessage({ sequence: 0 }));
        expect(encoded.messages[0].sequence).toBe(0);
    });
});

describe('canonicalizeTranscriptSnapshot / hashTranscriptSnapshot — determinism (design §3.4)', () => {
    it('is deterministic: encoding the same candidate twice yields the same hash', () => {
        const a = encodeTranscriptSnapshot(BASE_CANDIDATE);
        const b = encodeTranscriptSnapshot({ ...BASE_CANDIDATE });
        expect(hashTranscriptSnapshot(a)).toBe(hashTranscriptSnapshot(b));
    });

    it('changes when content changes', () => {
        const a = encodeTranscriptSnapshot(BASE_CANDIDATE);
        const b = encodeTranscriptSnapshot({
            ...BASE_CANDIDATE,
            messages: [{ role: 'assistant', kind: 'standard', content: 'different content' }],
        });
        expect(hashTranscriptSnapshot(a)).not.toBe(hashTranscriptSnapshot(b));
    });

    it('is stable regardless of candidate key insertion order (JCS, not JSON.stringify)', () => {
        const reordered: TranscriptSnapshotCandidate = {
            observedAt: BASE_CANDIDATE.observedAt,
            status: BASE_CANDIDATE.status,
            revision: BASE_CANDIDATE.revision,
            producerEpoch: BASE_CANDIDATE.producerEpoch,
            producerWriterId: BASE_CANDIDATE.producerWriterId,
            producerDaemonId: BASE_CANDIDATE.producerDaemonId,
            providerType: BASE_CANDIDATE.providerType,
            sessionId: BASE_CANDIDATE.sessionId,
            messages: BASE_CANDIDATE.messages,
            coverage: BASE_CANDIDATE.coverage,
        };
        const a = encodeTranscriptSnapshot(BASE_CANDIDATE);
        const b = encodeTranscriptSnapshot(reordered);
        expect(canonicalizeTranscriptSnapshot(a)).toBe(canonicalizeTranscriptSnapshot(b));
    });

    it('known answer: a fixed candidate hashes to a pinned digest', () => {
        const fixed: TranscriptSnapshotCandidate = {
            sessionId: 'known-answer-session',
            providerType: 'claude-code',
            producerDaemonId: 'daemon-known',
            producerWriterId: 'writer-known',
            producerEpoch: 'epoch-known',
            revision: 7,
            observedAt: '2026-08-29T00:00:00.000Z',
            status: 'idle',
            messages: [{ role: 'assistant', kind: 'standard', content: 'pinned' }],
            coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
        };
        const encoded = encodeTranscriptSnapshot(fixed);
        // Pinned so an accidental future change to field order, defaulting, or
        // the canonicalizer itself is caught even if no other assertion notices.
        //
        // Re-pinned when `sequence` joined the message allow-list (per-message
        // ordinal, `null` here since this fixture supplies none). A digest change
        // is the CORRECT signal for a wire-shape change — it must only ever be
        // updated alongside a deliberate allow-list edit, never to "make the test
        // pass".
        expect(hashTranscriptSnapshot(encoded)).toBe(
            '856b51baf1d31f9ad0118fc1a18469b05d66975a85da8a3a7af79d1ba7a25836',
        );
    });
});
