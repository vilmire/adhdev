/**
 * POSIX (macOS/Linux) post-upgrade boot health gate + automatic rollback.
 *
 * ## Why this exists (2026-09-27 rc.62 incident)
 *
 * rc.62 installed cleanly and its CLI answered `--version`, so it passed both
 * POSIX protections that existed at the time (the pre-flight smoke gate on a
 * throwaway prefix and the post-install `--version` smoke test on the live
 * prefix). The DAEMON then crashed on boot, fleet-wide. The Windows node rolled
 * itself back: its atomic path restarts the daemon from the staged prefix and
 * polls the loopback IPC port for `/health` + `status.version == target`
 * before committing (windows-atomic-upgrade.ts `waitForHealth`). The macOS and
 * Linux nodes had no such gate — the helper re-spawned the daemon and exited —
 * so they stayed dead until the owner restarted them by hand.
 *
 * `--version` proves the CLI entry loads; only a booted daemon answering its
 * IPC port with the target version proves the upgrade works. This module is
 * that gate for the POSIX in-place path: spawn the replacement daemon, wait a
 * bounded time for the same health/version signal the Windows gate uses, and
 * on failure (process exits during boot, no health, wrong version) stop what
 * was started, restore the previous install, restart it and verify THAT
 * comes back healthy too.
 *
 * ## Shape
 *
 * Pure orchestration over injected hooks (spawn, probe, stop, restore), like
 * `WindowsAtomicUpgradeHooks`: the upgrade helper wires the real
 * implementations, tests inject fakes. Nothing here touches npm, the
 * filesystem or real processes directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTrackIdentity, resolveBuildTrack } from '../track-identity.js';
import { isPidAlive } from '../system/process-utils.js';
import { DEFAULT_HEALTH_TIMEOUT_MS } from './windows-atomic-upgrade.js';

/** One observation of the daemon on the instance's loopback IPC port. */
export interface DaemonHealthProbe {
  alive: boolean;
  /** Pid the answering daemon reported in /health (null when not alive / unparseable). */
  pid: number | null;
  /** status.version from /api/v1/status (null while components are still booting). */
  version: string | null;
}

/** A process the gate started. `exitStatus()` is null while it is still running. */
export interface SpawnedDaemonHandle {
  pid: number | null;
  exitStatus(): { code: number | null; signal: string | null } | null;
}

/** How the previous install was put back. */
export type PosixRestoreMethod = 'snapshot' | 'reinstall';

