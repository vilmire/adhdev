/**
 * Stopping the processes that hold the installed package open before an upgrade
 * replaces it: the session-host daemons (which pin conpty.node on Windows) and any
 * foreign process holding one of the locked native addons. Each stop reports what it
 * found and killed so the upgrade log can explain a failed replace.
 */
import { getProcessCommandLine, killProcess, waitForPidExit } from './process-lifecycle.js';
import { getConfigDir } from '../config/config.js';
import * as path from 'path';
import * as fs from 'fs';
import { appendUpgradeLog } from './upgrade-log.js';
import { isPidAlive } from '../system/process-utils.js';
import { execFileSync } from 'child_process';

/**
 * True when a child process was killed for exceeding its `timeout`, as opposed
 * to exiting on its own with a non-zero status.
 *
 * Node surfaces the kill as `code: 'ETIMEDOUT'`; it delivers the configured
 * `killSignal` (default SIGTERM) and leaves `status` null, whereas a process
 * that ran to completion and failed reports a numeric `status` and no
 * `ETIMEDOUT`. Both shapes are checked because the `code` field is the
 * documented contract while the signal is the observable mechanism, and a
 * caller may override `killSignal`.
 */
export function isSpawnTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; signal?: unknown; status?: unknown };
  if (candidate.code === 'ETIMEDOUT') return true;
  return typeof candidate.signal === 'string' && candidate.signal !== '' && candidate.status == null;
}

/**
 * Three-valued identity check for a session-host pid.
 *
 * `getProcessCommandLine` shells out to PowerShell (Get-CimInstance) with a wmic
 * fallback. On a box where AV/EDR blocks the former and the latter is absent
 * (wmic is removed by default in Windows 11 24H2+) BOTH fail, structurally, on
 * every call. Collapsing that into a boolean is what made the upgrade path
 * unsafe: `unknown` was indistinguishable from `proven not ours`.
 */
type SessionHostPidIdentity = 'managed' | 'unrelated' | 'unknown';

function classifySessionHostPid(pid: number): SessionHostPidIdentity {
  const commandLine = getProcessCommandLine(pid);
  if (!commandLine) return 'unknown';
  return /session-host-daemon/i.test(commandLine) ? 'managed' : 'unrelated';
}

/**
 * Stop the session-host recorded in THIS instance's pidfile before an upgrade.
 *
 * The pidfile is written by the daemon for its own child, so the pid in it is
 * authoritative evidence that a host exists — evidence that needs no process
 * inspection at all. The previous implementation nonetheless required a
 * command-line match before killing (`isManagedSessionHostPid`) and then
 * deleted the pidfile unconditionally in `finally`. On a box where the
 * command-line probe is structurally broken that combination is the root cause
 * of the win32 stale-host outage:
 *
 *   1. probe returns null  → the kill is SKIPPED, the host keeps running;
 *   2. the pidfile is deleted anyway → the only non-probe evidence is destroyed;
 *   3. every downstream guard (`stopOwnedProcessesForPrefixes` in the helper and
 *      in `performWindowsAtomicUpgrade`, plus `cleanupInactivePrefixesWithGuard`)
 *      depends on that same broken probe, reports zero survivors, and the OLD
 *      prefix is deleted out from under the still-running host;
 *   4. the host answers its socket fine, so the next daemon reuses it, and every
 *      `create_session` dies in ~1ms requiring node-pty's conpty.node from the
 *      deleted tree.
 *
 * So: an `unknown` pid is now treated as OURS (the pidfile says so) and killed.
 * A wrong kill costs one respawn of a process we are about to replace anyway; a
 * missed kill costs the outage above. Only a pid POSITIVELY identified as
 * something else is spared — that is a recycled pid now owned by a stranger.
 *
 * Returns what happened so the caller can fail closed when a host survived.
 */
export interface SessionHostStopOutcome {
  /** Pid found in the pidfile, if any. */
  pid: number | null;
  /** Identity verdict for that pid. */
  identity: SessionHostPidIdentity | null;
  /** True when a kill was issued AND the pid left the process table. */
  stopped: boolean;
  /** True when a host was found but is still alive after the stop attempt. */
  survived: boolean;
}

export async function stopSessionHostProcesses(
  appName: string,
  configDir: string = getConfigDir(),
): Promise<SessionHostStopOutcome> {
  const pidFile = path.join(configDir, `${appName}-session-host.pid`);
  const outcome: SessionHostStopOutcome = { pid: null, identity: null, stopped: false, survived: false };
  let killedPid: number | null = null;
  // Retain the pidfile when a tracked host survived: it is the only evidence the
  // downstream guards can use that does not depend on the broken probe. Deleting
  // it here is what disarmed them in production.
  let keepPidFile = false;
  try {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid) {
        outcome.pid = pid;
        const identity = classifySessionHostPid(pid);
        outcome.identity = identity;
        if (identity === 'unrelated') {
          appendUpgradeLog(
            `Session-host pidfile names pid ${pid}, which is positively identified as an unrelated process; `
            + 'treating the pidfile as stale and not killing it.',
            configDir,
          );
        } else {
          if (identity === 'unknown') {
            appendUpgradeLog(
              `Could not read the command line of session-host pid ${pid} (process-inspection unavailable). `
              + 'The pidfile is this daemon\'s own record, so the pid is treated as ours and stopped — a stale host '
              + 'surviving an upgrade breaks every create_session with a conpty.node load failure.',
              configDir,
            );
          }
          if (killProcess(pid)) killedPid = pid;
        }
      }
    }
  } catch {
    // noop
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
    outcome.stopped = await waitForPidExit(killedPid, 15000);
    if (!outcome.stopped) {
      outcome.survived = true;
      appendUpgradeLog(
        `Session-host pid ${killedPid} did not exit within 15000ms of the stop request.`,
        configDir,
      );
    }
  } else if (outcome.pid !== null && outcome.identity !== 'unrelated') {
    // The kill request itself failed (permissions, taskkill unavailable). If the
    // process is still there, it is a survivor.
    outcome.survived = isPidAlive(outcome.pid);
  }

  keepPidFile = outcome.survived;
  if (!keepPidFile) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // noop
    }
  } else {
    appendUpgradeLog(
      `Keeping ${pidFile} so the remaining upgrade guards can still see the surviving host.`,
      configDir,
    );
  }

  return outcome;
}

/**
 * Is `pid` still alive? Signal 0 performs the permission/existence check without
 * delivering a signal. Unlike `getProcessCommandLine` this is a plain kernel
 * call that always answers, so it works on exactly the boxes where the
 * PowerShell/wmic probe does not. `EPERM` means the process exists but belongs
 * to someone else — alive for our purposes.
 */
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
