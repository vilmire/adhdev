import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { stopOwnedProcessesForPrefixes } from './process-lifecycle.js';

const POINTER_NAME = '.adhdev-current';
const STABLE_FILES = [POINTER_NAME, 'adhdev.cmd', 'adhdev.ps1', 'adhdev'] as const;
const DEFAULT_HEALTH_PORT = 19222;

// How long to wait for the replacement daemon to report the target version
// before deterministically rolling back. status.version only appears AFTER the
// daemon fully boots its components — a separate session-host process, node-pty/
// conpty, CDP, and providers — which on a Windows cold self-upgrade routinely
// exceeds the old 30s ceiling. Live Windows logs showed every rollback clustering
// at 33–35s (30s timeout + poll overhead), so the gate was tripping on slow-boot,
// not on genuine failure. 120s reflects real Windows self-upgrade cold-start time.
export const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;

function fetchLocalJson(port: number, pathname: string): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, body: '' }));
  });
}

// Liveness + pid identity: GET /health returns {ok, pid, wsPath, port}.
async function fetchLocalHealth(port: number): Promise<{ ok: boolean; pid?: number }> {
  const { ok, body } = await fetchLocalJson(port, '/health');
  if (!ok) return { ok: false };
  try {
    const pid = Number(JSON.parse(body)?.pid);
    return { ok: true, pid: Number.isFinite(pid) ? pid : undefined };
  } catch {
    return { ok: false };
  }
}

