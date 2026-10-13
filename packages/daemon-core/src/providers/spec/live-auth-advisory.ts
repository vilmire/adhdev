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
import { detectProviderFailure, type ProviderFailure } from './provider-failure-classifier.js';
import type { SignalDetection } from './signal-rules.js';

/** Exported so `cli-adapter.ts` can pass the same window to `RawTail.strippedTail()`
 *  (C6, wiring-unification) — the auth/billing classifier's read window is
 *  unchanged; only where the tail bytes live moved (one shared `RawTail`, not
 *  a private accumulator this module used to own via `appendAuthTail`). */
export const TAIL_BYTES = 16 * 1024;
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

/**
 * ── PROVIDER ATTRIBUTION (rc12 finding 2026-10-13) ───────────────────────────
 * The classifier's patterns are provider-agnostic, but the session they would
 * flag is not. A mesh session routinely QUOTES another provider's auth error:
 * an antigravity worker investigating a codex quota bug printed codex's
 * `wham/usage failed: 401 Unauthorized … token_revoked` line, the `unauthorized`
 * rule matched, and the antigravity session got an auth advisory (and would
 * have been latched auth_failed on an unexpected exit) for a credential it
 * does not even use.
 *
 * So before the AUTH axis may speak for `cliType`, every region of the tail
 * that names ANOTHER provider (its host, CLI name or vendor) is masked out, and
 * the remainder is classified again. If the auth evidence lived only in the
 * foreign region, the result is null — "no evidence about THIS provider", which
 * is unknown, never a verdict either way. A genuine banner from the owning CLI
 * does not name a competitor and is untouched, so own-provider detection is
 * unchanged. Providers absent from the marker table (unknown cliType) keep the
 * old behaviour: nothing is masked.
 *
 * Granularity: a marker masks its own line plus up to FOREIGN_CONTEXT_LINES
 * neighbouring lines on each side (a wrapped error body: the URL and the
 * `401 Unauthorized` often land on adjacent lines), never crossing a blank
 * line. A single over-long line is masked only within FOREIGN_CONTEXT_CHARS of
 * each marker, so a tail without newlines cannot hide an unrelated banner.
 */
const PROVIDER_MARKERS: Record<string, RegExp> = {
    'codex-cli': /chatgpt\.com|backend-api\/|wham\/usage|\bcodex(?:-cli)?\b|\bopenai\b/i,
    'claude-cli': /\banthropic\b|\bclaude(?:-cli)?\b|claude\.ai/i,
    'antigravity-cli': /\bantigravity(?:-cli)?\b|\bagy\b|cloudcode-pa\.googleapis/i,
    'kimi': /\bkimi(?:-cli)?\b|\bmoonshot\b/i,
    'cursor-cli': /\bcursor-(?:agent|cli)\b|cursor\.(?:com|sh)\b/i,
    'grok-cli': /\bgrok(?:-cli)?\b|\bx\.ai\b/i,
    'opencode': /\bopencode\b/i,
};
const FOREIGN_CONTEXT_LINES = 2;
const FOREIGN_CONTEXT_CHARS = 240;
const LONG_LINE_CHARS = 2 * FOREIGN_CONTEXT_CHARS;

function foreignMarkerFor(cliType: string): RegExp | null {
    if (!(cliType in PROVIDER_MARKERS)) return null;
    const sources = Object.entries(PROVIDER_MARKERS)
        .filter(([provider]) => provider !== cliType)
        .map(([, re]) => `(?:${re.source})`);
    return new RegExp(sources.join('|'), 'gi');
}

/**
 * The tail with every region attributed to a provider OTHER than `cliType`
 * blanked (see PROVIDER ATTRIBUTION). Exported for tests.
 */
export function maskForeignProviderText(cliType: string, text: string): string {
    const marker = foreignMarkerFor(cliType);
    if (!marker || !text) return text;
    const lines = text.split('\n');
    const masked = new Array<boolean>(lines.length).fill(false);
    const out = lines.slice();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        marker.lastIndex = 0;
        if (!marker.test(line)) continue;
        if (line.length > LONG_LINE_CHARS) {
            // Mask only the neighbourhood of each marker inside this one line.
            let result = '';
            let cursor = 0;
            marker.lastIndex = 0;
            for (let m = marker.exec(line); m; m = marker.exec(line)) {
                const start = Math.max(cursor, m.index - FOREIGN_CONTEXT_CHARS);
                const end = Math.min(line.length, m.index + m[0].length + FOREIGN_CONTEXT_CHARS);
                result += line.slice(cursor, start) + '\n';
                cursor = Math.max(cursor, end);
                if (m[0].length === 0) marker.lastIndex++;
            }
            out[i] = result + line.slice(cursor);
            continue;
        }
        masked[i] = true;
        for (let d = 1; d <= FOREIGN_CONTEXT_LINES && i - d >= 0 && lines[i - d]!.trim() !== ''; d++) masked[i - d] = true;
        for (let d = 1; d <= FOREIGN_CONTEXT_LINES && i + d < lines.length && lines[i + d]!.trim() !== ''; d++) masked[i + d] = true;
    }
    for (let i = 0; i < out.length; i++) if (masked[i]) out[i] = '';
    return out.join('\n');
}

/** Classify, admitting only the AUTH axis for non-kimi providers (see D4 above),
 *  and only on evidence attributable to `cliType` itself (PROVIDER ATTRIBUTION). */
export function classifyAuthBillingOutput(cliType: string, text: string, exitCode?: number): ProviderFailure | null {
    const failure = detectProviderFailure(text, exitCode);
    if (!failure) return null;
    if (cliType !== 'kimi' && failure.failureKind !== 'auth') return null;
    const own = maskForeignProviderText(cliType, text);
    if (own === text) return failure;
    const ownFailure = detectProviderFailure(own, exitCode);
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

/** Resolve a pending suspicion at a turn boundary. Runs on the routine status poll. */
export function resolveLiveAuthSuspect(
    state: LiveAuthState,
    ctx: LiveAuthContext,
    input: { midTurn: boolean; readScreen: () => string; tail: string; now?: number; submitInFlight?: boolean },
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
