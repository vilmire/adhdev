import * as fs from 'fs';
import * as os from 'os';

/**
 * Detects a wedged libuv thread pool and reports it once.
 *
 * node-pty writes to the PTY with `fs.write`, which runs on the libuv thread
 * pool. On 2026-10-21 a preview host was found with every pool request
 * (`fs.*`, `crypto.pbkdf2`, `dns.lookup`) never completing while the main loop
 * still served IPC: the host acknowledged every `send_input`, the PTY write
 * queue grew without draining, and no hosted session could receive input for
 * hours. Nothing in that state recovers on its own, and a host that answers
 * IPC never looks dead to the daemon, so the host has to notice it itself.
 *
 * One probe is in flight at a time. A probe that does not complete within
 * `stallMs` means the pool is not making progress; `onStall` fires once and
 * the watchdog stops. Timers are unref'd so the watchdog never keeps the
 * process alive.
 */
export interface ThreadpoolWatchdogOptions {
  /** How often to start a probe when none is in flight. */
  intervalMs?: number;
  /** How long one probe may stay in flight before the pool counts as wedged. */
  stallMs?: number;
  /** A thread-pool operation that calls `done` when it completes. */
  probe?: (done: () => void) => void;
  onStall: (stalledForMs: number) => void;
  now?: () => number;
}

export interface ThreadpoolWatchdog {
  stop(): void;
  /** Runs one check immediately; exposed for tests. */
  tick(): void;
}

export const THREADPOOL_WATCHDOG_INTERVAL_MS = 15_000;
// Long enough that a pool saturated by legitimate work (large snapshot reads,
// a slow disk) is not mistaken for a wedge.
export const THREADPOOL_WATCHDOG_STALL_MS = 120_000;

function defaultProbe(done: () => void): void {
  fs.stat(os.tmpdir(), () => done());
}

export function startThreadpoolWatchdog(options: ThreadpoolWatchdogOptions): ThreadpoolWatchdog {
  const intervalMs = options.intervalMs ?? THREADPOOL_WATCHDOG_INTERVAL_MS;
  const stallMs = options.stallMs ?? THREADPOOL_WATCHDOG_STALL_MS;
  const probe = options.probe ?? defaultProbe;
  const now = options.now ?? Date.now;
  let inFlightSince: number | null = null;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (inFlightSince !== null) {
      const stalledForMs = now() - inFlightSince;
      if (stalledForMs >= stallMs) {
        stopped = true;
        clearInterval(timer);
        options.onStall(stalledForMs);
      }
      return;
    }
    const startedAt = now();
    inFlightSince = startedAt;
    probe(() => {
      if (inFlightSince === startedAt) inFlightSince = null;
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

/**
 * Writes one line to stderr synchronously. `console.error` can silently drop
 * output once stderr's stream has errored (the wedged host's log file stopped
 * growing after a disk-full spell), and the last line before exit must land.
 */
export function writeStderrLineSync(line: string): void {
  try {
    fs.writeSync(2, `${line}\n`);
  } catch {
    // noop — nothing else can report it
  }
}
