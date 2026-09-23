import { describe, expect, it } from 'vitest';
import { isMeshTopicEntry } from '@adhdev/mesh-shared';
import { DEFAULT_TURN_POLICY, awaitDeliveryMs } from '../../src/mesh/turn-ledger/policy.js';
import {
    LIVE_IDLE, SUMMARY, T0, dispatch, evd, fakePublisher, ledgerOn, memDb, pendingCount, recordingHost, recordingPorts, rowsOf,
} from './ledger-harness.js';

// ledger.observe — the C2 write path over a real (in-memory) SQLite handle.

function driveToGenerating(ledger: ReturnType<typeof ledgerOn>, opts: { scope?: 'mesh_queue' | 'mesh_direct' } = {}) {
    expect(ledger.observe(dispatch({ scope: opts.scope ?? 'mesh_direct' })).rule).toBe('R1');
    expect(ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' })).rule).toBe('R2');
    expect(ledger.observe(evd('turn_started', { retro: false })).rule).toBe('R4');
}

describe('commit path', () => {
    it('one committed row + one notify row per commit, published as turn.committed / turn.notify with the summary ref', async () => {
        const db = memDb();
        const publisher = fakePublisher();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { publisher, ports });
        driveToGenerating(ledger);
        const end = ledger.observe(evd('turn_end', { strength: 'genuine', summary: SUMMARY }));
        expect(end.rule).toBe('R9');
        expect(end.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'genuine' });
        expect(rowsOf(db, 'committed', 'a1')).toHaveLength(1);
        expect(rowsOf(db, 'notify', 'a1')).toHaveLength(1);
        expect(pendingCount(db)).toBe(2);

        const report = await ledger.flushPublish();
        expect(report).toEqual({ published: 2, failed: 0, pending: 0 });
        expect(publisher.entries.map((e) => e.entry.k)).toEqual(['turn.committed', 'turn.notify']);
        for (const e of publisher.entries) {
            expect(isMeshTopicEntry(e.entry)).toBe(true);
            expect(e.ref).toEqual(SUMMARY);
            expect(e.meshId).toBe('m1');
        }
        expect(publisher.entries[1]!.entry).toMatchObject({ notify: 'completed', targetDaemonId: 'dc', targetSessionId: 'coord', taskId: 't1' });
        // published(src_seq)
        expect(rowsOf(db, 'committed', 'a1')[0]).toMatchObject({ publish_state: 'published', published_seq: 1 });
        // post-commit executors: bus committed + attempt-ref release; holds all released
        expect(ports.calls).toEqual(expect.arrayContaining(['bus:started', 'bus:committed', 'release:a1']));
        expect(ledger.store.activeHolds('a1')).toEqual([]);
        expect(ledger.isTerminal('a1')).toBe(true);
    });

    it('a duplicate eventId collapses (verdict duplicate); a later scrape is recorded with no second notice', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { publisher: fakePublisher() });
        driveToGenerating(ledger);
        const end = evd('turn_end', { strength: 'genuine' });
        expect(ledger.observe(end).verdict).toBe('applied');
        expect(ledger.observe(end).verdict).toBe('duplicate');
        const scrape = ledger.observe(evd('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }, { source: 'coordinator_probe' }));
        expect(scrape).toMatchObject({ verdict: 'recorded', rule: 'R19' });
        expect(rowsOf(db, 'committed')).toHaveLength(1);
        expect(rowsOf(db, 'notify')).toHaveLength(1);
    });

    it('mesh_queue scope drives the host in the same txn (graph advance) and the post-commit drain', () => {
        const db = memDb();
        const host = recordingHost();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { host, ports, publisher: fakePublisher() });
        driveToGenerating(ledger, { scope: 'mesh_queue' });
        ledger.observe(evd('worker_report', { outcome: 'completed', summary: SUMMARY, hasHandoffNotes: false }, { source: 'worker_tool' }));
        expect(host.calls).toEqual(['graph:t1:completed']);
        expect(ports.calls).toContain('after:m1/t1');
    });

    it('a host failure inside the txn rolls back the whole step (attempt, events, holds)', () => {
        const db = memDb();
        const host = recordingHost();
        const ledger = ledgerOn(db, { host, publisher: fakePublisher() });
        driveToGenerating(ledger, { scope: 'mesh_queue' });
        host.graphAdvance = () => { throw new Error('graph store exploded'); };
        const end = evd('turn_end', { strength: 'genuine' });
        expect(() => ledger.observe(end)).toThrow(/graph store exploded/);
        expect(ledger.getAttempt('a1')?.state).toBe('generating');
        expect(ledger.store.hasEvent(end.eventId)).toBe(false);
        expect(rowsOf(db, 'committed')).toHaveLength(0);
        expect(ledger.store.activeHolds('a1').map((h) => h.reason).sort()).toEqual(['hard_ceiling', 'liveness']);
    });
});

