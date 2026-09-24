import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from '../../src/mesh/turn-ledger/policy.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { renderNotice } from '../../src/mesh/turn-ledger/deliver.js';
import { observeAcceptedWorkerReport } from '../../src/mesh/turn-ledger/worker-report-evidence.js';
import { LIVE_IDLE, T0, dispatch, evd, fakePublisher, ledgerOn, memDb, recordingHost, recordingPorts, rowsOf } from './ledger-harness.js';

// Live preview rc.44, run 12 (2026-09-24 UTC, owner ledger, attempt
// mesh_direct:081e9cb8…, MainPC claude-cli worker with a live worker-MCP bind):
//   15:07:12 turn_started R4 → 15:07:19 progress → 15:07:34 turn_end R9r (false
//   idle during `sleep 300`, await_report 600 s — correct) → 15:12:25
//   turn_started R12r (correct) → 15:12:29 progress → 15:12:36 report ACCEPTED
//   while generating → 15:12:47 turn_end R9r opened ANOTHER 600 s await_report
//   → committed WEAK at ~15:22:47 (R13r), the report's summary already on file.
// The report never reached the reducer. Now: the accepted report is observed
// (worker_report); while generating it is recorded + an `await_end` hold
// (R17g); the idle end commits it (R9t); with no idle end the hold's expiry
// commits it (R13t); after the idle edge (finalizing) it commits at once (R17).

const P: TurnPolicy = DEFAULT_TURN_POLICY;
const SUMMARY_TEXT = 'RUN12-T1 done: slept 300s, progress noted twice.';

function rig() {
    const db = memDb();
    let now = T0;
    const ports = recordingPorts();
    const host = recordingHost();
    const ledger = ledgerOn(db, { now: () => now, ports, host, publisher: fakePublisher() });
    const scheduler = createTurnScheduler({ ledger, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} }, claim: vi.fn() });
    return {
        db, ledger, host, scheduler,
        /** Moves the ledger clock to T0 + ms. */
        at(ms: number) { now = T0 + ms; return now; },
    };
}
type Rig = ReturnType<typeof rig>;

const S = 1_000;

/** Run 12 up to the report: R4 → progress → R9r (false idle) → R12r (resumed) → progress. */
function toResumed(r: Rig, scope: 'mesh_direct' | 'mesh_queue') {
    expect(r.ledger.observe(dispatch({ scope })).rule).toBe('R1');
    expect(r.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'p2p' }, { source: 'dispatch' })).rule).toBe('R2');
    r.at(20 * S);
    expect(r.ledger.observe(evd('turn_started', { retro: false }, { at: T0 + 20 * S })).rule).toBe('R4');
    r.at(27 * S);
    expect(r.ledger.observe(evd('worker_progress', {}, { source: 'worker_tool', at: T0 + 27 * S })).rule).toBe('R17p');
    r.at(42 * S);
    expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine', at: T0 + 42 * S })).rule).toBe('R9r');
    r.at(333 * S);
    expect(r.ledger.observe(evd('turn_started', { retro: false }, { at: T0 + 333 * S })).rule).toBe('R12r');
    r.at(337 * S);
    expect(r.ledger.observe(evd('worker_progress', {}, { source: 'worker_tool', at: T0 + 337 * S })).rule).toBe('R17p');
    expect(r.ledger.getAttempt('a1')).toMatchObject({ state: 'generating', terminal: null });
}

/** The accepted report, through the production producer (envelope = the report's text). */
function report(r: Rig, atS: number, outcome: 'completed' | 'failed' | 'blocked' = 'completed') {
    r.at(atS * S);
    return observeAcceptedWorkerReport(r.ledger, {
        meshId: 'm1', taskId: 't1', attemptId: 'a1', sessionId: 's1', outcome, summary: SUMMARY_TEXT,
        hasHandoffNotes: true, touchedFileCount: 0, atMs: T0 + atS * S,
    })!;
}

function completionNotices(r: Rig) {
    return rowsOf(r.db, 'notify', 'a1')
        .map((row) => ({ row, payload: JSON.parse(String(row.payload_json)) as { notify?: string; textEventId?: string; entry?: Record<string, unknown> } }))
        .filter(({ payload }) => payload.notify === 'completed' || payload.notify === 'failed');
}

function renderedCompletion(r: Rig): string {
    const [notice] = completionNotices(r);
    const row = r.ledger.store.getEvent(String(notice!.row.event_id))!;
    return renderNotice({ ledger: r.ledger }, 'm1', notice!.payload.entry!, row).text;
}

