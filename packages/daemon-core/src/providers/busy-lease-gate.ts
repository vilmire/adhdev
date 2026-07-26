/**
 * TX-FSM Stage 2 — bounded busy lease rollout gate.
 *
 * The bounded busy lease (see transcript-signal-source.ts) changes FSM/completion
 * JUDGMENT, so it does not ship to every provider at once: it is gated per
 * provider type behind a canary list. The default canary is the Stage-2 goal's
 * designated pair (kimi, codex-cli); the rollout widens by env, not by code:
 *
 *   ADHDEV_TX_BUSY_LEASE_PROVIDERS  — comma-separated provider types the lease
 *                                     is enabled for (REPLACES the default
 *                                     canary when set; set to an empty value
 *                                     like "-" to disable everywhere).
 *   ADHDEV_TX_BUSY_LEASE_BOUND_MS   — lease bound override (field tuning;
 *                                     defaults to BUSY_LEASE_BOUND_MS).
 *
 * This is a ROLLOUT gate, not a classification: transcript class/timing still
 * go through resolveTranscriptAuthorityProfile exclusively, and the lease only
 * ever has data to act on for a native-source class (the signal source fails
 * open otherwise). A provider absent from the list observes ZERO behaviour
 * change — the lease branch is skipped before any lease state is consulted.
 */
'use strict';

/**
 * Default lease bound: 180s. Rationale:
 *  - During genuine work the transcript keeps advancing, so every probe
 *    RE-ISSUES the lease and the bound never limits real work (the observed
 *    long-quiet completions — codex 363s PTY-quiet, a 4m48s hero worker, kimi
 *    8m22s — all had continuously advancing transcripts; PTY quiet ≠ lease
 *    expiry).
 *  - The bound only starts mattering AFTER the transcript's last observed
 *    advance. It must comfortably cover the final-assistant write-lag on top
 *    of the 60s growth-quiet window (MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS),
 *    so 3× that window.
 *  - It must stay short enough that a genuinely wedged/finished session is not
 *    held busy indefinitely: 180s matches the idle stall-watchdog threshold, so
 *    a wedge surfaces on the same cadence as before Stage 2, and it is far
 *    below the 15-min reclaim deadline. Expiry returns the judgment to the
 *    unchanged floor/cap logic — the lease can never create an infinite busy.
 */
export const BUSY_LEASE_BOUND_MS = 180_000;

/** Stage-2 goal canary: the lease ships to these provider types first. */
const DEFAULT_CANARY_PROVIDERS = ['kimi', 'codex-cli'];

export interface BusyLeaseGate {
    /** True when the bounded busy lease may gate judgments for this provider. */
    enabled: boolean;
    /** The lease bound in effect (default or env override). */
    boundMs: number;
}

export function resolveBusyLeaseGate(
    providerType: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): BusyLeaseGate {
    const boundRaw = Number(env.ADHDEV_TX_BUSY_LEASE_BOUND_MS);
    const boundMs = Number.isFinite(boundRaw) && boundRaw > 0 ? Math.floor(boundRaw) : BUSY_LEASE_BOUND_MS;
    const listRaw = env.ADHDEV_TX_BUSY_LEASE_PROVIDERS;
    const list = (typeof listRaw === 'string' ? listRaw : DEFAULT_CANARY_PROVIDERS.join(','))
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const type = (providerType ?? '').trim();
    return { enabled: type.length > 0 && list.includes(type), boundMs };
}
