// ---------------------------------------------------------------------------
// chat-tail-missing-session-backoff — retry policy for chat_tail subscriptions
// whose target session is not in the live registry.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: a `session.chat_tail` subscription is only ever removed by an
// explicit client `unsubscribe` (see handleSubscribe / 'unsubscribe' in
// data-channel-router.ts). When a session is destroyed daemon-side — the user
// stops an agent, a mesh worker session is reclaimed — the dashboard's
// subscription stays registered. Every flush then calls `read_chat`, which
// fails the live-session lookup in ~0ms:
//
//   [WRN] [Command] [read_chat] end success=false duration=0ms
//     error="Live session not found for targetSessionId: <uuid>"
//
// Because the failure is instantaneous it does no useful work and never yields
// to the debounce that normally paces flushes, so `flushP2PChatSubscriptions`'s
// pending-flush tail re-enters at CPU speed. Observed live: 95 such warns for a
// single session in ~40s, in bursts of 10–27 at ~36ms spacing (the `concurrency:
// 4` batch), starting 1.2s after `🛑 Agent stopped: claude-cli`.
//
// The fix is a per-subscription retry policy rather than a change to the flush
// cadence, because the flush cadence is correct for every HEALTHY subscription —
// only the permanently-missing session needs to be paced and eventually dropped.
//
// ── The correctness constraint that shapes this file ────────────────────────
// "Session is missing" is genuinely ambiguous. It means BOTH:
//   (a) not yet — the session is still booting and its registry entry has not
//       landed. Giving up here would leave a live session with a dead chat pane.
//   (b) never again — the session was destroyed. Retrying here is pure waste.
// These are indistinguishable from a single failed read, so this policy
// separates them on TIME, not on the first observation: a generous grace window
// during which we retry at the normal cadence (so a booting session attaches as
// fast as it always did), then exponential backoff, then give up.
//
// Give-up is safe: the dashboard re-subscribes whenever it reopens/reselects the
// session, so a dropped subscription for a session that somehow returns is
// re-established by the client rather than being lost forever.

/** Immutable tuning for the missing-session retry policy. */
export interface ChatTailMissingSessionPolicy {
    /**
     * How long after the FIRST missing read we keep retrying every flush with no
     * backoff at all. Covers the "still booting" case (a). Sized well above
     * session-registry attach latency so a slow-starting session is never paced
     * down while it is legitimately on its way up.
     */
    graceMs: number;
    /** First backoff step applied once the grace window has elapsed. */
    initialBackoffMs: number;
    /** Ceiling for the exponential backoff. */
    maxBackoffMs: number;
    /**
     * Total time a session may stay missing before the subscription is dropped
     * entirely. Past this we conclude case (b).
     */
    giveUpAfterMs: number;
}

export const DEFAULT_CHAT_TAIL_MISSING_SESSION_POLICY: ChatTailMissingSessionPolicy = {
    // 10s of normal-cadence retries: comfortably longer than a session-registry
    // attach, short enough that a genuinely dead session starts backing off well
    // before it can produce a meaningful number of warns.
    graceMs: 10_000,
    initialBackoffMs: 1_000,
    // 30s ceiling — matches the idle status heartbeat, so a lingering
    // subscription costs at most one read per heartbeat instead of ~20/sec.
    maxBackoffMs: 30_000,
    // 5 min. Past this the session is not coming back under this subscription;
    // the dashboard re-subscribes on reopen if it ever does.
    giveUpAfterMs: 5 * 60_000,
};

/**
 * Per-subscription missing-session tracking. Absent (undefined) on a healthy
 * subscription — the state is created on the first missing read and cleared the
 * moment a read succeeds, so a session that recovers pays no lasting penalty.
 */
export interface ChatTailMissingSessionState {
    /** Epoch ms of the first consecutive missing read. */
    firstMissingAt: number;
    /** Epoch ms of the most recent missing read. */
    lastAttemptAt: number;
    /** Consecutive missing reads observed. */
    consecutiveMisses: number;
    /** Whether the one-time diagnostic for this streak has been emitted. */
    warned: boolean;
}

