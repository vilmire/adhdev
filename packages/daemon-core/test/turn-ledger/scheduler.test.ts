import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURN_POLICY, awaitDeliveryMs, weakConfirmMs, endProbeGraceMs, holdTtlMs, type TurnPolicy } from '../../src/mesh/turn-ledger/policy.js';
import {
    createLateBoundProbePort,
    createTurnScheduler,
    PLAIN_ATTEMPT_PRUNE_INTERVAL_MS,
    startTurnScheduler,
    type TurnSchedulerProbe,
} from '../../src/mesh/turn-ledger/scheduler.js';
import { makeAttempt, makeHold } from './fixtures.js';
import type { TurnProbeRead } from '../../src/mesh/turn-ledger/probe.js';
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import {
    LIVE_IDLE, T0, dispatch, evd, fakePublisher, ledgerOn, memDb, pendingCount, recordingHost, recordingPorts, rowsOf, confirmFixtureWriterQuiescence,
} from './ledger-harness.js';

// C4 (C-W4): ONE tick over ledger queries. Every hold expiry turns into
// hold_expired evidence and the reducer's H-rule decides the effect; the probe
// only produces evidence; a tick with nothing due writes nothing.

const P: TurnPolicy = DEFAULT_TURN_POLICY;

function rig(opts: { probe?: TurnSchedulerProbe; policy?: TurnPolicy } = {}) {
    const db = memDb();
    let now = T0;
    const ports = recordingPorts();
    const host = recordingHost();
    const publisher = fakePublisher();
    const ledger = ledgerOn(db, { now: () => now, ports, host, publisher, ...(opts.policy ? { policy: opts.policy } : {}) });
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(`I:${m}`), warn: (m: string) => logs.push(`W:${m}`), error: (m: string) => logs.push(`E:${m}`) };
    const claim = vi.fn();
    const scheduler = createTurnScheduler({ ledger, now: () => now, log, claim, ...(opts.probe ? { probe: opts.probe } : {}), ...(opts.policy ? { policy: opts.policy } : {}) });
    return {
        db, ledger, ports, host, publisher, logs, claim, scheduler,
        advance(ms: number) { now += ms; },
        get now() { return now; },
    };
}

type Rig = ReturnType<typeof rig>;

function toGenerating(r: Rig, scope: 'mesh_queue' | 'mesh_direct' = 'mesh_queue') {
    expect(r.ledger.observe(dispatch({ scope })).rule).toBe('R1');
    expect(r.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' })).rule).toBe('R2');
    expect(r.ledger.observe(evd('turn_started', { retro: false })).rule).toBe('R4');
}

function expectReportMissing(r: Rig) {
    const attempt = r.ledger.getAttempt('a1')!;
    expect(attempt).toMatchObject({ state: 'finalizing', generation: 0, terminal: null });
    expect(r.ledger.openAttemptForSession(attempt.sessionId)?.attemptId).toBe('a1');
    expect(r.ledger.store.listEvents('a1').some(e => e.rule === 'R13q'
        && (e.payload.notes as string[] | undefined)?.includes('queue_completion_report_missing'))).toBe(true);
    expect(r.host.calls.some(c => c.startsWith('terminal:') || c.startsWith('requeue:'))).toBe(false);
    expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(0);
}

function totalChanges(r: Rig): number {
    return (r.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('H-rule expiry → the effect the reducer table names (one tick)', () => {
    it('await_delivery (H1): an accepted attempt never delivered is reclaimed — generation + 1, row back to pending', async () => {
        const r = rig();
        r.ledger.observe(dispatch({ scope: 'mesh_queue' }));
        r.advance(awaitDeliveryMs(P) + 1);
        const report = await r.scheduler.tick();
        expect(report.swept).toBeGreaterThanOrEqual(1);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        await confirmFixtureWriterQuiescence(r.ledger);
        const attempt = r.ledger.getAttempt('a1')!;
        expect(attempt.generation).toBe(1);
        expect(attempt.state).toBe('accepted');
        expect(r.host.calls).toContain('requeue:t1');
    });

    it('await_consume (H2 → H2r): delivered-not-consumed is redelivered ONCE, then reclaimed', async () => {
        const r = rig();
        r.ledger.observe(dispatch({ scope: 'mesh_queue' }));
        r.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        r.advance(P.consumeGraceMs + 1);
        await r.scheduler.tick();
        expect(r.ports.calls).toContain('redeliver:s1');
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'delivered', generation: 0, redriveCount: 1 });

        r.advance(P.consumeGraceMs + 1);
        await r.scheduler.tick();
        expect(r.ports.calls.filter((c) => c.startsWith('redeliver:'))).toHaveLength(1);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        await confirmFixtureWriterQuiescence(r.ledger);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'accepted', generation: 1 });
        expect(r.host.calls).toContain('requeue:t1');
    });

    it('hard_ceiling (H5): an open attempt past the ceiling commits failed(hard_ceiling) and advances the graph', async () => {
        const r = rig();
        toGenerating(r);
        r.advance(P.hardCeilingMs + 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', terminal: null });
        expect(r.host.calls.filter(c => c.startsWith('terminal:'))).toEqual([]);
        await confirmFixtureWriterQuiescence(r.ledger);
        const attempt = r.ledger.getAttempt('a1')!;
        expect(attempt.terminal).toMatchObject({ outcome: 'failed', reason: 'hard_ceiling' });
        expect(r.host.calls).toContain('terminal:t1:failed');
        expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(1);
    });

    it('weak_candidate (R13a): a weak end is committed once the confirm window passes with no new activity', async () => {
        const r = rig();
        toGenerating(r);
        expect(r.ledger.observe(evd('turn_end', { strength: 'weak' })).rule).toBe('R10');
        r.advance(weakConfirmMs(P) - 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.state).toBe('finalizing');
        r.advance(2);
        r.ledger.observe(evd('liveness', { result: 'alive' }, { at: r.now }));
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });
    });

    it('live_pending (H7 reevaluate): a genuine end held by live state is re-reduced with the veto cleared and commits', async () => {
        const r = rig();
        toGenerating(r);
        const held = r.ledger.observe(evd('turn_end', { strength: 'genuine', live: { ...LIVE_IDLE, adapterPending: true } }));
        expect(held.rule).toBe('R16');
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        r.advance(holdTtlMs(P) + 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'genuine' });
    });

    it('liveness (H4): a silent running attempt makes the reducer ask for a probe (the `probe` port)', async () => {
        const r = rig();
        toGenerating(r);
        r.advance(P.livenessDeadlineMs + 1);
        await r.scheduler.tick();
        expect(r.ports.calls).toContain('probe:s1');
        // …and the hold is re-armed (unknown-liveness grace), never a verdict.
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        expect(r.ledger.store.activeHolds('a1').map((h) => h.reason)).toContain('liveness');
    });
});

