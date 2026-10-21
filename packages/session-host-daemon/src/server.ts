import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'node:path';
import {
  SessionHostRegistry,
  classifyTermination,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
  isTerminalRecord,
} from '@adhdev/session-host-core';
import type {
  CreateSessionPayload,
  SessionAttachedClient,
  SessionHostDiagnostics,
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
  SessionTermination,
} from '@adhdev/session-host-core';
import { PtySessionRuntime } from './runtime.js';
import { HostUpgradeLease, type HostUpgradeBinding } from './upgrade-lease.js';
import { SessionHostStorage } from './storage.js';
import {
  buildHostDiagnostics,
  pushRecent,
} from './session-diagnostics.js';
import {
  buildPayloadFromRecord,
  buildRecoveredRecord,
  planDuplicatePrune,
} from './session-lifecycle.js';
import {
  getRequestClientId,
  getRequestSessionId,
  mergeRuntimeSnapshot,
} from './session-protocol.js';

export const DEFAULT_EVICT_SIGKILL_GRACE_MS = 4_000;

export function isManagedSessionHostCommandLine(commandLine: string | null | undefined): boolean {
  if (!commandLine) return false;
  const tokens: string[] = [];
  const tokenRegex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  if (tokens.length === 0) return false;

  const execBase = path.basename(tokens[0].replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (execBase === 'adhdev-sessiond') {
    const subcommand = tokens[1]?.toLowerCase();
    return !subcommand || subcommand === 'serve';
  }
  if (execBase !== 'node') return false;

  const valueFlags = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C']);
  let idx = 1;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token === '--') {
      idx += 1;
      break;
    }
    if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') {
      return false;
    }
    if (valueFlags.has(token)) {
      idx += 2;
      continue;
    }
    if (token.startsWith('-')) {
      idx += 1;
      continue;
    }
    break;
  }

  const scriptToken = tokens[idx];
  if (!scriptToken) return false;
  const normalizedScript = scriptToken.replace(/\\/g, '/').toLowerCase();
  const isSessionHostEntry =
    normalizedScript.endsWith('/session-host-daemon/dist/index.js')
    || normalizedScript.endsWith('/session-host-daemon/dist/index.mjs')
    || normalizedScript.endsWith('/session-host-daemon/index.js')
    || normalizedScript.endsWith('/session-host-daemon/src/index.ts')
    || path.basename(normalizedScript) === 'adhdev-sessiond';
  if (!isSessionHostEntry) return false;

  const subcommand = tokens[idx + 1]?.toLowerCase();
  return !subcommand || subcommand === 'serve' || subcommand.startsWith('-');
}

export interface SessionHostServerOptions {
  endpoint?: SessionHostEndpoint;
  /** Opt-in pinned native binding; absent hosts cannot attest an upgrade idle lease. */
  upgradeBinding?: HostUpgradeBinding;
  appName?: string;
  /** Explicit session-host state root (runtime records + tombstones). */
  storageRootDir?: string;
  /** Optional pidfile path checked before unlinking/rebinding a unix socket endpoint. */
  pidFilePath?: string;
  /** Optional predicate override for testing whether a prior pid is a managed session-host. */
  isManagedOwnerPid?: (pid: number) => boolean;
  /** Grace period between SIGTERM and SIGKILL when evicting an unresponsive prior host (defaults to 4000ms). */
  evictGraceMs?: number;
}

