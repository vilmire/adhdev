/**
 * Regression (D3): hosted-runtime attach must restore the REAL session-host
 * startedAt as the session-registry spawnedAtMs (the native-history floor), never
 * collapse it to 0 for co-located runtimes nor pin it to Date.now().
 *
 * The mesh coordinator + MAGI replicas attach with attachExisting=true. The old
 * `spawnedAtMs: attachExisting ? 0 : Date.now()` disabled every co-located
 * antigravity session's per-session birth-floor, letting a replica claim the
 * coordinator's own conversation (coordinator chat regressed to pty-parser /
 * user-only). The fix threads the record's real (PAST) startedAt into spawnedAtMs.
 */

import { describe, expect, it } from 'vitest';
import { resolveHostedSpawnedAtMs } from '../../src/commands/cli-manager';

describe('resolveHostedSpawnedAtMs (hosted-runtime attach floor)', () => {
  const NOW = 2_000_000_000_000;
  const REAL_STARTED_AT = 1_900_000_000_000; // a PAST timestamp (before NOW)

  it('fresh launch (attachExisting=false) uses now — a live floor for leak protection', () => {
    expect(resolveHostedSpawnedAtMs(false, undefined, NOW)).toBe(NOW);
    // A stray attachStartedAtMs is ignored for a fresh launch.
    expect(resolveHostedSpawnedAtMs(false, REAL_STARTED_AT, NOW)).toBe(NOW);
  });

  it('attach WITH a recoverable record startedAt uses that real PAST timestamp (NOT 0, NOT now)', () => {
    const got = resolveHostedSpawnedAtMs(true, REAL_STARTED_AT, NOW);
    expect(got).toBe(REAL_STARTED_AT);
    expect(got).not.toBe(0);
    expect(got).not.toBe(NOW);
    // The floor is in the PAST relative to now, so it lands before the runtime's
    // own transcript (found) yet still isolates it from a sibling born later.
    expect(got).toBeLessThan(NOW);
  });

  it('attach with NO recoverable startedAt falls back to 0 (preserves tail-gap protection)', () => {
    expect(resolveHostedSpawnedAtMs(true, undefined, NOW)).toBe(0);
    // Non-positive / non-finite startedAt is treated as unrecoverable → 0, never now.
    expect(resolveHostedSpawnedAtMs(true, 0, NOW)).toBe(0);
    expect(resolveHostedSpawnedAtMs(true, -1, NOW)).toBe(0);
    expect(resolveHostedSpawnedAtMs(true, NaN, NOW)).toBe(0);
  });

  it('NEVER returns Date.now() for the attach case (the tail-gap regression guard)', () => {
    // Whatever the inputs, an attach never lands the floor at/after now.
    for (const started of [undefined, 0, -1, NaN, REAL_STARTED_AT]) {
      expect(resolveHostedSpawnedAtMs(true, started as number | undefined, NOW)).not.toBe(NOW);
    }
  });
});
