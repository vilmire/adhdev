import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts) so this suite's turn tables stay free of sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-dup-claim-rebind-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    proposeTurnCompletion,
    closeAttemptForReassignment,
    rebindAttemptToLiveHolder,
} from '../../src/mesh/mesh-turn-ledger.js';
import {
    DuplicateMeshDispatchError,
    DUPLICATE_MESH_DISPATCH_CODE,
    classifyDuplicateMeshDispatch,
    encodeDuplicateMeshDispatchCode,
} from '../../src/mesh/mesh-duplicate-dispatch.js';

// The live incident (task dc73f050 on the Linux node):
//   f6196842 = the session that claimed FIRST and is genuinely running the task
//   8267b612 = the session the re-fired claim dispatched to, which the node refused
const HOLDER_SESSION = 'f6196842';
const SECOND_SESSION = '8267b612';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

beforeEach(() => {
    MeshRuntimeStore.resetForTests();
});

afterEach(() => {
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Replay the incident up to the point of the refusal: the task is claimed and
 * dispatched to `SECOND_SESSION`, opening an attempt bound to that session, while
 * `HOLDER_SESSION` is the one actually working.
 */
function openAttemptDispatchedToSecondSession(taskId: string) {
    const { attempt } = openTurnAttempt({
        meshId: MESH,
        taskId,
        dispatchNonce: 1,
        nodeId: 'node-linux',
        sessionId: SECOND_SESSION,
        providerType: 'claude-cli',
    });
    return attempt;
}

/** The completion the REAL holder emits ~96s later, exactly as in the incident. */
function proposeHolderCompletion(taskId: string) {
    return proposeTurnCompletion({
        meshId: MESH,
        taskId,
        outcome: 'completed',
        source: 'worker_event',
        sessionId: HOLDER_SESSION,
    });
}

describe('DUP-CLAIM-REBIND — duplicate dispatch refusal must rebind the attempt, not cancel it', () => {
    describe('the structured refusal signal (never message parsing)', () => {
        it('classifies the in-process typed error and carries the holder session', () => {
            const err = new DuplicateMeshDispatchError('Refusing duplicate mesh dispatch: task X …', {
                holderSessionId: HOLDER_SESSION,
            });
            expect(classifyDuplicateMeshDispatch(err)).toEqual({ holderSessionId: HOLDER_SESSION });
        });

        it('classifies the refusal after a P2P hop, where only error.code survives as meshCode', () => {
            // The responder encodes the code; the sender surfaces it as meshCode.
            const wireCode = encodeDuplicateMeshDispatchCode(HOLDER_SESSION);
            expect(wireCode).toBe(`${DUPLICATE_MESH_DISPATCH_CODE}:${HOLDER_SESSION}`);

            const relayed = Object.assign(new Error('Refusing duplicate mesh dispatch: …'), {
                meshCode: wireCode,
            });
            expect(classifyDuplicateMeshDispatch(relayed)).toEqual({ holderSessionId: HOLDER_SESSION });
        });

        it('does NOT classify an ordinary transport failure, even one whose message mentions a duplicate', () => {
            // The guard must be code-driven. A message-parsing implementation would
            // rebind here — and rebinding on a false positive is exactly the hazard
            // the session_mismatch check exists to prevent.
            const transportErr = Object.assign(
                new Error('Refusing duplicate mesh dispatch: task is already being worked by a live session'),
                { meshCode: 'HANDLER_ERROR', code: 'p2p_timeout' },
            );
            expect(classifyDuplicateMeshDispatch(transportErr)).toBeNull();

            expect(classifyDuplicateMeshDispatch(new Error('dispatch_confirm_timeout after 30000ms'))).toBeNull();
            expect(classifyDuplicateMeshDispatch(Object.assign(new Error('peer gone'), { meshCode: 'PEER_NOT_CONNECTED' }))).toBeNull();
            expect(classifyDuplicateMeshDispatch(undefined)).toBeNull();
        });
    });

    describe('regression: the finished task must not be lost', () => {
        it('REBIND path — after the refusal, the real holder’s completion COMMITS', () => {
            const taskId = nextTaskId();
            const attempt = openAttemptDispatchedToSecondSession(taskId);
            recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: SECOND_SESSION });

            // The node refuses the duplicate and names the live holder.
            const refusal = new DuplicateMeshDispatchError('Refusing duplicate mesh dispatch', {
                holderSessionId: HOLDER_SESSION,
            });
            const info = classifyDuplicateMeshDispatch(refusal);
            expect(info?.holderSessionId).toBe(HOLDER_SESSION);

            const rebind = rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId: info!.holderSessionId });
            expect(rebind.rebound).toBe(true);
            expect(rebind).toMatchObject({ fromSessionId: SECOND_SESSION, toSessionId: HOLDER_SESSION });

            // The attempt stays OPEN (not cancelled) and now names the true worker.
            const after = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, taskId);
            expect(after?.attemptId).toBe(attempt.attemptId);
            expect(after?.terminalOutcome).toBeNull();
            expect(after?.sessionId).toBe(HOLDER_SESSION);

            // ★ The whole point: the holder's real completion is ACCEPTED.
            const decision = proposeHolderCompletion(taskId);
            expect(decision).toMatchObject({ committed: true, outcome: 'completed' });
        });

        it('OLD BEHAVIOR (cancel-on-refusal) loses the completion — the defect this fix closes', () => {
            const taskId = nextTaskId();
            openAttemptDispatchedToSecondSession(taskId);

            // Exactly what the pre-fix dispatch catch did with the refusal.
            closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'dispatch_failed' });

            // …and the holder's genuine completion is thrown away.
            const decision = proposeHolderCompletion(taskId);
            expect(decision.committed).toBe(false);
            expect((decision as { reason: string }).reason).toBe('session_mismatch');
        });
    });

    describe('rebind safety — it must stay narrow', () => {
        it('refuses to rebind a TERMINAL attempt (a settled attempt is never rewritten)', () => {
            const taskId = nextTaskId();
            openAttemptDispatchedToSecondSession(taskId);
            closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'dispatch_failed' });

            const rebind = rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId: HOLDER_SESSION });
            expect(rebind).toMatchObject({ rebound: false, reason: 'attempt_terminal' });
        });

        it('refuses to rebind when no holder session was named', () => {
            const taskId = nextTaskId();
            openAttemptDispatchedToSecondSession(taskId);

            expect(rebindAttemptToLiveHolder({ meshId: MESH, taskId })).toMatchObject({ rebound: false, reason: 'no_holder' });
            expect(rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId: '   ' })).toMatchObject({ rebound: false, reason: 'no_holder' });

            // The attempt is untouched by a refused rebind.
            const after = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, taskId);
            expect(after?.sessionId).toBe(SECOND_SESSION);
            expect(after?.terminalOutcome).toBeNull();
        });

        it('is a no-op when the attempt already names the holder', () => {
            const taskId = nextTaskId();
            const { attempt } = openTurnAttempt({
                meshId: MESH, taskId, dispatchNonce: 1, nodeId: 'node-linux',
                sessionId: HOLDER_SESSION, providerType: 'claude-cli',
            });
            const rebind = rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId: HOLDER_SESSION });
            expect(rebind).toMatchObject({ rebound: false, reason: 'same_session', attemptId: attempt.attemptId });

            // Still open and still bound to the holder — the completion path is unaffected.
            expect(proposeHolderCompletion(taskId)).toMatchObject({ committed: true });
        });

        it('reports no_attempt for a task that never opened one', () => {
            expect(rebindAttemptToLiveHolder({ meshId: MESH, taskId: nextTaskId(), holderSessionId: HOLDER_SESSION }))
                .toMatchObject({ rebound: false, reason: 'no_attempt' });
        });

        it('a rebind does NOT let an unrelated third session complete the attempt', () => {
            const taskId = nextTaskId();
            openAttemptDispatchedToSecondSession(taskId);
            expect(rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId: HOLDER_SESSION }).rebound).toBe(true);

            // session_mismatch still protects the attempt from everyone except the holder.
            const stranger = proposeTurnCompletion({
                meshId: MESH, taskId, outcome: 'completed', source: 'worker_event', sessionId: 'deadbeef',
            });
            expect(stranger.committed).toBe(false);
            expect((stranger as { reason: string }).reason).toBe('session_mismatch');
        });
    });
});
