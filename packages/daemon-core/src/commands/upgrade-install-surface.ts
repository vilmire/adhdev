/**
 * The global npm install surface the daemon upgrade engine acts on: discovering the
 * running install's package root and prefix, the npm/node invocation next to it, the
 * pinned `npm install -g` command for a target version, and the registry lookup that
 * answers "which version would we install?". Update DISCOVERS and preserves the
 * existing prefix; it never re-decides it (that is install.sh's job).
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveInstanceDir, appendUpgradeLog } from './upgrade-log.js';
import { isSpawnTimeoutError } from './upgrade-process-stop.js';
import { execFileSync, type ExecFileSyncOptions } from 'child_process';

export interface CurrentGlobalInstallSurface {
  npmExecutable: string;
  npmArgsPrefix?: string[];
  packageRoot: string | null;
  installPrefix: string | null;
  execOptions?: NpmExecOptions;
}

export interface PinnedGlobalInstallCommand {
  command: string;
  args: string[];
  surface: CurrentGlobalInstallSurface;
  execOptions: NpmExecOptions;
}

export type NpmExecOptions = { shell: boolean; windowsHide?: boolean };

function resolveSiblingNpmInvocation(nodeExecutable: string, platform: NodeJS.Platform = process.platform): {
  executable: string;
  argsPrefix: string[];
  execOptions: NpmExecOptions;
} {
  const binDir = path.dirname(nodeExecutable);
  if (platform === 'win32') {
    const npmCliPath = path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCliPath)) {
      return { executable: nodeExecutable, argsPrefix: [npmCliPath], execOptions: getNpmExecOptions(platform) };
    }
    for (const candidate of ['npm.exe', 'npm']) {
      const candidatePath = path.join(binDir, candidate);
      if (fs.existsSync(candidatePath)) {
        return { executable: candidatePath, argsPrefix: [], execOptions: getNpmExecOptions(platform) };
      }
    }
    return { executable: nodeExecutable, argsPrefix: [npmCliPath], execOptions: getNpmExecOptions(platform) };
  }
  for (const candidate of ['npm']) {
    const candidatePath = path.join(binDir, candidate);
    if (fs.existsSync(candidatePath)) {
      return { executable: candidatePath, argsPrefix: [], execOptions: getNpmExecOptions(platform) };
    }
  }
  return { executable: 'npm', argsPrefix: [], execOptions: getNpmExecOptions(platform) };
}

function findCurrentPackageRoot(currentCliPath: string | undefined, packageName: string): string | null {
  if (!currentCliPath) return null;

  let resolvedPath = currentCliPath;
  try {
    resolvedPath = fs.realpathSync.native(currentCliPath);
  } catch {
    // keep the original path when realpath is unavailable
  }

  let currentDir = resolvedPath;
  try {
    if (fs.statSync(resolvedPath).isFile()) {
      currentDir = path.dirname(resolvedPath);
    }
  } catch {
    currentDir = path.dirname(resolvedPath);
  }

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (parsed?.name === packageName) {
          const normalized = currentDir.replace(/\\/g, '/');
          return normalized.includes('/node_modules/') ? currentDir : null;
        }
      }
    } catch {
      // ignore malformed package metadata while scanning upward
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolveInstallPrefixFromPackageRoot(packageRoot: string, packageName: string): string | null {
  const nodeModulesDir = packageName.startsWith('@')
    ? path.dirname(path.dirname(packageRoot))
    : path.dirname(packageRoot);
  if (path.basename(nodeModulesDir) !== 'node_modules') {
    return null;
  }

  const maybeLibDir = path.dirname(nodeModulesDir);
  if (path.basename(maybeLibDir) === 'lib') {
    return path.dirname(maybeLibDir);
  }
  return maybeLibDir;
}

// True when `prefix` is the bin dir of a portable Node 22 the installer manages
// under ~/.adhdev/tools/node22/<node-vX>/. A `npm i -g adhdev` run while that
// portable node is the active `node` installs adhdev into node's own default
// global prefix (= that dir) — a "legacy node22-prefix" install that lives at
// the FRONT of PATH (Enable-NodePath prepends node22) and shadows the canonical
// dispatcher shims in ~/.adhdev/npm-global. Because self-upgrade reuses the
// running prefix, that install then re-installs into the same node22 dir forever
// and never converts to the dispatcher. Detecting it lets us force convergence.
function isPortableNode22Prefix(prefix: string | null, homeDir: string, instanceDir: string = '.adhdev'): boolean {
  if (!prefix) return false;
  const portableRoot = path.join(homeDir, instanceDir, 'tools', 'node22');
  const normalizedPrefix = path.resolve(prefix).replace(/[\\/]+$/, '').toLowerCase();
  const normalizedRoot = path.resolve(portableRoot).replace(/[\\/]+$/, '').toLowerCase();
  return normalizedPrefix === normalizedRoot || normalizedPrefix.startsWith(`${normalizedRoot}${path.sep.toLowerCase()}`);
}

// Redirect a legacy node22-prefix install to the canonical dispatcher install
// root so resolveWindowsInstallerLayout accepts it and the atomic-upgrade
// publishes the ~/.adhdev/npm-global pointer + shims. Prefer the version the
// dispatcher pointer already names (so we sit on the real active dispatcher
// prefix); otherwise synthesize a stable migration sentinel under npm-installs.
// resolveWindowsInstallerLayout only requires a `npm-installs/version-*` path —
// performWindowsAtomicUpgrade stages a fresh version- prefix of its own and uses
// this only as the "old prefix" to stop/clean, so a non-existent path is a no-op.
function canonicalDispatcherInstallPrefix(homeDir: string, instanceDir: string = '.adhdev'): string {
  const installRoot = path.join(homeDir, instanceDir, 'npm-installs');
  const pointerPath = path.join(homeDir, instanceDir, 'npm-global', '.adhdev-current');
  try {
    const activeVersion = fs.readFileSync(pointerPath, 'utf8').trim();
    if (activeVersion.startsWith('version-')) return path.join(installRoot, activeVersion);
  } catch {
    // No dispatcher pointer yet (first migration off the legacy layout).
  }
  return path.join(installRoot, 'version-legacy-migrate');
}

export function resolveCurrentGlobalInstallSurface(options: {
  packageName: string;
  currentCliPath?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /**
   * Per-instance base dir name under homeDir (`.adhdev` stable /
   * `.adhdev-preview` preview). Defaults to the running daemon's config-dir
   * basename via resolveInstanceDir(), so the legacy-prefix convergence checks
   * scope to the correct instance's tools/node22 + npm-installs tree.
   */
  instanceDir?: string;
}): CurrentGlobalInstallSurface {
  const packageRoot = findCurrentPackageRoot(options.currentCliPath || process.argv[1], options.packageName);
  const npmInvocation = resolveSiblingNpmInvocation(options.nodeExecutable || process.execPath, options.platform);
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const instanceDir = options.instanceDir || resolveInstanceDir();
  let installPrefix = packageRoot ? resolveInstallPrefixFromPackageRoot(packageRoot, options.packageName) : null;
  // FIX C: on Windows, never let a self-upgrade perpetuate the legacy
  // node22-prefix install. If the running adhdev lives under ~/.adhdev/tools/
  // node22, force the install onto the canonical dispatcher prefix so the update
  // converges to the ~/.adhdev/npm-global pointer + shims. Scoped to win32 AND a
  // tools/node22 prefix so npm-linked dev / standalone / real dispatcher installs
  // are untouched.
  if (platform === 'win32' && isPortableNode22Prefix(installPrefix, homeDir, instanceDir)) {
    installPrefix = canonicalDispatcherInstallPrefix(homeDir, instanceDir);
  }
  return {
    npmExecutable: npmInvocation.executable,
    npmArgsPrefix: npmInvocation.argsPrefix,
    packageRoot,
    installPrefix,
    execOptions: npmInvocation.execOptions,
  };
}

