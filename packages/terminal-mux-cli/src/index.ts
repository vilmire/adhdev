#!/usr/bin/env node
import { spawn } from 'child_process';
import {
  getDefaultSessionHostEndpoint,
  resolveRuntimeRecord,
  SessionHostClient,
  type SessionHostResponse,
  type SessionHostRecord,
} from '@adhdev/session-host-core';
import { copyTextToClipboard } from './clipboard.js';
import {
  createAdhMuxControlServer,
  withAdhMuxControlClient,
  type AdhMuxControlEvent,
  type AdhMuxControlRequest,
} from '@adhdev/terminal-mux-control/control-socket';
import { computePaneRects, renderWorkspace } from './render.js';
import { searchPaneText, type PaneSearchMatch } from './search.js';
import { getWorkspaceControlEndpoint, TerminalMuxStorage } from '@adhdev/terminal-mux-control/storage';
import { buildWorkspaceName, sanitizeWorkspaceName, toWorkspaceRef } from '@adhdev/terminal-mux-control/storage';
import {
  SessionHostMuxClient,
  type MuxAxis,
  type MuxControllerEvent,
  type MuxWorkspaceState,
} from '@adhdev/terminal-mux-core';

interface OpenCommandOptions {
  runtimeTargets: string[];
  workspaceName?: string;
  readOnly: boolean;
  takeover: boolean;
}

interface SessionCommandTarget {
  workspaceName: string;
  remainingArgs: string[];
}

interface PaneCommandTarget extends SessionCommandTarget {
  paneTarget?: string;
}

type UiMode = 'normal' | 'prefix' | 'prompt' | 'chooser' | 'copy';
type ChooserAction = 'split' | 'replace';
type PromptMode = 'runtime' | 'search';

interface PaneActivityState {
  kind: 'output' | 'done' | 'owner';
  count: number;
}

interface CommandFlags {
  json: boolean;
}

interface CopyPaneOptions {
  json: boolean;
  clipboard: boolean;
  output?: string;
}

type LayoutPreset = 'even' | 'main-vertical' | 'main-horizontal' | 'tiled';

const STARTUP_TIMEOUT_MS = 8000;
const STARTUP_POLL_MS = 200;
const SESSION_HOST_APP_NAME = process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev';
const CONTROL_SOCKET_TIMEOUT_MS = 4000;
const CONTROL_SOCKET_POLL_MS = 150;

function usage(): never {
  console.error(
    'Usage: adhmux <list|sessions|workspaces|windows|last-session|tree|state|socket-info|events|control|snapshot|open|rename-workspace|delete-workspace|new-session|attach-session|kill-session|rename-session|has-session|new-window|select-window|rename-window|kill-window|ls|list-panes|capture-pane|copy-pane|search-pane|select-pane|replace-pane|split-window|resize-pane|select-layout|swap-pane|zoom-pane|kill-pane|send-keys> [options] [runtimeKey...]',
  );
  process.exit(1);
}

function normalizeLayoutPreset(layoutName: string): LayoutPreset | 'balanced' {
  switch (layoutName) {
    case 'even':
    case 'even-horizontal':
    case 'even-vertical':
      return 'even';
    case 'balanced':
      return 'balanced';
    case 'tiled':
      return 'tiled';
    case 'main-vertical':
    case 'main-v':
      return 'main-vertical';
    case 'main-horizontal':
    case 'main-h':
      return 'main-horizontal';
    default:
      throw new Error(`Unsupported layout: ${layoutName}`);
  }
}

function parseCommandFlags(args: string[]): { flags: CommandFlags; rest: string[] } {
  const rest: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    rest.push(arg);
  }
  return { flags: { json }, rest };
}

function isControlSocketUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|ECONNREFUSED|EPIPE|socket/i.test(message);
}

