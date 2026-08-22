import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { enqueueTask, getQueue, updateTaskStatus, getLedgerDir } from '@adhdev/daemon-core';

// DEPENDSON-GATE-SYMMETRY — mcp-server Fix A.
//   The cloud "enqueue-and-push" path (IpcTransport) eagerly P2P-dispatches a freshly
//   enqueued task to a remote idle session, BYPASSING the queue claim. Before the fix it
//   never consulted task.dependsOn, so a dependency-blocked task was injected into a worker
//   immediately — running BEFORE its prerequisites completed. The gate must now be symmetric
//   with the queue-claim / auto-launch predicate: a task with unmet dependencies is NOT
//   eager-pushed (0 injections); it is left for the queue drain, which re-evaluates the same
//   predicate once the dependency completes. Tasks with no dependsOn are pushed as before.

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_dependson_push_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

// A transport that records every command / meshCommand it receives AND passes
// `instanceof IpcTransport` (so meshEnqueueTask takes the cloud eager-push branch)
// WITHOUT opening a real websocket. meshCommand is the eager-push injection signal —
// ipcDispatchToRemoteAgent calls it to fetch remote session truth before dispatching.
function recordingIpcTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
  const t = {
    commands,
    meshCommands,
    command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
    meshCommand: async (daemonId: string, cmd: string, args: any) => {
      meshCommands.push({ daemonId, cmd, args });
      return { success: true, sessions: [] };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  // Make it a genuine IpcTransport for the `instanceof` branch selector; own methods
  // above shadow the prototype so nothing tries to touch a real socket.
  Object.setPrototypeOf(t, IpcTransport.prototype);
  return t;
}

function makeCtx(meshId: string, transport: any) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
        { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win' },
      ],
    },
    transport,
  } as any;
}

test.after(() => {
  for (const meshId of createdMeshes) {
    for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
      const p = join(getLedgerDir(), `${meshId}${suffix}`);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
});

test('Fix A: a task with an UNMET dependency is NOT eager-pushed (0 injections)', async () => {
  const meshId = nextMeshId();
  // A prerequisite that is still pending (never completed).
  const dep = enqueueTask(meshId, 'prerequisite', { difficulty: 'medium' });
  assert.equal(dep.status, 'pending');

  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'dependent work', depends_on: [dep.id],
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.eagerPushDeferred, true, 'eager push must be deferred while the dependency is unmet');
  assert.equal(res.eagerPushDeferredReason, 'dependencies_unsatisfied');
  // Injection 0: the eager-push loop must never have called meshCommand to dispatch to a
  // remote session. The only transport traffic is the local queue trigger.
  assert.equal(transport.meshCommands.length, 0, 'no remote session may be injected for a dependency-blocked task');
  assert.ok(
    transport.commands.every((c: any) => c.cmd === 'trigger_mesh_queue' || c.cmd === 'get_mesh'),
    'only the pre-validation snapshot refresh (get_mesh) and the local queue trigger may run',
  );
});

test('Fix A: a task with NO dependencies is eager-pushed as before (conservative default)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'independent work',
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.eagerPushDeferred, undefined, 'a task with no dependsOn must not be gated');
});

test('Fix A: a task whose dependency is COMPLETED is eager-pushed (gate opens)', async () => {
  const meshId = nextMeshId();
  const dep = enqueueTask(meshId, 'prerequisite done', { difficulty: 'medium' });
  // Drive the dep to a terminal completed state through the host queue API.
  updateTaskStatus(meshId, dep.id, 'completed');
  assert.equal(getQueue(meshId).find(t => t.id === dep.id)?.status, 'completed');

  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'dependent, dep done', depends_on: [dep.id],
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.eagerPushDeferred, undefined, 'a satisfied dependency must not defer the eager push');
});
