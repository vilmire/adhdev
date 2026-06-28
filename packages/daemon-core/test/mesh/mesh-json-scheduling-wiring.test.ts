import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate mesh runtime-store file I/O (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-meshjson-wire-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    __resolveSchedulingStrategyForTests,
    __orderEligibleNodesForTests,
} from '../../src/mesh/mesh-events-coordinator.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

// A repo checkout root that may carry a (legacy) .adhdev/mesh.json — used to prove
// the scheduler IGNORES any repo-file scheduling block now that policy is machine-local.
function makeRepoRoot(): string {
    const root = join(tmpdir(), `adhdev-meshjson-repo-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, '.adhdev'), { recursive: true });
    return root;
}
function writeLegacyScheduling(root: string, scheduling: Record<string, unknown>): void {
    writeFileSync(join(root, '.adhdev', 'mesh.json'), JSON.stringify({ policy: { scheduling } }, null, 2), 'utf-8');
}

const roots: string[] = [];
function trackRoot(): string { const r = makeRepoRoot(); roots.push(r); return r; }

function meshWithRepoRoot(repoRoot: string, storedStrategy?: string): any {
    return {
        id: `mesh_${randomUUID().slice(0, 8)}`,
        policy: storedStrategy ? { schedulingStrategy: storedStrategy } : {},
        nodes: [{ id: 'n1', repoRoot, workspace: repoRoot, isLocalWorktree: false }],
    };
}

describe('scheduling strategy resolution (machine-local policy only)', () => {
    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('the stored policy strategy is honored', () => {
        const root = trackRoot();
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root, 'least_loaded'))).toBe('least_loaded');
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root, 'round_robin'))).toBe('round_robin');
    });

    it('defaults to first_eligible when no strategy is stored', () => {
        const root = trackRoot();
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root))).toBe('first_eligible');
    });

    it('a legacy .adhdev/mesh.json policy.scheduling block is IGNORED (policy is machine-local)', () => {
        const root = trackRoot();
        // Repo file asks for spread; the stored policy says first_eligible (default). The
        // repo overlay no longer exists, so the stored policy wins — spread is ignored.
        writeLegacyScheduling(root, { distribution: 'spread', maxParallel: 4 });
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root))).toBe('first_eligible');
        // And a stored strategy still wins regardless of what the repo file says.
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root, 'round_robin'))).toBe('round_robin');
    });

    it('the resolved strategy drives orderEligibleNodes correctly end-to-end', () => {
        const root = trackRoot();
        const mesh = meshWithRepoRoot(root, 'least_loaded');
        const strategy = __resolveSchedulingStrategyForTests(mesh);
        expect(strategy).toBe('least_loaded');
        const nodes = [
            { nodeId: 'a', node: { id: 'a', policy: {} }, index: 0 },
            { nodeId: 'b', node: { id: 'b', policy: {} }, index: 1 },
            { nodeId: 'c', node: { id: 'c', policy: {} }, index: 2 },
        ];
        // least_loaded; all equal load → rotation absorbed, advances per pass.
        const p1 = __orderEligibleNodesForTests(mesh.id, strategy, nodes, { bumpCursor: true }).map(n => n.nodeId);
        const p2 = __orderEligibleNodesForTests(mesh.id, strategy, nodes, { bumpCursor: true }).map(n => n.nodeId);
        expect(p1).toEqual(['a', 'b', 'c']);
        expect(p2).toEqual(['b', 'c', 'a']);
    });
});
