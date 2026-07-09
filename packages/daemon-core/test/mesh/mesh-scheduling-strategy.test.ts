import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-sched-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { __orderEligibleNodesForTests } from '../../src/mesh/mesh-events-coordinator.js';
import type { RepoMeshSchedulingStrategy } from '../../src/repo-mesh-types.js';

// Build the RankableNode list the scheduler orders. `index` is the original
// config/array position (the deterministic input order); `priority` and `loaded`
// drive the PRIORITY and least-loaded stages.
function nodes(
    specs: Array<{ id: string; priority?: number }>,
): Array<{ nodeId: string; node: any; index: number }> {
    return specs.map((s, index) => ({
        nodeId: s.id,
        index,
        node: { id: s.id, policy: { schedulingPriority: s.priority } },
    }));
}

// Assign N write tasks to a node so nodeActiveAssignmentCount reflects load.
function loadNode(db: MeshRuntimeStore, meshId: string, nodeId: string, count: number) {
    const now = new Date().toISOString();
    for (let i = 0; i < count; i++) {
        db.insertQueueEntry({
            id: `${meshId}-${nodeId}-${i}-${randomUUID().slice(0, 6)}`,
            meshId, message: 'work', status: 'assigned', taskMode: 'code_change',
            assignedNodeId: nodeId, assignedSessionId: `sess-${nodeId}-${i}`,
            createdAt: now, updatedAt: now,
        } as any);
    }
}

const order = (
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    specs: Array<{ id: string; priority?: number }>,
    opts?: { bumpCursor?: boolean },
): string[] => __orderEligibleNodesForTests(meshId, strategy, nodes(specs), opts).map(n => n.nodeId);

