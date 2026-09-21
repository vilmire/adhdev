import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import {
  getLedgerDir,
  providerPinsFromRequiredTags,
  filterProvidersByRequiredTags,
  buildMeshNodeCapabilityTags,
  nodeSatisfiesRequiredTags,
} from '@adhdev/daemon-core';

// ★PROVIDER-PIN-BYPASS (D2) — `required_tags: ["provider=X"]` was silently bypassed on
// the enqueue-and-push (`via: p2p_direct`) path.
//
// LIVE REPRO (2026-09-21, task 1c225a59, node Jupiter). Three consecutive ledger entries:
//   ① session_auto_launch  phase=skipped  reason=task_difficulty_floor_unavailable:medium
//        — Jupiter's antigravity-cli slot is difficulty:["easy"], so no antigravity slot
//          could take a `medium` task. Auto-launch was RIGHT to skip.
//   ② task_dispatched      via=p2p_direct  providerType=claude-cli   ← ★the pin is gone
//   ③ task_completed       finalContentLength=0, evidenceLevel=insufficient (34s)
//
// MECHANISM (three links, each individually reasonable):
//   1. buildMeshNodeCapabilityTags(node) with NO provider pinned advertises a
//      `provider=<type>` tag for EVERY slot the node declares. Jupiter declares
//      [claude-cli, antigravity-cli], so it advertises BOTH — and therefore
//      "satisfies" provider=antigravity-cli. Correct for a NODE filter; it answers
//      "could some provider here satisfy the pin?".
//   2. selectEagerPushReceiver used exactly that node-level predicate to pick a
//      receiver — also correct, that IS the question it needs answered.
//   3. ipcDispatchToRemoteAgent then chose the concrete provider on its own, from
//      `providerPriority[0]` — with no knowledge a pin existed. Jupiter's priority[0]
//      is claude-cli. Nothing compared the answer back against the pin.
//
// The node-level "yes" is not a guarantee about the provider ultimately selected, and
// link 3 treated it as one. The fix threads requiredTags into the provider resolution
// and re-asserts the pin on the value actually sent as `agentType`.
//
// OVER-CORRECTION GUARD (the real risk here): making pins strict must not block
// legitimate fallback. The tests below therefore fix BOTH directions as a control —
// an UNPINNED task must still be pushed exactly as before, and a SATISFIED pin must
// still dispatch. Only the unsatisfiable case declines, and it declines to `pending`
// (the claim path's job) rather than failing the task.

const NODE_JUPITER = 'node_f289402a016548388cae3db962527439';
const NODE_MAC = 'node_mac_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_pin_enforce_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

/**
 * A transport that satisfies `instanceof IpcTransport` (so meshEnqueueTask takes the
 * cloud eager-push branch) without a websocket. It records every agent_command, which
 * is the signal under test: `agentType` on that command is the provider the task
 * ACTUALLY ran on — the field the live ledger reported as claude-cli.
 *
 * `sessions` lets a test give the remote node live session truth, so the session
 * auto-pick branch (the other route to a provider) is exercised too.
 */
