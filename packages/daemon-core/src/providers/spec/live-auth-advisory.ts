/**
 * Auth/billing classification POLICY for a spec-backed CLI's PTY output.
 *
 * `kimi-auth-billing.ts` answers "does this text look like a provider failure?".
 * This module answers "what is the daemon allowed to DO about it?", which
 * depends on whether the process is still alive. SpecCliAdapter owns the state
 * fields and the side effects; everything here is a pure decision so the policy
 * has one home and the adapter stays under the file-size gate.
 *
 * ── AUTH-EXPIRY-GENERALIZATION (D4) ──────────────────────────────────────────
 * The observer used to return early for every non-kimi provider, so a spec CLI
 * that printed an expired-credential banner produced NO classification at all.
 * Live: claude-cli session b23d10ee answered "Login expired · Please run /login"
 * in 34s with zero content on 2026-09-20 and swallowed another task on 09-21.
 * The AUTH axis is therefore evaluated for every spec-backed CLI — an expired
 * credential is universal and its wording is provider-neutral.
 *
 * BILLING and QUOTA stay kimi-scoped deliberately. Their vocabulary is Kimi's
 * entitlement model, the quota bucket is gated on an HTTP failure envelope only
 * Kimi emits, and the quota axis is already covered for every provider by
 * mesh-quota-routing.ts. Widening them would re-risk the 2026-08-29
 * misclassification without covering anything the mesh does not already handle.
 *
 * ── AUTH-LIVE-CONFIRM ────────────────────────────────────────────────────────
 * A match while the PROCESS IS STILL ALIVE is a suspicion, never a verdict. The
 * 16KB tail is CONVERSATION content as much as CLI chrome, and a mesh session's
 * conversation routinely contains these exact phrases without being broken:
 *   - a coordinator reads a dead worker's transcript (banner quoted verbatim);
 *   - the daemon injects auth-failure mesh events into the PTY;
 *   - a worker on this repo prints the classifier's own test fixtures.
 * Live incident 2026-09-21 (preview): three coordinators in a row, a worker and
 * two plain sessions were flagged seconds-to-minutes after launch ("auth failure
 * detected … exitCode=pending" then "🧹 Auto-cleaned error CLI"). Each relaunch
 * re-delivered the pending auth-failure events and re-poisoned the new
 * coordinator; because the tail is append-only one quote re-matched on EVERY
 * later chunk, so the kill was inevitable once the text appeared at all.
 *
 * A live match is therefore re-checked against the VISIBLE SCREEN at a turn
 * boundary: a real banner is still there when the session idles, quoted content
 * has usually scrolled away. Mid-turn the check is deferred; after 60s of
 * unresolved suspicion it runs anyway (a session that banners and then hangs
 * "generating" forever must not defer indefinitely). Drivers with no snapshot
 * surface fall back to the tail.
 *
 * A COORDINATOR never takes a live-text outcome at all: its screen is EXPECTED
 * to display other sessions' auth failures, and removing it decapitates the mesh.
 *
 * ── AUTH-LIVE-ADVISORY (owner decision 2026-09-21) ───────────────────────────
 * For every non-kimi CLI even a screen-confirmed live match is NOT a verdict. An
 * agent's final answer can legitimately leave the words on screen at idle ("the
 * worker died with 'Login expired'"), and status 'error' is not the soft,
 * self-healing state D4 assumed: cli-manager auto-cleans an error session within
 * seconds, i.e. the daemon TERMINATES a session on a text match. Termination is
 * the coordinator's call. The daemon's job is to make the observation visible: a
 * WARN log line plus an advisory page over the existing provider-signal seam
 * (mesh:provider_signal, kind auth_error — "decide what to do about the session
 * yourself"). The page carries identifiers only, never the matched screen text:
 * that text is untrusted, and quoting it would re-poison whoever receives it.
 * Kimi keeps its established latch (its billing/quota recovery semantics depend
 * on status 'error'), now behind the same on-screen confirmation.
 *
 * Exit-context classification (the process is already dead) latches immediately
 * for every provider: there is no session left to falsely kill, only a death to
 * explain.
 *
 * ── EXIT-CONTEXT GATE ────────────────────────────────────────────────────────
 * "Only a death to explain" holds only when the death is UNEXPLAINED. The tail
 * classified at exit is the same conversation-polluted 16KB buffer, and the
 * classifier ignores the exit code, so a session that merely quoted auth wording
 * and was then stopped by the host (requestedStop, exit 129) or exited cleanly
 * (exit 0) was latched auth_failed: status 'error', MeshRecovery "Suppressing
 * automatic recovery after non-retryable provider failure", and the wrong reason
 * sent to the coordinator. A requested stop or a clean exit already has its
 * explanation, so the tail is not consulted at all. An unexpected non-zero exit
 * and an unknown/signal exit (exit code null — never collapsed to 0) still
 * classify, which keeps the b23d10ee-class and kimi billing exits intact. The
 * tail is deliberately still preferred over a final screen snapshot there: some
 * CLIs repaint the failure off-screen before exiting.
 */

import { LOG } from '../../logging/logger.js';
import { detectKimiAuthBillingFailure, stripAnsi, type KimiAuthBillingFailure } from './kimi-auth-billing.js';
import type { SignalDetection } from './signal-rules.js';

const TAIL_BYTES = 16 * 1024;
const STUCK_BUSY_ESCAPE_MS = 60_000;
/** A just-submitted prompt sits in the composer for ~1-2s while the FSM still
 *  reads idle (standalone live check 2026-09-21: a prompt that merely MENTIONED
 *  the words paged within 300ms of sendMessage). Let the idle→generating edge
 *  land before the screen is trusted as a turn boundary. */
