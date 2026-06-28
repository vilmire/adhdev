import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Mission ledger entries are dual-written to SQLite (primary read path) and a
// JSONL export file under getConfigDir(); redirect the config dir to a temp dir
// so the JSONL side-effect never touches the real ~/.adhdev.
const testConfigDir = join(tmpdir(), `adhdev-mission-ledger-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { upsertMeshMission } from '../../src/mesh/mesh-missions.js';
import { readLedgerEntries, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mission ledger audit trail', () => {
    // Fresh meshId per test: ledger entries are also exported to a per-mesh JSONL
    // file under the temp config dir, and a fresh store re-imports that file on its
    // first read — so reusing one meshId would leak entries across tests.
    let meshId = `mission-ledger-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `mission-ledger-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        __clearMeshLedgerForTests(meshId);
        MeshRuntimeStore.resetForTests();
    });

    it('appends mission_created on first upsert, with a truncated goal summary', () => {
        const mission = upsertMeshMission(meshId, { title: 'Ship feature X', goal: 'Merge all subtasks to main' });

        const created = readLedgerEntries(meshId, { kind: ['mission_created'] });
        expect(created).toHaveLength(1);
        expect(created[0].payload).toMatchObject({
            missionId: mission.id,
            title: 'Ship feature X',
            goalSummary: 'Merge all subtasks to main',
            goalLength: 'Merge all subtasks to main'.length,
            goalTruncated: false,
            status: 'active',
        });
        // No status/goal-change entries on a pure create.
        expect(readLedgerEntries(meshId, { kind: ['mission_status_changed'] })).toHaveLength(0);
        expect(readLedgerEntries(meshId, { kind: ['mission_goal_updated'] })).toHaveLength(0);
    });

    it('truncates a long goal in the mission_created payload but records the full length', () => {
        const longGoal = 'g'.repeat(500);
        upsertMeshMission(meshId, { title: 'Big mission', goal: longGoal });

        const created = readLedgerEntries(meshId, { kind: ['mission_created'] });
        expect(created).toHaveLength(1);
        const payload = created[0].payload as Record<string, unknown>;
        expect((payload.goalSummary as string).length).toBe(200);
        expect(payload.goalLength).toBe(500);
        expect(payload.goalTruncated).toBe(true);
    });

    it('records create → goal update → status transition as three distinct ledger kinds', () => {
        const created = upsertMeshMission(meshId, { title: 'Mission Y', goal: 'Initial goal' });

        // Goal change.
        upsertMeshMission(meshId, { id: created.id, title: 'Mission Y', goal: 'Revised goal text' });
        // Status transition.
        upsertMeshMission(meshId, { id: created.id, title: 'Mission Y', status: 'completed' });

        const createdEntries = readLedgerEntries(meshId, { kind: ['mission_created'] });
        const goalEntries = readLedgerEntries(meshId, { kind: ['mission_goal_updated'] });
        const statusEntries = readLedgerEntries(meshId, { kind: ['mission_status_changed'] });

        expect(createdEntries).toHaveLength(1);
        expect(goalEntries).toHaveLength(1);
        expect(statusEntries).toHaveLength(1);

        expect(goalEntries[0].payload).toMatchObject({
            missionId: created.id,
            prevGoalSummary: 'Initial goal',
            nextGoalSummary: 'Revised goal text',
            prevGoalLength: 'Initial goal'.length,
            nextGoalLength: 'Revised goal text'.length,
        });
        expect(statusEntries[0].payload).toMatchObject({
            missionId: created.id,
            fromStatus: 'active',
            toStatus: 'completed',
        });

        // All three are retrievable via a combined kind filter on mesh_task_history's read path.
        const all = readLedgerEntries(meshId, {
            kind: ['mission_created', 'mission_goal_updated', 'mission_status_changed'],
        });
        expect(all.map(e => e.kind).sort()).toEqual(
            ['mission_created', 'mission_goal_updated', 'mission_status_changed'].sort(),
        );
    });

    it('skips mission_goal_updated when the goal is rewritten with an identical value', () => {
        const created = upsertMeshMission(meshId, { title: 'Mission Z', goal: 'Same goal' });
        // No-op goal overwrite (identical text) + a real status change.
        upsertMeshMission(meshId, { id: created.id, title: 'Mission Z', goal: 'Same goal', status: 'paused' });

        expect(readLedgerEntries(meshId, { kind: ['mission_goal_updated'] })).toHaveLength(0);
        expect(readLedgerEntries(meshId, { kind: ['mission_status_changed'] })).toHaveLength(1);
    });

    it('does not emit a goal update when goal is omitted on a status-only upsert', () => {
        const created = upsertMeshMission(meshId, { title: 'Mission W', goal: 'Stable goal' });
        upsertMeshMission(meshId, { id: created.id, title: 'Mission W', status: 'abandoned' });

        expect(readLedgerEntries(meshId, { kind: ['mission_goal_updated'] })).toHaveLength(0);
        const statusEntries = readLedgerEntries(meshId, { kind: ['mission_status_changed'] });
        expect(statusEntries).toHaveLength(1);
        expect(statusEntries[0].payload).toMatchObject({ fromStatus: 'active', toStatus: 'abandoned' });
    });
});