function recordingIpcTransport(sessions: any[] = []) {
  const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
  const t = {
    meshCommands,
    command: async () => ({ success: true }),
    meshCommand: async (daemonId: string, cmd: string, args: any) => {
      meshCommands.push({ daemonId, cmd, args });
      if (cmd === 'get_status_metadata') return { success: true, sessions };
      return { success: true, sessionId: args?.targetSessionId || 'sess_remote' };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  Object.setPrototypeOf(t, IpcTransport.prototype);
  return t;
}

/** The provider each dispatched agent_command actually targeted. */
function dispatchedProviders(transport: any): string[] {
  return transport.meshCommands
    .filter((c: any) => c.cmd === 'agent_command')
    .map((c: any) => c.args?.agentType as string);
}

/**
 * Jupiter as configured live: claude-cli FIRST in providerPriority (so priority[0] is
 * the wrong answer for an antigravity pin) and both providers present in slots (so the
 * node-level tag predicate says "yes" to either pin). These exact values are what made
 * the live bypass possible — the test is worthless if they drift.
 */
function jupiterNode() {
  return {
    id: NODE_JUPITER,
    workspace: '/repo/jupiter',
    daemonId: 'daemon_jupiter',
    reportedPlatform: 'win32',
    reportedArch: 'x64',
    policy: {
      providerPriority: ['claude-cli', 'antigravity-cli'],
      slots: [
        { provider: 'claude-cli', model: 'sonnet', difficulty: ['medium'], maxParallel: 1 },
        { provider: 'antigravity-cli', model: 'Gemini 3.7 Flash (High)', difficulty: ['easy'] },
      ],
    },
  };
}

function makeCtx(meshId: string, transport: any, nodes: any[]) {
  return { mesh: { id: meshId, nodes }, transport } as any;
}

function ledgerEntries(meshId: string): any[] {
  const p = join(getLedgerDir(), `${meshId}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

test.after(() => {
  for (const meshId of createdMeshes) {
    for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
      const p = join(getLedgerDir(), `${meshId}${suffix}`);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
});

// ── the premise: why the node-level predicate cannot be the pin enforcer ───────────

test('PREMISE: the node-level tag predicate says YES to a pin the node may not honor', () => {
  const node = jupiterNode();
  // This is the exact call selectEagerPushReceiver makes. It passes — correctly, as a
  // NODE question — even though the dispatch may still select claude-cli.
  assert.equal(
    nodeSatisfiesRequiredTags(['provider=antigravity-cli'], buildMeshNodeCapabilityTags(node)),
    true,
    'a multi-slot node satisfies a pin for ANY of its slots — this is why the node filter alone cannot enforce it',
  );
  // And the value the old code then picked independently is the wrong one.
  assert.equal(node.policy.providerPriority[0], 'claude-cli',
    'priority[0] is NOT the pinned provider — the gap the fix closes');
});

// ── the helpers ───────────────────────────────────────────────────────────────────

test('providerPinsFromRequiredTags extracts ONLY the provider= axis', () => {
  assert.deepEqual(providerPinsFromRequiredTags(['provider=antigravity-cli']), ['antigravity-cli']);
  // os=/arch=/worktree=/converge= are node properties, not provider choices — they must
  // never be read as a provider constraint or every tagged task becomes unroutable.
  assert.deepEqual(providerPinsFromRequiredTags(['os=win32', 'arch=x64', 'converge=refine']), []);
  assert.deepEqual(providerPinsFromRequiredTags(['os=win32', 'provider=codex-cli']), ['codex-cli']);
  assert.deepEqual(providerPinsFromRequiredTags(undefined), [], 'absent tags = no pin');
  assert.deepEqual(providerPinsFromRequiredTags([]), [], 'empty tags = no pin');
  // Malformed `provider=` with no value must not become a pin on the empty string,
  // which would match nothing and strand the task.
  assert.deepEqual(providerPinsFromRequiredTags(['provider=', 'provider=  ']), []);
});

test('filterProvidersByRequiredTags: no pin passes the list through UNCHANGED (over-correction guard)', () => {
  const list = ['claude-cli', 'antigravity-cli'];
  assert.deepEqual(filterProvidersByRequiredTags(list, []), list);
  assert.deepEqual(filterProvidersByRequiredTags(list, ['os=win32']), list,
    'a non-provider tag must not narrow provider choice at all');
  assert.deepEqual(filterProvidersByRequiredTags(list, undefined), list);
});

test('filterProvidersByRequiredTags: a pin narrows, and an unsatisfiable pin yields EMPTY (not the full list)', () => {
  assert.deepEqual(filterProvidersByRequiredTags(['claude-cli', 'antigravity-cli'], ['provider=antigravity-cli']),
    ['antigravity-cli']);
  // The critical direction: "nothing matches" must be distinguishable from "no
  // constraint". Returning the input here would restore the exact bypass.
  assert.deepEqual(filterProvidersByRequiredTags(['claude-cli'], ['provider=codex-cli']), [],
    'an unsatisfiable pin must yield EMPTY so the caller can decline — never fall back to the full list');
});

// ── the live repro, end to end ────────────────────────────────────────────────────

test('★LIVE REPRO: a provider-pinned task is NOT dispatched to providerPriority[0]', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'antigravity-pinned work',
    required_tags: ['provider=antigravity-cli'],
    difficulty: 'medium',
  } as any));
  assert.equal(res.success, true, 'the row still enqueues — the eager push is only an accelerator');
  await new Promise(resolve => setImmediate(resolve));

  const providers = dispatchedProviders(transport);
  assert.ok(
    !providers.includes('claude-cli'),
    `the pinned task must NEVER reach claude-cli (priority[0]); dispatched to: ${JSON.stringify(providers)}`,
  );
  // The live failure is fully characterized by that one assertion, but state the
  // positive form too: whatever ran, it satisfied the pin.
  for (const p of providers) {
    assert.equal(p, 'antigravity-cli', `every dispatch must honor the pin; got '${p}'`);
  }
});

test('★LIVE REPRO: the declined push leaves the task PENDING for the claim path (not failed)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'antigravity-pinned work',
    required_tags: ['provider=antigravity-cli'],
    difficulty: 'medium',
  } as any));
  await new Promise(resolve => setImmediate(resolve));

  // DESIGN DECISION under test: pin-unsatisfiable → stay pending, NOT explicit failure.
  // A pinned provider that is merely BUSY must wait; only a coordinator can tell a busy
  // pin from an impossible one, and the claim path enforces the pin per-session anyway.
  assert.equal(res.success, true);
  assert.equal(res.status, 'pending', 'the task must remain claimable, not be failed by the accelerator');
});

test('★PIN-OBSERVABILITY: a refused eager push is recorded, not silent', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  await meshEnqueueTask(ctx, {
    message: 'antigravity-pinned work',
    required_tags: ['provider=antigravity-cli'],
    difficulty: 'medium',
  } as any);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 10));

  const entries = ledgerEntries(meshId);
  // Whatever the outcome, it must NOT be a task_dispatched onto an unpinned provider —
  // that is the entry the live incident produced.
  const wrongDispatch = entries.find(e =>
    e.kind === 'task_dispatched' && e.payload?.providerType === 'claude-cli');
  assert.equal(wrongDispatch, undefined,
    'no task_dispatched may record a provider the task did not pin');

  // And if the push was declined, the decline must have left a trace with a stated
  // cause — silence would reproduce the defect's worst property.
  const dispatched = entries.filter(e => e.kind === 'task_dispatched');
  if (dispatched.length === 0) {
    const declined = entries.find(e =>
      e.kind === 'p2p_dispatch_failed' && e.payload?.reason === 'mesh_provider_pin_unsatisfiable');
    assert.ok(declined, 'a declined eager push must record why — a routing decision with no trace is the original defect');
    assert.deepEqual(declined.payload.requiredTags, ['provider=antigravity-cli'],
      'the refusal must name the pin it could not satisfy');
  }
});

test('★PIN-OBSERVABILITY: the enqueue response labels requiredTags as a REQUEST echo', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'pinned work',
    required_tags: ['provider=antigravity-cli'],
    difficulty: 'medium',
  } as any));

  // The coordinator could not previously tell request from confirmation: `requiredTags`
  // echoed the input whether or not the pin was honored.
  assert.deepEqual(res.providerPin, ['antigravity-cli'], 'the pin must be surfaced explicitly');
  assert.ok(typeof res.providerPinHint === 'string' && res.providerPinHint.includes('task_dispatched'),
    'the response must point at where the HONORED provider is observable');
});

// ── over-correction guards: the control group ─────────────────────────────────────

test('CONTROL: an UNPINNED task still falls back to providerPriority[0] (unchanged)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'unpinned work', difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  await new Promise(resolve => setImmediate(resolve));

  // THE over-correction guard. With no pin there is no constraint, so the previous
  // behavior must survive byte for byte — a fix that strands unpinned work is worse
  // than the bug it replaces.
  assert.deepEqual(
    dispatchedProviders(transport), ['claude-cli'],
    'an unpinned task must still be dispatched to priority[0] exactly as before',
  );
  assert.equal(res.providerPin, undefined, 'no pin → no pin advisory');
});

test('CONTROL: a NON-PROVIDER tag (os=) does not constrain provider selection', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'windows work', required_tags: ['os=win32'], difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  await new Promise(resolve => setImmediate(resolve));

  // os=/arch=/worktree= are node axes. Reading them as provider constraints would make
  // every platform-tagged task undispatchable.
  assert.deepEqual(
    dispatchedProviders(transport), ['claude-cli'],
    'a node-axis tag must leave provider selection exactly as it was',
  );
});

test('CONTROL: a SATISFIED pin still dispatches (pinning priority[0] is not blocked)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [jupiterNode()]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'claude-pinned work',
    required_tags: ['provider=claude-cli'],
    difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  await new Promise(resolve => setImmediate(resolve));

  // A pin that the node CAN honor must behave exactly as an unpinned dispatch would.
  assert.deepEqual(
    dispatchedProviders(transport), ['claude-cli'],
    'a satisfiable pin must dispatch normally — the fix only blocks the unsatisfiable case',
  );
});

test('CONTROL: a pin satisfied by a NON-FIRST slot dispatches to that slot, not priority[0]', async () => {
  const meshId = nextMeshId();
  // A node whose pinned provider is second in priority AND has a live idle session for
  // it: the pin must both survive resolution and steer the session auto-pick.
  const node = {
    id: NODE_MAC,
    workspace: '/repo/mac',
    daemonId: 'daemon_mac',
    reportedPlatform: 'darwin',
    policy: {
      providerPriority: ['claude-cli', 'codex-cli'],
      slots: [
        { provider: 'claude-cli', difficulty: ['medium'] },
        { provider: 'codex-cli', difficulty: ['medium'] },
      ],
    },
  };
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [node]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'codex-pinned work',
    required_tags: ['provider=codex-cli'],
    difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  await new Promise(resolve => setImmediate(resolve));

  const providers = dispatchedProviders(transport);
  assert.ok(!providers.includes('claude-cli'),
    `a second-priority pin must not fall back to priority[0]; got ${JSON.stringify(providers)}`);
  for (const p of providers) {
    assert.equal(p, 'codex-cli', 'the pinned non-first provider must be the one dispatched');
  }
});