export function buildPinnedGlobalInstallCommand(options: {
  packageName: string;
  targetVersion: string;
  currentCliPath?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
}): PinnedGlobalInstallCommand {
  const surface = resolveCurrentGlobalInstallSurface(options);
  const args = [...(surface.npmArgsPrefix || []), 'install', '-g', `${options.packageName}@${options.targetVersion || 'latest'}`, '--force'];
  if (surface.installPrefix) {
    args.push('--prefix', surface.installPrefix);
  }
  return {
    command: surface.npmExecutable,
    args,
    surface,
    execOptions: surface.execOptions || getNpmExecOptions(options.platform),
  };
}

/**
 * Build an env for the `npm install` child whose PATH is prefixed with the
 * directory of the node binary currently running this helper.
 *
 * npm runs lifecycle scripts (e.g. adhdev's `preinstall` Node-version guard) by
 * spawning a bare `node`, which resolves from PATH — NOT from the node that runs
 * npm. On Windows a machine can have several node installs (e.g. a standalone
 * `C:\Program Files\nodejs` ahead of an nvm-managed node on PATH). Without this,
 * the guard sees the wrong (unsupported) node version and aborts the upgrade,
 * even though npm/adhdev actually run under a supported node. Pinning the
 * running node's dir to the front of PATH makes lifecycle scripts use the same
 * node as the install itself.
 *
 * POSIX needs the same PATH (2026-10-01, Homebrew + nvm Mac): npm's own bin is
 * `#!/usr/bin/env node`, so running Homebrew's npm from a shell where nvm's
 * Node 22 is first on PATH ran npm — and better-sqlite3's prebuild download —
 * on Node 22. The daemon runs on Homebrew's Node 26, so the upgraded install
 * could not load its native modules and never booted.
 */
