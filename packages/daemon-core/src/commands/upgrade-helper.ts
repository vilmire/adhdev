import { execFileSync } from 'child_process';
import { spawn, type ChildProcess } from 'child_process';
import { hiddenExecFileSync } from '../process/hidden-spawn.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ADHDEV_OWNED_MARKERS,
  createDefaultWindowsAtomicHooks,
  findPortableNode22,
  performWindowsAtomicUpgrade,
  probeLocalDaemonHealth,
  resolveWindowsInstallerLayout,
  verifyStagedConptyPrebuild,
} from './windows-atomic-upgrade.js';
import { stopOwnedProcessesForPrefixes, waitForPidExit } from './process-lifecycle.js';
import { canonicalizeInstancePath } from '@adhdev/session-host-core';
import { resolveSessionHostAppName } from '../session-host/app-name.js';
import { getConfigDir } from '../config/config.js';
import { openCaptureLogFd } from '../logging/logger.js';
import { IDENTITY } from '../track-identity.js';
import {
  clearPosixUpgradeJournal,
  describePosixHealthGateSkip,
  gatePosixUpgradeRestart,
  inspectPosixUpgradeJournal,
  resolvePosixHealthGatePort,
  writePosixUpgradeJournal,
  type PosixUpgradeGateHooks,
  type PosixUpgradeJournal,
  type SpawnedDaemonHandle,
} from './posix-upgrade-health-gate.js';
import { buildPinnedGlobalInstallCommand, buildInstallEnvWithNodeOnPath, execNpmCommandSync, type CurrentGlobalInstallSurface, type PinnedGlobalInstallCommand } from './upgrade-install-surface.js';
import { stopSessionHostProcesses, listForeignNativeAddonHolders, stopForeignNativeAddonHolders } from './upgrade-process-stop.js';
import { buildManualRecoveryCommand, emitUpgradeFailureNotice, clearUpgradeFailureNotice } from './upgrade-failure-notice.js';
import { resolveInstanceDir, getUpgradeLogPath, appendUpgradeLog } from './upgrade-log.js';

const UPGRADE_HELPER_ENV = 'ADHDEV_DAEMON_UPGRADE_HELPER';

