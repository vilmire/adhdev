// The production enqueueReviewChild port attests the stage parent's source scope before a read-lease review round,
// otherwise every review child sits in review_input_unavailable (reviewRoutingRefusal needs a physical scope).
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const testTmpDir = path.join(tmpdir(), `adhdev-stage-attest-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => { if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const meshConfigMocks = vi.hoisted(() => ({ getMesh: vi.fn(), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => [] as any[]) }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: meshConfigMocks.getMesh, getMeshByRepo: meshConfigMocks.getMeshByRepo, listMeshes: meshConfigMocks.listMeshes }));
vi.mock('../../src/config/mesh-config-routing.js', async (importOriginal) => ({ ...(await importOriginal<any>()), getDifficultyBrains: vi.fn(() => undefined) }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../src/logging/logger.js', async (importOriginal) => {
    const real = await importOriginal<any>();
    return { ...real, LOG: new Proxy(real.LOG, { get: (t, k) => (k === 'warn' ? warn : t[k]) }) };
});

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { bindMeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js';
import { reviewRoutingRefusal } from '../../src/mesh/mesh-task-routing-contract.js';
import { createProductionStagePorts } from '../../src/mesh/stage-ports-default.js';

const dirs: string[] = [];
let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    meshConfigMocks.getMesh.mockReset(); warn.mockClear();
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function setup(workspace: (root: string) => string) {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'stage-attest-')); dirs.push(root);
    const ws = workspace(root);
    currentMesh = `mesh_attest_${randomUUID().slice(0, 8)}`;
    bindMeshNoticeRuntime({ notify: () => ({ eventId: 'x', queued: true }), retract: () => 0 } as any);
    meshConfigMocks.getMesh.mockReturnValue({ id: currentMesh, repoIdentity: 'fixture/repo', nodes: [{ id: 'node_a', workspace: ws }] });
    const parent = enqueueTask(currentMesh, 'fix it', { taskMode: 'code_change', difficulty: 'medium', review: true, ownedPaths: ['f.ts'] } as any);
    const store = MeshRuntimeStore.getInstance();
    store.updateQueueEntry({ ...store.findQueueEntryById(currentMesh, parent.id)!, status: 'assigned', assignedNodeId: 'node_a', assignedSessionId: 'sess-impl', assignedProviderType: 'claude-cli' } as any);
    const live = store.findQueueEntryById(currentMesh, parent.id)!;
    expect(live.ownershipScope).toBeUndefined();
    return { ws, live, store, ports: createProductionStagePorts({ sessionRegistry: undefined, instanceManager: undefined } as any) };
}
const spec = { round: 1, message: 'review', inputArtifactIds: [], independence: 'different_provider' as const };

describe('stage parent source-scope attestation (production enqueueReviewChild)', () => {
    it('attests and persists the scope so the read-lease review child is routable, not review_input_unavailable', () => {
        const { ws, live, store, ports } = setup(root => {
            const w = path.join(root, 'ws'); fs.mkdirSync(w);
            execFileSync('git', ['init', '-q'], { cwd: w, stdio: 'pipe', windowsHide: true });
            fs.writeFileSync(path.join(w, 'f.ts'), 'export {};');
            return w;
        });
        const child = ports.queue.enqueueReviewChild(live, spec);
        const stored = store.findQueueEntryById(live.meshId, live.id)!;
        expect(stored.ownershipScope).toBeDefined();
        expect(stored.ownershipScope!.worktree).toBe(fs.realpathSync.native(ws));
        const ctx = { workspace: ws, machineId: 'test-machine' };
        const stageParent = { ...stored, stageState: { ...stored.stageState!, phase: 'awaiting_review' } } as typeof stored;
        const c = store.findQueueEntryById(live.meshId, child.id)!;
        expect(reviewRoutingRefusal(c, stageParent, 'codex-cli', ctx, [stageParent])).toBeUndefined();
        // without a scope the same child is refused
        expect(reviewRoutingRefusal(c, { ...stageParent, ownershipScope: undefined } as typeof stored, 'codex-cli', ctx, [])).toBe('review_input_unavailable');
    });

    it('a missing or non-git node workspace keeps no scope, warns and does not throw', () => {
        for (const make of [(root: string) => path.join(root, 'absent'), (root: string) => { const w = path.join(root, 'plain'); fs.mkdirSync(w); return w; }]) {
            warn.mockClear();
            const { live, store, ports } = setup(make);
            expect(() => ports.queue.enqueueReviewChild(live, spec)).not.toThrow();
            expect(store.findQueueEntryById(live.meshId, live.id)!.ownershipScope).toBeUndefined();
            expect(warn.mock.calls.some(c => /could not attest the source scope/.test(String(c[1])))).toBe(true);
            __clearMeshQueueForTests(live.meshId);
        }
    });
});
