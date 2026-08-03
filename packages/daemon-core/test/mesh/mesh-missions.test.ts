import { describe, expect, it, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
    upsertMeshMission,
    getMeshMissions,
    getMeshMission,
    summarizeMissionTasks,
    getActiveMeshMissionSummaries,
    getMeshStatusMissionSummaries,
    listMeshMissionSummaries,
    buildMissionPromptSection,
    GOAL_PREVIEW_MAX,
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

    it('leaves a direct dispatch with no mission_id unattributed (but still tracked)', () => {
        const mission = upsertMeshMission(meshId, { title: 'Unattributed control' });

        // MISSIONLESS-DIRECT-DISPATCH-NO-ATTEMPT: a missing mission_id means
        // "not attributable to a mission" — nothing more. The entry IS created, so the
        // dispatch still gets a turn attempt and a confirmed delivery record. It
        // previously returned null here, which silently cost mission-less dispatches
        // their terminal-state convergence and their redrive protection.
        const entry = recordDirectDispatchTask(meshId, 'untracked task', {
            id: randomUUID(),
            missionId: '   ',
            assignedNodeId: 'node-1',
            assignedSessionId: 'session-x',
        });
        expect(entry).not.toBeNull();
        expect(entry!.missionId).toBeUndefined();

        // The point of this test is unchanged: it must not be attributed to any mission.
        expect(getQueue(meshId)).toHaveLength(1);
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

describe('getMeshStatusMissionSummaries — compact (default) elides full goal text', () => {
    const meshId = `mission-slim-${randomUUID().slice(0, 8)}`;
    const longGoal = 'G'.repeat(GOAL_PREVIEW_MAX + 200);

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        MeshRuntimeStore.resetForTests();
    });

    it('compact (default) drops the full goal, keeps a capped preview + truncated flag', () => {
        const created = upsertMeshMission(meshId, { title: 'Slim mission', goal: longGoal });

        const compact = getMeshStatusMissionSummaries(meshId) as any[];
        expect(compact).toHaveLength(1);
        const m = compact[0];
        // Full goal text is NOT in the compact payload.
        expect(m).not.toHaveProperty('goal');
        expect(m.goalPreview).toHaveLength(GOAL_PREVIEW_MAX);
        expect(m.goalTruncated).toBe(true);
        // Identity/aggregate fields are still present.
        expect(m.id).toBe(created.id);
        expect(m.title).toBe('Slim mission');
        expect(m.status).toBe('active');
        expect(m.createdAt).toBeTruthy();
        expect(m.updatedAt).toBeTruthy();
        expect(m.tasks).toBeDefined();
    });

    it('verbose=true includes the full goal text and no preview fields', () => {
        upsertMeshMission(meshId, { title: 'Slim mission', goal: longGoal });

        const verbose = getMeshStatusMissionSummaries(meshId, { verbose: true }) as any[];
        expect(verbose).toHaveLength(1);
        const m = verbose[0];
        expect(m.goal).toBe(longGoal);
        expect(m).not.toHaveProperty('goalPreview');
        expect(m).not.toHaveProperty('goalTruncated');
    });

    it('short goals are returned whole in compact mode with truncated:false', () => {
        upsertMeshMission(meshId, { title: 'Short goal mission', goal: 'tiny goal' });

        const compact = getMeshStatusMissionSummaries(meshId) as any[];
        const m = compact[0];
        expect(m.goalPreview).toBe('tiny goal');
        expect(m.goalTruncated).toBe(false);
        expect(m).not.toHaveProperty('goal');
    });

    it('does not mutate the stored goal — the record keeps the full text', () => {
        const created = upsertMeshMission(meshId, { title: 'Persist goal', goal: longGoal });
        // Read the compact projection, then confirm storage is untouched.
        getMeshStatusMissionSummaries(meshId);
        expect(getMeshMission(meshId, created.id)?.goal).toBe(longGoal);
    });
});

describe('getMeshStatusMissionSummaries — withStats merges operational rollups', () => {
    const meshId = `mission-stats-${randomUUID().slice(0, 8)}`;

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        MeshRuntimeStore.resetForTests();
    });

    function dispatchAndComplete(taskId: string, dispatchedAt: string, terminalAt: string) {
        const store = MeshRuntimeStore.getInstance();
        store.appendLedgerEntry({
            id: randomUUID(), meshId, timestamp: dispatchedAt, kind: 'task_dispatched',
            sessionId: 'session-1', payload: { taskId, source: 'queue' },
        });
        store.appendLedgerEntry({
            id: randomUUID(), meshId, timestamp: terminalAt, kind: 'task_completed',
            sessionId: 'session-1', payload: { taskId },
        });
    }

    it('omits stats by default; includes the rollup when withStats:true', () => {
        const mission = upsertMeshMission(meshId, { title: 'Stats mission', goal: 'do work' });
        const a = enqueueTask(meshId, 'task A', { missionId: mission.id });
        updateTaskStatus(meshId, a.id, 'completed');
        dispatchAndComplete(a.id, '2026-06-17T10:00:00.000Z', '2026-06-17T10:00:30.000Z');

        const withoutStats = getMeshStatusMissionSummaries(meshId) as any[];
        expect(withoutStats[0]).not.toHaveProperty('stats');

        const withStats = getMeshStatusMissionSummaries(meshId, { withStats: true }) as any[];
        expect(withStats[0].stats).toBeDefined();
        const stats = withStats[0].stats;
        expect(stats.missionId).toBe(mission.id);
        expect(stats.taskCount).toBe(1);
        expect(stats.completed).toBe(1);
        // 30s dispatched → terminal window.
        expect(stats.totalDurationMs).toBe(30_000);
        expect(stats.wallClockMs).toBe(30_000);
        expect(Array.isArray(stats.incompleteTaskIds)).toBe(true);
    });

    it('matches computeMeshMissionStats and survives the slim (compact) projection', () => {
        const mission = upsertMeshMission(meshId, { title: 'Compact stats', goal: 'G'.repeat(GOAL_PREVIEW_MAX + 50) });
        const a = enqueueTask(meshId, 'task A', { missionId: mission.id });
        updateTaskStatus(meshId, a.id, 'completed');
        dispatchAndComplete(a.id, '2026-06-17T10:00:00.000Z', '2026-06-17T10:00:10.000Z');

        const direct = computeMeshMissionStats(meshId, mission.id);
        const slim = getMeshStatusMissionSummaries(meshId, { withStats: true }) as any[];
        // Compact projection still carries stats alongside goalPreview/goalTruncated.
        expect(slim[0]).not.toHaveProperty('goal');
        expect(slim[0].goalTruncated).toBe(true);
        expect(slim[0].stats).toEqual(direct);
    });
});