const MIN_SUSPECT_AGE_MS = 5_000;
/** A TUI repaints its banner, so without a cooldown one expired session would
 *  page the coordinator on every idle edge. */
const ADVISORY_COOLDOWN_MS = 10 * 60_000;
export const LIVE_AUTH_ADVISORY_RULE_ID = 'builtin.live_auth_marker';

export interface LiveAuthState {
    suspect: { failure: KimiAuthBillingFailure; suspectedAtMs: number } | null;
    advisoryNotifiedAtMs: number;
    /** One log line per coordinator session — the tail re-matches every chunk. */
    coordinatorMarkerLogged: boolean;
}

export function createLiveAuthState(): LiveAuthState {
    return { suspect: null, advisoryNotifiedAtMs: 0, coordinatorMarkerLogged: false };
}

export interface LiveAuthContext {
    cliType: string;
    sessionLabel: string;
    isCoordinator: boolean;
}

export function appendAuthTail(tail: string, chunk: string): string {
    return `${tail}${stripAnsi(chunk)}`.slice(-TAIL_BYTES);
}

/** Classify, admitting only the AUTH axis for non-kimi providers (see D4 above). */
export function classifyAuthBillingOutput(cliType: string, text: string, exitCode?: number): KimiAuthBillingFailure | null {
    const failure = detectKimiAuthBillingFailure(text, exitCode);
    if (!failure) return null;
    if (cliType !== 'kimi' && failure.failureKind !== 'auth') return null;
    return failure;
}

/** EXIT-CONTEXT GATE: consult the tail only for an unexplained death (see above). */
export function exitClassificationAllowed(
    exitCode: number | null | undefined,
    termination?: { requestedStop?: string | null } | null,
): boolean {
    if (termination?.requestedStop) return false;
    return exitCode !== 0;
}

export function authBillingLatchLogLine(cliType: string, failure: KimiAuthBillingFailure, context: string): string {
    const suppressionNote = failure.failureKind === 'quota'
        ? 'this PTY session will not be blindly restarted; the mesh may retry once quota resets'
        : 'automatic provider retry must be suppressed';
    return `[${cliType}] ${failure.failureKind} failure detected from live PTY/exit (${context}); ${suppressionNote}`;
}

/** Record a live (process-alive) match as a suspicion. Never changes status. */
export function noteLiveAuthMatch(state: LiveAuthState, ctx: LiveAuthContext, failure: KimiAuthBillingFailure): void {
    if (ctx.isCoordinator) {
        if (!state.coordinatorMarkerLogged) {
            state.coordinatorMarkerLogged = true;
            LOG.info('SpecAdapter', `[${ctx.cliType}] live ${failure.failureKind} marker in COORDINATOR PTY tail (session=${ctx.sessionLabel}) — ignored: a coordinator's screen quotes other sessions' failures; only its exit is classified`);
        }
        return;
    }
    if (state.suspect) return;
    state.suspect = { failure, suspectedAtMs: Date.now() };
    LOG.info('SpecAdapter', `[${ctx.cliType}] live ${failure.failureKind} marker in PTY tail (session=${ctx.sessionLabel}) — suspicion only, session untouched; checking the visible screen at the next turn boundary`);
}

export interface LiveAuthResolution {
    /** Drop the append-only tail so only NEW output can re-raise the suspicion. */
    clearTail?: boolean;
    /** Page the coordinator (non-kimi). The session is left running. */
    advisory?: SignalDetection;
    /** Latch status 'error' (kimi only). */
    latch?: KimiAuthBillingFailure;
}

/** Resolve a pending suspicion at a turn boundary. Runs on the routine status poll. */
export function resolveLiveAuthSuspect(
    state: LiveAuthState,
    ctx: LiveAuthContext,
    input: { midTurn: boolean; readScreen: () => string; tail: string; now?: number },
): LiveAuthResolution {
    const suspect = state.suspect;
    if (!suspect) return {};
    const now = input.now ?? Date.now();
    const ageMs = now - suspect.suspectedAtMs;
    if (ageMs < MIN_SUSPECT_AGE_MS) return {};
    if (input.midTurn && ageMs < STUCK_BUSY_ESCAPE_MS) return {};
    state.suspect = null;
    // Re-check at confirm time too — the relay stamp path can mark a session as a
    // coordinator after the suspicion was recorded.
    if (ctx.isCoordinator) return {};

    let screen = '';
    try { screen = input.readScreen() || ''; } catch { screen = ''; }
    const confirmed = classifyAuthBillingOutput(ctx.cliType, screen || input.tail);
    if (!confirmed) {
        LOG.info('SpecAdapter', `[${ctx.cliType}] live ${suspect.failure.failureKind} marker no longer on screen at turn boundary (session=${ctx.sessionLabel}) — dismissed as quoted content`);
        return { clearTail: true };
    }
    if (ctx.cliType === 'kimi') return { latch: confirmed };

    if (now - state.advisoryNotifiedAtMs < ADVISORY_COOLDOWN_MS) return { clearTail: true };
    state.advisoryNotifiedAtMs = now;
    LOG.warn('SpecAdapter', `[${ctx.cliType}] possible ${confirmed.failureKind} failure ON SCREEN at turn boundary (session=${ctx.sessionLabel}) — ADVISORY ONLY: session left running and dispatchable, coordinator notified; stopping it is the coordinator's decision`);
    return {
        clearTail: true,
        advisory: {
            ruleId: LIVE_AUTH_ADVISORY_RULE_ID,
            kind: 'auth_error',
            params: { reason: confirmed.errorReason, action: 'advisory_session_not_stopped' },
            detectedAt: now,
        },
    };
}
