import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

function getUpgradeLogPath(): string {
  const home = os.homedir();
  const dir = path.join(home, '.adhdev');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'daemon-upgrade.log');
}

function appendUpgradeLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(getUpgradeLogPath(), line, 'utf8');
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

function killPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function getWindowsProcessCommandLine(pid: number): string | null {
  const pidFilter = `ProcessId=${pid}`;
  try {
    const psOut = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "${pidFilter}").CommandLine`,
    ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (psOut) return psOut;
  } catch {
    // fall through to wmic fallback
  }

  try {
    const wmicOut = execFileSync('wmic', [
      'process', 'where', pidFilter, 'get', 'CommandLine',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (wmicOut) return wmicOut;
  } catch {
    // noop
  }
  return null;
}

function getProcessCommandLine(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return getWindowsProcessCommandLine(pid);
  try {
    const text = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return text || null;
  } catch {
    return null;
  }
}

function isManagedSessionHostPid(pid: number): boolean {
  const commandLine = getProcessCommandLine(pid);
  return !!commandLine && /session-host-daemon/i.test(commandLine);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      return;
    }
  }
}

export function stopSessionHostProcesses(appName: string): void {
  const pidFile = path.join(os.homedir(), '.adhdev', `${appName}-session-host.pid`);
  try {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && isManagedSessionHostPid(pid)) {
        killPid(pid);
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

  stopSessionHostProcesses(sessionHostAppName);
  removeDaemonPidFile();
  cleanupStaleGlobalInstallDirs(payload.packageName, installCommand.surface);

  const spec = `${payload.packageName}@${payload.targetVersion || 'latest'}`;
  appendUpgradeLog(`Installing ${spec}`);
  const installOutput = execFileSync(
    installCommand.command,
    installCommand.args,
    {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 20 * 1024 * 1024,
      env: buildInstallEnvWithNodeOnPath(),
      ...installCommand.execOptions,
    },
  );
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
    appendUpgradeLog(`Upgrade helper failed: ${error?.stack || error?.message || String(error)}`);
    process.exit(1);
  }
}
