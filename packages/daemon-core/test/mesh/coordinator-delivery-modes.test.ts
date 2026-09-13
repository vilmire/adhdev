/**
 * NOTIF-IMMEDIACY delivery-mode coverage (Tier 1 + Tier 2).
 *
 * A worker completion used to reach a BUSY coordinator only on its next idle
 * edge — median ~1min, worst measured 873s, and 1h42m in the composer-residue
 * incident. `injectPendingIntoCoordinator` now takes an explicit delivery mode
 * and returns a TYPED outcome so the caller can requeue a refusal instead of
 * losing it.
 *
 * The invariants these tests pin, in order of how badly they fail if broken:
 *
 *  1. A refusal must be REPORTABLE. The caller marks the row `drained = 1`
 *     BEFORE calling (pillar invariant), and a completion's `finalSummary` lives
 *     ONLY in that pending event — so a refusal the caller cannot see is
 *     permanent data loss. The old signature returned void.
 *  2. `next-turn-queue` must never set `force`. Force-inject into a generating
 *     PTY is the retired data-loss path; a busy-coordinator delivery must not be
 *     able to masquerade as one.
 *  3. `mid-generation-split` must FALL BACK, not fail. A refused split write
 *     wrote zero bytes (the engine's contract), so falling through to the FIFO
 *     is lossless — reporting failure instead would make the caller requeue a
 *     body that could have been delivered immediately.
 *  4. `idle-turn` must be byte-for-byte what it always was (default mode).
 */
import { describe, it, expect } from 'vitest';
import {
    injectPendingIntoCoordinator,
    type MeshDeliveryMode,
} from '../../src/mesh/mesh-reconcile-coordinator-drain.js';
import type { PendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events-pending.js';
import { isMidGenerationSplitEligible } from '../../src/mesh/mesh-event-forwarding.js';

type SendCall = { text: string; force: boolean };

/** Minimal coordinator instance double: records what reached the session. */
function makeCoordinator(opts: {
    splitAccepts?: boolean;
    splitReason?: string;
    hasSplit?: boolean;
    splitThrows?: boolean;
} = {}) {
    const sends: SendCall[] = [];
    const splitWrites: string[] = [];
    const inst: Record<string, unknown> = {
        onEvent(event: string, data: any) {
            if (event !== 'send_message') return;
            sends.push({ text: String(data?.input?.text ?? ''), force: data?.force === true });
        },
    };
    if (opts.hasSplit !== false) {
        inst.sendMessageDuringGeneration = (text: string) => {
            if (opts.splitThrows) throw new Error('pty gone');
            splitWrites.push(text);
            return opts.splitAccepts
                ? { accepted: true }
                : { accepted: false, reason: opts.splitReason ?? 'not_generating' };
        };
    }
    return { inst, sends, splitWrites };
}

function completionEvent(over?: Partial<PendingMeshCoordinatorEvent>): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId: 'mesh_test',
        nodeLabel: 'worker-node',
        coordinatorMessage: '[System] worker finished task T1',
        queuedAt: Date.now(),
        ...(over as object),
    } as PendingMeshCoordinatorEvent;
}

function inject(instance: unknown, pending: PendingMeshCoordinatorEvent, mode?: MeshDeliveryMode) {
    return injectPendingIntoCoordinator(instance as any, pending, mode ? { mode } : undefined);
}

describe('NOTIF-IMMEDIACY: typed inject outcome', () => {
    it('★ reports delivered:false for a missing coordinator instead of silently returning', () => {
        const outcome = injectPendingIntoCoordinator(null as any, completionEvent());
        expect(outcome.delivered).toBe(false);
        if (!outcome.delivered) expect(outcome.reason).toBe('no_coordinator');
    });

    it('★ reports delivered:false for a message-less LIFECYCLE event (not injectable, must requeue)', () => {
        const { inst, sends } = makeCoordinator();
        const outcome = inject(inst, completionEvent({
            event: 'agent:ready',
            coordinatorMessage: undefined,
        }));
        expect(outcome.delivered).toBe(false);
        if (!outcome.delivered) expect(outcome.reason).toBe('no_message');
        // Nothing was pushed at a silent lifecycle event.
        expect(sends).toHaveLength(0);
    });
});