export interface PosixUpgradeGateHooks {
  /** Start the daemon with the caller's restart argv (detached). Null when nothing could be spawned. */
  spawnDaemon: (argv: string[]) => SpawnedDaemonHandle | null;
  /** Probe the loopback IPC port once. Must never throw. */
  probe: (port: number) => Promise<DaemonHealthProbe>;
  /** Stop a pid (graceful, then forced). Resolves true once it is gone. */
  stopPid: (pid: number) => Promise<boolean>;
  /** Put the previous version back on disk. Throws when neither snapshot nor reinstall worked. */
  restorePrevious: () => Promise<PosixRestoreMethod> | PosixRestoreMethod;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

export interface PosixUpgradeGateOptions {
  targetVersion: string;
  /** Version installed before the upgrade (null when it could not be read). */
  previousVersion: string | null;
  restartArgv: string[];
  /** Loopback IPC port the instance's daemon serves. */
  port: number;
  /** Budget for the replacement daemon to report the target version. */
  healthTimeoutMs?: number;
  /** Budget for the restored previous version to come back healthy. */
  rollbackHealthTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Pids that must never be stopped (the helper itself). */
  excludePids?: number[];
  hooks: PosixUpgradeGateHooks;
  /** Phase transitions, so the caller can journal them for interrupt recovery. */
  onPhase?: (phase: 'gating' | 'rolling_back', spawnedPid: number | null) => void;
}

export type PosixUpgradeGateResult =
  | { outcome: 'healthy'; pid: number | null; elapsedMs: number }
  | {
    outcome: 'rolled_back';
    /** Why the replacement daemon failed the gate. */
    reason: string;
    restoredVia: PosixRestoreMethod;
    previousVersion: string | null;
    pid: number | null;
  }
  | {
    outcome: 'rollback_failed';
    reason: string;
    /** What went wrong with the rollback itself. */
    rollbackError: string;
    /** True when SOME daemon is answering health after the rollback attempt. */
    daemonRunning: boolean;
    runningVersion: string | null;
    pid: number | null;
  };

const DEFAULT_POLL_INTERVAL_MS = 500;
const ROLLBACK_RESTART_ATTEMPTS = 2;

type HealthWaitResult =
  | { ok: true; pid: number | null; version: string | null; elapsedMs: number }
  | { ok: false; reason: string; last: DaemonHealthProbe | null };

/**
 * Poll the IPC port until a daemon answers with `expectVersion` (or with any
 * version when `expectVersion` is null), the spawned process dies during boot,
 * or the budget runs out.
 *
 * Health is judged by the PORT, not by the spawned pid: on macOS the restart
 * argv may be `service install`, a short-lived CLI that hands the daemon to
 * launchd, and a service manager may respawn the daemon itself. A zero exit of
 * the spawned process is therefore not a failure; a non-zero exit (or a
 * signal) with nothing answering on the port is — that is the crash-on-boot
 * fast path, so an rc.62-class failure rolls back in seconds rather than after
 * the full budget.
 */
async function waitForDaemonHealth(
  hooks: PosixUpgradeGateHooks,
  options: {
    port: number;
    expectVersion: string | null;
    spawned: SpawnedDaemonHandle | null;
    timeoutMs: number;
    pollIntervalMs: number;
    label: string;
  },
): Promise<HealthWaitResult> {
  const { port, expectVersion, spawned, timeoutMs, pollIntervalMs, label } = options;
  const startedAt = hooks.now();
  let last: DaemonHealthProbe | null = null;
  let loggedAlive = false;
  let loggedWrongVersion = false;
  for (let attempt = 1; ; attempt++) {
    const probe = await hooks.probe(port);
    last = probe;
    const elapsedMs = hooks.now() - startedAt;
    if (probe.alive && (expectVersion === null || probe.version === expectVersion)) {
      hooks.log(
        `Health gate (${label}) passed after ${elapsedMs}ms (${attempt} probe(s)): pid ${probe.pid ?? 'unknown'} `
        + `on 127.0.0.1:${port} reports ${probe.version ?? 'an unreported version'}`,
      );
      return { ok: true, pid: probe.pid, version: probe.version, elapsedMs };
    }
    if (probe.alive && !loggedAlive) {
      loggedAlive = true;
      hooks.log(`Health gate (${label}): pid ${probe.pid ?? 'unknown'} is alive at ${elapsedMs}ms; awaiting status.version`);
    }
    if (probe.alive && probe.version && probe.version !== expectVersion && !loggedWrongVersion) {
      loggedWrongVersion = true;
      hooks.log(`Health gate (${label}): daemon reports version ${probe.version} (want ${expectVersion}) at ${elapsedMs}ms`);
    }
    const exit = spawned?.exitStatus() ?? null;
    if (exit && !probe.alive && (exit.code !== 0 || exit.signal)) {
      return {
        ok: false,
        last,
        reason: `the ${label} process (pid ${spawned?.pid ?? 'unknown'}) exited during boot `
          + `(code ${exit.code ?? 'none'}${exit.signal ? `, signal ${exit.signal}` : ''}) `
          + `before answering health on 127.0.0.1:${port}`,
      };
    }
    if (elapsedMs >= timeoutMs) break;
    await hooks.sleep(pollIntervalMs);
  }
  const waited = hooks.now() - startedAt;
  if (last?.alive && last.version) {
    return { ok: false, last, reason: `the daemon on 127.0.0.1:${port} reports version ${last.version}, not ${expectVersion}, after ${waited}ms` };
  }
  if (last?.alive) {
    return { ok: false, last, reason: `the daemon on 127.0.0.1:${port} answered /health but never reported status.version within ${waited}ms` };
  }
  return { ok: false, last, reason: `no daemon answered health on 127.0.0.1:${port} within ${waited}ms` };
}

/**
 * Stop whatever the failed attempt left running before the previous version is
 * restarted — otherwise a wedged-but-listening replacement keeps the port and
 * the restored daemon cannot bind. Only two pids are ever targeted: the one
 * this gate spawned (if still running) and the one the instance's own IPC port
 * reports in /health. Pidfiles are deliberately NOT used: the replacement may
 * have crashed after writing one, and a recycled pid must never be killed.
 */
async function stopFailedDaemons(
  hooks: PosixUpgradeGateHooks,
  spawned: SpawnedDaemonHandle | null,
  port: number,
  excludePids: Set<number>,
): Promise<void> {
  const pids = new Set<number>();
  if (spawned?.pid && spawned.exitStatus() === null) pids.add(spawned.pid);
  const probe = await hooks.probe(port);
  if (probe.alive && probe.pid) pids.add(probe.pid);
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0 || excludePids.has(pid)) continue;
    hooks.log(`Stopping failed replacement daemon pid ${pid} before rollback`);
    const stopped = await hooks.stopPid(pid);
    if (!stopped) hooks.log(`Pid ${pid} did not exit after the stop request; continuing the rollback anyway`);
  }
}

