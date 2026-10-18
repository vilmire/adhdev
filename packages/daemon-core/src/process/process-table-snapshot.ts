import fs from 'node:fs';
import { hiddenExecFileAsync } from './hidden-spawn.js';
import {
  inspectSessionProcessTree,
  parsePosixPsOutput,
  parseWin32ProcessOutput,
  type ProcessNodeInfo,
  type SessionProcessTreeInspection,
} from './session-process-tree.js';

/**
 * The daemon's one shared, asynchronous view of the OS process table.
 *
 * Why this exists: the worker background-work guard needs "what is running
 * under this session's PTY" in three places (turn-ledger probe, ledger
 * evidence gate, provider completion gate). The first version spawned `ps` /
 * PowerShell SYNCHRONOUSLY per idle worker on the daemon's main loop — on a
 * saturated machine that blocks P2P signaling, IPC and every session for as
 * long as the OS takes to answer. This module makes that impossible:
 *
 *   - Nothing here awaits or blocks the caller's tick. Reads go through the
 *     async `hiddenExecFileAsync` (never a `*Sync` variant).
 *   - SINGLE FLIGHT: at most one read is ever in flight, shared by every
 *     session and every caller.
 *   - ONE SNAPSHOT PER TTL serves all sessions (the table is indexed once per
 *     snapshot, see `inspectSessionProcessTree`), instead of one `ps` each.
 *   - Throttled by platform: POSIX `ps` ~3 s, Windows CIM (slow) ~15 s, and a
 *     failed read backs off much longer. A failure never retries per tick.
 *   - A read that is in flight, failed, or older than `maxStaleMs` yields
 *     `null` = UNKNOWN. Callers then fall back to the text / no-report
 *     signals they already had; unknown never blocks, holds or completes.
 */

export interface ProcessTableSnapshot {
  readonly table: readonly ProcessNodeInfo[];
  /** When the read BEGAN (epoch ms): conservative for `etime`-derived start times. */
  readonly readAtMs: number;
  /**
   * The snapshot immediately before this one (its own `previous` is dropped),
   * kept only while the gap is within `maxStaleMs`: the second sample CPU growth
   * is measured against. Null = no usable earlier sample (CPU activity unknown).
   */
  readonly previous: { readonly table: readonly ProcessNodeInfo[]; readonly readAtMs: number } | null;
}

export interface ProcessTableSource {
  /**
   * Non-blocking. Returns the newest snapshot that is not older than
   * `maxStaleMs`, else null (unknown). When the snapshot is older than the
   * TTL it also starts a background refresh (single flight, throttled).
   */
  peek(): ProcessTableSnapshot | null;
  /**
   * Bounded wait for a fresh-enough snapshot: joins the in-flight read or
   * starts one, and gives up after `maxWaitMs` (default `defaultMaxWaitMs`),
   * returning the stale-but-usable snapshot or null. The read itself keeps
   * running in the background either way.
   */
  snapshot(maxWaitMs?: number): Promise<ProcessTableSnapshot | null>;
  readonly stats: () => { reads: number; failures: number; inFlight: boolean };
}

export interface ProcessTableSourceOptions {
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  /** Test seam: replaces the OS read. MUST be asynchronous. Null/empty/throw = failed read. */
  readonly read?: (platform: NodeJS.Platform) => Promise<readonly ProcessNodeInfo[] | null>;
  readonly ttlMs?: number;
  readonly maxStaleMs?: number;
  readonly failureBackoffMs?: number;
  readonly defaultMaxWaitMs?: number;
}

export interface ProcessTableTiming {
  readonly ttlMs: number;
  readonly maxStaleMs: number;
  readonly failureBackoffMs: number;
  readonly defaultMaxWaitMs: number;
  /** Hard limit handed to the child process (it is killed when exceeded). */
  readonly readTimeoutMs: number;
}

/** Windows `Get-CimInstance Win32_Process` costs 0.5–several seconds, so it is throttled hard. */
export const PROCESS_TABLE_TIMING: Readonly<Record<'posix' | 'win32', ProcessTableTiming>> = {
  posix: { ttlMs: 3_000, maxStaleMs: 12_000, failureBackoffMs: 15_000, defaultMaxWaitMs: 1_500, readTimeoutMs: 4_000 },
  win32: { ttlMs: 15_000, maxStaleMs: 60_000, failureBackoffMs: 90_000, defaultMaxWaitMs: 3_000, readTimeoutMs: 10_000 },
};

const PS_MAX_BUFFER = 16 * 1024 * 1024;

const WIN32_CIM_COMMAND =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,'
  + "@{n='StartMs';e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}},"
  // Kernel/UserModeTime are cumulative CPU in 100 ns units: the same CIM query, no extra process.
  + "@{n='CpuMs';e={if ($null -ne $_.KernelModeTime) { [math]::Round(([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000) } else { $null }}}"
  + ' | ConvertTo-Json -Compress';

