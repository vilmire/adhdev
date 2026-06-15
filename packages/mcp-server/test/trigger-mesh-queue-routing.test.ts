import assert from 'node:assert/strict';
import test from 'node:test';

import { triggerMeshQueueAndReport } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';

// trigger_mesh_queue is a coordinator-only operation. Only the coordinator
// daemon hosts the mesh object, the coordinator's local CLI instances, and the
// queue ledger; triggerMeshQueue() dispatches to remote idle sessions over P2P
// itself. Relaying trigger_mesh_queue to a remote worker daemon (via
// IpcTransport.meshCommand) makes the remote daemon's requireMeshHostMutationOwner
// → getMeshForCommand return null → 'Mesh not found' → queueDispatchState:
// trigger_failed. These tests pin that the trigger ALWAYS routes to the
// coordinator's local IPC (ctx.transport.command), never to a worker daemon.

function makeCtx(transport: any): any {
  return {
    mesh: { id: 'mesh_remote', name: 'Remote Mesh', coordinator: {}, nodes: [], policy: {} },
    transport,
    localDaemonId: 'daemon-coordinator',
    localMachineId: 'machine-coordinator',
  };
}

test('routes trigger_mesh_queue to the coordinator-local IPC (ctx.transport.command)', async () => {
  const localCommands: Array<{ cmd: string; args: any }> = [];
  const meshCommands: Array<{ daemonId: string; cmd: string }> = [];

  // A faithful-enough stand-in: an IpcTransport instance whose command/meshCommand
  // are stubbed, so the historical `instanceof IpcTransport` branch would have
  // been eligible if the remote routing still existed.
  const transport = Object.create(IpcTransport.prototype);
  transport.command = async (cmd: string, args: any) => {
    localCommands.push({ cmd, args });
    return { success: true, trigger: { success: true, claimed: true } };
  };
  transport.meshCommand = async (daemonId: string, cmd: string) => {
    meshCommands.push({ daemonId, cmd });
    return { success: false, error: 'Mesh not found' };
  };

  const result = await triggerMeshQueueAndReport(makeCtx(transport));

  assert.equal(meshCommands.length, 0, 'must NOT relay trigger_mesh_queue to a worker daemon');
  assert.equal(localCommands.length, 1);
  assert.equal(localCommands[0].cmd, 'trigger_mesh_queue');
  assert.deepEqual(localCommands[0].args, { meshId: 'mesh_remote' });
  assert.equal((result as any)?.claimed, true);
});

test('surfaces a failed trigger as { success: false } without throwing', async () => {
  const transport = Object.create(IpcTransport.prototype);
  transport.command = async () => {
    throw new Error('boom');
  };
  transport.meshCommand = async () => ({ success: true });

  const result = await triggerMeshQueueAndReport(makeCtx(transport));
  assert.equal((result as any)?.success, false);
  assert.match(String((result as any)?.error), /boom/);
});
