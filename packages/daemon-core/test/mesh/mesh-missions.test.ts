import { describe, expect, it, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
    upsertMeshMission,
    getMeshMissions,
    getMeshMission,
    summarizeMissionTasks,
    getActiveMeshMissionSummaries,
    buildMissionPromptSection,
} from '../../src/mesh/mesh-missions.js';
import { enqueueTask, updateTaskStatus, claimNextTask, recordDirectDispatchTask, updateSessionTaskStatus, getQueue, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js';
import { computeMeshMissionStats } from '../../src/mesh/mesh-task-stats.js';
import { appendLedgerEntry } from '../../src/mesh/mesh-ledger.js';
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

function makeMesh(meshId: string): LocalMeshEntry {
    return {
        id: meshId,
        name: 'Mission Test Mesh',
        repoIdentity: 'example/mission-repo',
        policy: {},
        coordinator: {},
        nodes: [{ id: 'node-1', workspace: '/repo/a', userOverrides: {} }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    } as unknown as LocalMeshEntry;
}

describe('M3 — mission persistence', () => {
    const meshId = `mission-mesh-${randomUUID().slice(0, 8)}`;

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        MeshRuntimeStore.resetForTests();
    });

    it('creates, updates, and lists missions', () => {
        const created = upsertMeshMission(meshId, { title: 'Ship feature X', goal: 'All subtasks merged' });
        expect(created.status).toBe('active');
        expect(created.id).toBeTruthy();

        const updated = upsertMeshMission(meshId, { id: created.id, title: 'Ship feature X', status: 'completed' });
        expect(updated.status).toBe('completed');
        // goal preserved when not provided on update
        expect(updated.goal).toBe('All subtasks merged');

        expect(getMeshMission(meshId, created.id)?.status).toBe('completed');
        expect(getMeshMissions(meshId, ['completed'])).toHaveLength(1);
        expect(getMeshMissions(meshId, ['active'])).toHaveLength(0);
    });

    it('rejects empty titles and invalid statuses', () => {
        expect(() => upsertMeshMission(meshId, { title: '  ' })).toThrow(/mission_title_required/);
        expect(() => upsertMeshMission(meshId, { title: 'ok', status: 'bogus' })).toThrow(/invalid_mission_status/);
    });

    it('derives task aggregates from queue state at query time', () => {
        const mission = upsertMeshMission(meshId, { title: 'Aggregate test' });
        const a = enqueueTask(meshId, 'task A', { missionId: mission.id });
        enqueueTask(meshId, 'task B', { missionId: mission.id, dependsOn: [a.id] });
        enqueueTask(meshId, 'unrelated task');

        claimNextTask(meshId, 'node-1', 'session-1');
        updateTaskStatus(meshId, a.id, 'failed'); // blocks B under default policy

        const agg = summarizeMissionTasks(meshId, mission.id);
        expect(agg.total).toBe(2);
        expect(agg.failed).toBe(1);
        expect(agg.pending).toBe(1);
        expect(agg.blocked).toBe(1);
        expect(agg.lastActivityAt).toBeTruthy();
    });

    it('attributes a mission_id direct dispatch to mission aggregates and reflects completion', () => {
        const mission = upsertMeshMission(meshId, { title: 'Direct dispatch mission' });
        const taskId = randomUUID();
        const dispatchedAt = new Date().toISOString();

        const entry = recordDirectDispatchTask(meshId, 'direct task', {
            id: taskId,
            missionId: mission.id,
            assignedNodeId: 'node-1',
            assignedSessionId: 'session-direct',
            dispatchedAt,
        });
        expect(entry).not.toBeNull();
        expect(entry!.status).toBe('assigned');
        expect(entry!.missionId).toBe(mission.id);
        expect(entry!.assignedSessionId).toBe('session-direct');

        // +1 to the mission task aggregate while assigned.
        const assignedAgg = summarizeMissionTasks(meshId, mission.id);
        expect(assignedAgg.total).toBe(1);
        expect(assignedAgg.assigned).toBe(1);
        expect(assignedAgg.completed).toBe(0);

        // The terminal completion path (same as enqueued tasks) flips it by session.
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-1',
            sessionId: 'session-direct',
            payload: { source: 'direct', via: 'local_direct', taskId, message: 'direct task' },
        });
        const completed = updateSessionTaskStatus(meshId, 'session-direct', 'completed');
        expect(completed?.id).toBe(taskId);
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-1',
            sessionId: 'session-direct',
            payload: { taskId, finalSummary: 'done' },
        });

        const completedAgg = summarizeMissionTasks(meshId, mission.id);
        expect(completedAgg.total).toBe(1);
        expect(completedAgg.completed).toBe(1);
        expect(completedAgg.assigned).toBe(0);

        const stats = computeMeshMissionStats(meshId, mission.id);
        expect(stats.taskCount).toBe(1);
        expect(stats.completed).toBe(1);
    });

    it('leaves a direct dispatch with no mission_id unattributed (backward compatible)', () => {
        const mission = upsertMeshMission(meshId, { title: 'Unattributed control' });

        // No mission_id → helper is a no-op and creates no queue entry.
        const skipped = recordDirectDispatchTask(meshId, 'untracked task', {
            id: randomUUID(),
            missionId: '   ',
            assignedNodeId: 'node-1',
            assignedSessionId: 'session-x',
        });
        expect(skipped).toBeNull();

        expect(getQueue(meshId)).toHaveLength(0);
        const agg = summarizeMissionTasks(meshId, mission.id);
        expect(agg.total).toBe(0);
        expect(computeMeshMissionStats(meshId, mission.id).taskCount).toBe(0);
    });

    it('injects the active mission summary into the coordinator prompt', () => {
        const mission = upsertMeshMission(meshId, { title: 'Nightly refactor', goal: 'Split the monolith' });
        const a = enqueueTask(meshId, 'step 1', { missionId: mission.id });
        enqueueTask(meshId, 'step 2', { missionId: mission.id, dependsOn: [a.id] });
        enqueueTask(meshId, 'step 3', { missionId: mission.id, dependsOn: [a.id] });

        const section = buildMissionPromptSection(meshId);
        expect(section).toContain('Active Mission');
        expect(section).toContain('Nightly refactor');
        expect(section).toContain('Split the monolith');
        expect(section).toContain('3 total');
        expect(section).toContain('Do not re-enqueue');

        const prompt = buildCoordinatorSystemPrompt({ mesh: makeMesh(meshId), missionSection: section });
        expect(prompt).toContain('Nightly refactor');
        expect(prompt).toContain('Split the monolith');
    });

    it('prompt without a mission is identical to the pre-M3 output (no regression)', () => {
        const mesh = makeMesh(meshId);
        const withoutMission = buildCoordinatorSystemPrompt({ mesh });
        const withEmptySection = buildCoordinatorSystemPrompt({ mesh, missionSection: '' });
        expect(withEmptySection).toBe(withoutMission);
        expect(buildMissionPromptSection(meshId)).toBe('');
        expect(getActiveMeshMissionSummaries(meshId)).toHaveLength(0);
    });

    it('{{mission}} placeholder expands in override templates', () => {
        upsertMeshMission(meshId, { title: 'Override mission' });
        const mesh = makeMesh(meshId);
        (mesh as any).coordinator = { systemPromptOverride: 'CUSTOM PROMPT\n{{mission}}\nEND' };
        const prompt = buildCoordinatorSystemPrompt({
            mesh,
            missionSection: buildMissionPromptSection(meshId),
        });
        expect(prompt).toContain('CUSTOM PROMPT');
        expect(prompt).toContain('Override mission');
    });
});
