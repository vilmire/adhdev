/**
 * Auth/billing classification POLICY for a spec-backed CLI's PTY output.
 *
 * `provider-failure-classifier.ts` answers "does this text look like a provider failure?".
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
import { detectProviderFailure, stripAnsi, stripToolAndCodeLines, type ProviderFailure } from './provider-failure-classifier.js';
import { maskForeignProviderText } from './provider-output-attribution.js';
import type { SignalDetection } from './signal-rules.js';

/** Exported so `cli-adapter.ts` can pass the same window to `RawTail.strippedTail()`
 *  (C6, wiring-unification) — the auth/billing classifier's read window is
 *  unchanged; only where the tail bytes live moved (one shared `RawTail`, not
 *  a private accumulator this module used to own via `appendAuthTail`). */
export const TAIL_BYTES = 16 * 1024;
/** A just-submitted prompt sits in the composer for ~1-2s while the FSM still
 *  reads idle (standalone live check 2026-09-21: a prompt that merely MENTIONED
 *  the words paged within 300ms of sendMessage). Let the idle→generating edge
 *  land before the screen is trusted as a turn boundary. */
const MIN_SUSPECT_AGE_MS = 5_000;
/** Bounded mid-turn confirmation window: when a session stays in `busy` with no
 *  recent output and a strictly anchored auth error line (native JSON
 *  authentication_error or anchored CLI/HTTP 401 banner, never tool output),
 *  surface an advisory without re-introducing the unconditional 60s busy escape. */
const MID_TURN_AUTH_CONFIRM_MS = 15_000;
const MID_TURN_QUIET_MS = 5_000;
/** A TUI repaints its banner, so without a cooldown one expired session would
 *  page the coordinator on every idle edge. */
const ADVISORY_COOLDOWN_MS = 10 * 60_000;
export const LIVE_AUTH_ADVISORY_RULE_ID = 'builtin.live_auth_marker';

/**
 * Anchored Kimi provider-UI error envelope. Kimi's live hard-error latch is
 * restricted to Kimi's own machine-tagged `[provider.auth_error]` / `[auth.*]`
 * lines or its explicit `kimi login` / `Kimi Code` banner on the settled screen,
 * never generic text.
 */
const KIMI_ANCHORED_PROVIDER_UI_ERROR_RE = /(?:^|\n)\s*(?:\[(?:provider\.auth_error|auth\.(?:login_required|token_unauthorized|token_missing))\]\s+\S|(?:✗\s+|Error:\s+)?(?:Authentication\s+failed:[^\n]*\bkimi\s+login\b|Payment\s+required:[^\n]*\bKimi\s+Code\b))/i;

/**
 * Strictly anchored mid-turn auth failure line pattern (evaluated ONLY after
 * `stripAnsi` and `stripToolAndCodeLines`, and only on lines near the bottom
 * of the screen). Matches native JSON auth errors or line-anchored CLI/HTTP 401
 * / login-expired banners at column 0..2; never matches indented tool/code/diff
 * lines, prose, or 403 quota lines.
 */