async function readLinuxProcTableAsync(): Promise<ProcessNodeInfo[]> {
  const out: ProcessNodeInfo[] = [];
  let names: string[];
  try {
    names = (await fs.promises.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  const readOne = async (name: string): Promise<void> => {
    const pid = Number.parseInt(name, 10);
    try {
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const openParen = stat.indexOf('(');
      if (openParen < 0 || closeParen < 0) return;
      const comm = stat.slice(openParen + 1, closeParen);
      const rest = stat.slice(closeParen + 2).trim().split(/\s+/);
      const ppid = Number.parseInt(rest[1] ?? '0', 10);
      let args = comm;
      try {
        const cmdline = (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0+/g, ' ').trim();
        if (cmdline) args = cmdline;
      } catch {
        // cmdline unreadable.
      }
      // utime+stime (fields 14,15 → rest[11], rest[12]) in clock ticks; 100 Hz is the Linux USER_HZ.
      const ticks = Number.parseInt(rest[11] ?? '', 10) + Number.parseInt(rest[12] ?? '', 10);
      if (Number.isFinite(ppid)) out.push({ pid, ppid, comm, args, ...(Number.isFinite(ticks) ? { cpuTimeMs: ticks * 10 } : {}) });
    } catch {
      // Process exited during the scan.
    }
  };
  // Bounded concurrency: a few hundred tiny reads, never a thousand at once.
  for (let i = 0; i < names.length; i += 64) {
    await Promise.all(names.slice(i, i + 64).map(readOne));
  }
  return out;
}

/** One asynchronous read of the OS process table. Resolves null on failure; never throws. */
export async function readSystemProcessTableAsync(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessNodeInfo[] | null> {
  const timing = platform === 'win32' ? PROCESS_TABLE_TIMING.win32 : PROCESS_TABLE_TIMING.posix;
  const asText = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

  if (platform === 'win32') {
    try {
      const { stdout } = await hiddenExecFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN32_CIM_COMMAND],
        { encoding: 'utf8', timeout: timing.readTimeoutMs, maxBuffer: PS_MAX_BUFFER, windowsHide: true },
      );
      const parsed = parseWin32ProcessOutput(asText(stdout));
      if (parsed.length > 0) return parsed;
    } catch {
      // Fall back to wmic on older Windows installations.
    }
    try {
      const { stdout } = await hiddenExecFileAsync(
        'wmic.exe',
        ['process', 'get', 'CommandLine,Name,ParentProcessId,ProcessId', '/FORMAT:CSV'],
        { encoding: 'utf8', timeout: timing.readTimeoutMs, maxBuffer: PS_MAX_BUFFER, windowsHide: true },
      );
      const parsed = parseWin32ProcessOutput(asText(stdout));
      return parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  // POSIX (macOS / Linux / BSD). `etime` is the portable start time, `time` the cumulative CPU.
  const startedReadAt = Date.now();
  try {
    const { stdout } = await hiddenExecFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,etime=,time=,comm=,args='], {
      encoding: 'utf8',
      timeout: timing.readTimeoutMs,
      maxBuffer: PS_MAX_BUFFER,
    });
    const parsed = parsePosixPsOutput(asText(stdout), startedReadAt);
    if (parsed.length > 0) return parsed;
  } catch {
    // Fall back to /proc on Linux if ps is unavailable or failed.
  }
  if (platform === 'linux') {
    const table = await readLinuxProcTableAsync();
    return table.length > 0 ? table : null;
  }
  return null;
}

export function createProcessTableSource(options: ProcessTableSourceOptions = {}): ProcessTableSource {
  const platform = options.platform ?? process.platform;
  const timing = platform === 'win32' ? PROCESS_TABLE_TIMING.win32 : PROCESS_TABLE_TIMING.posix;
  const ttlMs = options.ttlMs ?? timing.ttlMs;
  const maxStaleMs = options.maxStaleMs ?? timing.maxStaleMs;
  const failureBackoffMs = options.failureBackoffMs ?? timing.failureBackoffMs;
  const defaultMaxWaitMs = options.defaultMaxWaitMs ?? timing.defaultMaxWaitMs;
  const now = options.now ?? Date.now;
  const read = options.read ?? ((p: NodeJS.Platform) => readSystemProcessTableAsync(p));

  let current: ProcessTableSnapshot | null = null;
  let inFlight: Promise<ProcessTableSnapshot | null> | null = null;
  let nextReadAllowedAt = 0;
  let reads = 0;
  let failures = 0;

  const fresh = (at: number): boolean => current !== null && at - current.readAtMs <= ttlMs;
  const usable = (at: number): ProcessTableSnapshot | null =>
    current !== null && at - current.readAtMs <= maxStaleMs ? current : null;

  function startRefresh(at: number): Promise<ProcessTableSnapshot | null> | null {
    if (inFlight) return inFlight;
    if (at < nextReadAllowedAt) return null;
    reads += 1;
    const startedAt = at;
    inFlight = (async (): Promise<ProcessTableSnapshot | null> => {
      try {
        const table = await read(platform);
        if (table && table.length > 0) {
          const previous = current && startedAt - current.readAtMs <= maxStaleMs
            ? { table: current.table, readAtMs: current.readAtMs }
            : null;
          current = { table, readAtMs: startedAt, previous };
          // The next read waits a TTL after this one FINISHED too, so a slow
          // read on a saturated machine is never followed by an immediate one.
          nextReadAllowedAt = now() + ttlMs;
          return current;
        }
        failures += 1;
        nextReadAllowedAt = now() + failureBackoffMs;
        return null;
      } catch {
        failures += 1;
        nextReadAllowedAt = now() + failureBackoffMs;
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    peek(): ProcessTableSnapshot | null {
      const at = now();
      if (!fresh(at)) void startRefresh(at);
      return usable(at);
    },
    async snapshot(maxWaitMs: number = defaultMaxWaitMs): Promise<ProcessTableSnapshot | null> {
      const at = now();
      if (fresh(at)) return current;
      const pending = startRefresh(at);
      if (!pending) return usable(at);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          pending,
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), maxWaitMs);
            timer.unref?.();
          }),
        ]);
        return settled === 'timeout' ? usable(now()) : (settled ?? usable(now()));
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    stats: () => ({ reads, failures, inFlight: inFlight !== null }),
  };
}

