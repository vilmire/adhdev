import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-duplicate-claim-attempt-rebind.test.ts) so this suite's turn tables stay
// free of sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-dup-refusal-consumed-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    evaluateRedrive,
    rebindAttemptToLiveHolder,
    recordDuplicateDispatchConsumption,
    closeAttemptForReassignment,
    proposeTurnCompletion,
} from '../../src/mesh/mesh-turn-ledger.js';
import { resolveTranscriptAuthorityProfile } from '../../src/providers/transcript-evidence.js';

/**
 * D3 — REDRIVE CONSUMPTION EVIDENCE BY PROFILE.
 *
 * The live incident (task 307f7b4e, node MoltBook, antigravity-cli, 2026-09-21):
 *   07:46:25  dispatch → session 3f3a7a16
 *   07:48:13  dispatch_duplicate_rebound — the node REFUSED a second dispatch and
 *             named the live holder, proving the worker held and was working the task
 *   07:49:54  delivered_not_consumed_redrive fired anyway → stopStaleMeshWorker
 *   07:50:09  the stopped worker produced a genuine, complete result
 *
 * The redrive judgement infers "never consumed" from the ABSENCE of
 * agent:generating_started — an event an emitsPtyTurnEvents=false provider never
 * emits — so the inference is structurally always-true for that class. The rebind
 * had already observed the contradicting evidence but recorded only the SESSION
 * binding, never the consumption. These tests pin that the refusal now promotes the
 * consumed link, and pin the overcorrection guards that keep genuine redrive alive.
 */

const HOLDER_SESSION = '3f3a7a16';
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

/** Dispatch to SECOND_SESSION and confirm the transport handoff (stage 'delivered'). */
function dispatchedButUnconsumed(taskId: string, sessionId = SECOND_SESSION) {
    const { attempt } = openTurnAttempt({
        meshId: MESH,
        taskId,
        dispatchNonce: 1,
        nodeId: 'node-moltbook',
        sessionId,
        providerType: 'antigravity-cli',
    });
    recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId });
    return attempt;
}

/** The refusal handler's ordering: rebind FIRST, then promote the consumed link. */
function applyRefusal(taskId: string, holderSessionId?: string, attemptId?: string) {
    const rebind = rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId });
    const promotion = recordDuplicateDispatchConsumption({
        meshId: MESH,
        taskId,
        holderSessionId,
        ...(attemptId ?? rebind.attemptId ? { attemptId: attemptId ?? rebind.attemptId } : {}),
    });
    return { rebind, promotion };
}

