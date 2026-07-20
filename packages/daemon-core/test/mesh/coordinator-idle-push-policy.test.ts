import { describe, it, expect } from 'vitest';

import {
  DEFAULT_MESH_POLICY,
  SILENT_IDLE_PUSH_TTL_MS,
  mergeAndNormalizePolicy,
  resolveCoordinatorIdlePushPolicy,
} from '../../src/repo-mesh-types.js';
import { resolveMuted } from '../../src/status/builders.js';

// COORDINATOR-SILENT-IDLE: an opt-in mesh policy lets a coordinator one-shot-silence
// the routine idle/completion push for a task it dispatches, reusing the existing
// session.muted channel (server push gate untouched). Conservative default: 'always'.
describe('resolveCoordinatorIdlePushPolicy', () => {
  it("defaults to 'always' (notify) when unset / invalid", () => {
    expect(resolveCoordinatorIdlePushPolicy(undefined)).toBe('always');
    expect(resolveCoordinatorIdlePushPolicy(null)).toBe('always');
    expect(resolveCoordinatorIdlePushPolicy({})).toBe('always');
    // A typo must never silently disable notifications — fall back to 'always'.
    expect(resolveCoordinatorIdlePushPolicy({ coordinatorIdlePushPolicy: 'silent' as any })).toBe('always');
  });

  it("honors the explicit opt-in", () => {
    expect(
      resolveCoordinatorIdlePushPolicy({ coordinatorIdlePushPolicy: 'auto_silent_on_dispatch' }),
    ).toBe('auto_silent_on_dispatch');
  });

  it("DEFAULT_MESH_POLICY is conservative ('always')", () => {
    expect(DEFAULT_MESH_POLICY.coordinatorIdlePushPolicy).toBe('always');
  });
});

describe('mergeAndNormalizePolicy — coordinatorIdlePushPolicy persistence economy', () => {
  it('drops the field when it normalizes to the default so meshes.json stays untouched', () => {
    const p = mergeAndNormalizePolicy(undefined, {});
    expect('coordinatorIdlePushPolicy' in p).toBe(false);
  });

  it('drops an invalid value (never persists a typo)', () => {
    const p = mergeAndNormalizePolicy(undefined, { coordinatorIdlePushPolicy: 'bogus' as any });
    expect('coordinatorIdlePushPolicy' in p).toBe(false);
  });

  it('persists the explicit opt-in', () => {
    const p = mergeAndNormalizePolicy(undefined, { coordinatorIdlePushPolicy: 'auto_silent_on_dispatch' });
    expect(p.coordinatorIdlePushPolicy).toBe('auto_silent_on_dispatch');
  });

  it("an explicit 'always' patch clears a previously-persisted opt-in", () => {
    const base = mergeAndNormalizePolicy(undefined, { coordinatorIdlePushPolicy: 'auto_silent_on_dispatch' });
    const p = mergeAndNormalizePolicy(base, { coordinatorIdlePushPolicy: 'always' });
    expect('coordinatorIdlePushPolicy' in p).toBe(false);
  });
});

// resolveMuted honors a one-shot arm (settings.silentNextIdlePush) ONLY for an idle
// snapshot within the TTL — the guardrails that keep approval/failure/long-running
// pushes and never-completing workers unaffected.
describe('resolveMuted — one-shot silent-idle arm', () => {
  const armed = () => ({ silentNextIdlePush: true, silentNextIdlePushArmedAt: Date.now() });

  it('mutes an idle completion snapshot when armed', () => {
    expect(resolveMuted(armed(), 'idle')).toBe(true);
  });

  it('does NOT mute an approval-needed snapshot in the same turn (guardrail)', () => {
    expect(resolveMuted(armed(), 'waiting_approval')).toBe(false);
  });

  it('does NOT mute a generating snapshot (guardrail)', () => {
    expect(resolveMuted(armed(), 'generating')).toBe(false);
  });

  it('does NOT mute when the status is omitted (cloud mirror has no live status)', () => {
    expect(resolveMuted(armed(), undefined)).toBe(false);
  });

  it('self-expires an idle arm older than the TTL (never-completing worker leak-guard)', () => {
    const stale = {
      silentNextIdlePush: true,
      silentNextIdlePushArmedAt: Date.now() - SILENT_IDLE_PUSH_TTL_MS - 1_000,
    };
    expect(resolveMuted(stale, 'idle')).toBe(false);
  });

  it('an arm with no/invalid timestamp still mutes an idle snapshot (fail-safe toward the explicit arm)', () => {
    expect(resolveMuted({ silentNextIdlePush: true }, 'idle')).toBe(true);
    expect(resolveMuted({ silentNextIdlePush: true, silentNextIdlePushArmedAt: NaN }, 'idle')).toBe(true);
  });

  it('an unset / cleared arm leaves an idle session unmuted (post one-shot consume)', () => {
    expect(resolveMuted({}, 'idle')).toBe(false);
    expect(resolveMuted({ silentNextIdlePush: undefined }, 'idle')).toBe(false);
  });

  it('an explicit userMuted still mutes regardless of status (existing behavior preserved)', () => {
    expect(resolveMuted({ userMuted: true }, 'generating')).toBe(true);
  });
});