describe('NOTIF-IMMEDIACY Tier 1: next-turn-queue', () => {
    it('★ delivers to a BUSY coordinator WITHOUT force (never a force-inject)', () => {
        const { inst, sends } = makeCoordinator();
        const outcome = inject(inst, completionEvent(), 'next-turn-queue');

        expect(outcome).toEqual({ delivered: true, mode: 'next-turn-queue' });
        expect(sends).toHaveLength(1);
        // THE invariant: a busy-coordinator delivery must never carry force.
        expect(sends[0].force).toBe(false);
        expect(sends[0].text).toContain('worker finished task T1');
    });

    it('★ idle-turn remains the DEFAULT mode (unchanged legacy behaviour)', () => {
        const { inst, sends } = makeCoordinator();
        const outcome = inject(inst, completionEvent());
        expect(outcome).toEqual({ delivered: true, mode: 'idle-turn' });
        expect(sends).toHaveLength(1);
        // A terminal event on the idle path still takes its historical force flag.
        expect(sends[0].force).toBe(true);
    });
});

describe('NOTIF-IMMEDIACY Tier 2: mid-generation-split', () => {
    it('★ uses the split write when the engine accepts it — no FIFO send at all', () => {
        const { inst, sends, splitWrites } = makeCoordinator({ splitAccepts: true });
        const outcome = inject(inst, completionEvent(), 'mid-generation-split');

        expect(outcome).toEqual({ delivered: true, mode: 'mid-generation-split' });
        expect(splitWrites).toHaveLength(1);
        expect(splitWrites[0]).toContain('worker finished task T1');
        // Delivered by the split write, so it must NOT also go through the FIFO.
        expect(sends).toHaveLength(0);
    });

    it('★ a REFUSED split write falls back to next-turn-queue — lossless, never a failure', () => {
        const { inst, sends, splitWrites } = makeCoordinator({
            splitAccepts: false,
            splitReason: 'not_generating',
        });
        const outcome = inject(inst, completionEvent(), 'mid-generation-split');

        // Attempted, refused, then delivered the safe way. The caller must NOT requeue.
        expect(splitWrites).toHaveLength(1);
        expect(outcome.delivered).toBe(true);
        if (outcome.delivered) expect(outcome.mode).toBe('next-turn-queue');
        expect(sends).toHaveLength(1);
        expect(sends[0].force).toBe(false);
    });

    it('★ a THROWING split write also falls back rather than escaping to the caller', () => {
        const { inst, sends } = makeCoordinator({ splitThrows: true });
        const outcome = inject(inst, completionEvent(), 'mid-generation-split');
        expect(outcome.delivered).toBe(true);
        expect(sends).toHaveLength(1);
        expect(sends[0].force).toBe(false);
    });

    it('★ an adapter WITHOUT the split method (win32 / older) still delivers via the FIFO', () => {
        const { inst, sends } = makeCoordinator({ hasSplit: false });
        const outcome = inject(inst, completionEvent(), 'mid-generation-split');
        expect(outcome.delivered).toBe(true);
        if (outcome.delivered) expect(outcome.mode).toBe('next-turn-queue');
        expect(sends).toHaveLength(1);
        expect(sends[0].force).toBe(false);
    });
});

describe('NOTIF-IMMEDIACY Tier 2: split eligibility policy', () => {
    const POSIX: NodeJS.Platform = 'darwin';

    it('★ requires the SPEC opt-in — never assumed for an unmeasured CLI', () => {
        expect(isMidGenerationSplitEligible({ specOptIn: false, bodyLength: 10, platform: POSIX })).toBe(false);
        expect(isMidGenerationSplitEligible({ specOptIn: true, bodyLength: 10, platform: POSIX })).toBe(true);
    });

    it('★ enforces the 512-char ceiling (the echo-verification boundary)', () => {
        // Exactly at the ceiling is allowed; one char over is not.
        expect(isMidGenerationSplitEligible({ specOptIn: true, bodyLength: 512, platform: POSIX })).toBe(true);
        expect(isMidGenerationSplitEligible({ specOptIn: true, bodyLength: 513, platform: POSIX })).toBe(false);
    });

    it('★ rejects the measured composer-residue body size (10,937 chars)', () => {
        // The oss 7cd5b777 incident body must never take the unverified split path.
        expect(isMidGenerationSplitEligible({ specOptIn: true, bodyLength: 10_937, platform: POSIX })).toBe(false);
    });

    it('★ refuses win32 regardless of opt-in and size (ConPTY not re-litigated)', () => {
        expect(isMidGenerationSplitEligible({ specOptIn: true, bodyLength: 10, platform: 'win32' })).toBe(false);
    });
});