export type ChatTailMissingSessionDecision =
    /** Do the read this flush. */
    | { action: 'attempt' }
    /** Still missing, but inside a backoff window — skip this flush silently. */
    | { action: 'skip' }
    /** Missing long enough to be considered gone — drop the subscription. */
    | { action: 'drop' };

/**
 * Decide whether a subscription whose session is currently missing should be
 * read again now. Pure: `now` is injected so this is deterministic under test.
 */
export function decideMissingSessionAttempt(
    state: ChatTailMissingSessionState | undefined,
    now: number,
    policy: ChatTailMissingSessionPolicy = DEFAULT_CHAT_TAIL_MISSING_SESSION_POLICY,
): ChatTailMissingSessionDecision {
    // No streak recorded yet — this is either a healthy subscription or the very
    // first miss, which must always be attempted so the miss can be observed.
    if (!state) return { action: 'attempt' };

    const missingFor = now - state.firstMissingAt;
    if (missingFor >= policy.giveUpAfterMs) return { action: 'drop' };

    // Inside the grace window the session may still be booting: retry at the
    // normal flush cadence so attach latency is unchanged from before this fix.
    if (missingFor < policy.graceMs) return { action: 'attempt' };

    // Past the grace window: exponential backoff keyed off how many misses we
    // have already absorbed during backoff, capped at maxBackoffMs.
    const sinceLastAttempt = now - state.lastAttemptAt;
    return sinceLastAttempt >= resolveBackoffMs(state, policy)
        ? { action: 'attempt' }
        : { action: 'skip' };
}

/**
 * Backoff for the NEXT attempt: doubles per miss recorded after the grace
 * window, capped. Uses a bounded exponent so a long-lived streak cannot
 * overflow into Infinity/NaN before `giveUpAfterMs` retires it.
 */
export function resolveBackoffMs(
    state: ChatTailMissingSessionState,
    policy: ChatTailMissingSessionPolicy = DEFAULT_CHAT_TAIL_MISSING_SESSION_POLICY,
): number {
    const stepsIntoBackoff = Math.max(0, state.consecutiveMisses - 1);
    const boundedExponent = Math.min(stepsIntoBackoff, 20);
    const scaled = policy.initialBackoffMs * Math.pow(2, boundedExponent);
    return Math.min(scaled, policy.maxBackoffMs);
}

/** Fold a missing read into the streak state, returning the updated state. */
export function recordMissingSessionAttempt(
    state: ChatTailMissingSessionState | undefined,
    now: number,
): ChatTailMissingSessionState {
    if (!state) {
        return { firstMissingAt: now, lastAttemptAt: now, consecutiveMisses: 1, warned: false };
    }
    return {
        firstMissingAt: state.firstMissingAt,
        lastAttemptAt: now,
        consecutiveMisses: state.consecutiveMisses + 1,
        warned: state.warned,
    };
}

/**
 * Whether this missing read should emit the one-time diagnostic. Exactly one
 * warn per streak: the actionable content is "this subscription's session went
 * away", which does not become more informative by repeating ~20 times a second.
 * Subsequent misses in the same streak stay at debug so the cause is still
 * traceable when debug logging is on.
 */
export function shouldWarnForMissingSession(state: ChatTailMissingSessionState): boolean {
    return !state.warned;
}

/**
 * Recognize the command-handler rejection for a session that is not in the live
 * registry. Matches `handler.ts`'s `Live session not found for targetSessionId:`
 * — the sessionLookupFailed branch. Deliberately narrow: an unrelated read_chat
 * failure (provider crash, transport error) must NOT be paced by this policy,
 * because those are not the "session is gone" case and have their own handling.
 */
export function isMissingLiveSessionResult(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const { success, error } = result as { success?: boolean; error?: unknown };
    if (success !== false || typeof error !== 'string') return false;
    return error.startsWith('Live session not found for targetSessionId:');
}
