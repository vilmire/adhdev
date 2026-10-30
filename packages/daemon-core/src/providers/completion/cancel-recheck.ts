import { captureCompletionIdentity, boundCompletionMarker, completionIdentityCurrent, type CompletionBindingHost } from './native-completion-binding.js';
/**
 * CANCEL-BLIP-ORPHAN — post-cancel completion re-verification.
 *
 * THE DEFECT
 * ----------
 * A continuity cancel (`resumed_status` / `busy_reentry`) deleted the completion arm and
 * nothing ever re-examined it. The ONLY path that re-arms a completion is a fresh
 * idle→generating FSM edge, so a sub-second PTY blip right after a genuine turn end
 * orphaned the completion permanently.
 *
 * Live incident (daemon-19223-2026-08-14.1.log, task 631c310b, codex-cli):
 *   14:07:27.670  busy → idle                 ← the turn genuinely ended
 *   14:07:27.670  status: generating → idle
 *   14:07:27.751  idle → busy                 ← an 81ms PTY blip
 *   14:07:27.751  cancelled pending completed (resumed generating)
 * codex kept working and finished ~14:17, but the coordinator's queue row read
 * 'generating' until 14:28. The blip settled straight back to idle, producing no further
 * FSM edge — so the deleted arm had no route back.
 *
 * (claude-cli was cancelled 10× in the same log with no harm: its `timing:'immediate'`
 * authority profile completes through a different path. codex is the class exposed here.)
 *
 * THE APPROACH
 * ------------
 * The cancel itself is CORRECT and unchanged — a resumed turn must never emit the
 * completion armed before it. What was missing is a second look. Rather than guess
 * blip-vs-real-resume at cancel time (unknowable from a point sample, which is exactly
 * what made the original inline judgment unreliable), the deleted arm is handed to a
 * bounded RE-VERIFICATION watch and judged LATER, when the session's state is observable.
 *
 * The invariant that makes this safe: a cancelled arm is never RESURRECTED, only given
 * another chance to be JUDGED. The watch re-arms the pending and calls the ordinary flush,
 * so the continuity cancels, the finalization block and the evidence gate all run again
 * unmodified. A genuinely resumed turn therefore cannot emit early — its very next recheck
 * hits the same cancel that fired the first time, and the budget expires.
 *
 * Failure direction is deliberate and one-way: the worst case of a recheck is that it
 * observes a still-busy session and gives up. It can produce a completion that is LATE,
 * never one that is EARLY.
 */

import { LOG } from '../../logging/logger.js';
import type { CompletedDebouncePending } from '../cli-provider-instance-types.js';
import {
    CANCELLED_COMPLETION_RECHECK_MS,
    CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS,
} from '../cli-provider-instance-types.js';

export type CancelledCompletionReason = 'resumed_status' | 'busy_reentry' | 'new_pty_output';

export interface CancelledCompletionRecheck {
    pending: CompletedDebouncePending;
    reason: CancelledCompletionReason;
    attempts: number;
    firstCancelledAt: number;
}

/**
 * The surface of CliProviderInstance this module reads/writes. Mutable state stays
 * instance-owned and helpers dispatch back THROUGH the host so suite stubs stay on the
 * path — identical to the status-transition / evidence / stall-rescue moves.
 */
export interface CancelRecheckHost extends Partial<CompletionBindingHost> {
    readExternalCompletionMessages?(): unknown;
    type: string;
    busyEpoch: number;
    adapter: { getStatus(opts: { allowParse: boolean }): any };
    completedDebouncePending: CompletedDebouncePending | null;
    cancelledCompletionRecheck: CancelledCompletionRecheck | null;
    cancelledCompletionRecheckTimer: NodeJS.Timeout | null;
    completionTraceOn(): boolean;
    recordCompletionGateTrace(stage: string, payload: Record<string, unknown>): void;
    flushCompletedDebounceIfFinalized(): void;
}

/** Native output cancellation keeps a bounded watch; only bound terminal proof can recover it. */
export function armCancelledCompletionRecheck(
    host: CancelRecheckHost,
    pending: CompletedDebouncePending,
    reason: CancelledCompletionReason,
): void {
    if (reason === 'new_pty_output' && !pending.completionBinding && !pending.capturedCompletionInput) return;
    const now = Date.now();
    let prior = host.cancelledCompletionRecheck;
    if (prior && (prior.pending.turnStartedAt !== pending.turnStartedAt
        || prior.pending.completionBinding?.inputAt !== pending.completionBinding?.inputAt
        || JSON.stringify(prior.pending.capturedAttemptRef) !== JSON.stringify(pending.capturedAttemptRef))) {
        clearCancelledCompletionRecheck(host); prior = null;
    }
    // Keep the ORIGINAL turn's arm across successive cancels: a blip that flaps a few times
    // must not restart its own budget (that would make the watch unbounded), and the
    // completion we owe belongs to the turn that first went idle, not to the flap.
    const carriedPending = prior?.pending ?? pending;
    const attempts = prior ? prior.attempts : 0;
    if (attempts >= CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS && !carriedPending.completionBinding && !carriedPending.capturedCompletionInput) {
        // Budget exhausted — the session is genuinely working, not blipping. Drop the watch;
        // the turn's own generating→idle edge will arm a fresh completion.
        clearCancelledCompletionRecheck(host);
        LOG.debug('CLI', `[${host.type}] cancelled-completion recheck budget exhausted (${reason}) — deferring to the next FSM completion edge`);
        return;
    }
    host.cancelledCompletionRecheck = {
        pending: carriedPending,
        reason,
        attempts,
        firstCancelledAt: prior?.firstCancelledAt ?? now,
    };
    if (host.cancelledCompletionRecheckTimer) clearTimeout(host.cancelledCompletionRecheckTimer);
    if (attempts >= CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS) {
        host.cancelledCompletionRecheckTimer = null; // Dormant: only a fresh native observation can retry.
        return;
    }
    host.cancelledCompletionRecheckTimer = setTimeout(
        () => runCancelledCompletionRecheck(host),
        CANCELLED_COMPLETION_RECHECK_MS,
    );
}

