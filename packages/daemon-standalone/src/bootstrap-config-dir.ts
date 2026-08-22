/**
 * Standalone config-dir bootstrap.
 *
 * MUST be the first import of the standalone entrypoint (index.ts) so the pin
 * lands before any module that reads the config dir at import time (e.g.
 * daemon-core's logger fixing its log dir at module evaluation).
 *
 * Isolates standalone state from the cloud `adhdev daemon` running on the
 * same machine: without this, both processes share ~/.adhdev/mesh-ledger/
 * (pending events, mesh-runtime-store, etc.) and a worker on the standalone
 * process would queue completion events in a file the cloud coordinator never
 * drains. Honors an explicit ADHDEV_CONFIG_DIR so power users can still point
 * both processes at a shared dir on purpose; defaults to a dedicated
 * `~/.adhdev-standalone` otherwise.
 *
 * That inheritance is DELIBERATE and stays — but it is silent, and silence is
 * what made two incidents expensive. A dev shell exporting
 * ADHDEV_CONFIG_DIR=~/.adhdev-preview (the coordinator setup) hands this
 * process the LIVE preview daemon's state dir, where a whole-file rewrite of
 * meshes.json / mesh-coordinators.json / config.json, or a ledger retention
 * pass, hits state no dev process should own. So we keep honoring the value
 * and instead WARN when the inherited dir is occupied by a live daemon — see
 * warnIfInheritedConfigDirIsOccupied below.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Imported from the config-dir LEAF, never the package barrel: this module
// must run before anything that reads the config dir at import time (the
// barrel pulls in the logger, which fixes its log dir on evaluation), so
// pulling the barrel here would defeat the "FIRST import" contract above.
// config-dir.ts is builtins + track-identity only, so it is safe to evaluate
// this early.
import {
  detectOccupiedConfigDir,
  formatOccupiedConfigDirWarning,
} from '@adhdev/daemon-core/config/config-dir';

export function pinStandaloneConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const existing = typeof env.ADHDEV_CONFIG_DIR === 'string' ? env.ADHDEV_CONFIG_DIR.trim() : '';
  if (existing) return existing;
  const isolated = path.join(homeDir, '.adhdev-standalone');
  env.ADHDEV_CONFIG_DIR = isolated;
  return isolated;
}

/**
 * Warn (never refuse) when the config dir we just honored came from the
 * environment AND a live daemon owns it.
 *
 * Scoped to the INHERITED case on purpose: the self-chosen
 * `~/.adhdev-standalone` default is this process's own dir, and a second
 * standalone in it is an ordinary port conflict that the server surfaces
 * already. `write` is injectable so the test asserts the exact text without
 * capturing global stderr.
 */
export function warnIfInheritedConfigDirIsOccupied(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => { process.stderr.write(line + '\n'); },
): boolean {
  const inherited = typeof env.ADHDEV_CONFIG_DIR === 'string' && env.ADHDEV_CONFIG_DIR.trim() === configDir;
  if (!inherited) return false;
  let occupancy;
  try {
    occupancy = detectOccupiedConfigDir(configDir, env);
  } catch {
    return false; // detection must never block startup
  }
  if (!occupancy) return false;
  write(formatOccupiedConfigDirWarning(occupancy));
  return true;
}

/**
 * One-time non-destructive migration hint: if the new isolated dir is empty
 * but the legacy shared dir holds mesh state, point the user at a manual
 * copy. We don't auto-move because the cloud daemon may still be using it.
 */
export function emitStandaloneMigrationHint(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): void {
  try {
    const isolatedDir = env.ADHDEV_CONFIG_DIR || '';
    if (!isolatedDir) return;
    const legacyLedger = path.join(homeDir, '.adhdev', 'mesh-ledger');
    const isolatedExists = fs.existsSync(isolatedDir);
    const isolatedEmpty = !isolatedExists
      || fs.readdirSync(isolatedDir).filter(name => name !== '.DS_Store').length === 0;
    const legacyHasLedger = fs.existsSync(legacyLedger)
      && fs.readdirSync(legacyLedger).some(name => name.endsWith('.jsonl'));
    if (isolatedEmpty && legacyHasLedger) {
      const line = 'ℹ standalone now stores its state under ' + isolatedDir
        + '. If you want to carry over prior mesh ledger from ~/.adhdev/mesh-ledger,'
        + ' copy ~/.adhdev/mesh-ledger to ' + path.join(isolatedDir, 'mesh-ledger')
        + ' once and restart. (Set ADHDEV_CONFIG_DIR=~/.adhdev to keep the legacy location.)';
      process.stderr.write(line + '\n');
    }
  } catch { /* best-effort hint */ }
}

const pinnedConfigDir = pinStandaloneConfigDir();
warnIfInheritedConfigDirIsOccupied(pinnedConfigDir);
emitStandaloneMigrationHint();
