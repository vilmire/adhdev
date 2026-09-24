import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURN_POLICY, awaitDeliveryMs, weakConfirmMs, holdTtlMs, type TurnPolicy } from '../../src/mesh/turn-ledger/policy.js';
import {
    createLateBoundProbePort,
    createTurnScheduler,
    PLAIN_ATTEMPT_PRUNE_INTERVAL_MS,
    startTurnScheduler,
    type TurnSchedulerProbe,
} from '../../src/mesh/turn-ledger/scheduler.js';
import type { TurnProbeRead } from '../../src/mesh/turn-ledger/probe.js';
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import {
    LIVE_IDLE, T0, dispatch, evd, fakePublisher, ledgerOn, memDb, pendingCount, recordingHost, recordingPorts, rowsOf,
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
        expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'accepted', generation: 1 });
        expect(r.host.calls).toContain('requeue:t1');
    });

    it('hard_ceiling (H5): an open attempt past the ceiling commits failed(hard_ceiling) and advances the graph', async () => {
        const r = rig();
        toGenerating(r);
        r.advance(P.hardCeilingMs + 1);
        await r.scheduler.tick();
        const attempt = r.ledger.getAttempt('a1')!;
        expect(attempt.terminal).toMatchObject({ outcome: 'failed', reason: 'hard_ceiling' });
        expect(r.host.calls).toContain('graph:t1:failed');
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
        // A plain turn: unbound turn_started opens it (R0a), a genuine end commits it.
        r.ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 'dash-1' }));
        const plain = r.ledger.openAttemptForSession('dash-1')!;
        expect(plain.scope).toBe('plain');
        r.ledger.observe(evd('turn_end', { strength: 'genuine' }, { attemptRef: { attemptId: plain.attemptId, generation: 0 }, sessionId: 'dash-1' }));
        expect(r.ledger.isTerminal(plain.attemptId)).toBe(true);

        const WEEK = 7 * 24 * 60 * 60_000;
        r.advance(WEEK - 10 * 60_000);
        expect((await r.scheduler.tick()).pruned).toBe(0); // first pass: not old enough yet
        r.advance(20 * 60_000); // now 7 d + 10 min old — but only 20 min since the last pass
        expect((await r.scheduler.tick()).pruned).toBe(0);
        r.advance(PLAIN_ATTEMPT_PRUNE_INTERVAL_MS);
        expect((await r.scheduler.tick()).pruned).toBe(1);
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
        expect(r.host.calls.filter((c) => c.startsWith('graph:'))).toEqual([]);
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

// Live rc.40 run 5 (2026-09-24, task 9315fa4d): idle 16 s into a `sleep 240` turn,
// busy again 4 min later, report at 08:18:42, idle again. The owner used to commit
// genuine at the first idle; with the report gate the attempt stays open through
// the false idle and commits ONCE, on the report.
describe('report gate — the rc.40 false-idle sequence commits once, on the report', () => {
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

    it('a report-capable worker that never reports is committed weak once the await_report window passes', async () => {
        const r = rig();
        toGenerating(r);
        r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }));
        r.advance(P.awaitReportMs + 1);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });
        expect(r.host.calls).toContain('graph:t1:completed');
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
        expect(r.ledger.getAttempt('a1')!.terminal).toBeNull(); // await_report's own 600 s deadline still governs the commit, untouched

        // The R13r commit path is unaffected: it still fires off the
        // await_report hold's own deadline, not the liveness hold.
        r.advance(P.awaitReportMs);
        await r.scheduler.tick();
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });
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
