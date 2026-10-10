/**
 * The one sentence every "the reading is old" message appends so the user learns
 * (a) the daemon does re-read on its own, but not instantly, and (b) the manual
 * lever that exists: `adhdev quota --refresh` (refresh_provider_quota).
 *
 * Binary name comes from IDENTITY so a preview install says `adhdev-preview`.
 * Kept out of the fetchers so the three call sites cannot drift apart.
 */
import { IDENTITY } from '../track-identity.js';

/** "re-read now" clause: `or run \`adhdev quota --refresh\` to re-read now`. */
export function quotaReadNowClause(): string {
    return `or run \`${IDENTITY.binaryName} quota --refresh\` to re-read now`;
}

/**
 * How soon the daemon looks again by itself, per quota axis (QUOTA_AXIS_TTL_MS
 * in ./refresh.ts): file-source providers (Claude statusline, Codex rollout)
 * ≈1 min while a CLI is active; otherwise only the hourly staleness backfill.
 */
export const FILE_AXIS_REREAD_NOTE = 'the daemon re-reads within ~1 min while a CLI is active, up to ~60 min when idle';
