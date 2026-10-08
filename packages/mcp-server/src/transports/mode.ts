import type { LocalTransport } from './local.js';
import type { IpcTransport } from './ipc.js';

export type CommandTransport = LocalTransport | IpcTransport;

/**
 * A transport that can run a command on ANOTHER daemon of the mesh: the local
 * daemon relays it (`mesh_relay_command`) over its daemon⇄daemon channel —
 * WebRTC for the cloud daemon (IPC), the direct-WS mesh link for a standalone
 * daemon (HTTP). Both transports implement it; the mesh tools ask for the
 * capability instead of a concrete class so a standalone coordinator reaches
 * remote nodes exactly like a cloud one (it used to run every remote-node verb
 * on its own host because the gate was `instanceof IpcTransport`).
 */
export interface MeshRelayTransport {
  readonly supportsMeshRelay: true;
  command(type: string, args?: Record<string, unknown>): Promise<any>;
  meshCommand(targetDaemonId: string, command: string, args?: Record<string, unknown>): Promise<any>;
}

/** Whether `transport` can relay a command to another daemon (see {@link MeshRelayTransport}). */
export function supportsMeshRelay(transport: unknown): transport is MeshRelayTransport {
  if (!transport || typeof transport !== 'object') return false;
  const candidate = transport as { supportsMeshRelay?: unknown; meshCommand?: unknown };
  return candidate.supportsMeshRelay === true && typeof candidate.meshCommand === 'function';
}
