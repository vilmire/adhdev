/**
 * DaemonCore — Core daemon orchestrator interface
 *
 * Both daemon-standalone and daemon-cloud use this interface via daemon-core.
 * Actual implementation extracted from launcher and placed in this package.
 */

import type { StatusResponse, CommandResult, DaemonEvent } from './types.js';
import type { ManagedIdeEntry, ManagedCliEntry, ManagedAcpEntry } from './shared-types.js';

export interface DaemonCoreOptions {
 /** Data directory for config, logs */
  dataDir?: string;
 /** Custom provider directories */
  providerDirs?: string[];
 /** Enable/disable specific detectors */
  enableIdeDetection?: boolean;
  enableCliDetection?: boolean;
  enableAcpDetection?: boolean;
 /** Status report interval (ms) */
  statusInterval?: number;
}

export interface IDaemonCore {
 /** Initialize and start the daemon core */
  start(): Promise<void>;

 /** Gracefully stop the daemon */
  stop(): Promise<void>;

 /** Get current daemon status snapshot */
  getStatus(): StatusResponse;

 /** Subscribe to status changes. Returns unsubscribe function. */
  onStatusChange(callback: (status: StatusResponse) => void): () => void;

 /** Subscribe to all daemon events. Returns unsubscribe function. */
  onEvent(callback: (event: DaemonEvent) => void): () => void;

 /** Execute a command (send_chat, new_session, etc.) */
  executeCommand(type: string, payload: any, target?: string): Promise<CommandResult>;

 /** Get currently detected/managed IDEs */
  getManagedIdes(): ManagedIdeEntry[];

 /** Get currently detected/managed CLIs */
  getManagedClis(): ManagedCliEntry[];

 /** Get currently detected/managed ACP agents */
  getManagedAcps(): ManagedAcpEntry[];
}
