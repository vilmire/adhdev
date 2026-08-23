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

import { existsSync, readFileSync } from 'fs';
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
/**
 * True when this process is a test runner. Covers vitest (`VITEST`), most
 * runners' default `NODE_ENV=test`, and Node's own test runner
 * (`NODE_TEST_CONTEXT`, set by `node --test` — which does NOT set VITEST).
 *
 * The 2026-08 config-dir gate originally keyed only on VITEST/NODE_ENV=test,
 * so mcp-server's `node --test` suite (synthetic mesh_adopt_* / mesh_graph_*
 * rows, sess-coord) could write the live ~/.adhdev-preview/mesh-ledger
 * silently. Exporting this keeps quota-fetcher isolation on the same
 * definition — a third surface of the same class will keep appearing.
 */
export function isTestRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.VITEST) return true;
    if (env.NODE_ENV === 'test') return true;
    if (env.NODE_TEST_CONTEXT) return true;
    return false;
}

export function resolveConfigDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    const override = env.ADHDEV_CONFIG_DIR;
    if (override && override.trim()) {
        const resolved = override.trim();
        assertConfigDirIsolatedInTestRuntime(env, resolved);
        return resolved;
    }
    assertConfigDirIsolatedInTestRuntime(env);
    // Fallback branch only (see above): track-aware default dir name.
    return join(homeDir ?? homedir(), getTrackIdentity(resolveBuildTrack(env)).configDirName);
}

function normalizeConfigPath(p: string, platform: NodeJS.Platform = process.platform): string {
    const unified = p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return platform === 'win32' ? unified.toLowerCase() : unified;
}

/** The two canonical live homes on THIS machine (real homedir, both tracks). */
function liveTrackHomeDirs(homeDir: string = homedir()): string[] {
    return [
        join(homeDir, getTrackIdentity('stable').configDirName),
        join(homeDir, getTrackIdentity('preview').configDirName),
    ];
}

/**
 * The home dir to measure "live" against — captured from the ORIGINAL process
 * environment at module load, before any test can relocate it.
 *
 * The gate must answer one question: "is this path the developer's real
 * ~/.adhdev(-preview)?" Deriving that from a call-time `homedir()` gets it
 * wrong in two ways that were both observed on 2026-08-23:
 *
 *   1. $HOME relocation — the standard way a test stays isolated is to point
 *      $HOME at a tmp dir and stage `<tmpHome>/.adhdev` under it. homedir()
 *      follows $HOME on POSIX, so liveTrackHomeDirs() re-derived itself
 *      against the relocated home and the gate matched the isolated dir as
 *      "live", firing on exactly the tests doing the right thing.
 *   2. mocked os — suites that `vi.mock('os')` with a homedir() stub (e.g. a
 *      fixture dir under the repo) hit the same inversion without $HOME being
 *      touched at all.
 *
 * Together those accounted for 45 failures across 10 files. Anchoring to the
 * process's original HOME fixes both while keeping the gate's real teeth: an
 * inherited ADHDEV_CONFIG_DIR pointing at the true live dir still throws,
 * because that path is unaffected by mocks or later $HOME edits.
 *
 * Note this deliberately reads process.env directly rather than calling
 * homedir(): several suites install PARTIAL `os` mocks, and importing another
 * os export here would throw "No export is defined on the os mock".
 */
const ORIGINAL_HOME_DIR = typeof process.env.HOME === 'string' && process.env.HOME.trim() !== ''
    ? process.env.HOME.trim()
    : (typeof process.env.USERPROFILE === 'string' ? process.env.USERPROFILE.trim() : '');

function isLiveTrackHomeDir(resolved: string, homeDir?: string): boolean {
    const needle = normalizeConfigPath(resolved);
    // An explicitly injected homeDir is a caller assertion; honor it. Otherwise
    // measure against the original process home, never a mocked/relocated one.
    const bases = homeDir !== undefined
        ? [homeDir]
        : [ORIGINAL_HOME_DIR].filter((v) => v !== '');
    return bases.some((base) => liveTrackHomeDirs(base).some((live) => normalizeConfigPath(live) === needle));
}

