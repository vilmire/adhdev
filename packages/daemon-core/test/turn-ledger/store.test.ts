import { describe, expect, it } from 'vitest';
import { TurnStore } from '../../src/mesh/turn-ledger/store.js';
import { readUserVersion, tableExists } from '../../src/mesh/turn-ledger/schema.js';
import { makeAttempt, makeHold } from './fixtures.js';
import { memDb } from './ledger-harness.js';

describe('turn-ledger schema + store', () => {
    it('creates the five tables additively and leaves user_version alone (only migrate-v1 writes it)', () => {
        const db = memDb();
        for (const t of ['turn_attempts', 'turn_events', 'turn_holds', 'mesh_topic_index', 'mesh_operating_notes']) expect(tableExists(db, t)).toBe(true);
        expect(readUserVersion(db)).toBe(0);
        const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mesh_topic_index'`).all() as Array<{ name: string }>).map((r) => r.name);
        // C3 correction 1: never on the constant `kind`.
        expect(indexes).toEqual(expect.arrayContaining(['ix_topic_index_ledger_kind', 'ix_topic_index_session', 'ix_topic_index_task', 'ix_topic_index_writer']));
        expect(indexes).not.toContain('ix_topic_index_kind');
    });

    it('round-trips an attempt exactly (every TurnAttempt field)', () => {
        const store = new TurnStore(memDb());
        const attempt = makeAttempt('completed', {
            terminal: { outcome: 'completed', reason: 'worker_reported', source: 'worker_tool', strength: 'tool_report', at: 5, summary: { topic: 'mesh.m1.handoff', writer: 'w', seq: 3 } },
            lastLiveness: 'alive', candidateNotifiedGeneration: 1, lastNoProgressNoticeAt: 9, notifiedAt: 11, consumeProfile: 'native_source',
            data: { gitSideEffect: { dirty: true, commitsSinceDispatch: 2, attributable: false, at: 4 } },
        });
        store.upsertAttempt(attempt, 100);
        expect(store.getAttempt('a1')).toEqual(attempt);
    });

    it('≤1 open attempt per session (partial UNIQUE index)', () => {
        const store = new TurnStore(memDb());
        store.upsertAttempt(makeAttempt('generating'), 1);
        expect(() => store.upsertAttempt(makeAttempt('accepted', { attemptId: 'a2', taskId: 't2' }), 2)).toThrow(/UNIQUE/);
        // a terminal attempt on the same session is fine
        store.upsertAttempt(makeAttempt('completed', { attemptId: 'a3', taskId: 't3' }), 3);
        expect(store.findOpenAttemptForSession('s1')?.attemptId).toBe('a1');
    });

    it('syncHolds makes the given set exact; dueHolds/nextHoldDeadline read active holds only; sessionIdFor joins', () => {
        const store = new TurnStore(memDb());
        store.upsertAttempt(makeAttempt('generating'), 1);
        store.syncHolds('a1', [makeHold('liveness', { until: 50 }), makeHold('hard_ceiling', { until: 900 })], 1);
        expect(store.nextHoldDeadline()).toBe(50);
        store.syncHolds('a1', [makeHold('hard_ceiling', { until: 900 })], 2);
        expect(store.activeHolds('a1').map((h) => h.reason)).toEqual(['hard_ceiling']);
        expect(store.dueHolds(1_000).map((h) => h.reason)).toEqual(['hard_ceiling']);
        expect(store.nextHoldDeadline()).toBe(900);
        expect(store.sessionIdForAttempt('a1')).toBe('s1');
        expect(store.sessionIdForAttempt('missing')).toBe('');
    });

    it('publish state goes pending → published once', () => {
        const store = new TurnStore(memDb());
        const base = { sessionId: 's1', kind: 'notify', source: 'x', verdict: 'applied' as const, payload: {}, atMs: 1, recordedAt: 1 };
        expect(store.insertEvent({ ...base, eventId: 'e1', publishState: 'pending' })).toBe(true);
        expect(store.insertEvent({ ...base, eventId: 'e1', publishState: 'pending' })).toBe(false);
        expect(store.pendingPublish().map((r) => r.eventId)).toEqual(['e1']);
        expect(store.markPublished('e1', 'w', 7)).toBe(true);
        expect(store.markPublished('e1', 'w', 8)).toBe(false);
        expect(store.getEvent('e1')).toMatchObject({ publishState: 'published', publishedSeq: 7 });
        expect(store.countPendingPublish()).toBe(0);
    });

    it('operating notes keep category and tombstone once', () => {
        const store = new TurnStore(memDb());
        store.insertOperatingNote({ noteId: 'n1', meshId: 'm1', text: 'lesson', category: 'ops', callerSessionId: null, createdAt: 1 });
        expect(store.tombstoneOperatingNote('m1', 'n1', 5)).toBe(true);
        expect(store.tombstoneOperatingNote('m1', 'n1', 6)).toBe(false);
        expect(store.listOperatingNotes('m1')).toEqual([]);
        expect(store.listOperatingNotes('m1', { includeTombstoned: true })[0]).toMatchObject({ category: 'ops', tombstonedAt: 5 });
    });

    it('prunes terminal plain attempts older than the window (C10-4) with their events and holds', () => {
        const store = new TurnStore(memDb());
        store.upsertAttempt(makeAttempt('completed', { attemptId: 'p1', scope: 'plain', meshId: null, taskId: null, terminal: { outcome: 'completed', reason: 'turn_end', source: 'fsm_edge', strength: 'genuine', at: 10 } }), 10);
        store.insertEvent({ eventId: 'pe', attemptId: 'p1', sessionId: 's1', kind: 'turn_end', source: 'x', verdict: 'applied', payload: {}, publishState: 'none', atMs: 1, recordedAt: 1 });
        store.upsertAttempt(makeAttempt('completed', { attemptId: 'm1a', taskId: 't9', terminal: { outcome: 'completed', reason: 'turn_end', source: 'fsm_edge', strength: 'genuine', at: 10 } }), 10);
        expect(store.pruneTerminalPlainAttempts(100, 1_000)).toEqual({ attempts: 1, events: 1, holds: 0 });
        expect(store.getAttempt('p1')).toBeNull();
        expect(store.getAttempt('m1a')).not.toBeNull();
    });
});
