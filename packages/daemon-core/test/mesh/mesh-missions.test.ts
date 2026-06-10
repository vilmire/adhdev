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
import { enqueueTask, updateTaskStatus, claimNextTask, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js';
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
