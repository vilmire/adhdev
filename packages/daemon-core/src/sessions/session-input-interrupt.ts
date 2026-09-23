/**
 * session-input-interrupt — the busy→idle observation the `interrupt` policy of
 * `SessionInputService` waits on after pressing a provider's stop key.
 *
 * Wiring-unification D2: moved verbatim (behaviour, constants and derivations)
 * out of the deleted `commands/interrupt-and-deliver.ts`; the interrupt SEQUENCE
 * itself now lives in `session-input-service.ts` (`interruptThenWrite`), which is
 * the only caller.
 *
 * ── Why the sequence waits at all ─────────────────────────────────────────
 * Writing a body into a generating PTY is NOT an honest "send now": the bytes
 * sit in the TUI's input buffer, the LLM never reads them, and the caller still
 * gets a success signal — the measured data-loss defect that retired
 * force-inject in oss 6cca365b (header of providers/spec/interrupt-capability.ts).
 * So the interrupt route presses the provider's OWN stop key, WAITS here for the
 * FSM to observe busy→idle, and only then writes the body through the ordinary
 * send gates. Returning before idle would hand the body to the driver while
 * `canSendNow()` is still false, parking it again — the exact state the owner
 * pressed the button to leave.
 */

import { isBusyStatus, isDeadStatus } from '@adhdev/mesh-shared';

/** How long to wait for the FSM to observe busy→idle after the stop key lands.
 *
 *  ★ Was 8s on the premise that "claude-cli returns to an idle prompt well under
 *  2s". Live measurement disproved it: 2026-09-07, stop key at 02:42:12.688 →
 *  busy→idle at 02:42:21.685 = 9.0s, because claude-cli does not abandon a tool
 *  call mid-flight — it waits for the running tool to return before redrawing an
 *  idle prompt, and a tool can take arbitrarily long. 15s covers that observed
 *  worst case with headroom. The ceiling is deliberately generous: a slow abort
 *  must not be reported as a failed interrupt (the turn HAS been cancelled by
 *  then — only the observation is late). */
export const INTERRUPT_IDLE_TIMEOUT_MS = 15_000;
/** Poll cadence for the busy→idle observation. */
export const INTERRUPT_IDLE_POLL_MS = 120;
/** How long to wait after the FIRST stop key before pressing it a second time.
 *
 *  Some TUIs (claude-cli measured above) treat one Ctrl-C as "finish the running
 *  tool, then stop" and only abort immediately on a second press. One extra
 *  press shortens the common case without changing the contract — we still wait
 *  for the FSM's own busy→idle, never assume the abort landed.
 *
 *  ★ Gated on confidence==='proven' (see providers/spec/interrupt-capability.ts).
 *  For a provider whose stop key is spec-DECLARED but whose busy→idle effect has
 *  never been observed live, a second unexplained control byte at an unknown TUI
 *  state is a change we have no evidence is safe — those keep the single press. */
export const INTERRUPT_SECOND_PRESS_DELAY_MS = 200;
/** SEND-NOW-SECOND-PRESS-KILL: how long the session must have been CONTINUOUSLY
 *  observed busy, on samples taken after the first press, before the second stop
 *  key is allowed to land.
 *
 *  ── The defect this closes (live, 2026-09-11 10:25, session 270c7cf7) ──────
 *  Ctrl-C at an IDLE claude-cli prompt is not a no-op: a second one exits the
 *  program. The daemon log shows both presses 215ms apart with NO busy→idle
 *  state line between them, then the session dying 2.6s later:
 *
 *    10:25:45.231 turn interrupted via Ctrl-C   <- first press
 *    10:25:45.446 turn interrupted via Ctrl-C   <- second press, 215ms later
 *    10:25:48.060 status: generating → stopped  <- claude-cli exited
 *
 *  Every pre-existing guard read the SAME cached observation: the wait polls
 *  adapter.getStatus(), which returns the cached FsmDriver `latestState`, and
 *  interruptTurn() re-checks that same value. The cache refreshes only when the
 *  CLI repaints (pty chunk → 80ms screen debounce → reevaluate → state_changed),
 *  with no periodic re-evaluation, so a 120ms poll and a 200ms press delay hold
 *  at most one or two samples — an idle repaint landing just after a poll is
 *  seen only AFTER the second press went out.
 *
 *  Requiring the busy run to span at least one full debounce+poll cycle means a
 *  repaint that already happened has necessarily been seen. Samples taken before
 *  the first press are discarded, so "still busy" is positive evidence gathered
 *  after the press. Sized at 260ms = 80ms debounce + 120ms poll + margin. */