describe('tick order and idempotence', () => {
    it('phases run in the fixed order: sweep → probe → claim → republish → invariants → prune', async () => {
        const r = rig();
        toGenerating(r);
        r.advance(P.quietWindowMs + 1);
        const order: string[] = [];
        const spyLedger: TurnLedger = new Proxy(r.ledger, {
            get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    if (key === 'sweepExpiredHolds' || key === 'republishPending' || key === 'pendingPublishCount') order.push(String(key));
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            },
        });
        const store = new Proxy(r.ledger.store, {
            get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    if (key === 'markProbed' || key === 'pruneTerminalPlainAttempts') order.push(String(key));
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            },
        });
        const probe: TurnSchedulerProbe = {
            locate: () => ({ kind: 'local' }),
            reader: { read: async () => { order.push('probe.read'); return { presence: 'present', status: 'generating' }; } },
        };
        const scheduler = createTurnScheduler({
            ledger: spyLedger, store, now: () => r.now, probe,
            claim: () => { order.push('claim'); },
            deliverBacklog: () => { order.push('deliverBacklog'); },
        });
        await scheduler.tick();
        expect(order).toEqual(['sweepExpiredHolds', 'probe.read', 'markProbed', 'claim', 'deliverBacklog', 'republishPending', 'pendingPublishCount', 'pruneTerminalPlainAttempts']);
    });

    it('a tick with nothing due writes NOTHING (no row changes, no appends)', async () => {
        const r = rig();
        toGenerating(r);
        await r.ledger.flushPublish();
        await r.scheduler.tick(); // first tick: the hourly prune SELECT runs, still no writes
        const appended = r.publisher.entries.length;
        const before = totalChanges(r);
        r.advance(1_000);
        const report = await r.scheduler.tick();
        expect(totalChanges(r)).toBe(before);
        expect(r.publisher.entries.length).toBe(appended);
        expect(report).toMatchObject({ swept: 0, probed: 0, published: 0, pruned: 0 });
    });

    it('a failing notice-backlog delivery is logged and never stops the tick (republish still runs)', async () => {
        const r = rig();
        const republish = vi.spyOn(r.ledger, 'republishPending');
        const scheduler = createTurnScheduler({ ledger: r.ledger, now: () => r.now, log: { info: () => {}, warn: (m) => r.logs.push(m), error: (m) => r.logs.push(m) }, deliverBacklog: async () => { throw new Error('boom') } });
        await scheduler.tick();
        expect(republish).toHaveBeenCalledTimes(1);
        expect(r.logs.some((l: string) => l.includes('notice backlog delivery failed: boom'))).toBe(true);
    });

    it('the claim phase runs every tick (a reclaim above it is re-dispatched in the same tick)', async () => {
        const r = rig();
        await r.scheduler.tick();
        await r.scheduler.tick();
        expect(r.claim).toHaveBeenCalledTimes(2);
    });
});

describe('invariants', () => {
    it('WARNs when a pending publish row is older than 2·tick, and the tick keeps republishing it', async () => {
        const r = rig();
        r.publisher.failMesh.add('m1');
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'genuine' })); // committed + notify rows → pending
        expect(pendingCount(r.db)).toBeGreaterThan(0);
        r.advance(2 * P.tickMs + 1);
        const report = await r.scheduler.tick();
        expect(report.stalePending).toBeGreaterThan(0);
        expect(r.logs.some((l) => l.startsWith('W:') && l.includes("publish_state='pending'"))).toBe(true);
        r.publisher.failMesh.clear();
        r.advance(1);
        await r.scheduler.tick();
        expect(pendingCount(r.db)).toBe(0);
    });

    it('WARNs when an open mesh attempt has no hard_ceiling hold', async () => {
        const r = rig();
        toGenerating(r);
        r.db.prepare(`DELETE FROM turn_holds WHERE reason = 'hard_ceiling'`).run();
        const report = await r.scheduler.tick();
        expect(report.missingCeiling).toBe(1);
        expect(r.logs.filter((l) => l.includes('without a hard_ceiling hold'))).toHaveLength(1);
        // Persisting condition: at most one WARN per interval, not one per tick.
        for (let i = 0; i < 5; i++) { r.advance(P.tickMs); await r.scheduler.tick(); }
        expect(r.logs.filter((l) => l.includes('without a hard_ceiling hold'))).toHaveLength(1);
        r.advance(60_000);
        await r.scheduler.tick();
        expect(r.logs.filter((l) => l.includes('without a hard_ceiling hold'))).toHaveLength(2);
    });
});

