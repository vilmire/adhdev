import type { SessionHostResponse } from '@adhdev/session-host-core';
import {
  AdhMuxControlClient,
  withAdhMuxControlClient,
  type AdhMuxControlEvent,
  type AdhMuxControlRequest,
} from './control-socket.js';
import { getWorkspaceControlEndpoint, type WorkspaceControlEndpoint } from './storage.js';

function isControlSocketUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|ECONNREFUSED|EPIPE|socket/i.test(message);
}

export interface AdhMuxSocketInfo {
  workspaceName: string;
  live: boolean;
  endpoint: WorkspaceControlEndpoint;
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

export async function getWorkspaceState<T = unknown>(workspaceName: string): Promise<SessionHostResponse<T> | null> {
  return requestWorkspaceControl<T>(workspaceName, { type: 'workspace_state' });
}

export async function getWorkspaceSocketInfo(workspaceName: string): Promise<AdhMuxSocketInfo> {
  const endpoint = getWorkspaceControlEndpoint(workspaceName);
  const client = new AdhMuxControlClient(workspaceName);
  try {
    await client.connect();
    return { workspaceName, live: true, endpoint };
  } catch (error) {
    if (isControlSocketUnavailable(error)) {
      return { workspaceName, live: false, endpoint };
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

export {
  AdhMuxControlClient,
  withAdhMuxControlClient,
  type AdhMuxControlEvent,
  type AdhMuxControlRequest,
};
