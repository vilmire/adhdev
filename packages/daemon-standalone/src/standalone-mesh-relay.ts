/**
 * Standalone `mesh_relay_command` — the coordinator MCP's "run this verb on the
 * daemon that owns that node" entry (design 2026-10-07 §4.3).
 *
 * The cloud daemon answers the same command in its local IPC handler
 * (`packages/daemon-cloud` adhdev-daemon-local-ipc.ts) by sending the verb over
 * its WebRTC mesh manager. The standalone daemon has the WebSocket sibling of
 * that manager (`WsMeshTransport`, both extend the shared `MeshRpcEndpoint`), and
 * the boot already hands it to daemon-core as `DaemonBootConfig.mesh
 * .dispatchMeshCommand` — the same function every in-daemon remote dispatch
 * (queue autolaunch, auto fast-forward, turn-ledger probes) uses. Relaying
 * through it gives the coordinator exactly what the daemon itself can already
 * reach, with the same per-command result deadlines (`mesh-rpc-timeouts.ts`) and
 * the same probe connect-wait budget.
 *
 * What may run on the far side is NOT decided here: the receiving daemon's
 * router admits a `mesh`-source command only when the command spec accepts that
 * source and its `meshSender` policy passes for the handshake-proven sender
 * (commands/mesh-sender.ts) — the same gate a cloud relay meets. So standalone
 * and cloud relay the same command set by construction.
 *
 * Result shape matches the cloud relay so mcp-server reads both the same way:
 *  - the remote router result is returned as is (a remote `success:false`
 *    stays a failure — never wrapped as a success);
 *  - a typed transport failure (`P2pRelayFailureError`, `transport: 'p2p'`)
 *    becomes the structured `buildP2pRelayFailurePayload` object, so the MCP's
 *    recoverable-transport classification still works across the hop;
 *  - anything else (bad arguments, no mesh link) throws — the HTTP command
 *    route answers it as a 400, the IPC compat route as a failed command.
 */
import {
  LOG,
  buildP2pRelayFailurePayload,
  daemonIdsEquivalent,
  maskDaemonId,
} from '@adhdev/daemon-core';

export const MESH_RELAY_COMMAND = 'mesh_relay_command';

export interface StandaloneMeshRelayDeps {
  /** This daemon's status identity (`standalone_<machineId>`). */
  readonly localDaemonId: string;
  /** Run a verb on THIS daemon (a self-targeted relay). */
  executeLocal(command: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * `DaemonBootConfig.mesh.dispatchMeshCommand` — probe connect-wait budget and
   * status-marker stripping included. Null when this daemon has no mesh link.
   */
  readonly dispatchRemote: ((daemonId: string, command: string, args: Record<string, unknown>) => Promise<unknown>) | null;
}

export interface StandaloneMeshRelayRequest {
  readonly targetDaemonId: string;
  readonly command: string;
  readonly args: Record<string, unknown>;
}

/** Validate a `mesh_relay_command` payload (`{ targetDaemonId, command, args }`). */
export function readMeshRelayRequest(payload: unknown): StandaloneMeshRelayRequest {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const targetDaemonId = typeof value.targetDaemonId === 'string' ? value.targetDaemonId.trim() : '';
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const args = value.args && typeof value.args === 'object' && !Array.isArray(value.args)
    ? value.args as Record<string, unknown>
    : {};
  if (!targetDaemonId || !command) {
    throw new Error('mesh_relay_command requires targetDaemonId and command');
  }
  if (command === MESH_RELAY_COMMAND) {
    // A relay of a relay would let a peer bounce a command onward under this
    // daemon's identity. The cloud relay never nests either.
    throw new Error('mesh_relay_command cannot relay itself');
  }
  return { targetDaemonId, command, args };
}

/** Run one `mesh_relay_command` (see the module comment for the result contract). */
export async function runStandaloneMeshRelay(
  deps: StandaloneMeshRelayDeps,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const request = readMeshRelayRequest(payload);
  // Self in ANY id form (bare `mach_X`, `daemon_mach_X`, `standalone_mach_X`):
  // a self-target sent over the transport would be refused as SELF_DIAL.
  if (daemonIdsEquivalent(request.targetDaemonId, deps.localDaemonId)) {
    return asRecord(await deps.executeLocal(request.command, request.args));
  }
  if (!deps.dispatchRemote) {
    throw new Error('mesh_relay_command: this standalone daemon has no mesh link to other machines');
  }
  try {
    return asRecord(await deps.dispatchRemote(request.targetDaemonId, request.command, request.args));
  } catch (error) {
    if (error && typeof error === 'object' && (error as { transport?: unknown }).transport === 'p2p') {
      LOG.info('Mesh', `[Mesh] Relay '${request.command}' to ${maskDaemonId(request.targetDaemonId)} failed: ${(error as Error).message}`);
      return buildP2pRelayFailurePayload(error, {
        command: request.command,
        targetDaemonId: request.targetDaemonId,
      }) as unknown as Record<string, unknown>;
    }
    throw error;
  }
}

/** Cloud `normalizeMeshRelayResult`: an object passes through, anything else is wrapped. */
function asRecord(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return { success: true, result };
}