export class SessionHostServer extends EventEmitter {
  readonly endpoint: SessionHostEndpoint;
  readonly registry = new SessionHostRegistry();
  private runtimes = new Map<string, PtySessionRuntime>();
  private readonly storage: SessionHostStorage;
  private readonly upgradeLease: HostUpgradeLease | null;
  private readonly pidFilePath: string | null;
  private readonly isManagedOwnerPid?: (pid: number) => boolean;
  private readonly evictGraceMs: number;
  private restorePending = true;
  private mutatingRequests = 0;
  private endpointInode: bigint | null = null;
  private ipcServer: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  // Tracks which sessionIds each socket has subscribed to (via create/attach).
  // Used to avoid broadcasting session-specific events to uninterested sockets.
  private socketSessions = new Map<net.Socket, Set<string>>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private readonly startedAt = Date.now();
  private recentLogs: SessionHostLogEntry[] = [];
  private recentRequests: SessionHostRequestTrace[] = [];
  private recentTransitions: SessionHostRuntimeTransition[] = [];
  private exitWaiters = new Map<string, Array<(exitCode: number | null) => void>>();
  private lastNoOutputInputWarnAt = new Map<string, number>();
  // Records the most recent explicit stop/delete/restart/prune request per
  // session so the termination diagnostic can attribute the exit to it.
  private stopRequests = new Map<string, SessionTermination['requestedStop']>();
  // Shutdown is driven by independent SIGINT/SIGTERM handlers, so stop() can be
  // entered twice. Cache the in-flight promise and hand it to every later caller
  // instead of re-running flushAllPersistence()/runtime.stop() on already-cleared state.
  private stopPromise: Promise<void> | null = null;

