/**
 * On-disk locations for the Claude Code statusline bridge.
 *
 * Everything the bridge owns lives under one directory so `uninstall` can
 * remove our footprint without guessing, and so a user can inspect or delete it
 * by hand. Nothing here is written outside `<configDir>/claude-statusline/`
 * except the single `statusLine` key in Claude Code's own settings file, which
 * install/uninstall treat as borrowed rather than owned.
 */
'use strict';

import * as os from 'node:os';
import * as path from 'node:path';

import { resolveConfigDir } from '../../config/config-dir.js';

/**
 * Root of ADHDev's own state for this track.
 *
 * Delegates to the single source of truth (`config/config-dir.ts`) so the
 * bridge lands in `~/.adhdev-preview` on a preview build and honours
 * `ADHDEV_CONFIG_DIR` — previously this read a dead `ADHDEV_HOME` override and
 * hardcoded `~/.adhdev`, which made a preview daemon read the STABLE track's
 * statusline snapshot.
 */
export function adhdevHome(env: NodeJS.ProcessEnv = process.env): string {
    return resolveConfigDir(env);
}

/** Directory holding the wrapper, the captured snapshot and the backup. */
export function statuslineDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(adhdevHome(env), 'claude-statusline');
}

/**
 * Claude Code's config directory.
 *
 * `CLAUDE_CONFIG_DIR` is undocumented but honoured by the CLI (verified against
 * 2.1.220: pointing it at a temp dir makes Claude Code read `settings.json`
 * from there and write `.claude.json`, `projects/` and `sessions/` alongside
 * it). We support it so install/uninstall can be exercised against a throwaway
 * config instead of the user's real one.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.CLAUDE_CONFIG_DIR?.trim();
    return override ? override : path.join(os.homedir(), '.claude');
}

/** Claude Code's settings file — the only file outside our dir we ever touch. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(claudeConfigDir(env), 'settings.json');
}

/** The wrapper script the `statusLine.command` points at once installed. */
export function wrapperScriptPath(env: NodeJS.ProcessEnv = process.env): string {
    // `.mjs` so it is loaded as an ES module regardless of any package.json
    // that happens to sit above it.
    return path.join(statuslineDir(env), 'adhdev-statusline.mjs');
}

/** Where the wrapper records the most recent `rate_limits` it saw. */
export function snapshotPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(statuslineDir(env), 'quota.json');
}

/** Where the pre-install `statusLine` value is preserved for uninstall. */
export function backupPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(statuslineDir(env), 'statusline-backup.json');
}