describe('reclaim cuts g−1 first; late completions (R27a / R27)', () => {
    it('reclaim records the cut in-txn and revokes the worker bind BEFORE cancelling (post-commit)', () => {
        const db = memDb();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { ports, publisher: fakePublisher() });
        driveToGenerating(ledger);
        const exit = ledger.observe(evd('process_exit', { exitCode: 137 }, { source: 'pty_exit' }));
        expect(exit.rule).toBe('R20');
        expect(exit.attempt).toMatchObject({ state: 'accepted', generation: 1, prevGeneration: { sessionId: 's1', consumed: true } });
        const [cancelRow] = rowsOf(db, 'cancel_dispatch', 'a1');
        expect(JSON.parse(String(cancelRow!.payload_json))).toMatchObject({ messageId: 'msg-1', revokeBind: true });
        expect(ports.calls.filter((c) => c.startsWith('revoke') || c.startsWith('cancel'))).toEqual(['revoke:s1', 'cancel:s1:g0']);
        expect(rowsOf(db, 'reclaim', 'a1')).toHaveLength(1);
        expect(ledger.store.activeHolds('a1').map((h) => `${h.reason}:${h.generation}`).sort()).toEqual(['await_delivery:1', 'hard_ceiling:null']);
    });

    it('R27a: g not started — g−1 genuine completion is adopted (one commit, one notice, no cut of the adopted session)', async () => {
        const db = memDb();
        const publisher = fakePublisher();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { ports, publisher });
        driveToGenerating(ledger);
        ledger.observe(evd('process_exit', { exitCode: 1 }, { source: 'pty_exit' }));
        ports.calls.length = 0;
        const late = ledger.observe(evd('turn_end', { strength: 'genuine', summary: SUMMARY }, { attemptRef: { attemptId: 'a1', generation: 0 } }));
        expect(late.rule).toBe('R27a');
        expect(late.attempt).toMatchObject({ state: 'completed', generation: 1, sessionId: 's1' });
        expect(ports.calls.some((c) => c.startsWith('cancel'))).toBe(false);
        await ledger.flushPublish();
        expect(publisher.entries.filter((e) => e.entry.k === 'turn.notify')).toHaveLength(1);
        expect(rowsOf(db, 'committed', 'a1')).toHaveLength(1);
    });

    it('R27a after re-delivery to another session cuts that session', () => {
        const db = memDb();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { ports, publisher: fakePublisher() });
        driveToGenerating(ledger);
        ledger.observe(evd('process_exit', { exitCode: 1 }, { source: 'pty_exit' }));
        ledger.observe(evd('delivered', { messageId: 'msg-2', outcome: 'delivered', via: 'local' }, { source: 'input_service', sessionId: 's2', attemptRef: { attemptId: 'a1', generation: 1 } }));
        ports.calls.length = 0;
        const late = ledger.observe(evd('worker_report', { outcome: 'completed', summary: SUMMARY, hasHandoffNotes: false }, { source: 'worker_tool', attemptRef: { attemptId: 'a1', generation: 0 } }));
        expect(late.rule).toBe('R27a');
        expect(ports.calls).toEqual(expect.arrayContaining(['revoke:s2', 'cancel:s2:g1']));
        expect(late.attempt?.sessionId).toBe('s1');
    });

    it('R27: g running — recorded, g untouched, and a late_completion notice (g−1, with the summary ref) is published', async () => {
        const db = memDb();
        const publisher = fakePublisher();
        const ledger = ledgerOn(db, { publisher });
        driveToGenerating(ledger);
        ledger.observe(evd('process_exit', { exitCode: 1 }, { source: 'pty_exit' }));
        const g1 = { attemptRef: { attemptId: 'a1', generation: 1 } };
        ledger.observe(evd('delivered', { messageId: 'msg-2', outcome: 'delivered', via: 'local' }, { ...g1, source: 'input_service', sessionId: 's2' }));
        ledger.observe(evd('turn_started', { retro: false }, { ...g1, sessionId: 's2' }));
        const late = ledger.observe(evd('turn_end', { strength: 'genuine', summary: SUMMARY }, { attemptRef: { attemptId: 'a1', generation: 0 } }));
        expect(late).toMatchObject({ verdict: 'recorded', rule: 'R27' });
        expect(ledger.getAttempt('a1')).toMatchObject({ state: 'generating', generation: 1, sessionId: 's2' });
        await ledger.flushPublish();
        const notices = publisher.entries.filter((e) => e.entry.k === 'turn.notify');
        expect(notices).toHaveLength(1);
        expect(notices[0]!.entry).toMatchObject({ notify: 'late_completion' });
        expect(notices[0]!.ref).toEqual(SUMMARY);
        expect(rowsOf(db, 'notify', 'a1')[0]).toMatchObject({ generation: 0 });
        expect(rowsOf(db, 'committed')).toHaveLength(0);
    });
});