describe('plain-attempt prune (C10-4)', () => {
    it('prunes terminal plain attempts older than 7 d, at most once per hour', async () => {
        const r = rig();
        const pruneLiveness = vi.spyOn(r.ledger.store, 'pruneTerminalLivenessSamples');
        // A plain turn: unbound turn_started opens it (R0a), a genuine end commits it.
        r.ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 'dash-1' }));
        const plain = r.ledger.openAttemptForSession('dash-1')!;
        expect(plain.scope).toBe('plain');
        r.ledger.observe(evd('turn_end', { strength: 'genuine' }, { attemptRef: { attemptId: plain.attemptId, generation: 0 }, sessionId: 'dash-1' }));
        expect(r.ledger.isTerminal(plain.attemptId)).toBe(true);

        const WEEK = 7 * 24 * 60 * 60_000;
        r.advance(WEEK - 10 * 60_000);
        expect((await r.scheduler.tick()).pruned).toBe(0); // first pass: not old enough yet
        expect(pruneLiveness).toHaveBeenCalledTimes(1);
        r.advance(20 * 60_000); // now 7 d + 10 min old — but only 20 min since the last pass
        expect((await r.scheduler.tick()).pruned).toBe(0);
        expect(pruneLiveness).toHaveBeenCalledTimes(1);
        r.advance(PLAIN_ATTEMPT_PRUNE_INTERVAL_MS);
        expect((await r.scheduler.tick()).pruned).toBe(1);
        expect(pruneLiveness).toHaveBeenCalledTimes(2);
        expect(r.ledger.getAttempt(plain.attemptId)).toBeNull();
    });
});

describe('probeDue — the probe produces evidence, never a verdict', () => {
    function probeRig(read: TurnProbeRead) {
        const reads: string[] = [];
        const probe: TurnSchedulerProbe = {
            locate: () => ({ kind: 'local' }),
            reader: { read: async (attempt) => { reads.push(attempt.attemptId); return read; } },
        };
        return { r: rig({ probe }), reads };
    }

    it('an idle worker with a fresh-shape final bubble becomes transcript_final{coordinator_probe} → weak candidate, NOT completed', async () => {
        const { r, reads } = probeRig({
            presence: 'present',
            status: 'idle',
            transcript: { providerObservedStatus: 'idle', activeModal: false, selfAttributing: false, trailingActivity: 0, nativeRead: false, finalAssistantAt: T0 + 1_000, newestActivityAt: T0 + 1_000 },
        });
        toGenerating(r);
        r.advance(P.quietWindowMs + 5_000);
        await r.scheduler.tick();
        expect(reads).toEqual(['a1']);
        const ev = rowsOf(r.db, 'transcript_final', 'a1');
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ source: 'coordinator_probe' });
        // Shape evidence only → the reducer's admission says weak → finalizing.
        expect(r.ledger.getAttempt('a1')!.state).toBe('finalizing');
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        expect(r.host.calls.filter((c) => c.startsWith('terminal:'))).toEqual([]);
        // …and the attempt is stamped probed.
        const row = r.db.prepare('SELECT last_probe_at FROM turn_attempts WHERE attempt_id = ?').get('a1') as { last_probe_at: number };
        expect(row.last_probe_at).toBe(r.now);
    });

    it('a session gone from the registry becomes liveness{dead} → R31 reclaim', async () => {
        const { r } = probeRig({ presence: 'absent' });
        toGenerating(r);
        r.advance(P.quietWindowMs + 1);
        await r.scheduler.tick();
        expect(rowsOf(r.db, 'liveness', 'a1')[0]).toMatchObject({ rule: 'R31' });
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        await confirmFixtureWriterQuiescence(r.ledger);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'accepted', generation: 1 });
    });

    it('a quiet delivered attempt is not re-probed inside the authoritative-transcript window', async () => {
        // A delivered attempt with no agent bubble yields NO evidence, so nothing
        // refreshes its activity clock — only the reprobe window spaces the reads.
        const { r, reads } = probeRig({ presence: 'present', status: 'idle', transcript: { providerObservedStatus: 'idle', activeModal: false, selfAttributing: false, trailingActivity: 0, nativeRead: false } });
        r.ledger.observe(dispatch({ scope: 'mesh_queue' }));
        r.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        r.advance(P.quietWindowMs + 1);
        await r.scheduler.tick();
        r.advance(P.tickMs);
        await r.scheduler.tick();
        expect(reads).toHaveLength(1);
        r.advance(60_000);
        await r.scheduler.tick();
        expect(reads).toHaveLength(2);
    });

    it('the H4 probe port reaches the scheduler through the late-bound port and forces a read the due rule would skip', async () => {
        const late = createLateBoundProbePort();
        const db = memDb();
        let now = T0;
        const ledger = ledgerOn(db, { now: () => now, ports: { probe: late.port }, host: recordingHost(), publisher: fakePublisher() });
        const reads: string[] = [];
        const scheduler = createTurnScheduler({
            ledger, now: () => now,
            probe: { locate: () => ({ kind: 'local' }), reader: { read: async (a) => { reads.push(a.attemptId); return { presence: 'present', status: 'generating' }; } } },
        });
        ledger.observe(dispatch({ scope: 'mesh_queue' }));
        ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        ledger.observe(evd('turn_started', { retro: false }));
        // Fresh activity + a fresh probe stamp: the due rule says "not due".
        ledger.store.markProbed('a1', now);
        await scheduler.tick();
        expect(reads).toEqual([]);
        // (a) a request that arrives before the scheduler is bound is remembered.
        late.port({ attemptId: 'a1' });
        late.bind(scheduler);
        await scheduler.tick();
        expect(reads).toEqual(['a1']);
        // (b) once bound, the port forwards straight to requestProbe.
        late.port({ attemptId: 'a1' });
        await scheduler.tick();
        expect(reads).toEqual(['a1', 'a1']);
    });
});

