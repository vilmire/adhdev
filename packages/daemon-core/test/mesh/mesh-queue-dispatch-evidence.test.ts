import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { openOrResumeQueueAttempt, queueAttemptId } from '../../src/mesh/mesh-queue-dispatch-evidence.js';
import { dispatch as _unused, evd, ledgerOn, memDb, recordingHost, T0 } from '../turn-ledger/ledger-harness.js';

// C2/C4 (C-W4): the queue claim reports EVIDENCE; the reducer opens, binds,
// reclaims and commits. No legacy attempt writer and no terminal
// updateTaskStatus is left on the claim/dispatch path.

void _unused;

const MESH = 'm1';
const TASK = { id: 't1', dispatchNonce: 3, sourceCoordinatorSessionId: 'coord-s' };

function open(ledger: ReturnType<typeof ledgerOn>, sessionId = 's1') {
    return openOrResumeQueueAttempt(ledger, {
        meshId: MESH, task: TASK, nodeId: 'n1', sessionId, providerType: 'claude-cli',
        consumeProfile: 'default', maxTaskRetries: 1, coordinatorDaemonId: 'daemon_mach_c', now: T0,
    });
}

describe('openOrResumeQueueAttempt', () => {
    it('a first claim observes dispatch_accepted → R1 opens attempt #0 with await_delivery + hard_ceiling holds', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost() });
        const opened = open(ledger);
        expect(opened).toEqual({ ref: { attemptId: queueAttemptId(MESH, 't1', 0), generation: 0 } });
        const attempt = ledger.getAttempt(queueAttemptId(MESH, 't1', 0))!;
        expect(attempt).toMatchObject({
            scope: 'mesh_queue', state: 'accepted', meshId: MESH, taskId: 't1', attemptNo: 0, sessionId: 's1',
            messageId: 'task:t1:n3', dispatchNonce: 3, coordinator: { daemonId: 'daemon_mach_c', sessionId: 'coord-s' },
        });
        expect(ledger.store.activeHolds(attempt.attemptId).map((h) => h.reason).sort()).toEqual(['await_delivery', 'hard_ceiling']);
    });

    it('re-claiming after a reclaim RESUMES the same attempt under the new generation (no second dispatch_accepted)', () => {
        const db = memDb();
        const host = recordingHost();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host });
        const first = open(ledger) as { ref: { attemptId: string; generation: number } };
        const reclaim = ledger.observe(evd('dispatch_failed', { workerAbsent: false, reason: 'transport_error' }, {
            source: 'dispatch', attemptRef: first.ref, sessionId: 's1', observedBy: 'daemon_mach_c',
        }));
        expect(reclaim.rule).toBe('R24');
        expect(host.calls).toContain('requeue:t1');
        const again = open(ledger, 's2');
        expect(again).toEqual({ ref: { attemptId: first.ref.attemptId, generation: 1 } });
        expect((db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE kind = 'dispatch_accepted'`).get() as { n: number }).n).toBe(1);
    });

    it('refuses to inject into an attempt that already consumed a prompt', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost() });
        const first = open(ledger) as { ref: { attemptId: string; generation: number } };
        ledger.observe(evd('delivered', { messageId: 'task:t1:n3', outcome: 'delivered', via: 'local' }, { source: 'dispatch', attemptRef: first.ref, observedBy: 'daemon_mach_c' }));
        ledger.observe(evd('turn_started', { retro: false }, { attemptRef: first.ref }));
        const refused = open(ledger);
        expect('refused' in refused && refused.refused.state).toBe('generating');
    });

    it('a terminal latest attempt is a retry: attemptNo + 1 opens a fresh row', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost() });
        const first = open(ledger) as { ref: { attemptId: string; generation: number } };
        ledger.observe(evd('session_error', { reason: 'spawn_failed' }, { source: 'dispatch', attemptRef: first.ref, observedBy: 'daemon_mach_c' }));
        expect(ledger.isTerminal(first.ref.attemptId)).toBe(true);
        expect(open(ledger)).toEqual({ ref: { attemptId: queueAttemptId(MESH, 't1', 1), generation: 0 } });
    });
});

describe('claim/dispatch path source shape (C-W4 retirements)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../src/mesh/mesh-queue-assignment.ts'), 'utf8');

    it('no legacy attempt writer is called any more', () => {
        expect(src).not.toMatch(/\b(openTurnAttempt|recordTurnAck|closeAttemptForReassignment|rebindAttemptToLiveHolder|recordDuplicateDispatchConsumption|recordAckedHoldDispatchOutcome|assertPromptInjectionAllowed)\(/);
        expect(src).not.toMatch(/from '\.\/mesh-turn-ledger\.js'/);
    });

    it('no terminal queue status is written directly (only the non-terminal pending requeue remains)', () => {
        const calls = [...src.matchAll(/updateTaskStatus\(([^)]*)\)/g)].map((m) => m[1]!);
        expect(calls.length).toBeGreaterThan(0);
        for (const args of calls) expect(args, args).toMatch(/'pending'/);
    });

    it('every transport outcome is reported as evidence', () => {
        for (const kind of ['delivered', 'dispatch_failed', 'duplicate_dispatch_refusal', 'session_error']) {
            expect(src, kind).toMatch(new RegExp(`kind: '${kind}'`));
        }
        expect(src).toMatch(/openOrResumeQueueAttempt\(turnLedger,/);
    });
});
