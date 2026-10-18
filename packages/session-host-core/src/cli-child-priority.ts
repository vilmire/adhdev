import * as os from 'node:os';
import { hiddenSpawn } from './process/hidden-spawn.js';

/** Relative POSIX niceness adjustment for newly spawned agent workloads. */
export const CLI_CHILD_NICE_INCREMENT = 10;
/** Set to "0" in the daemon environment (or launch env) to disable lowering. */
export const CLI_CHILD_NICE_ENV = 'ADHDEV_CLI_CHILD_NICE';
/** Optional Darwin CPU + I/O background policy, in addition to baseline nice. */
export const CLI_CHILD_SCHEDULING_ENV = 'ADHDEV_CLI_CHILD_SCHEDULING';

function setDarwinBackground(pid: number, onFailure: (error: unknown) => void): void {
  // A short control helper stays normal priority. Do not block the IPC owner.
  const task = hiddenSpawn('/usr/sbin/taskpolicy', ['-b', '-p', String(pid)], { stdio: 'ignore' });
  task.once('error', onFailure);
  task.once('exit', (code, signal) => {
    if (code !== 0) onFailure(new Error(`taskpolicy exited with ${signal ?? code}`));
  });
}

interface PriorityDependencies {
  platform: NodeJS.Platform;
  getPriority: typeof os.getPriority;
  setPriority: typeof os.setPriority;
  setDarwinBackground?: typeof setDarwinBackground;
}

/** Separate policy instances are useful for platform/error tests. */
export function createCliChildPriorityPolicy(deps: PriorityDependencies = {
  platform: process.platform,
  getPriority: os.getPriority,
  setPriority: os.setPriority,
  setDarwinBackground,
}) {
  let failureLogged = false;
  return function spawnCliChild<T extends { readonly pid?: number }>(
    spawnChild: () => T,
    env: NodeJS.ProcessEnv = process.env,
    logInfo: (message: string) => void = console.info,
  ): T {
    const child = spawnChild();
    const pid = child.pid;
    // Never pass 0/undefined to setPriority: that would lower the IPC owner!
    if (env[CLI_CHILD_NICE_ENV] === '0' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return child;
    const onFailure = (error: unknown) => {
      if (!failureLogged) {
        failureLogged = true;
        const detail = error instanceof Error ? error.message : String(error);
        logInfo(`[cli-child-priority] Could not apply CLI child scheduling (pid ${pid}); continuing: ${detail}`);
      }
    };
    try {
      const priority = deps.platform === 'win32'
        ? os.constants.priority.PRIORITY_BELOW_NORMAL
        : Math.min(19, deps.getPriority(pid) + CLI_CHILD_NICE_INCREMENT);
      deps.setPriority(pid, priority);
    } catch (error) {
      // EACCES/EPERM (policy/permissions) and ESRCH (already exited), as well
      // as unexpected OS errors, are best effort. Never fail a CLI launch.
      onFailure(error);
    }
    if (deps.platform === 'darwin' && env[CLI_CHILD_SCHEDULING_ENV] === 'darwin-bg') {
      try { deps.setDarwinBackground?.(pid, onFailure); } catch (error) { onFailure(error); }
    }
    return child;
  };
}

/**
 * Only wrap agent workload spawns. Keep daemon, session-host IPC, P2P signal
 * workers, version probes and git helpers at their existing priority.
 *
 * node-pty has no pre-spawn priority hook. Apply immediately on return, before
 * registering listeners/doing other work. There is a spawn-to-setPriority race:
 * a child can run (and fork) before this call. Later descendants inherit nice
 * on POSIX; early descendants are not retroactively changed. Windows creation
 * and ConPTY inheritance require verification on the MainPC.
 * Optional darwin-bg is applied asynchronously by taskpolicy after nice; the
 * extra helper startup adds a further race before the background class takes
 * effect. It also throttles I/O, so nice alone remains the default.
 */
export const spawnCliChild = createCliChildPriorityPolicy();
