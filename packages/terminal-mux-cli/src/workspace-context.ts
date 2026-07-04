import { SessionHostMuxClient, type MuxWorkspaceState } from '@adhdev/terminal-mux-core';
import { TerminalMuxStorage } from '@adhdev/terminal-mux-control/storage';
import { SESSION_HOST_APP_NAME } from './constants.js';
import { ensureSessionHostReady } from './session-host.js';

export function resolvePaneTarget(workspace: MuxWorkspaceState, paneTarget?: string): string {
  if (!paneTarget) {
    return workspace.focusedPaneId;
  }
  if (workspace.panes[paneTarget]) {
    return paneTarget;
  }
  const paneIds = Object.keys(workspace.panes);
  const index = Number.parseInt(paneTarget, 10);
  if (!Number.isNaN(index) && index >= 0 && index < paneIds.length) {
    return paneIds[index]!;
  }
  throw new Error(`Unknown pane target: ${paneTarget}`);
}

export async function withWorkspace<T>(
  workspaceName: string,
  fn: (ctx: {
    mux: SessionHostMuxClient;
    workspace: MuxWorkspaceState;
    save: () => void;
    storage: TerminalMuxStorage;
  }) => Promise<T>,
): Promise<T> {
  await ensureSessionHostReady();
  const storage = new TerminalMuxStorage();
  const savedWorkspace = storage.loadWorkspace(workspaceName);
  if (!savedWorkspace) {
    throw new Error(`Workspace not found: ${workspaceName}`);
  }
  const mux = new SessionHostMuxClient({ appName: SESSION_HOST_APP_NAME });
  await mux.connect();
  let workspace = await mux.restoreWorkspace(savedWorkspace);
  const save = () => {
    storage.saveWorkspace(workspaceName, mux.serializeWorkspace(workspace.workspaceId));
  };
  try {
    return await fn({
      mux,
      get workspace() {
        return workspace;
      },
      set workspace(next: MuxWorkspaceState) {
        workspace = next;
      },
      save,
      storage,
    } as {
      mux: SessionHostMuxClient;
      workspace: MuxWorkspaceState;
      save: () => void;
      storage: TerminalMuxStorage;
    });
  } finally {
    await mux.close();
  }
}