describe('ownership: forward vs reduce', () => {
    it('a worker daemon forwards evidence for a remote-owned attempt as turn.evidence (no local attempt)', async () => {
        const db = memDb();
        const publisher = fakePublisher('w-dw');
        const ledger = ledgerOn(db, { selfDaemonId: 'dw', publisher });
        const ev = evd('turn_end', { strength: 'genuine', summary: SUMMARY }, { attemptRef: { attemptId: 'a9', generation: 2 }, observedBy: 'dw' });
        expect(ledger.observe(ev, { owner: { daemonId: 'dc', meshId: 'm1' } }).verdict).toBe('forwarded');
        expect(ledger.getAttempt('a9')).toBeNull();
        await ledger.flushPublish();
        expect(publisher.entries).toHaveLength(1);
        expect(publisher.entries[0]!.entry).toMatchObject({ k: 'turn.evidence', attemptId: 'a9', generation: 2, ownerDaemonId: 'dc', ev: 'turn_end', strength: 'genuine', evidence: ev });
        expect(ledger.observe(ev, { owner: { daemonId: 'dc', meshId: 'm1' } }).verdict).toBe('duplicate');
    });

    it('the owner ingests it with src coordinates and dedupes a replay by eventId', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { publisher: fakePublisher() });
        driveToGenerating(ledger);
        const ev = evd('turn_end', { strength: 'genuine' }, { observedBy: 'dw' });
        expect(ledger.observe(ev, { src: { writer: 'w-dw', seq: 42 } }).verdict).toBe('applied');
        expect(ledger.store.getEvent(ev.eventId)).toMatchObject({ srcWriter: 'w-dw', srcSeq: 42 });
        expect(ledger.observe(ev, { src: { writer: 'w-dw', seq: 42 } }).verdict).toBe('duplicate');
    });
});

