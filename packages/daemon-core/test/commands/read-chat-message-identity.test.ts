/**
 * read_chat choke point ↔ message identity ledger (design 2026-09-28 §3.3).
 *
 * `buildReadChatCommandResult` stamps every returned bubble with the session
 * ledger's opaque `messageId` (mirrored into `id`) and strips the
 * daemon-internal `_src` reader address. Ids must not depend on the caller's
 * tailLimit / includeActivity, and must survive re-reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/seqscribe/transcript-publisher.js', () => ({
    notifyTranscriptObservation: vi.fn(),
}));

import { buildReadChatCommandResult } from '../../src/commands/read-chat-presentation.js';
import { stampDomScriptMessageSources } from '../../src/commands/read-chat-message-identity.js';
import { __resetMessageIdentityLedgersForTest } from '../../src/chat/message-identity-ledger.js';
import { lineageToken, nativeSourceAddress, runtimeSourceAddress } from '../../src/chat/message-source-address.js';
import { validateReadChatResultPayload } from '../../src/providers/read-chat-contract.js';

const SESSION = 'sess-identity-1';
const HISTORY = 'c0ffee00-0000-4000-8000-0000000000aa';

function read(messages: any[], args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, presentation = {}) {
    const result = buildReadChatCommandResult(
        { status: 'idle', messages, ...extra },
        { targetSessionId: SESSION, cliType: 'claude-cli', ...args },
        undefined,
        presentation,
    ) as any;
    expect(result.success).toBe(true);
    return result.messages as any[];
}

describe('read_chat message identity', () => {
    beforeEach(() => __resetMessageIdentityLedgersForTest());

    it('stamps a stable messageId (mirrored into id) and never returns _src', () => {
        const messages = [
            { role: 'user', content: 'hello', _src: nativeSourceAddress(HISTORY, '0.0') },
            { role: 'assistant', content: 'hi there', _src: nativeSourceAddress(HISTORY, '1.0') },
            { role: 'assistant', content: 'pty-only bubble' },
        ];
        const first = read(messages);
        const L = lineageToken(HISTORY);
        expect(first.map((m) => m.messageId)).toEqual([`n.${L}.0.0`, `n.${L}.1.0`, expect.stringMatching(/^d\./)]);
        for (const m of first) {
            expect(m.id).toBe(m.messageId);
            expect('_src' in m).toBe(false);
        }
        const second = read(messages.map((m) => ({ ...m })));
        expect(second.map((m) => m.messageId)).toEqual(first.map((m) => m.messageId));
    });

    it('overwrites a positional script id (IDE `msg_<i>`) instead of forwarding it', () => {
        const first = read([{ id: 'msg_0', role: 'user', content: 'a' }, { id: 'msg_1', role: 'assistant', content: 'b' }]);
        expect(first.map((m) => m.id)).not.toContain('msg_0');
        expect(first[0].id).toBe(first[0].messageId);
    });

    it('ids do not depend on the caller tailLimit or includeActivity', () => {
        const messages = [
            { role: 'user', content: 'q1' },
            { role: 'assistant', kind: 'tool', content: 'Read(a.ts)', senderName: 'Tool' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' },
        ];
        const full = read(messages, { includeActivity: true });
        const tail = read(messages, { tailLimit: 2 });
        const prose = read(messages);
        const byContent = new Map(full.map((m) => [m.content, m.messageId]));
        expect(full.every((m) => typeof m.messageId === 'string' && m.messageId.startsWith('d.'))).toBe(true);
        for (const m of [...tail, ...prose]) expect(m.messageId).toBe(byContent.get(m.content));
        expect(tail.map((m) => m.content)).toEqual(['q2', 'a2']);
    });

    it('streaming growth keeps the tail id; a runtime echo hands its id to the native record', () => {
        const echo = { role: 'user', content: 'second', _src: runtimeSourceAddress('user_input_ack:xyz') };
        const base = [
            { role: 'user', content: 'first', _src: nativeSourceAddress(HISTORY, '0.0') },
            { role: 'assistant', content: 'ok', _src: nativeSourceAddress(HISTORY, '1.0') },
        ];
        const f1 = read([...base, echo]);
        const f2 = read([
            ...base,
            { role: 'user', content: 'second', _src: nativeSourceAddress(HISTORY, '2.0') },
            { role: 'assistant', content: 'Work', bubbleState: 'streaming' },
        ], {}, { status: 'generating' });
        const f3 = read([
            ...base,
            { role: 'user', content: 'second', _src: nativeSourceAddress(HISTORY, '2.0') },
            { role: 'assistant', content: 'Working on it', bubbleState: 'streaming' },
        ], {}, { status: 'generating' });
        expect(f1[2].messageId).toMatch(/^d\./);
        expect(f2[2].messageId).toBe(f1[2].messageId);
        expect(f3[3].messageId).toBe(f2[3].messageId);
    });

    it('IDE/extension reads use window coverage: scrolled-out bubbles keep their ids', () => {
        const all = ['m0', 'm1', 'm2', 'm3', 'm4'].map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
        const window = { identityCoverage: 'window' as const };
        const f1 = read(all.slice(0, 3), {}, {}, window);
        read(all.slice(2, 5), {}, {}, window);
        const f3 = read(all.slice(0, 3), {}, {}, window);
        expect(f1.every((m) => typeof m.messageId === 'string')).toBe(true);
        expect(f3.map((m) => m.messageId)).toEqual(f1.map((m) => m.messageId));
    });

    it('keeps separate ledgers per session', () => {
        const a = read([{ role: 'user', content: 'same' }], { targetSessionId: 'sess-A' });
        const b = read([{ role: 'user', content: 'same' }], { targetSessionId: 'sess-B' });
        expect(a[0].messageId).not.toBe(b[0].messageId);
    });
});

describe('read_chat contract carries _src shape-checked', () => {
    it('keeps a well-formed _src and drops a malformed one', () => {
        const good = nativeSourceAddress(HISTORY, '3.1');
        const validated = validateReadChatResultPayload({
            status: 'idle',
            messages: [
                { role: 'user', content: 'a', _src: good },
                { role: 'user', content: 'b', _src: { cls: 'n', L: 'NOT-HEX', addr: '1.0' } },
                { role: 'user', content: 'c', _src: { cls: 'rt', key: 'k', extra: 'dropped' } },
            ],
        });
        expect(validated.messages[0]._src).toEqual(good);
        expect(validated.messages[1]._src).toBeUndefined();
        expect(validated.messages[2]._src).toEqual({ cls: 'rt', key: 'k' });
    });
});

describe('stampDomScriptMessageSources', () => {
    it('turns a script-supplied DOM messageId into a native keyed address', () => {
        const parsed = { status: 'idle', id: 'composer-42', messages: [{ role: 'user', content: 'a', messageId: 'Bubble:ABC/1' }, { role: 'assistant', content: 'b' }] };
        const stamped = stampDomScriptMessageSources(parsed, 'fallback') as any;
        expect(stamped.messages[0]._src).toEqual({ cls: 'n', L: lineageToken('composer-42'), addr: 'kbubble_abc_1.0' });
        expect(stamped.messages[1]._src).toBeUndefined();
        expect((parsed.messages[0] as any)._src).toBeUndefined();
    });

    it('is a no-op without script ids', () => {
        const parsed = { status: 'idle', messages: [{ role: 'user', content: 'a' }] };
        expect(stampDomScriptMessageSources(parsed, 'x')).toBe(parsed);
    });
});
