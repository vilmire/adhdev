import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Isolate all mesh file I/O (MeshRuntimeStore db, ledger, pending-events JSONL) to a
// per-run temp dir so production ~/.adhdev state is never touched.
const testTmpDir = path.join(tmpdir(), `adhdev-mission-close-candidate-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

const meshConfigMocks = vi.hoisted(() => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: meshConfigMocks.getMesh,
    getMeshByRepo: meshConfigMocks.getMeshByRepo,
    listMeshes: meshConfigMocks.listMeshes,
}));

import {
    upsertMeshMission,
    getMeshMission,
    summarizeMissionTasks,
    isMissionAllTasksTerminal,
    maybeEmitMissionCloseCandidate,
} from '../../src/mesh/mesh-missions.js';
import {
    enqueueTask,
    claimNextTask,
    updateTaskStatus,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import {
    getPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function setMesh(meshId: string): void {
    meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'Close Candidate Mesh', policy: {}, nodes: [{ id: 'node-1', workspace: '/repo/a' }] });
}

function closeCandidateEvents(meshId: string) {
    return getPendingMeshCoordinatorEvents(meshId).filter(e => e.event === 'mission_close_candidate');
}

describe('G3 — mission_close_candidate detection', () => {
    const meshId = `close-candidate-mesh-${randomUUID().slice(0, 8)}`;

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        try { __clearMeshPendingEventsForTests(meshId); } catch { /* fresh store */ }
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        __resetMeshRuntimeStoreForTests();
        vi.clearAllMocks();
    });

    it('isMissionAllTasksTerminal: only true with >0 tasks and none pending/assigned', () => {
        expect(isMissionAllTasksTerminal({ total: 0, pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null })).toBe(false);
        expect(isMissionAllTasksTerminal({ total: 2, pending: 1, assigned: 0, completed: 1, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null })).toBe(false);
        expect(isMissionAllTasksTerminal({ total: 2, pending: 0, assigned: 1, completed: 1, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null })).toBe(false);
        expect(isMissionAllTasksTerminal({ total: 2, pending: 0, assigned: 0, completed: 2, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null })).toBe(true);
    });

    it('emits one mission_close_candidate when all tasks become terminal, and is idempotent', () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Close me' });
        const a = enqueueTask(meshId, 'task A', { missionId: mission.id,
    difficulty: 'medium',
});
        const b = enqueueTask(meshId, 'task B', { missionId: mission.id,
    difficulty: 'medium',
});

        // Not all-terminal yet — no emit.
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false);
        expect(closeCandidateEvents(meshId)).toHaveLength(0);

        updateTaskStatus(meshId, a.id, 'completed');
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false); // b still pending
        expect(closeCandidateEvents(meshId)).toHaveLength(0);

        updateTaskStatus(meshId, b.id, 'completed');
        // Now all-terminal → first call emits.
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(true);
        const events = closeCandidateEvents(meshId);
        expect(events).toHaveLength(1);
        expect(events[0].metadataEvent.missionId).toBe(mission.id);
        expect((events[0].metadataEvent.aggregate as any).completed).toBe(2);

        // Marker set → subsequent calls no-op (no per-tick spam).
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false);
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false);
        expect(closeCandidateEvents(meshId)).toHaveLength(1);
        expect(getMeshMission(meshId, mission.id)?.closeCandidateEmittedAt).toBeTruthy();
    });

    it('does NOT auto-transition the mission — status stays active', () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Stay active' });
        const a = enqueueTask(meshId, 'only task', { missionId: mission.id,
    difficulty: 'medium',
});
        updateTaskStatus(meshId, a.id, 'completed');
        maybeEmitMissionCloseCandidate(meshId, mission.id);
        expect(getMeshMission(meshId, mission.id)?.status).toBe('active');
    });

    it('does not emit for a non-active mission', () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Paused', status: 'paused' });
        const a = enqueueTask(meshId, 'task', { missionId: mission.id,
    difficulty: 'medium',
});
        updateTaskStatus(meshId, a.id, 'completed');
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false);
        expect(closeCandidateEvents(meshId)).toHaveLength(0);
    });

    it('does not emit for a mission with zero tasks', () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Empty' });
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false);
        expect(closeCandidateEvents(meshId)).toHaveLength(0);
    });

    it('resets the marker when the mission returns to a non-terminal state, so a re-completion nudges again', () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Re-open' });
        const a = enqueueTask(meshId, 'task A', { missionId: mission.id,
    difficulty: 'medium',
});
        updateTaskStatus(meshId, a.id, 'completed');
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(true);
        expect(getMeshMission(meshId, mission.id)?.closeCandidateEmittedAt).toBeTruthy();

        // A new pending task returns the mission to a non-terminal state → marker cleared.
        const b = enqueueTask(meshId, 'task B', { missionId: mission.id,
    difficulty: 'medium',
});
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(false);
        expect(getMeshMission(meshId, mission.id)?.closeCandidateEmittedAt).toBeFalsy();

        // Re-completing all tasks nudges again (fresh idempotency edge).
        updateTaskStatus(meshId, b.id, 'completed');
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(true);
        // The pending-event dedup fingerprint is time-based for this event, so the second
        // emit is a distinct event; assert at least the marker re-armed.
        expect(getMeshMission(meshId, mission.id)?.closeCandidateEmittedAt).toBeTruthy();
    });

    it('all-terminal via mixed terminal statuses (completed + failed + cancelled)', () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Mixed' });
        const a = enqueueTask(meshId, 'A', { missionId: mission.id,
    difficulty: 'medium',
});
        const b = enqueueTask(meshId, 'B', { missionId: mission.id,
    difficulty: 'medium',
});
        const c = enqueueTask(meshId, 'C', { missionId: mission.id,
    difficulty: 'medium',
});
        updateTaskStatus(meshId, a.id, 'completed');
        updateTaskStatus(meshId, b.id, 'failed');
        updateTaskStatus(meshId, c.id, 'cancelled');
        const agg = summarizeMissionTasks(meshId, mission.id);
        expect(isMissionAllTasksTerminal(agg)).toBe(true);
        expect(maybeEmitMissionCloseCandidate(meshId, mission.id)).toBe(true);
        const ev = closeCandidateEvents(meshId)[0];
        expect((ev.metadataEvent.aggregate as any)).toMatchObject({ total: 3, completed: 1, failed: 1, cancelled: 1 });
    });

    it('queue terminal transition triggers the check via the fire-and-forget path', async () => {
        setMesh(meshId);
        const mission = upsertMeshMission(meshId, { title: 'Via queue' });
        const a = enqueueTask(meshId, 'only task', { missionId: mission.id,
    difficulty: 'medium',
});
        claimNextTask(meshId, 'node-1', 'session-1');
        // Terminal transition through updateTaskStatus schedules the async detection.
        updateTaskStatus(meshId, a.id, 'completed');
        // The detection runs via a dynamic import microtask; flush the microtask queue.
        await new Promise(resolve => setTimeout(resolve, 0));
        const events = closeCandidateEvents(meshId);
        expect(events).toHaveLength(1);
        expect(events[0].metadataEvent.missionId).toBe(mission.id);
    });
});
