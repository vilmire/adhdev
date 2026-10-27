import { assertMaintenanceAdmission, withMaintenanceEffect } from '../maintenance/cooperative-gate.js';
import * as os from 'os';
import type { SessionTermination } from '@adhdev/session-host-core';
import { niceLaunch, spawnCliChild } from '@adhdev/session-host-core';
import { LOG } from '../logging/logger.js';
import { ensureNodePtySpawnHelperPermissions } from './spawn-env.js';
import { resolveWin32Executable } from './resolve-executable.js';

let cachedPty: any | null | undefined;

// Test-only seam: lets a test simulate a native-load failure/success without
// touching the real node-pty addon. Defaults to the real require().
let requireNodePty: () => any = () => require('node-pty');

function isModuleNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND';
}

function loadNodePty(): any {
  if (cachedPty !== undefined) return cachedPty;
  try {
    // Keep node-pty out of processes that delegate PTY ownership elsewhere
    // (for example via session-host on Windows), so native PTY crashes do not
    // take down the daemon just by importing this module.
    cachedPty = requireNodePty();
    ensureNodePtySpawnHelperPermissions();
  } catch (error) {
    // Only memoize a genuine "package not installed" — that state cannot
    // change without a reinstall/restart, so it's safe (and cheap) to cache.
    // Any other failure (native ABI mismatch, transient load error) must NOT
    // be cached: node-pty may in fact be installed, and permanently caching
    // that failure would wedge PTY spawning for the rest of the daemon's
    // life even though a later require() could succeed.
    if (isModuleNotFoundError(error)) {
      cachedPty = null;
    }
  }
  return cachedPty ?? null;
}

