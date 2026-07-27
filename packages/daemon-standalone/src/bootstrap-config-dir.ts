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
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

pinStandaloneConfigDir();
emitStandaloneMigrationHint();
