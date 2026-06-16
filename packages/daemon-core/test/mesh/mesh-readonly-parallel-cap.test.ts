import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-ro-cap-test-${randomUUID().slice(0, 8)}`);
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
import { activeWriteAssignedCount, activeReadonlyAssignedCount } from '../../src/mesh/mesh-events-coordinator.js';

// Gate C (global parallel cap): read-only assignments are partitioned out of the
// write-task parallel cap so they never count against (or are bounded by) it.
// activeWriteAssignedCount drives the write cap (default maxParallelTasks);
// activeReadonlyAssignedCount drives the separate read-only safety cap (2x).
describe('mesh read-only parallel cap — assignment partitioning (gate C)', () => {
    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    const assignReadonly = (db: any, meshId: string, id: string, nodeId: string, sessionId: string) => {
        const now = new Date().toISOString();
        db.insertQueueEntry({ id, meshId, message: 'diagnose', status: 'assigned', taskMode: 'live_debug_readonly', assignedNodeId: nodeId, assignedSessionId: sessionId, createdAt: now, updatedAt: now });
    };
    const assignWrite = (db: any, meshId: string, id: string, nodeId: string, sessionId: string) => {
        const now = new Date().toISOString();
        db.insertQueueEntry({ id, meshId, message: 'edit', status: 'assigned', taskMode: 'code_change', assignedNodeId: nodeId, assignedSessionId: sessionId, createdAt: now, updatedAt: now });
    };

    it('read-only assignments do not count toward the write cap', () => {
        const meshId = `mesh-cap-ro-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        // 3 read-only on one node + 0 write.
        assignReadonly(db, meshId, 'ro-1', 'node1', 'sess1');
        assignReadonly(db, meshId, 'ro-2', 'node1', 'sess2');
        assignReadonly(db, meshId, 'ro-3', 'node1', 'sess3');

        // With maxParallelTasks=2, all 3 read-only tasks are active yet the write
        // cap (which gates write auto-launch) sees zero write assignments.
        expect(activeWriteAssignedCount(meshId)).toBe(0);
        expect(activeReadonlyAssignedCount(meshId)).toBe(3);

        __clearMeshQueueForTests(meshId);
    });

    it('counts write and read-only assignments independently in a mixed queue', () => {
        const meshId = `mesh-cap-mixed-${randomUUID().slice(0, 8)}`;
        const db = MeshRuntimeStore.getInstance();
        assignWrite(db, meshId, 'w-1', 'node1', 'sess1');
        assignWrite(db, meshId, 'w-2', 'node2', 'sess2');
        assignReadonly(db, meshId, 'ro-1', 'node3', 'sess3');
        assignReadonly(db, meshId, 'ro-2', 'node3', 'sess4');

        // Write cap (default 2) is exactly met by writes; read-only run under their
        // own (2x = 4) safety cap, unaffected by the write count.
        expect(activeWriteAssignedCount(meshId)).toBe(2);
        expect(activeReadonlyAssignedCount(meshId)).toBe(2);

        __clearMeshQueueForTests(meshId);
    });
});
