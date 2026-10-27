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
    it('retains audit boundaries and referenced/imported evidence when pruning terminal liveness duplicates', () => {
        const db = memDb();
        const store = new TurnStore(db);
        for (const id of ['old', 'open', 'foreign', 'recent', 'imported', 'published']) {
            store.upsertAttempt(makeAttempt(id === 'open' ? 'generating' : 'completed', {
                attemptId: id, sessionId: id, taskId: id, ownerDaemonId: id === 'foreign' ? 'foreign' : 'dc',
                terminal: id === 'open' ? null : { outcome: 'completed', reason: 'turn_end', source: 'fsm_edge', strength: 'genuine', at: id === 'recent' ? 999 : 1 },
            }), 1);
            for (let n = 0; n < 5; n++) {
                const eventId = `${id}:${n}`;
                store.insertEvent({ eventId, dedupeKey: eventId, srcWriter: id === 'imported' ? 'peer' : null, attemptId: id, generation: 1, sessionId: id, kind: 'liveness',
                    source: 'coordinator_probe', observedBy: 'dc', verdict: 'applied', rule: 'R32', fromState: 'generating', toState: 'generating',
                    payload: { evidence: { eventId, at: n, probeStartedAtMs: n, result: 'alive' } },
                    publishState: id === 'published' ? 'published' : 'none', atMs: n, recordedAt: n });
            }
        }
        store.insertEvent({ eventId: 'old:2#notice', attemptId: 'old', sessionId: 'old', kind: 'notify', source: 'scheduler',
            verdict: 'applied', payload: {}, publishState: 'none', atMs: 100, recordedAt: 100 });
        expect(store.pruneTerminalLivenessSamples(100, 1_000, 'dc')).toBe(2);
        expect(store.listEvents('old').map((e) => e.eventId)).toEqual(expect.arrayContaining(['old:0', 'old:2', 'old:4', 'old:2#notice']));
        for (const id of ['open', 'foreign', 'recent', 'imported', 'published']) expect(store.listEvents(id)).toHaveLength(5);
        expect(store.getAttempt('old')).not.toBeNull();
        db.close();
    });

    it('keeps JSON-referenced samples and progresses past a page of protected foreign rows', () => {
        const db = memDb();
        const store = new TurnStore(db);
        const add = (id: string, ownerDaemonId: string, count: number) => {
            store.upsertAttempt(makeAttempt('completed', { attemptId: id, sessionId: id, taskId: id,
                ownerDaemonId, terminal: { outcome: 'completed', reason: 'turn_end', source: 'fsm_edge', strength: 'genuine', at: 1 } }), 1);
            for (let n = 0; n < count; n++) {
                const eventId = `${id}:${n}`;
                store.insertEvent({ eventId, dedupeKey: eventId, attemptId: id, generation: 1, sessionId: id, kind: 'liveness',
                    source: 'coordinator_probe', observedBy: 'dc', verdict: 'applied', rule: 'R32', fromState: 'generating', toState: 'generating',
                    payload: { evidence: { eventId, at: n, result: 'alive' } }, publishState: 'none', atMs: n, recordedAt: n });
            }
        };
        add('foreign-page', 'peer', 500);
        add('local', 'dc', 6);
        store.syncHolds('local', [makeHold('live_pending', { attemptId: 'local', data: { evidenceId: 'local:1' } })], 1);
        const attempt = store.getAttempt('local')!;
        attempt.data.report = { generation: 1, outcome: 'completed', eventId: 'local:2', at: 1 };
        store.upsertAttempt(attempt, 1);
        store.insertEvent({ eventId: 'json-reference', attemptId: 'local', sessionId: 'local', kind: 'notify', source: 'scheduler',
            verdict: 'applied', payload: { evidenceId: 'local:3' }, publishState: 'none', atMs: 100, recordedAt: 100 });
        expect(store.pruneTerminalLivenessSamples(100, 1000, 'dc')).toBe(0);
        expect(store.pruneTerminalLivenessSamples(100, 1000, 'dc')).toBe(1);
        for (const id of ['local:0', 'local:1', 'local:2', 'local:3', 'local:5']) expect(store.hasEvent(id)).toBe(true);
        expect(store.hasEvent('local:4')).toBe(false);
        expect(store.getEvent('local:3')!.payload.livenessSamples).toMatchObject({ count: 2, latest: { eventId: 'local:4' } });
        expect(store.listEvents('foreign-page')).toHaveLength(500);
        db.close();
    });

    it('dedupes only consecutive benign local samples, preserving failures, transport and provenance', () => {
        const db = memDb();
        const store = new TurnStore(db);
        const sample = (n: number) => ({ eventId: `probe:${n}`, dedupeKey: `probe:${n}`, attemptId: 'a1', generation: 1, sessionId: 's1', kind: 'liveness',
            source: 'coordinator_probe', verdict: 'applied' as const, rule: 'R32', fromState: 'generating', toState: 'generating',
            payload: { evidence: { eventId: `probe:${n}`, at: n, result: 'alive' } } as Record<string, unknown>,
            publishState: 'none' as const, atMs: n, recordedAt: n });
        expect(store.recordEvidence(sample(1))).toBe(true);
        expect(store.recordEvidence(sample(2))).toBe(true);
        expect(store.recordEvidence(sample(2))).toBe(false);
        expect(store.listEvents('a1')).toHaveLength(1);
        store.insertEvent({ ...sample(3), kind: 'transcript_activity' });
        store.recordEvidence(sample(4));
        expect(store.hasEvent('probe:4')).toBe(true);
        store.recordEvidence({ ...sample(5), rule: 'R31a' });
        store.recordEvidence({ ...sample(6), srcWriter: 'peer', srcSeq: 1 });
        store.recordEvidence({ ...sample(7), payload: { ...sample(7).payload, writerStopReceipt: { evidenceId: 'receipt' } } });
        store.recordEvidence(sample(8));
        expect(store.listEvents('a1')).toHaveLength(7);
        expect(store.getEvent('probe:1')!.payload.evidence).toEqual(sample(1).payload.evidence);
        expect(store.getEvent('probe:1')!.payload.livenessSamples).toMatchObject({ count: 2, latest: { eventId: 'probe:2' } });
        db.close();
    });

});