let sharedSource: ProcessTableSource | null = null;

/**
 * The process-wide source. The OS process table is itself process-global state,
 * and the point of this module is that every consumer shares ONE snapshot and
 * ONE in-flight read, so it is lazily created here rather than threaded
 * through every stage. Tests build their own via `createProcessTableSource`.
 */
export function getSharedProcessTableSource(): ProcessTableSource {
  sharedSource ??= createProcessTableSource();
  return sharedSource;
}

/** Test-only: replace (or reset with null) the shared source. */
export function __setSharedProcessTableSourceForTests(source: ProcessTableSource | null): void {
  sharedSource = source;
}

/** What the guard learns about a session's background work from one snapshot pair. */
export interface SessionBackgroundInspection extends SessionProcessTreeInspection {
  /** When the newer snapshot of the pair was read: the instant CPU activity (if any) was observed. */
  readonly snapshotAtMs: number;
}

export interface BackgroundInspectionOptions {
  readonly source?: ProcessTableSource;
  readonly startedAfterMs?: number;
  readonly selfPid?: number;
}

/**
 * Non-blocking inspection from the newest usable snapshot. Returns null =
 * UNKNOWN (no PID, no snapshot yet, or the last read failed/went stale) — the
 * caller must treat that as "no process evidence", never as "no processes".
 */
export function peekSessionBackgroundProcesses(
  rootPid: number | undefined,
  options: BackgroundInspectionOptions = {},
): SessionBackgroundInspection | null {
  if (typeof rootPid !== 'number' || !(rootPid > 0)) return null;
  const snapshot = (options.source ?? getSharedProcessTableSource()).peek();
  return snapshot ? inspectFromSnapshot(rootPid, snapshot, options) : null;
}

/** Bounded-wait inspection (the probe path). Same null = UNKNOWN contract. */
export async function readSessionBackgroundProcesses(
  rootPid: number | undefined,
  options: BackgroundInspectionOptions & { readonly maxWaitMs?: number } = {},
): Promise<SessionBackgroundInspection | null> {
  if (typeof rootPid !== 'number' || !(rootPid > 0)) return null;
  const snapshot = await (options.source ?? getSharedProcessTableSource()).snapshot(options.maxWaitMs);
  return snapshot ? inspectFromSnapshot(rootPid, snapshot, options) : null;
}

function inspectFromSnapshot(
  rootPid: number,
  snapshot: ProcessTableSnapshot,
  options: BackgroundInspectionOptions,
): SessionBackgroundInspection {
  const inspection = inspectSessionProcessTree(rootPid, {
    processTable: snapshot.table,
    ...(snapshot.previous
      ? { previousProcessTable: snapshot.previous.table, snapshotIntervalMs: snapshot.readAtMs - snapshot.previous.readAtMs }
      : {}),
    ...(options.selfPid !== undefined ? { selfPid: options.selfPid } : {}),
    ...(options.startedAfterMs !== undefined ? { startedAfterMs: options.startedAfterMs } : {}),
  });
  return { ...inspection, snapshotAtMs: snapshot.readAtMs };
}
