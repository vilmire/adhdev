/**
 * `ADHDEV_SEQSCRIBE_TRANSCRIPT` mode gate (design §5.1, §8 unit 2).
 *
 * Same three-value shape as `ADHDEV_SEQSCRIBE_MESH` (mesh-dual-write.ts), but a
 * DIFFERENT safe default. Mesh's absent-env default is `primary` because Phase 2
 * already completed its read cutover fleet-wide. Transcript has not: "미설정/
 * 미인식 값의 안전 기본은 `shadow`다" (design §5.1) — this unit ships the
 * publisher/parity machinery but no consumer reads the replica yet (§8 units
 * 5-8), so there is nothing for `primary` to safely default to. `shadow` writes
 * the seqscribe leg (once a live node/topic exists — §8 unit 3) and runs parity
 * without moving any read off the existing `session.chat_tail`/`read_chat`
 * paths.
 */

import { LOG } from '../logging/logger.js';

export const TRANSCRIPT_MODE_ENV = 'ADHDEV_SEQSCRIBE_TRANSCRIPT';

export type TranscriptMode = 'off' | 'shadow' | 'primary';

const warnedOnce = new Set<string>();
function warnOnce(message: string): void {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    LOG.warn('Seqscribe', message);
}

/**
 * Resolve the mode. Explicit `off`/`shadow`/`primary` pass through; ABSENT or
 * UNRECOGNIZED both fall back to `shadow` — deliberately NOT the
 * `absent -> primary, garbage -> shadow` asymmetry `resolveMeshDualWriteMode`
 * uses, because that asymmetry exists to preserve an already-flipped
 * production default. Transcript has no such default to preserve yet, so both
 * "operator said nothing" and "operator said something we could not parse"
 * resolve to the same safe, currently-inert value.
 */
export function resolveTranscriptMode(env: NodeJS.ProcessEnv = process.env): TranscriptMode {
    const raw = env[TRANSCRIPT_MODE_ENV]?.trim().toLowerCase();
    if (!raw) return 'shadow';
    if (raw === 'off') return 'off';
    if (raw === 'shadow') return 'shadow';
    if (raw === 'primary') return 'primary';
    warnOnce(
        `unrecognized ${TRANSCRIPT_MODE_ENV}=${raw}; treating as 'shadow'. ` +
            "Valid values are 'shadow' (the default), 'primary' and 'off'.",
    );
    return 'shadow';
}

/** TESTS ONLY — clears the one-time-warning dedup set between cases. */
export function __resetTranscriptModeWarningsForTests(): void {
    warnedOnce.clear();
}
