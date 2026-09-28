import { afterEach, describe, expect, it } from 'vitest';
import {
    MessageIdentityLedger,
    __resetMessageIdentityLedgersForTest,
    getMessageIdentityLedger,
    setMessageIdentitySeedProvider,
    type MessageIdentityInput,
} from '../../src/chat/message-identity-ledger.js';

/**
 * Ledger rebuild after a restart (design 2026-09-28 §4.10), window retention
 * readout (§3.5) and the expand locator (§5.9).
 */

function input(text: string, extra: Partial<MessageIdentityInput> = {}): MessageIdentityInput {
    return { role: 'assistant', kind: 'standard', text, revisionKey: text, ...extra };
}

afterEach(() => {
    setMessageIdentitySeedProvider(null);
    __resetMessageIdentityLedgersForTest();
});

describe('MessageIdentityLedger.restore', () => {
    it('daemon-issued ids survive a restart: same bubbles re-align to their persisted ids, ords are kept, the counter resumes', () => {
        const before = new MessageIdentityLedger({ epoch: 'abc123' });
        const first = before.observe([input('one'), input('two'), input('three')]);
        const ids = first.assignments.map((a) => a.messageId);
        expect(ids.every((id) => id.startsWith('d.abc123.'))).toBe(true);

        const after = new MessageIdentityLedger({ epoch: 'abc123' });
        expect(after.restore({
            epoch: 'abc123',
            entries: before.snapshot().map((e, i) => ({ messageId: e.messageId, ord: e.ord, rev: e.rev, role: 'assistant', kind: 'standard', text: ['one', 'two', 'three'][i]! })),
        })).toBe(true);
        const frame = after.observe([input('one'), input('two'), input('three'), input('four')]);
        expect(frame.assignments.slice(0, 3).map((a) => a.messageId)).toEqual(ids);
        expect(frame.assignments.slice(0, 3).map((a) => a.ord)).toEqual(first.assignments.map((a) => a.ord));
        // A new bubble gets a fresh id — never a reissued one.
        expect(ids).not.toContain(frame.assignments[3]!.messageId);
        expect(frame.assignments[3]!.messageId).toBe('d.abc123.4');
    });

    it('native ids re-bind their own address and an adopted srcId, so the natural source maps back to the inherited id', () => {
        const ledger = new MessageIdentityLedger({ epoch: 'e1' });
        ledger.restore({
            epoch: 'e1',
            entries: [{ messageId: 'd.e1.7', ord: 'a0', rev: 3, role: 'user', kind: 'standard', text: 'hello', srcId: 'n.0000abcd.5.0' }],
        });
        const frame = ledger.observe([input('hello', { role: 'user', src: { cls: 'n', L: '0000abcd', addr: '5.0' } })]);
        expect(frame.assignments[0]).toMatchObject({ messageId: 'd.e1.7', srcId: 'n.0000abcd.5.0' });
    });

    it('refuses to restore a ledger that is already in use', () => {
        const ledger = new MessageIdentityLedger();
        ledger.observe([input('x')]);
        expect(ledger.restore({ epoch: 'zzz', entries: [] })).toBe(false);
    });

    it('a new registry ledger is seeded through the provider; a throwing provider starts fresh', () => {
        setMessageIdentitySeedProvider((key) => (key === 'seeded'
            ? { epoch: 'seed01', entries: [{ messageId: 'd.seed01.9', ord: 'a5', rev: 2, role: 'assistant', kind: 'standard', text: 'kept' }] }
            : null));
        expect(getMessageIdentityLedger('seeded').observe([input('kept')]).assignments[0]!.messageId).toBe('d.seed01.9');
        setMessageIdentitySeedProvider(() => { throw new Error('db gone'); });
        expect(getMessageIdentityLedger('other').observe([input('x')]).assignments[0]!.messageId).toMatch(/^d\./);
    });
});

describe('MessageIdentityLedger — window retention and locators', () => {
    it('retainedIds lists bubbles a window source scrolled out of view', () => {
        const ledger = new MessageIdentityLedger();
        const ids = ledger.observe([input('a'), input('b'), input('c')]).assignments.map((a) => a.messageId);
        ledger.observe([input('c')], { coverage: 'window' });
        expect(ledger.retainedIds().sort()).toEqual([ids[0], ids[1]].sort());
    });

    it('locatorOf returns what the latest observation attached (the expand ref, §5.9)', () => {
        const ledger = new MessageIdentityLedger();
        const ref1 = { sourceMtimeMs: 1, recordIndex: 4, blockIndex: 0 };
        const ref2 = { sourceMtimeMs: 2, recordIndex: 4, blockIndex: 0 };
        const src = { cls: 'n' as const, L: '0000abcd', addr: '4.1' };
        const id = ledger.observe([input('tool out', { kind: 'tool', src, locator: ref1 })]).assignments[0]!.messageId;
        expect(ledger.locatorOf(id)).toEqual(ref1);
        ledger.observe([input('tool out', { kind: 'tool', src, locator: ref2 })]);
        expect(ledger.locatorOf(id)).toEqual(ref2);
        expect(ledger.locatorOf('unknown')).toBeUndefined();
    });
});
