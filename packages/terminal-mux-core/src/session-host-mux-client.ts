import { randomUUID } from 'crypto';
import {
  resolveRuntimeRecord,
  SessionHostClient,
  type SessionHostClientOptions,
  type SessionHostEvent,
  type SessionHostRecord,
} from '@adhdev/session-host-core';
import { GhosttyTerminalSurface } from './ghostty-terminal-surface.js';
import {
  applyMuxLayoutPreset,
  createMuxWorkspace,
  focusMuxPane,
  rebalanceMuxLayout,
  removeMuxPane,
  resizeMuxPane,
  splitMuxPane,
  swapMuxPanePositions,
  toggleMuxPaneZoom,
  updateMuxPane,
} from './layout.js';
import { serializeWorkspace } from './workspace-persistence.js';
import type {
  CreateWorkspaceOptions,
  MuxControllerEvent,
  MuxLayoutPreset,
  MuxWorkspaceState,
  OpenRuntimeOptions,
  PersistedMuxWorkspaceState,
  RuntimePaneState,
  SplitPaneOptions,
} from './types.js';

function paneFromRecord(
  paneId: string,
  record: SessionHostRecord,
  surface: GhosttyTerminalSurface,
  paneKind: RuntimePaneState['paneKind'],
  accessMode: RuntimePaneState['accessMode'],
): RuntimePaneState {
  return {
    paneId,
    paneKind,
    runtimeId: record.sessionId,
    runtimeKey: record.runtimeKey,
    displayName: record.displayName,
    workspaceLabel: record.workspaceLabel,
    accessMode,
    lifecycle: record.lifecycle,
    writeOwner: record.writeOwner,
    attachedClients: record.attachedClients,
    viewport: surface.getViewportState(),
  };
}

export class SessionHostMuxClient {
  readonly clientId: string;
  readonly clientType = 'local-terminal';

  private client: SessionHostClient;
  private paneById = new Map<string, {
    record: SessionHostRecord;
    surface: GhosttyTerminalSurface;
    paneKind: RuntimePaneState['paneKind'];
    accessMode: RuntimePaneState['accessMode'];
    requestedReadOnly: boolean;
  }>();
  private paneIdsByRuntime = new Map<string, Set<string>>();
  private workspaceById = new Map<string, MuxWorkspaceState>();
  private listeners = new Set<(event: MuxControllerEvent) => void>();
  private unsubEvents: (() => void) | null = null;

  constructor(options: SessionHostClientOptions & { clientId?: string } = {}) {
    this.client = new SessionHostClient(options);
    this.clientId = options.clientId || `terminal-ui-${randomUUID()}`;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    if (!this.unsubEvents) {
      this.unsubEvents = this.client.onEvent((event) => {
        void this.handleHostEvent(event);
      });
    }
  }

  onEvent(listener: (event: MuxControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async createWorkspace(target: string, options: CreateWorkspaceOptions = {}): Promise<MuxWorkspaceState> {
    const pane = await this.openRuntime(target, options);
    const workspace = createMuxWorkspace(pane, {
      workspaceId: options.workspaceId,
      title: options.title,
    });
    this.workspaceById.set(workspace.workspaceId, workspace);
    this.emit({ kind: 'workspace', workspace });
    return workspace;
  }

  async splitWorkspacePane(
    workspaceId: string,
    targetPaneId: string,
    runtimeTarget: string,
    options: SplitPaneOptions,
  ): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const nextPane = await this.openRuntime(runtimeTarget, options);
    const updated = splitMuxPane(workspace, targetPaneId, options.axis, nextPane);
    this.workspaceById.set(workspaceId, updated);
    this.emit({ kind: 'workspace', workspace: updated });
    return updated;
  }

  async splitWorkspaceMirror(
    workspaceId: string,
    targetPaneId: string,
    sourcePaneId: string,
    axis: SplitPaneOptions['axis'],
  ): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const source = this.requirePane(sourcePaneId);
    const paneId = randomUUID();
    const viewport = source.surface.getViewportState();
    const surface = new GhosttyTerminalSurface({
      cols: viewport.cols,
      rows: viewport.rows,
    });
    surface.resetFromText(viewport.text, viewport.snapshotSeq);
    const paneState = paneFromRecord(paneId, source.record, surface, 'mirror', 'read-only');

    this.paneById.set(paneId, {
      record: source.record,
      surface,
      paneKind: 'mirror',
      accessMode: 'read-only',
      requestedReadOnly: true,
    });
    const paneIds = this.paneIdsByRuntime.get(source.record.sessionId) || new Set<string>();
    paneIds.add(paneId);
    this.paneIdsByRuntime.set(source.record.sessionId, paneIds);

    const updated = splitMuxPane(workspace, targetPaneId, axis, paneState);
    this.workspaceById.set(workspaceId, updated);
    this.emit({ kind: 'runtime', pane: paneState });
    this.emit({ kind: 'workspace', workspace: updated });
    return updated;
  }