describe('rc.44 run 12 — a report recorded before the idle edge commits on it, never a second await_report', () => {
    for (const scope of ['mesh_direct', 'mesh_queue'] as const) {
        it(`${scope}: report while generating opens await_end; the idle end commits genuine (tool_report) with the report's text, one notice`, () => {
            const r = rig();
            toResumed(r, scope);

            const reported = report(r, 344);
            expect(reported.rule).toBe('R17g');
            expect(reported.attempt).toMatchObject({ state: 'generating', terminal: null });
            expect(reported.attempt!.data.report).toMatchObject({ generation: 0, outcome: 'completed' });
            const holds = r.ledger.store.activeHolds('a1');
            expect(holds.find((h) => h.reason === 'await_end')).toMatchObject({ until: T0 + 344 * S + P.awaitEndMs, onExpire: 'commit' });
            expect(holds.some((h) => h.reason === 'await_report')).toBe(false);
            expect(completionNotices(r)).toHaveLength(0);
            expect(r.host.calls.filter((c) => c.startsWith('graph:'))).toEqual([]);

            // 15:12:47 — the idle end: committed from the report, NOT a second R9r.
            r.at(355 * S);
            const end = r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine', at: T0 + 355 * S }));
            expect(end.rule).toBe('R9t');
            expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
            expect(r.ledger.store.activeHolds('a1')).toEqual([]); // await_end released, no await_report opened
            expect(rowsOf(r.db, 'turn_end', 'a1').map((row) => row.rule)).toEqual(['R9r', 'R9t']);
            expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(1);
            expect(r.host.calls.filter((c) => c.startsWith('graph:'))).toEqual(['graph:t1:completed']);

            // Exactly one completion notice, rendered from the REPORT's evidence row.
            const notices = completionNotices(r);
            expect(notices).toHaveLength(1);
            expect(notices[0]!.payload.textEventId).toBe(reported.attempt!.data.report!.eventId);
            expect(renderedCompletion(r)).toContain(SUMMARY_TEXT);

            // Later idle evidence is recorded after the report, no second notice (R18).
            r.at(400 * S);
            expect(r.ledger.observe(evd('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }, { source: 'coordinator_probe' })).rule).toBe('R18');
            expect(completionNotices(r)).toHaveLength(1);
        });

        it(`${scope}: no idle end after the report → the await_end expiry commits genuine (tool_report), one notice`, async () => {
            const r = rig();
            toResumed(r, scope);
            expect(report(r, 344).rule).toBe('R17g');

            r.at(344 * S + P.awaitEndMs - 1);
            await r.scheduler.tick();
            expect(r.ledger.getAttempt('a1')!.terminal).toBeNull();

            r.at(344 * S + P.awaitEndMs + 1);
            await r.scheduler.tick();
            expect(rowsOf(r.db, 'hold_expired', 'a1').map((row) => row.rule)).toContain('R13t');
            expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
            expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(1);
            expect(completionNotices(r)).toHaveLength(1);
            expect(renderedCompletion(r)).toContain(SUMMARY_TEXT);
        });

        it(`${scope}: a report during finalizing (await_report open) still commits at once (R17), one notice`, () => {
            const r = rig();
            toResumed(r, scope);
            r.at(350 * S);
            expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine', at: T0 + 350 * S })).rule).toBe('R9r');
            expect(r.ledger.getAttempt('a1')!.state).toBe('finalizing');

            const reported = report(r, 360);
            expect(reported.rule).toBe('R17');
            expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
            expect(r.ledger.store.activeHolds('a1')).toEqual([]);
            expect(rowsOf(r.db, 'committed', 'a1')).toHaveLength(1);
            expect(completionNotices(r)).toHaveLength(1);
            expect(renderedCompletion(r)).toContain(SUMMARY_TEXT);
        });
    }

    it('a blocked report before the idle edge commits failed on the idle end', () => {
        const r = rig();
        toResumed(r, 'mesh_direct');
        expect(report(r, 344, 'blocked').rule).toBe('R17g');
        r.at(355 * S);
        expect(r.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine', at: T0 + 355 * S })).rule).toBe('R9t');
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'failed', strength: 'tool_report', reason: 'worker_reported' });
        expect(completionNotices(r).map((n) => n.payload.notify)).toEqual(['failed']);
    });

    it('a re-called report dedupes (same attempt/generation/outcome)', () => {
        const r = rig();
        toResumed(r, 'mesh_direct');
        expect(report(r, 344).rule).toBe('R17g');
        expect(report(r, 346).verdict).toBe('duplicate');
        expect(r.ledger.store.activeHolds('a1').find((h) => h.reason === 'await_end')!.until).toBe(T0 + 344 * S + P.awaitEndMs);
    });

    it('a report of a reclaimed generation no longer satisfies the guard (R9t is generation-scoped)', () => {
        const r = rig();
        toResumed(r, 'mesh_queue');
        expect(report(r, 344).rule).toBe('R17g');
        // The session dies before the idle edge: reclaim to generation 1.
        r.at(346 * S);
        expect(r.ledger.observe(evd('liveness', { result: 'dead' }, { source: 'coordinator_probe' })).rule).toBe('R31');
        const reclaimed = r.ledger.getAttempt('a1')!;
        expect(reclaimed).toMatchObject({ generation: 1, state: 'accepted' });
        expect(r.ledger.store.activeHolds('a1').some((h) => h.reason === 'await_end')).toBe(false);
        // g1 runs; its own idle end must NOT commit g0's report.
        const g1 = { attemptRef: { attemptId: 'a1', generation: 1 }, sessionId: 's2' };
        r.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'p2p' }, { ...g1, source: 'dispatch' }));
        expect(r.ledger.observe(evd('turn_started', { retro: false }, g1)).rule).toBe('R4');
        expect(r.ledger.observe(evd('turn_end', { strength: 'genuine' }, g1)).rule).toBe('R9');
        expect(r.ledger.getAttempt('a1')!.terminal).toMatchObject({ strength: 'genuine', reason: 'turn_end' });
    });
});
