import { type MuxAxis, type MuxWorkspaceState } from '@adhdev/terminal-mux-core';
import { normalizeLayoutPreset } from './arg-parsing.js';
import { requestWorkspaceControl } from './control-client.js';
import { resolvePaneTarget, withWorkspace } from './workspace-context.js';

export async function selectPane(workspaceName: string, paneTarget: string): Promise<void> {
  const live = await requestWorkspaceControl(workspaceName, { type: 'select_pane', payload: { paneTarget } });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    const next = await mux.focusPane(workspace.workspaceId, paneId);
    workspace = next;
    save();
  });
}

export async function killPane(workspaceName: string, paneTarget: string): Promise<void> {
  const live = await requestWorkspaceControl<{ workspaceDeleted?: boolean }>(workspaceName, {
    type: 'kill_pane',
    payload: { paneTarget },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save, storage }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    const next = await mux.closePane(workspace.workspaceId, paneId);
    if (!next) {
      storage.deleteWorkspace(workspaceName);
      return;
    }
    workspace = next;
    save();
  });
}

export async function replacePane(workspaceName: string, paneTarget: string | undefined, runtimeTarget: string): Promise<void> {
  const live = await requestWorkspaceControl(workspaceName, {
    type: 'replace_pane',
    payload: { paneTarget, runtimeTarget },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    workspace = await mux.replacePaneRuntime(workspace.workspaceId, paneId, runtimeTarget, {
      readOnly: false,
      takeover: false,
    });
    save();
  });
}

export async function resizePane(workspaceName: string, paneTarget: string | undefined, args: string[]): Promise<void> {
  let direction: 'left' | 'right' | 'up' | 'down' | null = null;
  let amount = 0.05;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-L') direction = 'left';
    else if (arg === '-R') direction = 'right';
    else if (arg === '-U') direction = 'up';
    else if (arg === '-D') direction = 'down';
    else if (arg === '--amount' && args[i + 1]) {
      amount = Number.parseFloat(args[i + 1]!) || amount;
      i += 1;
    } else {
      const parsed = Number.parseFloat(arg);
      if (!Number.isNaN(parsed)) {
        amount = parsed;
      }
    }
  }
  if (!direction) {
    throw new Error('One of -L, -R, -U, -D is required');
  }
  const live = await requestWorkspaceControl(workspaceName, {
    type: 'resize_pane',
    payload: { paneTarget, direction, amount },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    workspace = await mux.resizeLayoutPane(workspace.workspaceId, paneId, direction, amount);
    save();
  });
}

export async function selectLayout(workspaceName: string, layoutName: string): Promise<void> {
  const preset = normalizeLayoutPreset(layoutName);
  const live = await requestWorkspaceControl(workspaceName, {
    type: 'select_layout',
    payload: { layoutName: preset },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    workspace = preset === 'balanced'
      ? await mux.rebalanceWorkspaceLayout(workspace.workspaceId)
      : await mux.applyLayoutPreset(workspace.workspaceId, preset);
    save();
  });
}

export async function swapPane(workspaceName: string, firstTarget: string, secondTarget: string): Promise<void> {
  const live = await requestWorkspaceControl(workspaceName, {
    type: 'swap_panes',
    payload: { firstPaneTarget: firstTarget, secondPaneTarget: secondTarget },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const firstPaneId = resolvePaneTarget(workspace, firstTarget);
    const secondPaneId = resolvePaneTarget(workspace, secondTarget);
    workspace = await mux.swapPanePositions(workspace.workspaceId, firstPaneId, secondPaneId);
    save();
  });
}

export async function zoomPane(workspaceName: string, paneTarget?: string): Promise<void> {
  const live = await requestWorkspaceControl(workspaceName, { type: 'zoom_pane', payload: { paneTarget } });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    workspace = await mux.togglePaneZoom(workspace.workspaceId, paneId);
    save();
  });
}

export async function splitWindow(workspaceName: string, args: string[]): Promise<void> {
  let axis: MuxAxis = 'vertical';
  let mirror = false;
  const remaining: string[] = [];
  for (const arg of args) {
    if (arg === '-h') {
      axis = 'horizontal';
      continue;
    }
    if (arg === '-v') {
      axis = 'vertical';
      continue;
    }
    if (arg === '-m' || arg === '--mirror') {
      mirror = true;
      continue;
    }
    remaining.push(arg);
  }

  const live = await requestWorkspaceControl(workspaceName, {
    type: 'split_window',
    payload: { axis, mirror, runtimeKey: remaining[0] },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    let next: MuxWorkspaceState;
    if (mirror) {
      next = await mux.splitWorkspaceMirror(
        workspace.workspaceId,
        workspace.focusedPaneId,
        workspace.focusedPaneId,
        axis,
      );
    } else {
      const runtimeKey = remaining[0];
      if (!runtimeKey) {
        throw new Error('Runtime key is required unless --mirror is used');
      }
      next = await mux.splitWorkspacePane(
        workspace.workspaceId,
        workspace.focusedPaneId,
        runtimeKey,
        { axis, readOnly: false },
      );
    }
    workspace = next;
    save();
  });
}

export async function sendKeys(workspaceName: string, paneTarget: string | undefined, textParts: string[]): Promise<void> {
  const text = textParts.join(' ');
  const live = await requestWorkspaceControl(workspaceName, {
    type: 'send_keys',
    payload: { paneTarget, text },
  });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    await mux.sendInput(paneId, text);
  });
}
