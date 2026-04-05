import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import {
  SessionHostRegistry,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
  writeEnvelope,
} from '@adhdev/session-host-core';
import type {
  CreateSessionPayload,
  SessionAttachedClient,
  SessionHostEndpoint,
  SessionHostEvent,
  SessionHostRecord,
  SessionHostRequestEnvelope,
  SessionHostRequest,
  SessionHostResponse,
} from '@adhdev/session-host-core';
import { PtySessionRuntime } from './runtime.js';
import { SessionHostStorage, type PersistedRuntimeState } from './storage.js';

export interface SessionHostServerOptions {
  endpoint?: SessionHostEndpoint;
  appName?: string;
}

export class SessionHostServer extends EventEmitter {
  readonly endpoint: SessionHostEndpoint;
  readonly registry = new SessionHostRegistry();
  private runtimes = new Map<string, PtySessionRuntime>();
  private readonly storage: SessionHostStorage;
  private ipcServer: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private persistTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: SessionHostServerOptions = {}) {
    super();
    this.endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || 'adhdev');
    this.storage = new SessionHostStorage({ appName: options.appName || 'adhdev' });
  }

  async start(): Promise<void> {
    if (this.endpoint.kind === 'unix') {
      try {
        fs.unlinkSync(this.endpoint.path);
      } catch {
        // noop
      }
    }

    this.ipcServer = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
      socket.on('data', createLineParser((envelope) => {
        if (envelope.kind !== 'request') return;
        void this.handleIncomingRequest(socket, envelope);
      }));
    });

    await new Promise<void>((resolve, reject) => {
      this.ipcServer?.once('listening', () => resolve());
      this.ipcServer?.once('error', reject);
      this.ipcServer?.listen(this.endpoint.path);
    });

    this.emit('log', `session host endpoint ready: ${this.endpoint.path}`);
    // Do not block readiness on restoring/resuming persisted runtimes.
    // Startup callers only need the IPC endpoint to accept connections.
    setTimeout(() => {
      try {
        this.restorePersistedRuntimes();
      } catch (error: any) {
        this.emit('log', `session host restore failed: ${error?.message || String(error)}`);
      }
    }, 0);
  }

  async stop(): Promise<void> {
    this.flushAllPersistence();
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.stop();
      } catch {
        // noop
      }
    }
    this.runtimes.clear();
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.ipcServer) {
      const server = this.ipcServer;
      this.ipcServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.endpoint.kind === 'unix') {
      try {
        fs.unlinkSync(this.endpoint.path);
      } catch {
        // noop
      }
    }
    this.removeAllListeners();
  }

  async handleRequest(request: SessionHostRequest): Promise<SessionHostResponse> {
    try {
      switch (request.type) {
        case 'create_session': {
          const record = this.registry.createSession(request.payload);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: 'session_created', sessionId: record.sessionId, record });
          try {
            const startedRecord = this.startRuntime(record, request.payload, 'session_started');
            return { success: true, result: startedRecord };
          } catch (error: any) {
            this.registry.markStopped(record.sessionId, 'failed');
            this.persistNow(record.sessionId);
            return { success: false, error: error?.message || String(error) };
          }
        }
        case 'list_sessions':
          return { success: true, result: this.registry.listSessions() };
        case 'attach_session': {
          const record = this.registry.attachClient(request.payload);
          this.schedulePersist(record.sessionId);
          const client = record.attachedClients.find(item => item.clientId === request.payload.clientId);
          if (client) {
            this.emitEvent({ type: 'client_attached', sessionId: record.sessionId, client });
          }
          return { success: true, result: record };
        }
        case 'detach_session': {
          const record = this.registry.detachClient(request.payload);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: 'client_detached', sessionId: record.sessionId, clientId: request.payload.clientId });
          return { success: true, result: record };
        }
        case 'acquire_write': {
          const record = this.registry.acquireWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: 'write_owner_changed', sessionId: record.sessionId, owner: record.writeOwner });
          return { success: true, result: record };
        }
        case 'release_write': {
          const record = this.registry.releaseWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: 'write_owner_changed', sessionId: record.sessionId, owner: record.writeOwner });
          return { success: true, result: record };
        }
        case 'get_snapshot':
          return { success: true, result: this.getSnapshot(request.payload.sessionId, request.payload.sinceSeq) };
        case 'clear_session_buffer': {
          const record = this.registry.clearBuffer(request.payload.sessionId);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: 'session_cleared', sessionId: record.sessionId });
          return { success: true, result: record };
        }
        case 'update_session_meta': {
          const record = this.registry.updateSessionMeta(
            request.payload.sessionId,
            request.payload.meta || {},
            request.payload.replace === true,
          );
          this.persistNow(record.sessionId);
          return { success: true, result: record };
        }
        case 'send_input': {
          const client = this.getAttachedClient(request.payload.sessionId, request.payload.clientId);
          if (client?.readOnly) {
            return { success: false, error: `Client ${request.payload.clientId} is read-only` };
          }
          const session = this.registry.getSession(request.payload.sessionId);
          if (session?.writeOwner && session.writeOwner.clientId !== request.payload.clientId) {
            return { success: false, error: `Write owned by ${session.writeOwner.clientId}` };
          }
          this.requireRuntime(request.payload.sessionId).write(request.payload.data);
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case 'resize_session': {
          this.requireRuntime(request.payload.sessionId).resize(request.payload.cols, request.payload.rows);
          const record = this.registry.getSession(request.payload.sessionId);
          if (record) {
            this.registry.restoreSession(
              {
                ...record,
                meta: {
                  ...(record.meta || {}),
                  sessionHostCols: request.payload.cols,
                  sessionHostRows: request.payload.rows,
                },
              },
              this.registry.getSnapshot(request.payload.sessionId),
            );
          }
          this.schedulePersist(request.payload.sessionId);
          this.emitEvent({
            type: 'session_resized',
            sessionId: request.payload.sessionId,
            cols: request.payload.cols,
            rows: request.payload.rows,
          });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case 'stop_session': {
          this.registry.setLifecycle(request.payload.sessionId, 'stopping');
          this.persistNow(request.payload.sessionId);
          this.requireRuntime(request.payload.sessionId).stop();
          this.emitEvent({ type: 'session_stopped', sessionId: request.payload.sessionId });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case 'resume_session': {
          const existing = this.registry.getSession(request.payload.sessionId);
          if (!existing) {
            return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          }
          if (this.runtimes.has(request.payload.sessionId)) {
            return { success: true, result: existing };
          }
          const resumed = this.startRuntime(existing, this.buildPayloadFromRecord(existing), 'session_resumed');
          return { success: true, result: resumed };
        }
        default:
          return { success: false, error: `Unsupported session host request: ${(request as { type?: string })?.type || 'unknown'}` };
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  private requireRuntime(sessionId: string): PtySessionRuntime {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error(`Runtime not found for session: ${sessionId}`);
    return runtime;
  }

  private getAttachedClient(sessionId: string, clientId: string): SessionAttachedClient | null {
    const session = this.registry.getSession(sessionId);
    return session?.attachedClients.find((client) => client.clientId === clientId) || null;
  }

  private emitEvent(event: SessionHostEvent): void {
    for (const socket of this.sockets) {
      writeEnvelope(socket, {
        kind: 'event',
        event,
      });
    }
    this.emit('event', event);
  }

  private async handleIncomingRequest(socket: net.Socket, envelope: SessionHostRequestEnvelope): Promise<void> {
    const response = await this.handleRequest(envelope.request);
    writeEnvelope(socket, createResponseEnvelope(envelope.requestId, response));
  }

  private schedulePersist(sessionId: string): void {
    const existing = this.persistTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.persistTimers.set(sessionId, setTimeout(() => {
      this.persistTimers.delete(sessionId);
      this.persistNow(sessionId);
    }, 200));
  }

  private persistNow(sessionId: string): void {
    const record = this.registry.getSession(sessionId);
    if (!record) return;
    const snapshot = this.getSnapshot(sessionId);
    this.storage.save(record, snapshot);
  }

  private getSnapshot(sessionId: string, sinceSeq?: number) {
    const snapshot = this.registry.getSnapshot(sessionId, sinceSeq);
    const record = this.registry.getSession(sessionId);
    if (typeof sinceSeq === 'number') {
      return {
        ...snapshot,
        cols: typeof record?.meta?.sessionHostCols === 'number' ? (record.meta.sessionHostCols as number) : 80,
        rows: typeof record?.meta?.sessionHostRows === 'number' ? (record.meta.sessionHostRows as number) : 24,
      };
    }

    const runtime = this.runtimes.get(sessionId);
    const runtimeText = runtime?.getSnapshotText?.() || '';
    if (!runtimeText) {
      return {
        ...snapshot,
        cols: typeof record?.meta?.sessionHostCols === 'number' ? (record.meta.sessionHostCols as number) : 80,
        rows: typeof record?.meta?.sessionHostRows === 'number' ? (record.meta.sessionHostRows as number) : 24,
      };
    }

    return {
      ...snapshot,
      text: runtimeText,
      truncated: false,
      cols: typeof record?.meta?.sessionHostCols === 'number' ? (record.meta.sessionHostCols as number) : 80,
      rows: typeof record?.meta?.sessionHostRows === 'number' ? (record.meta.sessionHostRows as number) : 24,
    };
  }

  flushAllPersistence(): void {
    for (const sessionId of this.runtimes.keys()) {
      this.persistNow(sessionId);
    }
    for (const record of this.registry.listSessions()) {
      this.persistNow(record.sessionId);
    }
  }

  private restorePersistedRuntimes(): void {
    const states = this.storage.loadAll();
    const runtimesToResume: Array<{
      persisted: PersistedRuntimeState;
      recoveredRecord: SessionHostRecord;
    }> = [];
    for (const persisted of states) {
      const wasLiveRuntime = !['stopped', 'failed'].includes(persisted.record.lifecycle);
      const recoveredRecord: SessionHostRecord = {
        ...persisted.record,
        attachedClients: [],
        writeOwner: null,
        lifecycle: wasLiveRuntime ? 'interrupted' : persisted.record.lifecycle,
        lastActivityAt: Date.now(),
        meta: {
          ...(persisted.record.meta || {}),
          restoredFromStorage: true,
          runtimeRecoveryState: wasLiveRuntime ? 'host_restart_interrupted' : 'snapshot',
        },
      };
      this.registry.restoreSession(recoveredRecord, persisted.snapshot);
      this.storage.save(recoveredRecord, persisted.snapshot);
      if (wasLiveRuntime) {
        runtimesToResume.push({ persisted, recoveredRecord });
      }
    }

    for (const { persisted, recoveredRecord } of runtimesToResume) {
      try {
        const resumed = this.startRuntime(
          recoveredRecord,
          this.buildPayloadFromRecord(recoveredRecord),
          'session_resumed',
        );
        const resumedMeta = {
          ...(resumed.meta || {}),
          restoredFromStorage: true,
          runtimeRecoveryState: 'auto_resumed',
        };
        this.registry.restoreSession(
          { ...resumed, meta: resumedMeta },
          this.registry.getSnapshot(resumed.sessionId),
        );
        this.persistNow(resumed.sessionId);
      } catch (error: any) {
        const interrupted = this.registry.setLifecycle(recoveredRecord.sessionId, 'interrupted');
        this.registry.restoreSession({
          ...interrupted,
          meta: {
            ...(interrupted.meta || {}),
            restoredFromStorage: true,
            runtimeRecoveryState: 'resume_failed',
            runtimeRecoveryError: error?.message || String(error),
          },
        }, persisted.snapshot);
        this.persistNow(recoveredRecord.sessionId);
      }
    }
  }

  private buildPayloadFromRecord(record: SessionHostRecord): CreateSessionPayload {
    return {
      sessionId: record.sessionId,
      runtimeKey: record.runtimeKey,
      displayName: record.displayName,
      providerType: record.providerType,
      category: record.category,
      workspace: record.workspace,
      launchCommand: record.launchCommand,
      cols: typeof record.meta?.sessionHostCols === 'number' ? (record.meta.sessionHostCols as number) : 80,
      rows: typeof record.meta?.sessionHostRows === 'number' ? (record.meta.sessionHostRows as number) : 24,
      meta: record.meta,
    };
  }

  private startRuntime(
    record: SessionHostRecord,
    payload: CreateSessionPayload,
    startEventType: 'session_started' | 'session_resumed',
  ): SessionHostRecord {
    const runtime = new PtySessionRuntime({
      sessionId: record.sessionId,
      payload,
      onData: (data) => {
        const { seq } = this.registry.appendOutput(record.sessionId, data);
        this.schedulePersist(record.sessionId);
        this.emitEvent({ type: 'session_output', sessionId: record.sessionId, seq, data });
      },
      onExit: (exitCode) => {
        this.registry.markStopped(record.sessionId, exitCode === 0 ? 'stopped' : 'failed');
        this.runtimes.delete(record.sessionId);
        this.persistNow(record.sessionId);
        this.emitEvent({ type: 'session_exit', sessionId: record.sessionId, exitCode });
        // Clean up persistence file after a brief delay (allow post-mortem reads)
        setTimeout(() => this.storage.remove(record.sessionId), 5_000);
      },
    });

    this.registry.setLifecycle(record.sessionId, 'starting');
    const pid = runtime.start();
    this.runtimes.set(record.sessionId, runtime);
    const startedRecord = this.registry.markStarted(record.sessionId, pid);
    this.persistNow(record.sessionId);
    this.emitEvent({ type: startEventType, sessionId: record.sessionId, pid });
    return startedRecord;
  }
}
