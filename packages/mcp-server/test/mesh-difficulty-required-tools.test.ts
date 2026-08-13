/**
 * DIFFICULTY-REQUIRED at the MCP tool boundary.
 *
 * ★ The MCP inputSchema's `required` array is NOT enforcement. The tool dispatcher
 * forwards raw args to the handler without runtime schema validation — the same reason
 * `message` needed a hand-written DELIVERY-MSG-GUARD despite being nominally required.
 * So this file pins BOTH halves:
 *
 *   1. the schemas DECLARE difficulty required (so an LLM caller is told to supply it), and
 *   2. the handlers ENFORCE it themselves (so a caller that ignores the schema is refused).
 *
 * A test that only asserted (1) would be exactly the silently-inert gate this change set
 * exists to avoid.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { meshEnqueueTask, meshSendTask } from '../src/tools/mesh-tools.js';
import { MESH_ENQUEUE_TASK_TOOL, MESH_SEND_TASK_TOOL } from '../src/tools/mesh-tool-schemas.js';
import { getQueue } from '@adhdev/daemon-core';

const NODE = 'node_diff_base';

function makeCtx(meshId: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [{ id: NODE, workspace: '/repo/base', daemonId: 'daemon_base' }],
      policy: {},
    },
    localDaemonId: 'daemon_base',
    transport: {
      command: async () => ({ success: true }),
      getStatus: async () => ({ sessions: [] }),
    },
  } as any;
}

function nextMeshId(): string {
  return `mesh_diffreq_${randomUUID().slice(0, 8)}`;
}

// ─── (1) The schemas declare it ───────────────────────────────────────────────

test('mesh_enqueue_task schema declares difficulty required, with the fixed axis as enum', () => {
  const schema = MESH_ENQUEUE_TASK_TOOL.inputSchema as any;
  assert.ok(schema.required.includes('difficulty'), 'difficulty must be in required[]');
  assert.deepEqual(schema.properties.difficulty.enum, ['easy', 'medium', 'difficult', 'freeform']);
});

test('mesh_send_task schema declares difficulty required, with the fixed axis as enum', () => {
  const schema = MESH_SEND_TASK_TOOL.inputSchema as any;
  assert.ok(schema.required.includes('difficulty'), 'difficulty must be in required[]');
  assert.deepEqual(schema.properties.difficulty.enum, ['easy', 'medium', 'difficult', 'freeform']);
});

// ─── (2) The handlers enforce it, schema `required` being inert ────────────────

test('mesh_send_task REFUSES a call with no difficulty (schema required is not enforcement)', async () => {
  const meshId = nextMeshId();
  const raw = await meshSendTask(makeCtx(meshId), {
    node_id: NODE,
    session_id: 'sess_1',
    message: 'do the thing',
  } as any);
  const res = JSON.parse(raw);
  assert.equal(res.success, false);
  assert.equal(res.code, 'missing_difficulty');
  // The error must teach: name the field and enumerate the allowed values.
  assert.match(res.error, /difficulty/);
  assert.deepEqual(res.allowedDifficulties, ['easy', 'medium', 'difficult', 'freeform']);
  // Nothing was recorded.
  assert.equal(getQueue(meshId).length, 0);
});

test('mesh_send_task REFUSES an unrecognized difficulty (typo), rather than dropping it', async () => {
  const meshId = nextMeshId();
  const raw = await meshSendTask(makeCtx(meshId), {
    node_id: NODE,
    session_id: 'sess_1',
    message: 'do the thing',
    difficulty: 'medum',
  } as any);
  const res = JSON.parse(raw);
  assert.equal(res.success, false);
  assert.equal(res.code, 'invalid_difficulty');
  assert.match(res.error, /medum/);
  assert.equal(getQueue(meshId).length, 0);
});

test('mesh_enqueue_task REFUSES a call with no difficulty', async () => {
  const meshId = nextMeshId();
  const raw = await meshEnqueueTask(makeCtx(meshId), {
    message: 'queued work',
  } as any);
  const res = JSON.parse(raw);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res), /difficulty/);
  assert.equal(getQueue(meshId).length, 0);
});

test('mesh_enqueue_task REFUSES an unrecognized difficulty', async () => {
  const meshId = nextMeshId();
  const raw = await meshEnqueueTask(makeCtx(meshId), {
    message: 'queued work',
    difficulty: 'medum',
  } as any);
  const res = JSON.parse(raw);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res), /difficulty/);
  assert.equal(getQueue(meshId).length, 0);
});

// ─── The conduit: a supplied difficulty reaches the stored task ────────────────

test('mesh_enqueue_task carries the supplied difficulty onto the queued task', async () => {
  const meshId = nextMeshId();
  const raw = await meshEnqueueTask(makeCtx(meshId), {
    message: 'queued work',
    difficulty: 'difficult',
  } as any);
  const res = JSON.parse(raw);
  assert.equal(res.success, true);
  const [task] = getQueue(meshId);
  assert.equal(task.difficulty, 'difficult');
});

// ─── Stage 2: the MAGI decision ───────────────────────────────────────────────

test('MAGI fan-out stamps the fixed freeform sentinel — it is not exempted from the guard', () => {
  // The decision (see the rationale comment at the enqueueTask call in mesh-tools-magi.ts):
  // MAGI routes on a DIFFERENT axis — each replica is hard-pinned to a (node, provider)
  // slot by the kind-panel via requiredTags/targetNodeId, and its model comes from that
  // slot. A difficulty would be inert at best and would fight the panel's slot selection
  // at worst. But rather than carve a hole in the guard, MAGI passes 'freeform' — a real
  // member of the axis meaning "no difficulty-based constraint".
  //
  // Pinned as source text because the fan-out needs a live multi-node panel to execute;
  // what matters is that the call site supplies a difficulty AND that it is the sentinel,
  // so a future edit cannot quietly reintroduce an unclassified MAGI enqueue.
  const src = readFileSync(
    new URL('../src/tools/mesh-tools-magi.ts', import.meta.url),
    'utf8',
  );
  const call = src.slice(src.indexOf('enqueueTask(ctx.mesh.id, prompt, {'));
  const body = call.slice(0, call.indexOf('});'));
  assert.match(body, /difficulty: 'freeform'/, 'MAGI must stamp the freeform sentinel');
  // And it must NOT be wired to a caller-supplied value — exposing a difficulty knob on
  // mesh_magi_review would imply it influences replica placement, which it does not.
  assert.ok(!/difficulty:\s*(args|readString)/.test(body), 'MAGI difficulty must not be caller-configurable');
});

test('mesh_send_task accepts every value on the fixed axis', async () => {
  for (const difficulty of ['easy', 'medium', 'difficult', 'freeform']) {
    const meshId = nextMeshId();
    const raw = await meshSendTask(makeCtx(meshId), {
      node_id: NODE,
      session_id: 'sess_1',
      message: 'do the thing',
      difficulty,
    } as any);
    const res = JSON.parse(raw);
    // It must at minimum get PAST the difficulty gate — whatever the dispatch outcome,
    // it is never rejected for the difficulty axis.
    assert.notEqual(res.code, 'missing_difficulty');
    assert.notEqual(res.code, 'invalid_difficulty');
  }
});
