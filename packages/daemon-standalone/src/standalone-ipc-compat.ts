/**
 * Optional standalone IPC compatibility server (ws://127.0.0.1:19222/ipc,
 * `ADHDEV_STANDALONE_ENABLE_IPC=1`). Moved out of index.ts (wiring-unification B5).
 *
 * Changes on the way (B5):
 *  - commands go through `hostRuntime.execute(…, 'ipc')`, so an MCP command
 *    now invalidates the dashboard topics like every other entry (C11 —
 *    checklist item 8), instead of a bare `router.execute`;
 *  - the welcome reads `buildDaemonHealthSummary` (registry + CDP map) instead
 *    of `collectAllStates()` (ipc-load-audit row 16);
 *  - `/api/v1/status` uses the host's one snapshot builder, which carries the
 *    git summary the old inline builder omitted.
 */

import {
  LOG,
  DEFAULT_DAEMON_PORT,
  buildDaemonHealthSummary,
  startLocalIpcServer,
  type DaemonHostRuntime,
  type LocalIpcServerHandle,
} from '@adhdev/daemon-core';

export function standaloneIpcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.ADHDEV_STANDALONE_ENABLE_IPC || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export async function startStandaloneIpcCompatServer(opts: {
  pkgVersion: string;
  host(): DaemonHostRuntime | null;
}): Promise<LocalIpcServerHandle | null> {
  try {
    return await startLocalIpcServer({
      port: DEFAULT_DAEMON_PORT,
      buildStatusPayload: () => {
        const host = opts.host();
        return host ? host.buildSnapshot('metadata') as unknown as Record<string, unknown> : null;
      },
      buildWelcomePayload: () => {
        const health = buildDaemonHealthSummary(opts.host()?.runtime.components);
        return {
          daemonVersion: opts.pkgVersion,
          serverConnected: false, // standalone never has a cloud server connection
          cdpConnected: health.cdpConnected,
          localPort: DEFAULT_DAEMON_PORT,
          cliAgents: health.cliSessionIds,
          sessionHostConnected: false,
          mode: 'standalone',
        };
      },
      handleCommand: async ({ command, args }) => {
        const host = opts.host();
        if (!host) return { success: false, error: 'daemon not ready' };
        // Standalone does not implement mesh_relay_command (single-machine only).
        if (command === 'mesh_relay_command') {
          return {
            success: false,
            error: 'mesh_relay_command not supported in standalone mode (single-machine only)',
          };
        }
        const result = await host.execute(command, args, 'ipc');
        const errVal = (result as any)?.error;
        return {
          success: !!result?.success,
          result,
          error: result?.success
            ? undefined
            : (typeof errVal === 'string' ? errVal : errVal ? String(errVal) : undefined),
        };
      },
    });
  } catch (e: any) {
    const msg = e?.code === 'EADDRINUSE'
      ? `Port ${DEFAULT_DAEMON_PORT} already in use; standalone IPC compatibility mode disabled for this run.`
      : `Failed to start standalone IPC compatibility server: ${e?.message || e}`;
    LOG.warn('IPC', msg);
    return null;
  }
}
