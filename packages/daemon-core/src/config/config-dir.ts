/**
 * Config-dir resolution — the single source of truth for WHERE the ADHDev home
 * directory (~/.adhdev, ~/.adhdev-preview on a preview build track, or
 * ADHDEV_CONFIG_DIR when pinned) and its logs/ subdirectory live.
 *
 * Every consumer that needs the config dir or the logs dir must derive it from
 * here instead of re-implementing the `ADHDEV_CONFIG_DIR || ~/.adhdev` rule:
 * past copies drifted (missing mkdir, import-time snapshots freezing the env).
 *
 * The no-override default dir NAME comes from the build track (see
 * track-identity.ts): a preview build is self-identifying and lands in
 * `~/.adhdev-preview` even with a clean environment; a stable build keeps the
 * historical `~/.adhdev` byte-for-byte.
 *
 * Deliberately a LEAF module: node builtins + the equally-pure track-identity
 * leaf only, so cheap consumers (logger, command-log) can use it without
 * pulling config loading. Resolution is PURE (no mkdir side effect) and
 * evaluates `env` / `homedir()` at CALL time, so an ADHDEV_CONFIG_DIR assigned
 * after module load (tests, daemon boot ordering) is honored on the next call.
 *
 * Mirrors that CANNOT import this module and must stay manually in sync:
 *  - daemon-cloud/src/daemon-early-crash-guard.ts (builtin-only crash guard —
 *    importing daemon-core would load the native addon it guards against;
 *    it reads the same __ADHDEV_BUILD_CHANNEL__ stamp itself)
 *  - session-host-core/src/instance-key.ts (daemon-core depends on
 *    session-host-core, so the reverse import would be a cycle)
 */

import { homedir } from 'os';
import { basename, join } from 'path';
import { getTrackIdentity, resolveBuildTrack, type BuildTrack } from '../track-identity.js';

/** Legacy stable home dir name — also the empty-ipc-key compat instance. */
export const DEFAULT_CONFIG_DIR_NAME = '.adhdev';

/**
 * Resolve the config dir WITHOUT creating it: ADHDEV_CONFIG_DIR (trimmed) when
 * set, else `<homeDir>/<track dir name>` (`.adhdev` stable, `.adhdev-preview`
 * preview build). Callers that need the dir to exist use getConfigDir()
 * (config.ts), which adds the mkdir.
 *
 * homedir() is called ONLY in the fallback branch, never as a default
 * parameter value: a default arg evaluates even when the env override wins,
 * which both wastes a syscall on every call and trips test mocks whose
 * homedir stub closes over a not-yet-initialized binding at module load.
 */
export function resolveConfigDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    const override = env.ADHDEV_CONFIG_DIR;
    if (override && override.trim()) return override.trim();
    // Fallback branch only (see above): track-aware default dir name.
    return join(homeDir ?? homedir(), getTrackIdentity(resolveBuildTrack(env)).configDirName);
}

/** `<configDir>/logs` — daemon log, command history, service stdio capture. */
export function resolveConfigLogsDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    return join(resolveConfigDir(env, homeDir), 'logs');
}

/**
 * The SIBLING track's own canonical (un-overridden) config dir — i.e. what
 * `resolveConfigDir()` would return for the OTHER track with no
 * ADHDEV_CONFIG_DIR set. Used only to detect the narrow cross-track pollution
 * signature below; never a general "expected config dir" helper.
 */
export function otherTrackConfigDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    const ownTrack = resolveBuildTrack(env);
    const otherTrack: BuildTrack = ownTrack === 'preview' ? 'stable' : 'preview';
    return join(homeDir ?? homedir(), getTrackIdentity(otherTrack).configDirName);
}