  async replacePaneRuntime(
    workspaceId: string,
    paneId: string,
    runtimeTarget: string,
    options: OpenRuntimeOptions = {},
  ): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const existing = this.requirePane(paneId);
    const previousRuntimeId = existing.record.sessionId;
    const replacement = await this.openRuntime(runtimeTarget, {
      ...options,
      paneId,
    });

    existing.surface.dispose();
    if (previousRuntimeId !== replacement.runtimeId) {
      const existingPaneIds = this.paneIdsByRuntime.get(previousRuntimeId);
      existingPaneIds?.delete(paneId);
      if (existingPaneIds && existingPaneIds.size === 0) {
        this.paneIdsByRuntime.delete(previousRuntimeId);
        await this.client.request({
          type: 'detach_session',
          payload: {
            sessionId: previousRuntimeId,
            clientId: this.clientId,
          },
        });
      }
    }

    const updated = updateMuxPane(workspace, replacement);
    this.workspaceById.set(workspaceId, updated);
    this.emit({ kind: 'workspace', workspace: updated });
    return updated;
  }

  async restoreWorkspace(snapshot: PersistedMuxWorkspaceState): Promise<MuxWorkspaceState> {
    await this.connect();
    const panes = Object.entries(snapshot.panes);
    if (panes.length === 0) {
      throw new Error(`Workspace ${snapshot.workspaceId} has no panes`);
    }

    const orderedPanes = panes.sort(([, left], [, right]) => {
      const leftKind = left.paneKind || 'runtime';
      const rightKind = right.paneKind || 'runtime';
      if (leftKind === rightKind) return 0;
      return leftKind === 'runtime' ? -1 : 1;
    });

    const restoredPanes: Array<readonly [string, RuntimePaneState]> = [];
    for (const [paneId, pane] of orderedPanes) {
      const paneKind = pane.paneKind || 'runtime';
      const opened = paneKind === 'mirror'
        ? await this.openMirrorRuntime(pane.runtimeId || pane.runtimeKey, { paneId })
        : await this.openRuntime(pane.runtimeId || pane.runtimeKey, {
            paneId,
            readOnly: pane.accessMode === 'read-only',
            takeover: false,
          });
      restoredPanes.push([paneId, opened] as const);
    }

    const workspace: MuxWorkspaceState = {
      workspaceId: snapshot.workspaceId,
      title: snapshot.title,
      root: snapshot.root,
      focusedPaneId: snapshot.focusedPaneId in snapshot.panes ? snapshot.focusedPaneId : restoredPanes[0]![0],
      zoomedPaneId: snapshot.zoomedPaneId && snapshot.zoomedPaneId in snapshot.panes ? snapshot.zoomedPaneId : null,
      panes: Object.fromEntries(restoredPanes),
    };
    this.workspaceById.set(workspace.workspaceId, workspace);
    this.emit({ kind: 'workspace', workspace });
    return workspace;
  }

  async closePane(workspaceId: string, paneId: string): Promise<MuxWorkspaceState | null> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = removeMuxPane(workspace, paneId);
    const pane = this.paneById.get(paneId);
    if (pane) {
      pane.surface.dispose();
      this.paneById.delete(paneId);
      const paneIds = this.paneIdsByRuntime.get(pane.record.sessionId);
      paneIds?.delete(paneId);
      if (paneIds && paneIds.size === 0) {
        this.paneIdsByRuntime.delete(pane.record.sessionId);
        await this.client.request({
          type: 'detach_session',
          payload: {
            sessionId: pane.record.sessionId,
            clientId: this.clientId,
          },
        });
      }
    }

    if (!next) {
      this.workspaceById.delete(workspaceId);
      return null;
    }

    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async focusPane(workspaceId: string, paneId: string): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = focusMuxPane(workspace, paneId);
    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async resizeLayoutPane(
    workspaceId: string,
    paneId: string,
    direction: 'left' | 'right' | 'up' | 'down',
    amount = 0.05,
  ): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = resizeMuxPane(workspace, paneId, direction, amount);
    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async rebalanceWorkspaceLayout(workspaceId: string): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = rebalanceMuxLayout(workspace);
    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async applyLayoutPreset(workspaceId: string, preset: MuxLayoutPreset): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = applyMuxLayoutPreset(workspace, preset);
    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async swapPanePositions(
    workspaceId: string,
    firstPaneId: string,
    secondPaneId: string,
  ): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = swapMuxPanePositions(workspace, firstPaneId, secondPaneId);
    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async togglePaneZoom(workspaceId: string, paneId: string): Promise<MuxWorkspaceState> {
    const workspace = this.requireWorkspace(workspaceId);
    const next = toggleMuxPaneZoom(workspace, paneId);
    this.workspaceById.set(workspaceId, next);
    this.emit({ kind: 'workspace', workspace: next });
    return next;
  }

  async sendInput(paneId: string, data: string): Promise<void> {
    const pane = this.requirePane(paneId);
    if (pane.accessMode === 'read-only' && !pane.requestedReadOnly && pane.paneKind === 'runtime') {
      await this.takeoverPane(paneId);
    }
    if (pane.accessMode === 'read-only') {
      throw new Error(`Pane ${paneId} is read-only`);
    }
    const response = await this.client.request({
      type: 'send_input',
      payload: {
        sessionId: pane.record.sessionId,
        clientId: this.clientId,
        data,
      },
    });
    if (!response.success) {
      if ((response.error || '').includes('Write owned by') && !pane.requestedReadOnly && pane.paneKind === 'runtime') {
        await this.takeoverPane(paneId);
        const retry = await this.client.request({
          type: 'send_input',
          payload: {
            sessionId: pane.record.sessionId,
            clientId: this.clientId,
            data,
          },
        });
        if (!retry.success) {
          throw new Error(retry.error || `Failed to send input to pane ${paneId}`);
        }
        return;
      }
      throw new Error(response.error || `Failed to send input to pane ${paneId}`);
    }
  }

  async resizePane(paneId: string, cols: number, rows: number): Promise<void> {
    const pane = this.requirePane(paneId);
    pane.surface.resize(cols, rows);
    await this.client.request({
      type: 'resize_session',
      payload: {
        sessionId: pane.record.sessionId,
        cols,
        rows,
      },
    });
    this.publishPaneUpdate(paneId);
  }

  async takeoverPane(paneId: string): Promise<void> {
    const pane = this.requirePane(paneId);
    const response = await this.client.request<SessionHostRecord>({
      type: 'acquire_write',
      payload: {
        sessionId: pane.record.sessionId,
        clientId: this.clientId,
        ownerType: 'user',
        force: true,
      },
    });
    if (!response.success || !response.result) {
      throw new Error(response.error || 'Failed to acquire write owner');
    }
    pane.record = response.result;
    pane.requestedReadOnly = false;
    pane.accessMode = 'interactive';
    this.publishPaneUpdate(paneId);
  }

  async releasePane(paneId: string): Promise<void> {
    const pane = this.requirePane(paneId);
    const response = await this.client.request<SessionHostRecord>({
      type: 'release_write',
      payload: {
        sessionId: pane.record.sessionId,
        clientId: this.clientId,
      },
    });
    if (!response.success || !response.result) {
      throw new Error(response.error || 'Failed to release write owner');
    }
    pane.record = response.result;
    pane.requestedReadOnly = false;
    pane.accessMode = this.computeAccessMode(pane.record, false, pane.paneKind);
    this.publishPaneUpdate(paneId);
  }

  listWorkspaces(): MuxWorkspaceState[] {
    return Array.from(this.workspaceById.values());
  }

  async listRuntimes(): Promise<SessionHostRecord[]> {
    await this.connect();
    const list = await this.client.request<SessionHostRecord[]>({ type: 'list_sessions' });
    if (!list.success || !list.result) {
      throw new Error(list.error || 'Failed to list runtimes');
    }
    return list.result;
  }

  async resumeRuntime(target: string): Promise<SessionHostRecord> {
    await this.connect();
    const record = resolveRuntimeRecord(await this.listRuntimes(), target);
    const response = await this.client.request<SessionHostRecord>({
      type: 'resume_session',
      payload: {
        sessionId: record.sessionId,
      },
    });
    if (!response.success || !response.result) {
      throw new Error(response.error || `Failed to resume runtime ${target}`);
    }
    for (const [paneId, pane] of this.paneById) {
      if (pane.record.sessionId !== record.sessionId) continue;
      pane.record = response.result;
      this.publishPaneUpdate(paneId);
    }
    return response.result;
  }

  serializeWorkspace(workspaceId: string): PersistedMuxWorkspaceState {
    return serializeWorkspace(this.requireWorkspace(workspaceId));
  }

  async close(): Promise<void> {
    for (const [paneId, pane] of this.paneById) {
      try {
        if (pane.record.writeOwner?.clientId === this.clientId) {
          await this.client.request({
            type: 'release_write',
            payload: {
              sessionId: pane.record.sessionId,
              clientId: this.clientId,
            },
          });
        }
        const siblings = this.paneIdsByRuntime.get(pane.record.sessionId);
        if (siblings?.size === 1) {
          await this.client.request({
            type: 'detach_session',
            payload: {
              sessionId: pane.record.sessionId,
              clientId: this.clientId,
            },
          });
        }
      } catch {}
      pane.surface.dispose();
      this.paneById.delete(paneId);
    }
    this.paneIdsByRuntime.clear();
    this.workspaceById.clear();
    this.unsubEvents?.();
    this.unsubEvents = null;
    await this.client.close();
  }

  private async openRuntime(target: string, options: OpenRuntimeOptions): Promise<RuntimePaneState> {
    await this.connect();
    let record = resolveRuntimeRecord(await this.listRuntimes(), target);
    if (record.lifecycle === 'interrupted') {
      try {
        record = await this.resumeRuntime(target);
      } catch {
        // Keep interrupted snapshot attach available even if resume failed.
      }
    }
    const readOnly = options.takeover ? false : !!options.readOnly || !!(record.writeOwner && record.writeOwner.clientId !== this.clientId);

    const attachResponse = await this.client.request<SessionHostRecord>({
      type: 'attach_session',
      payload: {
        sessionId: record.sessionId,
        clientId: this.clientId,
        clientType: this.clientType,
        readOnly,
      },
    });
    if (!attachResponse.success || !attachResponse.result) {
      throw new Error(attachResponse.error || `Failed to attach runtime ${target}`);
    }
    record = attachResponse.result;

    if (options.takeover) {
      const takeoverResponse = await this.client.request<SessionHostRecord>({
        type: 'acquire_write',
        payload: {
          sessionId: record.sessionId,
          clientId: this.clientId,
          ownerType: 'user',
          force: true,
        },
      });
      if (!takeoverResponse.success || !takeoverResponse.result) {
        throw new Error(takeoverResponse.error || `Failed to acquire runtime ${target}`);
      }
      record = takeoverResponse.result;
    }

    const snapshot = await this.client.request<{ seq: number; text: string }>({
      type: 'get_snapshot',
      payload: {
        sessionId: record.sessionId,
      },
    });
    if (!snapshot.success || !snapshot.result) {
      throw new Error(snapshot.error || 'Failed to get runtime snapshot');
    }

    const paneId = options.paneId || randomUUID();
    const surface = new GhosttyTerminalSurface({
      cols: options.cols ?? 120,
      rows: options.rows ?? 36,
    });
    surface.resetFromText(snapshot.result.text, snapshot.result.seq);

    const runtimeRecord = {
      ...record,
      attachedClients: record.attachedClients,
    };
    const accessMode = this.computeAccessMode(runtimeRecord, readOnly, 'runtime');
    const paneState = paneFromRecord(paneId, runtimeRecord, surface, 'runtime', accessMode);

    this.paneById.set(paneId, {
      record: runtimeRecord,
      surface,
      paneKind: 'runtime',
      accessMode,
      requestedReadOnly: readOnly,
    });
    const paneIds = this.paneIdsByRuntime.get(runtimeRecord.sessionId) || new Set<string>();
    paneIds.add(paneId);
    this.paneIdsByRuntime.set(runtimeRecord.sessionId, paneIds);
    this.emit({ kind: 'runtime', pane: paneState });
    return paneState;
  }

  private async openMirrorRuntime(
    target: string,
    options: Pick<OpenRuntimeOptions, 'paneId'> = {},
  ): Promise<RuntimePaneState> {
    const record = resolveRuntimeRecord(await this.listRuntimes(), target);
    const runtimePane = Array.from(this.paneById.values()).find((pane) => pane.record.sessionId === record.sessionId);
    if (!runtimePane) {
      throw new Error(`Cannot mirror runtime ${record.runtimeKey} before it is attached`);
    }
    const paneId = options.paneId || randomUUID();
    const viewport = runtimePane.surface.getViewportState();
    const surface = new GhosttyTerminalSurface({
      cols: viewport.cols,
      rows: viewport.rows,
    });
    surface.resetFromText(viewport.text, viewport.snapshotSeq);
    const paneState = paneFromRecord(paneId, record, surface, 'mirror', 'read-only');

    this.paneById.set(paneId, {
      record,
      surface,
      paneKind: 'mirror',
      accessMode: 'read-only',
      requestedReadOnly: true,
    });
    const paneIds = this.paneIdsByRuntime.get(record.sessionId) || new Set<string>();
    paneIds.add(paneId);
    this.paneIdsByRuntime.set(record.sessionId, paneIds);
    this.emit({ kind: 'runtime', pane: paneState });
    return paneState;
  }

  private async handleHostEvent(event: SessionHostEvent): Promise<void> {
    const paneIds = this.paneIdsByRuntime.get(event.sessionId);
    if (!paneIds || paneIds.size === 0) return;

    for (const paneId of paneIds) {
      const pane = this.paneById.get(paneId);
      if (!pane) continue;

      switch (event.type) {
        case 'session_output':
          pane.surface.write(event.data, event.seq);
          break;
        case 'session_started':
        case 'session_resumed':
          pane.record = { ...pane.record, lifecycle: 'running', osPid: event.pid ?? pane.record.osPid };
          break;
        case 'session_exit':
          pane.record = { ...pane.record, lifecycle: event.exitCode === 0 ? 'stopped' : 'failed' };
          break;
        case 'session_stopped':
          pane.record = { ...pane.record, lifecycle: 'stopped' };
          break;
        case 'session_resized':
          pane.surface.resize(event.cols, event.rows);
          break;
        case 'write_owner_changed':
          pane.record = { ...pane.record, writeOwner: event.owner };
          pane.accessMode = this.computeAccessMode(pane.record, pane.requestedReadOnly, pane.paneKind);
          break;
        case 'client_attached':
          pane.record = {
            ...pane.record,
            attachedClients: [
              ...pane.record.attachedClients.filter((client) => client.clientId !== event.client.clientId),
              event.client,
            ],
          };
          pane.accessMode = this.computeAccessMode(pane.record, pane.requestedReadOnly, pane.paneKind);
          break;
        case 'client_detached':
          pane.record = {
            ...pane.record,
            attachedClients: pane.record.attachedClients.filter((client) => client.clientId !== event.clientId),
          };
          pane.accessMode = this.computeAccessMode(pane.record, pane.requestedReadOnly, pane.paneKind);
          break;
        case 'session_created':
          pane.record = event.record;
          pane.accessMode = this.computeAccessMode(pane.record, pane.requestedReadOnly, pane.paneKind);
          break;
      }

      this.publishPaneUpdate(paneId, event);
    }
  }

  private publishPaneUpdate(paneId: string, event?: SessionHostEvent): void {
    const pane = this.requirePane(paneId);
    const paneState = paneFromRecord(paneId, pane.record, pane.surface, pane.paneKind, pane.accessMode);
    this.emit({ kind: 'runtime', pane: paneState, event });

    for (const [workspaceId, workspace] of this.workspaceById) {
      if (!workspace.panes[paneId]) continue;
      const updated = updateMuxPane(workspace, paneState);
      this.workspaceById.set(workspaceId, updated);
      this.emit({ kind: 'workspace', workspace: updated });
    }
  }

  private emit(event: MuxControllerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private requireWorkspace(workspaceId: string): MuxWorkspaceState {
    const workspace = this.workspaceById.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    return workspace;
  }

  private requirePane(paneId: string): {
    record: SessionHostRecord;
    surface: GhosttyTerminalSurface;
    paneKind: RuntimePaneState['paneKind'];
    accessMode: RuntimePaneState['accessMode'];
    requestedReadOnly: boolean;
  } {
    const pane = this.paneById.get(paneId);
    if (!pane) throw new Error(`Unknown pane: ${paneId}`);
    return pane;
  }

  private computeAccessMode(
    record: SessionHostRecord,
    requestedReadOnly: boolean,
    paneKind: RuntimePaneState['paneKind'],
  ): RuntimePaneState['accessMode'] {
    if (paneKind === 'mirror') return 'read-only';
    if (requestedReadOnly) return 'read-only';
    if (record.writeOwner && record.writeOwner.clientId !== this.clientId) return 'read-only';
    const attachedClient = record.attachedClients.find((client) => client.clientId === this.clientId);
    if (attachedClient?.readOnly) return 'read-only';
    return 'interactive';
  }
}