/**
 * Restart the daemon from the just-upgraded install and gate it; on failure,
 * roll back to the previous install and verify THAT comes back.
 *
 * Never leaves the machine without a restart attempt: every path ends with a
 * daemon spawned from whatever is on disk. When the restore itself fails, the
 * restart still happens and any healthy daemon is accepted — a daemon on the
 * wrong version is recoverable remotely; no daemon at all is not.
 */
export async function gatePosixUpgradeRestart(options: PosixUpgradeGateOptions): Promise<PosixUpgradeGateResult> {
  const { hooks, port, targetVersion, previousVersion, restartArgv } = options;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const rollbackHealthTimeoutMs = options.rollbackHealthTimeoutMs ?? healthTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const excludePids = new Set<number>([process.pid, ...(options.excludePids ?? [])]);

  const spawned = hooks.spawnDaemon(restartArgv);
  options.onPhase?.('gating', spawned?.pid ?? null);
  hooks.log(
    `Health gate: waiting up to ${healthTimeoutMs}ms for the daemon on 127.0.0.1:${port} to report ${targetVersion}`
    + (spawned?.pid ? ` (spawned pid ${spawned.pid})` : ''),
  );
  const gate = await waitForDaemonHealth(hooks, {
    port,
    expectVersion: targetVersion,
    spawned,
    timeoutMs: healthTimeoutMs,
    pollIntervalMs,
    label: 'replacement',
  });
  if (gate.ok) {
    return { outcome: 'healthy', pid: gate.pid, elapsedMs: gate.elapsedMs };
  }

  const reason = gate.reason;
  hooks.log(`Health gate FAILED for ${targetVersion}: ${reason} — rolling back to ${previousVersion ?? 'the previous install'}`);
  options.onPhase?.('rolling_back', spawned?.pid ?? null);
  await stopFailedDaemons(hooks, spawned, port, excludePids);

  let restoredVia: PosixRestoreMethod | null = null;
  let rollbackError: string | null = null;
  try {
    restoredVia = await hooks.restorePrevious();
    hooks.log(`Rollback: previous install restored via ${restoredVia}`);
  } catch (error: any) {
    rollbackError = `could not restore the previous install: ${error?.message || String(error)}`;
    hooks.log(`ROLLBACK RESTORE FAILED: ${rollbackError} — restarting whatever is installed so the machine is not left without a daemon`);
  }

  // With the previous files back, demand the previous version. Without them,
  // accept any healthy daemon: keeping SOMETHING running beats a dead machine.
  const expectVersion = restoredVia ? previousVersion : null;
  let lastReason = '';
  for (let attempt = 1; attempt <= ROLLBACK_RESTART_ATTEMPTS; attempt++) {
    const child = hooks.spawnDaemon(restartArgv);
    const result = await waitForDaemonHealth(hooks, {
      port,
      expectVersion,
      spawned: child,
      timeoutMs: rollbackHealthTimeoutMs,
      pollIntervalMs,
      label: 'rollback',
    });
    if (result.ok) {
      if (rollbackError) {
        return {
          outcome: 'rollback_failed',
          reason,
          rollbackError,
          daemonRunning: true,
          runningVersion: result.version,
          pid: result.pid,
        };
      }
      return {
        outcome: 'rolled_back',
        reason,
        restoredVia: restoredVia as PosixRestoreMethod,
        previousVersion,
        pid: result.pid,
      };
    }
    lastReason = result.reason;
    hooks.log(`Rollback restart attempt ${attempt}/${ROLLBACK_RESTART_ATTEMPTS} did not pass health: ${result.reason}`);
    // A daemon answering with the wrong version here is typically a service
    // manager (launchd KeepAlive / systemd Restart=) that respawned the new
    // code before the files were restored. Stop it and try once more.
    if (attempt < ROLLBACK_RESTART_ATTEMPTS) await stopFailedDaemons(hooks, child, port, excludePids);
  }
  return {
    outcome: 'rollback_failed',
    reason,
    rollbackError: rollbackError
      ? `${rollbackError}; the restart afterwards also failed: ${lastReason}`
      : `the previous version was restored but did not come back healthy: ${lastReason}`,
    daemonRunning: false,
    runningVersion: null,
    pid: null,
  };
}

