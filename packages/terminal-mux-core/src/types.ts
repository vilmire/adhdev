import type {
  SessionAttachedClient,
  SessionHostEvent,
  SessionHostRecord,
  SessionWriteOwner,
} from '@adhdev/session-host-core';

export type MuxAxis = 'horizontal' | 'vertical';
export type PaneAccessMode = 'interactive' | 'read-only';
export type MuxPaneKind = 'runtime' | 'mirror';
export type MuxLayoutPreset = 'even' | 'main-vertical' | 'main-horizontal' | 'tiled';

export interface TerminalViewportState {
  cols: number;
  rows: number;
  snapshotSeq: number;
  text: string;
}

export interface RuntimePaneState {
  paneId: string;
  paneKind: MuxPaneKind;
  runtimeId: string;
  runtimeKey: string;
  displayName: string;
  workspaceLabel: string;
  accessMode: PaneAccessMode;
  lifecycle: SessionHostRecord['lifecycle'];
  writeOwner: SessionWriteOwner | null;
  attachedClients: SessionAttachedClient[];
  viewport: TerminalViewportState;
}

export type MuxLayoutNode =
  | {
      type: 'pane';
      paneId: string;
    }
  | {
      type: 'split';
      axis: MuxAxis;
      ratio: number;
      first: MuxLayoutNode;
      second: MuxLayoutNode;
    };

export interface MuxWorkspaceState {
  workspaceId: string;
  title: string;
  root: MuxLayoutNode;
  focusedPaneId: string;
  zoomedPaneId?: string | null;
  panes: Record<string, RuntimePaneState>;
}

export interface OpenRuntimeOptions {
  readOnly?: boolean;
  takeover?: boolean;
  cols?: number;
  rows?: number;
  paneId?: string;
}

export interface CreateWorkspaceOptions extends OpenRuntimeOptions {
  workspaceId?: string;
  title?: string;
}

export interface SplitPaneOptions extends OpenRuntimeOptions {
  axis: MuxAxis;
}

export interface RuntimePaneUpdate {
  kind: 'runtime';
  pane: RuntimePaneState;
  event?: SessionHostEvent;
}

export interface WorkspaceUpdate {
  kind: 'workspace';
  workspace: MuxWorkspaceState;
}

export type MuxControllerEvent = RuntimePaneUpdate | WorkspaceUpdate;

export interface PersistedMuxWorkspaceState {
  workspaceId: string;
  title: string;
  focusedPaneId: string;
  zoomedPaneId?: string | null;
  root: MuxLayoutNode;
  panes: Record<
    string,
    {
      runtimeId?: string;
      runtimeKey: string;
      paneKind: MuxPaneKind;
      accessMode: PaneAccessMode;
    }
  >;
}
