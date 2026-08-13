/**
 * DIFFICULTY-REQUIRED — difficulty is mandatory at every task-insertion boundary.
 *
 * Background: `difficulty` was optional and, worse, silently forgiving. A task enqueued
 * without it routed with no difficulty→slot matching, and a task enqueued with a TYPO
 * ('medum') behaved identically to one with no difficulty at all — isMeshTaskDifficulty()
 * returned false and the value was dropped to undefined with no error and no warning. Both
 * failures were invisible: the task enqueued "successfully" and then routed as though the
 * coordinator had never expressed a preference.
 *
 * Four things are pinned here, matching the four implementation stages:
 *
 *  1. CONDUIT — the difficulty a caller supplies actually reaches the stored task, on BOTH
 *     insertion paths.
 *  2. MAGI — the fan-out stamps a fixed 'freeform' sentinel rather than being exempted
 *     from the guard (see the rationale comment at that call site).
 *  3. RELAUNCH INHERITANCE — failure recovery re-enqueues with the difficulty the failed
 *     task ran with, recovered from the ledger; and, critically, still relaunches when no
 *     difficulty can be inherited. This path only runs because something already broke, so
 *     losing the relaunch would be strictly worse than losing the hint.
 *  4. GUARD — both enqueueTask AND recordDirectDispatchTask reject a missing difficulty.
 *     recordDirectDispatchTask writes to the store WITHOUT going through enqueueTask, so a
 *     guard in only one of them would be trivially bypassable via mesh_send_task.
 *
 * Plus the typo case, which is the reason a bad value is rejected as loudly as a missing one.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-difficulty-required-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    enqueueTask,
    recordDirectDispatchTask,
    getQueue,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { appendLedgerEntry, getSessionRecoveryContext } from '../../src/mesh/mesh-ledger.js';
import { createMesh } from '../../src/config/mesh-config.js';
import { MESH_TASK_DIFFICULTIES } from '@adhdev/mesh-shared';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

function freshMesh(): string {
    return createMesh({ name: 'diff-mesh', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
}

// ─── Stage 4: the guard, on BOTH insertion paths ──────────────────────────────

describe('DIFFICULTY-REQUIRED — enqueueTask guard', () => {
    it('rejects a task with no difficulty', () => {
        const meshId = freshMesh();
        expect(() => enqueueTask(meshId, 'do work', {}))
            .toThrow(/missing_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects a task whose opts object is omitted entirely', () => {
        const meshId = freshMesh();
        expect(() => (enqueueTask as any)(meshId, 'do work'))
            .toThrow(/missing_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects blank-string and null difficulty as missing, not as a value', () => {
        const meshId = freshMesh();
        expect(() => enqueueTask(meshId, 'do work', { difficulty: '' }))
            .toThrow(/missing_task_difficulty/);
        expect(() => enqueueTask(meshId, 'do work', { difficulty: '   ' }))
            .toThrow(/missing_task_difficulty/);
        expect(() => enqueueTask(meshId, 'do work', { difficulty: null as any }))
            .toThrow(/missing_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('names the field and enumerates allowed values so a caller can self-correct', () => {
        const meshId = freshMesh();
        try {
            enqueueTask(meshId, 'do work', {});
            expect.unreachable('should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('difficulty');
            for (const d of MESH_TASK_DIFFICULTIES) expect(e.message).toContain(d);
        }
    });

    it('accepts every value on the fixed axis and persists it verbatim', () => {
        for (const difficulty of MESH_TASK_DIFFICULTIES) {
            const meshId = freshMesh();
            const task = enqueueTask(meshId, `task ${difficulty}`, { difficulty });
            expect(task.difficulty).toBe(difficulty);
            // ...and it survives the store round-trip, not just the returned object.
            expect(getQueue(meshId)[0].difficulty).toBe(difficulty);
        }
    });
});

describe('DIFFICULTY-REQUIRED — recordDirectDispatchTask guard (the bypass path)', () => {
    // recordDirectDispatchTask does NOT call enqueueTask — it inserts into the store
    // directly. Guarding only enqueueTask would leave mesh_send_task as an open door.
    const dispatchOpts = {
        id: 'task_direct_1',
        assignedNodeId: 'node_a',
        assignedSessionId: 'sess_a',
    };

    it('rejects a direct dispatch with no difficulty', () => {
        const meshId = freshMesh();
        expect(() => recordDirectDispatchTask(meshId, 'direct work', { ...dispatchOpts }))
            .toThrow(/missing_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects an unrecognized difficulty on the direct path too', () => {
        const meshId = freshMesh();
        expect(() => recordDirectDispatchTask(meshId, 'direct work', { ...dispatchOpts, difficulty: 'medum' }))
            .toThrow(/invalid_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('persists the difficulty on the materialised assigned row', () => {
        const meshId = freshMesh();
        const entry = recordDirectDispatchTask(meshId, 'direct work', { ...dispatchOpts, difficulty: 'difficult' });
        expect(entry?.difficulty).toBe('difficult');
        expect(getQueue(meshId)[0].difficulty).toBe('difficult');
        // The direct path materialises an already-ASSIGNED row, not a pending one.
        expect(getQueue(meshId)[0].status).toBe('assigned');
    });

    it('the guard names recordDirectDispatchTask, so the error points at the real caller', () => {
        const meshId = freshMesh();
        expect(() => recordDirectDispatchTask(meshId, 'direct work', { ...dispatchOpts }))
            .toThrow(/recordDirectDispatchTask/);
    });
});

// ─── Side task: typo rejection ────────────────────────────────────────────────

describe('DIFFICULTY-REQUIRED — unrecognized values are rejected, never dropped', () => {
    it('rejects a near-miss typo instead of silently enqueuing an unclassified task', () => {
        const meshId = freshMesh();
        // 'medum' was the motivating case: it used to enqueue fine and route as if the
        // caller had said nothing at all.
        expect(() => enqueueTask(meshId, 'work', { difficulty: 'medum' }))
            .toThrow(/invalid_task_difficulty/);
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects plausible-but-wrong values that are not on the axis', () => {
        const meshId = freshMesh();
        for (const bad of ['hard', 'easy ', 'EASY', 'trivial', 'normal']) {
            expect(() => enqueueTask(meshId, 'work', { difficulty: bad }))
                .toThrow(/invalid_task_difficulty/);
        }
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('rejects non-string values without coercing them', () => {
        const meshId = freshMesh();
        for (const bad of [3, true, {}, []]) {
            expect(() => enqueueTask(meshId, 'work', { difficulty: bad as any }))
                .toThrow(/invalid_task_difficulty/);
        }
        expect(getQueue(meshId)).toHaveLength(0);
    });

    it('the invalid-value error quotes the offending value AND the allowed set', () => {
        const meshId = freshMesh();
        try {
            enqueueTask(meshId, 'work', { difficulty: 'medum' });
            expect.unreachable('should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('medum');
            for (const d of MESH_TASK_DIFFICULTIES) expect(e.message).toContain(d);
        }
    });
});

// ─── Stage 3: relaunch inheritance ────────────────────────────────────────────

describe('DIFFICULTY-REQUIRED — recovery relaunch inherits difficulty from the ledger', () => {
    // The recovery relaunch re-enqueues a task the coordinator already classified. Rather
    // than re-guess, it reads the classification back off the task_dispatched entry that
    // recordTaskDispatchedLedger wrote (payload.routingDecision.resolvedDifficulty) — the
    // same entry lastTaskMessage already came from. Before this, resolvedDifficulty was
    // written to the ledger but nothing ever read it back.
    function seedDispatch(meshId: string, opts: { difficulty?: string; nodeId: string; sessionId: string }) {
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: opts.nodeId,
            sessionId: opts.sessionId,
            payload: {
                taskId: 'task_x',
                message: 'the original task message',
                routingDecision: {
                    source: 'queue',
                    selectedNodeId: opts.nodeId,
                    ...(opts.difficulty ? { resolvedDifficulty: opts.difficulty } : {}),
                },
            },
        });
    }

    it('recovers the difficulty the failed task ran with', () => {
        const meshId = freshMesh();
        seedDispatch(meshId, { difficulty: 'difficult', nodeId: 'node_a', sessionId: 'sess_a' });
        const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_a', nodeId: 'node_a' });
        expect(ctx.lastTaskDifficulty).toBe('difficult');
        // The message the relaunch re-enqueues still resolves too — same entry.
        expect(ctx.lastTaskMessage).toBe('the original task message');
    });

    it('recovers every value on the axis, not just one', () => {
        for (const difficulty of MESH_TASK_DIFFICULTIES) {
            const meshId = freshMesh();
            seedDispatch(meshId, { difficulty, nodeId: 'node_a', sessionId: 'sess_a' });
            const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_a', nodeId: 'node_a' });
            expect(ctx.lastTaskDifficulty).toBe(difficulty);
        }
    });

    it('yields null — not a throw — for a LEGACY dispatch entry with no resolvedDifficulty', () => {
        // Entries written before resolvedDifficulty existed must not break recovery.
        const meshId = freshMesh();
        seedDispatch(meshId, { nodeId: 'node_a', sessionId: 'sess_a' });
        const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_a', nodeId: 'node_a' });
        expect(ctx.lastTaskDifficulty).toBeNull();
        // The message is still recovered, so the relaunch still has something to send.
        expect(ctx.lastTaskMessage).toBe('the original task message');
    });

    it('yields null for a CORRUPT/unrecognized resolvedDifficulty rather than propagating it', () => {
        // A stale value no longer on the axis must not be re-enqueued — it would only
        // throw at the guard downstream. Degrade to null and let the caller fall back.
        const meshId = freshMesh();
        seedDispatch(meshId, { difficulty: 'medum', nodeId: 'node_a', sessionId: 'sess_a' });
        const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_a', nodeId: 'node_a' });
        expect(ctx.lastTaskDifficulty).toBeNull();
    });

    it('yields null when there is no dispatch entry at all', () => {
        const meshId = freshMesh();
        const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_none', nodeId: 'node_none' });
        expect(ctx.lastTaskDifficulty).toBeNull();
        expect(ctx.lastTaskMessage).toBeNull();
    });

    it('★ the relaunch still succeeds when nothing can be inherited (fallback, not failure)', () => {
        // This is the load-bearing case. The relaunch path runs ONLY because something
        // already failed; making it throw over a missing difficulty would convert a
        // recoverable failure into a lost task. The call site falls back to 'freeform'.
        const meshId = freshMesh();
        seedDispatch(meshId, { nodeId: 'node_a', sessionId: 'sess_a' });
        const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_a', nodeId: 'node_a' });
        expect(ctx.lastTaskDifficulty).toBeNull();

        // Mirror of the relaunch call site in mesh-event-forwarding.ts.
        const inherited = ctx.lastTaskDifficulty ?? 'freeform';
        const task = enqueueTask(meshId, ctx.lastTaskMessage!, {
            targetNodeId: 'node_a',
            difficulty: inherited,
        });
        expect(task.difficulty).toBe('freeform');
        expect(task.status).toBe('pending');
    });

    it('★ an inheritable difficulty is carried onto the relaunched task, not reset', () => {
        const meshId = freshMesh();
        seedDispatch(meshId, { difficulty: 'difficult', nodeId: 'node_a', sessionId: 'sess_a' });
        const ctx = getSessionRecoveryContext(meshId, { sessionId: 'sess_a', nodeId: 'node_a' });

        const inherited = ctx.lastTaskDifficulty ?? 'freeform';
        const task = enqueueTask(meshId, ctx.lastTaskMessage!, {
            targetNodeId: 'node_a',
            difficulty: inherited,
        });
        // The whole point: a 'difficult' task that failed relaunches as 'difficult',
        // not silently downgraded to unclassified routing.
        expect(task.difficulty).toBe('difficult');
    });
});