export function buildInstallEnvWithNodeOnPath(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nodeBinDir = path.dirname(process.execPath);
  if (!nodeBinDir) return { ...baseEnv };
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (process.platform !== 'win32') {
    env.PATH = env.PATH ? `${nodeBinDir}:${env.PATH}` : nodeBinDir;
    return env;
  }
  // Windows env keys are case-insensitive and conventionally spelled `Path`;
  // prepend to the existing key (whatever its case) to avoid creating a dupe.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const current = env[pathKey] || '';
  env[pathKey] = current ? `${nodeBinDir};${current}` : nodeBinDir;
  // Belt-and-suspenders for the same Node-version guard: the PATH prepend above
  // only works if the running helper's node is itself a supported version, but a
  // helper launched via an nvm shim (e.g. `C:\nvm4w\nodejs\node.exe`) can resolve
  // to Node 24 even though the real install target node is pinned via `--prefix`.
  // In the AUTOMATIC upgrade path the install target is already pinned/verified,
  // so authorize the lifecycle guard to proceed via the same bootstrap escape
  // hatch the guard already honors. This is scoped to the helper-built env only —
  // it never weakens the guard for a user-run `npm i -g adhdev`.
  env.ADHDEV_BOOTSTRAP = '1';
  // Same conpty.node protection the atomic path already applies to its install
  // env. If a machine-level or user .npmrc sets build-from-source=true, npm
  // rebuilds node-pty from source: the install script deletes the shipped
  // win32-x64 prebuild first, and on a box with no build tools the rebuild
  // leaves NO conpty.node at all — every create_session then dies with
  // "Failed to load native module: conpty.node". Pinning it false here forces
  // the prebuild path for the fallback in-place install too. Both spellings are
  // set because npm normalizes config keys inconsistently across versions.
  env.npm_config_build_from_source = 'false';
  env['npm_config_build-from-source'] = 'false';
  return env;
}

export function getNpmExecOptions(platform: NodeJS.Platform = process.platform): NpmExecOptions {
  if (platform === 'win32') {
    return { shell: false, windowsHide: true };
  }
  return { shell: false };
}

