import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-mesh-task-graph-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    enqueueTaskGraph,
    MESH_TASK_GRAPH_MAX_TASKS,
    claimNextTask,
    getQueue,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';

// G5: atomic task-graph enqueue. The batch is all-or-nothing (one better-sqlite3
// transaction; per-entry enqueueTask calls nest as savepoints), refs resolve to
// pre-generated ids regardless of array order, and the resulting rows flow through
// the UNCHANGED dependency gate (taskDependenciesSatisfied) at claim time.

describe('enqueueTaskGraph (G5 atomic batch)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    function nextMeshId(): string {
        return `mesh_graph_${randomUUID().slice(0, 8)}`;
    }

    it('resolves refs to generated ids, forward references included (array order irrelevant)', () => {
        const meshId = nextMeshId();
        // Deliberately scrambled: the first entry depends on refs defined LATER.
        const tasks = enqueueTaskGraph(meshId, [
            { ref: 'verify', message: 'verify the fix', dependsOn: ['fix'], difficulty: 'easy' },
            { ref: 'fix', message: 'apply the fix', dependsOn: ['investigate'], difficulty: 'easy' },
            { ref: 'investigate', message: 'find the bug', difficulty: 'easy' },
        ]);

        expect(tasks).toHaveLength(3);
        const [verify, fix, investigate] = tasks;
        expect(verify.dependsOn).toEqual([fix.id]);
        expect(fix.dependsOn).toEqual([investigate.id]);
        expect(investigate.dependsOn).toBeUndefined();
        expect(new Set(tasks.map(t => t.id)).size).toBe(3);
        expect(tasks.every(t => t.status === 'pending')).toBe(true);
        expect(getQueue(meshId)).toHaveLength(3);
    });

    it('accepts an EXISTING queue task id as a dependency alongside batch refs', () => {
        const meshId = nextMeshId();
        const existing = enqueueTask(meshId, 'pre-existing prerequisite', { difficulty: 'easy' });

        const tasks = enqueueTaskGraph(meshId, [
            { ref: 'a', message: 'root of batch', difficulty: 'easy' },
            { message: 'depends on both worlds', dependsOn: ['a', existing.id], difficulty: 'easy' },
        ]);

        expect(tasks[1].dependsOn).toEqual([tasks[0].id, existing.id]);
    });

    it('is ATOMIC: an unknown dependency in a later entry rolls back already-inserted entries', () => {
        const meshId = nextMeshId();
        expect(() => enqueueTaskGraph(meshId, [
            { ref: 'ok', message: 'valid first entry', difficulty: 'easy' },
            { message: 'broken second entry', dependsOn: ['no-such-ref'], difficulty: 'easy' },
        ])).toThrow(/unknown_dependency/);
        // The valid first entry must NOT survive — that partial state is exactly what G5 closes.
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('is ATOMIC: an invalid difficulty in a later entry rolls back the whole batch', () => {
        const meshId = nextMeshId();
        expect(() => enqueueTaskGraph(meshId, [
            { ref: 'ok', message: 'valid first entry', difficulty: 'easy' },
            { message: 'typo difficulty', difficulty: 'medum' },
        ])).toThrow(/invalid_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects an intra-batch dependency cycle and inserts nothing', () => {
        const meshId = nextMeshId();
        expect(() => enqueueTaskGraph(meshId, [
            { ref: 'a', message: 'a depends on b', dependsOn: ['b'], difficulty: 'easy' },
            { ref: 'b', message: 'b depends on a', dependsOn: ['a'], difficulty: 'easy' },
        ])).toThrow(/dependency_cycle_detected/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects a duplicate ref', () => {
        const meshId = nextMeshId();
        expect(() => enqueueTaskGraph(meshId, [
            { ref: 'same', message: 'first', difficulty: 'easy' },
            { ref: 'same', message: 'second', difficulty: 'easy' },
        ])).toThrow(/duplicate_task_ref/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects an empty batch and an over-cap batch', () => {
        const meshId = nextMeshId();
        expect(() => enqueueTaskGraph(meshId, [])).toThrow(/empty_task_graph/);
        const tooMany = Array.from({ length: MESH_TASK_GRAPH_MAX_TASKS + 1 }, (_, i) => ({
            message: `task ${i}`, difficulty: 'easy' as const,
        }));
        expect(() => enqueueTaskGraph(meshId, tooMany)).toThrow(/task_graph_too_large/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('claim order honors the graph: only the root is claimable until its dependents unlock', () => {
        const meshId = nextMeshId();
        const [root, dependent] = enqueueTaskGraph(meshId, [
            { ref: 'root', message: 'root task', difficulty: 'easy' },
            { ref: 'child', message: 'dependent task', dependsOn: ['root'], difficulty: 'easy' },
        ]);

        // First claim (node A) must take the root — the dependent is dependency-gated.
        const first = claimNextTask(meshId, 'node_a', 'session_a');
        expect(first?.id).toBe(root.id);
        // A different node still cannot claim the dependent while the root is unfinished.
        expect(claimNextTask(meshId, 'node_b', 'session_b')).toBeNull();

        updateTaskStatus(meshId, root.id, 'completed');
        const second = claimNextTask(meshId, 'node_b', 'session_b');
        expect(second?.id).toBe(dependent.id);
    });
});
