import { describe, expect, it } from 'vitest';
import { buildTranscriptObservationFromReadChat } from '../../src/commands/transcript-observation-builder.js';
import { encodeTranscriptMessage } from '../../src/seqscribe/transcript-projection.js';
import type { ChatMessage } from '../../src/types.js';

const BASE_COVERAGE = { mode: 'full' as const, totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false };

describe('buildTranscriptObservationFromReadChat (design §5.2 choke point)', () => {
    it('returns null without a sessionId or providerType — never publishes an unaddressable observation', () => {
        expect(
            buildTranscriptObservationFromReadChat({
                sessionId: '',
                providerType: 'claude-code',
                status: 'idle',
                providerObservedStatus: 'idle',
                turn: null,
                messages: [],
                coverage: BASE_COVERAGE,
            }),
        ).toBeNull();
        expect(
            buildTranscriptObservationFromReadChat({
                sessionId: 'sess-1',
                providerType: '',
                status: 'idle',
                providerObservedStatus: 'idle',
                turn: null,
                messages: [],
                coverage: BASE_COVERAGE,
            }),
        ).toBeNull();
    });

    it('flattens string content verbatim', () => {
        const messages: ChatMessage[] = [{ role: 'assistant', kind: 'standard', content: 'hello world' }];
        const result = buildTranscriptObservationFromReadChat({
            sessionId: 'sess-1',
            providerType: 'claude-code',
            status: 'idle',
            providerObservedStatus: 'idle',
            turn: null,
            messages,
            coverage: BASE_COVERAGE,
        });
        expect(result?.messages[0]?.content).toBe('hello world');
    });

    it('flattens MessagePart[] content into a plain string (design §5.2: producer-side normalization)', () => {
        const messages: ChatMessage[] = [
            {
                role: 'assistant',
                kind: 'standard',
                content: [
                    { type: 'text', text: 'part one ' } as any,
                    { type: 'text', text: 'part two' } as any,
                ],
            },
        ];
        const result = buildTranscriptObservationFromReadChat({
            sessionId: 'sess-1',
            providerType: 'claude-code',
            status: 'idle',
            providerObservedStatus: 'idle',
            turn: null,
            messages,
            coverage: BASE_COVERAGE,
        });
        expect(typeof result?.messages[0]?.content).toBe('string');
        expect(result?.messages[0]?.content).toContain('part one');
        expect(result?.messages[0]?.content).toContain('part two');
    });

    it('carries the full message set given — coverage.mode "full", not the request tailLimit', () => {
        const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
            role: 'assistant',
            kind: 'standard',
            content: `msg-${i}`,
        }));
        const result = buildTranscriptObservationFromReadChat({
            sessionId: 'sess-1',
            providerType: 'claude-code',
            status: 'idle',
            providerObservedStatus: 'idle',
            turn: null,
            messages,
            coverage: { mode: 'full', totalMessageCount: 20, returnedMessageCount: 20, omittedBefore: false },
        });
        expect(result?.messages).toHaveLength(20);
        expect(result?.coverage.mode).toBe('full');
    });

    /**
     * (TOOL-EXPAND) Regression: the expand ref must survive BOTH narrowings.
     *
     * `flattenMessage` here and `encodeTranscriptMessage` downstream are two
     * independent field-by-field allow-lists, and a field has to be named in
     * each one. When the ref was added, only the encoder and the web adapter
     * were widened — this builder kept dropping it, so every truncated tool
     * bubble reached the dashboard with `toolBlockRef: null` and no way to
     * fetch the rest. The parser-level tests stayed green throughout, because
     * the ref was minted correctly and only died in transit.
     *
     * Asserting across the pair is therefore the point: either hop alone can be
     * green while the chain is broken.
     */
    it('carries toolBlockRef through the builder AND the wire encoder', () => {
        const ref = { sourceMtimeMs: 1_700_000_000_123, recordIndex: 13, blockIndex: 0 };
        const messages: ChatMessage[] = [
            { role: 'assistant', kind: 'tool', content: 'a long tool result…', toolBlockRef: ref },
        ];
        const result = buildTranscriptObservationFromReadChat({
            sessionId: 'sess-1',
            providerType: 'claude-code',
            status: 'idle',
            providerObservedStatus: 'idle',
            turn: null,
            messages,
            coverage: BASE_COVERAGE,
        });
        // Hop 1 — the narrowing this file owns.
        expect(result?.messages[0]?.toolBlockRef).toEqual(ref);
        // Hop 2 — the wire allow-list the dashboard actually receives. `null`
        // here is the live symptom, so assert the resolved object, not truthiness.
        expect(encodeTranscriptMessage(result!.messages[0]!).toolBlockRef).toEqual(ref);
    });

    it('leaves toolBlockRef null for a bubble that was never truncated', () => {
        const messages: ChatMessage[] = [{ role: 'assistant', kind: 'tool', content: 'short' }];
        const result = buildTranscriptObservationFromReadChat({
            sessionId: 'sess-1',
            providerType: 'claude-code',
            status: 'idle',
            providerObservedStatus: 'idle',
            turn: null,
            messages,
            coverage: BASE_COVERAGE,
        });
        // An expand affordance on a complete bubble returns the same text back.
        expect(encodeTranscriptMessage(result!.messages[0]!).toolBlockRef).toBeNull();
    });

    it('never throws on malformed message content', () => {
        const messages = [{ role: 'assistant', kind: 'standard', content: undefined as unknown as string }] as ChatMessage[];
        expect(() =>
            buildTranscriptObservationFromReadChat({
                sessionId: 'sess-1',
                providerType: 'claude-code',
                status: 'idle',
                providerObservedStatus: 'idle',
                turn: null,
                messages,
                coverage: BASE_COVERAGE,
            }),
        ).not.toThrow();
    });
});
