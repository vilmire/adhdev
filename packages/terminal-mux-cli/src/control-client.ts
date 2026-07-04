import {
  withAdhMuxControlClient,
  type AdhMuxControlRequest,
} from '@adhdev/terminal-mux-control/control-socket';
import type { SessionHostResponse } from '@adhdev/session-host-core';
import { CONTROL_SOCKET_POLL_MS, CONTROL_SOCKET_TIMEOUT_MS } from './constants.js';

function isControlSocketUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|ECONNREFUSED|EPIPE|socket/i.test(message);
}

export async function requestWorkspaceControl<T = unknown>(
  workspaceName: string,
  request: AdhMuxControlRequest,
): Promise<SessionHostResponse<T> | null> {
  try {
    return await withAdhMuxControlClient(workspaceName, (client) => client.request<T>(request));
  } catch (error) {
    if (isControlSocketUnavailable(error)) return null;
    throw error;
  }
}

export async function waitForWorkspaceControlReady(
  workspaceName: string,
  timeoutMs = CONTROL_SOCKET_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await withAdhMuxControlClient(workspaceName, async (client) => {
        await client.connect();
      });
      return;
    } catch (error) {
      if (!isControlSocketUnavailable(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_SOCKET_POLL_MS));
    }
  }
  throw new Error(`Workspace control socket did not become ready within ${timeoutMs}ms`);
}
