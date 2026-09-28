import { describe, expect, it } from 'vitest';
import { jcs } from 'seqscribe';
import {
    CHAT_DEL_KIND,
    CHAT_PART_MAX_JCS_BYTES,
    chatJcsTextBytes,
    chatMessageFromWire,
    computeChatCommitDigest,
    encodeChatMessageHead,
    encodeChatMeta,
    encodeChatPart,
    parseChatKey,
    splitChatBody,
} from '../../src/seqscribe/transcript-keyed-codec.js';
import { CHAT_TOMBSTONE_KIND, sessionChatPolicy } from '../../src/seqscribe/topics.js';

/**
 * Keyed chat wire codec (design 2026-09-28 §4.3, §4.6): allow-list encoders,
 * part splitting under seqscribe's 64 KiB entry/row bounds, and the id/rev
 * commit digest.
 */

// seqscribe `constants.ts`: MAX_ENTRY_BYTES / MAX_ROW_BYTES.
const MAX_ENTRY_BYTES = 65_536;
const MAX_ROW_BYTES = 65_536;

function utf8(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

/** The SUB row a part entry becomes (subs.ts ringRow: payload JSON-stringified), serialized once more on the wire. */
function subRowBytes(payload: unknown): number {
    const row = { key: 'w:1', writer: 'adhdev-writer-x', seq: 1, hlc_l: 1, hlc_c: 0, kind: 'chat.part.v2', payload: JSON.stringify(payload) };
    return utf8(JSON.stringify(row));
}

describe('keyed codec — part splitting (§4.6)', () => {
    const worstCases: Array<[string, string]> = [
        ['all backslashes', '\\'.repeat(200_000)],
        ['all quotes', '"'.repeat(200_000)],
        ['C0 controls', '\u0001\u0002\u001f'.repeat(70_000)],
        ['lone surrogates', '\ud800'.repeat(70_000)],
        ['astral pairs', '😀'.repeat(60_000)],
        ['CJK', '한국어텍스트'.repeat(40_000)],
        ['mixed', 'a"\\\n\t😀한\u0000'.repeat(30_000)],
    ];

    for (const [name, text] of worstCases) {
        it(`${name}: every part entry fits MAX_ENTRY_BYTES and its SUB row fits MAX_ROW_BYTES; nothing is truncated`, () => {
            const parts = splitChatBody(text);
            expect(parts.length).toBeGreaterThan(1);
            expect(parts.join('')).toBe(text);
            for (const [k, part] of parts.entries()) {
                expect(chatJcsTextBytes(part)).toBeLessThanOrEqual(CHAT_PART_MAX_JCS_BYTES);
                const payload = encodeChatPart('d.abc123.1', k, 7, 'epoch-x', 12, part);
                expect(utf8(jcs(payload as never))).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
                expect(subRowBytes(payload)).toBeLessThanOrEqual(MAX_ROW_BYTES);
            }
        });
    }

    it('never splits a surrogate pair', () => {
        const text = 'x'.repeat(CHAT_PART_MAX_JCS_BYTES - 2) + '😀😀😀';
        const parts = splitChatBody(text);
        for (const part of parts) {
            const first = part.charCodeAt(0);
            expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
        }
        expect(parts.join('')).toBe(text);
    });

    it('chatJcsTextBytes matches the JCS serialization of the string (minus the quotes)', () => {
        for (const text of ['plain', 'a"b\\c', '\u0001\n\t', '😀\ud800x', '한글', '']) {
            expect(chatJcsTextBytes(text)).toBe(utf8(jcs(text as never)) - 2);
        }
    });

    it('a body under the threshold stays one piece', () => {
        expect(splitChatBody('short')).toEqual(['short']);
    });
});

describe('keyed codec — head encoder is a by-name allow-list', () => {
    it('drops every non-allow-listed field (content hashes, reader addresses, refs, paths)', () => {
        const head = encodeChatMessageHead(
            {
                messageId: 'ignored',
                role: 'assistant',
                kind: 'tool',
                content: 'x',
                turnKey: 't1',
                bubbleState: 'final',
                senderName: 'claude',
                toolName: 'Bash',
                receivedAt: 5,
                timestamp: 6,
                expandable: true,
                meta: { streaming: false, internal: true, sourcePath: '/secret' },
                providerUnitKey: 'v3:hash',
                bubbleId: 'b1',
                _src: { cls: 'n', L: 'deadbeef', addr: '1.0' },
                toolBlockRef: { sourceMtimeMs: 1, recordIndex: 2, blockIndex: 3 },
                sequence: 9,
                sourcePath: '/x',
            },
            { id: 'n.deadbeef.1.0', ord: 'a0', rev: 3, epoch: 'e', frame: 4, srcId: null, body: { text: 'x' } },
        );
        expect(Object.keys(head).sort()).toEqual(
            [
                'v', 'id', 'rev', 'epoch', 'frame', 'ord', 'role', 'kind', 'turnKey', 'bubbleState', 'streaming',
                'senderName', 'toolName', 'receivedAt', 'timestamp', 'expandable', 'srcId', 'body',
            ].sort(),
        );
        expect(head.id).toBe('n.deadbeef.1.0');
        expect(head.streaming).toBe(false);
        const serialized = JSON.stringify(head);
        for (const forbidden of ['providerUnitKey', 'bubbleId', '_src', 'toolBlockRef', 'sequence', 'sourcePath', 'internal']) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('meta keeps only the scalar provenance selector and bounds presentation strings', () => {
        const meta = encodeChatMeta(
            {
                sessionId: 's',
                providerType: 'claude-cli',
                status: 'idle',
                title: 't'.repeat(5000),
                activeModal: { message: 'm'.repeat(100_000), buttons: ['Yes', 'No'], secret: 1 },
                provenance: { messageSource: { selected: 'native-history', sourcePath: '/p', staleness: {} } },
                workspace: '/ws',
            },
            { rev: 1, epoch: 'e', frame: 1, producerDaemonId: 'd', ledgerEpoch: 'abc123', coverage: { mode: 'full', omittedBefore: false } },
        );
        expect(meta.provenance).toEqual({ messageSource: 'native-history', transcriptProvenance: null });
        expect(meta.title!.length).toBe(1024);
        expect(meta.activeModal!.message.length).toBe(16 * 1024);
        expect(JSON.stringify(meta)).not.toContain('/p');
        expect(JSON.stringify(meta)).not.toContain('/ws');
        expect(utf8(jcs(meta as never))).toBeLessThan(MAX_ENTRY_BYTES);
    });

    it('wire → view keeps identity and never invents fields', () => {
        const head = encodeChatMessageHead(
            { role: 'user', kind: 'standard', content: 'hi' },
            { id: 'd.x.1', ord: 'a1', rev: 2, epoch: 'e', frame: 1, srcId: 'n.00000000.3.0', body: { text: 'hi' } },
        );
        expect(chatMessageFromWire(head, 'hi')).toMatchObject({ messageId: 'd.x.1', ord: 'a1', rev: 2, content: 'hi', srcId: 'n.00000000.3.0' });
    });
});

describe('keyed codec — digest and keys', () => {
    it('the digest is independent of pair order and moves with any id, rev or metaRev', () => {
        const a = computeChatCommitDigest([['b', 1], ['a', 2]], 3);
        expect(computeChatCommitDigest([['a', 2], ['b', 1]], 3)).toBe(a);
        expect(computeChatCommitDigest([['a', 2], ['b', 2]], 3)).not.toBe(a);
        expect(computeChatCommitDigest([['a', 2], ['c', 1]], 3)).not.toBe(a);
        expect(computeChatCommitDigest([['a', 2], ['b', 1]], 4)).not.toBe(a);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('parses bubble and part keys, rejects meta/commit/garbage', () => {
        expect(parseChatKey('m:n.ab.1.0')).toEqual({ id: 'n.ab.1.0', k: null });
        expect(parseChatKey('p:d.x:y.1:3')).toEqual({ id: 'd.x:y.1', k: 3 });
        expect(parseChatKey('meta')).toBeNull();
        expect(parseChatKey('commit')).toBeNull();
        expect(parseChatKey('p:x:-1')).toBeNull();
    });

    it('the codec tombstone kind is the topic policy tombstone kind', () => {
        expect(CHAT_DEL_KIND).toBe(CHAT_TOMBSTONE_KIND);
        expect(sessionChatPolicy().keyed).toEqual({ tombstoneKind: CHAT_DEL_KIND });
    });

    it('the chat policy is a subscribe-only content topic with no Beacon hint keys (I1)', () => {
        const policy = sessionChatPolicy();
        expect(policy).toMatchObject({ kind: 'append', replication: 'subscribe-only', access: 'content', retention: { mode: 'full' } });
        expect(policy.hintKeys).toBeUndefined();
    });
});