/**
 * Parse an explicit `-p <n>` / `--port <n>` / `--port=<n>` from the restart
 * argv. The cloud daemon's `daemon` command serves its IPC on that port.
 */
function parseRestartArgvPort(restartArgv: string[]): number | null {
  for (let i = 0; i < restartArgv.length; i++) {
    const arg = restartArgv[i];
    let raw: string | undefined;
    if (arg === '-p' || arg === '--port') raw = restartArgv[i + 1];
    else if (arg.startsWith('--port=')) raw = arg.slice('--port='.length);
    if (raw === undefined) continue;
    const port = Number.parseInt(raw, 10);
    if (Number.isFinite(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

/**
 * The loopback IPC port the restarted daemon will serve.
 *
 * 1. An explicit port in the restart argv wins (a service-launched preview
 *    daemon runs `daemon --port 19223`; `adhdev update` passes `daemon -p`).
 * 2. A non-stable instance dir (`.adhdev-preview`, …) serves the preview port —
 *    the same rule the service installer applies (resolveServiceInstance),
 *    which covers the macOS `service install` restart argv that carries no port.
 * 3. Otherwise the build track's default port (19222 stable / 19223 preview).
 *
 * Never a hard-coded 19222: the Windows gate once probed the stable port for
 * the preview instance and rolled back three healthy upgrades in a row.
 */
export function resolvePosixHealthGatePort(options: {
  restartArgv: string[];
  instanceDir: string;
  env?: NodeJS.ProcessEnv;
}): number {
  const explicit = parseRestartArgvPort(options.restartArgv);
  if (explicit !== null) return explicit;
  if (options.instanceDir && options.instanceDir !== '.adhdev') return getTrackIdentity('preview').defaultPort;
  return getTrackIdentity(resolveBuildTrack(options.env ?? process.env)).defaultPort;
}

/**
 * Whether the POSIX upgrade can be health-gated at all. Returns a reason when
 * it cannot, so the helper logs why it fell back to the ungated restart.
 *
 * - No restart argv: `adhdev update` with no daemon running — nothing to
 *   start, nothing to probe (mirrors the Windows gate's null-restart success).
 * - `@adhdev/daemon-standalone`: its loopback IPC server is opt-in
 *   (ADHDEV_STANDALONE_ENABLE_IPC) and its `-p` is the HTTP port, not the IPC
 *   port — gating it on the IPC port would roll back healthy upgrades.
 */
export function describePosixHealthGateSkip(packageName: string, restartArgv: string[]): string | null {
  if (restartArgv.length === 0) return 'no daemon restart was requested (daemon was not running)';
  if (packageName !== 'adhdev') return `${packageName} does not serve the loopback IPC health endpoints the gate probes`;
  return null;
}

// ─── Interrupt journal ───────────────────────────────────────────────────────
//
// The helper runs detached with the parent daemon already gone, so if IT dies
// mid-upgrade (SIGTERM from a shutdown, OOM kill, a second `adhdev update`)
// nobody else knows an unverified install is on disk. The journal is the
// durable trail: written before the live install is touched, advanced through
// the gate phases, removed on every terminal path. A later helper that finds a
// stale one logs it (with the backup dir it named) instead of silently
// overwriting the evidence, and a journal owned by a still-running helper makes
// a concurrent second helper stand down instead of racing the first.

export type PosixUpgradeJournalPhase = 'preflight' | 'installing' | 'gating' | 'rolling_back';

export interface PosixUpgradeJournal {
  helperPid: number;
  packageName: string;
  targetVersion: string;
  previousVersion: string | null;
  installPrefix: string | null;
  packageRoot: string | null;
  backupDir: string | null;
  restartArgv: string[];
  phase: PosixUpgradeJournalPhase;
  /** Pid the gate spawned (replacement or rollback daemon), when known. */
  spawnedPid: number | null;
  startedAt: string;
  updatedAt: string;
}

/** A journal older than this is stale even if its pid was recycled by a live process. */
const JOURNAL_OWNER_MAX_AGE_MS = 30 * 60_000;

export function getPosixUpgradeJournalPath(configDir: string): string {
  return path.join(configDir, 'daemon-upgrade-journal.json');
}

export function readPosixUpgradeJournal(configDir: string): PosixUpgradeJournal | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getPosixUpgradeJournalPath(configDir), 'utf8'));
    return parsed && typeof parsed === 'object' && Number.isFinite(parsed.helperPid) ? parsed as PosixUpgradeJournal : null;
  } catch {
    return null;
  }
}

