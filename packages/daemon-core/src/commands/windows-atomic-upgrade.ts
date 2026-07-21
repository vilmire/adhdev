import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const POINTER_NAME = '.adhdev-current';
const STABLE_FILES = [POINTER_NAME, 'adhdev.cmd', 'adhdev.ps1', 'adhdev'] as const;
const DEFAULT_HEALTH_PORT = 19222;

export interface WindowsInstallerLayout {
  homeDir: string;
  installRoot: string;
  stablePrefix: string;
  activePrefix: string;
  activeVersionName: string;
  pointerPath: string;
}

export interface WindowsAtomicUpgradeHooks {
  install: (stagedPrefix: string, portableNode: string) => void | Promise<void>;
  restart: (portableNode: string, stagedCliEntry: string) => ChildProcess;
  restartOld: (portableNode: string) => void;
  waitForHealth: (pid: number, targetVersion: string) => Promise<boolean>;
  stopProcess: (pid: number) => void;
  cleanup: (layout: WindowsInstallerLayout, activePrefix: string) => void;
  log: (message: string) => void;
}

export interface WindowsAtomicUpgradeOptions {
  layout: WindowsInstallerLayout;
  packageName: string;
  targetVersion: string;
  portableNode: string;
  hooks: WindowsAtomicUpgradeHooks;
}

export interface WindowsAtomicUpgradeResult {
  stagedPrefix: string;
  stagedCliEntry: string;
  daemonPid: number;
}

