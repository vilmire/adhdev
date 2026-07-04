import {
  buildWorkspaceName,
  sanitizeWorkspaceName,
  toWorkspaceRef,
  TerminalMuxStorage,
} from '@adhdev/terminal-mux-control/storage';
import { openWorkspace } from './interactive-workspace.js';

export async function renameWorkspace(fromName: string, toName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  storage.renameWorkspace(fromName, toName);
}

export async function deleteWorkspace(name: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  storage.deleteWorkspace(name);
}

export async function hasWorkspace(name: string): Promise<boolean> {
  const storage = new TerminalMuxStorage();
  return storage.loadWorkspace(name) !== null;
}

export async function hasSession(name: string): Promise<boolean> {
  const storage = new TerminalMuxStorage();
  return storage.listSessionWindows(name).length > 0;
}

export async function renameSession(fromName: string, toName: string): Promise<void> {
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

export async function killSession(name: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const windows = storage.listSessionWindows(name);
  if (windows.length === 0) {
    throw new Error(`Session not found: ${name}`);
  }
  for (const window of windows) {
    storage.deleteWorkspace(window.name);
  }
}

export async function newWindow(sessionName: string, windowName: string | undefined, runtimeTargets: string[]): Promise<void> {
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

export async function selectWindow(sessionName: string, windowName: string): Promise<void> {
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

export async function renameWindow(sessionName: string, fromWindowName: string, toWindowName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const fromWorkspace = storage.resolveSessionWindowWorkspace(sessionName, fromWindowName);
  if (!fromWorkspace) {
    throw new Error(`Window not found: ${sessionName}/${fromWindowName}`);
  }
  storage.renameWorkspace(fromWorkspace, buildWorkspaceName(sessionName, toWindowName));
}

export async function killWindow(sessionName: string, windowName: string): Promise<void> {
  const storage = new TerminalMuxStorage();
  const workspaceName = storage.resolveSessionWindowWorkspace(sessionName, windowName);
  if (!workspaceName) {
    throw new Error(`Window not found: ${sessionName}/${windowName}`);
  }
  storage.deleteWorkspace(workspaceName);
}
