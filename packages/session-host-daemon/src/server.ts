import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'node:path';
import { assertOrphanUnixSocket, lsofSocketOwnerPids } from './socket-probe.js';
import {
  SessionHostRegistry,
  classifyTermination,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
  validateSessionHostEndpoint,
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
import { HostUpgradeLease } from './upgrade-lease.js';
import { SessionHostStorage } from './storage.js';
import { acquireHostInstanceLock, type HostInstanceLock } from './host-instance-lock.js';
import { OperatorRecoveryFence } from './operator-recovery-fence.js';
import { resolveInstanceConfigDir } from '@adhdev/session-host-core';
import { OperatorRecoveryControl } from './operator-recovery-control.js';
import { resolveHostBootId } from './stop-session-if-expected.js';
import { handleDeleteSessionIfExpected } from './delete-session-if-expected.js';
import { handleStopSessionIfExpected } from './handle-stop-session-if-expected.js';

export {
  sessionHostInstanceArg,
  isManagedSessionHostCommandLine,
  readVerifiedReplacementProvenance,
} from './prior-host-identity.js';
export type { SessionHostReplacementProvenance } from './prior-host-identity.js';
import {
  buildHostDiagnostics,
  resolveHostEntryPath,
  pushRecent,
} from './session-diagnostics.js';
import {
  buildPayloadFromRecord,
  RuntimeExitWaiters,
  restorePersistedRuntimeRecords,
  planDuplicatePrune,
} from './session-lifecycle.js';
import {
  getRequestClientId,
  getRequestSessionId,
  mergeRuntimeSnapshot,
} from './session-protocol.js';

export const DEFAULT_EVICT_SIGKILL_GRACE_MS = 4_000;

import type { SessionHostServerOptions } from './server-options.js';
export type { SessionHostServerOptions } from './server-options.js';

export class SessionHostServer extends EventEmitter {
  readonly endpoint: SessionHostEndpoint;
  readonly registry = new SessionHostRegistry();
  private runtimes = new Map<string, PtySessionRuntime>();
  private readonly storage: SessionHostStorage;
  private readonly recoveryFence: OperatorRecoveryFence;
  private readonly upgradeLease: HostUpgradeLease | null;
  private readonly instanceConfigDir: string | null;
  private readonly pidFilePath: string | null;
  private readonly instanceLockPath: string | null;
  private readonly holdInstanceLockUntilExit: boolean;
  private instanceLock: HostInstanceLock | null = null;
  private readonly isPidAliveOverride?: (pid: number) => boolean;
  private readonly getOwnerBirth?: (pid: number) => string | null;
  private readonly getSocketOwnerPids?: (endpointPath: string) => number[] | null;
  private readonly isCancelled?: () => boolean;
  private startupFence: (() => void) | null = null;
  private readonly hasReplacementContext: boolean;
  private restorePending = true;
  private fullRestoreState: 'pending' | 'ready' | 'failed' = 'pending';
  private partialRestoreCount = 0;
  private readonly workerDaemonId: string;
  private readonly recoveryControl: OperatorRecoveryControl;
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
  private exitWaiters = new RuntimeExitWaiters();
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
    this.instanceConfigDir = options.instanceConfigDir || null;
    this.workerDaemonId = options.workerDaemonId || '';
    this.pidFilePath = options.pidFilePath || null;
    this.instanceLockPath = options.instanceLockPath || (this.pidFilePath ? `${this.pidFilePath}.lock` : null);
    this.holdInstanceLockUntilExit = options.holdInstanceLockUntilExit === true;
    this.isPidAliveOverride = options.isPidAlive;
    this.hasReplacementContext = Object.prototype.hasOwnProperty.call(options, 'replacementProvenance');
    this.getOwnerBirth = options.getOwnerBirth;
    this.getSocketOwnerPids = options.getSocketOwnerPids;
    this.isCancelled = options.isCancelled;
    this.storage = new SessionHostStorage({
      appName: options.appName || 'adhdev',
      rootDir: options.storageRootDir,
    });
    this.recoveryFence = new OperatorRecoveryFence(options.storageRootDir ||
      path.join(resolveInstanceConfigDir(process.env), 'session-host', options.appName || 'adhdev'));
    this.recoveryControl = new OperatorRecoveryControl(() => ({
      upgradeLease: this.upgradeLease, instanceConfigDir: this.instanceConfigDir, endpoint: this.endpoint,
      workerDaemonId: this.workerDaemonId, restorePending: this.restorePending, fullRestoreState: this.fullRestoreState,
      partialRestoreCount: this.partialRestoreCount, mutatingRequests: this.mutatingRequests, registry: this.registry,
      runtimes: this.runtimes, storage: this.storage, recoveryFence: this.recoveryFence,
    }), options.recoveryOwnerPublicKey);
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (this.isPidAliveOverride) return this.isPidAliveOverride(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      // Only ESRCH positively proves death; other probe failures stay contained.
      return error?.code !== 'ESRCH';
    }
  }

  private readProcessBirth(pid: number): string | null {
    if (this.getOwnerBirth) return this.getOwnerBirth(pid);
    if (process.platform === 'win32') return null;
    try {
      return String(
        execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
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

  private readSocketOwnerPids(): number[] | null {
    if (this.getSocketOwnerPids) return this.getSocketOwnerPids(this.endpoint.path);
    return lsofSocketOwnerPids(this.endpoint.path);
  }

  private assertNoAutomaticReplacementContext(): void {
    // Even a callback returning undefined is an unsupported replacement context.
    // Never consume or delete failure evidence to make ordinary startup pass.
    if (this.isCancelled?.()) throw new Error('session_host_start_cancelled');
    if (this.hasReplacementContext) throw new Error('session_host_live_owner_replacement_unauthorized');
    if (this.instanceConfigDir && fs.existsSync(this.instanceConfigDir)) {
      if (fs.readdirSync(this.instanceConfigDir).some(name => name.endsWith('-session-host-replacement.json'))) {
        throw new Error('session_host_live_owner_replacement_unauthorized');
      }
    }
    if (this.isCancelled?.()) throw new Error('session_host_start_cancelled');
  }

  private async evictPriorEndpointOwners(): Promise<void> {
    this.assertNoAutomaticReplacementContext();
    if (this.endpoint.kind !== 'unix') return;
    const identity = (file: string): string => {
      try {
        const stat = fs.lstatSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.mode}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
      }
    };
    const configIdentity = this.instanceConfigDir ? identity(this.instanceConfigDir) : null;
    const endpointParent = fs.realpathSync(path.dirname(this.endpoint.path));
    const initialEndpoint = identity(this.endpoint.path);
    const readPid = (): string => {
      if (!this.pidFilePath) return 'missing';
      try {
        const raw = fs.readFileSync(this.pidFilePath, 'utf8').trim();
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
          return 'corrupt'; // identifies no owner; handled like 'missing'
        }
        return raw;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
      }
    };
    const initialPid = readPid();
    const hasPid = (value: string): boolean => value !== 'missing' && value !== 'corrupt';
    const initialBirth = hasPid(initialPid) ? this.readProcessBirth(Number(initialPid)) : null;
    const assertGeneration = (expectedEndpoint: string): void => {
      this.assertNoAutomaticReplacementContext();
      const currentPid = readPid();
      const [birth, alive] = hasPid(initialPid)
        ? [this.readProcessBirth(Number(initialPid)), this.isPidAlive(Number(initialPid))] : [null, false];
      if (currentPid !== initialPid || birth !== initialBirth || alive
          || (this.instanceConfigDir && identity(this.instanceConfigDir) !== configIdentity)
          || fs.realpathSync(path.dirname(this.endpoint.path)) !== endpointParent
          || identity(this.endpoint.path) !== expectedEndpoint || readPid() !== initialPid) {
        throw new Error('session_host_endpoint_changed_during_recovery');
      }
      this.assertNoAutomaticReplacementContext();
    };
    if (hasPid(initialPid) && this.isPidAlive(Number(initialPid))) {
      throw new Error('session_host_live_owner_replacement_unauthorized');
    }
    if (initialEndpoint !== 'missing') {
      if (this.upgradeLease) throw new Error('native_host_endpoint_owner_unproved');
      // No usable PID + existing endpoint is UNKNOWN unless it is a real socket node AND
      // connect yields ECONNREFUSED; a connect that succeeds or hangs means a live/wedged host.
      if (!hasPid(initialPid)) {
        await assertOrphanUnixSocket(this.endpoint.path);
        assertGeneration(initialEndpoint);
      }
      for (let check = 0; check < 2; check++) {
        const owners = this.readSocketOwnerPids();
        if (owners === null) throw new Error('session_host_prior_owner_socket_unverified');
        if (owners.length !== 0) throw new Error('session_host_endpoint_changed_during_recovery');
        assertGeneration(initialEndpoint);
      }
      fs.unlinkSync(this.endpoint.path);
    }
    // start() awaits this method; recheck the same generation after that seam
    // and immediately before helper/createServer/listen effects.
    this.startupFence = () => assertGeneration('missing');
    this.startupFence();
  }

  async start(): Promise<void> {
    validateSessionHostEndpoint(this.endpoint);
    this.assertNoAutomaticReplacementContext();
    // Singleton gate for EVERY start path, before any pidfile/endpoint effect.
    if (this.instanceLockPath && !this.instanceLock) {
      this.instanceLock = acquireHostInstanceLock({
        lockPath: this.instanceLockPath,
        isPidAlive: this.isPidAliveOverride,
      });
    }
    try { await this.startAfterLock(); } catch (error) {
      this.instanceLock?.release();
      this.instanceLock = null;
      throw error;
    }
  }

  private async startAfterLock(): Promise<void> {
    if (this.upgradeLease && fs.existsSync(this.endpoint.path)) {
      throw new Error('native_host_endpoint_owner_unproved');
    }
    await this.evictPriorEndpointOwners();
    this.startupFence?.();
    if (this.upgradeLease) {
      await this.upgradeLease.start();
      try { this.startupFence?.(); }
      catch (error) { await this.upgradeLease.close(); throw error; }
    }
    this.startupFence?.();

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
        this.startupFence?.();
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
        if (!this.upgradeLease?.proof().held) {
          this.restorePersistedRuntimes();
          this.fullRestoreState = this.storage.recoveryInventory().complete ? 'ready' : 'failed';
        }
      } catch (error: any) {
        this.fullRestoreState = 'failed';
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
    if (!this.holdInstanceLockUntilExit) { this.instanceLock?.release(); this.instanceLock = null; }
    this.removeAllListeners();
  }

  async handleRequest(request: SessionHostRequest, sourceSocket?: net.Socket): Promise<SessionHostResponse> {
    const readOnly = ['prepare_operator_recovery_fence_v1', 'attest_operator_recovery_v1', 'get_operator_recovery_coverage_v1', 'get_upgrade_lease', 'acquire_upgrade_lease', 'release_upgrade_lease', 'get_host_diagnostics', 'get_session_census', 'get_session', 'list_sessions', 'get_snapshot', 'get_terminal_snapshot'].includes(request.type);
    let counted = false;
    try {
      if (!readOnly) {
        this.upgradeLease?.assertMutable();
        this.mutatingRequests++;
        counted = true;
      }
      switch (request.type) {
        case 'prepare_operator_recovery_fence_v1':
        case 'install_operator_recovery_fence_v1':
        case 'attest_operator_recovery_v1':
        case 'get_operator_recovery_coverage_v1':
          return this.recoveryControl.handle(request);
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
          this.recoveryFence.assertLaunchAllowed(request.payload);
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
          return { success: true, result: this.registry.listSessionSummaries(request.payload?.activeOnly === true) };
        case 'get_session_census':
          return { success: true, result: {
            hostStartedAt: this.startedAt,
            endpoint: this.endpoint.path,
            hostEntryPath: resolveHostEntryPath(),
            ...this.registry.getSessionCensus(request.payload.sessionIds),
          } };
        case 'get_session': {
          const record = this.registry.getSession(request.payload.sessionId);
          return record ? { success: true, result: record } : { success: false, error: 'session_absent' };
        }
        case 'attach_session':
        case 'attach_session_if_incarnation': {
          const record = request.type === 'attach_session_if_incarnation'
            ? this.registry.attachClientIfIncarnation(request.payload)
            : this.registry.attachClient(request.payload);
          // Keep guarded comparison, registry grant and socket subscription in
          // the same synchronous turn, before handleIncomingRequest awaits us.
          if (request.type === 'attach_session_if_incarnation' && sourceSocket) this.subscribeSocketToSession(sourceSocket, record.sessionId);
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
          this.recoveryFence.assertLaunchAllowed(request.payload as CreateSessionPayload);
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
          this.announceInput(request.payload.sessionId, request.payload.clientId);
          runtime.write(request.payload.data);
          this.scheduleNoOutputInputDiagnostic({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId,
            input: request.payload.data,
            beforeSnapshotSeq,
          });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case 'get_input_state':
          return { success: true, result: this.registry.getInputState(request.payload.sessionId) };
        case 'send_input_if_seq': {
          // SUBMIT-UNCONFIRMED-RECLAIM (review R8-1): the check and the write are
          // one step here, so no other input can land between them. No force:
          // a caller that is not allowed to write as things stand is refused.
          const p = request.payload;
          const client = this.getAttachedClient(p.sessionId, p.clientId);
          if (client?.readOnly) return { success: false, error: `Client ${p.clientId} is read-only` };
          const session = this.registry.getSession(p.sessionId);
          if (session?.writeOwner && session.writeOwner.clientId !== p.clientId) {
            return { success: false, error: `Write owned by ${session.writeOwner.clientId}` };
          }
          const runtime = this.requireRuntime(p.sessionId);
          const now = this.registry.getInputState(p.sessionId);
          if (now.inputSeq !== p.expectedInputSeq || now.inputEpoch !== p.expectedInputEpoch) {
            return { success: false, error: 'input_seq_mismatch' };
          }
          this.announceInput(p.sessionId, p.clientId);
          runtime.write(p.data);
          return { success: true, result: this.registry.getSession(p.sessionId) };
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
        case 'stop_session_if_expected':
          return handleStopSessionIfExpected(this as any, request.payload);
        case 'stop_mesh_writer': {
          const p = request.payload, record = this.registry.getSession(p.sessionId);
          const active = record?.meta.meshActiveAssignment as Record<string, unknown> | undefined;
          const launch = record?.meta.launchRecord as Record<string, unknown> | undefined;
          const keys = ['meshId','nodeId','taskId','attemptId','generation','dispatchNonce','ownerDaemonId'] as const;
          if (!record || !this.runtimes.has(p.sessionId) || record.termination || !['running','stopping'].includes(record.lifecycle)
            || record.category !== 'cli' || record.providerType !== p.providerType || record.runtimeKey !== p.runtimeKey
            || record.startedAt !== p.startedAt || record.osPid !== p.osPid || !record.writeOwner
            || record.writeOwner.clientId !== p.clientId || record.writeOwner.ownerType !== 'agent'
            || record.meta.assistant || record.meta.meshCoordinatorFor || launch?.launchedBy === 'assistant' || launch?.roleLaunch
            || !Number.isSafeInteger(p.osPid) || p.osPid <= 0 || !Number.isSafeInteger(p.startedAt) || p.startedAt <= 0
            || !active || !p.assignment || keys.some(key => {
              const v = p.assignment[key];
              return (key === 'generation' || key === 'dispatchNonce' ? !Number.isSafeInteger(v) || Number(v) < 0 : typeof v !== 'string' || !v)
                || active[key] !== v;
            })) {
            return { success: false, error: 'mesh_writer_identity_or_ownership_changed' };
          }
          this.stopRequests.set(p.sessionId, 'stop');
          this.registry.setLifecycle(p.sessionId, 'stopping');
          this.persistNow(p.sessionId);
          this.requireRuntime(p.sessionId).stop('SIGKILL');
          this.recordRuntimeTransition(p.sessionId, 'stop_mesh_writer', 'stopping', undefined, true);
          // A requested stop is not native quiescence. The owner retains its
          // claim until a separate exact process-tree observation settles it.
          return { success: true, result: { requested: true } };
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
        case 'delete_session_if_expected':
          return handleDeleteSessionIfExpected(this as any, request.payload);
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

  collectRecoveryCensus(nonce: string, fenceDigest: string) {
    return this.recoveryControl.collectRecoveryCensus(nonce, fenceDigest);
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

  /** Count and announce one accepted input BEFORE it reaches the PTY, so a
   *  subscriber sees who wrote it before any output it causes. */
  private announceInput(sessionId: string, clientId: string): void {
    const seq = this.registry.recordInput(sessionId);
    const { inputEpoch } = this.registry.getInputState(sessionId);
    this.emitEvent({ type: 'session_input', sessionId, seq, epoch: inputEpoch, clientId });
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

  /** Single SoT for cleanup inventory + stop_session_if_expected host boot CAS. */
  private currentHostBootId(): string | null {
    return resolveHostBootId({ upgradeBootId: this.upgradeLease?.bootId, hostStartedAt: this.startedAt });
  }

  private getHostDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): SessionHostDiagnostics {
    return buildHostDiagnostics({
      payload,
      hostStartedAt: this.startedAt,
      hostBootId: this.currentHostBootId(),
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
    return this.exitWaiters.wait(sessionId, timeoutMs, this.runtimes.has(sessionId), this.registry.getSession(sessionId)?.lifecycle);
  }
  private resolveExitWaiters(sessionId: string, exitCode: number | null): void {
    this.exitWaiters.resolve(sessionId, exitCode);
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

    const leaveLaunch = this.recoveryFence.enterLaunch(buildPayloadFromRecord(existing));
    try {
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
    } finally { leaveLaunch(); }
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
    restorePersistedRuntimeRecords(this.storage, this.registry, message => this.recordHostLog('warn', message));
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
    // The shared synchronous spawn boundary also covers delayed restart/resume
    // after an await. Never infer closure from a prior failed ensureReady.
    const leaveLaunch = this.recoveryFence.enterLaunch(payload);
    try {
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
    } finally { leaveLaunch(); }
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
