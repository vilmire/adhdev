import { describe, expect, it } from 'vitest';
import { normalizeNativeHistoryMessages } from '../../src/commands/chat-commands-read.js';
import type { ChatMessage } from '../../src/types.js';

/**
 * CHAT-FLAP-LONG-CONVO root-fix regression suite.
 *
 * The bug: native history is re-derived on every read_chat, so sending a user
 * message grows the tail and shifts every array index by one. The old
 * providerUnitKey embedded `${index}`, so every pre-existing bubble's key (and
 * the derived bubbleId) changed across a send. web-core getChatMessageStableKey
 * correctly trusts bubbleId/providerUnitKey as identity, so a shifted key means
 * a new React key → unmount+remount → a visible flash in long conversations.
 *
 * The invariant these tests pin: the same logical message keeps the same
 * providerUnitKey / bubbleId as the tail grows; different messages get
 * different keys.
 */
describe('normalizeNativeHistoryMessages — position-independent identity', () => {
    const PROVIDER = 'codex-cli';
    const SID = 'sess-abc';

    it('keeps every existing message key stable when a user message is appended', () => {
        const base: ChatMessage[] = [
            { role: 'user', content: 'question one', receivedAt: 1000 },
            { role: 'assistant', content: 'answer one', receivedAt: 1100 },
            { role: 'user', content: 'question two', receivedAt: 2000 },
            { role: 'assistant', content: 'answer two', receivedAt: 2100 },
        ];
        const grown: ChatMessage[] = [
            ...base,
            { role: 'user', content: 'question three', receivedAt: 3000 },
        ];

        const before = normalizeNativeHistoryMessages(PROVIDER, base, SID);
        const after = normalizeNativeHistoryMessages(PROVIDER, grown, SID);

        for (let i = 0; i < before.length; i += 1) {
            expect((after[i] as any).providerUnitKey,
                `providerUnitKey at index ${i} must be unchanged after tail-append`)
                .toBe((before[i] as any).providerUnitKey);
            expect((after[i] as any).bubbleId,
                `bubbleId at index ${i} must be unchanged after tail-append`)
                .toBe((before[i] as any).bubbleId);
            expect((after[i] as any).sequence,
                `sequence at index ${i} must be unchanged after tail-append`)
                .toBe((before[i] as any).sequence);
        }
        // The appended message gets a fresh, distinct key.
        const appended = after[after.length - 1] as any;
        expect(before.some((m: any) => m.providerUnitKey === appended.providerUnitKey)).toBe(false);
    });

    it('does not embed the array index in the providerUnitKey', () => {
        const out = normalizeNativeHistoryMessages(PROVIDER, [
            { role: 'user', content: 'q', receivedAt: 10 },
            { role: 'assistant', content: 'a', receivedAt: 20 },
        ], SID);
        // New format is v3-prefixed and carries no positional index segment.
        expect((out[1] as any).providerUnitKey).toMatch(/^v3:/);
        expect((out[1] as any).providerUnitKey).not.toContain(':1:');
    });

    it('gives distinct keys to identical-content messages (collision guard)', () => {
        const out = normalizeNativeHistoryMessages(PROVIDER, [
            { role: 'assistant', content: 'same reply', receivedAt: 0 },
            { role: 'assistant', content: 'same reply', receivedAt: 0 },
        ], SID);
        expect((out[0] as any).providerUnitKey).not.toBe((out[1] as any).providerUnitKey);
    });

    it('keeps the earlier duplicate stable when a later duplicate is appended', () => {
        const two = normalizeNativeHistoryMessages(PROVIDER, [
            { role: 'assistant', content: 'dup', receivedAt: 0 },
            { role: 'assistant', content: 'dup', receivedAt: 0 },
        ], SID);
        const three = normalizeNativeHistoryMessages(PROVIDER, [
            { role: 'assistant', content: 'dup', receivedAt: 0 },
            { role: 'assistant', content: 'dup', receivedAt: 0 },
            { role: 'assistant', content: 'dup', receivedAt: 0 },
        ], SID);
        expect((three[0] as any).providerUnitKey).toBe((two[0] as any).providerUnitKey);
        expect((three[1] as any).providerUnitKey).toBe((two[1] as any).providerUnitKey);
    });

    it('prefers a provider-native message id as the collision discriminator', () => {
        const out = normalizeNativeHistoryMessages(PROVIDER, [
            { role: 'assistant', content: 'x', receivedAt: 5, id: 'native-1' },
            { role: 'assistant', content: 'x', receivedAt: 5, id: 'native-2' },
        ], SID);
        expect((out[0] as any).providerUnitKey).toContain('native-1');
        expect((out[1] as any).providerUnitKey).toContain('native-2');
    });

    it('re-normalizing already-stamped v3 messages preserves their identity', () => {
        const first = normalizeNativeHistoryMessages(PROVIDER, [
            { role: 'user', content: 'hi', receivedAt: 1 },
            { role: 'assistant', content: 'hello', receivedAt: 2 },
        ], SID);
        // Feed the already-normalized output back through (simulates a re-read of
        // messages that already carry v3 identity).
        const second = normalizeNativeHistoryMessages(PROVIDER, first, SID);
        for (let i = 0; i < first.length; i += 1) {
            expect((second[i] as any).providerUnitKey).toBe((first[i] as any).providerUnitKey);
            expect((second[i] as any).bubbleId).toBe((first[i] as any).bubbleId);
        }
    });
});
