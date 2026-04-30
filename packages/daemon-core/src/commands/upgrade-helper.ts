import { execFileSync } from 'child_process';
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
  execOptions?: { shell: boolean };
}

export interface PinnedGlobalInstallCommand {
  command: string;
  args: string[];
  surface: CurrentGlobalInstallSurface;
  execOptions: { shell: boolean };
}

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
  execOptions: { shell: boolean };
} {
  const binDir = path.dirname(nodeExecutable);
  if (platform === 'win32') {
    const npmCliPath = path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCliPath)) {
      return { executable: nodeExecutable, argsPrefix: [npmCliPath], execOptions: { shell: false } };
    }
    for (const candidate of ['npm.exe', 'npm']) {
      const candidatePath = path.join(binDir, candidate);
      if (fs.existsSync(candidatePath)) {
        return { executable: candidatePath, argsPrefix: [], execOptions: { shell: false } };
      }
    }
    return { executable: nodeExecutable, argsPrefix: [npmCliPath], execOptions: { shell: false } };
  }
  for (const candidate of ['npm']) {
    const candidatePath = path.join(binDir, candidate);
    if (fs.existsSync(candidatePath)) {
      return { executable: candidatePath, argsPrefix: [], execOptions: { shell: false } };
    }
  }
  return { executable: 'npm', argsPrefix: [], execOptions: { shell: false } };
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

function getNpmExecOptions(_platform: NodeJS.Platform = process.platform): { shell: boolean } {
  return { shell: false };
}

function killPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
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
    ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (psOut) return psOut;
  } catch {
    // fall through to wmic fallback
  }

  try {
    const wmicOut = execFileSync('wmic', [
      'process', 'where', pidFilter, 'get', 'CommandLine',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

function cleanupStaleGlobalInstallDirs(pkgName: string, surface: CurrentGlobalInstallSurface): void {
  const prefixArgs = surface.installPrefix ? ['--prefix', surface.installPrefix] : [];
  const npmRoot = execFileSync(surface.npmExecutable, [...(surface.npmArgsPrefix || []), 'root', '-g', ...prefixArgs], { encoding: 'utf8', ...surface.execOptions }).trim();
  if (!npmRoot) return;
  const npmPrefix = surface.installPrefix
    || execFileSync(surface.npmExecutable, [...(surface.npmArgsPrefix || []), 'prefix', '-g', ...prefixArgs], { encoding: 'utf8', ...surface.execOptions }).trim();
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
      fs.rmSync(path.join(scopeDir, entry), { recursive: true, force: true });
      appendUpgradeLog(`Removed stale scoped staging dir: ${path.join(scopeDir, entry)}`);
    }
  } else {
    for (const entry of fs.readdirSync(npmRoot)) {
      if (!entry.startsWith(`.${pkgName}-`)) continue;
      fs.rmSync(path.join(npmRoot, entry), { recursive: true, force: true });
      appendUpgradeLog(`Removed stale staging dir: ${path.join(npmRoot, entry)}`);
    }
  }

  if (fs.existsSync(binDir)) {
    for (const entry of fs.readdirSync(binDir)) {
      if (!Array.from(binNames).some((name) => entry.startsWith(`.${name}-`))) continue;
      fs.rmSync(path.join(binDir, entry), { recursive: true, force: true });
      appendUpgradeLog(`Removed stale bin staging entry: ${path.join(binDir, entry)}`);
    }
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
