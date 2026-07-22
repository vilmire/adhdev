import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ADHDEV_OWNED_MARKERS,
  createDefaultWindowsAtomicHooks,
  findPortableNode22,
  performWindowsAtomicUpgrade,
  resolveWindowsInstallerLayout,
} from './windows-atomic-upgrade.js';
import {
  getProcessCommandLine,
  killProcess,
  stopOwnedProcessesForPrefixes,
  waitForPidExit,
} from './process-lifecycle.js';

const UPGRADE_HELPER_ENV = 'ADHDEV_DAEMON_UPGRADE_HELPER';

export interface DaemonUpgradeHelperPayload {
  packageName: string;
  targetVersion: string;
  parentPid: number;
  restartArgv: string[];
  cwd?: string;
  sessionHostAppName?: string;
}

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

function getUpgradeLogPath(home: string = os.homedir()): string {
  const dir = path.join(home, '.adhdev');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'daemon-upgrade.log');
}

function appendUpgradeLog(message: string, homeDir: string = os.homedir()): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(getUpgradeLogPath(homeDir), line, 'utf8');
  } catch {
    // noop
  }
}

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

export function resolveCurrentGlobalInstallSurface(options: {
  packageName: string;
  currentCliPath?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
}): CurrentGlobalInstallSurface {
  const packageRoot = findCurrentPackageRoot(options.currentCliPath || process.argv[1], options.packageName);
  const npmInvocation = resolveSiblingNpmInvocation(options.nodeExecutable || process.execPath, options.platform);
  return {
    npmExecutable: npmInvocation.executable,
    npmArgsPrefix: npmInvocation.argsPrefix,
    packageRoot,
    installPrefix: packageRoot ? resolveInstallPrefixFromPackageRoot(packageRoot, options.packageName) : null,
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
 */
function buildInstallEnvWithNodeOnPath(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The Node-version guard this works around only fires on Windows, so scope the
  // PATH rewrite to win32 — POSIX keeps its env untouched.
  if (process.platform !== 'win32') return { ...baseEnv };
  const nodeBinDir = path.dirname(process.execPath);
  if (!nodeBinDir) return { ...baseEnv };
  const env: NodeJS.ProcessEnv = { ...baseEnv };
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

function isManagedSessionHostPid(pid: number): boolean {
  const commandLine = getProcessCommandLine(pid);
  return !!commandLine && /session-host-daemon/i.test(commandLine);
}

export async function stopSessionHostProcesses(appName: string): Promise<void> {
  const pidFile = path.join(os.homedir(), '.adhdev', `${appName}-session-host.pid`);
  let killedPid: number | null = null;
  try {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && isManagedSessionHostPid(pid)) {
        if (killProcess(pid)) killedPid = pid;
      }
    }
  } catch {
    // noop
  } finally {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // noop
    }
  }

  // The session-host process keeps node-pty's `conpty.node` memory-mapped. On
  // Windows a mapped native addon stays EXCLUSIVELY locked until the process
  // fully exits and tears down the mapping — and that teardown lags `taskkill`
  // by an indeterminate interval. `taskkill` only *requests* termination, so
  // returning immediately lets the caller run `npm install` while conpty.node
  // is still locked, which makes npm's copy-to-staging fail with EBUSY (the
  // intermittent Windows upgrade failure). Wait for the killed process to
  // actually disappear — like we already do for the parent daemon pid — so the
  // file handle is released before the install runs. (POSIX can replace an open
  // file freely, so the wait is harmless there.)
  if (killedPid !== null) {
    await waitForPidExit(killedPid, 15000);
  }
}

// Native addons that stay EXCLUSIVELY locked on Windows while any process keeps
// them memory-mapped. node-pty's `conpty.node` is the confirmed offender; the
// ghostty VT dll has the same lifetime, so guard both.
const LOCKED_NATIVE_ADDON_BASENAMES = ['conpty.node', 'ghostty-vt.dll'];

/**
 * Enumerate processes that have a locked native addon (conpty.node /
 * ghostty-vt.dll) of *this* install memory-mapped.
 *
 * `stopSessionHostProcesses()` only knows the single managed session-host pid, so
 * any *foreign* holder — e.g. an orphaned `pty_*probe*.cjs` left in `%TEMP%` — is
 * invisible to it and keeps the addon locked through every install retry, dooming
 * the upgrade with EBUSY. This scans by the module's full path so we only ever
 * target a holder of the exact `packageRoot` being replaced (never an unrelated
 * install's copy). Windows-only — these locks don't exist on POSIX.
 */
