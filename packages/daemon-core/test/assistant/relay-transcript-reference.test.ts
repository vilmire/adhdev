import { describe, expect, it, vi } from 'vitest';
import { coordinatorReplyReadable, latestCoordinatorReference, remoteCoordinatorReference } from '../../src/assistant/relay-transcript-reference.js';
import { reportMessageId } from '../../src/assistant/project-views.js';
import type { AuditedCoordinatorReply } from '../../src/assistant/assistant-native-window.js';

const AT = Date.parse('2026-10-18T06:00:00Z');
const FINAL = 'Synthetic final answer. Every sentence is present.';
/** read_chat as the daemon serves it: the raw bubble keeps its surrounding whitespace. */
const bubble = (content: string, extra: Record<string, unknown> = {}) => ({ role: 'assistant', kind: 'standard', receivedAt: AT, content, ...extra });
/** The auditor derives text from the native window, trimmed, while the cursor is bound to the raw bubble. */
const audited = (raw: ReturnType<typeof bubble>, text: string): AuditedCoordinatorReply => ({
    sessionId: 'coord', meshId: 'mesh', attemptId: 'plain:a', messageAt: AT, text, chars: text.length, messageId: reportMessageId(raw) });
const executeWith = (messages: unknown[]) => vi.fn(async (command: string) =>
    command === 'read_chat' ? { success: true, messages } : { success: false });

describe('coordinatorReplyReadable (real predicate)', () => {
    it.each([
        ['no surrounding whitespace', FINAL],
        ['leading whitespace', `   \n${FINAL}`],
        ['trailing whitespace', `${FINAL}\n\n  `],
        ['leading and trailing whitespace', `\n  ${FINAL}\r\n\r\n`],
    ])('accepts a complete final with %s', async (_label, content) => {
        const raw = bubble(content);
        expect(await coordinatorReplyReadable(executeWith([raw]) as any, audited(raw, FINAL))).toBe(true);
    });

    it('rejects a cursor whose bubble text differs from what the auditor saw', async () => {
        const raw = bubble(`  ${FINAL}  `);
        const reply = audited(raw, 'Synthetic different text.');
        expect(await coordinatorReplyReadable(executeWith([raw]) as any, reply)).toBe(false);
    });

    it('rejects a reply without a cursor and a cursor the transcript no longer contains', async () => {
        const raw = bubble(FINAL);
        expect(await coordinatorReplyReadable(executeWith([raw]) as any, { ...audited(raw, FINAL), messageId: undefined })).toBe(false);
        expect(await coordinatorReplyReadable(executeWith([bubble('Synthetic unrelated message.')]) as any, audited(raw, FINAL))).toBe(false);
    });
});

describe('latestCoordinatorReference filtering', () => {
    it('skips thinking, user, tool and empty rows and points at the newest assistant prose', async () => {
        const prose = bubble('Synthetic readable context.', { receivedAt: AT - 1_000 });
        const rows = [prose,
            bubble('Synthetic hidden reasoning.', { kind: 'thinking', receivedAt: AT }),
            { role: 'user', kind: 'standard', receivedAt: AT + 1, content: 'Synthetic user prompt.' },
            bubble('   \n ', { receivedAt: AT + 2 }),
            bubble('Synthetic tool output.', { kind: 'tool', receivedAt: AT + 3 }),
            bubble('Synthetic internal note.', { receivedAt: AT + 4, meta: { internal: true } })];
        expect(await latestCoordinatorReference(executeWith(rows) as any, 'coord'))
            .toEqual({ coordinatorSessionId: 'coord', messageId: reportMessageId(prose), offset: 0 });
    });

    it('returns null when only filtered rows exist', async () => {
        const rows = [bubble('Synthetic hidden reasoning.', { kind: 'thinking' }), bubble('  ')];
        expect(await latestCoordinatorReference(executeWith(rows) as any, 'coord')).toBeNull();
    });
});

describe('remoteCoordinatorReference applies the same filters', () => {
    const id = (c: string) => c.repeat(64);
    const row = (extra: Record<string, unknown>) => ({ role: 'assistant', kind: 'standard', messageId: id('a'), text: 'Synthetic remote prose.', ...extra });

    it('accepts compact prose rows, including hosts that omit kind', () => {
        expect(remoteCoordinatorReference([row({ messageId: id('b'), kind: undefined })], 'remote-coord'))
            .toEqual({ coordinatorSessionId: 'remote-coord', messageId: id('b'), offset: 0 });
    });

    it('skips thinking, user, tool, empty and malformed-id rows', () => {
        const prose = row({ messageId: id('c'), text: 'Synthetic older prose.' });
        const rows = [prose, row({ messageId: id('d'), kind: 'thinking' }), row({ messageId: id('e'), role: 'user' }),
            row({ messageId: id('f'), text: '  \n' }), row({ messageId: id('1'), kind: 'tool' }), row({ messageId: 'not-a-hash' })];
        expect(remoteCoordinatorReference(rows, 'remote-coord')).toEqual({ coordinatorSessionId: 'remote-coord', messageId: id('c'), offset: 0 });
        expect(remoteCoordinatorReference(rows.slice(1), 'remote-coord')).toBeNull();
    });
});