describe('publish completeness (C7-1)', () => {
    it('crash between the txn and the append: a fresh ledger over the same DB republishes every pending row once', async () => {
        const db = memDb();
        const first = ledgerOn(db, { publisher: null });
        driveToGenerating(first);
        first.observe(evd('turn_end', { strength: 'genuine' }));
        expect(pendingCount(db)).toBe(2);
        // "restart": nothing appended; the boot republish drains.
        const publisher = fakePublisher();
        const rebooted = ledgerOn(db, { publisher });
        expect(await rebooted.republishPending()).toEqual({ published: 2, failed: 0, pending: 0 });
        expect(await rebooted.republishPending()).toEqual({ published: 0, failed: 0, pending: 0 });
        expect(publisher.entries.map((e) => e.entry.eventId)).toEqual([...new Set(publisher.entries.map((e) => e.entry.eventId))]);
    });

    it('a rejected append keeps the row pending (per-mesh head-of-line), the next flush publishes it', async () => {
        const db = memDb();
        const publisher = fakePublisher();
        const ledger = ledgerOn(db, { publisher });
        driveToGenerating(ledger);
        ledger.observe(evd('turn_end', { strength: 'genuine' }));
        publisher.failNext = 1;
        expect(await ledger.flushPublish()).toEqual({ published: 0, failed: 1, pending: 2 });
        expect(await ledger.flushPublish()).toEqual({ published: 2, failed: 0, pending: 0 });
        expect(publisher.entries.map((e) => e.entry.k)).toEqual(['turn.committed', 'turn.notify']);
    });

    it('plain sessions are local-only: no pending rows, no notice, but the bus commit still fires', () => {
        const db = memDb();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { ports, publisher: fakePublisher() });
        const start = ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 'sp' }));
        expect(start).toMatchObject({ rule: 'R0a' });
        expect(start.attempt).toMatchObject({ scope: 'plain', ownerDaemonId: 'dc' });
        const end = ledger.observe(evd('turn_end', { strength: 'genuine' }, { attemptRef: undefined, sessionId: 'sp' }));
        expect(end.rule).toBe('R9');
        expect(pendingCount(db)).toBe(0);
        expect(rowsOf(db, 'notify')).toHaveLength(0);
        expect(ports.calls).toContain('bus:committed');
    });
});