export function listForeignNativeAddonHolders(
  packageRoot: string | null | undefined,
): Array<{ pid: number; commandLine: string | null }> {
  if (process.platform !== 'win32' || !packageRoot) return [];
  const rootLower = packageRoot.replace(/\//g, '\\').replace(/'/g, "''").toLowerCase();
  const endsWithChecks = LOCKED_NATIVE_ADDON_BASENAMES
    .map((name) => `$lf.EndsWith('${name}')`)
    .join(' -or ');
  // List pids of node processes whose loaded modules include a locked native
  // addon living UNDER this install's package root. Accessing .Modules for a
  // process we can't open throws — swallow per-process so one inaccessible
  // process doesn't abort the whole scan.
  const script = [
    `$root = '${rootLower}'`,
    `Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {`,
    `  $p = $_`,
    `  try {`,
    `    foreach ($m in $p.Modules) {`,
    `      $fn = $m.FileName`,
    `      if ($fn) {`,
    `        $lf = $fn.ToLower()`,
    `        if ($lf.StartsWith($root) -and (${endsWithChecks})) { $p.Id; break }`,
    `      }`,
    `    }`,
    `  } catch {}`,
    `}`,
  ].join('\n');

  let out = '';
  try {
    out = String(execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim();
  } catch {
    return [];
  }

  const selfPid = process.pid;
  const seen = new Set<number>();
  const holders: Array<{ pid: number; commandLine: string | null }> = [];
  for (const line of out.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0 || pid === selfPid || seen.has(pid)) continue;
    seen.add(pid);
    holders.push({ pid, commandLine: getProcessCommandLine(pid) });
  }
  return holders;
}

/**
 * Terminate every foreign process holding this install's native addon mapped,
 * then wait for each to actually exit so the mapping is released before npm
 * copies the file into its staging dir. Returns what it found/killed so the
 * caller can surface an actionable recovery message on failure.
 */
export async function stopForeignNativeAddonHolders(
  packageRoot: string | null | undefined,
  options: { parentPid?: number } = {},
): Promise<Array<{ pid: number; commandLine: string | null; killed: boolean }>> {
  if (process.platform !== 'win32' || !packageRoot) return [];
  const parentPid = Number.isFinite(options.parentPid) ? Number(options.parentPid) : -1;
  const holders = listForeignNativeAddonHolders(packageRoot);
  const results: Array<{ pid: number; commandLine: string | null; killed: boolean }> = [];
  for (const holder of holders) {
    // The parent daemon pid is already awaited for exit separately; never
    // double-handle it here.
    if (holder.pid === parentPid) continue;
    appendUpgradeLog(
      `Foreign native-addon holder found: pid ${holder.pid}${holder.commandLine ? ` — ${holder.commandLine}` : ''}`,
    );
    const killed = killProcess(holder.pid);
    if (killed) {
      await waitForPidExit(holder.pid, 15000);
      appendUpgradeLog(`Terminated foreign native-addon holder pid ${holder.pid}`);
    } else {
      appendUpgradeLog(`Failed to terminate foreign native-addon holder pid ${holder.pid}`);
    }
    results.push({ ...holder, killed });
  }
  return results;
}

function getUpgradeFailureNoticePath(home: string = os.homedir()): string {
  const dir = path.join(home, '.adhdev');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // noop — appendUpgradeLog already creates the dir; this is best-effort.
  }
  return path.join(dir, 'daemon-upgrade-last-error.txt');
}

function buildManualRecoveryCommand(installCommand: PinnedGlobalInstallCommand): string {
  return [installCommand.command, ...installCommand.args]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(' ');
}

/**
 * On final failure, leave the user something actionable instead of only a buried
 * log line: the pids/commandlines still holding the lock and a paste-ready
 * recovery command. Written to a stable path the CLI can surface on next boot.
 */
export function emitUpgradeFailureNotice(lines: string[], homeDir: string = os.homedir()): void {
  const body = lines.join('\n');
  appendUpgradeLog(`Upgrade blocked — user action required:\n${body}`, homeDir);
  try {
    fs.writeFileSync(getUpgradeFailureNoticePath(homeDir), `[${new Date().toISOString()}]\n${body}\n`, 'utf8');
  } catch {
    // noop
  }
}

