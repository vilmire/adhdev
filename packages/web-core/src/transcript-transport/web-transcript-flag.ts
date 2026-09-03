/**
 * Build-time gate for the browser transcript worker transport (design §8
 * unit 4).
 *
 * ── Why the default is `off`, unlike daemon-core's `shadow` ───────────────
 * `daemon-core/src/seqscribe/transcript-mode.ts` defaults to `shadow` because
 * the daemon can write the seqscribe leg and run parity with no user-visible
 * effect. The browser has no such harmless middle state: enabling this spawns
 * a Worker, installs an OPFS SAH pool VFS (which takes an exclusive
 * per-directory lock), and makes the daemon start dialing a dedicated
 * `seqscribe` data channel for every dashboard peer. None of that buys
 * anything until a consumer reads the replica (§8 unit 5), so the cost is
 * currently all downside.
 *
 * This is therefore a foundation that ships INERT. The web chat pane keeps
 * running on legacy `session.chat_tail`, which stays the only path until unit
 * 5 flips a consumer over deliberately.
 *
 * ── Why a build-time flag rather than the env tri-state ───────────────────
 * `off | shadow | primary` describes dual-write/parity states that only make
 * sense where both legs exist. The browser has one leg, so the only real
 * question here is "is the transport wired at all" — a boolean. When unit 5
 * introduces a browser read path with a legacy fallback, that is when a
 * richer mode belongs, and it should mirror the daemon's vocabulary then.
 */

/** Vite exposes `import.meta.env`; typed loosely so this module stays bundler-agnostic. */
export interface TranscriptFlagEnv {
    readonly VITE_ADHDEV_TRANSCRIPT_WORKER?: unknown;
}

/**
 * True only when explicitly opted in with the string `'on'`.
 *
 * Fail-closed on every other value, including `'true'`/`'1'`: an ambiguous
 * value should not silently spawn a worker and change the daemon's dial
 * behavior. There is exactly one spelling that turns this on.
 */
export function isTranscriptWorkerEnabled(env: TranscriptFlagEnv): boolean {
    const raw = env.VITE_ADHDEV_TRANSCRIPT_WORKER;
    return typeof raw === 'string' && raw.trim().toLowerCase() === 'on';
}
