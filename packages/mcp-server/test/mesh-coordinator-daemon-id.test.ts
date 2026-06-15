import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCoordinatorDaemonId } from '../src/tools/mesh-tools.js';

// resolveCoordinatorDaemonId() resolves the anchor stamped into a worker
// dispatch's meshContext.coordinatorDaemonId — the value the remote router
// turns into the worker session's meshCoordinatorDaemonId relay anchor. A bug
// in the direct-dispatch (mesh_send_task --session_id) path left this empty
// when ctx.localDaemonId was undefined, because it lacked the local-machine-id
// fallback the queue-assignment dispatch path has (loadConfig().machineId).
// These tests pin the full fallback chain so the remote completion event is
// always relay-routable.

function ctx(over: Record<string, unknown>): any {
  return {
    mesh: { id: 'mesh_remote', name: 'Remote Mesh', coordinator: {}, nodes: [], policy: {} },
    transport: {},
    ...over,
  };
}

test('prefers the coordinator mesh node daemonId when one resolves', () => {
  const c = ctx({
    localMachineId: 'machine-coordinator',
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh_remote', name: 'Remote Mesh', coordinator: {}, policy: {},
      nodes: [{ id: 'node-coordinator', machineId: 'machine-coordinator', daemonId: 'node-daemon-id' }],
    },
  });
  assert.equal(resolveCoordinatorDaemonId(c), 'node-daemon-id');
});

test('falls back to ctx.localDaemonId when no coordinator node daemonId', () => {
  const c = ctx({ localDaemonId: 'daemon-coordinator' });
  assert.equal(resolveCoordinatorDaemonId(c), 'daemon-coordinator');
});

test('falls back to ctx.localMachineId when localDaemonId is undefined (the direct-dispatch bug)', () => {
  // The remote direct-dispatch path used to omit coordinatorDaemonId in exactly
  // this case (IPC transport without a daemon instanceId), so the worker session
  // never got its relay anchor and the completion event stranded in the pending
  // queue until a read_chat reconcile. The machine-id fallback fixes it.
  const c = ctx({ localDaemonId: undefined, localMachineId: 'machine-coordinator' });
  assert.equal(resolveCoordinatorDaemonId(c), 'machine-coordinator');
});

test('returns undefined only when no local identity exists at all', () => {
  const c = ctx({ localDaemonId: undefined, localMachineId: undefined });
  assert.equal(resolveCoordinatorDaemonId(c), undefined);
});

test('treats blank-string identities as absent and keeps falling back', () => {
  const c = ctx({ localDaemonId: '   ', localMachineId: 'machine-coordinator' });
  assert.equal(resolveCoordinatorDaemonId(c), 'machine-coordinator');
});
