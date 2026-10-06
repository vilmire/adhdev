import { describe, expect, it, vi } from 'vitest';
import { dispatch, evd, ledgerOn, memDb, T0 } from './ledger-harness.js';
import { closeInterruptedPlainAttempts, reconcileOrphanedPlainAttempts } from '../../src/mesh/turn-ledger/reconcile.js';

// Wiring-unification follow-up (design §5, §11 "2026-09-25 (02:30…)": a plain
// turn attempt orphaned by a daemon restart stays `generating` forever — R0a
// opens a plain attempt with NO hold (unlike a mesh attempt's hard_ceiling),
// so nothing ever closes it if the session dies without process_exit/
// session_error evidence. This module feeds ONE session_error observation
// through ledger.observe() per orphan so R21 (nonterminal → failed) closes it
// — the reducer stays the only thing that mutates the attempt.

function openPlainAttempt(ledger: ReturnType<typeof ledgerOn>, sessionId: string) {
    const result = ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId }));
    expect(result.rule).toBe('R0a');
    return result.attempt!;
}

describe('reconcileOrphanedPlainAttempts', () => {
    it('closes a plain attempt whose session is gone (daemon_restart), via the reducer — not a direct row write', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const attempt = openPlainAttempt(ledger, 'gone-1');
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('generating');

        const isSessionLive = vi.fn(() => false);
        const report = reconcileOrphanedPlainAttempts({ ledger, isSessionLive });

        expect(isSessionLive).toHaveBeenCalledWith('gone-1');
        expect(report).toEqual({ checked: 1, closed: 1, closedAttemptIds: [attempt.attemptId] });
        const closed = ledger.getAttempt(attempt.attemptId)!;
        expect(closed.state).toBe('failed');
        expect(closed.terminal).toMatchObject({ outcome: 'failed', reason: 'session_error', source: 'session_registry' });
    });

    it('a plain attempt whose session IS live is left open, untouched', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const attempt = openPlainAttempt(ledger, 'live-1');

        const isSessionLive = vi.fn(() => true);
        const report = reconcileOrphanedPlainAttempts({ ledger, isSessionLive });

        expect(report).toEqual({ checked: 1, closed: 0, closedAttemptIds: [] });
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('generating');
    });

    it('a mesh attempt with an active hold (hard_ceiling from dispatch_accepted) is never touched, even if its session is gone', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const opened = ledger.observe(dispatch({ scope: 'mesh_direct', session: 'mesh-s1', attemptId: 'am1' }));
        expect(opened.rule).toBe('R1');
        expect(ledger.store.activeHolds('am1').some((h) => h.reason === 'hard_ceiling')).toBe(true);

        const isSessionLive = vi.fn(() => false);
        const report = reconcileOrphanedPlainAttempts({ ledger, isSessionLive });

        // Mesh attempts are filtered out before the liveness check ever runs.
        expect(isSessionLive).not.toHaveBeenCalled();
        expect(report).toEqual({ checked: 0, closed: 0, closedAttemptIds: [] });
        expect(ledger.getAttempt('am1')?.state).toBe('accepted');
        expect(ledger.store.activeHolds('am1').some((h) => h.reason === 'hard_ceiling')).toBe(true);
    });

    it('an already-terminal plain attempt is not open, so it is never a candidate (idempotent across calls)', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const attempt = openPlainAttempt(ledger, 'gone-2');
        const isSessionLive = () => false;
        expect(reconcileOrphanedPlainAttempts({ ledger, isSessionLive })).toMatchObject({ closed: 1 });
        // Second call: the attempt is now terminal, so listOpenAttempts no longer returns it.
        const second = reconcileOrphanedPlainAttempts({ ledger, isSessionLive });
        expect(second).toEqual({ checked: 0, closed: 0, closedAttemptIds: [] });
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('failed');
    });

    it('BREAK-ONCE: without reconciliation the orphaned plain attempt stays generating forever', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const attempt = openPlainAttempt(ledger, 'gone-3');
        // No call to reconcileOrphanedPlainAttempts here — simulates the bug.
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('generating');
        expect(ledger.store.listOpenAttempts().map((a) => a.attemptId)).toContain(attempt.attemptId);
    });

    it('a liveness-check throw skips the attempt rather than closing it (never close on uncertainty)', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        const attempt = openPlainAttempt(ledger, 'flaky-1');
        const isSessionLive = () => { throw new Error('registry unavailable'); };
        const report = reconcileOrphanedPlainAttempts({ ledger, isSessionLive });
        expect(report).toEqual({ checked: 1, closed: 0, closedAttemptIds: [] });
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('generating');
    });
});

