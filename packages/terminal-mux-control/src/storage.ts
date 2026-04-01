import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PersistedMuxWorkspaceState } from '@adhdev/terminal-mux-core';

export interface StoredWorkspaceInfo {
  name: string;
  title: string;
  paneCount: number;
  updatedAt: number;
}

export interface StoredSessionInfo {
  name: string;
  title: string;
  windowCount: number;
  updatedAt: number;
  activeWindowName: string;
}

interface TerminalMuxClientState {
  lastWorkspace?: string;
  updatedAt: number;
}

export function getRootDir(): string {
  return path.join(os.homedir(), '.adhdev', 'terminal-mux');
}

const WINDOW_MARKER = '--w--';

function getWorkspacesDir(): string {
  return path.join(getRootDir(), 'workspaces');
}

function getStatePath(): string {
  return path.join(getRootDir(), 'state.json');
}

export function sanitizeWorkspaceName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export interface WorkspaceRef {
  sessionName: string;
  windowName: string;
  workspaceName: string;
}

export function toWorkspaceRef(name: string): WorkspaceRef {
  const workspaceName = sanitizeWorkspaceName(name);
  const markerIndex = workspaceName.indexOf(WINDOW_MARKER);
  if (markerIndex < 0) {
    return {
      sessionName: workspaceName,
      windowName: workspaceName,
      workspaceName,
    };
  }
  return {
    sessionName: workspaceName.slice(0, markerIndex),
    windowName: workspaceName.slice(markerIndex + WINDOW_MARKER.length),
    workspaceName,
  };
}

export function buildWorkspaceName(sessionName: string, windowName: string): string {
  const session = sanitizeWorkspaceName(sessionName);
  const window = sanitizeWorkspaceName(windowName);
  if (!session || session === window) return window;
  return `${session}${WINDOW_MARKER}${window}`;
}

export interface WorkspaceControlEndpoint {
  kind: 'unix' | 'pipe';
  path: string;
}

export function getWorkspaceControlEndpoint(name: string): WorkspaceControlEndpoint {
  const sanitized = sanitizeWorkspaceName(name);
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\adhmux-${sanitized}`,
    };
  }
  return {
    kind: 'unix',
    path: path.join(os.tmpdir(), `adhmux-${sanitized}.sock`),
  };
}

export class TerminalMuxStorage {
  private readonly workspacesDir = getWorkspacesDir();
  private readonly statePath = getStatePath();

  listWorkspaceNames(): string[] {
    return this.listWorkspaces().map((workspace) => workspace.name);
  }

  listWorkspaces(): StoredWorkspaceInfo[] {
    if (!fs.existsSync(this.workspacesDir)) return [];
    return fs
      .readdirSync(this.workspacesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        const name = entry.name.replace(/\.json$/, '');
        const filePath = this.getWorkspacePath(name);
        let title = name;
        let paneCount = 0;
        let updatedAt = 0;
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedMuxWorkspaceState;
          title = parsed.title || name;
          paneCount = Object.keys(parsed.panes || {}).length;
          updatedAt = fs.statSync(filePath).mtimeMs;
        } catch {
          return [];
        }
        return [{
          name,
          title,
          paneCount,
          updatedAt,
        }];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  listSessions(): StoredSessionInfo[] {
    const grouped = new Map<string, StoredWorkspaceInfo[]>();
    for (const workspace of this.listWorkspaces()) {
      const ref = toWorkspaceRef(workspace.name);
      const items = grouped.get(ref.sessionName) || [];
      items.push(workspace);
      grouped.set(ref.sessionName, items);
    }
    return Array.from(grouped.entries())
      .map(([sessionName, workspaces]) => {
        const sorted = [...workspaces].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
        const active = sorted[0]!;
        return {
          name: sessionName,
          title: toWorkspaceRef(active.name).sessionName,
          windowCount: workspaces.length,
          updatedAt: active.updatedAt,
          activeWindowName: toWorkspaceRef(active.name).windowName,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  listSessionWindows(sessionName: string): StoredWorkspaceInfo[] {
    const normalizedSession = sanitizeWorkspaceName(sessionName);
    return this.listWorkspaces().filter((workspace) => toWorkspaceRef(workspace.name).sessionName === normalizedSession);
  }

  resolveSessionWindowWorkspace(sessionName: string, windowName?: string): string | null {
    const windows = this.listSessionWindows(sessionName);
    if (windows.length === 0) return null;
    if (!windowName) return windows[0]!.name;
    const normalizedWindow = sanitizeWorkspaceName(windowName);
    const exact = windows.find((workspace) => toWorkspaceRef(workspace.name).windowName === normalizedWindow);
    return exact?.name || null;
  }

  loadWorkspace(name: string): PersistedMuxWorkspaceState | null {
    const filePath = this.getWorkspacePath(name);
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedMuxWorkspaceState;
    return parsed?.workspaceId ? parsed : null;
  }

  saveWorkspace(name: string, workspace: PersistedMuxWorkspaceState): void {
    fs.mkdirSync(this.workspacesDir, { recursive: true });
    fs.writeFileSync(this.getWorkspacePath(name), JSON.stringify(workspace, null, 2), 'utf8');
  }

  renameWorkspace(fromName: string, toName: string): void {
    const fromPath = this.getWorkspacePath(fromName);
    const toPath = this.getWorkspacePath(toName);
    if (!fs.existsSync(fromPath)) {
      throw new Error(`Workspace not found: ${fromName}`);
    }
    fs.mkdirSync(this.workspacesDir, { recursive: true });
    fs.renameSync(fromPath, toPath);
  }

  deleteWorkspace(name: string): void {
    const filePath = this.getWorkspacePath(name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Workspace not found: ${name}`);
    }
    fs.unlinkSync(filePath);
    const state = this.loadClientState();
    if (state.lastWorkspace === sanitizeWorkspaceName(name)) {
      this.saveClientState({ ...state, lastWorkspace: undefined, updatedAt: Date.now() });
    }
  }

  getLastWorkspace(): string | null {
    const state = this.loadClientState();
    return state.lastWorkspace || null;
  }

  setLastWorkspace(name: string): void {
    this.saveClientState({
      ...this.loadClientState(),
      lastWorkspace: sanitizeWorkspaceName(name),
      updatedAt: Date.now(),
    });
  }

  private getWorkspacePath(name: string): string {
    return path.join(this.workspacesDir, `${sanitizeWorkspaceName(name)}.json`);
  }

  private loadClientState(): TerminalMuxClientState {
    if (!fs.existsSync(this.statePath)) {
      return { updatedAt: 0 };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as TerminalMuxClientState;
      return typeof parsed === 'object' && parsed ? parsed : { updatedAt: 0 };
    } catch {
      return { updatedAt: 0 };
    }
  }

  private saveClientState(state: TerminalMuxClientState): void {
    fs.mkdirSync(getRootDir(), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }
}