describe('startTurnScheduler — nextHoldDeadline shortens the sleep', () => {
    it('a hold that expires mid-interval is swept at its deadline, not a whole interval later', async () => {
        vi.useFakeTimers({ now: T0 });
        const db = memDb();
        const ledger = ledgerOn(db, { now: () => Date.now(), host: recordingHost(), publisher: fakePublisher() });
        ledger.observe(dispatch({ scope: 'mesh_queue' }));
        ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        ledger.observe(evd('turn_started', { retro: false }));
        ledger.observe(evd('turn_end', { strength: 'weak' })); // weak_candidate hold: 12 s
        ledger.observe(evd('liveness', { result: 'alive', probeStartedAtMs: T0 }, { at: T0 }));
        const policy = { ...DEFAULT_TURN_POLICY, tickMs: 60_000 };
        const scheduler = startTurnScheduler({ ledger, policy, now: () => Date.now() });
        try {
            await vi.advanceTimersByTimeAsync(weakConfirmMs(policy) - 500);
            expect(ledger.getAttempt('a1')!.terminal).toBeNull();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', reason: 'weak_end_confirmed' });
        } finally {
            scheduler.stop();
        }
    });
});

describe('semantic liveness audit dedupe', () => {
    it('bounds unchanged observations while refreshing attempt freshness and preserving changes', async () => {
        let presence: TurnProbeRead['presence'] = 'present';
        const r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read: async () => ({ presence, status: 'generating' }) } } });
        toGenerating(r);
        for (let i = 0; i < 20; i++) {
            r.advance(P.tickMs);
            r.scheduler.requestProbe('a1');
            await r.scheduler.tick();
        }
        let rows = r.ledger.store.listEvents('a1').filter((e) => e.kind === 'liveness');
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.livenessSamples).toMatchObject({ count: 20 });
        expect(r.ledger.getAttempt('a1')!.data.livenessObservation?.at).toBe(r.now);
        const first = rows[0].payload.evidence;
        presence = 'unknown';
        for (let i = 0; i < 20; i++) {
            r.advance(P.tickMs);
            r.scheduler.requestProbe('a1');
            await r.scheduler.tick();
        }
        rows = r.ledger.store.listEvents('a1').filter((e) => e.kind === 'liveness');
        expect(rows).toHaveLength(2);
        expect(rows[1].payload.livenessSamples).toMatchObject({ count: 20 });
        expect(r.ledger.getAttempt('a1')!.data.livenessObservation?.at).toBe(r.now);
        expect(rows[0].payload.evidence).toEqual(first);
        expect(r.ledger.getAttempt('a1')!.lastLiveness).toBe('unknown');
        presence = 'present';
        r.advance(P.tickMs);
        r.scheduler.requestProbe('a1');
        await r.scheduler.tick();
        expect(r.ledger.store.listEvents('a1').filter((e) => e.kind === 'liveness')).toHaveLength(3);
        r.scheduler.stop();
        r.db.close();
    });
});

describe('scheduler owner and overdue deadline safety', () => {
    it('foreign and orphan expiries cannot starve local deadlines or cause immediate ticks', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const db = memDb();
        const ledger = ledgerOn(db, { now: () => Date.now(), selfDaemonId: 'daemon_mach_local' });
        // More than the sweep limit: eligibility must be applied BEFORE LIMIT.
        for (let i = 0; i < 501; i++) {
            const id = `foreign-${i}`;
            ledger.store.upsertAttempt(makeAttempt('generating', { attemptId: id, sessionId: id, taskId: id, ownerDaemonId: 'daemon_mach_foreign' }), T0);
            ledger.store.syncHolds(id, [makeHold('liveness', { holdId: id, attemptId: id, until: T0 - 1 })], T0);
        }
        ledger.store.syncHolds('orphan', [makeHold('liveness', { holdId: 'orphan', attemptId: 'orphan', until: T0 - 2 })], T0);
        ledger.store.upsertAttempt(makeAttempt('generating', { ownerDaemonId: 'mach_local' }), T0);
        ledger.store.syncHolds('a1', [makeHold('liveness', { until: T0 + 100 })], T0);
        expect(ledger.nextHoldDeadline()).toBe(T0 + 100);
        expect(ledger.expiredHoldEvidence(T0)).toEqual([]);
        const sweep = vi.spyOn(ledger, 'sweepExpiredHolds');
        const scheduler = startTurnScheduler({ ledger, intervalMs: 1_000 });
        try {
            await vi.advanceTimersByTimeAsync(101);
            expect(sweep).toHaveBeenCalledTimes(2); // boot + local deadline
            expect(ledger.store.activeHolds('a1')[0].until).toBeGreaterThan(T0 + 100);
            await vi.advanceTimersByTimeAsync(899);
            expect(sweep).toHaveBeenCalledTimes(3);
            expect(ledger.store.activeHolds('foreign-0')[0].until).toBe(T0 - 1);
            expect(ledger.store.activeHolds('orphan')[0].until).toBe(T0 - 2);
            expect(db.prepare("SELECT count(*) AS n FROM turn_events WHERE verdict = 'forwarded'").get()).toEqual({ n: 0 });
        } finally { scheduler.stop(); db.close(); }
    });

    it('an overdue local hold cannot hide a future eligible deadline after an unsuccessful sweep', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const db = memDb();
        const ledger = ledgerOn(db, { now: () => Date.now() });
        ledger.store.upsertAttempt(makeAttempt('generating'), T0);
        ledger.store.syncHolds('a1', [makeHold('liveness', { until: T0 - 1 }), makeHold('hard_ceiling', { until: T0 + 100 })], T0);
        const sweep = vi.spyOn(ledger, 'sweepExpiredHolds').mockReturnValue([]);
        const scheduler = startTurnScheduler({ ledger, intervalMs: 1_000 });
        try {
            await vi.advanceTimersByTimeAsync(101);
            expect(sweep).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(899);
            expect(sweep).toHaveBeenCalledTimes(3);
        } finally { scheduler.stop(); db.close(); }
    });

    it.each([T0 - 1, Number.NaN, Number.NEGATIVE_INFINITY])('bounds uncollectable deadline %s while preserving explicit wakeups', async (deadline) => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const db = memDb();
        const ledger = ledgerOn(db, { now: () => Date.now() });
        vi.spyOn(ledger, 'nextHoldDeadline').mockReturnValue(deadline);
        const sweep = vi.spyOn(ledger, 'sweepExpiredHolds');
        const scheduler = startTurnScheduler({ ledger, intervalMs: 1_000 });
        try {
            await vi.advanceTimersByTimeAsync(100);
            expect(sweep).toHaveBeenCalledTimes(1);
            scheduler.requestProbe('missing');
            await vi.advanceTimersByTimeAsync(1);
            expect(sweep).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(899);
            expect(sweep).toHaveBeenCalledTimes(3);
        } finally { scheduler.stop(); db.close(); }
    });
});

