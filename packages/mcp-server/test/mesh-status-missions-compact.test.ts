import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { meshStatus } from '../src/tools/mesh-tools.js';
import { enqueueTask, getLedgerDir, upsertMeshMission } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';

// Compact mesh_status used to inline every live mission PLUS up to 10 history
// missions in full (goalPreview + tasks + a per-mission stats rollup) on every
// poll, which dominated the payload and pushed mesh_status past the MCP token
// cap once a mesh accumulated missions. Compact must now fold missions like it
// folds nodes/sessions; verbose stays full (backward-compat escape hatch).
const COMPACT_BUDGET = 25_000;

function cleanupMesh(meshId: string): void {
  __clearMeshQueueForTests(meshId);
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  // Missions persist in the file-backed SQLite store (not the ledger files), so
  // clear them explicitly or rows leak across test runs and inflate live counts.
  try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function buildCtx(meshId: string) {
  const mesh = {
    id: meshId, name: 'Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
    defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [{ id: 'node-0', workspace: '/w', repoRoot: '/w', daemonId: 'daemon-A', machineId: 'machine-A', isLocalWorktree: true, userOverrides: {}, policy: {} }],
  };
  const responder = (command: string) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'git_status') return { success: true, status: { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] } };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    return { success: true };
  };
  const transport: any = {};
  transport.command = async (c: string) => responder(c);
  transport.meshCommand = async (_d: string, c: string) => responder(c);
  return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } };
}

const LONG_GOAL = 'Diagnose and fix the mesh_status compact output bloat caused by the missions array carrying full goal previews and stats per mission across active paused completed and abandoned lifecycle states forever. '.repeat(3);

function seedMissions(meshId: string, counts: { active: number; paused: number; completed: number; abandoned: number }) {
  let i = 0;
  const seed = (n: number, status: string) => {
    for (let k = 0; k < n; k++, i++) {
      const m = upsertMeshMission(meshId, { title: `Mission ${i} do something important here`, goal: LONG_GOAL, status });
      for (let t = 0; t < 3; t++) enqueueTask(meshId, `task ${t} of mission ${i}`, { missionId: m.id } as any);
    }
  };
  seed(counts.active, 'active');
  seed(counts.paused, 'paused');
  seed(counts.completed, 'completed');
  seed(counts.abandoned, 'abandoned');
}

test('compact mesh_status folds completed/abandoned missions and drops per-mission stats', async () => {
  const meshId = 'mesh-missions-compact-fold';
  cleanupMesh(meshId);
  const { ctx } = buildCtx(meshId);
  try {
    seedMissions(meshId, { active: 5, paused: 3, completed: 12, abandoned: 4 });

    const compact = JSON.parse(await meshStatus(ctx as any));
    assert.equal(compact.payloadMode, 'compact');

    // Live missions (active + paused) carry detail; history is NOT inlined.
    assert.ok(Array.isArray(compact.missions));
    assert.equal(compact.missions.length, 8, 'only the 8 live (active/paused) missions are detailed');
    for (const m of compact.missions) {
      assert.ok(m.status === 'active' || m.status === 'paused', 'detailed missions are live only');
      // Stats rollup is dropped in compact — tasks aggregate carries progress.
      assert.equal(m.stats, undefined, 'compact live missions must not carry the stats rollup');
      assert.ok(m.tasks && typeof m.tasks.total === 'number', 'tasks aggregate is retained');
      // Goal is elided to the tight compact preview (<= 80 chars).
      assert.ok(typeof m.goalPreview === 'string' && m.goalPreview.length <= 80, 'goalPreview <= 80 chars');
      assert.equal(m.goal, undefined, 'full goal text is elided in compact');
    }

    // Completed/abandoned history folded to counts + ids, not full detail.
    assert.ok(compact.missionsHistory, 'history is folded into missionsHistory');
    assert.equal(compact.missionsHistory.count, 16);
    assert.equal(compact.missionsHistory.byStatus.completed, 12);
    assert.equal(compact.missionsHistory.byStatus.abandoned, 4);
    assert.ok(Array.isArray(compact.missionsHistory.missionIds) && compact.missionsHistory.missionIds.length > 0);
    // The folded history must NOT carry per-mission goal/tasks bodies.
    const historyJson = JSON.stringify(compact.missionsHistory);
    assert.ok(!historyJson.includes('goalPreview'), 'folded history carries no goalPreview bodies');
  } finally {
    cleanupMesh(meshId);
  }
});

test('compact mesh_status stays under the token budget with many missions; every id stays discoverable', async () => {
  const meshId = 'mesh-missions-compact-budget';
  cleanupMesh(meshId);
  const { ctx } = buildCtx(meshId);
  try {
    // Pathological: 60 live missions + a long history.
    seedMissions(meshId, { active: 40, paused: 20, completed: 30, abandoned: 0 });

    const compactStr = await meshStatus(ctx as any);
    const compact = JSON.parse(compactStr);

    assert.ok(
      compactStr.length < COMPACT_BUDGET,
      `compact mesh_status must stay under ${COMPACT_BUDGET} bytes with many missions; got ${compactStr.length}`,
    );

    // Live missions: those that don't fit the byte budget fold into foldedMissions.
    const detailedIds: string[] = (compact.missions ?? []).map((m: any) => String(m.id));
    const foldedIds: string[] = compact.foldedMissions?.missionIds ?? [];
    assert.ok(compact.foldedMissions, 'overflow live missions must fold into foldedMissions');
    assert.equal(
      detailedIds.length + foldedIds.length,
      60,
      'every live mission id is discoverable (detailed array + foldedMissions id list)',
    );
    // History (30) is summarized, not inlined.
    assert.equal(compact.missionsHistory.count, 30);
  } finally {
    cleanupMesh(meshId);
  }
});

test('verbose mesh_status restores full missions (full goal + stats + history) — backward compat', async () => {
  const meshId = 'mesh-missions-verbose-restore';
  cleanupMesh(meshId);
  const { ctx } = buildCtx(meshId);
  try {
    seedMissions(meshId, { active: 3, paused: 2, completed: 4, abandoned: 1 });

    const verbose = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    assert.equal(verbose.payloadMode, 'full');
    assert.ok(Array.isArray(verbose.missions));
    // Verbose keeps live + a capped slice of history inline (no fold).
    assert.equal(verbose.missionsHistory, undefined, 'verbose does not fold history into missionsHistory');
    assert.equal(verbose.foldedMissions, undefined, 'verbose does not byte-fold live missions');
    const live = verbose.missions.filter((m: any) => m.status === 'active' || m.status === 'paused');
    const history = verbose.missions.filter((m: any) => m.status === 'completed' || m.status === 'abandoned');
    assert.equal(live.length, 5, 'all live missions inline in verbose');
    assert.ok(history.length >= 1, 'history missions inline in verbose');
    for (const m of verbose.missions) {
      assert.equal(typeof m.goal, 'string', 'verbose keeps full goal text');
      assert.ok(m.goal.length > 80, 'verbose goal is the full untruncated text');
      assert.ok(m.stats && typeof m.stats.taskCount === 'number', 'verbose keeps the stats rollup');
      assert.equal(m.goalPreview, undefined, 'verbose has no goalPreview elision');
    }
  } finally {
    cleanupMesh(meshId);
  }
});
