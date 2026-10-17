import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addNode, createMesh, getMesh, updateMesh } from '../../src/config/mesh-config.js';
import { getMeshConfigPath } from '../../src/config/mesh-config-store.js';
import { applyMeshHostJoinRequest, createMeshHostPairingToken } from '../../src/config/mesh-config-host-pairing.js';
import {
    MESH_NODE_LIMIT_CODE,
    MeshNodeLimitError,
    assertMeshNodeCapacity,
    buildMeshNodeLimitDetails,
    formatMeshNodeLimitMessage,
    isMeshNodeLimitError,
} from '../../src/config/mesh-node-limit.js';
import { DEFAULT_MESH_MAX_NODES, MESH_MAX_NODES_MAX } from '../../src/repo-mesh-types.js';

// The mesh node limit used to be a literal `mesh.nodes.length >= 10`, written twice (addNode
// and the member-join path). The preview daemon refused eight parallel-task worktree clones
// on adhdev-cloud-mesh between 2026-10-12 and 2026-10-16, each saying only "Maximum 10 nodes
// per mesh". These tests pin the replacement: the limit is the mesh's policy.maxNodes, both
// writers refuse at the same count, and the refusal says what is full, how to raise it
// (naming the meshes.json that instance reads) and what to clean up.

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'mesh-node-limit-'));
    process.env.ADHDEV_CONFIG_DIR = configDir;
});

afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
});

function newMesh(policy?: Record<string, unknown>, name = 'Limit Mesh') {
    return createMesh({ name, repoIdentity: `github.com/acme/${name.toLowerCase().replace(/\W+/g, '-')}`, ...(policy ? { policy: policy as any } : {}) });
}

function addBaseNodes(meshId: string, count: number, from = 0) {
    for (let i = from; i < from + count; i += 1) addNode(meshId, { workspace: `/work/base-${i}`, repoRoot: `/work/base-${i}` });
}

function addWorktreeNodes(meshId: string, count: number, from = 0) {
    for (let i = from; i < from + count; i += 1) {
        addNode(meshId, {
            workspace: `/work/wt-${i}`,
            repoRoot: `/work/wt-${i}`,
            isLocalWorktree: true,
            worktreeBranch: `feat/task-${i}`,
            machineNickname: 'mac-studio',
        });
    }
}

function refusal(meshId: string, workspace = '/work/one-too-many'): MeshNodeLimitError {
    try {
        addNode(meshId, { workspace, repoRoot: workspace });
    } catch (error) {
        expect(isMeshNodeLimitError(error)).toBe(true);
        return error as MeshNodeLimitError;
    }
    throw new Error('expected addNode to refuse');
}

describe('addNode — the limit is the mesh policy, not a literal', () => {
    it('a mesh is no longer capped at 10 nodes', () => {
        const mesh = newMesh();
        addBaseNodes(mesh.id, 11);
        expect(getMesh(mesh.id)!.nodes).toHaveLength(11);
    });

    it('refuses the node past the default limit and registers nothing', () => {
        const mesh = newMesh();
        addBaseNodes(mesh.id, DEFAULT_MESH_MAX_NODES);
        const error = refusal(mesh.id);
        expect(error.code).toBe(MESH_NODE_LIMIT_CODE);
        expect(error.details).toMatchObject({ meshId: mesh.id, count: DEFAULT_MESH_MAX_NODES, limit: DEFAULT_MESH_MAX_NODES, limitIsOverride: false });
        expect(getMesh(mesh.id)!.nodes).toHaveLength(DEFAULT_MESH_MAX_NODES);
    });

    it('honours a limit set when the mesh is created', () => {
        const mesh = newMesh({ maxNodes: 3 });
        addBaseNodes(mesh.id, 3);
        const error = refusal(mesh.id);
        expect(error.details).toMatchObject({ count: 3, limit: 3, limitIsOverride: true });
        expect(error.message).toContain('3 of its 3 allowed nodes');
    });

    it('raising it with the update_mesh patch lets the next node in; null returns to the default', () => {
        const mesh = newMesh({ maxNodes: 2 });
        addBaseNodes(mesh.id, 2);
        refusal(mesh.id);

        updateMesh(mesh.id, { policy: { maxNodes: 4 } });
        addBaseNodes(mesh.id, 2, 2);
        expect(getMesh(mesh.id)!.nodes).toHaveLength(4);
        refusal(mesh.id);

        const reset = updateMesh(mesh.id, { policy: { maxNodes: null } })!;
        expect('maxNodes' in reset.policy).toBe(false);
        addBaseNodes(mesh.id, 1, 4);
        expect(getMesh(mesh.id)!.nodes).toHaveLength(5);
    });

    it('rejects an out-of-range limit on write and keeps the stored policy untouched', () => {
        const mesh = newMesh({ maxNodes: 5 });
        expect(() => updateMesh(mesh.id, { policy: { maxNodes: MESH_MAX_NODES_MAX + 1 } })).toThrow(/invalid_max_nodes/);
        expect(() => updateMesh(mesh.id, { policy: { maxNodes: 0 } })).toThrow(/invalid_max_nodes/);
        expect(getMesh(mesh.id)!.policy).toEqual({ maxNodes: 5 });
    });

    it('lowering the limit below the node count evicts nothing but blocks further registration', () => {
        const mesh = newMesh();
        addBaseNodes(mesh.id, 3);
        updateMesh(mesh.id, { policy: { maxNodes: 2 } });
        expect(getMesh(mesh.id)!.nodes).toHaveLength(3);
        const error = refusal(mesh.id);
        expect(error.message).toContain('already holds 3 of its 2 allowed nodes');
        expect(getMesh(mesh.id)!.nodes).toHaveLength(3);
    });

    it('a malformed hand-edited limit resolves instead of wedging registration', () => {
        // What a hand edit of meshes.json can leave behind — the write path would have
        // rejected these, the reader must still land on a usable limit.
        const subject = (maxNodes: unknown, count: number) => ({
            id: 'mesh_hand_edited',
            name: 'Hand Edited',
            nodes: Array.from({ length: count }, (_, i) => ({ id: `node_${i}`, workspace: `/w/${i}` })) as any,
            policy: { maxNodes },
        });
        expect(() => assertMeshNodeCapacity(subject('', 3))).not.toThrow();
        expect(() => assertMeshNodeCapacity(subject(false, 3))).not.toThrow();
        expect(() => assertMeshNodeCapacity(subject(null, 3))).not.toThrow();
        // Above the ceiling clamps to the ceiling rather than lifting the guard.
        expect(() => assertMeshNodeCapacity(subject(9999, MESH_MAX_NODES_MAX - 1))).not.toThrow();
        expect(() => assertMeshNodeCapacity(subject(9999, MESH_MAX_NODES_MAX))).toThrow(MeshNodeLimitError);
    });

    it('an unknown mesh is still "not found" (undefined), not a limit error', () => {
        expect(addNode('mesh_missing', { workspace: '/work/x' })).toBeUndefined();
    });
});

