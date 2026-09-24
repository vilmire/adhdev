import { describe, expect, it, vi } from 'vitest';
import { dispatch, evd, ledgerOn, memDb } from './ledger-harness.js';
import { reconcileOrphanedPlainAttempts } from '../../src/mesh/turn-ledger/reconcile.js';

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