/** Test-only: reset the memoized node-pty handle and/or stub its loader. */
export function __setNodePtyLoaderForTests(loader: (() => any) | null): void {
  cachedPty = undefined;
  requireNodePty = loader ?? (() => require('node-pty'));
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** Only explicit launch overrides may be persisted for a later spawn. */
  envOverrides?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyRuntimeWriteOwner {
  clientId: string;
  ownerType: 'agent' | 'user';
}

export interface PtyRuntimeClientInfo {
  clientId: string;
  type: 'daemon' | 'web' | 'local-terminal';
  readOnly: boolean;
}

export interface PtyRuntimeMetadata {
  osPid?: number;
  startedAt?: number;
  runtimeId: string;
  runtimeKey?: string;
  displayName?: string;
  workspaceLabel?: string;
  lifecycle?: string | null;
  surfaceKind?: 'live_runtime' | 'recovery_snapshot' | 'inactive_record';
  writeOwner?: PtyRuntimeWriteOwner | null;
  attachedClients?: PtyRuntimeClientInfo[];
  restoredFromStorage?: boolean;
  recoveryState?: string | null;
  recoveryError?: string | null;
}
export interface PtyRuntimeControl {
  verifyMeta(expected: Record<string, unknown>): Promise<boolean>;
  stopMeshWriter(target: import('@adhdev/session-host-core').MeshWriterStopTarget): Promise<boolean>;
}

/**
 * Info delivered to an `onExit` subscriber.
 *
 * `termination` is the session host's authoritative classification of the exit
 * (TOMBSTONE-LEDGER-BRIDGE). It is OPTIONAL because only the session-host
 * transport can produce it — a raw node-pty child has no tombstone — so every
 * consumer must tolerate its absence and fall back to (exitCode, signal).
 */
export interface PtyRuntimeExitInfo {
  exitCode: number | null;
  signal?: number | null;
  termination?: SessionTermination;
}

export interface PtyRuntimeTransport {
  readonly pid: number;
  readonly ready: Promise<void>;
  write(data: string): boolean | void | Promise<boolean | void>;
  resize(cols: number, rows: number): void;
  kill(): void;
  clearBuffer?(): void;
  detach?(): void;
  updateMeta?(meta: Record<string, unknown>, replace?: boolean): void;
  getMetadata?(): PtyRuntimeMetadata | null;
  verifyMeta?(expected: Record<string, unknown>): Promise<boolean>;
  stopMeshWriter?(target: import('@adhdev/session-host-core').MeshWriterStopTarget): Promise<boolean>;
  /**
   * SUBMIT-UNCONFIRMED-RECLAIM: whether a client other than this daemon could
   * be typing into the runtime right now — a writable local terminal or web
   * client attached to a hosted session. Null = not known (fail closed).
   * Absent on a transport only this process can write to (a raw node-pty).
   */
  otherWritableClients?(): boolean | null;
  /**
   * SUBMIT-UNCONFIRMED-RECLAIM: the session host's own account of input into
   * the runtime since this transport attached — counts of inputs by other
   * clients, write-ownership moves to other clients, and sequence gaps (lost
   * or replayed announcements), plus whether every input the host has counted
   * has been announced to us yet. Null when the host does not announce inputs
   * (an older host): provenance is then unknown. Absent on a raw node-pty —
   * which therefore never proves input provenance either.
   */
  inputProvenance?(): { foreign: number; ownerAway: number; gaps: number; complete: boolean } | null;
  /**
   * SUBMIT-UNCONFIRMED-RECLAIM: write only if no input reached the runtime
   * since this transport's last accounted point — checked and written in one
   * step by the session host. Resolves false on refusal or unknown provenance.
   * Absent on a raw node-pty (no host to make it atomic).
   */
  writeIfInputUnchanged?(data: string): Promise<boolean>;
  onData(callback: (data: string) => void): void;
  onExit(callback: (info: PtyRuntimeExitInfo) => void): void;
}

export interface PtyTransportFactory {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport;
  /**
   * True when spawn() re-attaches to a runtime that was already running before
   * this daemon started (a hosted session restored after a daemon restart),
   * false/absent for a fresh process. The CLI behind an attach has long since
   * booted, so boot-phase gating (SpecCliAdapter's "hold at starting until the
   * first ready prompt") must not hide a turn that is already in flight.
   */
  readonly attachesExistingRuntime?: boolean;
}

class NodePtyRuntimeTransport implements PtyRuntimeTransport {
  readonly ready = Promise.resolve();

  constructor(private readonly handle: any) {}

  get pid(): number {
    return this.handle.pid;
  }

  write(data: string): void {
    assertMaintenanceAdmission();
    withMaintenanceEffect(() => this.handle.write(data));
  }

  resize(cols: number, rows: number): void {
    withMaintenanceEffect(() => this.handle.resize(cols, rows));
  }

  kill(): void {
    withMaintenanceEffect(() => this.handle.kill());
  }

  getMetadata(): PtyRuntimeMetadata | null {
    return null;
  }

  onData(callback: (data: string) => void): void {
    this.handle.onData(callback);
  }

  onExit(callback: (info: { exitCode: number }) => void): void {
    this.handle.onExit(callback);
  }
}

export class NodePtyTransportFactory implements PtyTransportFactory {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport {
    const pty = loadNodePty();
    if (!pty) throw new Error('node-pty is not installed');
    // Validate cwd — an invalid directory causes a native crash on Windows
    // (node-pty error code 267: ERROR_DIRECTORY) that bypasses JS try/catch
    let cwd = options.cwd;
    if (cwd) {
      try {
        const fs = require('fs');
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) cwd = os.homedir();
      } catch {
        cwd = os.homedir();
      }
    }
    assertMaintenanceAdmission();
    // Start the agent already lowered (niceLaunch) so no early fork escapes the policy.
    const launch = niceLaunch(resolveWin32Executable(command), args, options.env);
    const handle = withMaintenanceEffect(() => spawnCliChild(() => pty.spawn(launch.command, launch.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd,
      env: options.env,
    }), options.env, (message) => LOG.info('CliPriority', message), { preApplied: launch.preApplied }));
    return new NodePtyRuntimeTransport(handle);
  }
}