describe('the refusal says what is full, how to raise it and what to clean up', () => {
    it('worktree nodes count toward the limit, and the refusal names them', () => {
        const mesh = newMesh({ maxNodes: 3 }, 'Cloud Mesh');
        addBaseNodes(mesh.id, 1);
        addWorktreeNodes(mesh.id, 2);
        const error = refusal(mesh.id);

        expect(error.details).toMatchObject({ count: 3, limit: 3, baseNodes: 1, worktreeNodes: 2 });
        expect(error.details.worktrees.map(w => w.branch)).toEqual(['feat/task-0', 'feat/task-1']);
        expect(error.details.worktrees.map(w => w.nodeId)).toEqual(getMesh(mesh.id)!.nodes.filter(n => n.isLocalWorktree).map(n => n.id));
        const text = error.message;
        expect(text).toContain(`${MESH_NODE_LIMIT_CODE}: mesh "Cloud Mesh" already holds 3 of its 3 allowed nodes (1 base, 2 worktree)`);
        for (const worktree of error.details.worktrees) {
            expect(text).toContain(worktree.nodeId);
            expect(text).toContain(`${worktree.branch} @mac-studio`);
        }
    });

    it('names the key, the command, the range and where the default comes from', () => {
        const mesh = newMesh(undefined, 'Defaults');
        addBaseNodes(mesh.id, DEFAULT_MESH_MAX_NODES);
        const text = refusal(mesh.id).message;
        expect(text).toContain('policy.maxNodes');
        expect(text).toContain(`default ${DEFAULT_MESH_MAX_NODES}`);
        expect(text).toContain(`max ${MESH_MAX_NODES_MAX}`);
        expect(text).toContain('update_mesh');
        expect(text).toContain(`"meshId":"${mesh.id}"`);
        expect(text).toContain('"policy":{"maxNodes":<N>}');
        expect(text).toContain('meshes.json');
        expect(text).toContain('null resets it');
    });

    it('names the meshes.json this instance reads, not a bare file name', () => {
        const mesh = newMesh({ maxNodes: 1 });
        addBaseNodes(mesh.id, 1);
        const error = refusal(mesh.id);
        // The config dir differs per instance (~/.adhdev, ~/.adhdev-preview, ADHDEV_CONFIG_DIR):
        // the hand-edit route is only usable if the message says which file.
        expect(error.details.configPath).toBe(getMeshConfigPath());
        expect(error.details.configPath).toMatch(/meshes\.json$/);
        expect(error.message).toContain(`in ${getMeshConfigPath()} (no restart needed)`);
        // Pointing the edit route at a path that does not exist would be worse than naming none.
        expect(existsSync(getMeshConfigPath())).toBe(true);
    });

    it('says the limit was set on this mesh when the owner overrode it', () => {
        const mesh = newMesh({ maxNodes: 2 });
        addBaseNodes(mesh.id, 2);
        const text = refusal(mesh.id).message;
        expect(text).toContain('set on this mesh');
        expect(text).not.toContain(`default ${DEFAULT_MESH_MAX_NODES}`);
    });

    it('points at the tools that finish and reclaim worktrees, and admits when it cannot judge them', () => {
        const mesh = newMesh({ maxNodes: 2 });
        addWorktreeNodes(mesh.id, 2);
        const text = refusal(mesh.id).message;
        expect(text).toContain('mesh_refine_node');
        expect(text).toContain('mesh_cleanup_worktree_nodes');
        expect(text).toContain('mesh_remove_node');
        // The config layer holds no git evidence, so it must not pretend to know which
        // worktrees are cleanup_candidate — it says where to look instead.
        expect(text).not.toContain('cleanup_candidate worktrees (');
        expect(text).toContain('mesh_status shows it');
    });

    it('spells out a bounded number of worktrees but keeps every one in the details', () => {
        const mesh = newMesh({ maxNodes: 12 });
        addWorktreeNodes(mesh.id, 12);
        const error = refusal(mesh.id);
        expect(error.details.worktrees).toHaveLength(12);
        expect(error.message).toContain('+4 more');
        expect(error.message).toContain(error.details.worktrees[7].nodeId);
        expect(error.message).not.toContain(error.details.worktrees[8].nodeId);
    });

    it('a mesh of base nodes only says there is no worktree to clean up', () => {
        const mesh = newMesh({ maxNodes: 2 });
        addBaseNodes(mesh.id, 2);
        const text = refusal(mesh.id).message;
        expect(text).toContain('every node here is a base node');
        expect(text).not.toContain('mesh_refine_node');
    });

    it('at the ceiling it says the limit cannot be raised instead of telling the owner to raise it', () => {
        const nodes = Array.from({ length: MESH_MAX_NODES_MAX }, (_, i) => ({ id: `node_${i}`, workspace: `/w/${i}`, isLocalWorktree: i % 2 === 0, worktreeBranch: `feat/${i}` })) as any;
        const text = formatMeshNodeLimitMessage(buildMeshNodeLimitDetails({ id: 'mesh_max', name: 'Maxed', nodes, policy: { maxNodes: MESH_MAX_NODES_MAX } }));
        expect(text).toContain(`already holds ${MESH_MAX_NODES_MAX} of its ${MESH_MAX_NODES_MAX} allowed nodes`);
        expect(text).toContain(`policy.maxNodes is already at its maximum (${MESH_MAX_NODES_MAX})`);
        expect(text).not.toContain('update_mesh');
        expect(text).toContain('To free slots, finish worktree nodes');
    });

    it('buildMeshNodeLimitDetails describes a mesh without refusing anything', () => {
        const mesh = newMesh({ maxNodes: 9 });
        addBaseNodes(mesh.id, 2);
        addWorktreeNodes(mesh.id, 1);
        expect(buildMeshNodeLimitDetails(getMesh(mesh.id)!)).toMatchObject({ count: 3, limit: 9, baseNodes: 2, worktreeNodes: 1, limitIsOverride: true });
    });
});