describe('weak expiry requires a fresh completed probe', () => {
    it('a reader that never returns is bounded and supplies an inconclusive observation', async () => {
        vi.useFakeTimers();
        const read = vi.fn(() => new Promise<TurnProbeRead>(() => {}));
        const r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'weak' }));
        r.advance(weakConfirmMs(P) + 1);
        const tick = r.scheduler.tick();
        r.advance(endProbeGraceMs(P));
        await vi.advanceTimersByTimeAsync(endProbeGraceMs(P));
        await tick;
        expect(r.ledger.getAttempt('a1')!.lastLiveness).toBe('unknown');
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'failed', reason: 'weak_end_liveness_unconfirmed' });
    });

    it('an overdue sweep re-probes stale alive first; a slow live read can then confirm inside grace', async () => {
        let r: ReturnType<typeof rig>;
        const read = vi.fn(async () => {
            r.advance(20_000); // longer than the old 12 s grace
            return { presence: 'present' as const, status: 'generating' };
        });
        r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'weak' }));
        r.ledger.observe(evd('liveness', { result: 'alive' }, { at: r.now }));
        r.advance(weakConfirmMs(P) + 120_000);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        expect(r.ledger.getAttempt('a1')!.data.unconfirmedEndDeferral?.requestedAt).toBe(r.now - 20_000);
        expect(read).toHaveBeenCalled();
        r.advance(endProbeGraceMs(P) - 20_000);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'weak' });
    });

    it('re-reading an old alive member snapshot never refreshes its sample time', async () => {
        const read = vi.fn(async () => ({ presence: 'present' as const, status: 'generating', observedAtMs: T0 }));
        const r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'weak' }));
        r.advance(weakConfirmMs(P) + 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        r.advance(endProbeGraceMs(P) + 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'failed', reason: 'weak_end_probe_unobserved' });
    });

    it('a read begun for a generation that is reclaimed cannot be re-labelled for its replacement', async () => {
        let r: ReturnType<typeof rig>;
        const read = vi.fn(async () => {
            r.ledger.observe(evd('process_exit', { exitCode: 1 }));
            return { presence: 'absent' as const };
        });
        r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        toGenerating(r);
        r.scheduler.requestProbe('a1');
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        expect(rowsOf(r.db, 'liveness', 'a1')).toHaveLength(0);
        await confirmFixtureWriterQuiescence(r.ledger);
        const attempt = r.ledger.getAttempt('a1')!;
        expect(attempt).toMatchObject({ generation: 1, state: 'accepted', terminal: null });
        expect(attempt.lastLiveness).not.toBe('dead');
    });
});