  constructor(options: SessionHostServerOptions = {}) {
    super();
    this.endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || 'adhdev');
    if (options.upgradeBinding) {
      const relative = options.storageRootDir && path.relative(options.upgradeBinding.stateDir, options.storageRootDir);
      if (this.endpoint.kind !== 'unix' || !options.storageRootDir || !path.isAbsolute(options.storageRootDir) ||
          !path.isAbsolute(options.upgradeBinding.stateDir) || relative === '..' || relative?.startsWith(`..${path.sep}`) || path.isAbsolute(relative || '')) {
        throw new Error('native_host_instance_storage_binding_required');
      }
    }
    this.upgradeLease = options.upgradeBinding
      ? new HostUpgradeLease(options.upgradeBinding, this.endpoint.path) : null;
    this.pidFilePath = options.pidFilePath || null;
    this.isManagedOwnerPid = options.isManagedOwnerPid;
    this.evictGraceMs = options.evictGraceMs ?? DEFAULT_EVICT_SIGKILL_GRACE_MS;
    this.storage = new SessionHostStorage({
      appName: options.appName || 'adhdev',
      rootDir: options.storageRootDir,
    });
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  }

  private readProcessArgs(pid: number): string | null {
    if (process.platform === 'win32') return null;
    try {
      return String(
        execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2_000,
          windowsHide: true,
        }),
      ).trim() || null;
    } catch {
      return null;
    }
  }

  private isManagedSessionHostPid(pid: number): boolean {
    if (pid === process.pid || !Number.isFinite(pid) || pid <= 0) return false;
    if (this.isManagedOwnerPid) return this.isManagedOwnerPid(pid);
    const cmd = this.readProcessArgs(pid);
    return isManagedSessionHostCommandLine(cmd);
  }

  private async evictPriorEndpointOwners(): Promise<void> {
    if (this.endpoint.kind !== 'unix') return;
    const candidatePids = new Set<number>();
    if (this.pidFilePath && fs.existsSync(this.pidFilePath)) {
      try {
        const pid = Number.parseInt(fs.readFileSync(this.pidFilePath, 'utf8').trim(), 10);
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
          candidatePids.add(pid);
        }
      } catch {
        // noop
      }
    }
    if (process.platform !== 'win32' && fs.existsSync(this.endpoint.path)) {
      const lsofBin = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
      try {
        // IMPORTANT (C1): never pass `-U` without `-a` — lsof ORs selectors by default,
        // which would enumerate every unix-socket process on the machine. Passing only
        // the file path `-- <endpoint.path>` restricts lsof to this exact socket file.
        const out = String(
          execFileSync(lsofBin, ['-n', '-t', '--', this.endpoint.path], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
            windowsHide: true,
          }),
        );
        for (const line of out.split(/\r?\n/)) {
          const pid = Number.parseInt(line.trim(), 10);
          if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
            candidatePids.add(pid);
          }
        }
      } catch {
        // noop
      }
    }

    for (const pid of candidatePids) {
      if (!this.isPidAlive(pid) || !this.isManagedSessionHostPid(pid)) continue;
      const cmd = this.readProcessArgs(pid) || 'managed-session-host';
      this.recordHostLog(
        'warn',
        `evicting prior session-host process pid=${pid} on ${this.endpoint.path} (grace=${this.evictGraceMs}ms, cmd=${cmd})`,
      );
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        continue;
      }
      const deadline = Date.now() + this.evictGraceMs;
      while (Date.now() < deadline && this.isPidAlive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (this.isPidAlive(pid)) {
        this.recordHostLog(
          'warn',
          `prior session-host pid=${pid} did not exit within ${this.evictGraceMs}ms after SIGTERM; escalating to SIGKILL`,
        );
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // noop
        }
      }
    }
  }

  async start(): Promise<void> {
    if (this.upgradeLease) {
      await this.upgradeLease.start();
      // A stale socket requires separate native ownership recovery; never unlink on assertion.
      if (fs.existsSync(this.endpoint.path)) {
        await this.upgradeLease.close();
        throw new Error('native_host_endpoint_owner_unproved');
      }
    }
    if (!this.upgradeLease && this.endpoint.kind === 'unix') {
      await this.evictPriorEndpointOwners();
      try {
        fs.unlinkSync(this.endpoint.path);
      } catch {
        // noop
      }
    }

    this.ipcServer = net.createServer((socket) => {
      this.sockets.add(socket);
      // PARSER-EOF-FLUSH: hold the parser reference so `end()` is reachable.
      // Passing `createLineParser(...)` inline to `socket.on('data', ...)` threw
      // the handle away, which left the decoder's EOF flush permanently
      // unreachable — bytes held back as an incomplete UTF-8 sequence when the
      // peer disconnected simply vanished with the decoder.
      const parser = createLineParser((envelope) => {
        if (envelope.kind !== 'request') return;
        void this.handleIncomingRequest(socket, envelope);
      });
      const flushParser = () => {
        // The remainder is by definition a PARTIAL line — envelopes are
        // newline-framed, so an unterminated tail is a truncated transmission,
        // not a message. It is logged, never parsed: JSON.parse on a
        // half-written envelope inside a socket-close handler would raise an
        // uncaught exception and turn a peer that died mid-write into a crash
        // of the daemon observing it. That refusal is the original author's
        // design, preserved here.
        let remainder = '';
        try {
          remainder = parser.end();
        } catch {
          return;
        }
        if (!remainder.trim()) return;
        this.recordHostLog(
          'warn',
          `session host discarded ${remainder.length} bytes of an incomplete IPC frame at EOF`,
        );
      };
      const removeSocket = () => {
        this.sockets.delete(socket);
        this.socketSessions.delete(socket);
      };
      // Flush before the socket bookkeeping so the remainder is reported even
      // if a later handler throws. `end()` clears its own buffer, so the
      // close-after-end sequence flushes once and then sees an empty tail.
      socket.on('close', () => {
        flushParser();
        removeSocket();
      });
      socket.on('end', () => {
        flushParser();
        removeSocket();
      });
      socket.on('error', () => {
        flushParser();
        removeSocket();
        try {
          socket.destroy();
        } catch {
          // noop
        }
      });
      socket.on('data', parser);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.ipcServer?.once('listening', () => resolve());
        this.ipcServer?.once('error', reject);
        this.ipcServer?.listen(this.endpoint.path);
      });
    } catch (error) {
      await this.upgradeLease?.close();
      throw error;
    }

    if (this.endpoint.kind === 'unix') {
      if (this.upgradeLease) {
        fs.chmodSync(this.endpoint.path, 0o600);
      }
      try {
        this.endpointInode = fs.lstatSync(this.endpoint.path, { bigint: true }).ino;
      } catch {
        this.endpointInode = null;
      }
    }
    this.recordHostLog('info', `session host endpoint ready: ${this.endpoint.path}`);
    // Do not block readiness on restoring/resuming persisted runtimes.
    // Startup callers only need the IPC endpoint to accept connections.
    setTimeout(() => {
      try {
        if (!this.upgradeLease?.proof().held) this.restorePersistedRuntimes();
      } catch (error: any) {
        this.recordHostLog('error', `session host restore failed: ${error?.message || String(error)}`);
      } finally { this.restorePending = false; }
    }, 0);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
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
    this.socketSessions.clear();
    let endpointReplaced = false;
    if (this.endpoint.kind === 'unix' && this.endpointInode !== null) {
      try {
        const currentIno = fs.lstatSync(this.endpoint.path, { bigint: true }).ino;
        endpointReplaced = currentIno !== this.endpointInode;
      } catch {
        endpointReplaced = true;
      }
    }
    if (this.ipcServer) {
      const server = this.ipcServer;
      this.ipcServer = null;
      if (endpointReplaced) {
        // M3: Another server has already replaced this.endpoint.path with a new inode.
        // Calling net.Server.close() on a unix socket makes libuv unconditionally
        // unlink(pipe_fname) by path string, which would delete the replacement host's
        // socket; renaming the replacement socket away across close() risks stranding it
        // if this process is force-exited mid-stop. Since our socket inode is already
        // unlinked from the filesystem, unref and detach listeners without touching disk.
        server.unref();
        server.removeAllListeners();
      } else {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    if (this.endpoint.kind === 'unix' && !endpointReplaced) {
      try {
        if (this.endpointInode !== null && fs.lstatSync(this.endpoint.path, { bigint: true }).ino === this.endpointInode) {
          fs.unlinkSync(this.endpoint.path);
        }
      } catch {
        // A replacement endpoint belongs to someone else.
      }
    }
    await this.upgradeLease?.close();
    this.removeAllListeners();
  }

  async handleRequest(request: SessionHostRequest, sourceSocket?: net.Socket): Promise<SessionHostResponse> {
    const readOnly = ['get_upgrade_lease', 'acquire_upgrade_lease', 'release_upgrade_lease', 'get_host_diagnostics', 'list_sessions', 'get_snapshot', 'get_terminal_snapshot'].includes(request.type);
    let counted = false;
    try {
      if (!readOnly) {
        this.upgradeLease?.assertMutable();
        this.mutatingRequests++;
        counted = true;
      }
      switch (request.type) {
        case 'get_upgrade_lease':
          if (!this.upgradeLease) throw new Error('native_host_upgrade_binding_unavailable');
          return { success: true, result: this.upgradeLease.proof() };
        case 'acquire_upgrade_lease':
          if (!this.upgradeLease) throw new Error('native_host_upgrade_binding_unavailable');
          return { success: true, result: this.upgradeLease.acquire(request.payload,
            !this.restorePending && this.mutatingRequests === 0 && this.runtimes.size === 0 &&
            this.registry.listSessions().length === 0 && !this.storage.hasRuntimeEntries()) };
        case 'release_upgrade_lease':
          if (!this.upgradeLease) throw new Error('native_host_upgrade_binding_unavailable');
          return { success: true, result: this.upgradeLease.release(request.payload) };
        case 'create_session': {
          const record = this.registry.createSession(request.payload);
          if (sourceSocket) {
            this.subscribeSocketToSession(sourceSocket, record.sessionId);
          }
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
          return { success: true, result: await this.getSnapshotForRequest(request.payload.sessionId, request.payload.sinceSeq) };
        case 'get_terminal_snapshot':
          return { success: true, result: await this.requireRuntime(request.payload.sessionId).getTerminalSnapshot() };
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
          const runtime = this.requireRuntime(request.payload.sessionId);
          const beforeSnapshotSeq = this.registry.getSnapshot(request.payload.sessionId)?.seq ?? 0;
          runtime.write(request.payload.data);
          this.scheduleNoOutputInputDiagnostic({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId,
            input: request.payload.data,
            beforeSnapshotSeq,
          });
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
          this.stopRequests.set(request.payload.sessionId, 'stop');
          this.registry.setLifecycle(request.payload.sessionId, 'stopping');
          this.persistNow(request.payload.sessionId);
          this.requireRuntime(request.payload.sessionId).stop();
          this.emitEvent({ type: 'session_stopped', sessionId: request.payload.sessionId });
          this.recordRuntimeTransition(request.payload.sessionId, 'stop_session', 'stopping', undefined, true);
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case 'delete_session': {
          const record = this.registry.getSession(request.payload.sessionId);
          if (!record) return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          if (this.runtimes.has(record.sessionId)) {
            if (!request.payload.force) {
              return { success: false, error: `Session ${record.sessionId} is still running; pass force to stop and delete it` };
            }
            this.stopRequests.set(record.sessionId, 'delete');
            this.registry.setLifecycle(record.sessionId, 'stopping');
            this.persistNow(record.sessionId);
            this.requireRuntime(record.sessionId).stop();
            await this.waitForRuntimeExit(record.sessionId).catch((error: any) => {
              this.recordRuntimeTransition(record.sessionId, 'delete_session_timeout', 'stopping', undefined, false, error?.message || String(error));
            });
          }
          this.registry.deleteSession(record.sessionId);
          this.storage.remove(record.sessionId);
          this.storage.removeTombstone(record.sessionId);
          this.stopRequests.delete(record.sessionId);
          this.emitEvent({ type: 'session_deleted', sessionId: record.sessionId });
          this.recordRuntimeTransition(record.sessionId, 'delete_session', record.lifecycle, undefined, true);
          return { success: true, result: { sessionId: record.sessionId, deleted: true } };
        }
        case 'resume_session': {
          const existing = this.registry.getSession(request.payload.sessionId);
          if (!existing) {
            return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          }
          if (this.runtimes.has(request.payload.sessionId)) {
            return { success: true, result: existing };
          }
          const resumed = this.startRuntime(existing, buildPayloadFromRecord(existing), 'session_resumed');
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
    } finally {
      if (counted) this.mutatingRequests--;
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
    // Diagnostic-only events are stored locally (recentLogs/Requests/Transitions)
    // and accessible via get_host_diagnostics. Broadcasting them to every socket
    // creates O(N²) traffic when many CLI sessions are active.
    const diagnosticOnly = event.type === 'request_trace'
      || event.type === 'runtime_transition'
      || event.type === 'host_log';
    if (!diagnosticOnly) {
      const targetSessionId = 'sessionId' in event ? (event as { sessionId: string }).sessionId : null;
      for (const socket of [...this.sockets]) {
        // Session-scoped output and lifecycle events are only delivered to sockets
        // subscribed to that session; unsubscribed request/response control sockets
        // must not receive unsolicited lifecycle broadcasts that fill their Recv-Q.
        if (targetSessionId) {
          const sessions = this.socketSessions.get(socket);
          if (!sessions?.has(targetSessionId)) continue;
        }
        this.writeEnvelopeSafely(socket, {
          kind: 'event',
          event,
        });
      }
    }
    this.emit('event', event);
  }

  private subscribeSocketToSession(socket: net.Socket, sessionId: string): void {
    let sessions = this.socketSessions.get(socket);
    if (!sessions) {
      sessions = new Set();
      this.socketSessions.set(socket, sessions);
    }
    sessions.add(sessionId);
  }

  private async handleIncomingRequest(socket: net.Socket, envelope: SessionHostRequestEnvelope): Promise<void> {
    const sessionId = getRequestSessionId(envelope.request);
    if (sessionId && (envelope.request.type === 'create_session' || envelope.request.type === 'attach_session')) {
      this.subscribeSocketToSession(socket, sessionId);
    }
    const startedAt = Date.now();
    const response = await this.handleRequest(envelope.request, socket);
    if (sessionId && envelope.request.type === 'create_session' && response.success) {
      // sessionId may have been auto-generated — subscribe to whatever was actually created
      const createdId = (response.result as { sessionId?: string } | undefined)?.sessionId;
      if (createdId && createdId !== sessionId) this.subscribeSocketToSession(socket, createdId);
    }
    this.recordRequestTrace({
      timestamp: startedAt,
      requestId: envelope.requestId,
      type: envelope.request.type,
      sessionId: getRequestSessionId(envelope.request),
      clientId: getRequestClientId(envelope.request),
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

  /**
   * @param allowTerminal - write even if the record is terminal. Only the exit
   * handler sets this, to stamp the final terminated record for the brief
   * post-mortem window before cleanup.
   */
  private persistNow(sessionId: string, allowTerminal = false): void {
    const record = this.registry.getSession(sessionId);
    if (!record) return;
    // Never write a live file for an already-terminated record. A persist can
    // land after the exit handler stamped the termination — e.g. a PTY onData
    // debounce (schedulePersist) that raced handleRuntimeExit. Writing here
    // recreates the file after storage.remove() deleted it, resurrecting a
    // self-contradictory record (lifecycle:'stopping' + termination stamped
    // 'stopped') that then surfaces as a live attach target for a PID that
    // already exited.
    //
    // Keyed on the record itself rather than a "removed sessions" set on
    // purpose: a restart reuses the same sessionId (restartRuntime stops and
    // relaunches in place), so a sticky per-id block would permanently stop
    // persisting the restarted live session. A terminal record naturally
    // stops being terminal once the session is running again.
    if (!allowTerminal && isTerminalRecord(record)) return;
    const snapshot = this.getSnapshot(sessionId);
    try {
      this.storage.save(record, snapshot);
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? error.code : 'persist_failed';
      console.error(`[session-host] Persist failed for ${sessionId}: ${code}: ${error?.message || error}`);
    }
  }

  private getHostDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): SessionHostDiagnostics {
    return buildHostDiagnostics({
      payload,
      hostStartedAt: this.startedAt,
      endpointPath: this.endpoint.path,
      runtimeCount: this.runtimes.size,
      sessions: this.registry.listSessions(),
      recentLogs: this.recentLogs,
      recentRequests: this.recentRequests,
      recentTransitions: this.recentTransitions,
    });
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
    pushRecent(this.recentLogs, entry);
    this.emitEvent({ type: 'host_log', entry });
    this.emit('log', `[${level}] ${message}`);
  }

  private recordRequestTrace(trace: SessionHostRequestTrace): void {
    pushRecent(this.recentRequests, trace);
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

  private scheduleNoOutputInputDiagnostic(params: {
    sessionId: string;
    clientId: string;
    input: string;
    beforeSnapshotSeq: number;
  }): void {
    if (!params.input || /^\x1b/.test(params.input)) {
      return;
    }

    const hasPotentialEcho = /[^\x00-\x1F\x7F]/.test(params.input);
    if (!hasPotentialEcho && params.input !== '\r' && params.input !== '\n') {
      return;
    }

    setTimeout(() => {
      let afterSnapshotSeq = params.beforeSnapshotSeq;
      try {
        afterSnapshotSeq = this.registry.getSnapshot(params.sessionId)?.seq ?? params.beforeSnapshotSeq;
      } catch {
        return;
      }
      if (afterSnapshotSeq > params.beforeSnapshotSeq) {
        return;
      }

      const now = Date.now();
      const lastWarnAt = this.lastNoOutputInputWarnAt.get(params.sessionId) || 0;
      if (now - lastWarnAt < 10_000) {
        return;
      }
      this.lastNoOutputInputWarnAt.set(params.sessionId, now);
      const record = this.registry.getSession(params.sessionId);
      this.recordHostLog(
        'warn',
        'send_input produced no terminal output after PTY write; runtime may be ignoring stdin or stuck in a hidden input reader',
        params.sessionId,
        {
          clientId: params.clientId,
          inputLength: params.input.length,
          beforeSnapshotSeq: params.beforeSnapshotSeq,
          afterSnapshotSeq,
          lifecycle: record?.lifecycle,
          osPid: record?.osPid,
          providerType: record?.providerType,
        },
      );
      this.recordRuntimeTransition(
        params.sessionId,
        'send_input_no_output_after_write',
        record?.lifecycle,
        `clientId=${params.clientId} inputLength=${params.input.length} seq=${params.beforeSnapshotSeq}`,
        false,
        'no terminal output after PTY write',
      );
    }, 250);
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
    pushRecent(this.recentTransitions, transition);
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

  // Synchronous, best-effort variant for background/periodic persistence
  // (persistNow, called from many sync contexts). Uses getSnapshotTextSync()
  // rather than waiting for in-flight PTY writes to flush — see that method's
  // doc. Interactive requests must use getSnapshotForRequest() instead.
  private getSnapshot(sessionId: string, sinceSeq?: number) {
    const snapshot = this.registry.getSnapshot(sessionId, sinceSeq);
    const record = this.registry.getSession(sessionId);
    const runtimeText = typeof sinceSeq === 'number'
      ? ''
      : (this.runtimes.get(sessionId)?.getSnapshotTextSync?.() || '');
    return mergeRuntimeSnapshot(snapshot, record, { sinceSeq, runtimeText });
  }

  // Flush-aware variant for the interactive `get_snapshot` IPC request (the
  // dashboard's runtime_snapshot seed). Awaits any PTY chunk still queued in
  // the xterm mirror's WriteBuffer before reading, so the response reflects
  // everything written so far rather than racing an in-flight parse. See
  // PtySessionRuntime.flushPendingWrites() for why that race existed.
  private async getSnapshotForRequest(sessionId: string, sinceSeq?: number) {
    const snapshot = this.registry.getSnapshot(sessionId, sinceSeq);
    const record = this.registry.getSession(sessionId);
    const runtimeText = typeof sinceSeq === 'number'
      ? ''
      : ((await this.runtimes.get(sessionId)?.getSnapshotText?.()) || '');
    return mergeRuntimeSnapshot(snapshot, record, { sinceSeq, runtimeText });
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
      this.stopRequests.set(sessionId, 'restart');
      this.registry.setLifecycle(sessionId, 'stopping');
      this.persistNow(sessionId);
      this.recordRuntimeTransition(sessionId, 'restart_requested', 'stopping', undefined, true);
      this.requireRuntime(sessionId).stop();
      await this.waitForRuntimeExit(sessionId);
    }

    const latest = this.registry.getSession(sessionId) || existing;
    const restarted = this.startRuntime(latest, buildPayloadFromRecord(latest), 'session_resumed');
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

    const { duplicateGroups, keptSessionIds, duplicateRecords } = planDuplicatePrune(
      this.registry.listSessions(),
      { providerFilter, workspaceFilter },
    );

    const prunedSessionIds: string[] = [];
    if (!dryRun) {
      for (const duplicate of duplicateRecords) {
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
      const { recoveredRecord, wasLiveRuntime, hadRecoveryInterest } = buildRecoveredRecord(persisted);
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
      this.stopRequests.set(record.sessionId, 'prune');
      this.registry.setLifecycle(record.sessionId, 'stopping');
      this.persistNow(record.sessionId);
      this.requireRuntime(record.sessionId).stop();
      await this.waitForRuntimeExit(record.sessionId).catch((error: any) => {
        this.recordRuntimeTransition(record.sessionId, 'prune_duplicate_timeout', 'stopping', undefined, false, error?.message || String(error));
      });
    }

    const pendingPersistTimer = this.persistTimers.get(record.sessionId);
    if (pendingPersistTimer) {
      clearTimeout(pendingPersistTimer);
      this.persistTimers.delete(record.sessionId);
    }
    this.registry.deleteSession(record.sessionId);
    this.storage.remove(record.sessionId);
    this.storage.removeTombstone(record.sessionId);
    this.stopRequests.delete(record.sessionId);
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
      onExit: (exitCode, signal) => this.handleRuntimeExit(record, exitCode, signal),
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

  /**
   * Handle a PTY termination: classify the (exitCode, signal) pair, stamp the
   * record + tombstone, emit exactly one structured diagnostic, and schedule
   * cleanup of the live persistence file (the tombstone is retained).
   */
  private handleRuntimeExit(record: SessionHostRecord, exitCode: number | null, signal: number | null): SessionTermination {
    // Capture pre-termination context BEFORE mutating the record.
    const priorRecord = this.registry.getSession(record.sessionId);
    const termination = classifyTermination({
      exitCode,
      signal,
      osPid: priorRecord?.osPid,
      previousLifecycle: priorRecord?.lifecycle,
      lastOutputAt: priorRecord?.lastActivityAt,
      requestedStop: this.stopRequests.get(record.sessionId),
      terminatedAt: Date.now(),
    });
    this.stopRequests.delete(record.sessionId);

    this.registry.markStopped(record.sessionId, termination.lifecycle, termination);
    this.runtimes.delete(record.sessionId);
    this.resolveExitWaiters(record.sessionId, exitCode);
    const pendingPersistTimer = this.persistTimers.get(record.sessionId);
    if (pendingPersistTimer) {
      clearTimeout(pendingPersistTimer);
      this.persistTimers.delete(record.sessionId);
    }
    this.persistNow(record.sessionId, true);
    // Persist a tombstone that survives live-record cleanup so the termination
    // stays inspectable after the 5s removal below.
    this.storage.saveTombstone(record.sessionId, termination);
    this.emitEvent({ type: 'session_exit', sessionId: record.sessionId, exitCode, signal, termination });
    const summary = `reason=${termination.reason} exitCode=${termination.exitCode === null ? 'unknown' : termination.exitCode} signal=${termination.signal ?? 'none'}`;
    // Exactly one structured, secret-free termination diagnostic.
    this.recordHostLog(
      termination.lifecycle === 'stopped' ? 'info' : 'warn',
      `session terminated: ${summary}`,
      record.sessionId,
      {
        runtimeKey: record.runtimeKey,
        providerType: record.providerType,
        osPid: termination.osPid,
        exitCode: termination.exitCode,
        signal: termination.signal,
        reason: termination.reason,
        previousLifecycle: termination.previousLifecycle,
        lifecycle: termination.lifecycle,
        lastOutputAt: termination.lastOutputAt,
        requestedStop: termination.requestedStop,
      },
    );
    this.recordRuntimeTransition(
      record.sessionId,
      'session_exit',
      termination.lifecycle,
      summary,
      termination.lifecycle === 'stopped',
      termination.lifecycle === 'stopped' ? undefined : summary,
    );
    // Clean up the live persistence file after a brief delay (allow post-mortem
    // reads). The tombstone written above is retained. The registry entry is
    // dropped in the same tick as the file so the record can no longer be
    // served — and so no persist can find it and recreate the file (see
    // resurrection RCA: a persist landing after storage.remove() but finding
    // the record still registered recreates a stale live file).
    setTimeout(() => {
      // A restart reuses the sessionId: restartRuntime() stops the runtime,
      // which schedules this cleanup, then relaunches in place. If the session
      // is live again by the time this fires, it belongs to the new runtime —
      // deleting it would unregister and unpersist a running session.
      const current = this.registry.getSession(record.sessionId);
      if (current && !isTerminalRecord(current)) return;
      this.registry.deleteSession(record.sessionId);
      this.storage.remove(record.sessionId);
    }, 5_000).unref?.();
    return termination;
  }
}