describe('mission visibility — paused missions are surfaced (not active-only)', () => {
    const meshId = `mission-visible-${randomUUID().slice(0, 8)}`;

    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
        MeshRuntimeStore.resetForTests();
    });

    it('getMeshStatusMissionSummaries surfaces paused missions, getActiveMeshMissionSummaries hides them (the bug)', () => {
        upsertMeshMission(meshId, { title: 'Active one' });
        const paused = upsertMeshMission(meshId, { title: 'Paused one' });
        upsertMeshMission(meshId, { id: paused.id, title: 'Paused one', status: 'paused' });

        // Active-only view hides the paused mission — the original bug.
        const activeOnly = getActiveMeshMissionSummaries(meshId);
        expect(activeOnly.map(m => m.status)).toEqual(['active']);

        // Status view includes both active and paused.
        const live = getMeshStatusMissionSummaries(meshId) as any[];
        const statuses = live.map(m => m.status).sort();
        expect(statuses).toEqual(['active', 'paused']);
        const pausedSummary = live.find(m => m.status === 'paused');
        // Minimal identity + aggregates retained even in compact mode.
        expect(pausedSummary.id).toBe(paused.id);
        expect(pausedSummary.title).toBe('Paused one');
        expect(pausedSummary.tasks).toBeDefined();
    });

    it('listMeshMissionSummaries returns every status by default and filters when asked', () => {
        upsertMeshMission(meshId, { title: 'A', status: 'active' });
        const p = upsertMeshMission(meshId, { title: 'P' });
        upsertMeshMission(meshId, { id: p.id, title: 'P', status: 'paused' });
        const done = upsertMeshMission(meshId, { title: 'D' });
        upsertMeshMission(meshId, { id: done.id, title: 'D', status: 'completed' });

        const all = listMeshMissionSummaries(meshId) as any[];
        expect(all.map(m => m.status).sort()).toEqual(['active', 'completed', 'paused']);

        const onlyPaused = listMeshMissionSummaries(meshId, { statuses: ['paused'] }) as any[];
        expect(onlyPaused).toHaveLength(1);
        expect(onlyPaused[0].title).toBe('P');
        // compact by default — goal elided to preview fields.
        expect(onlyPaused[0]).not.toHaveProperty('goal');
        expect(onlyPaused[0]).toHaveProperty('goalPreview');

        const verbose = listMeshMissionSummaries(meshId, { statuses: ['paused'], verbose: true }) as any[];
        expect(verbose[0]).toHaveProperty('goal');
        expect(verbose[0]).not.toHaveProperty('goalPreview');
    });
});