function processLooksLikeNodeTestRunner(): boolean {
    return process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test='));
}

/**
 * Fail-fast gate against silent live-state pollution from tests.
 *
 * Two holes, both observed:
 *
 *  1. UNSET pin — reaching the real-home fallback on the PROCESS env inside a
 *     test runtime means some test forgot ADHDEV_CONFIG_DIR, and every state
 *     write below this resolution (daemon/mesh-coordinators.json, state.json,
 *     mesh-runtime.db, logs/) lands in the developer's LIVE ~/.adhdev(-preview).
 *     saveRegistry() rewrites the whole coordinator map, so one unisolated case
 *     evicts every real coordinator entry (2026-08-21 incident).
 *
 *  2. PINNED TO THE LIVE DIR — the first gate only fired when the override was
 *     absent. `node --test` (mcp-server) does not set VITEST; a shell that
 *     inherited ADHDEV_CONFIG_DIR=~/.adhdev-preview from the live daemon then
 *     sailed through and wrote synthetic graphs into the live mesh-runtime.db
 *     (mesh_adopt_* / sess-coord, 2026-08-23). An inherited live path is the
 *     same class as an unset pin.
 *
 * Only the default process-env call is gated: unit tests of the fallback rule
 * itself inject an explicit (env, homeDir) pair, which stays pure and
 * gate-free. Fix the TEST when this fires — pin ADHDEV_CONFIG_DIR to a tmp dir
 * in setup (see test/helpers/setup-env.ts / mcp-server test/setup-test-env.ts),
 * or inject an explicit env — never the gate.
 */
