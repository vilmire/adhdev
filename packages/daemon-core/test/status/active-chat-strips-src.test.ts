import { describe, expect, it } from 'vitest';
import { normalizeActiveChatData } from '../../src/status/normalize.js';

/**
 * `_src` is the daemon-internal reader address the message identity ledger
 * keys on (design 2026-09-28 §3.3). ACP/CLI `activeChat` rows carry it, and it
 * must stop at the P2P status projection — no consumer reads it.
 */
describe('normalizeActiveChatData — `_src` never reaches the status payload', () => {
    it('drops `_src` from every message and leaves the source rows untouched', () => {
        const source = {
            id: 'chat-1',
            title: 't',
            status: 'generating',
            messages: [
                { role: 'user', content: 'q', _src: { cls: 'rt', key: 't1.m1' } },
                { role: 'assistant', content: 'a', _src: { cls: 'n', L: '0000abcd', addr: '1.0' }, messageId: 'n.0000abcd.1.0' },
            ],
            activeModal: null,
        };
        const normalized = normalizeActiveChatData(source as never);
        expect(normalized.messages).toHaveLength(2);
        for (const message of normalized.messages as Array<Record<string, unknown>>) expect(message).not.toHaveProperty('_src');
        expect((normalized.messages as Array<Record<string, unknown>>)[1]!.messageId).toBe('n.0000abcd.1.0');
        expect(source.messages[0]).toHaveProperty('_src');
    });
});