export function execNpmCommandSync(
  args: string[],
  options: ExecFileSyncOptions = {},
  surface?: Pick<CurrentGlobalInstallSurface, 'npmExecutable' | 'npmArgsPrefix' | 'execOptions'>,
): Buffer | string {
  const execOptions = surface?.execOptions || getNpmExecOptions();
  return execFileSync(
    surface?.npmExecutable || 'npm',
    [...(surface?.npmArgsPrefix || []), ...args],
    {
      ...options,
      ...execOptions,
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    },
  );
}

/**
 * Ask the registry which concrete version a dist-tag or exact version resolves
 * to: `npm view <pkg>@<tagOrVersion> version`.
 *
 * This is the single "what version would we install?" query. It previously
 * existed three times — the CLI `update` path, the IPC `daemon_upgrade`
 * handler, and the mandatory-update verifier — each with slightly different
 * exec plumbing, which is exactly the drift this collapses. The installation
 * side was already unified here (resolveCurrentGlobalInstallSurface /
 * buildPinnedGlobalInstallCommand); this closes the lookup side.
 *
 * The three call sites' genuine differences are preserved as parameters rather
 * than flattened, so no caller's behavior changes:
 *   - `timeout`: defaults to 10s (the IPC + mandatory value). The CLI passed
 *     none; it opts out explicitly with `timeout: undefined`, since an
 *     interactive `adhdev update` blocking on a slow registry is preferable to
 *     failing the command outright.
 *   - `stdio`: the mandatory path pipes all three streams so npm's stderr never
 *     leaks onto the daemon's console; others keep execFileSync's default.
 *   - `execFileSync`: injectable so the mandatory-update tests can assert the
 *     exact argv without touching the network.
 *
 * Returns the trimmed stdout — the resolved version string. Verifying that it
 * matches what the caller asked for is the caller's job (only the mandatory
 * path requires exact equality; a dist-tag lookup by definition returns
 * something different from the tag it was given).
 *
 * ## Cold-start resilience (win32 on-access AV scan)
 *
 * On Windows this spawns a PORTABLE `node.exe` running `npm-cli.js`
 * (resolveSiblingNpmInvocation). Those files live outside the usual trusted
 * locations, so Microsoft Defender's on-access scanner reads them end-to-end the
 * FIRST time they are executed. Measured on a real user machine:
 *
 *   cold spawn 10,897ms  |  warm spawn 758ms  |  raw HTTPS HEAD 129ms
 *
 * The 10s timeout above therefore fires on the cold spawn and never on the warm
 * one — the daemon-side upgrade dies before `npm install` is even reached, and
 * the very next attempt succeeds. That is a ~14x spread, so NO fixed timeout can
 * separate "AV is scanning" from "the registry is down": the scan cost scales
 * with file count, disk speed and which AV is installed.
 *
 * The fix is to retry, because the retry is what the measurement already proves
 * works — the second spawn hits a warm scanner cache. Deliberately NOT chosen:
 *
 *   - Raising the timeout: picks a new arbitrary number against a distribution
 *     with no upper bound, and makes a genuinely dead registry hang that much
 *     longer on every call.
 *   - Querying the registry over plain HTTPS (129ms, very tempting): `npm view`
 *     is not merely an HTTP GET. It resolves the full `.npmrc` hierarchy
 *     (project / user / global / builtin) for `registry`, `@scope:registry`,
 *     per-registry `_authToken` + `always-auth`, `proxy`/`https-proxy`/`noproxy`,
 *     `strict-ssl` and custom `cafile`. Reimplementing that is how a private
 *     registry or a corporate MITM proxy silently starts resolving against
 *     public npm — a correctness and supply-chain regression far worse than the
 *     latency it saves. (This is not hypothetical: an authenticated
 *     `//registry.npmjs.org/:_authToken` + `always-auth=true` is present on
 *     developer machines in this project today.) Keeping npm as the resolver
 *     keeps one source of truth for registry identity.
 *
 * Retries are scoped to TIMEOUTS ONLY (`ETIMEDOUT`, or a SIGTERM kill, which is
 * how execFileSync enforces `timeout`). A real failure — unpublished version,
 * 404, auth rejection, DNS failure — exits non-zero WITHOUT `ETIMEDOUT` and is
 * rethrown on the first attempt, so a dead registry still fails fast instead of
 * being retried into a multiple of the timeout. A caller that opted out of the
 * timeout entirely (the interactive CLI) can never time out, so it never
 * retries either.
 */
