/**
 * Daemon build stamp — single runtime source for "which commit is this running
 * daemon built from?".
 *
 * The values are injected at BUILD time via tsup `define` (esbuild global
 * replacement). Every build config that bundles daemon-core into a shippable
 * daemon (daemon-core's own dist, daemon-standalone, daemon-cloud) replaces
 * these `__DAEMON_BUILD_*` identifiers with the literal git commit/version that
 * was current when the bundle was produced. See:
 *   - oss/packages/daemon-core/tsup.config.ts      (standalone consumes this dist)
 *   - packages/daemon-cloud/tsup.config.ts         (re-bundles daemon-core from source)
 *
 * If a bundle is produced WITHOUT the define (e.g. running src directly through
 * tsx in dev, or a build env without git), the identifiers stay undefined and
 * we fall back to `"unknown"` — never a ReferenceError, never a build failure.
 *
 * IMPORTANT (live-reflection caveat): a fresh local `daemon-core dist` rebuild +
 * daemon restart is NOT enough to make a *cloud* daemon report a new commit —
 * daemon-cloud ships its own re-bundle of daemon-core, so the build stamp only
 * advances after the cloud daemon is rebuilt/redeployed and restarted. This is
 * precisely the gap `mesh_status`'s `staleDaemonBuild` warning exists to surface.
 */

// These are replaced at build time by tsup `define`. `typeof` guards keep this
// safe when the define is absent (the identifiers are simply not declared).
declare const __DAEMON_BUILD_COMMIT__: string | undefined;
declare const __DAEMON_BUILD_COMMIT_SHORT__: string | undefined;
declare const __DAEMON_BUILD_VERSION__: string | undefined;
declare const __DAEMON_BUILD_AT__: string | undefined;

export interface DaemonBuildInfo {
    /** Full 40-char git commit the daemon bundle was built from, or 'unknown'. */
    commit: string;
    /** Short (7-char) form of the same commit, or 'unknown'. */
    commitShort: string;
    /** package.json version baked in at build time, or 'unknown'. */
    version: string;
    /** ISO build timestamp if the build config injected one. */
    builtAt?: string;
}

function readInjected(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'unknown') return undefined;
    return trimmed;
}

let cached: DaemonBuildInfo | undefined;

/**
 * Resolve the build stamp baked into the running daemon bundle. Pure read of
 * build-time constants — no I/O, safe to call from any runtime path. Cached.
 */
export function getDaemonBuildInfo(): DaemonBuildInfo {
    if (cached) return cached;

    const commit =
        readInjected(typeof __DAEMON_BUILD_COMMIT__ !== 'undefined' ? __DAEMON_BUILD_COMMIT__ : undefined)
        ?? 'unknown';
    const commitShort =
        readInjected(typeof __DAEMON_BUILD_COMMIT_SHORT__ !== 'undefined' ? __DAEMON_BUILD_COMMIT_SHORT__ : undefined)
        ?? (commit !== 'unknown' ? commit.slice(0, 7) : 'unknown');
    const version =
        readInjected(typeof __DAEMON_BUILD_VERSION__ !== 'undefined' ? __DAEMON_BUILD_VERSION__ : undefined)
        // Fall back to the runtime-injected package version env used elsewhere.
        ?? readInjected(typeof process !== 'undefined' ? process.env?.ADHDEV_PKG_VERSION : undefined)
        ?? 'unknown';
    const builtAt = readInjected(typeof __DAEMON_BUILD_AT__ !== 'undefined' ? __DAEMON_BUILD_AT__ : undefined);

    cached = builtAt ? { commit, commitShort, version, builtAt } : { commit, commitShort, version };
    return cached;
}
