import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseDispatchableSession } from '../src/tools/mesh-tools.js';

// D3 regression: auto-pick (sessionless dispatch) must only adopt an IDLE delegate
// session. The previous `|| meshSessions.find(matchingProvider)` fallback accepted a
// generating/busy session, injecting a new task mid-generation — bypassing the
// resolveDeliveryDecision queue/reject guard that the explicit-session path enforces.
// When no idle session exists, chooseDispatchableSession must return undefined so the
// caller dispatches sessionless (worker picks/creates a session, or the task queues)
// instead of clobbering an in-flight session.

const MESH = 'mesh_auto';
const NODE = 'node_worker';
const COORD = 'daemon-coordinator';
const PROVIDER = 'claude-cli';

// A relay-safe, mesh-owned session record for this mesh/node with a given status.
function meshSession(id: string, status: string): any {
  return {
    id,
    status,
    providerType: PROVIDER,
    settings: {
      meshNodeFor: MESH,
      meshNodeId: NODE,
      meshCoordinatorDaemonId: COORD, // makes it relay-safe ('safe')
    },
  };
}

test('D3: picks the idle session when both an idle and a generating session exist', () => {
  const generating = meshSession('sess_generating', 'generating');
  const idle = meshSession('sess_idle', 'idle');
  const chosen = chooseDispatchableSession([generating, idle], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen?.id, 'sess_idle');
});

test('D3: returns undefined when only a generating session exists (no injection mid-generation)', () => {
  const generating = meshSession('sess_generating', 'generating');
  const chosen = chooseDispatchableSession([generating], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen, undefined);
});

test('D3: returns undefined when the only matching session is busy/non-idle', () => {
  const busy = meshSession('sess_busy', 'busy');
  const chosen = chooseDispatchableSession([busy], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen, undefined);
});

test('D3: still returns undefined for a non-idle session even with no provider filter', () => {
  const generating = meshSession('sess_generating', 'generating');
  // Empty providerType means "any provider matches" — must NOT relax the idle gate.
  const chosen = chooseDispatchableSession([generating], '', MESH, NODE, COORD);
  assert.equal(chosen, undefined);
});

test('D3: a waiting_input session counts as idle (waiting on the user) and is pickable', () => {
  const waiting = {
    id: 'sess_waiting',
    status: 'generating', // top-level status not idle…
    activeChat: { status: 'waiting_input' }, // …but the chat is waiting for input
    providerType: PROVIDER,
    settings: { meshNodeFor: MESH, meshNodeId: NODE, meshCoordinatorDaemonId: COORD },
  };
  const chosen = chooseDispatchableSession([waiting], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen?.id, 'sess_waiting');
});

test('D3: ignores an idle session that is not relay-safe / not mesh-owned for this mesh', () => {
  // Idle but belongs to a different mesh → not a candidate → undefined (sessionless dispatch).
  const stranger = {
    id: 'sess_stranger',
    status: 'idle',
    providerType: PROVIDER,
    settings: { meshNodeFor: 'mesh_other', meshNodeId: NODE, meshCoordinatorDaemonId: COORD },
  };
  const chosen = chooseDispatchableSession([stranger], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen, undefined);
});
