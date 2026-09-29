import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// A cancel is a terminal acceptance like any other: it goes through the ONE
// terminal choke point (mesh-task-terminal.ts commitTaskTerminal), so the row
// flip, the output version and the post-commit cleanup stay together, and the
// cancel's own bookkeeping (cancelledAt / cancelReason / cleared assignment /
// bumped nonce) survives that flip. A cancel must never RELEASE dependents:
// under `block` they wait (a retry recovers them), under `cancel` they close.

const testTmpDir = path.join(tmpdir(), `adhdev-cancel-terminal-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
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
vi.mock('../../src/config/mesh-config-routing.js', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    __writeTaskStatusForTests,
    cancelTask,
    enqueueTask,
    getQueueEntryById,
    takeCancelledTaskAssignment,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { bindMeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js';

const MESH_SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/mesh');

let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    meshConfigMocks.getMesh.mockReset();
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function newMesh(tag: string): string {
    currentMesh = `mesh_cancel_${tag}_${randomUUID().slice(0, 8)}`;
    bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
    return currentMesh;
}

const opts = { taskMode: 'code_change', difficulty: 'medium' } as any;

describe('cancel goes through the terminal choke point', () => {
    it('persists an output version and the cancel-specific bookkeeping', () => {
        const mesh = newMesh('bookkeeping');
        const task = enqueueTask(mesh, 'do it', opts);
        const store = MeshRuntimeStore.getInstance();
        store.updateQueueEntry({
            ...store.findQueueEntryById(mesh, task.id)!,
            status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-live',
            assignedProviderType: 'claude', dispatchNonce: 3,
        } as any);

        const cancelled = cancelTask(mesh, task.id, { reason: 'operator_cancel' });

        expect(cancelled?.status).toBe('cancelled');
        expect(cancelled?.cancelledAt).toBeTruthy();
        expect(cancelled?.cancelReason).toBe('operator_cancel');
        expect(cancelled?.assignedSessionId).toBeUndefined();
        expect(cancelled?.dispatchNonce).toBe(4);
        const persisted = getQueueEntryById(mesh, task.id)!;
        expect(persisted.status).toBe('cancelled');
        expect(persisted.cancelReason).toBe('operator_cancel');
        expect(store.getLatestTaskOutput(task.id)).toMatchObject({ version: 1, status: 'cancelled' });
        expect(takeCancelledTaskAssignment(mesh, task.id)).toEqual({
            sessionId: 'sess-live', nodeId: 'node_main', providerType: 'claude',
        });
    });

    it('a replayed identical terminal is a duplicate: no second output version', () => {
        const mesh = newMesh('replay');
        const task = enqueueTask(mesh, 'do it', opts);
        __writeTaskStatusForTests(mesh, task.id, 'failed');
        __writeTaskStatusForTests(mesh, task.id, 'failed');
        expect(MeshRuntimeStore.getInstance().getLatestTaskOutput(task.id)?.version).toBe(1);
    });
});

describe('a cancel settles, it never releases dependents', () => {
    it('under `block`, a cancel leaves the dependent PENDING and a retry recovers it', () => {
        const mesh = newMesh('block');
        meshConfigMocks.getMesh.mockReturnValue({ policy: {} } as any);
        const a = enqueueTask(mesh, 'a', opts);
        const b = enqueueTask(mesh, 'b', { ...opts, dependsOn: [a.id] });

        cancelTask(mesh, a.id, { reason: 'operator_cancel' });
        expect(getQueueEntryById(mesh, b.id)!.status).toBe('pending');

        __writeTaskStatusForTests(mesh, a.id, 'completed', { force: true } as any);
        expect(getQueueEntryById(mesh, a.id)!.status).toBe('completed');
        expect(getQueueEntryById(mesh, b.id)!.status).toBe('pending');
    });

    it('under `cancel`, a cancel terminalizes the dependent subtree', () => {
        const mesh = newMesh('cascade');
        meshConfigMocks.getMesh.mockReturnValue({ policy: { onDependencyFailure: 'cancel' } } as any);
        const a = enqueueTask(mesh, 'a', opts);
        const b = enqueueTask(mesh, 'b', { ...opts, dependsOn: [a.id] });
        const c = enqueueTask(mesh, 'c', { ...opts, dependsOn: [b.id] });

        cancelTask(mesh, a.id, { reason: 'operator_cancel' });
        expect(getQueueEntryById(mesh, b.id)!.status).toBe('cancelled');
        expect(getQueueEntryById(mesh, b.id)!.cancelReason).toBe(`dependency_failed:${a.id}`);
        expect(getQueueEntryById(mesh, c.id)!.status).toBe('cancelled');
        expect(getQueueEntryById(mesh, c.id)!.cancelReason).toBe(`dependency_failed:${b.id}`);
    });
});

describe('structural pin — cancelTask has no inline terminal write', () => {
    it('cancelTask delegates its terminal flip instead of assigning entry.status', () => {
        const src = fs.readFileSync(path.join(MESH_SRC_DIR, 'mesh-work-queue.ts'), 'utf8');
        const fn = src.slice(src.indexOf('export function cancelTask'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        expect(body).toMatch(/commitTaskTerminal\(\{/);
        expect(body).not.toMatch(/entry\.status\s*=\s*'cancelled'/);
    });
});
