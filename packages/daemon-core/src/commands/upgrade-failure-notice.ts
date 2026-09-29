/**
 * The durable upgrade-failure notice: written when a detached upgrade fails or rolls
 * back (the only channel back to a caller that saw just "scheduled"), cleared by the
 * next successful upgrade, and read back — with its age and target version — by the
 * status surfaces and the CLI.
 */
import { getConfigDir } from '../config/config.js';
import * as fs from 'fs';
import * as path from 'path';
import type { PinnedGlobalInstallCommand } from './upgrade-install-surface.js';
import { appendUpgradeLog, getUpgradeLogPath } from './upgrade-log.js';

function getUpgradeFailureNoticePath(configDir: string = getConfigDir()): string {
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch {
    // noop — appendUpgradeLog already creates the dir; this is best-effort.
  }
  return path.join(configDir, 'daemon-upgrade-last-error.txt');
}

export function buildManualRecoveryCommand(installCommand: PinnedGlobalInstallCommand): string {
  return [installCommand.command, ...installCommand.args]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(' ');
}

/**
 * Marker line carrying the machine-readable target of the failed attempt.
 *
 * The human body already names the version in prose, but prose is not parseable
 * and the prose wording differs per failure site. Emitting an explicit marker
 * lets a reader decide whether a surviving notice describes an OLDER target than
 * the version now running — i.e. whether it is stale evidence of an attempt that
 * has since been superseded, or a live report about the current one. The marker
 * is appended after the body so an older notice (written before this field
 * existed) simply parses back as `targetVersion: null`.
 */
const UPGRADE_FAILURE_TARGET_MARKER = 'adhdev-upgrade-target:';

/**
 * On final failure, leave the user something actionable instead of only a buried
 * log line: the pids/commandlines still holding the lock and a paste-ready
 * recovery command. Written to a stable path the CLI can surface on next boot.
 */
export function emitUpgradeFailureNotice(
  lines: string[],
  configDir: string = getConfigDir(),
  options: { targetVersion?: string | null } = {},
): void {
  const body = lines.join('\n');
  appendUpgradeLog(`Upgrade blocked — user action required:\n${body}`, configDir);
  const target = typeof options.targetVersion === 'string' ? options.targetVersion.trim() : '';
  const marker = target ? `${UPGRADE_FAILURE_TARGET_MARKER} ${target}\n` : '';
  try {
    fs.writeFileSync(
      getUpgradeFailureNoticePath(configDir),
      `[${new Date().toISOString()}]\n${body}\n${marker}`,
      'utf8',
    );
  } catch {
    // noop
  }
}

/**
 * Delete the durable failure notice after a successful install/re-spawn.
 *
 * A silent failure here is how a solved problem keeps reporting itself: the
 * notice survives, every subsequent boot re-warns about it, and the reader has
 * no way to tell "the upgrade failed again" from "the old notice could not be
 * deleted". ENOENT is the overwhelmingly common case (no previous failure) and
 * stays quiet; anything else — a file lock, a permissions problem — is a real
 * condition that must be named, because it predicts the misleading warnings that
 * follow.
 */
export function clearUpgradeFailureNotice(configDir: string = getConfigDir()): void {
  const noticePath = getUpgradeFailureNoticePath(configDir);
  try {
    fs.unlinkSync(noticePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return; // no previous failure notice — expected
    appendUpgradeLog(
      `Failed to clear stale upgrade-failure notice (${error?.code || 'error'}): ${noticePath} — ${error?.message || String(error)}. `
      + 'Investigate a file lock or permissions: until it is removed, every daemon boot will keep warning about this ALREADY-RESOLVED failure.',
      configDir,
    );
  }
}

export interface UpgradeFailureNotice {
  /** Path of the durable failure-notice file (`daemon-upgrade-last-error.txt`). */
  noticePath: string;
  /** Path of the full install/health trace (`daemon-upgrade.log`). */
  logPath: string;
  /** The actionable notice body the helper left behind. */
  notice: string;
  /** ISO timestamp the notice was written, parsed from its `[...]` header. Null when unparseable. */
  recordedAt: string | null;
  /** Age of the notice in milliseconds at read time. Null when `recordedAt` is unavailable. */
  ageMs: number | null;
  /** Human-readable age (`3h ago`), for log/status prose. Null when `recordedAt` is unavailable. */
  ageLabel: string | null;
  /** Version the failed attempt targeted, from the structured marker. Null on pre-marker notices. */
  targetVersion: string | null;
}

/** `2h ago` / `3d ago` — coarse on purpose; the exact ISO stamp is right next to it. */
function formatUpgradeNoticeAge(ageMs: number): string {
  if (ageMs < 0) return 'in the future (clock skew?)';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Parse the `[ISO]` header emitted by emitUpgradeFailureNotice. */
function parseUpgradeNoticeTimestamp(notice: string): string | null {
  const match = /^\[([^\]\n]+)\]/.exec(notice);
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Parse the structured target-version marker; null on notices written before it existed. */
function parseUpgradeNoticeTargetVersion(notice: string): string | null {
  const pattern = new RegExp(`^${UPGRADE_FAILURE_TARGET_MARKER}\\s*(.+)$`, 'm');
  const match = pattern.exec(notice);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * Read the durable upgrade-failure notice, if one is present. The helper
 * deletes this file only after a successful install/re-spawn, so a surviving
 * notice means the LAST upgrade attempt failed and the daemon was rolled back
 * to (or left on) the previous version — the signal that lets a re-spawned
 * daemon and status callers observe a failure the schedule-time response
 * could not have known about. Returns null when there is nothing to report.
 *
 * The notice is durable but NOT self-expiring: a failure from days ago reads
 * exactly like one from a minute ago, which is how a resolved incident gets
 * re-diagnosed as a fresh one. So the parsed `[ISO]` header is returned
 * alongside the body as `recordedAt`/`ageMs`/`ageLabel`, and the attempted
 * `targetVersion` as a structured field — together they let a reader ask "is
 * this about the upgrade I just ran, or an older one?" without parsing prose.
 */
export function readUpgradeFailureNotice(configDir: string = getConfigDir()): UpgradeFailureNotice | null {
  try {
    const noticePath = getUpgradeFailureNoticePath(configDir);
    if (!fs.existsSync(noticePath)) return null;
    const notice = fs.readFileSync(noticePath, 'utf8').trim();
    if (!notice) return null;
    const recordedAt = parseUpgradeNoticeTimestamp(notice);
    const ageMs = recordedAt ? Date.now() - Date.parse(recordedAt) : null;
    return {
      noticePath,
      logPath: getUpgradeLogPath(configDir),
      notice,
      recordedAt,
      ageMs,
      ageLabel: ageMs === null ? null : formatUpgradeNoticeAge(ageMs),
      targetVersion: parseUpgradeNoticeTargetVersion(notice),
    };
  } catch {
    return null;
  }
}