describe('mesh scheduling pipeline — orderEligibleNodes', () => {
    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('first_eligible returns input order verbatim, ignoring load and priority (strict no-change)', () => {
        const meshId = `m-fe-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        // a is heavily loaded and low priority; first_eligible must still try it first.
        loadNode(db, meshId, 'a', 5);
        const result = order(meshId, 'first_eligible', [
            { id: 'a', priority: -10 },
            { id: 'b', priority: 100 },
            { id: 'c' },
        ]);
        expect(result).toEqual(['a', 'b', 'c']);
        __clearMeshQueueForTests(meshId);
    });

    it('least_loaded prefers the node with the fewest active assignments', () => {
        const meshId = `m-ll-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        loadNode(db, meshId, 'a', 3);
        loadNode(db, meshId, 'b', 1);
        // c has 0 load
        const result = order(meshId, 'least_loaded', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        expect(result).toEqual(['c', 'b', 'a']);
        __clearMeshQueueForTests(meshId);
    });

    it('priority_only ranks by schedulingPriority desc, ignoring load', () => {
        const meshId = `m-po-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        // high-priority node is also the most loaded — priority_only still puts it first.
        loadNode(db, meshId, 'hi', 9);
        const result = order(meshId, 'priority_only', [
            { id: 'lo', priority: 1 },
            { id: 'hi', priority: 50 },
            { id: 'mid', priority: 10 },
        ]);
        expect(result).toEqual(['hi', 'mid', 'lo']);
        __clearMeshQueueForTests(meshId);
    });

    it('least_loaded uses priority as the primary key, then load', () => {
        const meshId = `m-llp-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        // b has higher priority but more load; priority wins first, load breaks ties.
        loadNode(db, meshId, 'b', 4);
        const result = order(meshId, 'least_loaded', [
            { id: 'a', priority: 0 },
            { id: 'b', priority: 5 },
        ]);
        expect(result).toEqual(['b', 'a']);
        __clearMeshQueueForTests(meshId);
    });

    it('round_robin rotates the tie-break winner across passes (equal priority + load)', () => {
        const meshId = `m-rr-${randomUUID().slice(0, 8)}`;
        // All three nodes are equal (priority 0, load 0). Each bumped pass should
        // rotate which node sorts first.
        const specs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const p1 = order(meshId, 'round_robin', specs, { bumpCursor: true });
        const p2 = order(meshId, 'round_robin', specs, { bumpCursor: true });
        const p3 = order(meshId, 'round_robin', specs, { bumpCursor: true });
        const p4 = order(meshId, 'round_robin', specs, { bumpCursor: true });
        // Cursor starts at 0 → first pass keeps input order, then rotates each pass.
        expect(p1).toEqual(['a', 'b', 'c']);
        expect(p2).toEqual(['b', 'c', 'a']);
        expect(p3).toEqual(['c', 'a', 'b']);
        expect(p4).toEqual(['a', 'b', 'c']); // wrapped back
        __clearMeshQueueForTests(meshId);
    });

    it('least_loaded (the spread mode) absorbs round_robin rotation among equal ties', () => {
        const meshId = `m-llrr-${randomUUID().slice(0, 8)}`;
        // All three nodes equal (priority 0, load 0) — Spread must rotate the tie-break
        // winner across bumped passes exactly like the legacy round_robin strategy, so a
        // single 'spread' mode subsumes both former load-spreading strategies.
        const specs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const p1 = order(meshId, 'least_loaded', specs, { bumpCursor: true });
        const p2 = order(meshId, 'least_loaded', specs, { bumpCursor: true });
        const p3 = order(meshId, 'least_loaded', specs, { bumpCursor: true });
        expect(p1).toEqual(['a', 'b', 'c']);
        expect(p2).toEqual(['b', 'c', 'a']);
        expect(p3).toEqual(['c', 'a', 'b']);
        __clearMeshQueueForTests(meshId);
    });

    it('least_loaded still ranks load before rotating ties', () => {
        const meshId = `m-llrr2-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        loadNode(db, meshId, 'a', 2); // a is busy → always last regardless of rotation
        const specs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const p1 = order(meshId, 'least_loaded', specs, { bumpCursor: true });
        expect(p1[2]).toBe('a');
        __clearMeshQueueForTests(meshId);
    });

    it('round_robin does NOT rotate within a single pass (no bump)', () => {
        const meshId = `m-rr2-${randomUUID().slice(0, 8)}`;
        const specs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        // No bump: repeated reads at the same cursor give the same order.
        const a = order(meshId, 'round_robin', specs, { bumpCursor: false });
        const b = order(meshId, 'round_robin', specs, { bumpCursor: false });
        expect(a).toEqual(b);
        __clearMeshQueueForTests(meshId);
    });

    it('round_robin still respects load before rotating ties', () => {
        const meshId = `m-rr3-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        loadNode(db, meshId, 'a', 2); // a is busy
        // b and c are empty and tied — rotation only applies between them; a is last.
        const specs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const p1 = order(meshId, 'round_robin', specs, { bumpCursor: true });
        expect(p1[2]).toBe('a'); // most-loaded node always ranks last
        __clearMeshQueueForTests(meshId);
    });

    it('single-node input is returned as-is for every strategy (no cursor work)', () => {
        const meshId = `m-single-${randomUUID().slice(0, 8)}`;
        for (const s of ['first_eligible', 'least_loaded', 'round_robin', 'priority_only'] as const) {
            expect(order(meshId, s, [{ id: 'only' }], { bumpCursor: true })).toEqual(['only']);
        }
        __clearMeshQueueForTests(meshId);
    });
});

describe('MeshRuntimeStore — round-robin cursor', () => {
    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('starts at 0 and bump returns the pre-bump value while advancing the stored value', () => {
        const meshId = `m-cursor-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        expect(db.getSchedulerCursor(meshId)).toBe(0);
        expect(db.bumpSchedulerCursor(meshId)).toBe(0);
        expect(db.getSchedulerCursor(meshId)).toBe(1);
        expect(db.bumpSchedulerCursor(meshId)).toBe(1);
        expect(db.getSchedulerCursor(meshId)).toBe(2);
    });

    it('cursors are independent per mesh', () => {
        const db = MeshRuntimeStore.getInstance();
        const m1 = `m-cur1-${randomUUID().slice(0, 8)}`;
        const m2 = `m-cur2-${randomUUID().slice(0, 8)}`;
        db.bumpSchedulerCursor(m1);
        db.bumpSchedulerCursor(m1);
        expect(db.getSchedulerCursor(m1)).toBe(2);
        expect(db.getSchedulerCursor(m2)).toBe(0);
    });
});

// ── Fitness strategy: task→capability-slot ranking (ORCHESTRATION_NODE_SLOTS.md) ──
describe('mesh scheduling pipeline — fitness strategy', () => {
    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // Nodes with explicit capability slots. Each spec's `slots` becomes policy.slots.
    function slotNodes(specs: Array<{ id: string; priority?: number; slots?: any[] }>) {
        return specs.map((s, index) => ({
            nodeId: s.id,
            index,
            node: { id: s.id, policy: { schedulingPriority: s.priority, slots: s.slots } },
        }));
    }

    const fitnessOrder = (
        meshId: string,
        specs: Array<{ id: string; priority?: number; slots?: any[] }>,
        task?: { difficulty?: string; requiredTags?: string[] },
    ): string[] =>
        __orderEligibleNodesForTests(meshId, 'fitness', slotNodes(specs), { task }).map(n => n.nodeId);

    it('ranks the node whose slot handles the task difficulty first', () => {
        const meshId = `m-fit-${randomUUID().slice(0, 8)}`;
        // node a: easy-only slot; node b: difficult slot. A difficult task prefers b.
        const result = fitnessOrder(meshId, [
            { id: 'a', slots: [{ provider: 'codex-cli', difficulty: ['easy'] }] },
            { id: 'b', slots: [{ provider: 'claude-cli', difficulty: ['difficult'] }] },
        ], { difficulty: 'difficult' });
        expect(result[0]).toBe('b');
    });

    it('a general-purpose slot outranks a mismatched-difficulty slot (fallback, never blocks)', () => {
        const meshId = `m-fit2-${randomUUID().slice(0, 8)}`;
        // node a: easy-only (mismatch for difficult); node b: no difficulty (general).
        const result = fitnessOrder(meshId, [
            { id: 'a', slots: [{ provider: 'codex-cli', difficulty: ['easy'] }] },
            { id: 'b', slots: [{ provider: 'claude-cli' }] },
        ], { difficulty: 'difficult' });
        expect(result[0]).toBe('b');
    });

    it('capability coverage breaks ties among equal-difficulty slots', () => {
        const meshId = `m-fit3-${randomUUID().slice(0, 8)}`;
        const result = fitnessOrder(meshId, [
            { id: 'a', slots: [{ provider: 'codex-cli', difficulty: ['difficult'] }] },
            { id: 'b', slots: [{ provider: 'claude-cli', difficulty: ['difficult'], capability: ['worktree'] }] },
        ], { difficulty: 'difficult', requiredTags: ['worktree'] });
        expect(result[0]).toBe('b');
    });

    it('without a task, fitness falls back to priority/load ordering (idle drain)', () => {
        const meshId = `m-fit4-${randomUUID().slice(0, 8)}`;
        // No task → fitness inert; higher priority wins like priority ordering.
        const result = __orderEligibleNodesForTests(meshId, 'fitness', slotNodes([
            { id: 'a', priority: 0, slots: [{ provider: 'codex-cli' }] },
            { id: 'b', priority: 100, slots: [{ provider: 'claude-cli' }] },
        ]), {}).map(n => n.nodeId);
        expect(result[0]).toBe('b');
    });
});