export interface DaemonUpgradeHelperPayload {
  packageName: string;
  targetVersion: string;
  parentPid: number;
  restartArgv: string[];
  cwd?: string;
  sessionHostAppName?: string;
  /**
   * Instance identity handoff: the calling daemon's config dir. The detached
   * helper pins it into the child env (ADHDEV_CONFIG_DIR) so the helper's own
   * log/pid/notice paths and the re-spawned daemon stay inside the CALLER's
   * instance — an upgrade/restart must never write preview state into the
   * stable directory (or vice-versa), even when the caller resolved its
   * instance implicitly. Absent → the current process's getConfigDir().
   */
  configDir?: string;
  /**
   * Restart-only mode: wait for the parent daemon to exit, then re-spawn it
   * without running any npm install. Used by daemon_restart (mesh
   * restart_daemon_node mode="restart") to reset daemon state (memory leaks,
   * zombie sessions, wedged internals) with minimal downtime.
   */
  skipInstall?: boolean;
  /**
   * Opt-in hard refresh: also stop the session-host process, which destroys
   * EVERY hosted CLI session (no idle-gate — see SessionHostServer.stop).
   * Mirrors what Windows already does unconditionally on upgrade (conpty.node
   * lock). Default off: POSIX leaves the host running so sessions rebind.
   */
  killSessionHost?: boolean;
  /**
   * POSIX boot health gate budget (ms) for the replacement daemon to report
   * the target version, and for a rolled-back daemon to report the previous
   * one. Defaults to DEFAULT_HEALTH_TIMEOUT_MS (the Windows gate's budget).
   */
  healthTimeoutMs?: number;
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

function removeDaemonPidFile(configDir: string = getConfigDir()): void {
  const pidFile = path.join(configDir, 'daemon.pid');
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

// Bin shims a package publishes under <prefix>/bin. Mirrors the binNames set in
// cleanupStaleGlobalInstallDirs so the smoke gate and the backup cover exactly
// the entry points the cleanup already knows about.
function resolvePosixBinNames(packageName: string): string[] {
  const base = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
  const names = [base];
  if (packageName === '@adhdev/daemon-standalone') {
    names.push('adhdev-standalone');
  }
  return names;
}

/**
 * Run `--version` on every installed bin shim under <prefix>/bin.
 *
 * A zero-exit `npm install` is NOT proof of a runnable install: the 2026-08-26
 * rc.17 package installed cleanly but its CLI died instantly on `--version`.
 * win32 survived because the installer-managed atomic path gates a staged
 * prefix before flipping the pointer; POSIX installed in place with no gate,
 * bricking both the CLI and the re-spawned daemon. This is the POSIX half of
 * that gate. Throws on the first shim that is missing or exits non-zero.
 */
function smokeTestInstalledBins(prefix: string, packageName: string): void {
  const binDir = path.join(prefix, 'bin');
  const names = resolvePosixBinNames(packageName);
  const baseShim = path.join(binDir, names[0]);
  if (!fs.existsSync(baseShim)) {
    throw new Error(`installed CLI shim is missing: ${baseShim}`);
  }
  for (const name of names) {
    const shimPath = path.join(binDir, name);
    if (!fs.existsSync(shimPath)) continue;
    execFileSync(shimPath, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
      env: buildInstallEnvWithNodeOnPath(),
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
  }
  assertNativeAddonsLoad(prefix, packageName);
}

/**
 * `--version` never touches the native addons, so a package whose addons were
 * built for another Node ABI passes it and then the daemon dies at boot
 * (2026-10-01: better-sqlite3 for Node 22 under a Node 26 daemon). Load every
 * compiled addon of the installed package with the node the daemon runs on.
 */
function assertNativeAddonsLoad(prefix: string, packageName: string): void {
  const packageRoot = [path.join(prefix, 'lib', 'node_modules', packageName), path.join(prefix, 'node_modules', packageName)]
    .find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!packageRoot) return;
  const script = [
    "const fs=require('fs'),path=require('path');",
    'const root=path.join(process.argv[1],"node_modules");',
    'const pkgs=[];',
    'for(const n of fs.existsSync(root)?fs.readdirSync(root):[]){',
    ' if(n.startsWith("@")){for(const m of fs.readdirSync(path.join(root,n)))pkgs.push(path.join(root,n,m));}else pkgs.push(path.join(root,n));}',
    'for(const p of pkgs){const d=path.join(p,"build","Release");',
    ' if(!fs.existsSync(d))continue;',
    ' for(const f of fs.readdirSync(d))if(f.endsWith(".node"))process.dlopen({exports:{}},path.join(d,f));}',
  ].join('');
  try {
    execFileSync(process.execPath, ['-e', script, packageRoot], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
    throw new Error(`a native module does not load under ${process.execPath}: ${detail}`);
  }
}

interface PosixInstallBackup {
  backupDir: string;
  packageRoot: string;
  binShims: string[];
}

/**
 * Snapshot the current package tree and its bin shims so a failed in-place
 * install can be rolled back. npm's in-place `--force` install deletes the old
 * tree before writing the new one, so without a snapshot a mid-install failure
 * (or a package that installs but cannot run) leaves NO working CLI at all —
 * the rc.17 POSIX bricking. Returns null when the live package root could not
 * be identified (nothing to safely snapshot).
 */
function backupPosixInstall(options: {
  packageRoot: string;
  installPrefix: string;
  packageName: string;
  configDir: string;
}): PosixInstallBackup | null {
  try {
    fs.mkdirSync(options.configDir, { recursive: true });
    const backupDir = fs.mkdtempSync(path.join(options.configDir, 'upgrade-backup-'));
    fs.cpSync(options.packageRoot, path.join(backupDir, 'package'), { recursive: true });
    const binShims: string[] = [];
    const binDir = path.join(options.installPrefix, 'bin');
    for (const name of resolvePosixBinNames(options.packageName)) {
      const shim = path.join(binDir, name);
      if (fs.existsSync(shim)) {
        // npm's shims are usually relative symlinks; keep the link text as-is.
        fs.cpSync(shim, path.join(backupDir, `bin-${name}`), { recursive: true, verbatimSymlinks: true });
        binShims.push(shim);
      }
    }
    return { backupDir, packageRoot: options.packageRoot, binShims };
  } catch (error: any) {
    appendUpgradeLog(`Install backup failed (${error?.code || 'error'}): ${error?.message || String(error)} — proceeding without a rollback snapshot`, options.configDir);
    return null;
  }
}

/**
 * Keep the node the previous install pinned its CLI to. Homebrew rewrites the
 * bin entries to `#!/opt/homebrew/opt/node/bin/node`; npm's in-place install
 * writes `#!/usr/bin/env node` back, so the CLI would start following whatever
 * `node` is first on PATH (nvm's Node 22 on 2026-10-01) — a different ABI from
 * the one the native modules were just installed for.
 */
function preservePinnedShebangs(backup: PosixInstallBackup): void {
  for (const shim of backup.binShims) {
    try {
      const entry = fs.realpathSync(shim);
      const relative = path.relative(backup.packageRoot, entry);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const previousFirstLine = fs.readFileSync(path.join(backup.backupDir, 'package', relative), 'utf8').split('\n', 1)[0];
      if (!/^#!\/\S*node$/.test(previousFirstLine)) continue;
      const current = fs.readFileSync(entry, 'utf8');
      const currentFirstLine = current.split('\n', 1)[0];
      if (!currentFirstLine.startsWith('#!') || currentFirstLine === previousFirstLine) continue;
      fs.writeFileSync(entry, previousFirstLine + current.slice(currentFirstLine.length));
      appendUpgradeLog(`Kept the pinned interpreter ${previousFirstLine.slice(2)} for ${path.basename(shim)}`);
    } catch {
      // A shim we cannot read keeps npm's shebang — the smoke gate still runs it.
    }
  }
}

/** Restore a backupPosixInstall snapshot over the live prefix. Throws on failure. */
function restorePosixInstall(backup: PosixInstallBackup): void {
  // Verify the snapshot BEFORE deleting the live tree: removing the live
  // package and then failing to copy a missing snapshot would turn a
  // recoverable state into no install at all.
  const snapshotPackage = path.join(backup.backupDir, 'package');
  if (!fs.existsSync(path.join(snapshotPackage, 'package.json'))) {
    throw new Error(`rollback snapshot is missing or incomplete: ${snapshotPackage}`);
  }
  fs.rmSync(backup.packageRoot, { recursive: true, force: true });
  fs.cpSync(snapshotPackage, backup.packageRoot, { recursive: true });
  for (const shim of backup.binShims) {
    const saved = path.join(backup.backupDir, `bin-${path.basename(shim)}`);
    // Copying a symlink onto the live symlink that points at the same file
    // fails with ERR_FS_CP_EINVAL (2026-10-01, Homebrew prefix), so recreate it.
    fs.rmSync(shim, { force: true });
    if (fs.lstatSync(saved).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(saved), shim);
    else fs.cpSync(saved, shim, { recursive: true });
  }
}

/**
 * Error thrown after the helper already wrote a specific, actionable failure
 * notice. The top-level catch must not overwrite that notice with its generic
 * "upgrade failed: <message>" wrapper (which also drops the target marker).
 */
class UpgradeNoticeEmittedError extends Error {
  readonly upgradeNoticeEmitted = true;
}

function readInstalledPackageVersion(packageRoot: string | null): string | null {
  if (!packageRoot) return null;
  try {
    const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/** The pinned install command re-targeted at another version (same npm, same --prefix). */
function retargetInstallCommand(
  installCommand: PinnedGlobalInstallCommand,
  packageName: string,
  fromVersion: string,
  toVersion: string,
): PinnedGlobalInstallCommand {
  const fromSpec = `${packageName}@${fromVersion || 'latest'}`;
  return {
    ...installCommand,
    args: installCommand.args.map((arg) => (arg === fromSpec ? `${packageName}@${toVersion}` : arg)),
  };
}

/** Graceful stop, then forced — POSIX only (this path never runs on win32). */
async function stopPosixPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error: any) {
    return error?.code === 'ESRCH';
  }
  if (await waitForPidExit(pid, 10_000)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // noop — it may have exited between the checks
  }
  return waitForPidExit(pid, 3_000);
}

/**
 * The real hooks behind the POSIX boot health gate: spawn via the same
 * detached restart the helper always used, probe the same /health +
 * /api/v1/status endpoints the Windows gate polls, restore from the pre-install
 * snapshot, and fall back to reinstalling the exact previous version into the
 * same prefix when the snapshot is unusable.
 */
function buildPosixGateHooks(options: {
  payload: DaemonUpgradeHelperPayload;
  installCommand: PinnedGlobalInstallCommand;
  backup: PosixInstallBackup | null;
  previousVersion: string | null;
  configDir: string;
}): PosixUpgradeGateHooks {
  const { payload, installCommand, backup, previousVersion, configDir } = options;
  const log = (message: string) => appendUpgradeLog(message, configDir);
  return {
    spawnDaemon: (argv): SpawnedDaemonHandle | null => {
      const child = spawnDetachedDaemonRestart(argv, payload.cwd);
      if (!child) return null;
      let exit: { code: number | null; signal: string | null } | null = null;
      // Record an exit so a crash during boot fails the gate immediately
      // instead of after the full budget. The 'error' listener also keeps an
      // async spawn failure (ENOENT) from crashing the helper mid-gate.
      if (typeof child.on === 'function') {
        child.on('exit', (code, signal) => { exit = { code, signal }; });
        child.on('error', (error) => {
          log(`Daemon spawn error: ${error?.message || String(error)}`);
          exit = { code: null, signal: null };
        });
      }
      return { pid: child.pid ?? null, exitStatus: () => exit };
    },
    probe: async (port) => {
      try {
        return await probeLocalDaemonHealth(port);
      } catch {
        return { alive: false, pid: null, version: null };
      }
    },
    stopPid: stopPosixPid,
    restorePrevious: () => {
      if (backup) {
        try {
          restorePosixInstall(backup);
          return 'snapshot';
        } catch (error: any) {
          log(`Snapshot restore failed (${error?.code || 'error'}): ${error?.message || String(error)} — falling back to reinstalling the previous version`);
        }
      }
      if (!previousVersion || !installCommand.surface.installPrefix) {
        throw new Error(backup
          ? 'snapshot restore failed and the previous version/prefix is unknown, so it cannot be reinstalled'
          : 'no snapshot was taken and the previous version/prefix is unknown');
      }
      const reinstall = retargetInstallCommand(installCommand, payload.packageName, payload.targetVersion, previousVersion);
      log(`Reinstalling previous version: ${buildManualRecoveryCommand(reinstall)}`);
      hiddenExecFileSync(reinstall.command, reinstall.args, {
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        env: buildInstallEnvWithNodeOnPath(),
        ...reinstall.execOptions,
      });
      return 'reinstall';
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log,
  };
}

/**
 * POSIX in-place upgrade with the protections the rc.17 and rc.62 incidents
 * proved necessary ("실패해도 데몬은 살고 CLI는 동작한다"):
 *
 *   1. PRE-FLIGHT GATE — install the target into a throwaway prefix and
 *      smoke-run `<bin> --version` BEFORE the old install is touched. A
 *      failure here aborts the upgrade with the existing install byte-intact.
 *   2. BACKUP + ROLLBACK — snapshot the live package root + bin shims; if the
 *      in-place install throws or the freshly-installed CLI fails the same
 *      smoke test, restore the snapshot.
 *   3. BOOT HEALTH GATE (rc.62) — restart the daemon from the new install and
 *      require it to answer its loopback IPC port with status.version == target
 *      within a bounded budget. A crash on boot, no health or a wrong version
 *      stops what was started, restores the previous install (snapshot, else a
 *      pinned reinstall of the exact previous version into the same prefix),
 *      restarts it and verifies that comes back healthy. See
 *      posix-upgrade-health-gate.ts. The snapshot is kept until this passes.
 *
 * On EVERY failure path the daemon is re-spawned from the (untouched or
 * restored) previous install before the error propagates: the parent daemon
 * has already exited by the time this helper runs, so failing to re-spawn is
 * what turned a bad package into a dead daemon requiring manual npm surgery.
 *
 * A journal (daemon-upgrade-journal.json) tracks the phase so a concurrent
 * helper stands down and an interrupted one leaves a trail; SIGTERM/SIGINT/
 * SIGHUP while the live install is unverified trigger a synchronous restore +
 * restart before exiting.
 *
 * POSIX-only by construction — the caller dispatches here only when
 * process.platform !== 'win32'. The win32 fallback keeps its existing
 * conpty-gated flow untouched.
 */
async function runPosixInPlaceUpgrade(options: {
  payload: DaemonUpgradeHelperPayload;
  installCommand: PinnedGlobalInstallCommand;
  restartArgv: string[];
}): Promise<void> {
  const { payload, installCommand, restartArgv } = options;
  const configDir = getConfigDir();
  const spec = `${payload.packageName}@${payload.targetVersion || 'latest'}`;
  const { packageRoot, installPrefix } = installCommand.surface;
  const previousVersion = readInstalledPackageVersion(packageRoot);

  // Step -1: journal. A live helper that already owns it will gate and
  // restart the daemon itself — stand down rather than install underneath it.
  const journalState = inspectPosixUpgradeJournal(configDir);
  if (journalState.state === 'busy') {
    appendUpgradeLog(
      `Another upgrade helper (pid ${journalState.journal.helperPid}) is mid-upgrade to `
      + `${journalState.journal.targetVersion} (phase ${journalState.journal.phase}); this helper stands down and leaves the restart to it`,
    );
    return;
  }
  if (journalState.state === 'stale') {
    const stale = journalState.journal;
    appendUpgradeLog(
      `Previous upgrade helper (pid ${stale.helperPid}) was interrupted during "${stale.phase}" while upgrading `
      + `${stale.previousVersion ?? '?'} → ${stale.targetVersion}`
      + (stale.backupDir ? `; its pre-install snapshot is retained at ${stale.backupDir}` : ''),
    );
  }
  const journal: PosixUpgradeJournal = {
    helperPid: process.pid,
    packageName: payload.packageName,
    targetVersion: payload.targetVersion,
    previousVersion,
    installPrefix,
    packageRoot,
    backupDir: null,
    restartArgv,
    phase: 'preflight',
    spawnedPid: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const advanceJournal = (patch: Partial<PosixUpgradeJournal>): void => {
    Object.assign(journal, patch);
    writePosixUpgradeJournal(configDir, journal);
  };
  advanceJournal({});

  let backup: PosixInstallBackup | null = null;
  // Synchronous emergency rollback for a signal delivered while the live
  // install is unverified. Conservative by design: if the replacement was in
  // fact healthy, this undoes a good upgrade — recoverable by retrying,
  // whereas an unverified install left behind by a killed helper is exactly
  // the rc.62 dead-machine state.
  const onSignal = (signal: NodeJS.Signals): void => {
    appendUpgradeLog(`Upgrade helper received ${signal} during "${journal.phase}" — restoring the previous install before exiting`);
    if (journal.spawnedPid && journal.spawnedPid !== process.pid) {
      try { process.kill(journal.spawnedPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    let restored = false;
    if (backup) {
      try {
        restorePosixInstall(backup);
        restored = true;
      } catch (error: any) {
        appendUpgradeLog(`Emergency restore failed: ${error?.message || String(error)} — snapshot retained at ${backup.backupDir}`);
      }
    }
    try { spawnDetachedDaemonRestart(restartArgv, payload.cwd); } catch { /* best effort */ }
    emitUpgradeFailureNotice([
      `adhdev ${spec} upgrade was interrupted (${signal}) during "${journal.phase}".`,
      restored
        ? `The previous version${previousVersion ? ` (${previousVersion})` : ''} was restored and the daemon restarted on it.`
        : `The previous install could not be restored${backup ? `; a snapshot is at ${backup.backupDir}` : ''}. Reinstall manually if the daemon does not come back:`,
      ...(restored ? [] : [`  ${buildManualRecoveryCommand(previousVersion ? retargetInstallCommand(installCommand, payload.packageName, payload.targetVersion, previousVersion) : installCommand)}`]),
    ], configDir, { targetVersion: payload.targetVersion });
    clearPosixUpgradeJournal(configDir);
    process.exit(1);
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  let signalsArmed = false;
  const armSignals = (): void => {
    if (signalsArmed) return;
    signalsArmed = true;
    for (const sig of signals) process.on(sig, onSignal);
  };

  try {
    // Step 0: sweep disposable scratch dirs from earlier attempts. Only the
    // pre-flight dirs are safe to remove unconditionally — a leftover backup dir
    // may be the user's last recovery copy after a failed rollback, so keep it.
    try {
      for (const entry of fs.readdirSync(configDir)) {
        if (entry.startsWith('upgrade-preflight-')) {
          safeRemoveStaleEntry(path.join(configDir, entry), 'Removed stale pre-flight staging prefix');
        }
      }
    } catch {
      // noop — housekeeping must never abort the upgrade
    }

    // Step 1: pre-flight gate. Install the target into a throwaway prefix and
    // prove the installed CLI actually runs before the live install is touched.
    const preflightPrefix = (() => {
      fs.mkdirSync(configDir, { recursive: true });
      return fs.mkdtempSync(path.join(configDir, 'upgrade-preflight-'));
    })();
    try {
      appendUpgradeLog(`Pre-flight: installing ${spec} into throwaway prefix ${preflightPrefix}`);
      execNpmCommandSync(
        ['install', '-g', spec, '--prefix', preflightPrefix],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          maxBuffer: 20 * 1024 * 1024,
          env: buildInstallEnvWithNodeOnPath(),
        },
        installCommand.surface,
      );
      smokeTestInstalledBins(preflightPrefix, payload.packageName);
      appendUpgradeLog(`Pre-flight smoke gate passed for ${spec}`);
    } catch (error: any) {
      const detail = error?.message || String(error);
      appendUpgradeLog(`Pre-flight smoke gate FAILED for ${spec}: ${detail} — existing install left untouched`);
      emitUpgradeFailureNotice([
        `adhdev ${spec} was NOT installed: the package installs but its CLI does not run (\`--version\` failed).`,
        `Detail: ${detail}`,
        'Your previous version is untouched and the daemon was restarted on it.',
        'This is a broken published package — retry once a fixed version is published.',
      ], configDir, { targetVersion: payload.targetVersion });
      spawnDetachedDaemonRestart(restartArgv, payload.cwd);
      throw new Error(`Pre-flight smoke gate failed for ${spec}: ${detail}`);
    } finally {
      safeRemoveStaleEntry(preflightPrefix, 'Removed pre-flight staging prefix');
    }

    // Step 2: snapshot the live install so a failed swap can be rolled back.
    backup = packageRoot && installPrefix
      ? backupPosixInstall({ packageRoot, installPrefix, packageName: payload.packageName, configDir })
      : null;
    if (backup) {
      appendUpgradeLog(`Backed up current install${previousVersion ? ` (${previousVersion})` : ''} to ${backup.backupDir}`);
    } else {
      appendUpgradeLog('No rollback snapshot available (package root unresolved or backup failed); relying on the pre-flight gate alone');
    }
    advanceJournal({ phase: 'installing', backupDir: backup?.backupDir ?? null });
    armSignals();

    const liveBackup = backup;
    const rollbackAndRestart = (cause: string): void => {
      if (liveBackup) {
        try {
          restorePosixInstall(liveBackup);
          appendUpgradeLog('Rollback restored the previous install');
          safeRemoveStaleEntry(liveBackup.backupDir, 'Removed upgrade backup after rollback');
        } catch (error: any) {
          appendUpgradeLog(`ROLLBACK FAILED (${error?.code || 'error'}): ${error?.message || String(error)} — snapshot retained at ${liveBackup.backupDir}`);
          emitUpgradeFailureNotice([
            `adhdev ${spec} install failed (${cause}) AND the automatic rollback failed.`,
            `A snapshot of the previous working install is preserved at: ${liveBackup.backupDir}`,
            'To recover manually, reinstall the previous version:',
            `  ${buildManualRecoveryCommand(installCommand)}`,
          ], configDir, { targetVersion: payload.targetVersion });
          spawnDetachedDaemonRestart(restartArgv, payload.cwd);
          throw new Error(`Install failed and rollback failed for ${spec}: ${cause}`);
        }
      }
      emitUpgradeFailureNotice([
        `adhdev ${spec} install failed (${cause}); the previous version was ${liveBackup ? 'restored' : 'left as-is (no snapshot available)'}.`,
        `The daemon was restarted on the previous version. See ${getUpgradeLogPath(configDir)} for the full trace.`,
        'To retry manually:',
        `  ${buildManualRecoveryCommand(installCommand)}`,
      ], configDir, { targetVersion: payload.targetVersion });
      spawnDetachedDaemonRestart(restartArgv, payload.cwd);
    };

    // Step 3: the in-place install itself. POSIX replaces open files freely and
    // the pre-flight gate already proved the package runnable, so no retries.
    let installOutput = '';
    try {
      installOutput = String(hiddenExecFileSync(
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
    } catch (error: any) {
      rollbackAndRestart(`npm install exited non-zero: ${error?.message || String(error)}`);
      throw error;
    }
    if (installOutput.trim()) {
      appendUpgradeLog(installOutput.trim());
    }
    if (liveBackup) preservePinnedShebangs(liveBackup);

    // Step 4: post-install smoke gate on the LIVE prefix. Catches a swap that
    // diverged from the pre-flight result (e.g. partial write with a zero exit).
    if (installPrefix) {
      try {
        smokeTestInstalledBins(installPrefix, payload.packageName);
      } catch (error: any) {
        rollbackAndRestart(`installed CLI failed its --version smoke test: ${error?.message || String(error)}`);
        throw error;
      }
    }

    // Step 5: boot health gate. `--version` only proves the CLI entry loads;
    // rc.62 passed it and then crashed on daemon boot fleet-wide.
    const skipReason = describePosixHealthGateSkip(payload.packageName, restartArgv);
    if (skipReason) {
      appendUpgradeLog(`Boot health gate skipped: ${skipReason}`);
      if (liveBackup) safeRemoveStaleEntry(liveBackup.backupDir, 'Removed upgrade backup after successful install');
      spawnDetachedDaemonRestart(restartArgv, payload.cwd);
      clearUpgradeFailureNotice();
      return;
    }

    const port = resolvePosixHealthGatePort({ restartArgv, instanceDir: resolveInstanceDir(configDir) });
    const result = await gatePosixUpgradeRestart({
      targetVersion: payload.targetVersion,
      previousVersion,
      restartArgv,
      port,
      healthTimeoutMs: payload.healthTimeoutMs,
      excludePids: [payload.parentPid].filter((n) => Number.isFinite(n) && n > 0),
      hooks: buildPosixGateHooks({ payload, installCommand, backup: liveBackup, previousVersion, configDir }),
      onPhase: (phase, spawnedPid) => advanceJournal({ phase, spawnedPid }),
    });

    if (result.outcome === 'healthy') {
      appendUpgradeLog(`Upgrade to ${spec} verified: daemon${result.pid ? ` pid ${result.pid}` : ''} healthy on ${payload.targetVersion} after ${result.elapsedMs}ms`);
      if (liveBackup) safeRemoveStaleEntry(liveBackup.backupDir, 'Removed upgrade backup after successful install');
      clearUpgradeFailureNotice();
      return;
    }

    const logPath = getUpgradeLogPath(configDir);
    const previousLabel = previousVersion ?? 'the previous version';
    const reinstallPrevious = previousVersion
      ? buildManualRecoveryCommand(retargetInstallCommand(installCommand, payload.packageName, payload.targetVersion, previousVersion))
      : null;
    if (result.outcome === 'rolled_back') {
      if (liveBackup) safeRemoveStaleEntry(liveBackup.backupDir, 'Removed upgrade backup after rollback');
      emitUpgradeFailureNotice([
        `adhdev ${spec} was ROLLED BACK to ${previousLabel}: the upgraded daemon failed its boot health gate — ${result.reason}.`,
        `The previous version was restored (${result.restoredVia}) and its daemon is running again${result.pid ? ` (pid ${result.pid})` : ''}.`,
        `See ${logPath} for the full install/health trace.`,
      ], configDir, { targetVersion: payload.targetVersion });
      throw new UpgradeNoticeEmittedError(
        `Upgrade to ${spec} rolled back to ${previousLabel}: boot health gate failed — ${result.reason}`,
      );
    }

    // rollback_failed — keep the snapshot; it may be the only good copy left.
    appendUpgradeLog(`ROLLBACK FAILED for ${spec}: ${result.rollbackError}`);
    emitUpgradeFailureNotice([
      `adhdev ${spec} failed its boot health gate (${result.reason}) AND the automatic rollback to ${previousLabel} failed: ${result.rollbackError}.`,
      result.daemonRunning
        ? `A daemon is still running${result.runningVersion ? ` on version ${result.runningVersion}` : ''}${result.pid ? ` (pid ${result.pid})` : ''}, but it is not the verified previous version.`
        : 'NO healthy daemon is running on this machine.',
      ...(liveBackup ? [`A snapshot of the previous install is preserved at: ${liveBackup.backupDir}`] : []),
      'To recover manually, reinstall the previous version and start the daemon:',
      `  ${reinstallPrevious ?? buildManualRecoveryCommand(installCommand)}`,
      `  ${IDENTITY.binaryName} daemon`,
      `See ${logPath} for the full install/health trace.`,
    ], configDir, { targetVersion: payload.targetVersion });
    throw new UpgradeNoticeEmittedError(
      `Upgrade to ${spec} failed its boot health gate and the rollback failed: ${result.rollbackError}`,
    );
  } finally {
    if (signalsArmed) {
      for (const sig of signals) process.removeListener(sig, onSignal);
    }
    clearPosixUpgradeJournal(configDir);
  }
}

export function spawnDetachedDaemonUpgradeHelper(payload: DaemonUpgradeHelperPayload): void {
  const env = buildUpgradeHelperChildEnv(payload);
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: payload.cwd || process.cwd(),
    env,
  });
  child.unref();
}

/**
 * Build the detached helper's environment. The helper payload is threaded
 * through ADHDEV_DAEMON_UPGRADE_HELPER and the instance identity is PINNED via
 * ADHDEV_CONFIG_DIR (payload.configDir, else the caller's own resolved config
 * dir). Pinning — rather than hoping the caller's env happens to carry the
 * override — guarantees the helper's log/pid/notice paths and the eventually
 * re-spawned daemon land in the caller's instance even when the caller itself
 * resolved the default instance implicitly.
 */
export function buildUpgradeHelperChildEnv(
  payload: DaemonUpgradeHelperPayload,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const configDir = payload.configDir || getConfigDir();
  return {
    ...baseEnv,
    ADHDEV_CONFIG_DIR: configDir,
    [UPGRADE_HELPER_ENV]: JSON.stringify({ ...payload, configDir }),
  };
}

async function runDaemonUpgradeHelper(payload: DaemonUpgradeHelperPayload): Promise<void> {
  const restartArgv = Array.isArray(payload.restartArgv) ? payload.restartArgv : [];
  // Falls back to THIS build's namespace, not a hardcoded 'adhdev'. This value
  // feeds stopSessionHostProcesses() below — a preview upgrade that lost
  // ADHDEV_SESSION_HOST_NAME would otherwise kill the STABLE install's session
  // host (and every session hosted in it).
  const sessionHostAppName = payload.sessionHostAppName || resolveSessionHostAppName();
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

  // The only reason to kill the session-host during an upgrade is the Windows
  // EBUSY hazard: node-pty's `conpty.node` (and the ghostty VT dll) stay
  // EXCLUSIVELY locked while the host has them memory-mapped, so npm's
  // copy-to-staging fails until the host exits (see stopSessionHostProcesses).
  // POSIX can replace an open file freely — the running host keeps its handles
  // to the old inode and keeps serving — so killing it there only tears down
  // every hosted CLI session (coordinator + workers) for no benefit. Leave the
  // host running on POSIX; on the next boot `ensureSessionHostReady()` reuses
  // the still-listening socket and `cliManager.restoreHostedSessions()` rebinds
  // the live runtimes. Windows keeps the kill unchanged.
  // killSessionHost is an explicit opt-in hard refresh (mesh restart_daemon_node
  // kill_session_host) that forces the same teardown on any platform.
  if (process.platform === 'win32' || payload.killSessionHost === true) {
    const hostStop = await stopSessionHostProcesses(sessionHostAppName);
    // Fail closed on a surviving host. Continuing would install a new prefix and
    // then delete the old one while a live session-host still resolves its lazy
    // `require`s (node-pty → conpty.node) against that tree — the exact state
    // that leaves every create_session failing after a "successful" upgrade.
    // Aborting keeps the working install intact and tells the user what to do.
    if (process.platform === 'win32' && hostStop.survived && hostStop.pid !== null) {
      const message =
        `Cannot upgrade: the session-host process (pid ${hostStop.pid}) is still running and could not be stopped. `
        + 'Upgrading now would delete the install it is running from and break every new session.';
      emitUpgradeFailureNotice([
        message,
        'To recover, stop it and retry the update:',
        `  Stop-Process -Id ${hostStop.pid} -Force`,
        `  ${IDENTITY.binaryName} update`,
      ], getConfigDir(), { targetVersion: payload.targetVersion });
      throw new Error(message);
    }
  } else {
    appendUpgradeLog('POSIX — session-host left running (survives upgrade; sessions rebind on next boot)');
  }
  removeDaemonPidFile();

  // Restart-only mode (daemon_restart): the parent has exited and the pid file
  // is gone — re-spawn the daemon as-is. No npm install, no prefix rotation, so
  // there is no Windows lock hazard and downtime is just the re-spawn.
  if (payload.skipInstall) {
    appendUpgradeLog('Restart-only mode — package install skipped, re-spawning daemon');
    spawnDetachedDaemonRestart(restartArgv, payload.cwd);
    clearUpgradeFailureNotice();
    return;
  }

  // Scope the Windows atomic-upgrade layout to THIS daemon's instance so
  // `adhdev-preview update` rotates only the preview prefix/pointer/tools tree
  // and never touches the stable install (and vice-versa). Stable / no-override
  // daemons resolve `.adhdev`, keeping the historical layout byte-identical.
  const instanceDir = resolveInstanceDir();
  const windowsInstallerLayout = resolveWindowsInstallerLayout({
    homeDir: os.homedir(),
    installPrefix: installCommand.surface.installPrefix,
    instanceDir,
  });
  if (windowsInstallerLayout) {
    const portableNode = findPortableNode22(os.homedir(), process.execPath, instanceDir);
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

    let atomicResult: Awaited<ReturnType<typeof performWindowsAtomicUpgrade>>;
    try {
      atomicResult = await performWindowsAtomicUpgrade({
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
      ], getConfigDir(), { targetVersion: payload.targetVersion });
      throw error;
    }
    clearUpgradeFailureNotice();
    if (atomicResult.daemonPid === null) {
      appendUpgradeLog(
        `Installer-managed Windows atomic upgrade completed (no daemon was running, so none was started — run \`${IDENTITY.binaryName} daemon\` to start it)`,
      );
    } else {
      appendUpgradeLog('Installer-managed Windows atomic upgrade completed');
    }
    return;
  }
  // Kill any *foreign* process still holding this install's conpty.node mapped
  // (the session-host stop above only covers the single managed pid). Do this
  // BEFORE the staging GC so the just-released file can also be cleaned up now
  // that no process maps it.
  await stopForeignNativeAddonHolders(installCommand.surface.packageRoot, { parentPid: payload.parentPid });
  cleanupStaleGlobalInstallDirs(payload.packageName, installCommand.surface);

  // POSIX takes its own path: pre-flight smoke gate on a throwaway prefix,
  // then a backup + rollback + daemon-restart protected in-place install. The
  // win32 fallback below (lock-retry loop + conpty gate) is unchanged.
  if (process.platform !== 'win32') {
    await runPosixInPlaceUpgrade({ payload, installCommand, restartArgv });
    return;
  }

  const spec = `${payload.packageName}@${payload.targetVersion || 'latest'}`;
  appendUpgradeLog(`Installing ${spec}`);
  // Windows can still race a lingering conpty.node mapping even after the
  // session-host exits, so retry the install on transient lock errors there.
  const maxInstallAttempts = process.platform === 'win32' ? 3 : 1;
  let installOutput = '';
  for (let attempt = 1; attempt <= maxInstallAttempts; attempt++) {
    try {
      installOutput = String(hiddenExecFileSync(
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
        emitUpgradeFailureNotice(notice, getConfigDir(), { targetVersion: payload.targetVersion });
      }
      throw error;
    }
  }
  if (installOutput.trim()) {
    appendUpgradeLog(installOutput.trim());
  }

  // A zero-exit npm install is NOT proof of a usable install: if node-pty was
  // rebuilt from source without build tools, npm reports success while leaving
  // no conpty.node behind, and every subsequent create_session fails with
  // "Failed to load native module: conpty.node". The atomic path gates on this
  // before flipping its pointer; the fallback in-place path had no such check.
  //
  // Fallback is in-place, so there is no pointer swap to roll back — the files
  // are already overwritten. What we CAN still protect is the running daemon:
  // throw before spawnDetachedDaemonRestart so the current process keeps
  // serving on the last-known-good code it already has loaded, and leave the
  // user an actionable notice instead of restarting into a broken install.
  if (process.platform === 'win32' && installCommand.surface.installPrefix) {
    try {
      verifyStagedConptyPrebuild(installCommand.surface.installPrefix, appendUpgradeLog);
    } catch (error: any) {
      appendUpgradeLog(`Post-install conpty verification failed: ${error?.message || String(error)}`);
      emitUpgradeFailureNotice([
        `adhdev ${spec} installed but is missing node-pty's native addon (conpty.node).`,
        'Starting it would break every session with "Failed to load native module: conpty.node",',
        'so the running daemon was left on its previous version and was NOT restarted.',
        'To recover, reinstall (this forces the shipped prebuild instead of a source rebuild):',
        `  ${buildManualRecoveryCommand(installCommand)}`,
      ], getConfigDir(), { targetVersion: payload.targetVersion });
      throw error;
    }
  }

  // npm may leave a staging dir behind on Windows when prebuild-install holds
  // conpty.node open during install scripts. Clean it up now that all npm child
  // processes have exited.
  if (process.platform === 'win32') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    cleanupStaleGlobalInstallDirs(payload.packageName, installCommand.surface);
    appendUpgradeLog('Post-install staging cleanup complete');
  }

  spawnDetachedDaemonRestart(restartArgv, payload.cwd);
  clearUpgradeFailureNotice();
}

/**
 * Re-spawn the daemon detached. Returns the child so the POSIX boot health
 * gate can notice a crash during boot; null when no restart was requested.
 */
function spawnDetachedDaemonRestart(restartArgv: string[], cwd?: string): ChildProcess | null {
  if (restartArgv.length > 0) {
    const env = { ...process.env };
    delete env[UPGRADE_HELPER_ENV];
    appendUpgradeLog(`Restarting daemon with args: ${restartArgv.join(' ')}`);
    // ★The post-upgrade daemon's raw stdout/stderr must land in
    // daemon-service.log, exactly as it does for the wizard start and
    // `daemon:restart` (both already open an append fd). This site was left on
    // `stdio: 'ignore'`, so every UPGRADE silently retargeted the capture log to
    // /dev/null: the file's last line stayed "[Upgrade] Exiting daemon so
    // detached upgrader can continue..." while the replacement daemon ran fine
    // and wrote nothing. Observed on Windows 2026-09-23 (5.2MB file frozen at
    // 00:44:43 while pid 3536 was healthy since 00:45:01).
    //
    // Fd inheritance is what makes this survive the handoff: this helper exits
    // right after the spawn, and a detached child keeps writing through an
    // inherited append fd after the parent has exited AND closed its own copy
    // (verified empirically). No shell — reintroducing `start /B ... >> log`
    // would bring back the console flash that `windowsHide` cannot suppress on
    // a hidden shell's grandchild.
    const { fd: outFd, close: closeOutFd } = openCaptureLogFd();
    try {
      const child = spawn(process.execPath, restartArgv, {
        detached: true,
        stdio: ['ignore', outFd, outFd],
        windowsHide: true,
        cwd: cwd || process.cwd(),
        env,
      });
      child.unref();
      return child;
    } finally {
      // The child inherited the fd; drop our copy so this process does not hold
      // the log open. Runs even if spawn threw.
      closeOutFd();
    }
  }
  appendUpgradeLog('No restart argv provided; upgrade completed without restart');
  return null;
}

export async function maybeRunDaemonUpgradeHelperFromEnv(): Promise<boolean> {
  const raw = process.env[UPGRADE_HELPER_ENV];
  if (!raw) return false;
  delete process.env[UPGRADE_HELPER_ENV];

  let targetVersion: string | null = null;
  try {
    const payload = JSON.parse(raw) as DaemonUpgradeHelperPayload;
    targetVersion = typeof payload?.targetVersion === 'string' ? payload.targetVersion : null;
    // Fail closed on a conflicting instance identity: a payload naming one
    // config dir handed to a process env-pinned to another must abort, never
    // merge namespaces or retarget mid-upgrade.
    const envConfigDir = (process.env.ADHDEV_CONFIG_DIR || '').trim();
    if (payload.configDir && envConfigDir
      && canonicalizeInstancePath(payload.configDir) !== canonicalizeInstancePath(envConfigDir)) {
      throw new Error(
        `Upgrade helper instance conflict: payload configDir "${payload.configDir}" vs `
        + `ADHDEV_CONFIG_DIR "${envConfigDir}" — refusing to run across instances`,
      );
    }
    await runDaemonUpgradeHelper(payload);
    process.exit(0);
  } catch (error: any) {
    const detail = error?.stack || error?.message || String(error);
    appendUpgradeLog(`Upgrade helper failed: ${detail}`);
    // A path that already wrote a specific notice (the POSIX boot health gate's
    // rollback report) keeps it — the generic wrapper would bury the reason.
    if (!(error instanceof UpgradeNoticeEmittedError)) {
      emitUpgradeFailureNotice([
        `adhdev upgrade failed: ${error?.message || String(error)}`,
        `See ${getUpgradeLogPath()} for details. The previous installer-managed version was preserved or restored when available.`,
      ], getConfigDir(), { targetVersion });
    }
    process.exit(1);
  }
}
