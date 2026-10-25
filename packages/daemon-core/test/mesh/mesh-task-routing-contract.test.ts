import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { attestLocalOwnership } from '../../src/mesh/mesh-physical-ownership.js';
import { preferEligible, reviewRoutingRefusal, pendingLaunchReservation } from '../../src/mesh/mesh-task-routing-contract.js';
import { pinnedMeshNodeIdMatches } from '../../src/mesh/mesh-pinned-node-identity.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
describe('routing contracts', () => {
    it('keeps pinned node spelling exact and rejects blank or trimmed aliases', () => {
        expect(pinnedMeshNodeIdMatches('node-a', 'node-a')).toBe(true);
        expect(pinnedMeshNodeIdMatches(undefined, undefined)).toBe(true);
        expect(pinnedMeshNodeIdMatches(null, null)).toBe(true);
        for (const [actual, expected] of [['node-a ', 'node-a'], ['node-a', ' node-a'],
            ['node-a', 'node-b'], ['', ''], [' ', ' '], [null, undefined], [undefined, 'node-a']] as const) {
            expect(pinnedMeshNodeIdMatches(actual, expected)).toBe(false);
        }
    });
    it('soft preference retains every eligible fallback; unknown preferences do not create candidates', () => {
        expect(preferEligible(['mac', 'pinned-worker'], ['pinned-worker'], x => x)).toEqual(['pinned-worker', 'mac']);
        expect(preferEligible(['mac'], ['pinned-worker'], x => x)).toEqual(['mac']);
    });
    it('requires independent provider and actual input availability for read-only review', () => {
        const workspace = mkdtempSync(join(tmpdir(), 'rc28-review-')); dirs.push(workspace);
        execFileSync('git', ['init'], { cwd: workspace, stdio: 'pipe' }); writeFileSync(join(workspace, 'file.ts'), 'export {};');
        const ownedPaths = normalizeOwnedPaths(['file.ts']).declaration;
        const scope = attestLocalOwnership({ workspace, paths: ownedPaths, phase: 'source', repoIdentity: 'repo', machineId: 'machine', nodeId: 'author' });
        const source = { status: 'completed', assignedProviderType: 'claude-cli', ownedPaths, ownershipScope: scope } as MeshWorkQueueEntry;
        const review = { readonly: true, review: { sourceTaskId: 'source', differentProvider: true as const } };
        expect(reviewRoutingRefusal(review, source, 'claude-cli', { workspace, machineId: 'machine' })).toBe('review_independence_required');
        expect(reviewRoutingRefusal(review, source, 'codex-cli', { workspace, machineId: 'other-machine' })).toBe('review_input_unavailable');
        expect(reviewRoutingRefusal(review, source, 'codex-cli', { workspace: '/absent', machineId: 'machine' })).toBe('review_input_unavailable');
        expect(reviewRoutingRefusal(review, source, 'codex-cli', { workspace, machineId: 'machine' })).toBeUndefined();
        expect(reviewRoutingRefusal(review, { ...source, status: 'assigned' }, 'codex-cli', { workspace, machineId: 'machine' })).toBe('review_input_unavailable');
    });
    it('reserves pending launches only through the bounded claim window', () => {
        const task = { status: 'pending', autoLaunch: { status: 'completed', nodeId: 'node', providerType: 'codex-cli', updatedAt: new Date(100000).toISOString() } } as MeshWorkQueueEntry;
        expect(pendingLaunchReservation(task, 110000)).toBe(true);
        expect(pendingLaunchReservation(task, 200000)).toBe(false);
        expect(pendingLaunchReservation({ ...task, status: 'assigned' }, 110000)).toBe(false);
    });
});
