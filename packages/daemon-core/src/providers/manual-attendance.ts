/**
 * ManualAttendanceTracker — provider-agnostic "is a human driving this session
 * right now" signal, used to suppress auto-approve while the user is taking
 * manual control of a session from the dashboard.
 *
 * Why this exists
 * ---------------
 * When `autoApprove` is on, an approval modal is auto-dismissed within a few
 * hundred ms of appearing. For a background mesh worker that is exactly the
 * desired delegated behavior. But for a session the user is actively watching
 * and operating (a base-node / foreground session), the auto-fire closes the
 * modal before the human can pick a button — and likewise fights their use of
 * the controlbar. The fix is to give the human a short quiet window: while they
 * are attending the session by hand, auto-approve holds; once they go idle it
 * resumes.
 *
 * The tracker holds only a timestamp. The *signal* — which commands count as
 * "a human attending" — is decided by the caller (the command handler), and is
 * the same set for every provider: foreground tab selection (select_session /
 * open_panel), controlbar use (invoke_provider_script / set_mode / change_model
 * / set_thought_level), manual approval (resolve_action) and manual terminal
 * input (pty_input). Notably NOT send_chat, which is also how a coordinator
 * delegates a task to a worker — counting it would wrongly suppress the
 * worker's delegated auto-approve.
 *
 * Because a background worker never receives any of those attending commands,
 * it is never "attended", so its delegated auto-approve is unaffected. The
 * mechanism is therefore provider-common AND preserves worker auto-approve
 * without any per-provider branching.
 */

/**
 * How long after the last manual interaction auto-approve stays suppressed.
 *
 * Trade-off: long enough that after foregrounding a session's tab the user has
 * a realistic chance to act on an incoming approval (the auto-approve settle
 * window is only ~600ms, so a human cannot out-race it), yet short enough that
 * a session left unattended — e.g. a worker tab the user briefly peeked at —
 * resumes auto-approving within about a minute. Re-armed on every attending
 * command, so a user who keeps interacting keeps the window fresh.
 */
export const AUTO_APPROVE_MANUAL_ATTENDANCE_SUPPRESS_MS = 60_000;

export class ManualAttendanceTracker {
    private lastInteractionAt = 0;

    constructor(private readonly suppressMs: number = AUTO_APPROVE_MANUAL_ATTENDANCE_SUPPRESS_MS) {}

    /** Record that a human just drove this session by hand. */
    note(now = Date.now()): void {
        this.lastInteractionAt = now;
    }

    /** True while a manual interaction is recent enough to suppress auto-approve. */
    isAttended(now = Date.now()): boolean {
        return this.lastInteractionAt > 0 && (now - this.lastInteractionAt) < this.suppressMs;
    }

    /**
     * Milliseconds remaining in the current suppression window, or 0 when not
     * attended. Used to re-arm a re-check timer so auto-approve fires the moment
     * the window lapses even if the PTY/agent has since gone silent.
     */
    remainingMs(now = Date.now()): number {
        if (this.lastInteractionAt <= 0) return 0;
        return Math.max(0, this.suppressMs - (now - this.lastInteractionAt));
    }
}

/**
 * The session-scoped commands that count as "a human is attending this session
 * by hand". Shared so the command handler and any forward path agree on one
 * definition. Deliberately excludes send_chat (coordinator task delegation) and
 * pure read commands (read_chat / list_chats — passive polling, not driving).
 */
export const MANUAL_ATTENDANCE_COMMANDS: ReadonlySet<string> = new Set([
    'select_session',
    'open_panel',
    'invoke_provider_script',
    'set_mode',
    'change_model',
    'set_thought_level',
    'resolve_action',
    'pty_input',
]);

/**
 * The subset of {@link MANUAL_ATTENDANCE_COMMANDS} that are PASSIVE view-only
 * actions — foregrounding a session's tab / opening its panel. They convey "I am
 * looking at this session", not "I am driving it", and carry no user input.
 *
 * For a foreground (base-node) session these still attend: a user who
 * foregrounds their own session should get the quiet window so an incoming
 * approval stays visible for them to act on. But for a DELEGATED worker session
 * a passive peek must NOT attend — a coordinator merely opening a worker's panel
 * to watch progress would otherwise suppress that worker's delegated
 * auto-approve for the whole window (secondary cause, #137). The per-instance
 * hook decides: it drops a passive stamp only when the session is a delegated
 * worker, so explicit input (controlbar / resolve_action / pty_input) still
 * attends a worker and a foreground session is unaffected.
 */
export const MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS: ReadonlySet<string> = new Set([
    'select_session',
    'open_panel',
]);
