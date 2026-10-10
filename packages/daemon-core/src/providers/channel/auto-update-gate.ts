/**
 * Activation compatibility gates for verified-channel syncs
 * (docs/design/2026-10-10-provider-auto-update.md §3.3).
 *
 * A gate never fails a sync: a gated entry is reported as a typed `blocked`
 * record, the previous activation stays live, and the sync's status/stamp
 * logic is untouched (blocked ≠ error).
 *
 * Two phases, because they need different inputs:
 *   - before transport (no download): version ordering, the user's rollback
 *     pin, a user/external override shadowing the type, and the
 *     "already blocked with the same inputs" cache;
 *   - after digest verification (the manifest is only trusted once its tree
 *     verified): the bundle's `minDaemonVersion` and whether it still yields a
 *     spec for the CLI version installed on this machine.
 *
 * Pure functions over plain inputs — ProviderChannelSync owns the state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { compareVersions, resolveSpecPathForVersion } from '../provider-loader-support.js';
import type { ActivatableEntry } from './contract.js';
import type { ActivationPointer } from './store.js';

export type ActivationBlockCode =
  /** Channel version ≤ the active pin (downgrade or same-version republish). */
  | 'NOT_AN_UPGRADE'
  /** The channel offers exactly the bundle the user rolled back AWAY from. */
  | 'ROLLBACK_PINNED'
  /** A user dir / sibling checkout / external source outranks the channel store for this type. */
  | 'USER_OVERRIDE'
  /** The bundle's minDaemonVersion is above the running daemon. */
  | 'DAEMON_VERSION_UNSUPPORTED'
  /** The bundle yields no spec for the installed CLI version, while the current one does. */
  | 'CLI_VERSION_UNSUPPORTED';

export interface ActivationBlock {
  providerType: string;
  /** Channel (offered) version. */
  providerVersion: string;
  bundleDigest: string;
  /** Active pin version at decision time (null = no pin). */
  fromVersion: string | null;
  code: ActivationBlockCode;
  reason: string;
  /** Structured requirement for the dashboard (localized there). */
  requires?: { daemon?: string; cliVersion?: string; cliRanges?: string[] };
}

/**
 * Per-entry gate hooks consumed by ProviderChannelRuntime.sync(). Either hook
 * returning a block skips the entry.
 */
export interface ActivationGate {
  beforeTransport?(entry: ActivatableEntry, pointer: ActivationPointer | null): ActivationBlock | null;
  /** `artifactDir` is the VERIFIED staged provider dir; `manifest` its parsed provider manifest. */
  afterVerify?(
    entry: ActivatableEntry,
    artifact: { dir: string; manifest: Record<string, unknown> | null },
    pointer: ActivationPointer | null,
  ): ActivationBlock | null;
}

const SEMVER_CORE_RE = /^\d+\.\d+\.\d+/;

export function makeActivationBlock(
  entry: ActivatableEntry,
  pointer: ActivationPointer | null,
  code: ActivationBlockCode,
  reason: string,
  requires?: ActivationBlock['requires'],
): ActivationBlock {
  return {
    providerType: entry.providerType,
    providerVersion: entry.providerVersion,
    bundleDigest: entry.bundleDigest,
    fromVersion: pointer?.active.providerVersion ?? null,
    code,
    reason,
    ...(requires ? { requires } : {}),
  };
}

/** Auto-only: never move backwards, never undo the user's rollback. */
export function evaluateVersionOrdering(entry: ActivatableEntry, pointer: ActivationPointer | null): ActivationBlock | null {
  if (!pointer) return null;
  if (pointer.previous?.digest === entry.bundleDigest) {
    return makeActivationBlock(entry, pointer, 'ROLLBACK_PINNED',
      `${entry.providerType}@${entry.providerVersion} is the bundle this machine was rolled back from — kept on ${pointer.active.providerVersion} until the channel moves past it`);
  }
  const active = pointer.active.providerVersion;
  if (SEMVER_CORE_RE.test(entry.providerVersion) && SEMVER_CORE_RE.test(active)
    && compareVersions(entry.providerVersion, active) <= 0) {
    return makeActivationBlock(entry, pointer, 'NOT_AN_UPGRADE',
      `channel offers ${entry.providerType}@${entry.providerVersion}, not newer than the active ${active} — auto-update never downgrades`);
  }
  return null;
}

/**
 * Daemon axis: optional `minDaemonVersion: "x.y.z"`. Absent/malformed = no
 * constraint; unknown daemon version (source run) = no constraint. Prerelease
 * tails are ignored on both sides (an rc train carries its version's features).
 */
export function evaluateDaemonCompatibility(
  entry: ActivatableEntry,
  manifest: Record<string, unknown> | null,
  daemonVersion: string,
  pointer: ActivationPointer | null,
): ActivationBlock | null {
  const min = typeof manifest?.minDaemonVersion === 'string' ? manifest.minDaemonVersion.trim() : '';
  if (!min || !SEMVER_CORE_RE.test(min) || !daemonVersion || !SEMVER_CORE_RE.test(daemonVersion)) return null;
  if (compareVersions(daemonVersion, min) >= 0) return null;
  return makeActivationBlock(entry, pointer, 'DAEMON_VERSION_UNSUPPORTED',
    `${entry.providerType}@${entry.providerVersion} requires daemon >= ${min} (running ${daemonVersion})`,
    { daemon: min });
}

/**
 * CLI axis — no dedicated field: `compatibility[].ideVersion` already declares
 * which CLI versions each spec supports and is what the launch path selects
 * by. Block only a REGRESSION: the new bundle yields no spec for the
 * installed CLI while the current bundle does. Unknown CLI version → pass
 * (the runtime itself treats unknown as "any entry"; see the design doc).
 */
export function evaluateCliCompatibility(
  entry: ActivatableEntry,
  artifact: { dir: string; manifest: Record<string, unknown> | null },
  cliVersion: string | null,
  currentArtifactDir: string | null,
  pointer: ActivationPointer | null,
): ActivationBlock | null {
  if (entry.category !== 'cli' || !cliVersion || !artifact.manifest) return null;
  const compatibility = artifact.manifest.compatibility;
  if (resolveSpecPathForVersion(artifact.dir, compatibility, cliVersion)) return null;
  if (currentArtifactDir) {
    const current = readProviderManifest(currentArtifactDir);
    if (!current || !resolveSpecPathForVersion(currentArtifactDir, current.compatibility, cliVersion)) {
      return null; // the active bundle cannot run this CLI either — not a regression
    }
  }
  const ranges = Array.isArray(compatibility)
    ? compatibility
      .map((c: any) => (c && typeof c.ideVersion === 'string' && typeof c.spec === 'string' ? c.ideVersion : ''))
      .filter(Boolean)
    : [];
  return makeActivationBlock(entry, pointer, 'CLI_VERSION_UNSUPPORTED',
    `${entry.providerType}@${entry.providerVersion} has no spec for the installed CLI ${cliVersion}`
      + (ranges.length ? ` (supports ${ranges.join(', ')})` : ''),
    { cliVersion, cliRanges: ranges });
}

/** Parse provider.v1.json (preferred) or provider.json in a provider dir; null when unreadable. */
export function readProviderManifest(dir: string): Record<string, unknown> | null {
  for (const name of ['provider.v1.json', 'provider.json']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return null;
}
