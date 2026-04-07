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

function getNpmExecutable(): string {
  return 'npm';
}

function getNpmExecOptions(): { shell: boolean } {
  return { shell: process.platform === 'win32' };
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

function stopSessionHostProcesses(appName: string): void {
  const pidFile = path.join(os.homedir(), '.adhdev', `${appName}-session-host.pid`);
  try {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid)) {
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

  if (process.platform !== 'win32') {
    try {
      const raw = execFileSync('pgrep', ['-f', 'session-host-daemon'], { encoding: 'utf8' }).trim();
      for (const line of raw.split('\n')) {
        const pid = Number.parseInt(line.trim(), 10);
        if (Number.isFinite(pid)) {
          killPid(pid);
        }
      }
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

function cleanupStaleGlobalInstallDirs(pkgName: string): void {
  const npmExecOpts = getNpmExecOptions();
  const npmRoot = execFileSync(getNpmExecutable(), ['root', '-g'], { encoding: 'utf8', ...npmExecOpts }).trim();
  if (!npmRoot) return;
  const npmPrefix = execFileSync(getNpmExecutable(), ['prefix', '-g'], { encoding: 'utf8', ...npmExecOpts }).trim();
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
      if (![...binNames].some((name) => entry.startsWith(`.${name}-`))) continue;
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
  appendUpgradeLog(`Upgrade helper started for ${payload.packageName}@${payload.targetVersion}`);

  if (Number.isFinite(payload.parentPid) && payload.parentPid > 0) {
    appendUpgradeLog(`Waiting for parent pid ${payload.parentPid} to exit`);
    await waitForPidExit(payload.parentPid, 15000);
  }

  stopSessionHostProcesses(sessionHostAppName);
  removeDaemonPidFile();
  cleanupStaleGlobalInstallDirs(payload.packageName);

  const spec = `${payload.packageName}@${payload.targetVersion || 'latest'}`;
  appendUpgradeLog(`Installing ${spec}`);
  const installOutput = execFileSync(
    getNpmExecutable(),
    ['install', '-g', spec, '--force'],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 20 * 1024 * 1024,
      ...getNpmExecOptions(),
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
    cleanupStaleGlobalInstallDirs(payload.packageName);
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