export const INTERRUPT_SECOND_PRESS_MIN_BUSY_DWELL_MS = 260;
/** Head-room added to the idle timeout when reserving the driver's FIFO drain.
 *
 *  The reservation must outlive the idle wait AND the write that follows it, or
 *  it would lapse in the window between the two and let a leftover entry take
 *  the idle prompt — the very race it exists to close (SEND-NOW-WRONG-ITEM). It
 *  is only a backstop: the sequence releases it explicitly in a `finally`. */
export const DRAIN_RESERVE_SLACK_MS = 5_000;

/** The status surface the wait reads. Structural — the spec adapter and test doubles both satisfy it. */
export interface InterruptWaitTarget {
    getStatus?(options?: { allowParse?: boolean }): { status?: string } | undefined;
}

function readStatus(target: InterruptWaitTarget): string | undefined {
    try {
        return target.getStatus?.()?.status;
    } catch {
        return undefined;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for the target to leave every busy status. Resolves true on the first
 * observed non-busy status, false on timeout — or on a DEAD status, which is
 * reported through `onTerminalStatus` and never counted as idle.
 *
 * "Busy" is `isBusyStatus` from the one status vocabulary (class `working` or
 * `blocked`); "dead" is `isDeadStatus`. ★ Dead statuses are not busy, so a plain
 * "not busy ⇒ idle" test reports a dead session as a successful interrupt. That
 * produced the self-contradictory live pair in the 10:25 trace: `generating →
 * stopped`, then `interrupt → idle → requeued` 330ms later — the body was parked
 * in a FIFO the shutdown sweep discarded 5s after, while the dashboard was told
 * the steer had succeeded. The dead check therefore runs BEFORE the busy check.
 *
 * `secondPress`, when supplied, is invoked ONCE — the extra stop-key press
 * described at INTERRUPT_SECOND_PRESS_DELAY_MS — only when BOTH hold:
 * `secondPressAfterMs` has elapsed since the first press, AND the session has
 * been observed CONTINUOUSLY busy for at least `minBusyDwellMs` on samples taken
 * after this wait began (SEND-NOW-SECOND-PRESS-KILL). An `undefined` status
 * (the adapter threw, or has no state yet) is NOT busy: it breaks the dwell run.
 * Unknown is not evidence of generating; fail-closed costs only a slower abort.
 */
export async function waitForIdleAfterInterrupt(
    target: InterruptWaitTarget,
    timeoutMs: number = INTERRUPT_IDLE_TIMEOUT_MS,
    pollMs: number = INTERRUPT_IDLE_POLL_MS,
    options?: {
        secondPress?: () => void;
        secondPressAfterMs?: number;
        minBusyDwellMs?: number;
        onTerminalStatus?: (status: string) => void;
    },
): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const secondPressAt = options?.secondPress
        ? startedAt + (options.secondPressAfterMs ?? INTERRUPT_SECOND_PRESS_DELAY_MS)
        : Number.POSITIVE_INFINITY;
    const minBusyDwellMs = options?.minBusyDwellMs ?? INTERRUPT_SECOND_PRESS_MIN_BUSY_DWELL_MS;
    let pressed = false;
    /** Start of the current uninterrupted run of busy observations (strictly after the first press). */
    let busySince: number | null = null;
    for (;;) {
        const status = readStatus(target);
        if (status !== undefined && isDeadStatus(status)) {
            options?.onTerminalStatus?.(status);
            return false;
        }
        if (status !== undefined && !isBusyStatus(status)) return true;
        const now = Date.now();
        if (status === undefined) busySince = null;
        else if (busySince === null) busySince = now;
        if (now >= deadline) return false;
        const busyLongEnough = busySince !== null && now - busySince >= minBusyDwellMs;
        if (!pressed && now >= secondPressAt && busyLongEnough) {
            pressed = true;
            // Still busy after the first press, confirmed by observations that
            // span a full repaint window. interruptTurn re-validates capability
            // and 'generating' before writing, so this is a no-op if the session
            // has meanwhile parked on a modal.
            options?.secondPress?.();
        }
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
}
