import {
  resolveRuntimeRecord,
  SessionHostClient,
  type SessionHostRecord,
} from '@adhdev/session-host-core';
import {
  withAdhMuxControlClient,
  type AdhMuxControlEvent,
} from '@adhdev/terminal-mux-control/control-socket';
import { getWorkspaceControlEndpoint, TerminalMuxStorage } from '@adhdev/terminal-mux-control/storage';
import { toWorkspaceRef } from '@adhdev/terminal-mux-control/storage';
import { type MuxWorkspaceState } from '@adhdev/terminal-mux-core';
import { copyTextToClipboard } from './clipboard.js';
import { searchPaneText, type PaneSearchMatch } from './search.js';
import { formatMuxRuntimeListHeader, formatMuxRuntimeListLine } from './runtime-list.js';
import { SESSION_HOST_APP_NAME } from './constants.js';
import { ensureSessionHostReady } from './session-host.js';
import { requestWorkspaceControl, waitForWorkspaceControlReady } from './control-client.js';
import { resolvePaneTarget, withWorkspace } from './workspace-context.js';
import type { CommandFlags, CopyPaneOptions } from './types.js';

export async function listRuntimes(flags: CommandFlags = { json: false }): Promise<void> {
  await ensureSessionHostReady();
  const client = new SessionHostClient({ appName: SESSION_HOST_APP_NAME });
  const result = await client.request<SessionHostRecord[]>({ type: 'list_sessions' });
  if (!result.success || !result.result) {
    throw new Error(result.error || 'Failed to list runtimes');
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(result.result, null, 2));
    process.stdout.write('\n');
    await client.close();
    return;
  }
  process.stdout.write(`${formatMuxRuntimeListHeader()}\n`);
  for (const record of result.result) {
    process.stdout.write(`${formatMuxRuntimeListLine(record)}\n`);
  }
  await client.close();
}

export async function listWorkspaces(flags: CommandFlags = { json: false }): Promise<void> {
  const storage = new TerminalMuxStorage();
  const workspaces = storage.listWorkspaces();
  if (flags.json) {
    process.stdout.write(JSON.stringify(workspaces, null, 2));
    process.stdout.write('\n');
    return;
  }
  for (const workspace of workspaces) {
    process.stdout.write(
      `${workspace.name}\t${workspace.title}\tpanes=${workspace.paneCount}\tupdated=${new Date(workspace.updatedAt).toISOString()}\n`,
    );
  }
}

export async function listSessions(flags: CommandFlags = { json: false }): Promise<void> {
  const storage = new TerminalMuxStorage();
  const sessions = storage.listSessions();
  if (flags.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2));
    process.stdout.write('\n');
    return;
  }
  for (const session of sessions) {
    process.stdout.write(
      `${session.name}\twindows=${session.windowCount}\tactive=${session.activeWindowName}\tupdated=${new Date(session.updatedAt).toISOString()}\n`,
    );
  }
}

export async function listWindows(sessionName: string, flags: CommandFlags = { json: false }): Promise<void> {
  const storage = new TerminalMuxStorage();
  const windows = storage.listSessionWindows(sessionName).map((workspace) => ({
    ...workspace,
    windowName: toWorkspaceRef(workspace.name).windowName,
  }));
  if (flags.json) {
    process.stdout.write(JSON.stringify(windows, null, 2));
    process.stdout.write('\n');
    return;
  }
  for (const window of windows) {
    process.stdout.write(
      `${window.windowName}\tworkspace=${window.name}\tpanes=${window.paneCount}\tupdated=${new Date(window.updatedAt).toISOString()}\n`,
    );
  }
}

export async function printLastWorkspace(flags: CommandFlags = { json: false }): Promise<void> {
  const storage = new TerminalMuxStorage();
  const lastWorkspace = storage.getLastWorkspace();
  if (flags.json) {
    process.stdout.write(JSON.stringify({ lastWorkspace }, null, 2));
    process.stdout.write('\n');
    return;
  }
  if (lastWorkspace) {
    process.stdout.write(`${lastWorkspace}\n`);
  }
}