// Live rc.40 run 5 (2026-09-24, task 9315fa4d): idle 16 s into a `sleep 240` turn,
// busy again 4 min later, report at 08:18:42, idle again. The owner used to commit
// genuine at the first idle; with the report gate the attempt stays open through
// the false idle and commits ONCE, on the report.
describe('report gate — the rc.40 false-idle sequence commits once, on the report', () => {
    it.each(['report', 'hard_ceiling'] as const)('direct missing-report expiry releases its hold once and preserves %s authority', async (resolution) => {
        const r = rig();
        toGenerating(r, 'mesh_direct');
        r.ledger.observe(evd('turn_end', { strength: 'weak' }));
        r.advance(weakConfirmMs(P) + 1);
        r.ledger.observe(evd('liveness', { result: 'alive' }, { at: r.now }));
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'finalizing', terminal: null });
        expect(r.ledger.store.activeHolds('a1').some(h => h.reason === 'weak_candidate')).toBe(false);
        const candidates = () => rowsOf(r.db, 'notify', 'a1').filter(row =>
            (JSON.parse(String(row.payload_json)) as { notify?: string }).notify === 'candidate');
        expect(candidates()).toHaveLength(1);
        const expiries = rowsOf(r.db, 'hold_expired', 'a1').length;
        for (let i = 0; i < 3; i++) {
            r.advance(1);
            await r.scheduler.tick();
        }
        expect(rowsOf(r.db, 'hold_expired', 'a1')).toHaveLength(expiries);
        expect(candidates()).toHaveLength(1);
        expect(r.host.calls.filter(c => c.startsWith('terminal:'))).toEqual([]);
        expect(r.ledger.nextHoldDeadline(r.now)!).toBeGreaterThan(r.now);
        if (resolution === 'report') {
            r.ledger.observe(evd('worker_report', { outcome: 'completed', hasHandoffNotes: false },
                { source: 'worker_tool', at: r.now }));
            expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' });
        } else {
            r.advance(P.hardCeilingMs);
            await r.scheduler.tick();
            expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', terminal: null });
            await confirmFixtureWriterQuiescence(r.ledger);
            expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'failed', reason: 'hard_ceiling' });
        }
        expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(1);
        expect(candidates()).toHaveLength(1);
    });

    it('idle (report expected) → tick → busy → report → idle: one tool_report commit, one completion notice', async () => {
        const r = rig();
        toGenerating(r, 'mesh_direct');
        expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine' })).rule).toBe('R9r');
        r.advance(P.awaitReportMs - 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'finalizing', terminal: null });
        expect(r.ledger.observe(evd('turn_started', { retro: false }, { at: T0 + 231_000 })).rule).toBe('R12r');
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'generating', data: { falseIdleCount: 1 } });
        r.advance(P.awaitReportMs + 1); // the released hold can no longer expire the attempt
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        const report = r.ledger.observe(evd('worker_report', { outcome: 'completed', summary: { topic: 'mesh.m1.handoff', writer: 'w-dw', seq: 11 }, hasHandoffNotes: false }, { source: 'worker_tool', at: T0 + 256_000 }));
        // The report lands while the session is generating again (after R12r):
        // recorded + await_end (R17g); the idle end that follows commits it (R9t)
        // instead of opening a second await_report window (live rc.44 run 12).
        expect(report.rule).toBe('R17g');
        expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine', at: T0 + 268_000 })).rule).toBe('R9t');
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
        expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(1);
        const notices = rowsOf(r.db, 'notify', 'a1').map((row) => JSON.parse(String(row.payload_json)) as { notify?: string });
        expect(notices.filter((n) => n.notify === 'completed')).toHaveLength(1);
        expect(notices.filter((n) => n.notify === 'candidate')).toHaveLength(0);
    });

    it('a report-capable worker that never reports stays explicitly report-missing and retains ownership after expiry', async () => {
        const r = rig();
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }));
        r.advance(P.awaitReportMs + 1);
        r.ledger.observe(evd('liveness', { result: 'alive' }, { at: r.now }));
        await r.scheduler.tick();
        expectReportMissing(r);
        r.advance(P.awaitReportMs);
        await r.scheduler.tick();
        expectReportMissing(r);
        const notices = rowsOf(r.db, 'notify', 'a1').map(row => JSON.parse(String(row.payload_json)));
        expect(notices.filter(n => n.notify === 'candidate')).toHaveLength(1);
        expect(notices.filter(n => n.notify === 'completed')).toHaveLength(0);
    });
});

// Live rc.43 run 10 (2026-09-24, owner ledger, mesh_direct:ed31090f…, session
// f437e525): R9r opened `await_report` (600 s) at t=0 while the `liveness`
// hold armed by R4/livenessExtend was still running toward its own 480 s
// deadline — the two holds are independent. Once liveness expired at ~480 s,
// H4 re-armed it at the 12 s `unknown_grace` cadence and kept re-arming every
// 12 s for the REST of the await_report window: 11 remote transcript probes
// in under 2 minutes on an attempt already bounded by its own 600 s deadline.
describe('liveness probe backoff during await_report (rc.43 run 10)', () => {
    it('H4 re-arms at the normal 12 s cadence in generating, but backs off to the finalizing interval once await_report is held', async () => {
        const r = rig();
        toGenerating(r);
        // generating: unchanged cadence.
        r.advance(P.livenessDeadlineMs + 1);
        await r.scheduler.tick();
        expect(r.ports.calls.filter((c) => c === 'probe:s1')).toHaveLength(1);
        expect(r.ledger.store.activeHolds('a1').find((h) => h.reason === 'liveness')!.until).toBe(r.now + 12_000);

        // A genuine end with reportExpected opens await_report (R9r) without
        // touching the still-running liveness hold.
        expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true })).rule).toBe('R9r');
        expect(r.ledger.getAttempt('a1')!.state).toBe('finalizing');

        // The pre-existing liveness hold (armed at the *generating* cadence,
        // now re-armed once already above) expires again inside the
        // await_report window: from here every re-arm must use the finalizing
        // interval (60 s default), not 12 s.
        r.advance(12_000 + 1);
        await r.scheduler.tick();
        expect(r.ports.calls.filter((c) => c === 'probe:s1')).toHaveLength(2);
        const rearmed = r.ledger.store.activeHolds('a1').find((h) => h.reason === 'liveness')!;
        expect(rearmed.until).toBe(r.now + P.livenessProbeIntervalFinalizingMs);

        // Simulate the rest of run 10's 2-minute window at the OLD 12 s cadence
        // (what H4 used to re-arm at): with the fix, ticking every 12 s must NOT
        // produce a probe every tick — only every ~60 s.
        const probesBefore = r.ports.calls.filter((c) => c === 'probe:s1').length;
        for (let i = 0; i < 10; i++) {
            r.advance(12_000);
            await r.scheduler.tick();
        }
        const probesAfter = r.ports.calls.filter((c) => c === 'probe:s1').length - probesBefore;
        // 120 s elapsed at a >=60 s floor → at most 2 further probes (break-once:
        // before this fix every 12 s tick produced one, i.e. 10).
        expect(probesAfter).toBeLessThanOrEqual(2);
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull(); // no verdict while the report is missing

        // Expiring await_report records missing proof, independently of H4 cadence.
        r.advance(P.awaitReportMs);
        r.ledger.observe(evd('liveness', { result: 'alive' }, { at: r.now }));
        await r.scheduler.tick();
        expectReportMissing(r);
    });

    it('liveness_unknown (R32u) also backs off while await_report is held', async () => {
        const r = rig();
        toGenerating(r);
        expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true })).rule).toBe('R9r');
        expect(r.ledger.observe(evd('liveness', { result: 'unknown' })).rule).toBe('R32u');
        const hold = r.ledger.store.activeHolds('a1').find((h) => h.reason === 'liveness')!;
        expect(hold.until).toBe(r.now + P.livenessProbeIntervalFinalizingMs);
    });
});


