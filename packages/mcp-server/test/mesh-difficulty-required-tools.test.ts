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

import { meshEnqueueTask, meshSendTask } from '../src/tools/mesh-tools.js';
import { MESH_SEND_TASK_TOOL } from '../src/tools/mesh-tool-schemas-session.js';
import { MESH_ENQUEUE_TASK_TOOL } from '../src/tools/mesh-tool-schemas-queue.js';
import { getQueue } from '@adhdev/daemon-core';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
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
      command: async (__ipcCmd: string, __ipcArgs?: Record<string, unknown>) => { if (isTurnIpcCommand(__ipcCmd)) return answerTurnIpc(__ipcCmd, __ipcArgs ?? {}); return ({ success: true }); },
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
