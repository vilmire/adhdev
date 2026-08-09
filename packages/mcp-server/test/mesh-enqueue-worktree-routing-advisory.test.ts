import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { buildUntargetedCodeChangeWorktreeAdvisory } from '../src/tools/mesh-tools-queue.js';
import { getQueue, getLedgerDir } from '@adhdev/daemon-core';

// WORKTREE-ROUTING-ADVISORY (b1) — tool-side companion to the coordinator prompt's
// base-node boundary. An untargeted `code_change` is claimed by whichever node polls
// first (in practice the base node), so general code work lands on a shared checkout
// with no branch isolation. The advisory flags exactly that case.
//
// The exemptions are the safety-critical half: a task pinned with required_tags
// (os=win32 …) or target_node_id is a DELIBERATE physical-environment test. Flagging
// those would push real win32 PATH / clean-install / machine-state verification toward
// worktrees, where it cannot be verified at all. The advisory must stay silent there.
//
// Advisory only: it never blocks and never re-routes — every task below still enqueues.

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_wtadv_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function recordingTransport() {
  return {
    command: async () => ({ success: true }),
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(meshId: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
        { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win' },
      ],
    },
    transport: recordingTransport(),
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

// ── the flagged case ──────────────────────────────────────────────────────────

test('untargeted code_change is flagged with a worktree routing advisory', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'refactor the status reporter',
    task_mode: 'code_change',
  } as any));

  assert.equal(res.success, true, 'advisory must not block the enqueue');
  assert.ok(res.worktreeRoutingAdvisory, 'untargeted code_change carries the advisory');
  assert.match(res.worktreeRoutingAdvisory, /mesh_clone_node/);
  assert.match(res.worktreeRoutingAdvisory, /required_tags/, 'names the exemption escape hatch');
  assert.equal(getQueue(meshId).length, 1, 'the task still enqueues unchanged');
});

test('the advisory is non-destructive: the enqueued task keeps its unpinned routing', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'add a unit test for the parser',
    task_mode: 'code_change',
  } as any));

  assert.ok(res.worktreeRoutingAdvisory);
  // b1 advises; it must NOT silently re-route (that would be b3).
  assert.equal(res.targetNodeId, undefined, 'advisory must not stamp a target node');
  assert.equal(getQueue(meshId)[0].targetNodeId, undefined, 'queued task stays unpinned');
});

// ── ★ exemption guard: physical-environment tasks must never be pushed to worktrees ──

test('EXEMPTION: required_tags (os=win32) suppresses the advisory — real win32 verification stays on the base node', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'verify the win32 PATH after a clean install',
    task_mode: 'code_change',
    required_tags: ['os=win32'],
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.worktreeRoutingAdvisory, undefined,
    'a tag-pinned physical-environment task must NOT be nudged toward a worktree');
});

test('EXEMPTION: target_node_id suppresses the advisory — explicit machine routing is honored', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'reproduce the Homebrew state bug on this exact machine',
    task_mode: 'code_change',
    target_node_id: NODE_WIN,
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_WIN);
  assert.equal(res.worktreeRoutingAdvisory, undefined,
    'an explicitly targeted task must NOT be nudged toward a worktree');
});

test('EXEMPTION: the target_node spelling also suppresses the advisory', async () => {
  // MESH-DISPATCH-MISROUTE accepts four spellings for the target pin; the exemption
  // is keyed off the RESOLVED targetNodeId, so every spelling must exempt.
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'check the installer layout on the mac node',
    task_mode: 'code_change',
    target_node: NODE_MAC,
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.worktreeRoutingAdvisory, undefined);
});

// ── read-only / convergence are out of scope by design ────────────────────────

test('read-only tasks are unaffected — they need no isolation and may stack on a busy node', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  const viaTaskMode = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'investigate why the reporter drops events',
    task_mode: 'live_debug_readonly',
  } as any));
  assert.equal(viaTaskMode.success, true);
  assert.equal(viaTaskMode.worktreeRoutingAdvisory, undefined,
    'live_debug_readonly is exempt from the one-write-per-node invariant');

  const viaFlag = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'read the queue claim path and report',
    task_mode: 'code_change',
    readonly: true,
  } as any));
  assert.equal(viaFlag.success, true);
  assert.equal(viaFlag.worktreeRoutingAdvisory, undefined,
    'the orthogonal readonly axis also exempts');
});

test('convergence tasks are exempt — merge/push is base-only and must not be pinned to a worktree', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'merge the feature branch into main',
    task_mode: 'convergence',
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.worktreeRoutingAdvisory, undefined);
});

test('a task with no task_mode at all is not flagged (the advisory is scoped to declared code_change)', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'do the thing' } as any));

  assert.equal(res.success, true);
  assert.equal(res.worktreeRoutingAdvisory, undefined);
});

test('prefer_worktree already asks for worktree routing, so it is exempt', () => {
  // Unit-level: with no worktree node in the mesh, prefer_worktree resolves to no
  // target (preferWorktreeNoOp) — the intent is still explicit, so no advisory.
  assert.equal(
    buildUntargetedCodeChangeWorktreeAdvisory({
      taskMode: 'code_change', readonly: false, requiredTags: [],
      targetNodeId: undefined, preferWorktree: true,
    }),
    null,
  );
});

// ── predicate-level truth table ───────────────────────────────────────────────

test('predicate: only an untargeted, non-read-only, tag-less code_change is advised', () => {
  const base = {
    taskMode: 'code_change', readonly: false, requiredTags: [] as string[],
    targetNodeId: undefined as string | undefined, preferWorktree: false,
  };

  assert.ok(buildUntargetedCodeChangeWorktreeAdvisory(base), 'the flagged case');

  assert.equal(buildUntargetedCodeChangeWorktreeAdvisory({ ...base, requiredTags: ['os=linux'] }), null);
  assert.equal(buildUntargetedCodeChangeWorktreeAdvisory({ ...base, targetNodeId: NODE_MAC }), null);
  assert.equal(buildUntargetedCodeChangeWorktreeAdvisory({ ...base, readonly: true }), null);
  assert.equal(buildUntargetedCodeChangeWorktreeAdvisory({ ...base, taskMode: 'convergence' }), null);
  assert.equal(buildUntargetedCodeChangeWorktreeAdvisory({ ...base, taskMode: 'validation' }), null);
  assert.equal(buildUntargetedCodeChangeWorktreeAdvisory({ ...base, taskMode: undefined }), null);
});