describe('production ledger/scheduler session rebound fencing', () => {
    it.each(['await_report', 'weak_candidate'] as const)('%s rejects stored s1 proof, accepts fresh s2 alive, and respects report ownership', async (reason) => {
        const r = rig();
        toGenerating(r);
        r.ledger.observe(evd('turn_end', reason === 'await_report'
            ? { strength: 'genuine', reportExpected: true } : { strength: 'weak' }));
        const window = reason === 'await_report' ? P.awaitReportMs : weakConfirmMs(P);
        r.advance(window - 10);
        r.ledger.observe(evd('liveness', { result: 'alive', probeStartedAtMs: r.now }, { at: r.now }));
        r.advance(1);
        expect(r.ledger.observe(evd('session_rebound', { toSessionId: 's2', reason: 'restart' }, { at: r.now })).rule).toBe('R26');
        r.advance(10);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')).toMatchObject({ sessionId: 's2', terminal: null, lastLiveness: null });
        expect(r.host.calls).not.toContain('terminal:t1:completed');
        if (reason === 'weak_candidate') expect(r.ledger.getAttempt('a1')!.data.unconfirmedEndDeferral?.count).toBe(1);
        else expectReportMissing(r);
        const late = r.ledger.observe(evd('liveness', { result: 'dead', probeStartedAtMs: r.now - 11 }, { at: r.now }));
        expect(late.verdict).toBe('rejected');
        expect(r.host.calls.some(c => c.startsWith('requeue:'))).toBe(false);
        r.advance(endProbeGraceMs(P) - 1);
        const read = vi.fn(async (attempt) => {
            expect(attempt.sessionId).toBe('s2');
            return { presence: 'present' as const, status: 'generating' };
        });
        const scheduler = createTurnScheduler({ ledger: r.ledger, now: () => r.now,
            probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        scheduler.requestProbe('a1');
        await scheduler.tick();
        expect(read).toHaveBeenCalledOnce();
        r.advance(1);
        await scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.lastLiveness).toBe('alive');
        if (reason === 'await_report') {
            expectReportMissing(r);
            expect(r.ledger.observe(evd('worker_report', { outcome: 'completed', hasHandoffNotes: false },
                { sessionId: 's2', at: r.now, source: 'worker_tool' })).rule).toBe('R17');
            expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' });
        } else expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'weak' });
        expect(r.host.calls.filter(c => c === 'terminal:t1:completed')).toHaveLength(1);
    });

    it.each(['alive', 'dead'] as const)('an in-flight s1 %s read is discarded after rebound; fresh s2 read remains valid', async (verdict) => {
        let r: Rig;
        let rebind = true;
        const read = vi.fn(async () => {
            if (rebind) {
                rebind = false;
                r.advance(1);
                r.ledger.observe(evd('session_rebound', { toSessionId: 's2', reason: 'restart' }, { at: r.now }));
                return { presence: verdict === 'dead' ? 'absent' as const : 'present' as const, status: 'generating' };
            }
            return { presence: 'present' as const, status: 'generating' };
        });
        r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }));
        r.scheduler.requestProbe('a1');
        const tick = await r.scheduler.tick();
        expect(tick.probeEvidence).toBe(0);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ sessionId: 's2', generation: 0, lastLiveness: null, terminal: null });
        r.advance(P.awaitReportMs + 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
        expect(r.ledger.getAttempt('a1')!.lastLiveness).toBe('alive');
        r.advance(endProbeGraceMs(P));
        await r.scheduler.tick();
        expectReportMissing(r);
        expect(r.ledger.getAttempt('a1')!.lastLiveness).toBe('alive');
    });

    it('a restart that returns to the same session id still cuts an in-flight read', async () => {
        let r: Rig;
        const read = vi.fn(async () => {
            r.ledger.observe(evd('session_rebound', { toSessionId: 's1', reason: 'restart' }, { at: r.now }));
            return { presence: 'absent' as const };
        });
        r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read } } });
        toGenerating(r);
        r.scheduler.requestProbe('a1');
        expect((await r.scheduler.tick()).probeEvidence).toBe(0);
        expect(r.ledger.getAttempt('a1')).toMatchObject({ generation: 0, terminal: null, lastLiveness: null });
    });
});