describe('D3 — a duplicate-dispatch refusal is consumption evidence', () => {
    describe('the structural blind spot this closes', () => {
        it('antigravity-cli is emitsPtyTurnEvents=false, so the absence of generating_started proves nothing', () => {
            // The premise of the whole defect: for this class the redrive's evidence
            // (a missing turn-start event) is structurally unobtainable, so it is
            // always "absent" — for a healthy worker exactly as for a dead one.
            const antigravity = resolveTranscriptAuthorityProfile({
                transcriptAuthority: 'provider',
                nativeHistory: { source: 'native', path: '~/.antigravity/chat' } as never,
                holdCompletionForTranscript: true,
            });
            expect(antigravity.emitsPtyTurnEvents).toBe(false);

            // The contrast class, whose judgement must NOT change.
            const daemonOwned = resolveTranscriptAuthorityProfile({});
            expect(daemonOwned.emitsPtyTurnEvents).toBe(true);
        });

        it('PRE-FIX SHAPE: a rebind alone leaves the attempt re-drivable — the live incident', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);

            // rc.35's rebind, WITHOUT the consumption promotion (the pre-fix behaviour).
            expect(rebindAttemptToLiveHolder({ meshId: MESH, taskId, holderSessionId: HOLDER_SESSION }).rebound).toBe(true);

            // …and the redrive is still allowed against the session just identified as
            // the live holder. This is what stopped the worker at 07:49:54.
            expect(evaluateRedrive(MESH, taskId, Date.now())).toMatchObject({ allowed: true });
        });
    });

    describe('the fix', () => {
        it('LIVE CASE: after the refusal, redrive is blocked as already_consumed', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);

            const { rebind, promotion } = applyRefusal(taskId, HOLDER_SESSION);
            expect(rebind.rebound).toBe(true);
            expect(promotion).toMatchObject({ promoted: true, stage: 'consumed' });

            const evaluation = evaluateRedrive(MESH, taskId, Date.now());
            expect(evaluation.allowed).toBe(false);
            expect((evaluation as { reason: string }).reason).toBe('already_consumed');
        });

        it('binds the consumed evidence to the HOLDER, and the attempt stays open and non-terminal', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);
            const { promotion } = applyRefusal(taskId, HOLDER_SESSION);

            const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, taskId);
            expect(attempt?.attemptId).toBe(promotion.attemptId);
            expect(attempt?.sessionId).toBe(HOLDER_SESSION);
            expect(attempt?.stage).toBe('consumed');
            // Consumption is not completion — the task still owes a terminal.
            expect(attempt?.terminalOutcome).toBeNull();
        });

        it('the holder’s genuine completion still commits (consumption does not pre-empt the terminal)', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);
            applyRefusal(taskId, HOLDER_SESSION);

            // The 07:50:09 result, which the redrive's stop had destroyed.
            expect(proposeTurnCompletion({
                meshId: MESH, taskId, outcome: 'completed', source: 'worker_event', sessionId: HOLDER_SESSION,
            })).toMatchObject({ committed: true, outcome: 'completed' });
        });

        it('is idempotent — a second refusal for the same attempt promotes nothing new', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);
            expect(applyRefusal(taskId, HOLDER_SESSION).promotion.promoted).toBe(true);

            const second = recordDuplicateDispatchConsumption({ meshId: MESH, taskId, holderSessionId: HOLDER_SESSION });
            expect(second).toMatchObject({ promoted: false, reason: 'already_consumed' });
            // Still consumed, still one attempt, still open.
            const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, taskId);
            expect(attempt?.stage).toBe('consumed');
            expect(attempt?.terminalOutcome).toBeNull();
        });

        it('covers the same-session refusal (rebind reports same_session, promotion still applies)', () => {
            // The node refuses a re-dispatch naming the session the attempt ALREADY
            // names. The rebind is a no-op, but the refusal is no less proof of
            // consumption — if the promotion were gated on `rebound === true` this
            // case would keep the pre-fix behaviour.
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId, HOLDER_SESSION);

            const { rebind, promotion } = applyRefusal(taskId, HOLDER_SESSION);
            expect(rebind).toMatchObject({ rebound: false, reason: 'same_session' });
            expect(promotion.promoted).toBe(true);
            expect(evaluateRedrive(MESH, taskId, Date.now())).toMatchObject({ reason: 'already_consumed' });
        });
    });

    describe('OVERCORRECTION GUARD — genuine redrive must survive', () => {
        it('a task that was merely DELIVERED (no refusal) is still re-drivable', () => {
            // The control group: this is the real "delivered but never consumed"
            // case the redrive exists for. Nothing called the promotion, so the
            // judgement is byte-for-byte the pre-fix one.
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);
            expect(evaluateRedrive(MESH, taskId, Date.now())).toMatchObject({ allowed: true });
        });

        it('an emitsPtyTurnEvents=TRUE provider is judged identically — before and after', () => {
            // The promotion is provider-agnostic by construction (it keys on the
            // refusal, never on the profile), so a reliable-PTY provider's judgement
            // is unchanged: re-drivable without a refusal, consumed with one — which
            // is exactly what its real generating_started ACK would have produced.
            const noRefusal = nextTaskId();
            const { attempt } = openTurnAttempt({
                meshId: MESH, taskId: noRefusal, dispatchNonce: 1,
                nodeId: 'node-moltbook', sessionId: SECOND_SESSION, providerType: 'claude-cli',
            });
            recordTurnAck({ meshId: MESH, taskId: noRefusal, kind: 'delivered', attemptId: attempt.attemptId, sessionId: SECOND_SESSION });
            expect(evaluateRedrive(MESH, noRefusal, Date.now())).toMatchObject({ allowed: true });

            const withRefusal = nextTaskId();
            const { attempt: a2 } = openTurnAttempt({
                meshId: MESH, taskId: withRefusal, dispatchNonce: 1,
                nodeId: 'node-moltbook', sessionId: SECOND_SESSION, providerType: 'claude-cli',
            });
            recordTurnAck({ meshId: MESH, taskId: withRefusal, kind: 'delivered', attemptId: a2.attemptId, sessionId: SECOND_SESSION });
            applyRefusal(withRefusal, HOLDER_SESSION);
            expect(evaluateRedrive(MESH, withRefusal, Date.now())).toMatchObject({ reason: 'already_consumed' });
        });

        it('a refusal naming NO holder promotes nothing — unverifiable claims never suppress redrive', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);

            expect(recordDuplicateDispatchConsumption({ meshId: MESH, taskId }))
                .toMatchObject({ promoted: false, reason: 'no_holder' });
            expect(recordDuplicateDispatchConsumption({ meshId: MESH, taskId, holderSessionId: '   ' }))
                .toMatchObject({ promoted: false, reason: 'no_holder' });

            // Untouched: still pre-consumed and still re-drivable.
            expect(MeshRuntimeStore.getInstance().getCurrentTurnAttempt(MESH, taskId)?.stage).toBe('delivered');
            expect(evaluateRedrive(MESH, taskId, Date.now())).toMatchObject({ allowed: true });
        });

        it('never rewrites a TERMINAL attempt', () => {
            const taskId = nextTaskId();
            dispatchedButUnconsumed(taskId);
            closeAttemptForReassignment({ meshId: MESH, taskId, reason: 'dispatch_failed' });

            expect(recordDuplicateDispatchConsumption({ meshId: MESH, taskId, holderSessionId: HOLDER_SESSION }))
                .toMatchObject({ promoted: false, reason: 'attempt_terminal' });
        });

        it('reports no_attempt for a task that never opened one', () => {
            expect(recordDuplicateDispatchConsumption({ meshId: MESH, taskId: nextTaskId(), holderSessionId: HOLDER_SESSION }))
                .toMatchObject({ promoted: false, reason: 'no_attempt' });
        });
    });

    describe('the refusal HANDLER wires both authorities (source-shape guard)', () => {
        // The two writes below live inside an async .catch() in the dispatch path,
        // reachable only through a live transport round-trip, so the unit tests above
        // exercise the ledger/store contracts rather than the handler itself. These
        // guards pin the two decisions that would otherwise regress silently — both
        // were wrong in the pre-fix code, and each alone leaves half the defect.
        const handlerSrc = readFileSync(
            join(__dirname, '..', '..', 'src', 'mesh', 'mesh-queue-assignment.ts'),
            'utf8',
        );

        it('advances the delivery row to acked — NOT delivered, which is one rank short of consumed', () => {
            // `taskDeliveryConsumed` = status IN ('acked','completed'). Writing
            // 'delivered' here is precisely what let the redrive gate read the refused
            // dispatch as unconsumed.
            const refusalBlock = handlerSrc.slice(
                handlerSrc.indexOf('DUP-REFUSAL-IS-CONSUMPTION (delivery-row half)'),
                handlerSrc.indexOf('dispatch_duplicate_rebound'),
            );
            expect(refusalBlock).not.toBe('');
            expect(refusalBlock).toMatch(/updateSessionDeliveryStatus\(delivery\.id,\s*'acked'\)/);
            expect(refusalBlock).not.toMatch(/updateSessionDeliveryStatus\(delivery\.id,\s*'delivered'\)/);
        });

        it('promotes the durable attempt link, and does so AFTER the rebind', () => {
            // Ordering is load-bearing: recordTurnAck's session-binding guard ignores
            // evidence from a session the attempt does not name, so promoting before
            // the rebind would silently record nothing.
            const rebindAt = handlerSrc.indexOf('const rebind = rebindAttemptToLiveHolder(');
            const promoteAt = handlerSrc.indexOf('recordDuplicateDispatchConsumption({');
            expect(rebindAt).toBeGreaterThan(-1);
            expect(promoteAt).toBeGreaterThan(rebindAt);
        });
    });

    describe('the delivery-row gate is the OTHER authority and must be satisfied too', () => {
        it('taskDeliveryConsumed keys on acked/completed — a delivered row reads false', () => {
            // Pins why the refusal handler writes 'acked' rather than 'delivered':
            // the redrive gate in mesh-reconcile-stranded-dispatch reads THIS, not the
            // attempt table, so promoting only the attempt would leave half the defect.
            const store = MeshRuntimeStore.getInstance();
            const taskId = nextTaskId();
            const deliveryId = `del-${randomUUID().slice(0, 8)}`;
            const nowIso = new Date().toISOString();
            store.insertSessionDelivery({
                id: deliveryId,
                meshId: MESH,
                taskId,
                sessionId: SECOND_SESSION,
                nodeId: 'node-moltbook',
                kind: 'task',
                message: 'prompt',
                status: 'delivering',
                createdAt: nowIso,
                updatedAt: nowIso,
            });

            store.updateSessionDeliveryStatus(deliveryId, 'delivered');
            expect(store.taskDeliveryConsumed(MESH, taskId)).toBe(false);

            store.updateSessionDeliveryStatus(deliveryId, 'acked');
            expect(store.taskDeliveryConsumed(MESH, taskId)).toBe(true);

            // Monotonic guard: a late transport confirm cannot pull it back.
            store.updateSessionDeliveryStatus(deliveryId, 'delivered');
            expect(store.taskDeliveryConsumed(MESH, taskId)).toBe(true);
        });
    });
});
