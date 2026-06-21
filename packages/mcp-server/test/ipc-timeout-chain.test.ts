import assert from 'node:assert/strict';
import test from 'node:test';

import { getTimeoutMs } from '../src/transports/ipc.js';

// Q-E: IPC (layer-1) timeout chain. The invariant for each heavy verb is
//   IPC (layer-1, here) >= relay (layer-2, daemon-cloud resultTimeoutForCommand) >= responder.
//
// Two dispatch shapes feed the IPC layer (see mesh-tools.ts commandForNode):
//   - REMOTE node: the verb is wrapped in `mesh_relay_command` (nestedCommand = verb).
//     getTimeoutMs takes max(table[mesh_relay_command]=120s, table[verb]) → always >= 120s,
//     so the relay/responder budget is always covered for remote dispatch.
//   - LOCAL node: the BARE verb is sent (no relay layer). getTimeoutMs(verb, '') is the
//     SOLE deadline and must directly cover the responder's synchronous budget.
//
// The relay budgets are the documented contract from daemon-cloud mesh-rpc-timeouts.ts:
//   clone 90s, remove 60s, git/fast-forward/refine 90s, git_status 30s.

// Relay-layer budgets (the contract this IPC layer must dominate).
const RELAY_CLONE_MS = 90_000;
const RELAY_REMOVE_MS = 60_000;
const RELAY_GIT_MS = 90_000;
const RELAY_GIT_STATUS_MS = 30_000;

test('remote-wrapped dispatch (mesh_relay_command) dominates every relay budget', () => {
  // Whatever heavy verb is nested, the relay envelope deadline is 120s ≥ any relay value.
  for (const verb of ['clone_mesh_node', 'remove_mesh_node', 'fast_forward_mesh_node', 'refine_mesh_node', 'git_status']) {
    assert.equal(getTimeoutMs('mesh_relay_command', verb), 120_000, `remote ${verb}`);
  }
  assert.ok(getTimeoutMs('mesh_relay_command', 'clone_mesh_node') >= RELAY_CLONE_MS);
  assert.ok(getTimeoutMs('mesh_relay_command', 'remove_mesh_node') >= RELAY_REMOVE_MS);
});

test('local bare clone_mesh_node IPC deadline >= relay clone budget (90s) — no more 15s false-timeout', () => {
  const ipc = getTimeoutMs('clone_mesh_node', '');
  assert.ok(ipc >= RELAY_CLONE_MS, `IPC clone ${ipc} >= relay ${RELAY_CLONE_MS}`);
  assert.equal(ipc, 120_000);
});

test('local bare remove_mesh_node IPC deadline >= relay remove budget (60s)', () => {
  const ipc = getTimeoutMs('remove_mesh_node', '');
  assert.ok(ipc >= RELAY_REMOVE_MS, `IPC remove ${ipc} >= relay ${RELAY_REMOVE_MS}`);
  assert.equal(ipc, 60_000);
});

test('local bare fast_forward / git_status / git_diff stay >= their relay budgets', () => {
  assert.ok(getTimeoutMs('fast_forward_mesh_node', '') >= RELAY_GIT_MS);
  assert.ok(getTimeoutMs('git_status', '') >= RELAY_GIT_STATUS_MS);
  assert.ok(getTimeoutMs('git_diff_summary', '') >= RELAY_GIT_STATUS_MS);
});

test('A5: plan_mesh_refine_node (synchronous dry-run) gets a 45s defensive budget, not the 15s default', () => {
  assert.equal(getTimeoutMs('plan_mesh_refine_node', ''), 45_000);
  assert.ok(getTimeoutMs('plan_mesh_refine_node', '') > 15_000);
});

test('A2: async refine/batch get a 30s defensive floor (intentionally < relay 90s — responder ack is sub-second)', () => {
  // These are async-job-ack: the responder returns immediately, so a deadline below the
  // relay budget is correct — the relay 90s never bounds the synchronous ack reply.
  assert.equal(getTimeoutMs('refine_mesh_node', ''), 30_000);
  assert.equal(getTimeoutMs('batch_refine_mesh_nodes', ''), 30_000);
  // Remote refine is still safe: the relay wrapper gives it 120s.
  assert.equal(getTimeoutMs('mesh_relay_command', 'refine_mesh_node'), 120_000);
});

test('an unclassified bare verb still falls back to the 15s default', () => {
  assert.equal(getTimeoutMs('some_unknown_command', ''), 15_000);
});
