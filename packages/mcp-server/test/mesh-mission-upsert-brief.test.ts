import assert from 'node:assert/strict';
import test from 'node:test';

import { getMeshMission } from '@adhdev/daemon-core';
import { meshMissionUpsert } from '../src/tools/mesh-tools.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';
import { makeFakeTurnIpcTransport } from './fake-turn-ipc-transport.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { MESH_MISSION_UPSERT_TOOL } from '../src/tools/mesh-tool-schemas.js';

/**
 * Parity audit gap: `coerceBriefArg` (mesh-tools-mission.ts) read only
 * camelCase (`ownedPaths`, `doneCriteria`, `handoffNotes`) even though the
 * daemon-side `normalizeMissionBrief` (mesh-shared/mission-brief.ts) has
 * always accepted the snake_case aliases too (`raw.doneCriteria ?? raw.done_criteria`
 * etc.) — so a caller using snake_case had that field silently dropped at the
 * MCP boundary before it ever reached the daemon. A brief with no `goal` (or a
 * field of the wrong type) was ALSO dropped with zero signal — the caller had
 * no way to learn their brief did not land. Fixed by (1) accepting the
 * snake_case aliases in coerceBriefArg and (2) returning a typed
 * `briefIgnored: {reason, field?}` warning when a non-empty brief is dropped.
 */

function buildCtx(meshId: string): any {
    return { mesh: { id: meshId }, transport: makeFakeTurnIpcTransport(), localDaemonId: 'daemon-A', localMachineId: 'machine-A' };
}

function cleanup(meshId: string): void {
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
}

test('mesh_mission_upsert: snake_case brief fields (done_criteria/handoff_notes/owned_paths) reach the stored brief', async () => {
    const meshId = 'mesh-brief-snake-case';
    cleanup(meshId);
    try {
        const raw = await meshMissionUpsert(buildCtx(meshId), {
            title: 'Snake case brief',
            brief: {
                goal: 'Ship the thing',
                done_criteria: ['tests green', 'deployed'],
                handoff_notes: ['ping owner before merging'],
                owned_paths: ['packages/server/src'],
            },
        } as any);
        const res = JSON.parse(raw);

        assert.equal(res.success, true);
        assert.equal(res.briefIgnored, undefined);

        const stored = getMeshMission(meshId, res.mission.id);
        assert.deepEqual(stored?.brief?.doneCriteria, ['tests green', 'deployed']);
        assert.deepEqual(stored?.brief?.handoffNotes, ['ping owner before merging']);
        assert.deepEqual(stored?.brief?.ownedPaths, ['packages/server/src']);
    } finally {
        cleanup(meshId);
    }
});

test('mesh_mission_upsert: camelCase brief fields still work (no regression)', async () => {
    const meshId = 'mesh-brief-camel-case';
    cleanup(meshId);
    try {
        const raw = await meshMissionUpsert(buildCtx(meshId), {
            title: 'Camel case brief',
            brief: {
                goal: 'Ship the thing',
                doneCriteria: ['tests green'],
                handoffNotes: ['note'],
                ownedPaths: ['packages/web-cloud/src'],
            },
        } as any);
        const res = JSON.parse(raw);

        assert.equal(res.success, true);
        const stored = getMeshMission(meshId, res.mission.id);
        assert.deepEqual(stored?.brief?.doneCriteria, ['tests green']);
        assert.deepEqual(stored?.brief?.handoffNotes, ['note']);
        assert.deepEqual(stored?.brief?.ownedPaths, ['packages/web-cloud/src']);
    } finally {
        cleanup(meshId);
    }
});

test('mesh_mission_upsert: a brief with no goal is dropped WITH a briefIgnored warning (was silent)', async () => {
    const meshId = 'mesh-brief-no-goal';
    cleanup(meshId);
    try {
        const raw = await meshMissionUpsert(buildCtx(meshId), {
            title: 'No-goal brief',
            brief: { doneCriteria: ['tests green'] },
        } as any);
        const res = JSON.parse(raw);

        assert.equal(res.success, true); // mission still created — brief is optional
        assert.ok(res.briefIgnored, 'expected a briefIgnored warning');
        assert.equal(res.briefIgnored.reason, 'missing_goal');

        const stored = getMeshMission(meshId, res.mission.id);
        assert.equal(stored?.brief, undefined);
    } finally {
        cleanup(meshId);
    }
});

test('mesh_mission_upsert: a brief field of the wrong type is dropped WITH a briefIgnored warning naming the field', async () => {
    const meshId = 'mesh-brief-bad-field';
    cleanup(meshId);
    try {
        const raw = await meshMissionUpsert(buildCtx(meshId), {
            title: 'Bad field brief',
            brief: { goal: 'ship it', doneCriteria: 'not an array' },
        } as any);
        const res = JSON.parse(raw);

        assert.equal(res.success, true);
        assert.ok(res.briefIgnored, 'expected a briefIgnored warning');
        assert.equal(res.briefIgnored.reason, 'invalid_field_type');
        assert.match(res.briefIgnored.field, /doneCriteria/);
    } finally {
        cleanup(meshId);
    }
});

test('mesh_mission_upsert schema declares the snake_case brief field aliases', () => {
    const briefProps = (MESH_MISSION_UPSERT_TOOL.inputSchema.properties as any).brief.properties;
    for (const field of ['done_criteria', 'handoff_notes', 'owned_paths']) {
        assert.ok(field in briefProps, `${field} missing from brief schema`);
    }
});

test('validateMeshToolArgs: mesh_mission_upsert accepts snake_case brief fields', () => {
    const err = validateMeshToolArgs('mesh_mission_upsert', {
        title: 't',
        brief: { goal: 'g', done_criteria: ['a'], handoff_notes: ['b'], owned_paths: ['c'] },
    });
    assert.equal(err, null);
});