// Running version: GET /api/v1/status exposes it at payload.status.version.
// /health carries no version, so the upgrade version gate must read this.
async function fetchLocalStatusVersion(port: number): Promise<string | undefined> {
  const { ok, body } = await fetchLocalJson(port, '/api/v1/status');
  if (!ok) return undefined;
  try {
    const version = (JSON.parse(body) as { status?: { version?: unknown } })?.status?.version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

// Markers that identify a Node process as ADHDev-owned when its command line
// also lives under a versioned install prefix. This deliberately excludes
// arbitrary user scripts that happen to be located under ~/.adhdev.
export const ADHDEV_OWNED_MARKERS = [
    'session-host-daemon',
    'node_modules/adhdev',
    'node_modules/@adhdev/daemon-standalone',
] as const;

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
  cleanup: (layout: WindowsInstallerLayout, activePrefix: string) => void | Promise<void>;
  log: (message: string) => void;
}

export interface WindowsAtomicUpgradeOptions {
  layout: WindowsInstallerLayout;
  packageName: string;
  targetVersion: string;
  portableNode: string;
  hooks: WindowsAtomicUpgradeHooks;
  /** PIDs that must never be terminated during prefix sweeps (helper + parent daemon). */
  excludePids?: number[];
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

// node-pty ships a Windows x64 prebuild. If npm rebuilds from source (because a
// .npmrc sets build-from-source=true), the install script deletes the prebuild
// and may leave no conpty.node on machines without build tools. Verify it
// survived before we ever activate the staged prefix.
const CONPTY_PREBUILD_RELATIVE_PATH = path.join(
  'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'
);

function resolveStagedConptyPrebuildPath(stagedPrefix: string): string {
  return path.join(stagedPrefix, CONPTY_PREBUILD_RELATIVE_PATH);
}

function verifyStagedConptyPrebuild(stagedPrefix: string): void {
  const conptyPath = resolveStagedConptyPrebuildPath(stagedPrefix);
  if (!fs.existsSync(conptyPath)) {
    throw new Error(
      `Staged install is missing required native addon: ${conptyPath}. ` +
      'Aborting activation to prevent a daemon boot crash.'
    );
  }
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
  // The no-extension `adhdev` shim is what `where.exe adhdev` can resolve first
  // and what git-bash / MSYS / WSL and `spawnSync('adhdev')` invoke. npm generates
  // it as a POSIX `sh` shim whose ELSE branch falls back to the FIRST `node` on
  // PATH (`else exec node ...`). On a box where system PATH node is v24, that
  // fallback trips adhdev's own Node-24 guard and `adhdev doctor` reports the
  // runtime surface broken. Rewrite it too so it hard-codes the portable Node 22
  // absolute path with NO system-node fallback — mirroring the .cmd/.ps1 pins.
  const noExtPath = path.join(prefix, 'adhdev');
  const cmd = `@echo off\r\n"${portableNode}" "${cliEntry}" %*\r\n`;
  const ps1 = `#!/usr/bin/env pwsh\r\n& ${quotePowerShellLiteral(portableNode)} ${quotePowerShellLiteral(cliEntry)} @args\r\nexit $LASTEXITCODE\r\n`;
  // sh shim: single unconditional exec of the pinned node — no `if -x node` /
  // `else exec node` branch, so PATH ordering can never shadow the runtime.
  const noExt = `#!/bin/sh\nexec "${portableNode}" "${cliEntry}" "$@"\n`;
  fs.writeFileSync(cmdPath, cmd, 'ascii');
  fs.writeFileSync(ps1Path, ps1, 'utf8');
  fs.writeFileSync(noExtPath, noExt, 'ascii');
  const cmdReadback = fs.readFileSync(cmdPath, 'utf8');
  const ps1Readback = fs.readFileSync(ps1Path, 'utf8');
  const noExtReadback = fs.readFileSync(noExtPath, 'utf8');
  if (
    !cmdReadback.includes(portableNode)
    || !ps1Readback.includes(portableNode)
    || !noExtReadback.includes(portableNode)
    || /(^|\s)exec\s+node(\s|$)/m.test(noExtReadback)
  ) {
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

// Rollback must never leave PATH `adhdev` broken. Two failure modes made the old
// "restore-or-delete" logic dangerous:
//   1. If a stable shim (adhdev.cmd/.ps1/no-ext) did not exist at snapshot time —
//      a first/partial install, or a stable tree that never had the launcher —
//      deleting it leaves `where.exe adhdev` / `spawnSync('adhdev')` resolving to
//      nothing (ENOENT). `adhdev doctor` then reports the runtime surface broken.
//   2. If the pointer (.adhdev-current) was absent at snapshot time, deleting it
//      strands the re-published shims with no version to redirect to.
// So rollback (re)guarantees a valid launcher surface: existing snapshots restore
// their original bytes atomically; missing shims are re-issued from the canonical
// pointer-redirect launcher contents; and the pointer, when it has no snapshot,
// is re-written to the last-known-good active version instead of removed.
function restoreStableFiles(snapshots: Map<string, FileSnapshot>, layout: WindowsInstallerLayout): void {
  const shims = stableShimContents();
  for (const [target, snapshot] of snapshots) {
    if (snapshot.exists && snapshot.data) {
      atomicWrite(target, snapshot.data.toString('binary'), 'binary');
      continue;
    }
    const name = path.basename(target);
    if (name === 'adhdev.cmd' || name === 'adhdev.ps1' || name === 'adhdev') {
      // Re-issue a valid pointer-redirect launcher rather than deleting it, so
      // PATH `adhdev` always resolves after a rollback.
      atomicWrite(target, shims[name].content, shims[name].encoding);
    } else if (name === POINTER_NAME) {
      // Preserve the last-successful (currently active) version so the redirect
      // launchers still reach a real prefix. Only fall back to deleting when we
      // have no active version to point at.
      if (layout.activeVersionName) atomicWrite(target, layout.activeVersionName, 'ascii');
      else try { fs.unlinkSync(target); } catch { /* noop */ }
    } else {
      try { fs.unlinkSync(target); } catch { /* noop */ }
    }
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
    verifyStagedConptyPrebuild(stagedPrefix);
    const stagedCliEntry = readPackageCliEntry(stagedPrefix, packageName, targetVersion);
    pinStagedShims(stagedPrefix, portableNode, stagedCliEntry);
    validateStagedCli(portableNode, stagedCliEntry, targetVersion);
    hooks.log(`Validated staged CLI and portable Node 22 shims in ${stagedPrefix}`);

    // Stop every ADHDev-owned process still executing from the current active
    // prefix or the legacy stable shim tree before moving the pointer. A stale
    // session-host left running here keeps node-pty's native addon mapped from
    // the old tree and resolves lazy requires against a deleted prefix after
    // activation. Survivors block activation so the pointer is never corrupted.
    const excludedPids = new Set([process.pid, ...(options.excludePids ?? [])].filter((n) => Number.isFinite(n) && n > 0));
    const preStop = await stopOwnedProcessesForPrefixes({
      prefixes: [layout.activePrefix, layout.stablePrefix],
      excludePids: Array.from(excludedPids),
      markers: Array.from(ADHDEV_OWNED_MARKERS),
      waitMs: 15_000,
      log: hooks.log,
    });
    if (preStop.survivors.length > 0) {
      throw new Error(
        `Cannot activate ${versionName}: ${preStop.survivors.length} owned process(es) still running under the current prefix`
      );
    }

    activated = true;
    publishStableShimsAndPointer(layout, versionName);
    hooks.log(`Atomically activated ${versionName}`);
    restarted = hooks.restart(portableNode, stagedCliEntry);
    const daemonPid = restarted.pid;
    if (!daemonPid || !(await hooks.waitForHealth(daemonPid, targetVersion))) {
      throw new Error('replacement daemon did not pass the health/version gate');
    }
    hooks.log(`Replacement daemon pid ${daemonPid} passed health for ${targetVersion}`);
    await hooks.cleanup(layout, stagedPrefix);
    return { stagedPrefix, stagedCliEntry, daemonPid };
  } catch (error) {
    if (restarted?.pid) hooks.stopProcess(restarted.pid);
    if (activated) {
      try {
        restoreStableFiles(snapshots, layout);
        hooks.log(`Rolled back activation to ${layout.activeVersionName}`);
      } catch (rollbackError: any) {
        hooks.log(`Stable-file rollback failed: ${rollbackError?.message || String(rollbackError)}`);
      }
    }
    try { hooks.restartOld(portableNode); } catch { hooks.log('Failed to restart the previous daemon during rollback'); }
    try { await hooks.cleanup(layout, layout.activePrefix); } catch { /* failure path must preserve original error */ }
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
  /** Loopback IPC port to probe for health/version. Defaults to the daemon's local IPC port. */
  healthPort?: number;
  /** How long to poll for the replacement daemon to report the target version. */
  healthTimeoutMs?: number;
}): WindowsAtomicUpgradeHooks {
  const healthPort = options.healthPort ?? DEFAULT_HEALTH_PORT;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  return {
    install: (stagedPrefix, portableNode) => {
      const env: NodeJS.ProcessEnv = {
        ...options.env,
        ADHDEV_BOOTSTRAP: '1',
        npm_config_build_from_source: 'false',
        'npm_config_build-from-source': 'false',
      };
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
      env[pathKey] = `${path.dirname(portableNode)};${env[pathKey] || ''}`;
      const installOutput = String(execFileSync(portableNode, [
        options.npmCliPath,
        'install', '-g', `${options.packageName}@${options.targetVersion}`, '--force', '--prefer-online', '--prefix', stagedPrefix,
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env,
      }));
      // On failure execFileSync throws with stdout attached to the Error; on
      // success it was previously discarded. Surface the npm output either way so
      // a silently-succeeding-then-rolled-back upgrade leaves a diagnosable trail.
      if (installOutput.trim()) options.log(installOutput.trim());
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
      const startedAt = Date.now();
      const deadline = startedAt + healthTimeoutMs;
      let attempt = 0;
      // Log the transition milestones exactly once so the daemon log shows how far
      // the replacement got before the gate resolved: not-yet-alive → alive but
      // version-not-yet-ready (components still booting) → version matched. This is
      // what pins down which boot stage the full-boot budget is being spent in.
      let loggedAlive = false;
      let loggedVersionPending = false;
      while (Date.now() < deadline) {
        attempt += 1;
        // Liveness + pid identity come from GET /health, whose body is
        // {ok, pid, wsPath, port} — it carries NO version. The running version
        // lives only in GET /api/v1/status → payload.status.version, so the
        // version gate must fetch that endpoint separately. Requiring the raw
        // /health body to include targetVersion is unsatisfiable and silently
        // rolls every upgrade back.
        const liveness = await fetchLocalHealth(healthPort);
        const alive = liveness.ok && liveness.pid === pid;
        const version = alive ? await fetchLocalStatusVersion(healthPort) : undefined;
        const elapsedMs = Date.now() - startedAt;
        if (alive && version === targetVersion) {
          options.log(`Health gate passed after ${elapsedMs}ms (${attempt} probe(s)): pid ${pid} reports ${targetVersion}`);
          return true;
        }
        if (alive && !loggedAlive) {
          loggedAlive = true;
          options.log(`Health gate: replacement pid ${pid} is alive at ${elapsedMs}ms; awaiting status.version (components still booting)`);
        }
        if (alive && version && version !== targetVersion && !loggedVersionPending) {
          loggedVersionPending = true;
          options.log(`Health gate: replacement reports version ${version} (want ${targetVersion}) at ${elapsedMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      options.log(`Health gate timed out after ${Date.now() - startedAt}ms (${attempt} probe(s), budget ${healthTimeoutMs}ms) waiting for pid ${pid} to report ${targetVersion}`);
      return false;
    },
    stopProcess: (pid) => {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
    },
    cleanup: async (layout, activePrefix) => cleanupInactivePrefixesWithGuard({
      layout,
      activePrefix,
      excludePids: [process.pid],
      markers: Array.from(ADHDEV_OWNED_MARKERS),
      waitMs: 15_000,
      log: options.log,
    }),
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
  // Delete in-process (see removeInactivePrefix) rather than via a powershell.exe
  // Remove-Item batch under a 5000ms spawnSync timeout, which ETIMEDOUT'd on
  // Windows and left orphan version-* prefixes behind. best-effort: a failure
  // here never blocks the upgrade success/failure signal.
  let incomplete = false;
  for (const candidate of candidates) {
    try {
      fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      incomplete = true;
    }
  }
  if (incomplete) log('Bounded inactive-prefix cleanup was incomplete; future updates will retry');
}

export async function cleanupInactivePrefixesWithGuard(options: {
  layout: WindowsInstallerLayout;
  activePrefix: string;
  excludePids?: number[];
  markers?: readonly string[];
  waitMs?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const { layout, activePrefix, log } = options;
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

  for (const candidate of candidates) {
    const stopResult = await stopOwnedProcessesForPrefixes({
      prefixes: [candidate],
      excludePids: options.excludePids,
      markers: options.markers,
      waitMs: options.waitMs ?? 15_000,
      log,
    });
    if (stopResult.survivors.length > 0) {
      log?.(`Skipping cleanup of ${candidate}: ${stopResult.survivors.length} owned process(es) could not be stopped`);
      continue;
    }
    removeInactivePrefix(candidate, log);
  }
}

function removeInactivePrefix(target: string, log?: (message: string) => void): void {
  // Delete in-process with fs.rmSync instead of shelling out to powershell.exe.
  // A version prefix holds thousands of small files (node_modules, node-pty
  // prebuilds); Remove-Item -Recurse -Force over that, plus PowerShell 5.1's
  // cold-start, routinely blew past the old 5000ms spawnSync timeout on Windows
  // — every candidate then failed with ETIMEDOUT and orphan version-* dirs
  // accumulated. fs.rmSync has no process spawn, no timeout, and retries the
  // transient EBUSY/EPERM/ENOTEMPTY that a just-stopped process can leave behind.
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error: any) {
    log?.(`Failed to remove inactive prefix ${target}: ${error?.message || String(error)}`);
  }
}
