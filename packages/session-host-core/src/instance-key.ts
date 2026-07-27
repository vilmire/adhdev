import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Instance identity derivation for the session-host IPC namespace.
 *
 * One machine can host several ADHDev installs (stable `~/.adhdev`, preview
 * `~/.adhdev-preview`, standalone `~/.adhdev-standalone`, or any explicit
 * ADHDEV_CONFIG_DIR). Each install is an *instance*: it owns its config dir
 * and everything mutable under it. The session-host socket/pipe must be
 * namespaced by that identity so two simultaneous instances can never attach
 * to, kill, or rebind each other's session host.
 *
 * This module is the single derivation rule, shared by:
 * - the parent daemons (via @adhdev/daemon-core's InstanceContext),
 * - the session-host-daemon child process (which only sees env vars),
 * - CLI attach/list clients.
 *
 * All three compute the endpoint from the same inputs (appName +
 * ADHDEV_CONFIG_DIR), so they always agree without extra plumbing.
 *
 * Compatibility contract: the DEFAULT instance (config dir canonicalizes to
 * `<home>/.adhdev`) yields an EMPTY ipc key, so its socket/pipe path stays
 * byte-for-byte identical to the pre-instance layout.
 */

export const DEFAULT_CONFIG_DIR_NAME = '.adhdev';

/**
 * Resolve the instance config dir from the environment: ADHDEV_CONFIG_DIR
 * when set (trimmed), else `<homeDir>/.adhdev`. Mirrors daemon-core's
 * getConfigDir() source rule without the mkdir side effect.
 */
export function resolveInstanceConfigDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = os.homedir(),
): string {
    const override = typeof env.ADHDEV_CONFIG_DIR === 'string' ? env.ADHDEV_CONFIG_DIR.trim() : '';
    return override || path.join(homeDir, DEFAULT_CONFIG_DIR_NAME);
}

/**
 * Realpath the longest existing prefix of `resolved` and re-append the
 * non-existing remainder. Unlike a plain realpathSync, this is deterministic
 * whether or not the leaf exists yet (a config dir realpath'd only after its
 * first mkdir must not change the derived ipc key between processes).
 */
function realpathLongestExistingPrefix(resolved: string): string {
    let current = resolved;
    const remainder: string[] = [];
    // Bounded walk: a path can have at most its own segment count of parents.
    for (let depth = 0; depth < 256; depth++) {
        try {
            const real = fs.realpathSync.native(current);
            return remainder.length === 0 ? real : path.join(real, ...remainder);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return resolved;
            remainder.unshift(path.basename(current));
            current = parent;
        }
    }
    return resolved;
}

/**
 * Canonical form of an instance path for identity comparison/hashing:
 * absolute, symlink-resolved (longest existing prefix), no trailing
 * separator, case-folded on win32.
 */
export function canonicalizeInstancePath(
    dir: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const resolved = path.resolve(dir);
    const real = realpathLongestExistingPrefix(resolved).replace(/[\\/]+$/, '');
    return platform === 'win32' ? real.toLowerCase() : real;
}

/** True when `configDir` is canonically the default `<homeDir>/.adhdev`. */
export function isDefaultInstanceConfigDir(
    configDir: string,
    homeDir: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
): boolean {
    return canonicalizeInstancePath(configDir, platform)
        === canonicalizeInstancePath(path.join(homeDir, DEFAULT_CONFIG_DIR_NAME), platform);
}

/**
 * Derive the session-host IPC namespace key for an instance config dir.
 *
 * '' for the default instance (legacy-compatible endpoint), otherwise a
 * 12-hex-char sha256 prefix of the canonical config dir — stable across
 * processes/machines for the same dir, collision-resistant between dirs,
 * and insensitive to symlink/spelling differences of the same dir.
 */
export function resolveSessionHostIpcKey(
    configDir: string,
    homeDir: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    if (isDefaultInstanceConfigDir(configDir, homeDir, platform)) return '';
    const canonical = canonicalizeInstancePath(configDir, platform);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}
