import { describe, expect, it } from 'vitest';
import { buildTranscriptObservationFromReadChat } from '../../src/commands/transcript-observation-builder.js';
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
