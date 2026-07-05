import assert from 'node:assert/strict';
import test from 'node:test';

import { upsertMeshMission, getMeshMission } from '@adhdev/daemon-core';
import { meshMissionUpsert } from '../src/tools/mesh-tools.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';

function buildCtx(meshId: string): any {
    // meshMissionUpsert only reads ctx.mesh.id (single + bulk paths operate on the
    // file-backed mission store directly), so a minimal mesh is enough.
    return { mesh: { id: meshId }, transport: {}, localDaemonId: 'daemon-A', localMachineId: 'machine-A' };
}

function cleanup(meshId: string): void {
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
}

test('G3 bulk: mission_ids + status transitions many missions and returns per-mission results', async () => {
    const meshId = 'mesh-bulk-upsert-happy';
    cleanup(meshId);
    try {
        const m1 = upsertMeshMission(meshId, { title: 'Stale 1' });
        const m2 = upsertMeshMission(meshId, { title: 'Stale 2', goal: 'keep this goal' });
        const m3 = upsertMeshMission(meshId, { title: 'Stale 3' });

        const raw = await meshMissionUpsert(buildCtx(meshId), { mission_ids: [m1.id, m2.id, m3.id], status: 'abandoned' } as any);
        const res = JSON.parse(raw);

        assert.equal(res.success, true);
        assert.equal(res.mode, 'bulk');
        assert.equal(res.requestedStatus, 'abandoned');
        assert.equal(res.applied, 3);
        assert.equal(res.failed, 0);
        assert.equal(res.results.length, 3);
        assert.ok(res.results.every((r: any) => r.ok === true && r.status === 'abandoned'));

        // Each mission is actually transitioned and keeps its own title/goal.
        assert.equal(getMeshMission(meshId, m1.id)?.status, 'abandoned');
        assert.equal(getMeshMission(meshId, m2.id)?.status, 'abandoned');
        assert.equal(getMeshMission(meshId, m2.id)?.goal, 'keep this goal');
        assert.equal(getMeshMission(meshId, m2.id)?.title, 'Stale 2');
        assert.equal(getMeshMission(meshId, m3.id)?.status, 'abandoned');
    } finally {
        cleanup(meshId);
    }
});

test('G3 bulk: partial failure — unknown id reported, others still applied', async () => {
    const meshId = 'mesh-bulk-upsert-partial';
    cleanup(meshId);
    try {
        const m1 = upsertMeshMission(meshId, { title: 'Real' });

        const raw = await meshMissionUpsert(buildCtx(meshId), { mission_ids: [m1.id, 'does-not-exist'], status: 'completed' } as any);
        const res = JSON.parse(raw);

        assert.equal(res.success, false); // one failed → overall not success
        assert.equal(res.applied, 1);
        assert.equal(res.failed, 1);
        const okRow = res.results.find((r: any) => r.id === m1.id);
        const missRow = res.results.find((r: any) => r.id === 'does-not-exist');
        assert.equal(okRow.ok, true);
        assert.equal(missRow.ok, false);
        assert.equal(missRow.error, 'mission_not_found');
        assert.equal(getMeshMission(meshId, m1.id)?.status, 'completed');
    } finally {
        cleanup(meshId);
    }
});

test('G3 bulk: mission_ids without status is rejected', async () => {
    const meshId = 'mesh-bulk-upsert-nostatus';
    cleanup(meshId);
    try {
        const m1 = upsertMeshMission(meshId, { title: 'Real' });
        const raw = await meshMissionUpsert(buildCtx(meshId), { mission_ids: [m1.id] } as any);
        const res = JSON.parse(raw);
        assert.equal(res.success, false);
        assert.equal(res.code, 'bulk_status_required');
        // Mission untouched.
        assert.equal(getMeshMission(meshId, m1.id)?.status, 'active');
    } finally {
        cleanup(meshId);
    }
});

test('G3 bulk: invalid status surfaces per-mission invalid_mission_status', async () => {
    const meshId = 'mesh-bulk-upsert-badstatus';
    cleanup(meshId);
    try {
        const m1 = upsertMeshMission(meshId, { title: 'Real' });
        const raw = await meshMissionUpsert(buildCtx(meshId), { mission_ids: [m1.id], status: 'bogus' } as any);
        const res = JSON.parse(raw);
        assert.equal(res.success, false);
        assert.equal(res.failed, 1);
        assert.equal(res.results[0].code, 'invalid_mission_status');
        assert.equal(getMeshMission(meshId, m1.id)?.status, 'active');
    } finally {
        cleanup(meshId);
    }
});

test('mission_ids takes precedence over mission_id/title (bulk overrides single)', async () => {
    const meshId = 'mesh-bulk-upsert-precedence';
    cleanup(meshId);
    try {
        const m1 = upsertMeshMission(meshId, { title: 'Real' });
        // Both mission_ids and a single mission_id/title given → bulk path wins.
        const raw = await meshMissionUpsert(buildCtx(meshId), {
            mission_ids: [m1.id], status: 'completed', mission_id: 'ignored', title: 'ignored',
        } as any);
        const res = JSON.parse(raw);
        assert.equal(res.mode, 'bulk');
        assert.equal(res.applied, 1);
        assert.equal(getMeshMission(meshId, m1.id)?.status, 'completed');
    } finally {
        cleanup(meshId);
    }
});

test('single-mission path still works and now requires a title explicitly', async () => {
    const meshId = 'mesh-bulk-upsert-single';
    cleanup(meshId);
    try {
        // Create (single path).
        const createRaw = await meshMissionUpsert(buildCtx(meshId), { title: 'New mission', goal: 'done' } as any);
        const created = JSON.parse(createRaw);
        assert.equal(created.success, true);
        assert.equal(created.mission.status, 'active');

        // Missing title on single path → clear error.
        const noTitleRaw = await meshMissionUpsert(buildCtx(meshId), { status: 'completed' } as any);
        const noTitle = JSON.parse(noTitleRaw);
        assert.equal(noTitle.success, false);
        assert.equal(noTitle.code, 'mission_title_required');
    } finally {
        cleanup(meshId);
    }
});
