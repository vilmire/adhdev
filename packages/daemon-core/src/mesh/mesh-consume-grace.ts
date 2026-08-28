/**
 * CONSUME-GRACE — how long a delivered-but-unconsumed dispatch may sit before the
 * `delivered_not_consumed_redrive` watchdog re-opens it.
 *
 * The grace answers one question: "has this worker had a fair chance to START the turn
 * yet?" It is NOT a turn budget (that is DELIVERED_NO_TURN_DEADLINE_MS, 15min) — it only
 * covers spawn → interactive → first token.
 *
 * Why this module exists. The grace used to be a single 25s constant, which measurement
 * showed sat BELOW the p95 boot→consume latency of every provider in the fleet
 * (mesh-runtime.db, 1,094 successful consumes, 2026-08-28):
 *
 *   provider          n     p50     p90     p95     p99
 *   claude-cli        678   12.2s   15.9s   21.4s    30.3s
 *   codex-cli          82    8.8s   28.3s   31.6s   247.6s
 *   kimi               64   11.3s   27.7s   28.7s   907.4s
 *   grok-cli           29    5.7s   23.1s   23.2s    30.4s
 *   antigravity-cli    16   22.7s   34.6s   37.5s    37.5s
 *
 * 77 of those 1,094 consumes (7%) exceeded 25s — every one a worker that was booting
 * normally and would have been torn off its task had the watchdog reached it first. The
 * floor below is sized above the slowest measured p95 (antigravity 37.5s) with headroom
 * for a cold TUI + MCP init, which is the case the constant was mis-sized against
 * (live 2026-08-28: codex task 3cd41be4 re-driven 26s after autoLaunch completed, its
 * session then unrecoverable — "Session not found").
 *
 * Cost of being wrong in each direction is asymmetric, which is why the floor is generous:
 * waiting too long merely delays recovery of a genuinely dead worker by seconds (and the
 * liveness gates in the caller already cover the common dead cases); re-driving too early
 * destroys a live worker's turn AND re-injects the same prompt, which the fleet observed
 * as double execution and silent provider flips.
 */

/**
 * Global floor. No provider re-drives sooner than this, whatever its profile says.
 *
 * Sized above the slowest measured p95 (antigravity-cli, 37.5s) plus room for a cold
 * boot: at 90s only 10 of 1,094 measured consumes (0.9%) would still be inside the
 * window, versus 77 (7%) at the former 25s.
 */
export const CONSUME_GRACE_FLOOR_MS = 90_000;

/**
 * Boot grace for a provider whose turn start is NOT observable as a PTY event
 * (`emitsPtyTurnEvents === false` — codex-cli, cursor-cli, kimi, opencode,
 * antigravity-cli). For this class the ABSENCE of `agent:generating_started` is not
 * evidence of anything: the worker signals through its native transcript, so the only
 * proof of life is a read_chat round trip. They also carry the heaviest cold starts
 * (codex p99 247.6s, kimi p99 907.4s). Give them the widest window — a late re-drive
 * costs a few seconds of recovery latency, a premature one costs the whole turn.
 */
export const CONSUME_GRACE_NATIVE_SOURCE_MS = 180_000;

/** The subset of the transcript-authority profile this decision reads. */
export interface ConsumeGraceProfileInput {
    emitsPtyTurnEvents?: boolean;
}

/**
 * The grace for one dispatch, in ms.
 *
 * Deliberately profile-driven rather than keyed on provider NAME: the fleet adds
 * providers continuously, and a name table would silently give every new arrival the
 * short window — the exact failure mode that produced this defect. `emitsPtyTurnEvents`
 * is the property that actually determines whether a missing turn-start event means
 * anything, and it is already stamped on the queue row at claim time (so it classifies
 * REMOTE workers this coordinator cannot resolve locally).
 *
 * An UNKNOWN profile (older daemon's row, direct dispatch, unresolvable session) takes
 * the floor — never the short window. Unknown means "we cannot prove this worker is the
 * fast kind", which is a reason for patience, not haste.
 */
export function resolveConsumeGraceMs(profile?: ConsumeGraceProfileInput | null): number {
    if (profile?.emitsPtyTurnEvents === false) return CONSUME_GRACE_NATIVE_SOURCE_MS;
    return CONSUME_GRACE_FLOOR_MS;
}
