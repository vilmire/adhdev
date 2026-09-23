import assert from 'node:assert/strict';
import test from 'node:test';

import { drainCoordinatorPendingEvents } from '../src/tools/mesh-tools-internal.js';

// C2 / C-W3: the MCP coordinator's inbox is ONE `get_pending_mesh_events` read of
// its own daemon's turn.notify rows (the daemon claims what it returns). The
// retired shape — local drain + re-forward via mesh_forward_event + a remote
// get_pending_mesh_events pull per node — must not come back.

function ctxWith(respond: (command: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const meshCalls: string[] = [];
  const ctx: any = {
    localDaemonId: 'daemon-coord',
    coordinatorSessionId: 'coord-session-1',
    mesh: { id: 'mesh-inbox', nodes: [{ id: 'n-remote', daemonId: 'daemon-remote', workspace: '/w' }] },
    transport: {
      async command(command: string, args: Record<string, unknown> = {}) {
        calls.push({ command, args });
        return respond(command, args);
      },
      async meshCommand(_daemonId: string, command: string) {
        meshCalls.push(command);
        return { events: [] };
      },
    },
  };
  return { ctx, calls, meshCalls };
}

test('one self-inbox read, scoped to this coordinator session; events are surfaced, never re-forwarded, never pulled from peers', async () => {
  const { ctx, calls, meshCalls } = ctxWith(() => ({
    success: true,
    events: [
      { eventId: 'e1', meshId: 'mesh-inbox', event: 'refine:failed', coordinatorMessage: 'x', metadataEvent: { jobId: 'j1' } },
      { eventId: 'e2', meshId: 'other-mesh', event: 'refine:failed', coordinatorMessage: 'y' },
    ],
    hasLiveCliCoordinator: true,
    surfacedForSelfCoordinator: true,
    source: 'turn.notify',
  }));
  const events = await drainCoordinatorPendingEvents(ctx, { nodeIds: ['n-remote'] });
  assert.deepEqual(events.map((e: any) => e.eventId), ['e1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'get_pending_mesh_events');
  assert.deepEqual(calls[0].args, { meshId: 'mesh-inbox', coordinatorDaemonId: 'daemon-coord', selfCoordinatorInboxRead: true, sessionId: 'coord-session-1' });
  assert.equal(calls.some((c) => c.command === 'mesh_forward_event'), false);
  assert.deepEqual(meshCalls, []);
  assert.equal(ctx.lastNoticeReplication, undefined);
});

test('a replication-pending marker is kept for mesh_status; a failed read is non-fatal (empty)', async () => {
  const pending = ctxWith(() => ({ success: true, events: [], replication: 'pending' }));
  assert.deepEqual(await drainCoordinatorPendingEvents(pending.ctx), []);
  assert.equal(pending.ctx.lastNoticeReplication, 'pending');

  const failing = ctxWith(() => { throw new Error('ipc down'); });
  assert.deepEqual(await drainCoordinatorPendingEvents(failing.ctx), []);
});
