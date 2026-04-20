import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import {
  SessionHostRegistry,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
} from '@adhdev/session-host-core';
import type {
  CreateSessionPayload,
  SessionHostDiagnostics,
  SessionAttachedClient,
  SessionHostDuplicateSessionGroup,
  SessionHostEndpoint,
  SessionHostEvent,
  SessionHostLogEntry,
  SessionHostPruneDuplicatesResult,
  SessionHostRecord,
  SessionHostRequestEnvelope,
  SessionHostRequestTrace,
  SessionHostRequest,
  SessionHostRuntimeTransition,
  SessionHostResponse,
} from '@adhdev/session-host-core';
import { PtySessionRuntime } from './runtime.js';
import { SessionHostStorage, type PersistedRuntimeState } from './storage.js';

export interface SessionHostServerOptions {
  endpoint?: SessionHostEndpoint;
  appName?: string;
}

export class SessionHostServer extends EventEmitter {
  private static readonly MAX_RECENT_DIAGNOSTICS = 200;

  readonly endpoint: SessionHostEndpoint;
  readonly registry = new SessionHostRegistry();
  private runtimes = new Map<string, PtySessionRuntime>();
  private readonly storage: SessionHostStorage;
  private ipcServer: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private readonly startedAt = Date.now();
  private recentLogs: SessionHostLogEntry[] = [];
  private recentRequests: SessionHostRequestTrace[] = [];
  private recentTransitions: SessionHostRuntimeTransition[] = [];
  private exitWaiters = new Map<string, Array<(exitCode: number | null) => void>>();

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
      socket.on('end', () => {
        this.sockets.delete(socket);
      });
      socket.on('error', () => {
        this.sockets.delete(socket);
        try {
          socket.destroy();
        } catch {
          // noop
        }
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

    this.recordHostLog('info', `session host endpoint ready: ${this.endpoint.path}`);
    // Do not block readiness on restoring/resuming persisted runtimes.
    // Startup callers only need the IPC endpoint to accept connections.
    setTimeout(() => {
      try {
        this.restorePersistedRuntimes();
      } catch (error: any) {
        this.recordHostLog('error', `session host restore failed: ${error?.message || String(error)}`);
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
          this.recordRuntimeTransition(record.sessionId, 'create_session', 'starting', `provider=${record.providerType}`, true);
          try {
            const startedRecord = this.startRuntime(record, request.payload, 'session_started');
            return { success: true, result: startedRecord };
          } catch (error: any) {
            this.registry.markStopped(record.sessionId, 'failed');
            this.persistNow(record.sessionId);
            this.recordRuntimeTransition(record.sessionId, 'create_session_failed', 'failed', undefined, false, error?.message || String(error));
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
          this.recordRuntimeTransition(record.sessionId, 'attach_client', record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case 'detach_session': {
          const record = this.registry.detachClient(request.payload);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: 'client_detached', sessionId: record.sessionId, clientId: request.payload.clientId });
          this.recordRuntimeTransition(record.sessionId, 'detach_client', record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case 'acquire_write': {
          const record = this.registry.acquireWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: 'write_owner_changed', sessionId: record.sessionId, owner: record.writeOwner });
          this.recordRuntimeTransition(record.sessionId, 'acquire_write', record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case 'release_write': {
          const record = this.registry.releaseWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: 'write_owner_changed', sessionId: record.sessionId, owner: record.writeOwner });
          this.recordRuntimeTransition(record.sessionId, 'release_write', record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case 'get_snapshot':
          return { success: true, result: this.getSnapshot(request.payload.sessionId, request.payload.sinceSeq) };
        case 'get_host_diagnostics':
          return { success: true, result: this.getHostDiagnostics(request.payload) };
        case 'clear_session_buffer': {
          const record = this.registry.clearBuffer(request.payload.sessionId);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: 'session_cleared', sessionId: record.sessionId });
          this.recordRuntimeTransition(record.sessionId, 'clear_buffer', record.lifecycle, undefined, true);
          return { success: true, result: record };
        }
        case 'update_session_meta': {
          const record = this.registry.updateSessionMeta(
            request.payload.sessionId,
            request.payload.meta || {},
            request.payload.replace === true,
          );
          this.persistNow(record.sessionId);
          this.recordRuntimeTransition(record.sessionId, 'update_meta', record.lifecycle, undefined, true);
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
          this.recordRuntimeTransition(request.payload.sessionId, 'stop_session', 'stopping', undefined, true);
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
          this.recordRuntimeTransition(request.payload.sessionId, 'resume_session', resumed.lifecycle, undefined, true);
          return { success: true, result: resumed };
        }
        case 'restart_session': {
          const restarted = await this.restartRuntime(request.payload.sessionId);
          return { success: true, result: restarted };
        }
        case 'prune_duplicate_sessions': {
          const result = await this.pruneDuplicateSessions(request.payload);
          return { success: true, result };
        }
        case 'send_signal': {
          const runtime = this.requireRuntime(request.payload.sessionId);
          runtime.sendSignal(request.payload.signal);
          const record = this.registry.getSession(request.payload.sessionId);
          this.recordRuntimeTransition(request.payload.sessionId, 'send_signal', record?.lifecycle, request.payload.signal, true);
          return { success: true, result: record };
        }
        case 'force_detach_client': {
          const session = this.registry.getSession(request.payload.sessionId);
          if (session?.writeOwner?.clientId === request.payload.clientId) {
            const released = this.registry.releaseWrite({
              sessionId: request.payload.sessionId,
              clientId: request.payload.clientId,
            });
            this.emitEvent({ type: 'write_owner_changed', sessionId: released.sessionId, owner: released.writeOwner });
          }
          const record = this.registry.detachClient({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId,
          });
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: 'client_detached', sessionId: record.sessionId, clientId: request.payload.clientId });
          this.recordRuntimeTransition(record.sessionId, 'force_detach_client', record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
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
    for (const socket of [...this.sockets]) {
      this.writeEnvelopeSafely(socket, {
        kind: 'event',
        event,
      });
    }
    this.emit('event', event);
  }

  private async handleIncomingRequest(socket: net.Socket, envelope: SessionHostRequestEnvelope): Promise<void> {
    const startedAt = Date.now();
    const response = await this.handleRequest(envelope.request);
    this.recordRequestTrace({
      timestamp: startedAt,
      requestId: envelope.requestId,
      type: envelope.request.type,
      sessionId: this.getRequestSessionId(envelope.request),
      clientId: this.getRequestClientId(envelope.request),
      success: response.success,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: response.success ? undefined : response.error,
    });
    this.writeEnvelopeSafely(socket, createResponseEnvelope(envelope.requestId, response));
  }

  private writeEnvelopeSafely(socket: net.Socket, envelope: SessionHostRequestEnvelope | ReturnType<typeof createResponseEnvelope> | { kind: 'event'; event: SessionHostEvent }): void {
    if (socket.destroyed || !socket.writable || socket.writableEnded) {
      this.sockets.delete(socket);
      return;
    }
    const payload = `${JSON.stringify(envelope)}\n`;
    try {
      socket.write(payload, (error?: Error | null) => {
        if (!error) return;
        this.sockets.delete(socket);
        try {
          socket.destroy();
        } catch {
          // noop
        }
      });
    } catch {
      this.sockets.delete(socket);
      try {
        socket.destroy();
      } catch {
        // noop
      }
    }
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

  private getSessionHostRecoveryLabel(record: SessionHostRecord): string | null {
    const recoveryState = typeof record.meta?.runtimeRecoveryState === 'string'
      ? String(record.meta.runtimeRecoveryState).trim()
      : '';
    if (!recoveryState) return null;
    if (recoveryState === 'auto_resumed') return 'restored after restart';
    if (recoveryState === 'resume_failed') return 'restore failed';
    if (recoveryState === 'host_restart_interrupted') return 'host restart interrupted';
    if (recoveryState === 'orphan_snapshot') return 'snapshot recovered';
    return recoveryState.replace(/_/g, ' ');
  }

  private getSessionSurfaceKind(record: SessionHostRecord): 'live_runtime' | 'recovery_snapshot' | 'inactive_record' {
    if (['starting', 'running', 'stopping', 'interrupted'].includes(record.lifecycle)) {
      return 'live_runtime';
    }
    if ((record.lifecycle === 'stopped' || record.lifecycle === 'failed') && (record.meta?.restoredFromStorage === true || this.getSessionHostRecoveryLabel(record))) {
      return 'recovery_snapshot';
    }
    return 'inactive_record';
  }

  private annotateSessionSurface(record: SessionHostRecord): SessionHostRecord {
    return {
      ...record,
      surfaceKind: this.getSessionSurfaceKind(record),
    };
  }

  private sanitizeDiagnosticsRecord(record: SessionHostRecord): SessionHostRecord {
    return {
      ...record,
      launchCommand: {
        command: record.launchCommand.command,
        args: Array.isArray(record.launchCommand.args) ? [...record.launchCommand.args] : [],
      },
    };
  }

  private getHostDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): SessionHostDiagnostics {
    const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 50));
    const sessions = payload?.includeSessions === false
      ? undefined
      : this.registry.listSessions()
        .map((record) => this.annotateSessionSurface(record))
        .map((record) => this.sanitizeDiagnosticsRecord(record));
    const liveRuntimes = sessions?.filter((record) => record.surfaceKind === 'live_runtime');
    const recoverySnapshots = sessions?.filter((record) => record.surfaceKind === 'recovery_snapshot');
    const inactiveRecords = sessions?.filter((record) => record.surfaceKind === 'inactive_record');
    return {
      hostStartedAt: this.startedAt,
      endpoint: this.endpoint.path,
      runtimeCount: this.runtimes.size,
      sessions,
      liveRuntimes,
      recoverySnapshots,
      inactiveRecords,
      recentLogs: this.recentLogs.slice(-limit),
      recentRequests: this.recentRequests.slice(-limit),
      recentTransitions: this.recentTransitions.slice(-limit),
    };
  }

  private getRequestSessionId(request: SessionHostRequest): string | undefined {
    const payload = (request as { payload?: Record<string, unknown> }).payload;
    return typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
  }

  private getRequestClientId(request: SessionHostRequest): string | undefined {
    const payload = (request as { payload?: Record<string, unknown> }).payload;
    return typeof payload?.clientId === 'string' ? payload.clientId : undefined;
  }

  private pushRecent<T>(bucket: T[], entry: T): void {
    bucket.push(entry);
    if (bucket.length > SessionHostServer.MAX_RECENT_DIAGNOSTICS) {
      bucket.splice(0, bucket.length - SessionHostServer.MAX_RECENT_DIAGNOSTICS);
    }
  }

  private recordHostLog(
    level: SessionHostLogEntry['level'],
    message: string,
    sessionId?: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: SessionHostLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      sessionId,
      data,
    };
    this.pushRecent(this.recentLogs, entry);
    this.emitEvent({ type: 'host_log', entry });
    this.emit('log', `[${level}] ${message}`);
  }

  private recordRequestTrace(trace: SessionHostRequestTrace): void {
    this.pushRecent(this.recentRequests, trace);
    this.emitEvent({ type: 'request_trace', trace });
    if (!trace.success) {
      this.recordHostLog(
        'warn',
        `request ${trace.type} failed after ${trace.durationMs}ms${trace.error ? `: ${trace.error}` : ''}`,
        trace.sessionId,
        { requestId: trace.requestId, clientId: trace.clientId },
      );
    }
  }

  private recordRuntimeTransition(
    sessionId: string,
    action: string,
    lifecycle?: SessionHostRuntimeTransition['lifecycle'],
    detail?: string,
    success = true,
    error?: string,
  ): void {
    const transition: SessionHostRuntimeTransition = {
      timestamp: Date.now(),
      sessionId,
      action,
      lifecycle,
      detail,
      success,
      error,
    };
    this.pushRecent(this.recentTransitions, transition);
    this.emitEvent({ type: 'runtime_transition', transition });
  }

  private waitForRuntimeExit(sessionId: string, timeoutMs = 5_000): Promise<number | null> {
    if (!this.runtimes.has(sessionId)) {
      return Promise.resolve(this.registry.getSession(sessionId)?.lifecycle === 'failed' ? 1 : 0);
    }
    return new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.exitWaiters.get(sessionId) || [];
        this.exitWaiters.set(sessionId, waiters.filter((waiter) => waiter !== onExit));
        reject(new Error(`Timed out waiting for runtime ${sessionId} to exit`));
      }, timeoutMs);
      const onExit = (exitCode: number | null) => {
        clearTimeout(timeout);
        resolve(exitCode);
      };
      const waiters = this.exitWaiters.get(sessionId) || [];
      waiters.push(onExit);
      this.exitWaiters.set(sessionId, waiters);
    });
  }

  private resolveExitWaiters(sessionId: string, exitCode: number | null): void {
    const waiters = this.exitWaiters.get(sessionId);
    if (!waiters?.length) return;
    this.exitWaiters.delete(sessionId);
    for (const waiter of waiters) {
      try {
        waiter(exitCode);
      } catch {
        // noop
      }
    }
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

  private async restartRuntime(sessionId: string): Promise<SessionHostRecord> {
    const existing = this.registry.getSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    if (this.runtimes.has(sessionId)) {
      this.registry.setLifecycle(sessionId, 'stopping');
      this.persistNow(sessionId);
      this.recordRuntimeTransition(sessionId, 'restart_requested', 'stopping', undefined, true);
      this.requireRuntime(sessionId).stop();
      await this.waitForRuntimeExit(sessionId);
    }

    const latest = this.registry.getSession(sessionId) || existing;
    const restarted = this.startRuntime(latest, this.buildPayloadFromRecord(latest), 'session_resumed');
    this.recordRuntimeTransition(sessionId, 'restart_completed', restarted.lifecycle, undefined, true);
    return restarted;
  }

  private async pruneDuplicateSessions(payload?: {
    providerType?: string;
    workspace?: string;
    dryRun?: boolean;
  }): Promise<SessionHostPruneDuplicatesResult> {
    const providerFilter = typeof payload?.providerType === 'string' ? payload.providerType.trim() : '';
    const workspaceFilter = typeof payload?.workspace === 'string' ? payload.workspace.trim() : '';
    const dryRun = payload?.dryRun === true;

    const sessions = this.registry.listSessions()
      .filter((record) => ['starting', 'running', 'stopping', 'interrupted'].includes(record.lifecycle))
      .filter((record) => !providerFilter || record.providerType === providerFilter)
      .filter((record) => !workspaceFilter || record.workspace === workspaceFilter);

    const groups = new Map<string, SessionHostRecord[]>();
    for (const record of sessions) {
      const providerSessionId = typeof record.meta?.providerSessionId === 'string'
        ? String(record.meta.providerSessionId).trim()
        : '';
      if (!providerSessionId) continue;
      const bindingKey = `${record.providerType}::${record.workspace}::${providerSessionId}`;
      const bucket = groups.get(bindingKey) || [];
      bucket.push(record);
      groups.set(bindingKey, bucket);
    }

    const duplicateGroups: SessionHostDuplicateSessionGroup[] = [];
    const keptSessionIds: string[] = [];
    const prunedSessionIds: string[] = [];

    for (const [bindingKey, records] of groups.entries()) {
      if (records.length < 2) continue;
      const sorted = [...records].sort((a, b) => this.compareDuplicateCandidates(a, b));
      const kept = sorted[0];
      const duplicates = sorted.slice(1);
      const providerSessionId = typeof kept.meta?.providerSessionId === 'string'
        ? String(kept.meta.providerSessionId)
        : '';
      duplicateGroups.push({
        bindingKey,
        providerType: kept.providerType,
        workspace: kept.workspace,
        providerSessionId,
        keptSessionId: kept.sessionId,
        prunedSessionIds: duplicates.map((record) => record.sessionId),
      });
      keptSessionIds.push(kept.sessionId);

      if (dryRun) continue;

      for (const duplicate of duplicates) {
        await this.pruneDuplicateRuntime(duplicate);
        prunedSessionIds.push(duplicate.sessionId);
      }
    }

    this.recordHostLog(
      dryRun ? 'info' : 'warn',
      `${dryRun ? 'session host dry-run found' : 'session host pruned'} ${duplicateGroups.length} duplicate group(s)`,
      undefined,
      {
        providerType: providerFilter || undefined,
        workspace: workspaceFilter || undefined,
        dryRun,
        prunedSessionIds,
        keptSessionIds,
      },
    );

    return {
      duplicateGroupCount: duplicateGroups.length,
      keptSessionIds,
      prunedSessionIds,
      groups: duplicateGroups,
    };
  }

  private restorePersistedRuntimes(): void {
    const states = this.storage.loadAll();
    let skippedAutoResumeSessions = 0;
    for (const persisted of states) {
      const wasLiveRuntime = !['stopped', 'failed'].includes(persisted.record.lifecycle);
      const hadAttachedClients = Array.isArray(persisted.record.attachedClients) && persisted.record.attachedClients.length > 0;
      const hadWriteOwner = !!persisted.record.writeOwner;
      const hadRecoveryInterest = hadAttachedClients || hadWriteOwner;
      const recoveredRecord: SessionHostRecord = {
        ...persisted.record,
        attachedClients: [],
        writeOwner: null,
        lifecycle: wasLiveRuntime ? 'stopped' : persisted.record.lifecycle,
        lastActivityAt: Date.now(),
        meta: {
          ...(persisted.record.meta || {}),
          restoredFromStorage: true,
          runtimeRecoveryState: wasLiveRuntime ? 'orphan_snapshot' : 'snapshot',
          runtimeHadAttachedClientsAtCrash: hadAttachedClients,
          runtimeHadWriteOwnerAtCrash: hadWriteOwner,
          runtimeAutoResumeSkipped: wasLiveRuntime && hadRecoveryInterest,
        },
      };
      this.registry.restoreSession(recoveredRecord, persisted.snapshot);
      this.storage.save(recoveredRecord, persisted.snapshot);
      if (wasLiveRuntime && hadRecoveryInterest) {
        skippedAutoResumeSessions += 1;
      }
    }

    if (skippedAutoResumeSessions > 0) {
      this.recordHostLog('warn', `session host restored ${skippedAutoResumeSessions} live runtime snapshot(s) without auto-resume`);
    }
  }

  private compareDuplicateCandidates(a: SessionHostRecord, b: SessionHostRecord): number {
    const score = (record: SessionHostRecord) => {
      const lifecycleScore = record.lifecycle === 'running'
        ? 4
        : record.lifecycle === 'starting'
          ? 3
          : record.lifecycle === 'stopping'
            ? 2
            : record.lifecycle === 'interrupted'
              ? 1
              : 0;
      return [
        lifecycleScore,
        record.writeOwner ? 1 : 0,
        Array.isArray(record.attachedClients) ? record.attachedClients.length : 0,
        record.lastActivityAt || 0,
        record.startedAt || 0,
        record.createdAt || 0,
      ];
    };

    const aScore = score(a);
    const bScore = score(b);
    for (let i = 0; i < aScore.length; i += 1) {
      if (aScore[i] === bScore[i]) continue;
      return bScore[i] - aScore[i];
    }
    return 0;
  }

  private async pruneDuplicateRuntime(record: SessionHostRecord): Promise<void> {
    const providerSessionId = typeof record.meta?.providerSessionId === 'string'
      ? String(record.meta.providerSessionId)
      : undefined;
    this.recordRuntimeTransition(
      record.sessionId,
      'prune_duplicate_session',
      record.lifecycle,
      providerSessionId ? `providerSessionId=${providerSessionId}` : undefined,
      true,
    );

    if (this.runtimes.has(record.sessionId)) {
      this.registry.setLifecycle(record.sessionId, 'stopping');
      this.persistNow(record.sessionId);
      this.requireRuntime(record.sessionId).stop();
      await this.waitForRuntimeExit(record.sessionId).catch((error: any) => {
        this.recordRuntimeTransition(record.sessionId, 'prune_duplicate_timeout', 'stopping', undefined, false, error?.message || String(error));
      });
    }

    this.registry.deleteSession(record.sessionId);
    this.storage.remove(record.sessionId);
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
        this.resolveExitWaiters(record.sessionId, exitCode);
        this.persistNow(record.sessionId);
        this.emitEvent({ type: 'session_exit', sessionId: record.sessionId, exitCode });
        this.recordRuntimeTransition(
          record.sessionId,
          'session_exit',
          exitCode === 0 ? 'stopped' : 'failed',
          undefined,
          exitCode === 0,
          exitCode === 0 ? undefined : `exitCode=${exitCode}`,
        );
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
    this.recordRuntimeTransition(record.sessionId, startEventType, startedRecord.lifecycle, `pid=${pid}`, true);
    return startedRecord;
  }
}
