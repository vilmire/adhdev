import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInputConsumeAck, isApplicationAck } from '../../src/sessions/input-consume-ack.js';
import { ensureInputConsumeAckSchema } from '../../src/sessions/input-consume-ack-schema.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { redeliverDispatch } from '../../src/mesh/mesh-dispatch-redelivery.js';
import { createNoticeSubmitInventory } from '../../src/mesh/turn-ledger/notice-submit-inventory.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function open(file: string, bootNonce: string, pid = process.pid) {
    const db = new Database(file);
    ensureInputConsumeAckSchema(db);
    return { db, ack: createInputConsumeAck({ getDb: () => db, bootNonce, pid }) };
}
const tmpDb = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'consume-ack-')); dirs.push(d); return path.join(d, 'j.db'); };

describe('input consume ACK', () => {
    it('queued / written / submitted never become an ACK', () => {
        const { db, ack } = open(':memory:', 'b1');
        ack.begin('m1', 's1');
        expect(ack.read('m1')?.state).toBe('queued');
        ack.observeWrite('m1', 'started');
        expect(ack.read('m1')?.state).toBe('written');
        ack.observeWrite('m1', 'submitted');
        expect(ack.read('m1')).toMatchObject({ state: 'submitted', evidence: null });
        // A bogus evidence kind cannot mint an ACK or a proof.
        ack.recordConsumed('m1', 'native_write_ack' as never);
        ack.recordNotConsumed('m1', 'queued' as never);
        expect(ack.read('m1')?.state).toBe('submitted');
        expect(ack.claimRetry('m1')).toBe(false);
        db.close();
    });

    it('proven not_consumed allows exactly one resend; consumed always wins', () => {
        const { db, ack } = open(':memory:', 'b1');
        ack.begin('m2', 's1');
        ack.observeWrite('m2', 'submitted');
        ack.recordNotConsumed('m2', 'driver_unconfirmed_after_repaste');
        expect(ack.read('m2')?.state).toBe('not_consumed');
        expect(ack.claimRetry('m2')).toBe(true);
        expect(ack.claimRetry('m2')).toBe(false);
        expect(ack.read('m2')).toMatchObject({ state: 'written', retries: 1 });
        ack.recordNotConsumed('m2', 'transcript_no_turn_after_composer_clear');
        expect(ack.claimRetry('m2')).toBe(false); // budget spent, even with a second proof
        ack.recordConsumed('m2', 'engine_accepted_for_message');
        ack.recordNotConsumed('m2', 'driver_unconfirmed_after_repaste');
        expect(ack.read('m2')?.state).toBe('consumed');
        db.close();
    });

    it('redelivery never re-sends; it reports consumed and spends the single retry only on proven not_consumed', () => {
        const { db, ack } = open(':memory:', 'b1');
        const probe = vi.fn();
        const req = (id: string) => ({ attemptId: 'a', generation: 0, sessionId: 's1', messageId: id, taskId: null });
        const deps = { consume: ack, probe };
        ack.begin('q', 's1'); ack.begin('sub', 's1'); ack.observeWrite('sub', 'submitted');
        expect(redeliverDispatch(req('q'), deps)).toBe('probe_requested');
        expect(redeliverDispatch(req('sub'), deps)).toBe('probe_requested');
        expect(ack.read('sub')?.retries).toBe(0);
        ack.begin('np', 's1'); ack.recordNotConsumed('np', 'driver_unconfirmed_after_repaste');
        expect(redeliverDispatch(req('np'), deps)).toBe('retry_claimed');
        expect(redeliverDispatch(req('np'), deps)).toBe('probe_requested'); // budget spent, state back to written
        expect(ack.read('np')?.retries).toBe(1);
        ack.begin('c', 's1'); ack.recordConsumed('c', 'agent_activity_since_write');
        expect(redeliverDispatch(req('c'), deps)).toBe('already_consumed');
        expect(redeliverDispatch(req('np'), { probe })).toBe('probe_requested'); // no journal
        db.close();
    });

    it('engine submitState=confirmed is the exact ACK; loose activity is consumed but not an application ACK', async () => {
        const { db, ack } = open(':memory:', 'b1');
        let engine: 'in_flight' | 'confirmed' = 'in_flight';
        const service = createSessionInputService({
            consumeAck: ack,
            resolveSession: () => ({ sendMessage: async () => undefined, submitState: () => engine }),
        });
        ack.begin('e1', 's1'); ack.observeWrite('e1', 'submitted');
        expect(await service.settleConsume('s1', 'e1')).toMatchObject({ state: 'submitted' });
        engine = 'confirmed';
        const view = await service.settleConsume('s1', 'e1');
        expect(view).toMatchObject({ state: 'consumed', evidence: 'engine_accepted_for_message' });
        expect(isApplicationAck(view)).toBe(true);
        ack.begin('e2', 's1'); ack.recordConsumed('e2', 'agent_activity_since_write');
        expect(isApplicationAck(ack.read('e2'))).toBe(false);
        db.close();
    });

    it('restored uncertain input is unknown and never resent; consumed survives a store reopen', () => {
        const file = tmpDb();
        const first = open(file, 'boot-1', 111);
        first.ack.begin('open', 's1'); first.ack.observeWrite('open', 'submitted');
        first.ack.begin('done', 's1'); first.ack.recordConsumed('done', 'agent_activity_since_write');
        first.db.close();

        const second = open(file, 'boot-2', 222);
        expect(second.ack.read('open')).toMatchObject({ state: 'unknown', restored: true });
        expect(second.ack.read('done')).toMatchObject({ state: 'consumed', evidence: 'agent_activity_since_write', restored: false });
        expect(redeliverDispatch({ attemptId: 'a', generation: 0, sessionId: 's1', messageId: 'open', taskId: null }, { consume: second.ack })).toBe('not_resent');
        expect(second.ack.claimRetry('open')).toBe(false);
        // Restart is not proof: even an observer callback for the restored row cannot invent a state downgrade.
        second.ack.observeWrite('open', 'uncertain');
        expect(second.ack.read('open')?.state).toBe('unknown');
        second.db.close();
    });

    it('a journal failure degrades to no ACK and no retry, never a throw', () => {
        const ack = createInputConsumeAck({ getDb: () => { throw new Error('locked'); }, bootNonce: 'b' });
        expect(() => { ack.begin('x', 's'); ack.recordConsumed('x', 'engine_accepted_for_message'); }).not.toThrow();
        expect(ack.read('x')).toBeUndefined();
        expect(ack.claimRetry('x')).toBe(false);
    });

    it('SessionInputService records written/submitted/queued but never consumed from them, and exposes the state', async () => {
        const { db, ack } = open(':memory:', 'b1');
        let observer: ((s: 'started' | 'submitted' | 'uncertain') => void) | undefined;
        const service = createSessionInputService({
            consumeAck: ack,
            resolveSession: () => ({
                sendMessage: async () => { observer?.('started'); observer?.('submitted'); },
                observeSendWrite: (_id: string, o: (s: 'started' | 'submitted' | 'uncertain') => void) => { observer = o; },
            }),
        });
        const outcome = await service.submit({ messageId: 'm9', sessionId: 's1', origin: 'mesh', policy: { mode: 'queue' }, input: { parts: [{ type: 'text', text: 'hi' }], textFallback: 'hi' } } as never);
        expect(outcome.kind).toBe('delivered');
        expect(service.getConsumeStates(['m9', 'nope'])).toMatchObject([{ messageId: 'm9', state: 'submitted', evidence: null }]);
        db.close();
    });

    it('notice inventory lifts consumed/applicationAck only from the journal', () => {
        const { db, ack } = open(':memory:', 'b1');
        const store = { db } as never;
        const inv = createNoticeSubmitInventory({ store, selfDaemonId: 'd1' } as never, ack);
        const begin = inv.begin({ meshId: 'M', writer: 'w', seq: 1 }, 's1');
        begin.observe('submitted');
        let ev = inv.inventory().evidence[0];
        expect(ev).toMatchObject({ nativeSubmission: 'confirmed', consumed: 'unknown', applicationAck: 'unknown', retry: 'requires_exact_not_consumed_proof' });
        ack.begin('notify:M:w:1', 's1'); ack.recordConsumed('notify:M:w:1', 'agent_activity_since_write');
        expect(inv.inventory().evidence[0]).toMatchObject({ consumed: 'confirmed', applicationAck: 'unknown' });
        ack.recordConsumed('notify:M:w:1', 'engine_accepted_for_message');
        ev = inv.inventory().evidence[0];
        expect(ev).toMatchObject({ consumed: 'confirmed', applicationAck: 'confirmed' });
        db.close();
    });
});
