import { describe, expect, it } from 'vitest';
import { isEmptyTranscriptObservation, type TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';
import { KeyedChatSessionState } from '../../src/seqscribe/transcript-keyed-frame.js';

function observation(overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-code',
        status: 'idle',
        messages: [{ messageId: 'n.00000000.1.0', ord: 'a0', role: 'assistant', kind: 'standard', content: 'hello' }],
        coverage: { mode: 'full', omittedBefore: false },
        ...overrides,
    };
}

/** Rows a second observation writes after the first one landed. */
function rowsAfter(first: TranscriptObservation, second: TranscriptObservation): number {
    const state = new KeyedChatSessionState('sess-1', 'e');
    const ctx = { writerId: 'w', producerDaemonId: 'd', observedAt: 't', nowMs: 0 };
    const built = state.build(first, ctx);
    if (built.status !== 'frame') throw new Error('first observation must publish');
    state.commit(built.frame, 0);
    const next = state.build(second, ctx);
    return next.status === 'frame' ? next.frame.rows.length : 0;
}

/**
 * The incident-2026-09-28 property, restated for the keyed lane: fields the
 * wire allow-list drops must never make an observation look changed. v1 hashed
 * the raw observation and minted a wire-identical revision on every 350 ms
 * read (41,928 of them for one session); the keyed publisher compares the
 * ENCODED bubble and meta, so only wire-visible change writes a row.
 */
describe('producer-only fields never write a row', () => {
    function withProvenance(ageMs: number, label: string, selected = 'native-history'): TranscriptObservation {
        return observation({
            provenance: {
                messageSource: {
                    selected,
                    provider: 'claude-cli',
                    staleness: { sourceMtimeMs: 1_790_000_000_000, sourceMtimeAgeMs: ageMs, freshEnough: true },
                    coverage: { nativeMessageCount: 1, ptyMessageCount: 0 },
                },
            },
            messages: [{ messageId: 'n.00000000.1.0', ord: 'a0', role: 'assistant', kind: 'standard', content: 'hello', meta: { label, streaming: false } }],
        });
    }

    it('staleness ages and non-streaming meta changes write nothing', () => {
        expect(rowsAfter(withProvenance(120, 'Read'), withProvenance(470, 'Write'))).toBe(0);
    });

    it('a projected provenance scalar change writes meta + commit only', () => {
        expect(rowsAfter(withProvenance(120, 'Read', 'native-history'), withProvenance(120, 'Read', 'pty-parser'))).toBe(2);
    });

    it('a meta.streaming flip rewrites that one bubble', () => {
        const a = observation({ messages: [{ messageId: 'd.x.1', ord: 'a0', role: 'assistant', kind: 'standard', content: 'hi', meta: { streaming: true } }] });
        const b = observation({ messages: [{ messageId: 'd.x.1', ord: 'a0', role: 'assistant', kind: 'standard', content: 'hi', meta: { streaming: false } }] });
        expect(rowsAfter(a, b)).toBe(2);
    });
});

describe('isEmptyTranscriptObservation (design §3.4 empty-guard)', () => {
    it('true for no messages and no modal/prompt/title', () => {
        expect(isEmptyTranscriptObservation(observation({ messages: [] }))).toBe(true);
    });

    it('false when messages are present', () => {
        expect(isEmptyTranscriptObservation(observation())).toBe(false);
    });

    it('false when a modal is staged even with no messages', () => {
        expect(
            isEmptyTranscriptObservation(
                observation({ messages: [], activeModal: { message: 'approve?', buttons: ['yes', 'no'] } }),
            ),
        ).toBe(false);
    });
});
