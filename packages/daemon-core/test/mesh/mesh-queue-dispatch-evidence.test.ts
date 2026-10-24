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
const confirmedStop = (r: any) => ({ ...r, success: true, quiescent: true, incarnation: 'fixture-native-writer' });
const drainStop = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

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
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost(), ports: { cancelDispatch: confirmedStop } });
        const opened = open(ledger);
        expect(opened).toEqual({ ref: { attemptId: queueAttemptId(MESH, 't1', 0), generation: 0 } });
        const attempt = ledger.getAttempt(queueAttemptId(MESH, 't1', 0))!;
        expect(attempt).toMatchObject({
            scope: 'mesh_queue', state: 'accepted', meshId: MESH, taskId: 't1', attemptNo: 0, sessionId: 's1',
            messageId: 'task:t1:n3', dispatchNonce: 3, coordinator: { daemonId: 'daemon_mach_c', sessionId: 'coord-s' },
        });
        expect(ledger.store.activeHolds(attempt.attemptId).map((h) => h.reason).sort()).toEqual(['await_delivery', 'hard_ceiling']);
    });

    it('re-claiming after confirmed quiescence resumes the same attempt under the new generation', async () => {
        const db = memDb();
        const host = recordingHost();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host, ports: { cancelDispatch: confirmedStop } });
        const first = open(ledger) as { ref: { attemptId: string; generation: number } };
        const reclaim = ledger.observe(evd('dispatch_failed', { workerAbsent: false, reason: 'transport_error' }, {
            source: 'dispatch', attemptRef: first.ref, sessionId: 's1', observedBy: 'daemon_mach_c',
        }));
        expect(reclaim.rule).toBe('R24');
        expect(reclaim.attempt?.state).toBe('stopping');
        await drainStop();
        expect(host.calls).toContain('requeue:t1');
        const again = open(ledger, 's2');
        expect(again).toEqual({ ref: { attemptId: first.ref.attemptId, generation: 1 } });
        expect((db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE kind = 'dispatch_accepted'`).get() as { n: number }).n).toBe(1);
    });

    it('refuses to inject into an attempt that already consumed a prompt', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost(), ports: { cancelDispatch: confirmedStop } });
        const first = open(ledger) as { ref: { attemptId: string; generation: number } };
        ledger.observe(evd('delivered', { messageId: 'task:t1:n3', outcome: 'delivered', via: 'local' }, { source: 'dispatch', attemptRef: first.ref, observedBy: 'daemon_mach_c' }));
        ledger.observe(evd('turn_started', { retro: false }, { attemptRef: first.ref }));
        const refused = open(ledger);
        expect('refused' in refused && refused.refused.state).toBe('generating');
    });

    it('a terminal latest attempt is a retry: attemptNo + 1 opens a fresh row', async () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost(), ports: { cancelDispatch: confirmedStop } });
        const first = open(ledger) as { ref: { attemptId: string; generation: number } };
        ledger.observe(evd('session_error', { reason: 'spawn_failed' }, { source: 'dispatch', attemptRef: first.ref, observedBy: 'daemon_mach_c' }));
        await drainStop();
        expect(ledger.isTerminal(first.ref.attemptId)).toBe(true);
        expect(open(ledger)).toEqual({ ref: { attemptId: queueAttemptId(MESH, 't1', 1), generation: 0 } });
    });
});

describe('openOrResumeQueueAttempt — retry after a rejected open', () => {
    const OTHER = { id: 't0', dispatchNonce: 1, sourceCoordinatorSessionId: 'coord-s' };
    const openTask = (ledger: ReturnType<typeof ledgerOn>, task: typeof TASK) => openOrResumeQueueAttempt(ledger, {
        meshId: MESH, task, nodeId: 'n1', sessionId: 's1', providerType: 'claude-cli',
        consumeProfile: 'default', maxTaskRetries: 1, coordinatorDaemonId: 'daemon_mach_c', now: T0,
    });

    // Live 2026-10-11: the first claim of a task was rejected (the session still
    // held the previous task's open attempt). The claim retried 4 s later with the
    // SAME `dispatch:<attemptId>` event id, the ledger answered `duplicate`, and the
    // task was dispatched with a ref to an attempt that was never opened — every
    // worker report then failed `unknown_attempt` and the queue row stayed assigned.
    it('never returns a ref for an attempt the ledger did not open', async () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost(), ports: { cancelDispatch: confirmedStop } });
        const held = openTask(ledger, OTHER) as { ref: { attemptId: string; generation: number } };
        expect(() => openTask(ledger, TASK)).toThrow(/dispatch_accepted rejected/);
        expect(ledger.getAttempt(queueAttemptId(MESH, 't1', 0))).toBeFalsy();

        // The session frees up; the claim path retries the same task.
        ledger.observe(evd('session_error', { reason: 'spawn_failed' }, { source: 'dispatch', attemptRef: held.ref, observedBy: 'daemon_mach_c' }));
        await drainStop();
        const retried = openTask(ledger, TASK);
        expect(retried).toEqual({ ref: { attemptId: queueAttemptId(MESH, 't1', 0), generation: 0 } });
        expect(ledger.getAttempt(queueAttemptId(MESH, 't1', 0))).toMatchObject({ state: 'accepted', taskId: 't1', sessionId: 's1' });
    });

    it('a retry that is rejected again still throws (task stays pending, no phantom ref)', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { selfDaemonId: 'daemon_mach_c', host: recordingHost(), ports: { cancelDispatch: confirmedStop } });
        openTask(ledger, OTHER);
        expect(() => openTask(ledger, TASK)).toThrow(/dispatch_accepted rejected/);
        expect(() => openTask(ledger, TASK)).toThrow(/dispatch_accepted/);
        expect(ledger.getAttempt(queueAttemptId(MESH, 't1', 0))).toBeFalsy();
    });
});

describe('claim/dispatch path source shape (C-W4 retirements)', () => {
    // The dispatch delivery lifecycle (deliverTaskToSession / handleDispatchFailure —
    // where the transport-outcome evidence is reported) moved out of
    // mesh-queue-assignment.ts into mesh-queue-dispatch.ts. Only the path follows it —
    // the claim/dispatch path is read as both files; every assertion is unchanged.
    const src = ['mesh-queue-assignment.ts', 'mesh-queue-dispatch.ts', 'mesh-holder-reconcile.ts']
        .map((f) => readFileSync(join(import.meta.dirname, '../../src/mesh', f), 'utf8'))
        .join('\n');

    it('no legacy attempt writer is called any more', () => {
        expect(src).not.toMatch(/\b(openTurnAttempt|recordTurnAck|closeAttemptForReassignment|rebindAttemptToLiveHolder|recordDuplicateDispatchConsumption|recordAckedHoldDispatchOutcome|assertPromptInjectionAllowed)\(/);
        expect(src).not.toMatch(/from '\.\/mesh-turn-ledger\.js'/);
    });

    it('no terminal queue status is written directly (only the non-terminal pending requeue remains)', () => {
        const calls = [...src.matchAll(/updateTaskStatus\(([^)]*)\)/g)].map((m) => m[1]!);
        expect(calls.length).toBeGreaterThan(0);
        for (const args of calls) expect(args, args).toMatch(/'pending'/);
    });

    it('an injection-closed refusal rebinds the row to the running attempt instead of writing it back to pending', () => {
        // QUEUE-LEDGER-DRIFT (c362e481): `pending` here was re-claimed by every drain
        // tick, bumping the nonce each time. The one remaining `'pending'` write is the
        // open-failure (throw) path.
        const refusal = src.slice(src.indexOf(`if ('refused' in opened)`), src.indexOf('task.attemptId = opened.ref.attemptId'));
        expect(refusal).toMatch(/rebindRefusedClaimToOpenAttempt\(meshId, task\.id, opened\.refused\)/);
        expect(refusal).not.toMatch(/updateTaskStatus\(/);
    });

    it('every transport outcome is reported as evidence', () => {
        for (const kind of ['delivered', 'dispatch_failed', 'duplicate_dispatch_refusal', 'session_error']) {
            expect(src, kind).toMatch(new RegExp(`kind: '${kind}'`));
        }
        expect(src).toMatch(/openOrResumeQueueAttempt\(turnLedger,/);
    });
});