function normalizeForCompare(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

export function resolveWindowsInstallerLayout(options: {
  homeDir: string;
  installPrefix: string | null;
  platform?: NodeJS.Platform;
}): WindowsInstallerLayout | null {
  if ((options.platform || process.platform) !== 'win32' || !options.installPrefix) return null;
  const installRoot = path.join(options.homeDir, '.adhdev', 'npm-installs');
  const stablePrefix = path.join(options.homeDir, '.adhdev', 'npm-global');
  const pointerPath = path.join(stablePrefix, POINTER_NAME);
  const activeVersionName = path.basename(options.installPrefix);
  if (!activeVersionName.startsWith('version-')) return null;
  if (normalizeForCompare(path.dirname(options.installPrefix)) !== normalizeForCompare(installRoot)) return null;
  return {
    homeDir: options.homeDir,
    installRoot,
    stablePrefix,
    activePrefix: options.installPrefix,
    activeVersionName,
    pointerPath,
  };
}

function nodeMajor(nodeExecutable: string): number | null {
  try {
    const version = String(execFileSync(nodeExecutable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const major = Number.parseInt(version.split('.')[0], 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

export function findPortableNode22(homeDir: string, currentNode: string = process.execPath): string | null {
  const candidates: string[] = [currentNode];
  const portableRoot = path.join(homeDir, '.adhdev', 'tools', 'node22');
  try {
    const dirs = fs.readdirSync(portableRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(portableRoot, entry.name, 'node.exe'));
    candidates.push(...dirs);
  } catch {
    // The installer-managed layout is incomplete; the caller will fail safely.
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && nodeMajor(candidate) === 22) return candidate;
  }
  return null;
}

function packageRootForPrefix(prefix: string, packageName: string): string {
  return path.join(prefix, 'node_modules', ...packageName.split('/'));
}

function readPackageCliEntry(prefix: string, packageName: string, targetVersion: string): string {
  const packageRoot = packageRootForPrefix(prefix, packageName);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (pkg.name !== packageName) throw new Error(`staged package name mismatch: ${pkg.name || 'missing'}`);
  if (pkg.version !== targetVersion) throw new Error(`staged package version mismatch: ${pkg.version || 'missing'}`);
  const bin = typeof pkg.bin === 'string'
    ? pkg.bin
    : pkg.bin?.adhdev || (pkg.bin ? Object.values(pkg.bin)[0] : undefined);
  if (!bin) throw new Error('staged package has no CLI entry');
  const cliEntry = path.resolve(packageRoot, bin);
  if (!fs.existsSync(cliEntry)) throw new Error(`staged CLI entry is missing: ${cliEntry}`);
  return cliEntry;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pinStagedShims(prefix: string, portableNode: string, cliEntry: string): void {
  const cmdPath = path.join(prefix, 'adhdev.cmd');
  const ps1Path = path.join(prefix, 'adhdev.ps1');
  const cmd = `@echo off\r\n"${portableNode}" "${cliEntry}" %*\r\n`;
  const ps1 = `#!/usr/bin/env pwsh\r\n& ${quotePowerShellLiteral(portableNode)} ${quotePowerShellLiteral(cliEntry)} @args\r\nexit $LASTEXITCODE\r\n`;
  fs.writeFileSync(cmdPath, cmd, 'ascii');
  fs.writeFileSync(ps1Path, ps1, 'utf8');
  const cmdReadback = fs.readFileSync(cmdPath, 'utf8');
  const ps1Readback = fs.readFileSync(ps1Path, 'utf8');
  if (!cmdReadback.includes(portableNode) || !ps1Readback.includes(portableNode)) {
    throw new Error('portable Node 22 pin validation failed');
  }
}

function validateStagedCli(portableNode: string, cliEntry: string, targetVersion: string): void {
  const output = String(execFileSync(portableNode, [cliEntry, '--version'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  if (!output.includes(targetVersion)) {
    throw new Error(`staged CLI version check failed: expected ${targetVersion}, received ${output || 'no output'}`);
  }
}

function atomicWrite(destination: string, content: string, encoding: BufferEncoding): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (process.platform === 'win32') {
    const bytes = Buffer.from(content, encoding);
    const payload = Buffer.from(JSON.stringify({ destination, bytes: bytes.toString('base64') }), 'utf8').toString('base64');
    const script = [
      `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
      `$destination = [string]$payload.destination`,
      `$temporary = "$destination.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"`,
      `$backup = "$destination.backup-$PID-$([Guid]::NewGuid().ToString('N'))"`,
      `try {`,
      `  [IO.File]::WriteAllBytes($temporary, [Convert]::FromBase64String([string]$payload.bytes))`,
      `  if ([IO.File]::Exists($destination)) {`,
      `    [IO.File]::Replace($temporary, $destination, $backup, $true)`,
      `    if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }`,
      `  } else { [IO.File]::Move($temporary, $destination) }`,
      `} finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`atomic file replacement failed for ${destination}: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    }
    return;
  }
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, content, encoding);
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* noop */ }
    throw error;
  }
}

function stableShimContents(): Record<'adhdev.cmd' | 'adhdev.ps1' | 'adhdev', { content: string; encoding: BufferEncoding }> {
  return {
    'adhdev.cmd': {
      content: '@echo off\r\nsetlocal\r\nset /p "_ADHDEV_VERSION="<"%~dp0.adhdev-current"\r\nif not defined _ADHDEV_VERSION exit /b 1\r\ncall "%~dp0..\\npm-installs\\%_ADHDEV_VERSION%\\adhdev.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n',
      encoding: 'ascii',
    },
    'adhdev.ps1': {
      content: "$versionName = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '.adhdev-current')).Trim()\r\n$adhdevPrefix = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'npm-installs') $versionName\r\n& (Join-Path $adhdevPrefix 'adhdev.ps1') @args\r\nexit $LASTEXITCODE\r\n",
      encoding: 'utf8',
    },
    adhdev: {
      content: '#!/bin/sh\nadhdev_version="$(cat "$(dirname "$0")/.adhdev-current")"\nadhdev_prefix="$(dirname "$(dirname "$0")")/npm-installs/$adhdev_version"\nexec "$adhdev_prefix/adhdev" "$@"\n',
      encoding: 'ascii',
    },
  };
}

type FileSnapshot = { exists: boolean; data?: Buffer };

function snapshotStableFiles(stablePrefix: string): Map<string, FileSnapshot> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const name of STABLE_FILES) {
    const target = path.join(stablePrefix, name);
    try {
      snapshots.set(target, { exists: true, data: fs.readFileSync(target) });
    } catch {
      snapshots.set(target, { exists: false });
    }
  }
  return snapshots;
}

function restoreStableFiles(snapshots: Map<string, FileSnapshot>): void {
  for (const [target, snapshot] of snapshots) {
    if (snapshot.exists && snapshot.data) atomicWrite(target, snapshot.data.toString('binary'), 'binary');
    else try { fs.unlinkSync(target); } catch { /* noop */ }
  }
}

function publishStableShimsAndPointer(layout: WindowsInstallerLayout, versionName: string): void {
  const shims = stableShimContents();
  for (const name of ['adhdev.cmd', 'adhdev.ps1', 'adhdev'] as const) {
    atomicWrite(path.join(layout.stablePrefix, name), shims[name].content, shims[name].encoding);
  }
  // Pointer last: until this rename, every stable launcher still reaches the old prefix.
  atomicWrite(layout.pointerPath, versionName, 'ascii');
}

export async function performWindowsAtomicUpgrade(options: WindowsAtomicUpgradeOptions): Promise<WindowsAtomicUpgradeResult> {
  const { layout, packageName, targetVersion, portableNode, hooks } = options;
  const versionName = `version-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const stagedPrefix = path.join(layout.installRoot, versionName);
  const snapshots = snapshotStableFiles(layout.stablePrefix);
  let activated = false;
  let restarted: ChildProcess | null = null;
  fs.mkdirSync(stagedPrefix, { recursive: false });
  try {
    hooks.log(`Installing ${packageName}@${targetVersion} into inactive prefix ${stagedPrefix}`);
    await hooks.install(stagedPrefix, portableNode);
    const stagedCliEntry = readPackageCliEntry(stagedPrefix, packageName, targetVersion);
    pinStagedShims(stagedPrefix, portableNode, stagedCliEntry);
    validateStagedCli(portableNode, stagedCliEntry, targetVersion);
    hooks.log(`Validated staged CLI and portable Node 22 shims in ${stagedPrefix}`);

    activated = true;
    publishStableShimsAndPointer(layout, versionName);
    hooks.log(`Atomically activated ${versionName}`);
    restarted = hooks.restart(portableNode, stagedCliEntry);
    const daemonPid = restarted.pid;
    if (!daemonPid || !(await hooks.waitForHealth(daemonPid, targetVersion))) {
      throw new Error('replacement daemon did not pass the health/version gate');
    }
    hooks.log(`Replacement daemon pid ${daemonPid} passed health for ${targetVersion}`);
    hooks.cleanup(layout, stagedPrefix);
    return { stagedPrefix, stagedCliEntry, daemonPid };
  } catch (error) {
    if (restarted?.pid) hooks.stopProcess(restarted.pid);
    if (activated) {
      try {
        restoreStableFiles(snapshots);
        hooks.log(`Rolled back activation to ${layout.activeVersionName}`);
      } catch (rollbackError: any) {
        hooks.log(`Stable-file rollback failed: ${rollbackError?.message || String(rollbackError)}`);
      }
    }
    try { hooks.restartOld(portableNode); } catch { hooks.log('Failed to restart the previous daemon during rollback'); }
    try { hooks.cleanup(layout, layout.activePrefix); } catch { /* failure path must preserve original error */ }
    throw error;
  }
}

export function createDefaultWindowsAtomicHooks(options: {
  packageName: string;
  targetVersion: string;
  npmCliPath: string;
  restartArgv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}): WindowsAtomicUpgradeHooks {
  return {
    install: (stagedPrefix, portableNode) => {
      const env: NodeJS.ProcessEnv = { ...options.env, ADHDEV_BOOTSTRAP: '1' };
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
      env[pathKey] = `${path.dirname(portableNode)};${env[pathKey] || ''}`;
      execFileSync(portableNode, [
        options.npmCliPath,
        'install', '-g', `${options.packageName}@${options.targetVersion}`, '--force', '--prefer-online', '--prefix', stagedPrefix,
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env,
      });
    },
    restart: (portableNode, stagedCliEntry) => {
      const restartArgv = options.restartArgv.map((arg, index) => index === 0 ? stagedCliEntry : arg);
      if (restartArgv.length === 0) throw new Error('replacement daemon restart arguments are missing');
      const child = spawn(portableNode, restartArgv, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
      });
      child.unref();
      return child;
    },
    restartOld: (portableNode) => {
      if (options.restartArgv.length === 0) return;
      const child = spawn(portableNode, options.restartArgv, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
      });
      child.unref();
    },
    waitForHealth: async (pid, targetVersion) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const result = await new Promise<{ ok: boolean; pid?: number; body?: string }>((resolve) => {
          const req = http.get(`http://127.0.0.1:${DEFAULT_HEALTH_PORT}/health`, { timeout: 1500 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              let responsePid: number | undefined;
              try { responsePid = Number(JSON.parse(body)?.pid); } catch { /* noop */ }
              resolve({ ok: res.statusCode === 200, pid: responsePid, body });
            });
          });
          req.on('timeout', () => req.destroy());
          req.on('error', () => resolve({ ok: false }));
        });
        if (result.ok && result.pid === pid && result.body?.includes(targetVersion)) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    },
    stopProcess: (pid) => {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
    },
    cleanup: (layout, activePrefix) => boundedCleanupInactivePrefixes(layout, activePrefix, options.log),
    log: options.log,
  };
}

export function boundedCleanupInactivePrefixes(
  layout: WindowsInstallerLayout,
  activePrefix: string,
  log: (message: string) => void,
): void {
  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(layout.installRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('version-'))
      .map((entry) => path.join(layout.installRoot, entry.name))
      .filter((entry) => normalizeForCompare(entry) !== normalizeForCompare(activePrefix))
      .sort()
      .slice(0, 8);
  } catch {
    return;
  }
  if (candidates.length === 0) return;
  const escaped = candidates.map((candidate) => quotePowerShellLiteral(candidate)).join(',');
  const script = `$ErrorActionPreference='Stop'; @(${escaped}) | ForEach-Object { if (Test-Path -LiteralPath $_) { Remove-Item -LiteralPath $_ -Recurse -Force } }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
  if (result.error || result.status !== 0) log('Bounded inactive-prefix cleanup was incomplete; future updates will retry');
}
