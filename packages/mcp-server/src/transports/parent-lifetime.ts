/**
 * MCP-IPC-LIFETIME: a stdio MCP server exits when the session that spawned it is gone.
 *
 * Every ADHDev MCP server is a stdio child of an agent CLI (a delegated worker's
 * `adhdev mcp --mode ipc --worker`, a coordinator's mesh server, the assistant). The MCP
 * SDK's StdioServerTransport listens only for stdin `data`/`error` — never `end` — and
 * the IPC transport keeps a pooled WebSocket plus the worker's delivery/maintenance
 * timers alive. So when the parent CLI exited (or was killed), its MCP child kept
 * running with nobody left to talk to, one orphan per finished worker session.
 *
 * Two independent signals, either one is enough:
 *   - stdin `end`/`close`: the parent's end of the pipe is gone (normal exit AND
 *     SIGKILL — the kernel closes the pipe either way). This is the primary signal.
 *   - parent pid probe: the original parent no longer exists, or (POSIX) this process
 *     was re-parented. Covers a parent that died while the pipe stays open because a
 *     grandchild inherited it. The probe timer is unref'd and is the ONLY resource this
 *     guard adds to an idle server, so an idle server's footprint is unchanged.
 */

export type ParentGoneReason = 'stdin_end' | 'stdin_close' | 'parent_exited';

export interface ParentLifetimeWatchOptions {
  onGone: (reason: ParentGoneReason) => void;
  stdin?: NodeJS.ReadableStream;
  /** Current parent pid (test seam; defaults to process.ppid). */
  readPpid?: () => number;
  /** Whether a pid still exists (test seam; defaults to a signal-0 probe). */
  isAlive?: (pid: number) => boolean;
  pollMs?: number;
}

export const PARENT_LIFETIME_POLL_MS = 5_000;
export const PARENT_LIFETIME_SHUTDOWN_GRACE_MS = 5_000;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return err?.code === 'EPERM';
  }
}

/** Watch for the parent session going away; fires `onGone` at most once. Returns a stop function. */
export function watchParentLifetime(opts: ParentLifetimeWatchOptions): () => void {
  const stdin = opts.stdin ?? process.stdin;
  const readPpid = opts.readPpid ?? (() => process.ppid);
  const isAlive = opts.isAlive ?? pidIsAlive;
  const initialPpid = readPpid();
  let fired = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const onEnd = () => fire('stdin_end');
  const onClose = () => fire('stdin_close');
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    stdin.off('end', onEnd);
    stdin.off('close', onClose);
  };
  function fire(reason: ParentGoneReason) {
    if (fired) return;
    fired = true;
    stop();
    opts.onGone(reason);
  }
  stdin.on('end', onEnd);
  stdin.on('close', onClose);
  // pid 0/1 as the initial parent means we were already orphaned (or are init's child
  // by design) — the pid probe has nothing meaningful to watch; stdin still decides.
  if (initialPpid > 1) {
    timer = setInterval(() => {
      const current = readPpid();
      if (current !== initialPpid || !isAlive(initialPpid)) fire('parent_exited');
    }, opts.pollMs ?? PARENT_LIFETIME_POLL_MS);
    timer.unref?.();
  }
  return stop;
}

/**
 * Install the lifetime guard on a running stdio MCP server: when the parent session is
 * gone, run `shutdown` (bounded by a grace period so a hung flush cannot keep the orphan
 * alive) and exit 0.
 */
export function exitWhenParentGone(opts: {
  label: string;
  shutdown: () => Promise<unknown> | unknown;
  graceMs?: number;
  exit?: (code: number) => void;
  watch?: Omit<ParentLifetimeWatchOptions, 'onGone'>;
}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  return watchParentLifetime({
    ...(opts.watch ?? {}),
    onGone: (reason) => {
      process.stderr.write(`[adhdev-mcp] ${opts.label}: parent session gone (${reason}) — shutting down.\n`);
      const grace = new Promise<void>(resolve => {
        const t = setTimeout(resolve, opts.graceMs ?? PARENT_LIFETIME_SHUTDOWN_GRACE_MS);
        t.unref?.();
      });
      let shutdown: Promise<unknown>;
      try {
        shutdown = Promise.resolve(opts.shutdown());
      } catch {
        shutdown = Promise.resolve();
      }
      void Promise.race([shutdown.catch(() => undefined), grace]).finally(() => exit(0));
    },
  });
}
