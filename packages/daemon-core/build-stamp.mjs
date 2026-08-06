// Shared build-time git stamp resolver for tsup `define`.
//
// Returns the `define` map that injects the daemon build commit/version into
// the `__DAEMON_BUILD_*` identifiers read by src/build-info.ts. Used by every
// build config that bundles daemon-core into a shippable daemon (daemon-core
// itself, daemon-cloud, daemon-standalone). If git info is unavailable the
// values are injected as 'unknown' — the build MUST NOT fail over a missing
// commit.
import { execFileSync } from 'node:child_process';

function gitOut(args, cwd) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd] - dir to run git in (defaults to process.cwd())
 * @param {string} [opts.version] - package version to bake in (defaults to 'unknown')
 * @returns {Record<string, string>} tsup `define` map (values are JSON.stringify'd literals)
 */
export function daemonBuildDefine(opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const commit = gitOut(['rev-parse', 'HEAD'], cwd) || 'unknown';
    const commitShort = commit !== 'unknown'
        ? (gitOut(['rev-parse', '--short', 'HEAD'], cwd) || commit.slice(0, 7))
        : 'unknown';
    const version = opts.version || 'unknown';
    // No Date.now() determinism worries here — build time is genuinely "now".
    const builtAt = new Date().toISOString();

    return {
        __DAEMON_BUILD_COMMIT__: JSON.stringify(commit),
        __DAEMON_BUILD_COMMIT_SHORT__: JSON.stringify(commitShort),
        __DAEMON_BUILD_VERSION__: JSON.stringify(version),
        __DAEMON_BUILD_AT__: JSON.stringify(builtAt),
        // Build track stamp (stable|preview) read by src/track-identity.ts.
        // Same ADHDEV_BUILD_CHANNEL axis the web build already uses; an unset
        // env stamps '' which track-identity treats as "no stamp" (env
        // fallback, then stable) — never a build failure.
        __ADHDEV_BUILD_CHANNEL__: JSON.stringify(process.env.ADHDEV_BUILD_CHANNEL || ''),
    };
}