describe('a member joining the host mesh refuses at the same count in the same words', () => {
    const MEMBER = { workspace: '/member/repo', daemonId: 'mach_00000000000000000000000000000b02' };

    it('is refused past the limit with the shared error, and the token is not consumed', () => {
        const mesh = newMesh({ maxNodes: 2 }, 'Host Mesh');
        addBaseNodes(mesh.id, 2);
        createMeshHostPairingToken(mesh.id, { token: 'tok-limit' });

        let error: unknown;
        try {
            applyMeshHostJoinRequest(mesh.id, { token: 'tok-limit', memberNode: MEMBER });
        } catch (caught) {
            error = caught;
        }
        expect(isMeshNodeLimitError(error)).toBe(true);
        expect((error as MeshNodeLimitError).message).toContain('mesh "Host Mesh" already holds 2 of its 2 allowed nodes');
        expect(getMesh(mesh.id)!.nodes).toHaveLength(2);
        expect(getMesh(mesh.id)!.meshHost?.pairing?.status).not.toBe('paired');

        // The member can simply retry once the host raises the limit — same token.
        updateMesh(mesh.id, { policy: { maxNodes: 3 } });
        const retried = applyMeshHostJoinRequest(mesh.id, { token: 'tok-limit', memberNode: MEMBER });
        expect(retried).toMatchObject({ accepted: true });
        expect(getMesh(mesh.id)!.nodes).toHaveLength(3);
    });

    it('an already-registered member that re-joins a full mesh is not refused', () => {
        const mesh = newMesh({ maxNodes: 1 });
        addNode(mesh.id, { workspace: MEMBER.workspace, repoRoot: MEMBER.workspace, daemonId: MEMBER.daemonId });
        createMeshHostPairingToken(mesh.id, { token: 'tok-rejoin' });
        const joined = applyMeshHostJoinRequest(mesh.id, { token: 'tok-rejoin', memberNode: MEMBER });
        expect(joined).toMatchObject({ accepted: true });
        expect(getMesh(mesh.id)!.nodes).toHaveLength(1);
    });
});