// npm copies the current install's files into a staging dir before swapping in
// the new version. On Windows that copy of `conpty.node` can still race a
// just-killed session-host whose mapping hasn't been released yet, surfacing as
// EBUSY/EPERM. Treat those as transient and retry with backoff.
function isRetriableInstallLockError(error: any): boolean {
  const code = error?.code;
  if (code === 'EBUSY' || code === 'EPERM') return true;
  const text = `${error?.message || ''} ${error?.stderr || ''}`;
  return /\bEBUSY\b|\bEPERM\b|resource busy or locked/i.test(text);
}

function removeDaemonPidFile(): void {
  const pidFile = path.join(os.homedir(), '.adhdev', 'daemon.pid');
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // noop
  }
}

/**
 * Best-effort removal of a leftover npm staging entry.
 *
 * A stale staging dir can hold a locked native binary — e.g. `ghostty-vt.dll`
 * from `@adhdev/ghostty-vt-node` still mapped by a lingering session-host
 * process — which makes `rmSync` throw `EPERM` on Windows. Staging cleanup is
 * only housekeeping: the leftover is inert and npm creates its own fresh
 * staging dir for the real install, so a lock on an old leftover must NOT abort
 * the upgrade. Log and continue instead of letting the error propagate.
 */
export function safeRemoveStaleEntry(target: string, label: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    appendUpgradeLog(`${label}: ${target}`);
  } catch (error: any) {
    appendUpgradeLog(`Skipped locked stale entry (${error?.code || 'error'}): ${target} — ${error?.message || String(error)}`);
  }
}

export function cleanupStaleGlobalInstallDirs(pkgName: string, surface: CurrentGlobalInstallSurface): void {
  // The whole routine is housekeeping — never let it throw out and abort the
  // upgrade (npm root/prefix probing or readdir can fail for unrelated reasons).
  try {
    const prefixArgs = surface.installPrefix ? ['--prefix', surface.installPrefix] : [];
    const npmRoot = String(execNpmCommandSync(['root', '-g', ...prefixArgs], { encoding: 'utf8' }, surface)).trim();
    if (!npmRoot) return;
    const npmPrefix = surface.installPrefix
      || String(execNpmCommandSync(['prefix', '-g', ...prefixArgs], { encoding: 'utf8' }, surface)).trim();
    const binDir = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
    const packageBaseName = pkgName.startsWith('@') ? pkgName.split('/')[1] : pkgName;
    const binNames = new Set<string>([packageBaseName]);
    if (pkgName === '@adhdev/daemon-standalone') {
      binNames.add('adhdev-standalone');
    }

    if (pkgName.startsWith('@')) {
      const [scope, name] = pkgName.split('/');
      const scopeDir = path.join(npmRoot, scope);
      if (!fs.existsSync(scopeDir)) return;
      for (const entry of fs.readdirSync(scopeDir)) {
        if (!entry.startsWith(`.${name}-`)) continue;
        safeRemoveStaleEntry(path.join(scopeDir, entry), 'Removed stale scoped staging dir');
      }
    } else {
      for (const entry of fs.readdirSync(npmRoot)) {
        if (!entry.startsWith(`.${pkgName}-`)) continue;
        safeRemoveStaleEntry(path.join(npmRoot, entry), 'Removed stale staging dir');
      }
    }

    if (fs.existsSync(binDir)) {
      for (const entry of fs.readdirSync(binDir)) {
        if (!Array.from(binNames).some((name) => entry.startsWith(`.${name}-`))) continue;
        safeRemoveStaleEntry(path.join(binDir, entry), 'Removed stale bin staging entry');
      }
    }
  } catch (error: any) {
    appendUpgradeLog(`Stale staging cleanup skipped (${error?.code || 'error'}): ${error?.message || String(error)}`);
  }
}

export function spawnDetachedDaemonUpgradeHelper(payload: DaemonUpgradeHelperPayload): void {
  const env = { ...process.env, [UPGRADE_HELPER_ENV]: JSON.stringify(payload) };
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: payload.cwd || process.cwd(),
    env,
  });
  child.unref();
}