export async function printWorkspaceTree(flags: CommandFlags = { json: false }): Promise<void> {
  const storage = new TerminalMuxStorage();
  const workspaces = storage.listWorkspaces().map((workspace) => {
    const saved = storage.loadWorkspace(workspace.name);
    return {
      ...workspace,
      focusedPaneId: saved?.focusedPaneId || null,
      zoomedPaneId: saved?.zoomedPaneId || null,
      panes: saved?.panes || {},
    };
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify(workspaces, null, 2));
    process.stdout.write('\n');
    return;
  }
  for (const workspace of workspaces) {
    process.stdout.write(`${workspace.name}\tpanes=${workspace.paneCount}\tfocus=${workspace.focusedPaneId || '-'}\tzoom=${workspace.zoomedPaneId || '-'}\n`);
    for (const [paneId, pane] of Object.entries(workspace.panes || {})) {
      process.stdout.write(`  ${paneId}\t${pane.paneKind}\t${pane.runtimeKey}\t${pane.accessMode}\n`);
    }
  }
}

export async function printWorkspaceState(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
  const live = await requestWorkspaceControl<{
    workspaceName: string;
    workspace: MuxWorkspaceState;
    panes: Array<{ index: number; paneId: string; paneKind: string; runtimeKey: string; accessMode: string; focused: boolean }>;
  }>(workspaceName, { type: 'workspace_state' });
  if (live?.success && live.result) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(live.result, null, 2));
      process.stdout.write('\n');
      return;
    }
    process.stdout.write(
      `${live.result.workspaceName}\tpanes=${live.result.panes.length}\tfocus=${live.result.workspace.focusedPaneId}\tzoom=${live.result.workspace.zoomedPaneId || '-'}\n`,
    );
    return;
  }

  const storage = new TerminalMuxStorage();
  const saved = storage.loadWorkspace(workspaceName);
  if (!saved) {
    throw new Error(`Workspace not found: ${workspaceName}`);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ workspaceName, workspace: saved }, null, 2));
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(
    `${workspaceName}\tpanes=${Object.keys(saved.panes || {}).length}\tfocus=${saved.focusedPaneId}\tzoom=${saved.zoomedPaneId || '-'}\n`,
  );
}