export function resolveNpmPublishedVersion(
  packageName: string,
  tagOrVersion: string,
  surface?: Pick<CurrentGlobalInstallSurface, 'npmExecutable' | 'npmArgsPrefix' | 'execOptions'>,
  options: {
    /** Milliseconds; explicitly pass `undefined` for no timeout. Defaults to 10_000. */
    timeout?: number;
    stdio?: ExecFileSyncOptions['stdio'];
    /** Injection seam for tests; defaults to the shared execNpmCommandSync path. */
    execFileSync?: (file: string, args: readonly string[], options: Record<string, unknown>) => string | Buffer;
    /**
     * Extra attempts allowed after a TIMEOUT (not after a real failure).
     * Defaults to 2 → at most 3 spawns. Set 0 to disable retrying.
     */
    timeoutRetries?: number;
    /** Observability seam: called before each retry. Defaults to the upgrade log. */
    onRetry?: (info: { attempt: number; attempts: number; timeoutMs: number; error: unknown }) => void;
  } = {},
): string {
  const args = ['view', `${packageName}@${tagOrVersion}`, 'version'];
  const effectiveTimeout = 'timeout' in options ? options.timeout : 10_000;
  const execOptions: ExecFileSyncOptions = {
    encoding: 'utf-8',
    ...(effectiveTimeout === undefined ? {} : { timeout: effectiveTimeout }),
    ...(options.stdio ? { stdio: options.stdio } : {}),
  };

  const runOnce = (): string => {
    if (options.execFileSync) {
      // Mirror execNpmCommandSync's argv/option assembly so an injected runner
      // observes exactly what the real one would have executed.
      const runnerOptions = surface?.execOptions || getNpmExecOptions();
      return String(options.execFileSync(
        surface?.npmExecutable || 'npm',
        [...(surface?.npmArgsPrefix || []), ...args],
        {
          ...execOptions,
          ...runnerOptions,
          ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        },
      )).trim();
    }
    return String(execNpmCommandSync(args, execOptions, surface)).trim();
  };

  // No timeout configured → the spawn cannot be killed for slowness, so there is
  // no cold-scan failure to recover from and retrying would only multiply a real
  // error. Run exactly once, preserving the interactive CLI's behavior verbatim.
  const retries = effectiveTimeout === undefined ? 0 : Math.max(0, options.timeoutRetries ?? 2);
  const attempts = retries + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return runOnce();
    } catch (error) {
      lastError = error;
      // Retry ONLY a timeout, and only while attempts remain. Anything else —
      // a 404, an auth failure, an offline registry — is a real answer and is
      // rethrown immediately so the caller still fails fast.
      // `effectiveTimeout` is necessarily defined here: `retries` is forced to 0
      // when it is undefined, so this branch is unreachable without a timeout.
      if (attempt >= attempts || effectiveTimeout === undefined || !isSpawnTimeoutError(error)) throw error;
      const info = { attempt, attempts, timeoutMs: effectiveTimeout, error };
      if (options.onRetry) options.onRetry(info);
      else {
        appendUpgradeLog(
          `npm view ${packageName}@${tagOrVersion} timed out after ${effectiveTimeout}ms `
          + `(attempt ${attempt}/${attempts}); retrying. This is expected on the first run after `
          + `install while on-access antivirus scans the bundled node/npm binaries.`,
        );
      }
    }
  }
  throw lastError;
}