/** Atomic replace (tmp + rename) so an interrupted write never leaves half a journal. */
export function writePosixUpgradeJournal(configDir: string, journal: PosixUpgradeJournal): void {
  const target = getPosixUpgradeJournalPath(configDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* noop */ }
  }
}

/** Remove the journal, but only when this process owns it. */
export function clearPosixUpgradeJournal(configDir: string, ownerPid: number = process.pid): void {
  const current = readPosixUpgradeJournal(configDir);
  if (current && current.helperPid !== ownerPid) return;
  try { fs.rmSync(getPosixUpgradeJournalPath(configDir), { force: true }); } catch { /* noop */ }
}

/**
 * Decide whether this helper may proceed.
 *
 * - `busy`: another helper that is still alive (and recent) owns the journal —
 *   it will finish, gate and restart the daemon itself; running a second
 *   install underneath it would corrupt both.
 * - `stale`: a previous helper died mid-upgrade; returned so the caller can log
 *   what was interrupted before this run takes over.
 */
export function inspectPosixUpgradeJournal(
  configDir: string,
  options: { selfPid?: number; now?: number; isAlive?: (pid: number) => boolean } = {},
): { state: 'none' } | { state: 'busy'; journal: PosixUpgradeJournal } | { state: 'stale'; journal: PosixUpgradeJournal } {
  const journal = readPosixUpgradeJournal(configDir);
  if (!journal) return { state: 'none' };
  const selfPid = options.selfPid ?? process.pid;
  const now = options.now ?? Date.now();
  const alive = options.isAlive ?? isPidAlive;
  const updatedAt = Date.parse(journal.updatedAt || journal.startedAt || '');
  const fresh = Number.isFinite(updatedAt) && now - updatedAt < JOURNAL_OWNER_MAX_AGE_MS;
  if (journal.helperPid !== selfPid && fresh && alive(journal.helperPid)) return { state: 'busy', journal };
  return { state: 'stale', journal };
}
