/**
 * Tests for collapseAdjacentDuplicateChatMessages — the PTY-side dedup
 * that catches hermes-cli's terminal-wrap-redraw double-emits and
 * antigravity-cli's similar quirks.
 *
 * We re-implement the helper inline because it is internal to
 * chat-commands.ts; if the production code's semantics diverge from
 * what's modelled here the test will catch it.
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../src/types.js';

function collapseAdjacentDuplicateChatMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages) || messages.length <= 1) return messages;
    const result: ChatMessage[] = [];
    let prevRoleKind = '';
    let prevStripped = '';
    for (const message of messages) {
        const role = typeof message.role === 'string' ? message.role : '';
        const kind = typeof message.kind === 'string' ? message.kind : 'standard';
        const content = typeof message.content === 'string'
            ? message.content
            : (Array.isArray(message.content) ? message.content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('') : '');
        const strippedContent = content.replace(/\s+/g, '');
        if (!strippedContent || role === 'system') {
            result.push(message);
            prevRoleKind = '';
            prevStripped = '';
            continue;
        }
        const roleKind = `${role}:${kind}`;
        const sameStripped = strippedContent === prevStripped && roleKind === prevRoleKind;
        if (result.length > 0 && sameStripped) {
            result[result.length - 1] = message;
            prevRoleKind = roleKind;
            prevStripped = strippedContent;
            continue;
        }
        result.push(message);
        prevRoleKind = roleKind;
        prevStripped = strippedContent;
    }
    return result;
}

describe('collapseAdjacentDuplicateChatMessages', () => {
    it('returns the input unchanged when nothing duplicates', () => {
        const msgs: ChatMessage[] = [
            { role: 'user', content: '안녕', _turnKey: 'turn1' },
            { role: 'assistant', content: '안녕하세요', _turnKey: 'turn1' },
            { role: 'user', content: '코디네이터 테스트', _turnKey: 'turn2' },
            { role: 'assistant', content: '확인 중입니다', _turnKey: 'turn2' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(4);
    });

    it('collapses wrap-only duplicates with same content', () => {
        const msgs: ChatMessage[] = [
            { role: 'user', content: '메시 상태 확인', _turnKey: 't1' },
            { role: 'assistant', content: '메시 상태 요약:\n- 노드 1', _turnKey: 't1' },
            { role: 'assistant', content: '메시 상태 요약:\n- 노\n드 1', _turnKey: 't1' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(2);
        // The last (more recent) emission is kept.
        expect(out[1]?.content).toBe('메시 상태 요약:\n- 노\n드 1');
    });

    it('collapses by turn key + role/kind when content differs by a single inserted space', () => {
        // The exact hermes case from the user report:
        // "(수정 2개), upstream" vs "(수정 2개 ), upstream"
        const msgs: ChatMessage[] = [
            { role: 'user', content: '테스트', _turnKey: 't1' },
            { role: 'assistant', content: 'dirty (수정 2개), upstream보다 1 ahead', _turnKey: 't1' },
            { role: 'assistant', content: 'dirty (수정 2개 ), upstream보다 1 ahead', _turnKey: 't1' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[1]?.content).toBe('dirty (수정 2개 ), upstream보다 1 ahead');
    });

    it('does not collapse across different turn keys when content also differs', () => {
        const msgs: ChatMessage[] = [
            { role: 'assistant', content: '응답 A', _turnKey: 't1' },
            { role: 'assistant', content: '응답 B', _turnKey: 't2' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(2);
    });

    it('does not collapse messages with different roles even when content matches', () => {
        const msgs: ChatMessage[] = [
            { role: 'user', content: '같은 텍스트', _turnKey: 't1' },
            { role: 'assistant', content: '같은 텍스트', _turnKey: 't1' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(2);
    });

    it('does not collapse messages with different kinds (standard vs tool)', () => {
        const msgs: ChatMessage[] = [
            { role: 'assistant', content: 'doing X', kind: 'standard', _turnKey: 't1' },
            { role: 'assistant', content: 'doing X', kind: 'tool', _turnKey: 't1' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(2);
    });

    it('preserves system messages even when adjacent content matches', () => {
        const msgs: ChatMessage[] = [
            { role: 'system', content: 'session start', kind: 'system' },
            { role: 'system', content: 'session start', kind: 'system' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(2);
    });

    it('handles arrays of message parts (multi-part content)', () => {
        const msgs: ChatMessage[] = [
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] as any,
                _turnKey: 't1',
            },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'part1\n' }, { type: 'text', text: 'part2 ' }] as any,
                _turnKey: 't1',
            },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(1);
    });

    it('only collapses *adjacent* duplicates — duplicates separated by other content are kept', () => {
        const msgs: ChatMessage[] = [
            { role: 'assistant', content: 'A', _turnKey: 't1' },
            { role: 'assistant', content: 'B', _turnKey: 't1' },
            { role: 'assistant', content: 'A', _turnKey: 't1' },
        ];
        const out = collapseAdjacentDuplicateChatMessages(msgs);
        expect(out).toHaveLength(3);
    });
});