/** Drop the watch and its timer. */
export function clearCancelledCompletionRecheck(host: CancelRecheckHost): void {
    if (host.cancelledCompletionRecheckTimer) {
        clearTimeout(host.cancelledCompletionRecheckTimer);
        host.cancelledCompletionRecheckTimer = null;
    }
    host.cancelledCompletionRecheck = null;
}

/**
 * Re-arm the cancelled pending and re-run the ordinary flush.
 *
 * Yields entirely when a live arm already exists: the FSM observed a real generating→idle
 * edge in the meantime and armed a completion for the CURRENT turn, which strictly outranks
 * this stale watch.
 */
export function runCancelledCompletionRecheck(host: CancelRecheckHost): void {
    host.cancelledCompletionRecheckTimer = null;
    const watch = host.cancelledCompletionRecheck;
    if (!watch) return;
    if (host.completedDebouncePending) {
        // A fresh arm owns the completion now — the watch has nothing to recover.
        clearCancelledCompletionRecheck(host);
        return;
    }
    if (watch.pending.completionBinding || watch.pending.capturedCompletionInput) {
        host.readExternalCompletionMessages?.();
        captureCompletionIdentity(host as CompletionBindingHost, watch.pending);
        if (Date.now() - watch.firstCancelledAt > 120_000
            || (watch.pending.completionBinding && !completionIdentityCurrent(host as CompletionBindingHost, watch.pending))) {
            clearCancelledCompletionRecheck(host);
            return;
        }
        const status = host.adapter.getStatus({ allowParse: false });
        if (status?.status && status.status !== 'idle') { clearCancelledCompletionRecheck(host); return; }
        host.readExternalCompletionMessages?.();
        if (!boundCompletionMarker(host as CompletionBindingHost, watch.pending)) {
            watch.attempts++;
            if (watch.attempts < CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS) {
                host.cancelledCompletionRecheckTimer = setTimeout(() => runCancelledCompletionRecheck(host), CANCELLED_COMPLETION_RECHECK_MS);
            }
            return;
        }
    }
    watch.attempts += 1;
    LOG.info('CLI', `[${host.type}] re-checking completion cancelled by ${watch.reason} `
        + `(attempt ${watch.attempts}/${CANCELLED_COMPLETION_RECHECK_MAX_ATTEMPTS}, `
        + `${Date.now() - watch.firstCancelledAt}ms since cancel)`);
    if (host.completionTraceOn()) host.recordCompletionGateTrace('cancel_recheck', {
        reason: watch.reason,
        attempt: watch.attempts,
        sinceCancelMs: Date.now() - watch.firstCancelledAt,
        busyEpoch: host.busyEpoch,
    });
    // Re-arm against the CURRENT continuity clocks. Re-snapshotting busyEpochAtArm is what
    // makes the recheck meaningful rather than self-defeating: the blip already bumped
    // busyEpoch, so replaying the stale epoch would re-cancel on `busy_reentry` every single
    // time and the watch could never recover anything. The turn-identity fields that make the
    // completion CORRECT (turnStartedAt, taskId, duration, timestamp) are carried through
    // untouched, so the recovered completion still reports the turn that actually ended.
    // Continuity from here forward is enforced normally: a resume AFTER this instant bumps
    // the epoch again and re-cancels.
    const lastOutputAt = host.adapter.getStatus({ allowParse: false })?.lastOutputAt;
    host.completedDebouncePending = {
        ...watch.pending,
        busyEpochAtArm: host.busyEpoch,
        lastOutputAtArm: typeof lastOutputAt === 'number' && Number.isFinite(lastOutputAt)
            ? lastOutputAt
            : watch.pending.lastOutputAtArm,
    };
    host.flushCompletedDebounceIfFinalized();
    // The flush either emitted (pending cleared), held (pending re-scheduled through the
    // normal retry path), or cancelled again — in which case the cancel branch re-armed the
    // watch with the incremented budget. Only drop the watch when the flush did NOT hand it
    // back, so a hold's own retry owns the pending from here.
    if (host.cancelledCompletionRecheck === watch && host.completedDebouncePending) {
        clearCancelledCompletionRecheck(host);
    }
}

/** Existing attributed native hydration drives late finals after the timer budget, without polling anew. */
export function observeCancelledNativeCompletion(host: CancelRecheckHost): void {
    const watch = host.cancelledCompletionRecheck;
    if (!watch || (!watch.pending.completionBinding && !watch.pending.capturedCompletionInput) || host.completedDebouncePending || host.cancelledCompletionRecheckTimer) return;
    captureCompletionIdentity(host as CompletionBindingHost, watch.pending);
    if (Date.now() - watch.firstCancelledAt > 120_000 || !completionIdentityCurrent(host as CompletionBindingHost, watch.pending)) {
        clearCancelledCompletionRecheck(host);
        return;
    }
    if (!boundCompletionMarker(host as CompletionBindingHost, watch.pending)) return;
    host.cancelledCompletionRecheckTimer = setTimeout(() => runCancelledCompletionRecheck(host), 0);
}