async function requestWorkspaceControl<T = unknown>(
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

async function waitForWorkspaceControlReady(workspaceName: string, timeoutMs = CONTROL_SOCKET_TIMEOUT_MS): Promise<void> {
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

async function listRuntimes(flags: CommandFlags = { json: false }): Promise<void> {
  await ensureSessionHostReady();
  const client = new SessionHostClient({ appName: 'adhdev' });
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
  for (const record of result.result) {
    process.stdout.write(
      `${record.runtimeKey}\t${record.lifecycle}\t${record.workspaceLabel}\t${record.writeOwner ? `${record.writeOwner.ownerType}:${record.writeOwner.clientId}` : 'none'}\n`,
    );
  }
  await client.close();
}

async function listWorkspaces(flags: CommandFlags = { json: false }): Promise<void> {
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

async function listSessions(flags: CommandFlags = { json: false }): Promise<void> {
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

async function listWindows(sessionName: string, flags: CommandFlags = { json: false }): Promise<void> {
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

async function printLastWorkspace(flags: CommandFlags = { json: false }): Promise<void> {
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

async function printWorkspaceTree(flags: CommandFlags = { json: false }): Promise<void> {
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

async function printWorkspaceState(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
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

async function printSocketInfo(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
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

async function controlWorkspace(
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

async function streamWorkspaceEvents(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
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

async function renameWorkspace(fromName: string, toName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  storage.renameWorkspace(fromName, toName);
}

async function deleteWorkspace(name: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  storage.deleteWorkspace(name);
}

async function hasWorkspace(name: string): Promise<boolean> {
  const storage = new TerminalMuxStorage();
  return storage.loadWorkspace(name) !== null;
}

async function hasSession(name: string): Promise<boolean> {
  const storage = new TerminalMuxStorage();
  return storage.listSessionWindows(name).length > 0;
}

async function renameSession(fromName: string, toName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const windows = storage.listSessionWindows(fromName);
  if (windows.length === 0) {
    throw new Error(`Session not found: ${fromName}`);
  }
  for (const window of windows) {
    const ref = toWorkspaceRef(window.name);
    storage.renameWorkspace(window.name, buildWorkspaceName(toName, ref.windowName));
  }
}

async function killSession(name: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const windows = storage.listSessionWindows(name);
  if (windows.length === 0) {
    throw new Error(`Session not found: ${name}`);
  }
  for (const window of windows) {
    storage.deleteWorkspace(window.name);
  }
}

async function newWindow(sessionName: string, windowName: string | undefined, runtimeTargets: string[]): Promise<void> {
  if (runtimeTargets.length === 0) {
    throw new Error('At least one runtime target is required');
  }
  const resolvedWindowName = sanitizeWorkspaceName(windowName || runtimeTargets[0]);
  await openWorkspace({
    workspaceName: buildWorkspaceName(sessionName, resolvedWindowName),
    runtimeTargets,
    readOnly: false,
    takeover: false,
  });
}

async function selectWindow(sessionName: string, windowName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const workspaceName = storage.resolveSessionWindowWorkspace(sessionName, windowName);
  if (!workspaceName) {
    throw new Error(`Window not found: ${sessionName}/${windowName}`);
  }
  await openWorkspace({
    workspaceName,
    runtimeTargets: [],
    readOnly: false,
    takeover: false,
  });
}

async function renameWindow(sessionName: string, fromWindowName: string, toWindowName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const fromWorkspace = storage.resolveSessionWindowWorkspace(sessionName, fromWindowName);
  if (!fromWorkspace) {
    throw new Error(`Window not found: ${sessionName}/${fromWindowName}`);
  }
  storage.renameWorkspace(fromWorkspace, buildWorkspaceName(sessionName, toWindowName));
}

async function killWindow(sessionName: string, windowName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const workspaceName = storage.resolveSessionWindowWorkspace(sessionName, windowName);
  if (!workspaceName) {
    throw new Error(`Window not found: ${sessionName}/${windowName}`);
  }
  storage.deleteWorkspace(workspaceName);
}

async function snapshotRuntime(target: string): Promise<void> {
  await ensureSessionHostReady();
  const client = new SessionHostClient({ appName: 'adhdev' });
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

function parseOpenArgs(args: string[]): OpenCommandOptions {
  const runtimeTargets: string[] = [];
  let workspaceName: string | undefined;
  let readOnly = false;
  let takeover = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--workspace' || arg === '-w') {
      workspaceName = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--read-only') {
      readOnly = true;
      continue;
    }
    if (arg === '--takeover') {
      takeover = true;
      continue;
    }
    runtimeTargets.push(arg);
  }

  return { runtimeTargets, workspaceName, readOnly, takeover };
}

function parseSessionTargetArgs(args: string[]): SessionCommandTarget {
  let workspaceName = '';
  const remainingArgs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '-t' || arg === '-s') {
      workspaceName = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (!workspaceName) {
      workspaceName = arg;
      continue;
    }
    remainingArgs.push(arg);
  }
  if (!workspaceName) {
    throw new Error('Workspace name is required');
  }
  return { workspaceName, remainingArgs };
}

function parsePaneTargetArgs(args: string[]): PaneCommandTarget {
  const session = parseSessionTargetArgs(args);
  let paneTarget: string | undefined;
  const remainingArgs: string[] = [];
  for (let i = 0; i < session.remainingArgs.length; i += 1) {
    const arg = session.remainingArgs[i];
    if (!arg) continue;
    if (arg === '-p') {
      paneTarget = session.remainingArgs[i + 1];
      i += 1;
      continue;
    }
    remainingArgs.push(arg);
  }
  return {
    workspaceName: session.workspaceName,
    paneTarget,
    remainingArgs,
  };
}

function resolvePaneTarget(workspace: MuxWorkspaceState, paneTarget?: string): string {
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

async function withWorkspace<T>(
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
  const mux = new SessionHostMuxClient({ appName: 'adhdev' });
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

async function canConnect(): Promise<boolean> {
  const client = new SessionHostClient({ endpoint: getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME) });
  try {
    await client.connect();
    await client.close();
    return true;
  } catch {
    return false;
  }
}

async function waitForSessionHostReady(timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect()) return;
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
  throw new Error(`Session host did not become ready within ${timeoutMs}ms`);
}

function resolveSessionHostEntry(): string {
  return require.resolve('@adhdev/session-host-daemon');
}

async function ensureSessionHostReady(): Promise<void> {
  if (await canConnect()) return;
  const entry = resolveSessionHostEntry();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ADHDEV_SESSION_HOST_NAME: SESSION_HOST_APP_NAME,
    },
  });
  child.unref();
  await waitForSessionHostReady();
}

async function listPanes(workspaceName: string, flags: CommandFlags = { json: false }): Promise<void> {
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

async function capturePane(workspaceName: string, paneTarget?: string, flags: CommandFlags = { json: false }): Promise<void> {
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

async function copyPane(workspaceName: string, paneTarget: string | undefined, options: CopyPaneOptions): Promise<void> {
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

async function searchPane(
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

async function selectPane(workspaceName: string, paneTarget: string): Promise<void> {
  const live = await requestWorkspaceControl(workspaceName, { type: 'select_pane', payload: { paneTarget } });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    const next = await mux.focusPane(workspace.workspaceId, paneId);
    workspace = next;
    save();
  });
}

async function killPane(workspaceName: string, paneTarget: string): Promise<void> {
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

async function replacePane(workspaceName: string, paneTarget: string | undefined, runtimeTarget: string): Promise<void> {
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

async function resizePane(workspaceName: string, paneTarget: string | undefined, args: string[]): Promise<void> {
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

async function selectLayout(workspaceName: string, layoutName: string): Promise<void> {
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

async function swapPane(workspaceName: string, firstTarget: string, secondTarget: string): Promise<void> {
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

async function zoomPane(workspaceName: string, paneTarget?: string): Promise<void> {
  const live = await requestWorkspaceControl(workspaceName, { type: 'zoom_pane', payload: { paneTarget } });
  if (live?.success) return;
  await withWorkspace(workspaceName, async ({ mux, workspace, save }) => {
    const paneId = resolvePaneTarget(workspace, paneTarget);
    workspace = await mux.togglePaneZoom(workspace.workspaceId, paneId);
    save();
  });
}

async function splitWindow(workspaceName: string, args: string[]): Promise<void> {
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

async function sendKeys(workspaceName: string, paneTarget: string | undefined, textParts: string[]): Promise<void> {
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

function clearScreen(): void {
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
}

function restoreScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

function cycleFocus(workspace: MuxWorkspaceState): string {
  const paneIds = Object.keys(workspace.panes);
  if (paneIds.length <= 1) return workspace.focusedPaneId;
  const current = paneIds.indexOf(workspace.focusedPaneId);
  const next = current >= 0 ? (current + 1) % paneIds.length : 0;
  return paneIds[next] || workspace.focusedPaneId;
}

function buildChooserStatus(runtimes: SessionHostRecord[]): string {
  if (runtimes.length === 0) return '[adhmux] no running runtimes available';
  return runtimes
    .slice(0, 9)
    .map((runtime, index) => `${index + 1}:${runtime.runtimeKey}(${runtime.lifecycle})`)
    .join('  ');
}

function buildPaneIndicators(activityByPaneId: Map<string, PaneActivityState>): Record<string, string> {
  return Object.fromEntries(
    Array.from(activityByPaneId.entries()).map(([paneId, activity]) => {
      if (activity.kind === 'output') {
        return [paneId, `•${activity.count}`];
      }
      if (activity.kind === 'done') {
        return [paneId, '✓'];
      }
      return [paneId, '!'];
    }),
  );
}

async function openWorkspace(options: OpenCommandOptions): Promise<void> {
  const storage = new TerminalMuxStorage();
  const mux = new SessionHostMuxClient({ appName: 'adhdev' });
  await mux.connect();

  const savedWorkspace = options.workspaceName ? storage.loadWorkspace(options.workspaceName) : null;
  let workspace: MuxWorkspaceState;
  if (savedWorkspace && options.runtimeTargets.length === 0) {
    workspace = await mux.restoreWorkspace(savedWorkspace);
  } else {
    if (options.runtimeTargets.length === 0) usage();
    workspace = await mux.createWorkspace(options.runtimeTargets[0]!, {
      readOnly: options.readOnly,
      takeover: options.takeover,
      title: options.workspaceName || options.runtimeTargets.join(' + '),
    });
    for (let i = 1; i < options.runtimeTargets.length; i += 1) {
      workspace = await mux.splitWorkspacePane(
        workspace.workspaceId,
        workspace.focusedPaneId,
        options.runtimeTargets[i]!,
        {
          axis: i % 2 === 1 ? 'vertical' : 'horizontal',
          readOnly: options.readOnly,
          takeover: options.takeover,
        },
      );
    }
  }

  if (options.workspaceName) {
    storage.saveWorkspace(options.workspaceName, mux.serializeWorkspace(workspace.workspaceId));
    storage.setLastWorkspace(options.workspaceName);
  }

  let statusLine = options.workspaceName
    ? `workspace=${options.workspaceName}`
    : 'temporary workspace';
  let mode: UiMode = 'normal';
  let promptAxis: MuxAxis | null = null;
  let promptAction: ChooserAction = 'split';
  let promptMode: PromptMode = 'runtime';
  let promptBuffer = '';
  let chooserAxis: MuxAxis | null = null;
  let chooserAction: ChooserAction = 'split';
  let chooserRuntimes: SessionHostRecord[] = [];
  let shouldExit = false;
  let syncRunning = false;
  let syncQueued = false;
  let controlServer: ReturnType<typeof createAdhMuxControlServer> | null = null;
  const paneActivityById = new Map<string, PaneActivityState>();
  const paneSearchById = new Map<string, { query: string; matches: PaneSearchMatch[] }>();
  const paneScrollOffsetById = new Map<string, number>();
  const paneSearchIndexById = new Map<string, number>();

  const clearPaneActivity = (paneId: string) => {
    paneActivityById.delete(paneId);
  };

  const getSplitCandidates = async (): Promise<SessionHostRecord[]> => {
    const runtimes = (await mux.listRuntimes()).filter((runtime) => runtime.lifecycle === 'running');
    const openRuntimeKeys = new Set(Object.values(workspace.panes).map((pane) => pane.runtimeKey));
    const unseen = runtimes.filter((runtime) => !openRuntimeKeys.has(runtime.runtimeKey));
    return unseen.length > 0 ? unseen : runtimes;
  };

  const enterChooser = async (axis: MuxAxis, action: ChooserAction = 'split') => {
    chooserAxis = axis;
    chooserAction = action;
    chooserRuntimes = await getSplitCandidates();
    mode = 'chooser';
    statusLine = buildChooserStatus(chooserRuntimes);
    render();
  };

  const footerLine = () => {
    if (mode === 'prefix') {
      return '^B [% vertical] [" horizontal] [c replace] [[] copy-mode] [/ search] [y copy] [z zoom] [HJKL resize] [= rebalance] [n next] [t takeover] [r release] [x close] [s save] [d detach]';
    }
    if (mode === 'chooser') {
      return `${chooserAction} ${chooserAxis} choose [1-9]  [/] manual key  [esc] cancel`;
    }
    if (mode === 'prompt') {
      if (promptMode === 'search') {
        return `search query> ${promptBuffer}`;
      }
      return `${promptAction} ${promptAxis} runtime> ${promptBuffer}`;
    }
    if (mode === 'copy') {
      return 'copy-mode  [j/k down/up] [d/u page] [g/G top/bottom] [n/N next/prev match] [y copy pane] [enter/esc exit]';
    }
    const focused = workspace.panes[workspace.focusedPaneId];
    return `^B prefix  pane=${focused?.runtimeKey || 'n/a'}  mode=${focused?.accessMode || 'n/a'}  workspace=${workspace.title}`;
  };

  const persistWorkspace = () => {
    if (!options.workspaceName) return;
    storage.saveWorkspace(options.workspaceName, mux.serializeWorkspace(workspace.workspaceId));
    storage.setLastWorkspace(options.workspaceName);
  };

  const listWorkspacePanes = () =>
    Object.keys(workspace.panes).map((paneId, index) => {
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

  const render = () => {
    clearScreen();
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    process.stdout.write(
      renderWorkspace(workspace, cols, rows, {
        footerLine: footerLine(),
        statusLine,
        paneIndicators: {
          ...buildPaneIndicators(paneActivityById),
          ...Object.fromEntries(
            Array.from(paneSearchById.entries()).map(([paneId, search]) => [paneId, `/${search.matches.length}`]),
          ),
        },
        paneLineOffsets: Object.fromEntries(paneScrollOffsetById.entries()),
      }),
    );
  };

  const scheduleSync = () => {
    if (shouldExit) return;
    if (syncRunning) {
      syncQueued = true;
      return;
    }
    syncRunning = true;
    void (async () => {
      do {
        syncQueued = false;
        const rects = computePaneRects(workspace, process.stdout.columns || 120, process.stdout.rows || 40);
        const seenRuntimeIds = new Set<string>();
        for (const [paneId, rect] of rects) {
          const pane = workspace.panes[paneId];
          if (pane?.paneKind === 'mirror') continue;
          if (!pane || seenRuntimeIds.has(pane.runtimeId)) continue;
          seenRuntimeIds.add(pane.runtimeId);
          const cols = Math.max(1, rect.width - 2);
          const rows = Math.max(1, rect.height - 2);
          if (pane.viewport.cols === cols && pane.viewport.rows === rows) continue;
          try {
            await mux.resizePane(paneId, cols, rows);
          } catch (error: any) {
            statusLine = `[adhmux] resize failed: ${error?.message || error}`;
          }
        }
      } while (syncQueued);
      syncRunning = false;
      if (!shouldExit) {
        render();
      }
    })();
  };

  const setStatus = (next: string) => {
    statusLine = next;
    render();
  };

  const updateSearchStatus = (paneId: string, query: string) => {
    const pane = workspace.panes[paneId];
    const matches = searchPaneText(pane?.viewport.text || '', query);
    if (matches.length === 0) {
      paneSearchById.delete(paneId);
      paneSearchIndexById.delete(paneId);
      setStatus(`[adhmux] no matches for "${query}"`);
      return;
    }
    paneSearchById.set(paneId, { query, matches });
    paneSearchIndexById.set(paneId, 0);
    paneScrollOffsetById.set(paneId, Math.max(0, matches[0]!.line - 1));
    const first = matches[0]!;
    setStatus(`[adhmux] ${matches.length} matches for "${query}" at ${first.line}:${first.column}`);
  };

  const setPaneScroll = (paneId: string, nextOffset: number) => {
    const maxOffset = Math.max(
      0,
      (workspace.panes[paneId]?.viewport.text.replace(/\r\n/g, '\n').split('\n').length || 1) - 1,
    );
    paneScrollOffsetById.set(paneId, Math.min(maxOffset, Math.max(0, nextOffset)));
    render();
  };

  const moveSearchMatch = (paneId: string, delta: 1 | -1) => {
    const search = paneSearchById.get(paneId);
    if (!search || search.matches.length === 0) {
      setStatus('[adhmux] no active search');
      return;
    }
    const currentIndex = paneSearchIndexById.get(paneId) || 0;
    const nextIndex = (currentIndex + delta + search.matches.length) % search.matches.length;
    paneSearchIndexById.set(paneId, nextIndex);
    const match = search.matches[nextIndex]!;
    paneScrollOffsetById.set(paneId, Math.max(0, match.line - 1));
    setStatus(`[adhmux] ${search.query} ${nextIndex + 1}/${search.matches.length} at ${match.line}:${match.column}`);
  };

  const onMuxEvent = (event: MuxControllerEvent) => {
    if (event.kind === 'runtime') {
      const paneId = event.pane.paneId;
      if (workspace.focusedPaneId !== paneId) {
        if (event.event?.type === 'session_output') {
          const previous = paneActivityById.get(paneId);
          paneActivityById.set(paneId, {
            kind: 'output',
            count: previous?.kind === 'output' ? previous.count + 1 : 1,
          });
          if (!previous) {
            process.stdout.write('\u0007');
          }
        } else if (event.event?.type === 'session_exit') {
          paneActivityById.set(paneId, { kind: 'done', count: 1 });
          process.stdout.write('\u0007');
        } else if (event.event?.type === 'write_owner_changed') {
          paneActivityById.set(paneId, { kind: 'owner', count: 1 });
        }
      }
      if (options.workspaceName) {
        controlServer?.broadcast({
          type: 'runtime_update',
          payload: {
            workspaceName: options.workspaceName,
            pane: event.pane,
            event: event.event || null,
          },
        });
      }
      render();
      return;
    }
    if (event.kind === 'workspace' && event.workspace?.workspaceId === workspace.workspaceId) {
      if (event.workspace.focusedPaneId !== workspace.focusedPaneId) {
        clearPaneActivity(event.workspace.focusedPaneId);
      }
      workspace = event.workspace;
      persistWorkspace();
      if (options.workspaceName) {
        controlServer?.broadcast({
          type: 'workspace_update',
          payload: {
            workspaceName: options.workspaceName,
            workspace,
            panes: listWorkspacePanes(),
          },
        });
      }
      if (!shouldExit) {
        render();
        scheduleSync();
      }
    }
  };

  const unsub = mux.onEvent(onMuxEvent);
  controlServer = options.workspaceName
    ? createAdhMuxControlServer(options.workspaceName, async (request) => {
        const payload = request.payload || {};
        if (request.type === 'list_panes') {
          return { success: true, result: listWorkspacePanes() };
        }
        if (request.type === 'workspace_state') {
          return {
            success: true,
            result: {
              workspaceName: options.workspaceName,
              workspace,
              panes: listWorkspacePanes(),
            },
          };
        }
        if (request.type === 'capture_pane') {
          const paneId = resolvePaneTarget(workspace, payload.paneTarget as string | undefined);
          return { success: true, result: { paneId, text: workspace.panes[paneId]!.viewport.text } };
        }
        if (request.type === 'copy_pane') {
          const paneId = resolvePaneTarget(workspace, payload.paneTarget as string | undefined);
          const text = workspace.panes[paneId]!.viewport.text;
          const clipboard = !!payload.clipboard;
          const output = typeof payload.output === 'string' ? payload.output : undefined;
          if (output) {
            const { writeFileSync } = await import('fs');
            writeFileSync(output, text, 'utf8');
          }
          if (clipboard) {
            copyTextToClipboard(text);
          }
          return {
            success: true,
            result: { paneId, copiedToClipboard: clipboard, output: output || null, text: !clipboard && !output ? text : undefined },
          };
        }
        if (request.type === 'search_pane') {
          const paneId = resolvePaneTarget(workspace, payload.paneTarget as string | undefined);
          const query = String(payload.query || '');
          const matches = searchPaneText(workspace.panes[paneId]!.viewport.text, query);
          return { success: true, result: { paneId, query, count: matches.length, matches } };
        }
        if (request.type === 'select_pane') {
          workspace = await mux.focusPane(workspace.workspaceId, resolvePaneTarget(workspace, payload.paneTarget as string | undefined));
          clearPaneActivity(workspace.focusedPaneId);
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'replace_pane') {
          workspace = await mux.replacePaneRuntime(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
            String(payload.runtimeTarget || ''),
            { readOnly: false, takeover: false },
          );
          persistWorkspace();
          render();
          scheduleSync();
          return { success: true };
        }
        if (request.type === 'split_window') {
          const axis = (payload.axis as MuxAxis) || 'vertical';
          workspace = payload.mirror
            ? await mux.splitWorkspaceMirror(workspace.workspaceId, workspace.focusedPaneId, workspace.focusedPaneId, axis)
            : await mux.splitWorkspacePane(workspace.workspaceId, workspace.focusedPaneId, String(payload.runtimeKey || ''), {
                axis,
                readOnly: false,
              });
          persistWorkspace();
          render();
          scheduleSync();
          return { success: true };
        }
        if (request.type === 'resize_pane') {
          workspace = await mux.resizeLayoutPane(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
            payload.direction as 'left' | 'right' | 'up' | 'down',
            Number(payload.amount || 0.05),
          );
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'select_layout') {
          const preset = normalizeLayoutPreset(String(payload.layoutName || 'balanced'));
          workspace = preset === 'balanced'
            ? await mux.rebalanceWorkspaceLayout(workspace.workspaceId)
            : await mux.applyLayoutPreset(workspace.workspaceId, preset);
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'swap_panes') {
          workspace = await mux.swapPanePositions(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.firstPaneTarget as string | undefined),
            resolvePaneTarget(workspace, payload.secondPaneTarget as string | undefined),
          );
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'zoom_pane') {
          workspace = await mux.togglePaneZoom(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
          );
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'kill_pane') {
          const next = await mux.closePane(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
          );
          if (!next) {
            if (options.workspaceName) storage.deleteWorkspace(options.workspaceName);
            await finish();
            return { success: true, result: { workspaceDeleted: true } };
          }
          workspace = next;
          persistWorkspace();
          render();
          scheduleSync();
          return { success: true };
        }
        if (request.type === 'send_keys') {
          await mux.sendInput(
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
            String(payload.text || ''),
          );
          return { success: true };
        }
        return { success: false, error: `Unsupported control request: ${request.type}` };
      })
    : null;
  const onResize = () => {
    render();
    scheduleSync();
  };
  process.stdout.on('resize', onResize);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  render();
  scheduleSync();

  const finish = async () => {
    if (shouldExit) return;
    shouldExit = true;
    persistWorkspace();
    process.stdin.off('data', onData);
    process.stdout.off('resize', onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    restoreScreen();
    unsub();
    controlServer?.close();
    await mux.close();
  };

  const handlePromptChar = async (char: string) => {
    if (char === '\u0007' || char === '\u001b') {
      mode = 'normal';
      promptAxis = null;
      promptAction = 'split';
      promptMode = 'runtime';
      promptBuffer = '';
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      render();
      return;
    }
    if (char === '\r' || char === '\n') {
      const value = promptBuffer.trim();
      mode = 'normal';
      const axis = promptAxis;
      const action = promptAction;
      const modeType = promptMode;
      promptAxis = null;
      promptAction = 'split';
      promptMode = 'runtime';
      promptBuffer = '';
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      if (modeType === 'search') {
        if (!value) {
          setStatus('[adhmux] search cancelled');
          return;
        }
        updateSearchStatus(workspace.focusedPaneId, value);
        return;
      }
      if (!value || !axis) {
        setStatus('[adhmux] split cancelled');
        return;
      }
      try {
        workspace = action === 'replace'
          ? await mux.replacePaneRuntime(workspace.workspaceId, workspace.focusedPaneId, value, {
              readOnly: false,
              takeover: false,
            })
          : await mux.splitWorkspacePane(workspace.workspaceId, workspace.focusedPaneId, value, {
              axis,
              readOnly: false,
            });
        persistWorkspace();
        render();
        scheduleSync();
      } catch (error: any) {
        setStatus(`[adhmux] split failed: ${error?.message || error}`);
      }
      return;
    }
    if (char === '\u007f') {
      promptBuffer = promptBuffer.slice(0, -1);
      render();
      return;
    }
    if (char >= ' ' && char <= '~') {
      promptBuffer += char;
      render();
    }
  };

  const handleChooserChar = async (char: string) => {
    if (char === '\u0007' || char === '\u001b') {
      mode = 'normal';
      chooserAxis = null;
      chooserAction = 'split';
      chooserRuntimes = [];
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      render();
      return;
    }
    if (char === '/') {
      mode = 'prompt';
      promptAxis = chooserAxis;
      promptAction = chooserAction;
      promptMode = 'runtime';
      chooserAxis = null;
      chooserAction = 'split';
      chooserRuntimes = [];
      promptBuffer = '';
      render();
      return;
    }
    const digit = Number.parseInt(char, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
      const selected = chooserRuntimes[digit - 1];
      const axis = chooserAxis;
      const action = chooserAction;
      mode = 'normal';
      chooserAxis = null;
      chooserAction = 'split';
      chooserRuntimes = [];
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      if (!selected || !axis) {
        setStatus('[adhmux] invalid chooser selection');
        return;
      }
      try {
        workspace = action === 'replace'
          ? await mux.replacePaneRuntime(workspace.workspaceId, workspace.focusedPaneId, selected.runtimeKey, {
              readOnly: false,
              takeover: false,
            })
          : await mux.splitWorkspacePane(workspace.workspaceId, workspace.focusedPaneId, selected.runtimeKey, {
              axis,
              readOnly: false,
            });
        persistWorkspace();
        render();
        scheduleSync();
      } catch (error: any) {
        setStatus(`[adhmux] split failed: ${error?.message || error}`);
      }
    }
  };

  const handlePrefixChar = async (char: string) => {
    mode = 'normal';
    try {
      if (char === '\u0002') {
        await mux.sendInput(workspace.focusedPaneId, '\u0002');
        return;
      }
      if (char === '%') {
        await enterChooser('vertical', 'split');
        return;
      }
      if (char === '"') {
        await enterChooser('horizontal', 'split');
        return;
      }
      if (char === 'm') {
        workspace = await mux.splitWorkspaceMirror(
          workspace.workspaceId,
          workspace.focusedPaneId,
          workspace.focusedPaneId,
          'vertical',
        );
        persistWorkspace();
        render();
        return;
      }
      if (char === '[') {
        mode = 'copy';
        paneScrollOffsetById.set(workspace.focusedPaneId, paneScrollOffsetById.get(workspace.focusedPaneId) || 0);
        render();
        return;
      }
      if (char === 'c') {
        await enterChooser('vertical', 'replace');
        return;
      }
      if (char === '/') {
        mode = 'prompt';
        promptAxis = null;
        promptAction = 'split';
        promptMode = 'search';
        promptBuffer = '';
        render();
        return;
      }
      if (char === 'y') {
        copyTextToClipboard(workspace.panes[workspace.focusedPaneId]!.viewport.text);
        setStatus('[adhmux] copied focused pane to clipboard');
        return;
      }
      if (char === 'n' || char === '\t') {
        workspace = await mux.focusPane(workspace.workspaceId, cycleFocus(workspace));
        clearPaneActivity(workspace.focusedPaneId);
        render();
        return;
      }
      if (char === 'H') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'left');
        persistWorkspace();
        render();
        return;
      }
      if (char === 'L') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'right');
        persistWorkspace();
        render();
        return;
      }
      if (char === 'K') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'up');
        persistWorkspace();
        render();
        return;
      }
      if (char === 'J') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'down');
        persistWorkspace();
        render();
        return;
      }
      if (char === '=') {
        workspace = await mux.rebalanceWorkspaceLayout(workspace.workspaceId);
        persistWorkspace();
        render();
        return;
      }
      if (char === 't') {
        await mux.takeoverPane(workspace.focusedPaneId);
        setStatus('[adhmux] write ownership acquired');
        return;
      }
      if (char === 'z') {
        workspace = await mux.togglePaneZoom(workspace.workspaceId, workspace.focusedPaneId);
        persistWorkspace();
        render();
        return;
      }
      if (char === 'r') {
        await mux.releasePane(workspace.focusedPaneId);
        setStatus('[adhmux] write ownership released');
        return;
      }
      if (char === 'x') {
        const next = await mux.closePane(workspace.workspaceId, workspace.focusedPaneId);
        if (!next) {
          await finish();
          return;
        }
        workspace = next;
        persistWorkspace();
        render();
        scheduleSync();
        return;
      }
      if (char === 's') {
        persistWorkspace();
        setStatus(options.workspaceName ? `[adhmux] saved workspace ${options.workspaceName}` : '[adhmux] temporary workspace');
        return;
      }
      if (char === 'd' || char === 'q') {
        await finish();
        return;
      }
      setStatus(`[adhmux] unknown prefix command: ${JSON.stringify(char)}`);
    } catch (error: any) {
      setStatus(`[adhmux] ${error?.message || error}`);
    } finally {
      if (!shouldExit) {
        render();
      }
    }
  };

  const handleNormalChunk = async (chunk: string) => {
    if (chunk === '\u0002') {
      mode = 'prefix';
      render();
      return;
    }
    try {
      await mux.sendInput(workspace.focusedPaneId, chunk);
    } catch (error: any) {
      setStatus(`[adhmux] ${error?.message || error}`);
    }
  };

  const onData = (chunk: string) => {
    void (async () => {
      for (const char of chunk) {
        if (shouldExit) break;
        if (mode === 'chooser') {
          await handleChooserChar(char);
          continue;
        }
        if (mode === 'prompt') {
          await handlePromptChar(char);
          continue;
        }
        if (mode === 'copy') {
          const paneId = workspace.focusedPaneId;
          const current = paneScrollOffsetById.get(paneId) || 0;
          if (char === '\u0007' || char === '\u001b' || char === '\r' || char === '\n') {
            mode = 'normal';
            render();
            continue;
          }
          if (char === 'j') {
            setPaneScroll(paneId, current + 1);
            continue;
          }
          if (char === 'k') {
            setPaneScroll(paneId, current - 1);
            continue;
          }
          if (char === 'd') {
            setPaneScroll(paneId, current + Math.max(5, Math.floor((process.stdout.rows || 40) / 2)));
            continue;
          }
          if (char === 'u') {
            setPaneScroll(paneId, current - Math.max(5, Math.floor((process.stdout.rows || 40) / 2)));
            continue;
          }
          if (char === 'g') {
            setPaneScroll(paneId, 0);
            continue;
          }
          if (char === 'G') {
            setPaneScroll(paneId, 1_000_000);
            continue;
          }
          if (char === 'n') {
            moveSearchMatch(paneId, 1);
            continue;
          }
          if (char === 'N') {
            moveSearchMatch(paneId, -1);
            continue;
          }
          if (char === 'y') {
            try {
              copyTextToClipboard(workspace.panes[paneId]!.viewport.text);
              setStatus('[adhmux] copied focused pane to clipboard');
            } catch (error: any) {
              setStatus(`[adhmux] ${error?.message || error}`);
            }
            continue;
          }
          continue;
        }
        if (mode === 'prefix') {
          await handlePrefixChar(char);
          continue;
        }
        await handleNormalChunk(char);
      }
    })();
  };

  process.stdin.on('data', onData);

  await new Promise<void>((resolve) => {
    const poll = () => {
      if (shouldExit) {
        resolve();
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) usage();
  const { flags, rest } = parseCommandFlags(args);

  if (command === 'list' || command === 'list-runtimes') {
    await listRuntimes(flags);
    return;
  }
  if (command === 'sessions' || command === 'list-sessions') {
    await listSessions(flags);
    return;
  }
  if (command === 'workspaces' || command === 'ls' || command === 'list-workspaces') {
    await listWorkspaces(flags);
    return;
  }
  if (command === 'windows' || command === 'list-windows') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await listWindows(workspaceName, flags);
    return;
  }
  if (command === 'tree') {
    await printWorkspaceTree(flags);
    return;
  }
  if (command === 'state') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await printWorkspaceState(workspaceName, flags);
    return;
  }
  if (command === 'socket-info') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await printSocketInfo(workspaceName, flags);
    return;
  }
  if (command === 'events') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await streamWorkspaceEvents(workspaceName, flags);
    return;
  }
  if (command === 'control') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await controlWorkspace(workspaceName, remainingArgs[0], remainingArgs[1], flags);
    return;
  }
  if (command === 'last-session') {
    await printLastWorkspace(flags);
    return;
  }
  if (command === 'rename-workspace') {
    if (!rest[0] || !rest[1]) usage();
    await renameWorkspace(rest[0], rest[1]);
    return;
  }
  if (command === 'delete-workspace') {
    if (!rest[0]) usage();
    await deleteWorkspace(rest[0]);
    return;
  }
  if (command === 'new-session') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    await openWorkspace({
      workspaceName: buildWorkspaceName(workspaceName, workspaceName),
      runtimeTargets: remainingArgs,
      readOnly: false,
      takeover: false,
    });
    return;
  }
  if (command === 'attach-session') {
    const storage = new TerminalMuxStorage();
    const sessionTarget = rest.length > 0 ? parseSessionTargetArgs(rest).workspaceName : storage.getLastWorkspace();
    if (!sessionTarget) {
      throw new Error('No workspace specified and no last session recorded');
    }
    const workspaceTarget = storage.resolveSessionWindowWorkspace(sessionTarget) || sessionTarget;
    await openWorkspace({
      workspaceName: workspaceTarget,
      runtimeTargets: [],
      readOnly: false,
      takeover: false,
    });
    return;
  }
  if (command === 'kill-session') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await killSession(workspaceName);
    return;
  }
  if (command === 'rename-session') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await renameSession(workspaceName, remainingArgs[0]);
    return;
  }
  if (command === 'has-session') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    process.exit((await hasSession(workspaceName)) ? 0 : 1);
  }
  if (command === 'new-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    let windowName;
    const runtimeTargets = [];
    for (let i = 0; i < remainingArgs.length; i += 1) {
      const arg = remainingArgs[i];
      if (arg === '-n' && remainingArgs[i + 1]) {
        windowName = remainingArgs[i + 1];
        i += 1;
        continue;
      }
      runtimeTargets.push(arg);
    }
    await newWindow(workspaceName, windowName, runtimeTargets);
    return;
  }
  if (command === 'select-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await selectWindow(workspaceName, remainingArgs[0]);
    return;
  }
  if (command === 'rename-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0] || !remainingArgs[1]) usage();
    await renameWindow(workspaceName, remainingArgs[0], remainingArgs[1]);
    return;
  }
  if (command === 'kill-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await killWindow(workspaceName, remainingArgs[0]);
    return;
  }
  if (command === 'list-panes') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await listPanes(workspaceName, flags);
    return;
  }
  if (command === 'capture-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    await capturePane(workspaceName, paneTarget, flags);
    return;
  }
  if (command === 'copy-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    let clipboard = false;
    let output: string | undefined;
    for (let i = 0; i < remainingArgs.length; i += 1) {
      const arg = remainingArgs[i];
      if (arg === '--clipboard') {
        clipboard = true;
        continue;
      }
      if (arg === '--output' && remainingArgs[i + 1]) {
        output = remainingArgs[i + 1];
        i += 1;
      }
    }
    await copyPane(workspaceName, paneTarget, { json: flags.json, clipboard, output });
    return;
  }
  if (command === 'search-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await searchPane(workspaceName, paneTarget, remainingArgs.join(' '), flags);
    return;
  }
  if (command === 'select-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    if (!paneTarget) usage();
    await selectPane(workspaceName, paneTarget);
    return;
  }
  if (command === 'replace-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await replacePane(workspaceName, paneTarget, remainingArgs[0]);
    return;
  }
  if (command === 'kill-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    if (!paneTarget) usage();
    await killPane(workspaceName, paneTarget);
    return;
  }
  if (command === 'split-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    await splitWindow(workspaceName, remainingArgs);
    return;
  }
  if (command === 'resize-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    await resizePane(workspaceName, paneTarget, remainingArgs);
    return;
  }
  if (command === 'select-layout') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await selectLayout(workspaceName, remainingArgs[0]!);
    return;
  }
  if (command === 'swap-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (!paneTarget || !remainingArgs[0]) usage();
    await swapPane(workspaceName, paneTarget, remainingArgs[0]!);
    return;
  }
  if (command === 'zoom-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    await zoomPane(workspaceName, paneTarget);
    return;
  }
  if (command === 'send-keys') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (remainingArgs.length === 0) usage();
    await sendKeys(workspaceName, paneTarget, remainingArgs);
    return;
  }
  if (command === 'snapshot') {
    if (!rest[0]) usage();
    await snapshotRuntime(rest[0]);
    return;
  }
  if (command === 'open') {
    await openWorkspace(parseOpenArgs(rest));
    return;
  }

  usage();
}

main().catch((error) => {
  console.error('[adhmux]', error?.message || error);
  process.exit(1);
});
