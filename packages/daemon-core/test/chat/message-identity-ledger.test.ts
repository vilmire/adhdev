/**
 * Message identity ledger + aligner (design 2026-09-28 §3.3–§3.5).
 *
 * The ledger is the single place that turns an observation of a session's
 * bubbles into stable, opaque `messageId`s and fractional `ord` keys. These
 * tests pin the behaviours the design names for it: streaming growth, PTY
 * re-parse of earlier bubbles, reorder, source handoff (PTY → native, runtime
 * echo → native, ACP partial → final, lineage switch), clear, window coverage,
 * and idempotency.
 */
import { describe, expect, it } from 'vitest';
import {
    MessageIdentityLedger,
    type MessageIdentityInput,
    type MessageIdentityFrame,
} from '../../src/chat/message-identity-ledger.js';
import {
    generateKeyBetween,
    generateNKeysBetween,
    isValidOrderKey,
} from '../../src/chat/fractional-index.js';
import {
    lineageToken,
    nativeSourceAddress,
    recordBlockAddress,
    runtimeSourceAddress,
    type MessageSourceAddress,
} from '../../src/chat/message-source-address.js';

function msg(role: string, text: string, extra: { kind?: string; src?: MessageSourceAddress; rev?: string } = {}): MessageIdentityInput {
    const kind = extra.kind ?? 'standard';
    return {
        role,
        kind,
        text,
        ...(extra.src ? { src: extra.src } : {}),
        revisionKey: extra.rev ?? JSON.stringify([role, kind, text]),
    };
}

const user = (text: string, src?: MessageSourceAddress) => msg('user', text, { src });
const bot = (text: string, src?: MessageSourceAddress) => msg('assistant', text, { src });
const tool = (text: string, src?: MessageSourceAddress) => msg('assistant', text, { kind: 'tool', src });

const ids = (frame: MessageIdentityFrame) => frame.assignments.map((a) => a.messageId);
const ords = (frame: MessageIdentityFrame) => frame.assignments.map((a) => a.ord);
const revs = (frame: MessageIdentityFrame) => frame.assignments.map((a) => a.rev);

function expectAscending(values: readonly string[]): void {
    for (let i = 1; i < values.length; i += 1) expect(values[i - 1] < values[i]).toBe(true);
}

function native(session: string, recordIndex: number, blockIndex = -1): MessageSourceAddress {
    return nativeSourceAddress(session, recordBlockAddress(recordIndex, blockIndex))!;
}

describe('fractional-index', () => {
    it('generates keys strictly between neighbours, both sides unbounded included', () => {
        const a = generateKeyBetween(null, null);
        const b = generateKeyBetween(a, null);
        const mid = generateKeyBetween(a, b);
        const before = generateKeyBetween(null, a);
        expect(before < a && a < mid && mid < b).toBe(true);
        for (const key of [a, b, mid, before]) expect(isValidOrderKey(key)).toBe(true);
    });

    it('keeps 2,000 consecutive appends short (integer-part growth, not per-append)', () => {
        const keys = generateNKeysBetween(null, null, 2000);
        expectAscending(keys);
        expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(4);
    });

    it('spreads N keys between two bounds in order', () => {
        const keys = generateNKeysBetween('a0', 'a1', 25);
        expect(keys).toHaveLength(25);
        expectAscending(['a0', ...keys, 'a1']);
    });
});

describe('message-source-address', () => {
    it('derives the lineage token from the history session id only (8 hex)', () => {
        expect(lineageToken('abc')).toMatch(/^[0-9a-f]{8}$/);
        expect(lineageToken('abc')).toBe(lineageToken('abc'));
        expect(lineageToken('abc')).not.toBe(lineageToken('abd'));
    });

    it('maps (recordIndex, blockIndex) to recordIndex.(blockIndex+1)', () => {
        expect(recordBlockAddress(7, -1)).toBe('7.0');
        expect(recordBlockAddress(7, 2)).toBe('7.3');
        expect(recordBlockAddress(-1, 0)).toBeUndefined();
    });
});