/**
 * True only when ADHDEV_CONFIG_DIR is explicitly set AND resolves to EXACTLY
 * the sibling track's own canonical home directory (e.g. a `stable` binary
 * whose ADHDEV_CONFIG_DIR points at `~/.adhdev-preview`) — the cross-track
 * pollution signature behind the 2026-08 incident where a stable
 * `uninstall --force` deleted a live preview install because that env var had
 * been left set in the shell from an earlier session.
 *
 * IMPORTANT — this is NOT a general "is my env unusual" check, and callers
 * must not use it to warn on ordinary commands. Pinning ADHDEV_CONFIG_DIR to
 * the sibling track's dir is a DELIBERATE, DOCUMENTED, routine setup on some
 * machines (see scripts/deploy-restart-verify.mjs's coordinator note: it
 * talks to whichever daemon is actually installed, which on a coordinator is
 * routinely the preview instance). That is normal and this function still
 * returns true for it — the mismatch is not the problem; running an
 * IRREVERSIBLE command (uninstall) against it without the operator noticing
 * is. Gate destructive actions only, never informational ones.
 *
 * Any other override value (a /tmp test-isolation dir, daemon-standalone's
 * own `.adhdev-standalone`, a self-host custom path, or a directory that
 * merely happens to share the sibling's basename somewhere else on disk)
 * never matches the sibling's full canonical path and returns false — full
 * absolute-path comparison (not a basename-only check) is what keeps an
 * unrelated same-named directory from being misjudged as the sibling track.
 *
 * `platform` defaults to `process.platform` and exists only so tests can pin
 * win32 case-insensitive comparison deterministically without depending on
 * the host OS running the test.
 */
export function isCrossTrackConfigDirOverride(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const override = env.ADHDEV_CONFIG_DIR;
    if (!override || !override.trim()) return false;

    const sibling = otherTrackConfigDir(env, homeDir);
    const normalize = (p: string): string => {
        // Unify separators before comparing so a mixed forward/back-slash
        // override still lines up with a native join() result regardless of
        // which OS actually produced either string.
        const unified = p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
        return platform === 'win32' ? unified.toLowerCase() : unified;
    };
    return normalize(override) === normalize(sibling);
}

/**
 * Detects the config-dir/provider-channel axis decoupling: the config dir's
 * NAME implies one track (stable `.adhdev` vs preview `.adhdev-preview`,
 * whether that name came from ADHDEV_CONFIG_DIR or the track default) while
 * the resolved provider channel (providers/channel/contract.ts
 * `resolveProviderChannel`) landed on the other. This is possible because
 * ADHDEV_CONFIG_DIR only overrides the config-dir PATH — it never feeds the
 * provider-channel resolution — so the two axes normally move together (both
 * derive from the same build-track stamp) but can drift apart, e.g. a
 * preview session-host passes ADHDEV_CONFIG_DIR=~/.adhdev-preview to a child
 * that then runs `tsx` (no `__ADHDEV_BUILD_CHANNEL__` bundler define), so
 * resolveProviderChannel falls through its precedence chain to 'stable'.
 *
 * Only informational — this NEVER fires when the divergence is explained by
 * an explicit signal (config.providerChannel, ADHDEV_PROVIDER_CHANNEL env,
 * or a preview config.updateChannel): those are deliberate overrides, not
 * axis decoupling, and `hasExplicitChannelSignal` lets the caller say so.
 * Callers must pass the SAME explicit-signal inputs they gave
 * `resolveProviderChannel` for this exemption to line up correctly.
 *
 * A config dir whose basename is neither track's canonical name (a custom
 * self-host path, a /tmp test-isolation dir, `.adhdev-standalone`) never
 * implies either track and always returns false — there is nothing to
 * compare the channel against.
 */
export function configDirChannelMismatch(
    resolvedConfigDir: string,
    resolvedChannel: 'stable' | 'preview',
    hasExplicitChannelSignal: boolean,
): { impliedTrack: BuildTrack; channel: 'stable' | 'preview' } | null {
    if (hasExplicitChannelSignal) return null;

    const name = basename(resolvedConfigDir);
    const impliedTrack: BuildTrack | null =
        name === getTrackIdentity('stable').configDirName ? 'stable'
            : name === getTrackIdentity('preview').configDirName ? 'preview'
                : null;
    if (!impliedTrack) return null;

    return impliedTrack === resolvedChannel ? null : { impliedTrack, channel: resolvedChannel };
}