describe('sessions, holds, notices', () => {
    it('a dispatch onto a session with an open plain turn supersedes the plain turn (closed, not stopped)', () => {
        const db = memDb();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { ports, publisher: fakePublisher() });
        const plain = ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 's1' })).attempt!;
        const opened = ledger.observe(dispatch());
        expect(opened.rule).toBe('R1');
        expect(ledger.getAttempt(plain.attemptId)).toMatchObject({ state: 'cancelled', terminal: { reason: 'superseded' } });
        expect(ledger.openAttemptForSession('s1')?.attemptId).toBe('a1');
        expect(ports.calls.some((c) => c.startsWith('cancel'))).toBe(false);
        expect(ports.calls).toContain('bus:committed');
    });

    it('★a delivery that lands the attempt on a session holding an open plain turn supersedes the plain turn (C-W4 ledger fix)', () => {
        const db = memDb();
        const ports = recordingPorts();
        const ledger = ledgerOn(db, { ports, publisher: fakePublisher() });
        // The dispatch targets s1; the prompt actually lands on s2, which is
        // mid plain (dashboard) turn.
        expect(ledger.observe(dispatch()).rule).toBe('R1');
        const plain = ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 's2' })).attempt!;
        expect(plain.scope).toBe('plain');
        const delivered = ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service', sessionId: 's2' }));
        expect(delivered.verdict).toBe('applied');
        expect(delivered.attempt?.sessionId).toBe('s2');
        expect(ledger.getAttempt(plain.attemptId)).toMatchObject({ state: 'cancelled', terminal: { reason: 'superseded' } });
        expect(ledger.openAttemptForSession('s2')?.attemptId).toBe('a1');
        // Closed, not stopped: s2 is the session that just took the prompt.
        expect(ports.calls.some((c) => c.startsWith('cancel'))).toBe(false);
    });

    it('a delivery that would land the attempt on a session holding ANOTHER open mesh attempt is refused, not an index violation', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { publisher: fakePublisher() });
        ledger.observe(dispatch());
        ledger.observe(dispatch({ attemptId: 'a2', taskId: 't2', session: 's2' }));
        const delivered = ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service', sessionId: 's2' }));
        expect(delivered.verdict).toBe('rejected');
        expect(ledger.openAttemptForSession('s2')?.attemptId).toBe('a2');
    });

    it('a second mesh dispatch onto a session with an open mesh attempt is refused', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { publisher: fakePublisher() });
        ledger.observe(dispatch());
        const second = ledger.observe(dispatch({ attemptId: 'a2', taskId: 't2' }));
        expect(second).toMatchObject({ verdict: 'rejected' });
        expect(ledger.getAttempt('a2')).toBeNull();
    });

    it('the scheduler sweep turns a due await_delivery hold into H1 (reclaim) via the store-side session join', () => {
        const db = memDb();
        let now = T0;
        const ledger = ledgerOn(db, { now: () => now, publisher: fakePublisher() });
        ledger.observe(dispatch());
        expect(ledger.nextHoldDeadline()).toBe(T0 + awaitDeliveryMs(DEFAULT_TURN_POLICY));
        now = T0 + awaitDeliveryMs(DEFAULT_TURN_POLICY);
        const [expiry] = ledger.expiredHoldEvidence();
        expect(expiry).toMatchObject({ sessionId: 's1', reason: 'await_delivery' });
        const [result] = ledger.sweepExpiredHolds();
        expect(result).toMatchObject({ rule: 'H1', attempt: { generation: 1, state: 'accepted' } });
        expect(ledger.sessionIdFor('a1')).toBe('s1');
    });

    it('notifyMeshEvent: attempt-less notice, local payload kept, content-free entry published', async () => {
        const db = memDb();
        const publisher = fakePublisher();
        const ledger = ledgerOn(db, { publisher });
        const { eventId, inserted } = ledger.notifyMeshEvent({ meshId: 'm1', event: 'refine:completed', payload: { summary: 'LOCAL-ONLY TEXT' }, targetDaemonId: 'dc', taskId: 't1' });
        expect(inserted).toBe(true);
        expect(ledger.notifyMeshEvent({ meshId: 'm1', event: 'refine:completed', targetDaemonId: 'dc', eventId }).inserted).toBe(false);
        await ledger.flushPublish();
        expect(publisher.entries[0]!.entry).toMatchObject({ k: 'turn.notify', notify: 'mesh_event', targetDaemonId: 'dc', taskId: 't1' });
        expect(JSON.stringify(publisher.entries[0]!.entry)).not.toContain('LOCAL-ONLY TEXT');
        expect(JSON.parse(String(rowsOf(db, 'notify')[0]!.payload_json))).toMatchObject({ event: 'refine:completed', local: { payload: { summary: 'LOCAL-ONLY TEXT' } } });
    });

    it('claimDelivery is exactly-once per (writer, seq)', () => {
        const ledger = ledgerOn(memDb());
        expect(ledger.claimDelivery({ writer: 'w-dc', seq: 5, meshId: 'm1', sessionId: 'coord' })).toBe(true);
        expect(ledger.claimDelivery({ writer: 'w-dc', seq: 5, meshId: 'm1', sessionId: 'coord' })).toBe(false);
        expect(ledger.store.hasEvent('delivered:w-dc:5')).toBe(true);
    });

    it('malformed evidence is refused before any write', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const bad = { ...evd('turn_end', { strength: 'genuine' }), summaryText: 'free text' };
        expect(ledger.observe(bad as never)).toMatchObject({ verdict: 'rejected', rejection: 'invalid_evidence' });
        expect((db.prepare('SELECT COUNT(*) AS n FROM turn_events').get() as { n: number }).n).toBe(0);
    });

    it('a held transcript_final re-evaluates on hold expiry with the live veto cleared (R16 → H7 → R14)', () => {
        const db = memDb();
        let now = T0;
        const ledger = ledgerOn(db, { now: () => now, publisher: fakePublisher() });
        driveToGenerating(ledger);
        const held = ledger.observe(evd('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: { ...LIVE_IDLE, adapterPending: true } }, { source: 'coordinator_probe' }));
        expect(held.rule).toBe('R16');
        now = T0 + 60_000;
        const results = ledger.sweepExpiredHolds();
        expect(results.map((r) => r.rule)).toContain('H7');
        expect(ledger.getAttempt('a1')?.state).toBe('completed');
        expect(rowsOf(db, 'committed')).toHaveLength(1);
    });
});
