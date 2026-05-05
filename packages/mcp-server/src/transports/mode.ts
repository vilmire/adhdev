import type { LocalTransport } from './local.js';
import type { CloudTransport } from './cloud.js';
import type { IpcTransport } from './ipc.js';

export type CommandTransport = LocalTransport | IpcTransport;
export type McpTransport = CommandTransport | CloudTransport;

/**
 * Local/IPC and cloud transports are intentionally detected by an operation that
 * is unique to command-routed daemon modes. CloudTransport also exposes methods
 * like getStatus(targetId), so checking for getStatus incorrectly routes cloud
 * tools through command mode.
 */
export function isLocalTransport(
  transport: McpTransport,
): transport is CommandTransport {
  return typeof (transport as { command?: unknown }).command === 'function';
}