export async function printSocketInfo(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
  const endpoint = getWorkspaceControlEndpoint(workspaceName);
  const live = await requestWorkspaceControl(workspaceName, { type: 'workspace_state' });
  const result = {
    workspaceName,
    endpoint,
    live: !!live?.success,
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${workspaceName}\t${endpoint.path}\t${result.live ? 'live' : 'offline'}\n`);
}

export async function controlWorkspace(
  workspaceName: string,
  requestType: string,
  payloadRaw: string | undefined,
  flags: CommandFlags = { json: false },
): Promise<void> {
  const payload = payloadRaw ? (JSON.parse(payloadRaw) as Record<string, unknown>) : {};
  const response = await requestWorkspaceControl(workspaceName, { type: requestType, payload });
  if (!response) {
    throw new Error(`Workspace control socket unavailable: ${workspaceName}`);
  }
  if (flags.json || true) {
    process.stdout.write(JSON.stringify(response, null, 2));
    process.stdout.write('\n');
    return;
  }
}

export async function streamWorkspaceEvents(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
  await waitForWorkspaceControlReady(workspaceName);
  await withAdhMuxControlClient(workspaceName, async (client) => {
    await client.connect();
    const writeEvent = (event: AdhMuxControlEvent) => {
      if (flags.json) {
        process.stdout.write(JSON.stringify(event, null, 2));
        process.stdout.write('\n');
        return;
      }
      process.stdout.write(`${event.type}\t${JSON.stringify(event.payload)}\n`);
    };
    const unsub = client.onEvent(writeEvent);
    const initial = await client.request<{ workspaceName: string; workspace: MuxWorkspaceState }>({ type: 'workspace_state' });
    if (initial.success && initial.result) {
      writeEvent({ type: 'workspace_update', payload: initial.result as unknown as Record<string, unknown> });
    }
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 1000);
      const onSigint = () => {
        clearInterval(keepAlive);
        process.off('SIGINT', onSigint);
        unsub();
        resolve();
      };
      process.on('SIGINT', onSigint);
    });
  });
}

export async function snapshotRuntime(target: string): Promise<void> {
  await ensureSessionHostReady();
  const client = new SessionHostClient({ appName: SESSION_HOST_APP_NAME });
  const list = await client.request<SessionHostRecord[]>({ type: 'list_sessions' });
  if (!list.success || !list.result) throw new Error(list.error || 'Failed to list runtimes');
  const record = resolveRuntimeRecord(list.result, target);
  const snapshot = await client.request<{ seq: number; text: string }>({
    type: 'get_snapshot',
    payload: { sessionId: record.sessionId },
  });
  if (!snapshot.success || !snapshot.result) throw new Error(snapshot.error || 'Failed to get snapshot');
  process.stdout.write(snapshot.result.text);
  await client.close();
}

export async function listPanes(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
  const live = await requestWorkspaceControl<any[]>(workspaceName, { type: 'list_panes' });
  if (live?.success && live.result) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(live.result, null, 2));
      process.stdout.write('\n');
      return;
    }
    for (const pane of live.result) {
      process.stdout.write(
        `${pane.index}\t${pane.paneId}\t${pane.paneKind}\t${pane.runtimeKey}\t${pane.accessMode}\t${pane.focused ? 'focused' : ''}\n`,
      );
    }
    return;
  }
  await withWorkspace(workspaceName, async ({ workspace }) => {
    const panes = Object.keys(workspace.panes).map((paneId, index) => {
      const pane = workspace.panes[paneId]!;
      return {
        index,
        paneId,
        paneKind: pane.paneKind,
        runtimeKey: pane.runtimeKey,
        accessMode: pane.accessMode,
        focused: workspace.focusedPaneId === paneId,
      };
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(panes, null, 2));
      process.stdout.write('\n');
      return;
    }
    Object.keys(workspace.panes).forEach((paneId, index) => {
      const pane = workspace.panes[paneId]!;
      process.stdout.write(
        `${index}\t${paneId}\t${pane.paneKind}\t${pane.runtimeKey}\t${pane.accessMode}\t${workspace.focusedPaneId === paneId ? 'focused' : ''}\n`,
      );
    });
  });
}

export async function capturePane(workspaceName: string, paneTarget?: string, flags: CommandFlags = { json: false }): Promise<void> {
  const live = await requestWorkspaceControl<{ paneId: string; text: string }>(workspaceName, {
    type: 'capture_pane',
    payload: { paneTarget },
  });
  if (live?.success && live.result) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(live.result, null, 2));
      process.stdout.write('\n');
      return;
    }
    process.stdout.write(live.result.text);
    return;
  }
  await withWorkspace(workspaceName, async ({ workspace }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    const text = workspace.panes[paneId]!.viewport.text;
    if (flags.json) {
      process.stdout.write(JSON.stringify({ paneId, text }, null, 2));
      process.stdout.write('\n');
      return;
    }
    process.stdout.write(text);
  });
}

export async function copyPane(workspaceName: string, paneTarget: string | undefined, options: CopyPaneOptions): Promise<void> {
  const live = await requestWorkspaceControl<{ paneId: string; copiedToClipboard: boolean; output: string | null; text?: string }>(
    workspaceName,
    {
      type: 'copy_pane',
      payload: { paneTarget, clipboard: options.clipboard, output: options.output },
    },
  );
  if (live?.success && live.result) {
    if (options.json) {
      process.stdout.write(JSON.stringify(live.result, null, 2));
      process.stdout.write('\n');
      return;
    }
    if (!options.output && !options.clipboard && live.result.text) {
      process.stdout.write(live.result.text);
    }
    return;
  }
  await withWorkspace(workspaceName, async ({ workspace }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    const text = workspace.panes[paneId]!.viewport.text;
    if (options.output) {
      const { writeFileSync } = await import('fs');
      writeFileSync(options.output, text, 'utf8');
    }
    if (options.clipboard) {
      copyTextToClipboard(text);
    }
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ paneId, copiedToClipboard: options.clipboard, output: options.output || null }, null, 2),
      );
      process.stdout.write('\n');
      return;
    }
    if (!options.output && !options.clipboard) {
      process.stdout.write(text);
    }
  });
}

export async function searchPane(
  workspaceName: string,
  paneTarget: string | undefined,
  query: string,
  flags: CommandFlags = { json: false },
): Promise<void> {
  const live = await requestWorkspaceControl<{ paneId: string; query: string; count: number; matches: PaneSearchMatch[] }>(
    workspaceName,
    { type: 'search_pane', payload: { paneTarget, query } },
  );
  if (live?.success && live.result) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(live.result, null, 2));
      process.stdout.write('\n');
      return;
    }
    for (const match of live.result.matches) {
      process.stdout.write(`${match.line}:${match.column}\t${match.preview}\n`);
    }
    return;
  }
  await withWorkspace(workspaceName, async ({ workspace }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    const matches = searchPaneText(workspace.panes[paneId]!.viewport.text, query);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ paneId, query, count: matches.length, matches }, null, 2));
      process.stdout.write('\n');
      return;
    }
    for (const match of matches) {
      process.stdout.write(`${match.line}:${match.column}\t${match.preview}\n`);
    }
  });
}
