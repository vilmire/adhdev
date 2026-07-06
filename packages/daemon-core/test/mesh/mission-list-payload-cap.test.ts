import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Mission mutations dual-write a JSONL export under getConfigDir(); redirect it to
// a temp dir so the test never touches the real ~/.adhdev.
const testConfigDir = join(tmpdir(), `adhdev-mission-list-cap-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    upsertMeshMission,
    listMeshMissionsForTool,
    MESH_MISSION_LIST_STATUS_LIMIT,
    type MeshMissionSlimSummary,
} from '../../src/mesh/mesh-missions.js';
import { __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh_mission_list payload cap (listMeshMissionsForTool)', () => {
    let meshId = `mission-list-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `mission-list-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        __clearMeshLedgerForTests(meshId);
        MeshRuntimeStore.resetForTests();
    });

    it('default view returns live missions in detail and folds completed/abandoned history', () => {
        upsertMeshMission(meshId, { title: 'Live A', goal: 'active goal', status: 'active' });
        upsertMeshMission(meshId, { title: 'Live B', goal: 'paused goal', status: 'paused' });
        // Many terminal missions — these must NOT be listed one-by-one.
        for (let i = 0; i < 40; i++) {
            upsertMeshMission(meshId, { title: `Done ${i}`, status: 'completed' });
        }
        for (let i = 0; i < 5; i++) {
            upsertMeshMission(meshId, { title: `Gone ${i}`, status: 'abandoned' });
        }

        const result = listMeshMissionsForTool(meshId);

        // Only the 2 non-terminal missions appear in detail.
        expect(result.missions).toHaveLength(2);
        const titles = result.missions.map(m => m.title).sort();
        expect(titles).toEqual(['Live A', 'Live B']);

        // The 45 terminal missions are folded, not listed.
        expect(result.historyFold).not.toBeNull();
        expect(result.historyFold!.count).toBe(45);
        expect(result.historyFold!.byStatus).toEqual({ completed: 40, abandoned: 5 });
        // Id list is capped (default 30) so the fold itself stays bounded.
        expect(result.historyFold!.missionIds.length).toBeLessThanOrEqual(30);
    });

    it('omits per-mission stats by default (withStats off)', () => {
        upsertMeshMission(meshId, { title: 'Live', status: 'active' });
        const result = listMeshMissionsForTool(meshId);
        expect(result.missions[0]).not.toHaveProperty('stats');
    });

    it('attaches stats when withStats is set', () => {
        upsertMeshMission(meshId, { title: 'Live', status: 'active' });
        const result = listMeshMissionsForTool(meshId, { withStats: true });
        expect(result.missions[0]).toHaveProperty('stats');
    });

    it('explicit status filter returns those missions in detail (no fold)', () => {
        upsertMeshMission(meshId, { title: 'Live', status: 'active' });
        upsertMeshMission(meshId, { title: 'Done 1', status: 'completed' });
        upsertMeshMission(meshId, { title: 'Done 2', status: 'completed' });

        const result = listMeshMissionsForTool(meshId, { statuses: ['completed'] });
        expect(result.historyFold).toBeNull();
        expect(result.missions.map(m => m.title).sort()).toEqual(['Done 1', 'Done 2']);
        expect(result.truncated).toBe(false);
    });

    it('explicit status filter is bounded by limit and reports overflow', () => {
        for (let i = 0; i < 60; i++) {
            upsertMeshMission(meshId, { title: `Done ${i}`, status: 'completed' });
        }
        const result = listMeshMissionsForTool(meshId, { statuses: ['completed'], limit: 10 });
        expect(result.missions).toHaveLength(10);
        expect(result.matched).toBe(60);
        expect(result.truncated).toBe(true);
        expect(result.overflowIds).toBeDefined();
        expect(result.overflowIds!.length).toBe(50);
    });

    it('default limit caps the detail list at MESH_MISSION_LIST_STATUS_LIMIT', () => {
        for (let i = 0; i < MESH_MISSION_LIST_STATUS_LIMIT + 5; i++) {
            upsertMeshMission(meshId, { title: `Active ${i}`, status: 'active' });
        }
        const result = listMeshMissionsForTool(meshId);
        expect(result.missions).toHaveLength(MESH_MISSION_LIST_STATUS_LIMIT);
        expect(result.truncated).toBe(true);
        expect(result.matched).toBe(MESH_MISSION_LIST_STATUS_LIMIT + 5);
    });

    it('hides completed MAGI missions by default, includes them with includeMagi', () => {
        upsertMeshMission(meshId, { title: 'MAGI done', status: 'completed', source: 'magi' });
        upsertMeshMission(meshId, { title: 'Coord done', status: 'completed' });

        const hidden = listMeshMissionsForTool(meshId, { statuses: ['completed'] });
        expect(hidden.missions.map(m => m.title)).toEqual(['Coord done']);

        const shown = listMeshMissionsForTool(meshId, { statuses: ['completed'], includeMagi: true });
        expect(shown.missions.map(m => m.title).sort()).toEqual(['Coord done', 'MAGI done']);
    });

    it('compact (default) elides goal to a preview; verbose returns full goal', () => {
        const longGoal = 'x'.repeat(500);
        upsertMeshMission(meshId, { title: 'Live', goal: longGoal, status: 'active' });

        const compact = listMeshMissionsForTool(meshId).missions[0] as MeshMissionSlimSummary;
        expect(compact.goalTruncated).toBe(true);
        expect(compact.goalPreview.length).toBeLessThan(longGoal.length);
        expect(compact).not.toHaveProperty('goal');

        const verbose = listMeshMissionsForTool(meshId, { verbose: true }).missions[0] as any;
        expect(verbose.goal).toBe(longGoal);
    });
});
