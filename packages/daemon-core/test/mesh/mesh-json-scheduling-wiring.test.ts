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
import { __resetMeshJsonConfigCacheForTests } from '../../src/config/mesh-json-config.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

// A repo checkout root carrying .adhdev/mesh.json, distinct from the config dir.
function makeRepoRoot(): string {
    const root = join(tmpdir(), `adhdev-meshjson-repo-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, '.adhdev'), { recursive: true });
    return root;
}
function writeScheduling(root: string, scheduling: Record<string, unknown> | null): void {
    const path = join(root, '.adhdev', 'mesh.json');
    if (scheduling === null) {
        try { rmSync(path, { force: true }); } catch { /* best-effort */ }
    } else {
        writeFileSync(path, JSON.stringify({ policy: { scheduling } }, null, 2), 'utf-8');
    }
    __resetMeshJsonConfigCacheForTests();
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

describe('.adhdev/mesh.json scheduling wiring (LOCAL-WINS) — direct-call integration smoke', () => {
    afterEach(() => {
        __resetMeshJsonConfigCacheForTests();
        __resetMeshRuntimeStoreForTests();
        for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('distribution=spread overlay resolves the effective strategy to least_loaded', () => {
        const root = trackRoot();
        writeScheduling(root, { distribution: 'spread' });
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root))).toBe('least_loaded');
    });

    it('distribution=in_order overlay resolves to first_eligible', () => {
        const root = trackRoot();
        writeScheduling(root, { distribution: 'in_order' });
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root))).toBe('first_eligible');
    });

    it('overlay WINS over a conflicting stored policy strategy (LOCAL-WINS)', () => {
        const root = trackRoot();
        writeScheduling(root, { distribution: 'spread' });
        // Stored policy says first_eligible, but the repo file says spread → least_loaded.
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root, 'first_eligible'))).toBe('least_loaded');
    });

    it('with no overlay file, the raw stored strategy is honored (escape hatch preserved)', () => {
        const root = trackRoot();
        writeScheduling(root, null);
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root, 'round_robin'))).toBe('round_robin');
        // And the default when nothing is set stays first_eligible (strict no-change).
        expect(__resolveSchedulingStrategyForTests(meshWithRepoRoot(root))).toBe('first_eligible');
    });

    it('the resolved strategy drives orderEligibleNodes correctly end-to-end', () => {
        const root = trackRoot();
        writeScheduling(root, { distribution: 'spread' });
        const mesh = meshWithRepoRoot(root);
        const strategy = __resolveSchedulingStrategyForTests(mesh);
        const nodes = [
            { nodeId: 'a', node: { id: 'a', policy: {} }, index: 0 },
            { nodeId: 'b', node: { id: 'b', policy: {} }, index: 1 },
            { nodeId: 'c', node: { id: 'c', policy: {} }, index: 2 },
        ];
        // spread → least_loaded; all equal load → rotation absorbed, advances per pass.
        const p1 = __orderEligibleNodesForTests(mesh.id, strategy, nodes, { bumpCursor: true }).map(n => n.nodeId);
        const p2 = __orderEligibleNodesForTests(mesh.id, strategy, nodes, { bumpCursor: true }).map(n => n.nodeId);
        expect(p1).toEqual(['a', 'b', 'c']);
        expect(p2).toEqual(['b', 'c', 'a']);
    });
});
