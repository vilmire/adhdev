import { describe, expect, it } from 'vitest';
import { buildTranscriptObservationFromReadChat } from '../../src/commands/transcript-observation-builder.js';
import { encodeChatMessageHead } from '../../src/seqscribe/transcript-keyed-codec.js';
import type { ChatMessage } from '../../src/types.js';

const BASE_COVERAGE = { mode: 'full' as const, omittedBefore: false };

/** The keyed wire head a builder output message becomes (the downstream allow-list hop). */
function wireHead(message: Parameters<typeof encodeChatMessageHead>[0]) {
    return encodeChatMessageHead(message, { id: 'd.x.1', ord: 'a0', rev: 1, epoch: 'e', frame: 1, srcId: null, body: { text: message.content } });
}

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
            coverage: { mode: 'full', omittedBefore: false },
        });
        expect(result?.messages).toHaveLength(20);
        expect(result?.coverage.mode).toBe('full');
    });

    /**
     * (TOOL-EXPAND, keyed lane) The mtime-sealed ref itself no longer travels
     * (design 2026-09-28 §5.9) — only the affordance does, and it has to
     * survive BOTH narrowings: this builder and the keyed wire encoder. Either
     * hop alone can be green while the chain is broken, so assert across the pair.
     */
    it('turns a truncated tool bubble into `expandable` through the builder AND the keyed wire encoder, and drops the ref', () => {
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
        expect(result?.messages[0]?.expandable).toBe(true);
        expect(result?.messages[0]?.toolBlockRef).toBeUndefined();
        const head = wireHead(result!.messages[0]!);
        expect(head.expandable).toBe(true);
        expect(JSON.stringify(head)).not.toContain('recordIndex');
    });

    it('stamps the identity ledger assignment (messageId, ord, srcId) and the retained window ids', () => {
        const messages: ChatMessage[] = [
            { role: 'user', kind: 'standard', content: 'q' },
            { role: 'assistant', kind: 'standard', content: 'a' },
        ];
        const assignments = new Map([
            [messages[0]!, { messageId: 'n.aaaaaaaa.1.0', ord: 'a1', rev: 1, srcId: null }],
            [messages[1]!, { messageId: 'd.e.3', ord: 'a2', rev: 2, srcId: 'n.bbbbbbbb.4.0' }],
        ]);
        const result = buildTranscriptObservationFromReadChat({
            sessionId: 'sess-1',
            providerType: 'claude-code',
            status: 'idle',
            providerObservedStatus: 'idle',
            turn: null,
            messages,
            identity: { assignments, retainedIds: ['d.e.1'], ledgerEpoch: 'e' },
            coverage: { mode: 'window', omittedBefore: true },
        });
        expect(result?.messages.map((m) => [m.messageId, m.ord, m.srcId])).toEqual([
            ['n.aaaaaaaa.1.0', 'a1', null],
            ['d.e.3', 'a2', 'n.bbbbbbbb.4.0'],
        ]);
        expect(result?.coverage).toMatchObject({ mode: 'window', omittedBefore: true, retainedMessageIds: ['d.e.1'] });
        expect(result?.ledgerEpoch).toBe('e');
        // No sequence / toolBlockRef / _src on the observation (keyed wire excludes them).
        expect(Object.keys(result!.messages[0]!)).not.toEqual(expect.arrayContaining(['sequence', '_src', 'toolBlockRef']));
    });

    it('carries toolName through the builder AND the wire encoder (TOOL-LABEL: the live lane label)', () => {
        const messages: ChatMessage[] = [
            { role: 'assistant', kind: 'tool', content: '↗ Write: {"path":"x"}', senderName: 'Tool', toolName: 'Write' },
            { role: 'assistant', kind: 'tool', content: '↘ ok', senderName: 'Tool' },
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
        // Hop 1 — this file used to hardcode `toolName: undefined` here, so the
        // dashboard's live lane labelled every tool card 'Tool'.
        expect(result?.messages[0]?.toolName).toBe('Write');
        expect(result?.messages[1]?.toolName).toBeUndefined();
        // Hop 2 — survives the keyed wire allow-list as a typed string / null.
        expect(wireHead(result!.messages[0]!).toolName).toBe('Write');
        expect(wireHead(result!.messages[1]!).toolName).toBeNull();
    });

    it('leaves expandable false for a bubble that was never truncated', () => {
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
        expect(wireHead(result!.messages[0]!).expandable).toBe(false);
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