// Assistant-layer design 2026-10-07, appendix B item 2 (measured live): a
// coordinator turn is mid-flight (plain attempt, R0a, `generating`) when the
// daemon restarts; the hosted session survives and is restored live + idle.
// The liveness-only sweep keeps the stale attempt open, so the next human
// `turn_started` lands on it as R32 activity and the two turns commit as one
// under the old attemptId. Pass 1 (`closeInterruptedPlainAttempts`, run before
// restore) closes every plain attempt a previous incarnation opened.
describe('closeInterruptedPlainAttempts (restart with the session restored live)', () => {
    const RESTART_GAP_MS = 60_000;

    function previousIncarnationOpened(sessionId: string) {
        const db = memDb();
        const before = ledgerOn(db, { now: () => T0 });
        const opened = before.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId, at: T0 }));
        expect(opened.rule).toBe('R0a');
        // "Restart": a new ledger incarnation over the same persisted db.
        const after = ledgerOn(db, { now: () => T0 + RESTART_GAP_MS });
        expect(after.incarnationStartedAt).toBe(T0 + RESTART_GAP_MS);
        return { db, after, stale: opened.attempt! };
    }

    it('closes the pre-restart attempt (failed/session_error, never a completion); the next turn opens a fresh attempt and commits on its own', () => {
        const { after, stale } = previousIncarnationOpened('coord-1');

        const report = closeInterruptedPlainAttempts({ ledger: after });
        expect(report).toEqual({ checked: 1, closed: 1, closedAttemptIds: [stale.attemptId] });
        // Restore resolves with the session live; the liveness pass leaves nothing else to do.
        expect(reconcileOrphanedPlainAttempts({ ledger: after, isSessionLive: () => true })).toEqual({ checked: 0, closed: 0, closedAttemptIds: [] });

        const closed = after.getAttempt(stale.attemptId)!;
        expect(closed.state).toBe('failed');
        expect(closed.terminal).toMatchObject({ outcome: 'failed', reason: 'session_error', source: 'session_registry' });
        expect(closed.terminal?.outcome).not.toBe('completed');

        // The restored session's next (human) turn.
        const at = T0 + RESTART_GAP_MS + 5_000;
        const next = after.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 'coord-1', at }));
        expect(next.rule).toBe('R0a');
        expect(next.attempt!.attemptId).not.toBe(stale.attemptId);

        const end = after.observe(evd('turn_end', { strength: 'genuine' }, { attemptRef: undefined, sessionId: 'coord-1', at: at + 10_000 }));
        expect(end.attempt?.attemptId).toBe(next.attempt!.attemptId);
        expect(after.getAttempt(next.attempt!.attemptId)?.state).toBe('completed');
        // The stale attempt stays the honest failure it was closed as.
        expect(after.getAttempt(stale.attemptId)?.state).toBe('failed');
    });

    it('BREAK-ONCE: with only the liveness sweep, the next turn is absorbed into the stale attempt (R32) — the measured defect', () => {
        const { after, stale } = previousIncarnationOpened('coord-2');
        expect(reconcileOrphanedPlainAttempts({ ledger: after, isSessionLive: () => true })).toMatchObject({ closed: 0 });
        const next = after.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 'coord-2', at: T0 + RESTART_GAP_MS + 5_000 }));
        expect(next.rule).toBe('R32');
        expect(next.attempt!.attemptId).toBe(stale.attemptId);
    });

    it('leaves an attempt THIS incarnation opened alone', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { now: () => T0 });
        const own = ledger.observe(evd('turn_started', { retro: false }, { attemptRef: undefined, sessionId: 'own-1', at: T0 }));
        expect(own.rule).toBe('R0a');
        expect(closeInterruptedPlainAttempts({ ledger })).toEqual({ checked: 1, closed: 0, closedAttemptIds: [] });
        expect(ledger.getAttempt(own.attempt!.attemptId)?.state).toBe('generating');
    });

    it('never touches a pre-restart mesh attempt (its hard_ceiling hold owns closure)', () => {
        const db = memDb();
        const before = ledgerOn(db, { now: () => T0 });
        expect(before.observe(dispatch({ scope: 'mesh_direct', session: 'mesh-s1', attemptId: 'am1' })).rule).toBe('R1');
        const after = ledgerOn(db, { now: () => T0 + RESTART_GAP_MS });
        expect(closeInterruptedPlainAttempts({ ledger: after })).toEqual({ checked: 0, closed: 0, closedAttemptIds: [] });
        expect(after.getAttempt('am1')?.state).toBe('accepted');
        expect(after.store.activeHolds('am1').some((h) => h.reason === 'hard_ceiling')).toBe(true);
    });

    it('is idempotent across calls', () => {
        const { after, stale } = previousIncarnationOpened('coord-3');
        expect(closeInterruptedPlainAttempts({ ledger: after })).toMatchObject({ closed: 1 });
        expect(closeInterruptedPlainAttempts({ ledger: after })).toEqual({ checked: 0, closed: 0, closedAttemptIds: [] });
        expect(after.getAttempt(stale.attemptId)?.state).toBe('failed');
    });
});
