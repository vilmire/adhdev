import type { MuxWorkspaceState, PersistedMuxWorkspaceState } from './types.js';

export function serializeWorkspace(workspace: MuxWorkspaceState): PersistedMuxWorkspaceState {
  return {
    workspaceId: workspace.workspaceId,
    title: workspace.title,
    focusedPaneId: workspace.focusedPaneId,
    zoomedPaneId: workspace.zoomedPaneId || null,
    root: workspace.root,
    panes: Object.fromEntries(
      Object.entries(workspace.panes).map(([paneId, pane]) => [
        paneId,
        {
          runtimeId: pane.runtimeId,
          runtimeKey: pane.runtimeKey,
          paneKind: pane.paneKind,
          accessMode: pane.accessMode,
        },
      ]),
    ),
  };
}
