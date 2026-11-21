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
    it('enforces attested read-lease checkout, different provider, proof integrity and writer absence on resumed stage review child', async () => {
        const { createHash } = await import('node:crypto');
        const { realpathSync } = await import('node:fs');
        const { attestStageReviewInput } = await import('../../src/mesh/stage-review-input.js');
        const { initialStageState } = await import('../../src/mesh/stage-state.js');
        const candidateWs = mkdtempSync(join(tmpdir(), 'rc-stage-cand-')); dirs.push(candidateWs);
        const baseWs = mkdtempSync(join(tmpdir(), 'rc-stage-base-')); dirs.push(baseWs);
        execFileSync('git', ['init', '-q'], { cwd: candidateWs, stdio: 'pipe' });
        execFileSync('git', ['init', '-q'], { cwd: baseWs, stdio: 'pipe' });
        writeFileSync(join(candidateWs, 'runtime.ts'), 'export const r5 = true;\n');
        execFileSync('git', ['add', 'runtime.ts'], { cwd: candidateWs, stdio: 'pipe' });
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'd919'], { cwd: candidateWs, stdio: 'pipe' });
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateWs, encoding: 'utf8', stdio: 'pipe' }).trim();
        const artPath = join(realpathSync.native(candidateWs), 'art_e4ec.json');
        writeFileSync(artPath, '{"ok":true}');
        const grant = { id: 'art_e4ec', file: artPath, sha256: createHash('sha256').update('{"ok":true}').digest('hex'), size: Buffer.byteLength('{"ok":true}') };

        const st = initialStageState(new Date().toISOString());
        Object.assign(st, {
            phase: 'awaiting_review', round: 6, released: false,
            stageHeads: [{ round: 5, rootSha: 'a'.repeat(40) }, { round: 6, rootSha: headSha }],
            reviewTaskIds: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
            selfCheck: 'unavailable',
        });
        const parent = {
            id: 'parent_3e2', meshId: 'mesh_1', status: 'assigned',
            assignedNodeId: 'node_a992', assignedSessionId: 'impl_3e2', assignedProviderType: 'claude-cli',
            stagePlan: { review: true, maxRevisions: 2, independence: 'different_provider' },
            stageState: st,
        } as unknown as MeshWorkQueueEntry;
        const proof = attestStageReviewInput(parent, {
            repoIdentity: 'vilmire/adhdev', machineId: 'machine-1', nodeId: 'node_a992', workspace: candidateWs,
        }, [grant]);
        proof.childTaskId = 'c6';
        parent.stageReviewInput = proof;
        const child = {
            id: 'c6', origin: 'stage', parentTaskId: 'parent_3e2', stageRole: 'review', stageRound: 6,
            readonly: true, taskMode: 'validation', inputArtifactIds: ['art_e4ec'],
            review: { sourceTaskId: 'parent_3e2', independence: 'different_provider' },
        } as unknown as MeshWorkQueueEntry;

        // 1. Wrong base checkout is refused
        expect(reviewRoutingRefusal(child, parent, 'antigravity-cli', { workspace: baseWs, machineId: 'machine-1', repoIdentity: 'vilmire/adhdev' }, [parent])).toBe('review_input_unavailable');
        // 2. Same provider as proven implementer source provider is refused
        expect(reviewRoutingRefusal(child, parent, 'claude-cli', { workspace: candidateWs, machineId: 'machine-1', repoIdentity: 'vilmire/adhdev' }, [parent])).toBe('review_independence_required');
        // 3. Missing proof is refused
        expect(reviewRoutingRefusal(child, { ...parent, stageReviewInput: undefined }, 'antigravity-cli', { workspace: candidateWs, machineId: 'machine-1', repoIdentity: 'vilmire/adhdev' }, [parent])).toBe('review_input_unavailable');
        // 4. Attested candidate checkout read-lease is accepted for an independent provider
        expect(reviewRoutingRefusal(child, parent, 'antigravity-cli', { workspace: candidateWs, machineId: 'machine-1', repoIdentity: 'vilmire/adhdev' }, [parent])).toBeUndefined();
    });
});