describe('MessageIdentityLedger', () => {
    it('keeps ids across streaming growth and bumps only the growing bubble', () => {
        const ledger = new MessageIdentityLedger({ epoch: 'aaaaaa' });
        const f1 = ledger.observe([user('hi'), bot('Hel')]);
        const f2 = ledger.observe([user('hi'), bot('Hello wor')]);
        const f3 = ledger.observe([user('hi'), bot('Hello world, done.')]);
        expect(ids(f2)).toEqual(ids(f1));
        expect(ids(f3)).toEqual(ids(f1));
        expect(f2.upserts).toEqual([ids(f1)[1]]);
        expect(f3.upserts).toEqual([ids(f1)[1]]);
        expect(revs(f3)).toEqual([1, 3]);
        expect(ords(f3)).toEqual(ords(f1));
        expect(f2.deletes).toEqual([]);
        expect(ids(f1).every((id) => id.startsWith('d.aaaaaa.'))).toBe(true);
    });

    it('is idempotent: re-observing an unchanged source changes nothing', () => {
        const ledger = new MessageIdentityLedger();
        const list = [user('a'), bot('b'), tool('Read(x)'), bot('c')];
        const f1 = ledger.observe(list);
        const f2 = ledger.observe(list.map((m) => ({ ...m })));
        expect(ids(f2)).toEqual(ids(f1));
        expect(ords(f2)).toEqual(ords(f1));
        expect(revs(f2)).toEqual(revs(f1));
        expect(f2.upserts).toEqual([]);
        expect(f2.deletes).toEqual([]);
        expect(f2.aliases).toEqual([]);
    });

    it('keeps the id of an EARLIER bubble the PTY parser re-wrapped or lightly re-cleaned', () => {
        const ledger = new MessageIdentityLedger();
        const long = 'The quick brown fox jumps over the lazy dog and keeps running far away';
        const f1 = ledger.observe([user('q1'), bot(long), user('q2'), bot('streaming')]);
        const rewrapped = long.replace(/ over /, '\nover ').replace(/ far /, '  far\n');
        const recleaned = `${long.slice(0, 30)}X${long.slice(31)}`;
        const f2 = ledger.observe([user('q1'), bot(rewrapped), user('q2'), bot('streaming more')]);
        const f3 = ledger.observe([user('q1'), bot(recleaned), user('q2'), bot('streaming more')]);
        expect(ids(f2)).toEqual(ids(f1));
        expect(ids(f3)).toEqual(ids(f1));
        expect(f3.upserts).toEqual([ids(f1)[1]]);
    });

    it('gives identical repeated lines distinct, stable ids', () => {
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('go'), bot('ok'), user('go'), bot('ok')]);
        expect(new Set(ids(f1)).size).toBe(4);
        const f2 = ledger.observe([user('go'), bot('ok'), user('go'), bot('ok'), user('go')]);
        expect(ids(f2).slice(0, 4)).toEqual(ids(f1));
        expect(f2.upserts).toEqual([ids(f2)[4]]);
    });

    it('treats a reorder as a move: ids survive, only moved bubbles get a new ord', () => {
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('a'), bot('b'), bot('c'), bot('d')]);
        const [a, b, c, d] = ids(f1);
        const f2 = ledger.observe([user('a'), bot('c'), bot('b'), bot('d')]);
        expect(ids(f2)).toEqual([a, c, b, d]);
        expectAscending(ords(f2));
        // Exactly one of b/c moved (LIS keeps the other); a and d keep their ord.
        expect(f2.upserts).toHaveLength(1);
        expect(ords(f2)[0]).toBe(ords(f1)[0]);
        expect(ords(f2)[3]).toBe(ords(f1)[3]);
    });

    it('tombstones deleted bubbles under full coverage and revives an exact return under the same id', () => {
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('prompt'), user('coordinator prompt'), bot('answer')]);
        const f2 = ledger.observe([user('prompt'), bot('answer')]);
        expect(f2.deletes).toEqual([ids(f1)[1]]);
        const f3 = ledger.observe([user('prompt'), user('coordinator prompt'), bot('answer')]);
        expect(ids(f3)).toEqual(ids(f1));
        expectAscending(ords(f3));
    });

    it('derives native ids from the source address, deterministically across ledgers', () => {
        const session = 'c0ffee00-0000-4000-8000-000000000001';
        const list = [user('hi', native(session, 0)), bot('hello', native(session, 1, 0)), tool('Read(a)', native(session, 1, 1))];
        const f1 = new MessageIdentityLedger().observe(list);
        const f2 = new MessageIdentityLedger().observe(list);
        const L = lineageToken(session);
        expect(ids(f1)).toEqual([`n.${L}.0.0`, `n.${L}.1.1`, `n.${L}.1.2`]);
        expect(ids(f2)).toEqual(ids(f1));
        for (const id of ids(f1)) expect(id).toMatch(/^[a-z0-9.:_-]{1,64}$/);
    });

    it('keeps native ids when records append (only the new bubbles are upserts)', () => {
        const session = 'c0ffee00-0000-4000-8000-000000000002';
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('hi', native(session, 0)), bot('hello', native(session, 1))]);
        const f2 = ledger.observe([
            user('hi', native(session, 0)),
            bot('hello', native(session, 1)),
            user('next', native(session, 2)),
            bot('sure', native(session, 3)),
        ]);
        expect(ids(f2).slice(0, 2)).toEqual(ids(f1));
        expect(f2.upserts).toEqual(ids(f2).slice(2));
        expectAscending(ords(f2));
    });

    it('antigravity-style in-place row growth: same address, same id, rev bumps', () => {
        const session = 'agy-conv-1';
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('q', native(session, 4)), bot('partial', native(session, 5))]);
        const f2 = ledger.observe([user('q', native(session, 4)), bot('partial answer, now complete', native(session, 5))]);
        expect(ids(f2)).toEqual(ids(f1));
        expect(revs(f2)).toEqual([1, 2]);
    });

    it('PTY → native handoff: the native bubble inherits the PTY bubble id (alias recorded)', () => {
        const session = 'c0ffee00-0000-4000-8000-000000000003';
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('fix the bug'), bot('Looking at the code now')]);
        const f2 = ledger.observe([
            user('fix the bug', native(session, 0)),
            bot('Looking at the code now.', native(session, 1)),
        ]);
        expect(ids(f2)).toEqual(ids(f1));
        const L = lineageToken(session);
        expect(f2.aliases).toEqual([
            { messageId: ids(f1)[0], srcId: `n.${L}.0.0` },
            { messageId: ids(f1)[1], srcId: `n.${L}.1.0` },
        ]);
        expect(f2.deletes).toEqual([]);
        // The adopted address stays bound: the next native frame is a pure address hit.
        const f3 = ledger.observe([
            user('fix the bug', native(session, 0)),
            bot('Looking at the code now.', native(session, 1)),
            bot('Done.', native(session, 2)),
        ]);
        expect(ids(f3).slice(0, 2)).toEqual(ids(f1));
        expect(ids(f3)[2]).toBe(`n.${L}.2.0`);
        expect(f3.aliases).toEqual([]);
    });

    it('native → PTY (transient gap) keeps ids, and native coming back reclaims them', () => {
        const session = 'c0ffee00-0000-4000-8000-000000000004';
        const ledger = new MessageIdentityLedger();
        const nativeFrame = [user('q', native(session, 0)), bot('a', native(session, 1))];
        const f1 = ledger.observe(nativeFrame);
        const f2 = ledger.observe([user('q'), bot('a')]);
        expect(ids(f2)).toEqual(ids(f1));
        const f3 = ledger.observe(nativeFrame);
        expect(ids(f3)).toEqual(ids(f1));
    });

    it('runtime user echo → native user record: the native record inherits the echo id', () => {
        const session = 'c0ffee00-0000-4000-8000-000000000005';
        const ledger = new MessageIdentityLedger();
        const echo = runtimeSourceAddress('user_input_ack:abc123')!;
        const f1 = ledger.observe([user('first', native(session, 0)), bot('ok', native(session, 1)), user('second question', echo)]);
        const echoId = ids(f1)[2];
        expect(echoId.startsWith('d.')).toBe(true);
        // The merge drops the echo in the same frame the native record appears.
        const f2 = ledger.observe([
            user('first', native(session, 0)),
            bot('ok', native(session, 1)),
            user('second question', native(session, 2)),
        ]);
        expect(ids(f2)[2]).toBe(echoId);
        expect(f2.deletes).toEqual([]);
        expect(f2.aliases).toEqual([{ messageId: echoId, srcId: `n.${lineageToken(session)}.2.0` }]);
    });

    it('spec screen-scrape fallback → native answer keeps the id', () => {
        const session = 'c0ffee00-0000-4000-8000-000000000006';
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('q', native(session, 0)), bot('Working on it')]);
        const f2 = ledger.observe([user('q', native(session, 0)), bot('Working on it — done.', native(session, 1))]);
        expect(ids(f2)).toEqual(ids(f1));
    });

    it('runtime-keyed partial → final: the finalized message keeps the partial bubble id', () => {
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([
            user('do it', runtimeSourceAddress('m1')),
            msg('assistant', 'thinking about', { kind: 'thought', src: runtimeSourceAddress('t1.thought') }),
            bot('Here is the ans...', runtimeSourceAddress('t1.answer')),
        ]);
        const f2 = ledger.observe([
            user('do it', runtimeSourceAddress('m1')),
            msg('assistant', 'thinking about it', { kind: 'thought', src: runtimeSourceAddress('t1.thought') }),
            tool('Edit(file.ts)', runtimeSourceAddress('t1.tool.call-1')),
            bot('Here is the answer', runtimeSourceAddress('t1.answer')),
        ]);
        expect([ids(f2)[0], ids(f2)[1], ids(f2)[3]]).toEqual(ids(f1));
        expect(f2.deletes).toEqual([]);
        expectAscending(ords(f2));
    });

    it('ACP front trim tombstones only the trimmed bubbles', () => {
        const ledger = new MessageIdentityLedger();
        const all = Array.from({ length: 6 }, (_, i) => bot(`m${i}`, runtimeSourceAddress(`m${i}`)));
        const f1 = ledger.observe(all);
        const f2 = ledger.observe(all.slice(3));
        expect(ids(f2)).toEqual(ids(f1).slice(3));
        expect(f2.deletes).toEqual(ids(f1).slice(0, 3));
        expect(f2.upserts).toEqual([]);
    });

    it('reset (verifiedClear): every live bubble is deleted and a new epoch never reissues old ids', () => {
        const ledger = new MessageIdentityLedger({ epoch: 'epoch1' });
        const f1 = ledger.observe([user('a'), bot('b')]);
        const cleared = ledger.reset();
        expect(cleared.reset).toBe(true);
        expect(cleared.deletes.sort()).toEqual([...ids(f1)].sort());
        expect(cleared.epoch).not.toBe('epoch1');
        const f2 = ledger.observe([user('a'), bot('b')]);
        expect(ids(f2).some((id) => ids(f1).includes(id))).toBe(false);
        expect(ids(f2).every((id) => id.startsWith(`d.${cleared.epoch}.`))).toBe(true);
    });

    it('lineage switch (resume into a new file): copied bubbles inherit their ids', () => {
        const oldSession = 'c0ffee00-0000-4000-8000-00000000000a';
        const newSession = 'c0ffee00-0000-4000-8000-00000000000b';
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('q1', native(oldSession, 0)), bot('a1', native(oldSession, 1))]);
        const f2 = ledger.observe([
            user('q1', native(newSession, 0)),
            bot('a1', native(newSession, 1)),
            user('q2', native(newSession, 2)),
        ]);
        expect(ids(f2).slice(0, 2)).toEqual(ids(f1));
        expect(ids(f2)[2]).toBe(`n.${lineageToken(newSession)}.2.0`);
        expect(f2.aliases.map((a) => a.messageId)).toEqual(ids(f1));
    });

    it('new conversation under full coverage: old bubbles are deleted, new ones get fresh ids', () => {
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('old question'), bot('old answer')]);
        const f2 = ledger.observe([user('brand new topic')]);
        expect(ids(f2).some((id) => ids(f1).includes(id))).toBe(false);
        expect(f2.deletes.sort()).toEqual([...ids(f1)].sort());
    });

    it('window coverage: bubbles scrolled out of a virtualized window are retained, not deleted', () => {
        const ledger = new MessageIdentityLedger();
        const all = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map((t, i) => (i % 2 ? bot(t) : user(t)));
        const f1 = ledger.observe(all.slice(0, 4), { coverage: 'window' });
        // Scroll down: the DOM now shows m2..m5.
        const f2 = ledger.observe(all.slice(2, 6), { coverage: 'window' });
        expect(f2.deletes).toEqual([]);
        expect(f2.retainedCount).toBe(2);
        expect(ids(f2).slice(0, 2)).toEqual(ids(f1).slice(2, 4));
        // Scroll back up: m0/m1 regain their original ids. The design's window
        // rule only protects what fell off the FRONT, so m4/m5 (now below the
        // window) are tombstoned…
        const f3 = ledger.observe(all.slice(0, 4), { coverage: 'window' });
        expect(ids(f3)).toEqual(ids(f1));
        expect(f3.deletes).toEqual(ids(f2).slice(2));
        // …and revived under the SAME ids when they scroll back in.
        const f4 = ledger.observe(all.slice(2, 6), { coverage: 'window' });
        expect(ids(f4)).toEqual(ids(f2));
        expectAscending(ords(f4));
        // A bubble that vanished INSIDE the window is a real deletion.
        const f5 = ledger.observe([all[2], all[3], all[5]], { coverage: 'window' });
        expect(f5.deletes).toEqual([ids(f2)[2]]);
    });

    it('window retention orders newly appended bubbles after the retained ones', () => {
        const ledger = new MessageIdentityLedger();
        ledger.observe([user('a'), bot('b'), user('c')], { coverage: 'window' });
        const f2 = ledger.observe([user('c'), bot('d')], { coverage: 'window' });
        const all = ledger.snapshot();
        expect(all.map((e) => e.retained)).toEqual([true, true, false, false]);
        expectAscending(all.map((e) => e.ord));
        expect(all.slice(2).map((e) => e.messageId)).toEqual(ids(f2));
    });

    it('never lets a look-alike bubble steal a native id within the same lineage', () => {
        const session = 'c0ffee00-0000-4000-8000-00000000000c';
        const ledger = new MessageIdentityLedger();
        const f1 = ledger.observe([user('yes', native(session, 0)), bot('ok', native(session, 1))], { coverage: 'window' });
        // Tail window moved on; a NEW record says exactly "ok" again.
        const f2 = ledger.observe([bot('ok', native(session, 5))], { coverage: 'window' });
        expect(ids(f2)[0]).toBe(`n.${lineageToken(session)}.5.0`);
        expect(ids(f2)[0]).not.toBe(ids(f1)[1]);
        expect(f2.aliases).toEqual([]);
    });

    it('demotes an in-frame source-address collision instead of emitting a duplicate id', () => {
        const session = 'dom-composer-1';
        const src = nativeSourceAddress(session, 'kdup.0')!;
        const f1 = new MessageIdentityLedger().observe([bot('first', src), bot('second', src)]);
        expect(new Set(ids(f1)).size).toBe(2);
        expect(ids(f1)[0]).toBe(`n.${lineageToken(session)}.kdup.0`);
        expect(ids(f1)[1].startsWith('d.')).toBe(true);
    });

    it('keeps ids unique and ords ascending under a large random-ish edit sequence', () => {
        const ledger = new MessageIdentityLedger();
        let list: MessageIdentityInput[] = [];
        for (let step = 0; step < 60; step += 1) {
            if (step % 3 === 0) list = [...list, user(`q${step}`)];
            else if (step % 3 === 1) list = [...list, bot(`a${step}`)];
            else list = list.map((m, i) => (i === list.length - 1 ? bot(`${m.text} more`) : m));
            if (step % 17 === 0 && list.length > 3) list = [list[1], list[0], ...list.slice(2)];
            const frame = ledger.observe(list);
            expect(new Set(ids(frame)).size).toBe(list.length);
            expectAscending(ords(frame));
        }
    });
});
