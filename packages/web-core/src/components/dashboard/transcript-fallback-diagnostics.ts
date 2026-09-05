/**
 * (§8 unit 9) Browser-local counters for replica→legacy REGRESSIONS.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Unit 9 retires the legacy push transport per session and re-arms it on any
 * fallback. That auto-recovery is what makes an empty pane impossible — and it
 * is also, on its own, a silent-failure machine: a replica lane can break, the
 * pane can quietly return to legacy, and nobody learns the replica is broken.
 * On preview, where the whole point is to find out whether the replica works,
 * that would defeat the exercise.
 *
 * So every regression is both SHOWN (the pane's degradation notice) and COUNTED
 * here, so an operator can ask "has this browser session fallen back, and why"
 * without watching the screen at the moment it happened.
 *
 * ── Server content boundary (CLAUDE.md) ────────────────────────────────────
 * ★ These counters are BROWSER-LOCAL and must stay that way. Nothing here is
 * reported to the server: they are not wired into `status_report`, not into
 * `RoutingSessionEntry`, and not into any P2P frame — the module has no
 * transport dependency at all, and the only writer is the controller running in
 * this tab.
 *
 * They are also content-free by construction: the shape is integers plus
 * closed-union reason strings. No session id, no daemon id, no message content,
 * no topic name. That is deliberate even for a local surface — it keeps the
 * counters safe to log or surface anywhere later without re-auditing them, and
 * removes any temptation to key them by session (which is how an identifier
 * would eventually leak into a report).
 */

/** Closed-union fallback reasons, mirrored from the controller's callers. */
export interface TranscriptFallbackDiagnostics {
    /**
     * Replica→legacy regressions since page load. Counts only sessions that had
     * a WORKING replica and lost it — never a session that was legacy all along,
     * which is the normal state on a `shadow`-mode daemon and not a fault.
     */
    regressions: number;
    /** Per-reason breakdown of the same regressions. Reason strings only — no ids. */
    byReason: Record<string, number>;
    /** The most recent regression reason, or null if none has happened. */
    lastReason: string | null;
    /**
     * `Date.now()` at module load — effectively page load.
     *
     * ★ Mirrors the daemon's `transcriptParityCounters().since` and exists for
     * the same reason: without it, `regressions: 0` cannot be told apart from
     * "this tab opened ten seconds ago". A zero must always be dated.
     */
    since: number;
}

const counters: TranscriptFallbackDiagnostics = {
    regressions: 0,
    byReason: {},
    lastReason: null,
    since: Date.now(),
};

/**
 * Record one replica→legacy regression.
 *
 * Called ONLY on a genuine transition (the session had a healthy replica and
 * lost it). The controller is responsible for that gating — see
 * `everHadHealthyReplica` — so this function never has to decide whether a
 * fallback is meaningful.
 */
export function recordTranscriptReplicaFallbackForDiagnostics(reason: string): void {
    counters.regressions += 1;
    counters.byReason[reason] = (counters.byReason[reason] ?? 0) + 1;
    counters.lastReason = reason;
}

/** Read the counters. Returns a copy so callers cannot mutate the module state. */
export function transcriptFallbackDiagnostics(): TranscriptFallbackDiagnostics {
    return { ...counters, byReason: { ...counters.byReason } };
}

/** TESTS ONLY — counters are module-level and would otherwise leak across cases. */
export function __resetTranscriptFallbackDiagnosticsForTests(): void {
    counters.regressions = 0;
    counters.byReason = {};
    counters.lastReason = null;
    counters.since = Date.now();
}