describe('async handoff respects session cuts in the production SQLite scheduler', () => {
    for (const reason of ['await_report', 'weak_candidate'] as const) {
        it.each(['unknown', 'alive', 'dead'] as const)(`${reason}: same-id same-millisecond rebound during handoff discards old evidence; fresh %s stays authoritative`, async (control) => {
            let r: Rig;
            let firstRead = true;
            const read = vi.fn(async (): Promise<TurnProbeRead> => {
                if (firstRead) {
                    firstRead = false;
                    return { presence: 'present', status: 'idle', transcript: {
                        providerObservedStatus: 'idle', activeModal: false, selfAttributing: false,
                        trailingActivity: 0, nativeRead: false, finalAssistantAt: T0 + 1,
                        finalSummary: 'Synthetic handoff before the session cut.',
                    } };
                }
                return control === 'dead' ? { presence: 'absent' }
                    : control === 'unknown' ? { presence: 'unknown' }
                    : { presence: 'present', status: 'generating' };
            });
            const handoff = vi.fn(async () => {
                // The clock and session ID are unchanged; only cut revision fences this await.
                r.ledger.observe(evd('session_rebound', { toSessionId: 's1', reason: 'restart' }, { at: r.now }));
                return { topic: 'mesh.m1.handoff', writer: 'old-session', seq: 1 };
            });
            r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read }, handoff } });
            toGenerating(r);
            r.ledger.observe(evd('turn_end', reason === 'await_report'
                ? { strength: 'genuine', reportExpected: true } : { strength: 'weak' }));
            r.advance(2);
            r.scheduler.requestProbe('a1');
            const stale = await r.scheduler.tick();
            expect(handoff).toHaveBeenCalledOnce();
            expect(stale.probeEvidence).toBe(0);
            expect(stale.probed).toBe(0);
            expect(rowsOf(r.db, 'transcript_final', 'a1')).toHaveLength(0);
            expect(rowsOf(r.db, 'liveness', 'a1')).toHaveLength(0);
            expect(r.ledger.getAttempt('a1')).toMatchObject({ terminal: null, lastLiveness: null });
            r.advance((reason === 'await_report' ? P.awaitReportMs : weakConfirmMs(P)) - 1);
            await r.scheduler.tick();
            expect(r.host.calls).not.toContain('terminal:t1:completed');
            if (control === 'dead') {
                expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
                await confirmFixtureWriterQuiescence(r.ledger);
                expect(r.ledger.getAttempt('a1')).toMatchObject({ generation: 1, state: 'accepted', terminal: null });
                expect(r.host.calls).toContain('requeue:t1');
            } else {
                expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
                r.advance(endProbeGraceMs(P));
                await r.scheduler.tick();
                if (reason === 'await_report') {
                    expectReportMissing(r);
                    expect(r.ledger.getAttempt('a1')!.lastLiveness).toBe(control);
                } else {
                    expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject(control === 'alive'
                        ? { outcome: 'completed', strength: 'weak' }
                        : { outcome: 'failed', reason: 'weak_end_liveness_unconfirmed' });
                    expect(r.host.calls.filter(c => c === 'terminal:t1:completed')).toHaveLength(control === 'alive' ? 1 : 0);
                }
            }
        });
    }

    it.each(['rejected_restart', 'reclaim', 'accepted_report'] as const)('handoff boundary fences %s and preserves report/correction authority', async (change) => {
        let r: Rig;
        const handoff = vi.fn(async () => {
            if (change === 'accepted_report') r.ledger.observe(evd('worker_report', { outcome: 'completed', hasHandoffNotes: false }, { source: 'worker_tool', at: r.now }));
            else if (change === 'reclaim') r.ledger.observe(evd('process_exit', { exitCode: 1 }, { at: r.now }));
            else {
                r.ledger.observe(evd('session_rebound', { toSessionId: 's1', reason: 'restart' }, { at: r.now }));
                throw new Error('Synthetic handoff rejection after the cut');
            }
            return { topic: 'mesh.m1.handoff', writer: 'pre-cut', seq: 1 };
        });
        const read = vi.fn(async (): Promise<TurnProbeRead> => ({ presence: 'present', status: 'idle', transcript: {
            providerObservedStatus: 'idle', activeModal: false, selfAttributing: false, trailingActivity: 0,
            nativeRead: false, finalAssistantAt: T0 + 1, finalSummary: 'Synthetic handoff boundary.',
        } }));
        r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read }, handoff } });
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }));
        r.ledger.observe(evd('worker_report_correction_requested', { deliveryId: 'synthetic-refusal' }, { source: 'worker_tool', at: r.now }));
        const correction = r.ledger.getAttempt('a1')!.data.reportCorrection;
        r.advance(2);
        r.scheduler.requestProbe('a1');
        expect((await r.scheduler.tick()).probeEvidence).toBe(0);
        expect(rowsOf(r.db, 'transcript_final', 'a1')).toHaveLength(0);
        expect(rowsOf(r.db, 'liveness', 'a1')).toHaveLength(0);
        if (change === 'accepted_report') expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' });
        else if (change === 'reclaim') {
            expect(r.ledger.getAttempt('a1')).toMatchObject({ generation: 0, state: 'stopping', terminal: null });
            await confirmFixtureWriterQuiescence(r.ledger);
            expect(r.ledger.getAttempt('a1')).toMatchObject({ generation: 1, state: 'accepted', terminal: null });
        }
        else {
            expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();
            expect(r.ledger.getAttempt('a1')!.data.reportCorrection).toEqual(correction);
        }
    });

    it.each([false, true])('a post-cut probe cannot reuse a %s pre-cut memo (false = handoff returned after cut)', async (warmMemo) => {
        let r: Rig;
        let calls = 0;
        const summary = { topic: 'mesh.m1.handoff', writer: 'fresh-session', seq: 2 };
        const handoff = vi.fn(async () => {
            calls++;
            if (!warmMemo && calls === 1) r.ledger.observe(evd('session_rebound', { toSessionId: 's1', reason: 'restart' }, { at: r.now }));
            return calls === 1 ? { ...summary, writer: 'old-session', seq: 1 } : summary;
        });
        const read = vi.fn(async (): Promise<TurnProbeRead> => ({ presence: 'present', status: 'idle', transcript: {
            providerObservedStatus: 'idle', activeModal: false, selfAttributing: false, trailingActivity: 0,
            nativeRead: false, finalAssistantAt: T0 + 1, finalSummary: 'Synthetic identical bubble across cut.',
        } }));
        r = rig({ probe: { locate: () => ({ kind: 'local' }), reader: { read }, handoff } });
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }));
        r.advance(2);
        r.scheduler.requestProbe('a1');
        await r.scheduler.tick();
        if (warmMemo) r.ledger.observe(evd('session_rebound', { toSessionId: 's1', reason: 'restart' }, { at: r.now }));
        // Keep the final bubble timestamp identical; only the cut distinguishes memo ownership.
        r.advance(1);
        r.scheduler.requestProbe('a1');
        await r.scheduler.tick();
        expect(handoff).toHaveBeenCalledTimes(2);
        const events = rowsOf(r.db, 'transcript_final', 'a1');
        expect(events).toHaveLength(warmMemo ? 2 : 1);
        expect(JSON.parse(String(events.at(-1)!.payload_json))).toMatchObject({ evidence: { summary } });
    });
});