async function runDaemonUpgradeHelper(payload: DaemonUpgradeHelperPayload): Promise<void> {
  const restartArgv = Array.isArray(payload.restartArgv) ? payload.restartArgv : [];
  const sessionHostAppName = payload.sessionHostAppName || process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev';
  const installCommand = buildPinnedGlobalInstallCommand({
    packageName: payload.packageName,
    targetVersion: payload.targetVersion,
  });
  appendUpgradeLog(`Upgrade helper started for ${payload.packageName}@${payload.targetVersion}`);
  appendUpgradeLog(`Using npm executable: ${installCommand.command}`);
  if (installCommand.surface.installPrefix) {
    appendUpgradeLog(`Pinned install prefix: ${installCommand.surface.installPrefix}`);
  }

  if (Number.isFinite(payload.parentPid) && payload.parentPid > 0) {
    appendUpgradeLog(`Waiting for parent pid ${payload.parentPid} to exit`);
    await waitForPidExit(payload.parentPid, 15000);
  }

  await stopSessionHostProcesses(sessionHostAppName);
  removeDaemonPidFile();
  const windowsInstallerLayout = resolveWindowsInstallerLayout({
    homeDir: os.homedir(),
    installPrefix: installCommand.surface.installPrefix,
  });
  if (windowsInstallerLayout) {
    const portableNode = findPortableNode22(os.homedir());
    if (!portableNode) {
      throw new Error('installer-managed Windows update requires the portable Node.js 22 runtime');
    }
    const npmCliPath = path.join(path.dirname(portableNode), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCliPath)) {
      throw new Error(`portable Node.js 22 npm CLI is missing: ${npmCliPath}`);
    }
    appendUpgradeLog(`Installer-managed pointer layout detected; active prefix will remain untouched: ${windowsInstallerLayout.activePrefix}`);

    // Terminate any ADHDev-owned process still executing from the current active
    // prefix or the legacy stable shim tree before activation. The parent daemon
    // and this helper itself are excluded: the parent is already exiting, and the
    // helper must survive to complete the upgrade.
    const upgradePids = [process.pid, payload.parentPid].filter((n): n is number => Number.isFinite(n) && n > 0);
    const preStop = await stopOwnedProcessesForPrefixes({
      prefixes: [windowsInstallerLayout.activePrefix, windowsInstallerLayout.stablePrefix],
      excludePids: upgradePids,
      markers: Array.from(ADHDEV_OWNED_MARKERS),
      waitMs: 15_000,
      log: appendUpgradeLog,
    });
    if (preStop.survivors.length > 0) {
      throw new Error(
        `Cannot upgrade: owned processes still running under current prefix: ${preStop.survivors.map((s) => s.pid).join(', ')}`
      );
    }

    try {
      await performWindowsAtomicUpgrade({
        layout: windowsInstallerLayout,
        packageName: payload.packageName,
        targetVersion: payload.targetVersion,
        portableNode,
        excludePids: upgradePids,
        hooks: createDefaultWindowsAtomicHooks({
          packageName: payload.packageName,
          targetVersion: payload.targetVersion,
          npmCliPath,
          restartArgv,
          cwd: payload.cwd || process.cwd(),
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== UPGRADE_HELPER_ENV)),
          log: appendUpgradeLog,
        }),
      });
    } catch (error: any) {
      // performWindowsAtomicUpgrade already rolled the pointer/shims back to the
      // prior version before rethrowing. Without a durable notice that rollback
      // was silent — the daemon simply kept running the old version (the rc.6
      // stuck-upgrade defect). Leave an actionable last-error file naming the
      // target that failed its health/version gate.
      emitUpgradeFailureNotice([
        `adhdev ${payload.packageName}@${payload.targetVersion} upgrade failed and was rolled back: ${error?.message || String(error)}`,
        `Previous version preserved (active prefix: ${windowsInstallerLayout.activePrefix}).`,
        'See daemon-upgrade.log for the full install/health trace. The next daemon start will retry.',
      ]);
      throw error;
    }
    try { fs.unlinkSync(getUpgradeFailureNoticePath()); } catch { /* no previous failure notice */ }
    appendUpgradeLog('Installer-managed Windows atomic upgrade completed');
    return;
  }
  // Kill any *foreign* process still holding this install's conpty.node mapped
  // (the session-host stop above only covers the single managed pid). Do this
  // BEFORE the staging GC so the just-released file can also be cleaned up now
  // that no process maps it.
  await stopForeignNativeAddonHolders(installCommand.surface.packageRoot, { parentPid: payload.parentPid });
  cleanupStaleGlobalInstallDirs(payload.packageName, installCommand.surface);

  const spec = `${payload.packageName}@${payload.targetVersion || 'latest'}`;
  appendUpgradeLog(`Installing ${spec}`);
  // Windows can still race a lingering conpty.node mapping even after the
  // session-host exits, so retry the install on transient lock errors there.
  const maxInstallAttempts = process.platform === 'win32' ? 3 : 1;
  let installOutput = '';
  for (let attempt = 1; attempt <= maxInstallAttempts; attempt++) {
    try {
      installOutput = String(execFileSync(
        installCommand.command,
        installCommand.args,
        {
          encoding: 'utf8',
          stdio: 'pipe',
          maxBuffer: 20 * 1024 * 1024,
          env: buildInstallEnvWithNodeOnPath(),
          ...installCommand.execOptions,
        },
      ));
      break;
    } catch (error: any) {
      if (attempt < maxInstallAttempts && isRetriableInstallLockError(error)) {
        appendUpgradeLog(`Install attempt ${attempt} hit a file lock (${error?.code || 'lock'}); clearing holders + staging and retrying after backoff`);
        // Re-run the active cleanup ("정리 → 확인 → 설치") rather than relying on
        // backoff alone: a never-exiting foreign holder won't disappear on its
        // own, so kill it again before the next attempt.
        await stopForeignNativeAddonHolders(installCommand.surface.packageRoot, { parentPid: payload.parentPid });
        cleanupStaleGlobalInstallDirs(payload.packageName, installCommand.surface);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        continue;
      }
      // Out of retries on a lock error: leave the user an actionable recovery
      // notice naming whoever is still holding the native addon locked.
      if (isRetriableInstallLockError(error)) {
        const blockers = listForeignNativeAddonHolders(installCommand.surface.packageRoot);
        const notice: string[] = [
          `adhdev ${spec} could not be installed: a file lock (${error?.code || 'EBUSY/EPERM'}) is blocking the native addon.`,
        ];
        if (blockers.length > 0) {
          notice.push('Processes still holding the lock:');
          for (const b of blockers) {
            notice.push(`  pid ${b.pid}${b.commandLine ? ` — ${b.commandLine}` : ''}`);
          }
          notice.push('To recover, stop them and reinstall:');
          notice.push(`  Stop-Process -Id ${blockers.map((b) => b.pid).join(',')} -Force`);
        } else {
          notice.push('To recover, reinstall manually:');
        }
        notice.push(`  ${buildManualRecoveryCommand(installCommand)}`);
        emitUpgradeFailureNotice(notice);
      }
      throw error;
    }
  }
  if (installOutput.trim()) {
    appendUpgradeLog(installOutput.trim());
  }

  // npm may leave a staging dir behind on Windows when prebuild-install holds
  // conpty.node open during install scripts. Clean it up now that all npm child
  // processes have exited.
  if (process.platform === 'win32') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    cleanupStaleGlobalInstallDirs(payload.packageName, installCommand.surface);
    appendUpgradeLog('Post-install staging cleanup complete');
  }

  if (restartArgv.length > 0) {
    const env = { ...process.env };
    delete env[UPGRADE_HELPER_ENV];
    appendUpgradeLog(`Restarting daemon with args: ${restartArgv.join(' ')}`);
    const child = spawn(process.execPath, restartArgv, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: payload.cwd || process.cwd(),
      env,
    });
    child.unref();
  } else {
    appendUpgradeLog('No restart argv provided; upgrade completed without restart');
  }
  try { fs.unlinkSync(getUpgradeFailureNoticePath()); } catch { /* no previous failure notice */ }
}

export async function maybeRunDaemonUpgradeHelperFromEnv(): Promise<boolean> {
  const raw = process.env[UPGRADE_HELPER_ENV];
  if (!raw) return false;
  delete process.env[UPGRADE_HELPER_ENV];

  try {
    const payload = JSON.parse(raw) as DaemonUpgradeHelperPayload;
    await runDaemonUpgradeHelper(payload);
    process.exit(0);
  } catch (error: any) {
    const detail = error?.stack || error?.message || String(error);
    appendUpgradeLog(`Upgrade helper failed: ${detail}`);
    emitUpgradeFailureNotice([
      `adhdev upgrade failed: ${error?.message || String(error)}`,
      `See ${getUpgradeLogPath()} for details. The previous installer-managed version was preserved or restored when available.`,
    ]);
    process.exit(1);
  }
}
