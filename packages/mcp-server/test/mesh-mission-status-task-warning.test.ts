import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { getQueue, getLedgerDir, upsertMeshMission } from '@adhdev/daemon-core';

// MISSION-STATUS-TASK-WARNING: mission status is never auto-transitioned (only an
// explicit mesh_mission_upsert moves it). A task attached via mission_id to a
// paused/completed/abandoned mission must still enqueue (warn-only, mirroring the
// G4 duplicateSuspect convention) but the response must carry a missionInactive
// warning so the coordinator notices instead of silently leaving the mission's
// status misrepresenting what's actually happening.

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_missionwarn_${randomUUID().slice(0, 8)}`;
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
        { id: 'node_mac_base', workspace: '/repo/mac', daemonId: 'daemon_mac' },
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

test('paused mission: enqueue warns missionInactive but the task still enqueues', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const mission = upsertMeshMission(meshId, { title: 'Paused mission', status: 'paused' });

  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'follow-up work', mission_id: mission.id,
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true, 'task must still enqueue — warn, never block');
  assert.equal(res.missionInactive?.missionId, mission.id);
  assert.equal(res.missionInactive?.status, 'paused');
  assert.match(res.missionInactiveHint, /paused/i);
  assert.match(res.missionInactiveHint, /mesh_mission_upsert/);
  const row = getQueue(meshId).find((t: any) => t.id === res.taskId);
  assert.equal(row?.missionId, mission.id, 'the task is actually attached to the mission');
});

test('completed mission: warns with wording distinct from paused', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const mission = upsertMeshMission(meshId, { title: 'Completed mission', status: 'completed' });

  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'regression fix', mission_id: mission.id,
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.missionInactive?.status, 'completed');
  assert.match(res.missionInactiveHint, /completed/i);
});

test('abandoned mission: warns with wording distinct from paused/completed', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const mission = upsertMeshMission(meshId, { title: 'Abandoned mission', status: 'abandoned' });

  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'revive work', mission_id: mission.id,
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.missionInactive?.status, 'abandoned');
  assert.match(res.missionInactiveHint, /abandoned/i);
});

test('the three inactive-status hints are all textually distinct from each other', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const paused = upsertMeshMission(meshId, { title: 'M paused', status: 'paused' });
  const completed = upsertMeshMission(meshId, { title: 'M completed', status: 'completed' });
  const abandoned = upsertMeshMission(meshId, { title: 'M abandoned', status: 'abandoned' });

  const rPaused = JSON.parse(await meshEnqueueTask(ctx, { message: 'a', mission_id: paused.id,
    difficulty: 'medium',
} as any));
  const rCompleted = JSON.parse(await meshEnqueueTask(ctx, { message: 'b', mission_id: completed.id,
    difficulty: 'medium',
} as any));
  const rAbandoned = JSON.parse(await meshEnqueueTask(ctx, { message: 'c', mission_id: abandoned.id,
    difficulty: 'medium',
} as any));

  const hints = new Set([rPaused.missionInactiveHint, rCompleted.missionInactiveHint, rAbandoned.missionInactiveHint]);
  assert.equal(hints.size, 3, 'status-specific hints must not collapse into one shared string');
});

test('active mission: no warning', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const mission = upsertMeshMission(meshId, { title: 'Active mission', status: 'active' });

  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'normal work', mission_id: mission.id,
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.missionInactive, undefined);
  assert.equal(res.missionInactiveHint, undefined);
});

test('no mission_id: no warning', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'missionless work',
    difficulty: 'medium',
} as any));

  assert.equal(res.success, true);
  assert.equal(res.missionInactive, undefined);
  assert.equal(res.missionInactiveHint, undefined);
});

// MISSION-UPSERT-SILENT-CREATE: an unresolvable mission_id previously enqueued the task
// fine and orphaned it silently (buildMissionInactiveWarning only warns for a KNOWN mission
// in a non-active status, and returns undefined for an unknown id — no feedback at all).
// This must now be rejected before anything is queued.

test('unresolvable mission_id: rejected, task never enqueued (no silent orphan)', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'should not enqueue',
    mission_id: 'not-a-real-mission-id',
    difficulty: 'medium',
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'mission_not_found');
  assert.equal(getQueue(meshId).length, 0, 'no task was inserted for the unresolvable mission_id');
});