const ANCHORED_MID_TURN_AUTH_LINE_RE = /^[ \t]{0,2}(?:[●⏺✗✖⚠!]\s+)?(?:\{[^\n]*"type"\s*:\s*"authentication_error"|\{[^\n]*"error"\s*:\s*\{[^}\n]*"code"\s*:\s*"(?:token_revoked|invalid_api_key|token_expired|invalid_token)"|(?:api\s+error|http\s+error|error)\s*:\s*(?:http\s*)?401\b(?:\s+unauthorized\b|\s*[—–\-:]|\s*\{)|(?:codex|claude|antigravity|agy|kimi|cursor|grok)\b[^\n:]{0,40}(?:error|failed)\s*:\s*(?:http\s*)?401\s+unauthorized\b|login\s+expired\s*[·•—–-]\s*please\s+run\s+\/login\b|(?:(?:api\s+error|http\s+error|error)\s*:\s*)?invalid\s+authentication\s+credentials\b|\[(?:provider\.auth_error|auth\.(?:login_required|token_unauthorized|token_missing))\]\s+(?!403\b)\S)/i;

function hasAnchoredMidTurnAuthFailure(cliType: string, rawSurface: string): boolean {
    const masked = maskForeignProviderText(cliType, rawSurface);
    const stripped = stripAnsi(masked).replace(/\r\n?/g, '\n');
    const filtered = stripToolAndCodeLines(stripped);
    if (!filtered.trim()) return false;
    const rawNonEmpty = stripped.split('\n').filter(l => l.trim().length > 0);
    const bottomWindow = new Set(rawNonEmpty.slice(-8));
    for (const line of filtered.split('\n')) {
        if (ANCHORED_MID_TURN_AUTH_LINE_RE.test(line) && bottomWindow.has(line)) {
            return true;
        }
    }
    return false;
}

export interface LiveAuthState {
    suspect: { failure: ProviderFailure; suspectedAtMs: number } | null;
    advisoryNotifiedAtMs: number;
    /** One log line per coordinator session — the tail re-matches every chunk. */
    coordinatorMarkerLogged: boolean;
    /** The daemon itself asked this session to stop (adapter.shutdown()). From
     *  here on nothing about it is news: teardown takes seconds, the driver keeps
     *  emitting state, and the status poll keeps running — standalone live check
     *  2026-09-22 paged "session left running" 12s AFTER stop_cli, i.e. the
     *  coordinator would be told a session it just stopped is still running. The
     *  eventual exit is equally explained, even when the session host delivers no
     *  `termination.requestedStop` tombstone. */
    stopRequested: boolean;
}

export function createLiveAuthState(): LiveAuthState {
    return { suspect: null, advisoryNotifiedAtMs: 0, coordinatorMarkerLogged: false, stopRequested: false };
}

export interface LiveAuthContext {
    cliType: string;
    sessionLabel: string;
    isCoordinator: boolean;
}

// Keep the public test seam; completion verdicts share the same attribution.
export { maskForeignProviderText } from './provider-output-attribution.js';

/** Classify, admitting only the AUTH axis for non-kimi providers (see D4 above),
 *  and only on evidence attributable to `cliType` itself (provider-output-attribution.ts). */
export function classifyAuthBillingOutput(cliType: string, text: string, exitCode?: number): ProviderFailure | null {
    const ownFailure = detectProviderFailure(maskForeignProviderText(cliType, text), exitCode);
    if (!ownFailure) return null;
    if (cliType !== 'kimi' && ownFailure.failureKind !== 'auth') return null;
    return ownFailure;
}

/** EXIT-CONTEXT GATE: consult the tail only for an unexplained death (see above). */
export function exitClassificationAllowed(
    exitCode: number | null | undefined,
    termination?: { requestedStop?: string | null } | null,
    state?: LiveAuthState,
): boolean {
    if (termination?.requestedStop || state?.stopRequested) return false;
    return exitCode !== 0;
}

export function authBillingLatchLogLine(cliType: string, failure: ProviderFailure, context: string): string {
    const suppressionNote = failure.failureKind === 'quota'
        ? 'this PTY session will not be blindly restarted; the mesh may retry once quota resets'
        : 'automatic provider retry must be suppressed';
    return `[${cliType}] ${failure.failureKind} failure detected from live PTY/exit (${context}); ${suppressionNote}`;
}

/** Record a live (process-alive) match as a suspicion. Never changes status. */
export function noteLiveAuthMatch(state: LiveAuthState, ctx: LiveAuthContext, failure: ProviderFailure): void {
    if (state.stopRequested) return;
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
    latch?: ProviderFailure;
}

/** Resolve a pending suspicion at a turn boundary (or bounded anchored mid-turn wedge). Runs on the routine status poll. */
export function resolveLiveAuthSuspect(
    state: LiveAuthState,
    ctx: LiveAuthContext,
    input: { midTurn: boolean; readScreen: () => string; tail: string; now?: number; submitInFlight?: boolean; quietMs?: number },
): LiveAuthResolution {
    const suspect = state.suspect;
    if (!suspect) return {};
    if (state.stopRequested) { state.suspect = null; return {}; }
    const now = input.now ?? Date.now();
    const ageMs = now - suspect.suspectedAtMs;
    if (ageMs < MIN_SUSPECT_AGE_MS) return {};
    // A prompt still being written into the composer is on screen at `idle`, and
    // its own wording can carry an auth phrase. MIN_SUSPECT_AGE_MS assumes the
    // body leaves the composer within a second or two; a CLI that ingests a
    // multi-KB body over tens of seconds (antigravity) kept re-raising and
    // re-resolving the suspicion against the task text. Wait for the submit.
    if (input.submitInFlight) return {};

    let screen = '';
    try { screen = input.readScreen() || ''; } catch { screen = ''; }
    const surface = screen || input.tail;

    if (input.midTurn) {
        if (ageMs < MID_TURN_AUTH_CONFIRM_MS) return {};
        if (input.quietMs !== undefined && input.quietMs < MID_TURN_QUIET_MS) return {};
        if (!hasAnchoredMidTurnAuthFailure(ctx.cliType, surface)) return {};
    }
    if (!input.midTurn || ctx.cliType !== 'kimi') {
        state.suspect = null;
    }
    // Re-check at confirm time too — the relay stamp path can mark a session as a
    // coordinator after the suspicion was recorded.
    if (ctx.isCoordinator) return {};

    const confirmed = classifyAuthBillingOutput(ctx.cliType, surface);
    if (!confirmed) {
        LOG.info('SpecAdapter', `[${ctx.cliType}] live ${suspect.failure.failureKind} marker no longer on screen at turn boundary (session=${ctx.sessionLabel}) — dismissed as quoted content`);
        return { clearTail: true };
    }
    if (!input.midTurn && ctx.cliType === 'kimi' && KIMI_ANCHORED_PROVIDER_UI_ERROR_RE.test(surface)) {
        return { latch: confirmed };
    }

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
