/**
 * Where the upgrade engine writes: the per-instance base dir and the upgrade log
 * every step of a detached upgrade appends to. A leaf module — the install-surface,
 * process-stop and failure-notice modules all log through it.
 */
import { getConfigDir } from '../config/config.js';
import * as path from 'path';
import * as fs from 'fs';

// Canonical per-instance base dir name (e.g. `.adhdev` for stable,
// `.adhdev-preview` for the coexisting preview install). Derived from the
// running daemon's config dir basename so it stays consistent with Phase 0/1:
// the installer pins ADHDEV_CONFIG_DIR=~/.adhdev-preview for the preview
// instance, getConfigDir() honors it, and its basename is the instance dir. A
// stable / no-override daemon yields `.adhdev`, so every Windows-layout path is
// byte-for-byte identical to before the instance axis existed.
export function resolveInstanceDir(configDir: string = getConfigDir()): string {
  const base = path.basename(configDir).trim();
  return base || '.adhdev';
}

// Upgrade handoff paths live under the instance config dir (default
// `~/.adhdev`, preview `~/.adhdev-preview`, …) so a detached helper never
// writes one instance's upgrade log/notice into another's directory. The
// default parameter is getConfigDir(), which the helper child inherits pinned
// via ADHDEV_CONFIG_DIR (see buildUpgradeHelperChildEnv).
// Exported so the daemon_upgrade / daemon_restart responses can hand the
// caller the exact diagnosis path — the detached helper's outcome (install /
// health-gate / rollback) lands HERE, never in the daemon's own log, so a
// caller that only saw the schedule-time response otherwise has no way to
// learn why the daemon came back on the old version.
export function getUpgradeLogPath(configDir: string = getConfigDir()): string {
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'daemon-upgrade.log');
}

export function appendUpgradeLog(message: string, configDir: string = getConfigDir()): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(getUpgradeLogPath(configDir), line, 'utf8');
  } catch {
    // noop
  }
}