function assertConfigDirIsolatedInTestRuntime(env: NodeJS.ProcessEnv, resolvedOverride?: string): void {
    if (env !== process.env) return;
    if (!isTestRuntimeEnv(env) && !processLooksLikeNodeTestRunner()) return;
    if (resolvedOverride) {
        if (isLiveTrackHomeDir(resolvedOverride)) {
            throw new Error(
                'resolveConfigDir() is pinned to the LIVE ~/.adhdev(-preview) dir in a test runtime: '
                + 'a test inherited or re-assigned ADHDEV_CONFIG_DIR to the developer\'s real state dir '
                + `(${resolvedOverride}). Pin ADHDEV_CONFIG_DIR to a tmp dir in test setup, `
                + 'or pass an explicit env/homeDir to resolveConfigDir.',
            );
        }
        return;
    }
    throw new Error(
        'resolveConfigDir() reached the real-home fallback in a test runtime with ADHDEV_CONFIG_DIR unset: '
        + 'a test is about to touch the LIVE ~/.adhdev(-preview) state dir. '
        + 'Pin ADHDEV_CONFIG_DIR to a tmp dir in test setup, or pass an explicit env/homeDir to resolveConfigDir.',
    );
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

/** Env var that silences the inherited-config-dir occupancy warning. Shared
 *  with daemon-cloud's uninstall guard so one opt-in covers both surfaces. */
export const ALLOW_TRACK_MISMATCH_ENV_VAR = 'ADHDEV_ALLOW_TRACK_MISMATCH';

/**
 * The daemon PID file a track's own daemon writes inside its config dir.
 * Mirrors daemon-cloud/src/daemon-pid.ts getDaemonPidFile(): the stable
 * default port keeps the historical bare `daemon.pid` name, every other
 * instance is `daemon-<port>.pid`. Duplicated here rather than imported
 * because daemon-pid.ts lives in the proprietary cloud package and this leaf
 * must stay importable from OSS standalone.
 */
function trackDaemonPidFileName(track: BuildTrack): string {
    const port = getTrackIdentity(track).defaultPort;
    return port === getTrackIdentity('stable').defaultPort ? 'daemon.pid' : `daemon-${port}.pid`;
}

export interface ConfigDirOccupancy {
    /** Absolute path of the config dir a live daemon is using. */
    configDir: string;
    /** PID of the live daemon that owns it. */
    pid: number;
    /** Which track's PID file matched (drives the remediation hint). */
    track: BuildTrack;
}

/**
 * Detects the dangerous half of ADHDEV_CONFIG_DIR inheritance: this process
 * was handed a config dir that a DIFFERENT, CURRENTLY-RUNNING daemon owns.
 *
 * Why liveness and not a track-name match. `isCrossTrackConfigDirOverride`
 * asks "does this path spell the sibling track's name?", which is the right
 * question for an irreversible `uninstall` but the wrong one here: pointing a
 * dev process at the sibling track's dir is explicitly a supported, routine
 * setup (see that function's own doc and scripts/deploy-restart-verify.mjs),
 * while the actual hazard — two processes writing the same state files —
 * happens for ANY occupied dir, including a custom self-host path that spells
 * neither track's name. Asking "is somebody else live in here?" flags exactly
 * the cases that can corrupt state and stays quiet for the sanctioned ones
 * (an unoccupied dir, a /tmp isolation dir, a stopped daemon's leftovers).
 *
 * PURE-ish and fail-open: any unreadable/absent PID file, an unparseable
 * body, or a dead PID yields null. A false negative just restores today's
 * behaviour; a false positive would nag on a legitimate workflow, so every
 * ambiguous case resolves to "not occupied".
 *
 * `selfPid` defaults to process.pid so a daemon that legitimately re-resolves
 * its OWN config dir never warns about itself.
 */
export function detectOccupiedConfigDir(
    configDir: string,
    env: NodeJS.ProcessEnv = process.env,
    selfPid: number = process.pid,
    isAlive: (pid: number) => boolean = defaultIsAlive,
): ConfigDirOccupancy | null {
    if (env[ALLOW_TRACK_MISMATCH_ENV_VAR] === '1') return null;
    if (!configDir || !configDir.trim()) return null;

    // Check both tracks' PID names: the occupant may be either track's daemon
    // (or a custom-path install), and we only know the dir, not who owns it.
    for (const track of ['preview', 'stable'] as const) {
        const pidFile = join(configDir.trim(), trackDaemonPidFileName(track));
        let pid: number;
        try {
            if (!existsSync(pidFile)) continue;
            pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        } catch {
            continue;
        }
        if (!Number.isFinite(pid) || pid <= 0) continue;
        if (pid === selfPid) continue;
        if (!isAlive(pid)) continue;
        return { configDir: configDir.trim(), pid, track };
    }
    return null;
}

/** signal-0 liveness probe. Split out so tests inject determinism. */
function defaultIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Operator-facing message for a detected occupancy. Separate from detection so
 * the wording is pinned by a test and cannot drift into uselessness.
 *
 * Deliberately a WARNING, not a refusal: ADHDEV_CONFIG_DIR is the documented
 * override, and standalone's bootstrap honors an inherited value on purpose
 * (bootstrap-config-dir.ts) so power users can share one dir between the cloud
 * daemon and standalone. Blocking that would break the sanctioned workflow.
 * The 2026-08-21 and 2026-08-22 incidents were both misdiagnosed for hours
 * because the cross-track write was SILENT — naming the occupant, the dir, and
 * the escape hatch is the whole fix.
 */
export function formatOccupiedConfigDirWarning(occupancy: ConfigDirOccupancy): string {
    return `⚠ ADHDEV_CONFIG_DIR was inherited from the environment and points at ${occupancy.configDir}, `
        + `which a LIVE daemon (pid ${occupancy.pid}, ${occupancy.track} track) is currently using. `
        + `This process will read and WRITE that daemon's state files — meshes.json (whole-file rewrite), `
        + `mesh-ledger/ (append + retention deletes), mesh-coordinators.json, state.json — so its mesh registry, `
        + `ledger history and provider activation can be clobbered by this process. `
        + `If this is intentional (a deliberate shared dir), set ${ALLOW_TRACK_MISMATCH_ENV_VAR}=1 to silence this. `
        + `Otherwise run \`env -u ADHDEV_CONFIG_DIR <cmd>\` to use this build's own dir.`;
}
