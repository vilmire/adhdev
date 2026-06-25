/**
 * Shared constants for the native-history subtree.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

/**
 * Spawn-bind grace window: an on-disk rollout whose session_meta.timestamp
 * lands within ±SPAWN_BIND_GRACE_MS of the daemon's spawnedAtMs is treated
 * as belonging to that daemon session. 10s is long enough to absorb codex
 * binary startup latency on cold caches and short enough that two
 * back-to-back launches don't both fall inside the same window.
 *
 * Shared by the declarative executor (providers/spec/native-history-executor.ts)
 * and the codex runtime disambiguator (providers/native-history/dispatcher.ts) —
 * both apply the identical ±10s session-binding window.
 */
export const SPAWN_BIND_GRACE_MS = 10_000;
