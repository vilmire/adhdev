// HOST-JOIN-INLINE-CACHE-UNION — apply_mesh_host_join must UNION-warm the
// inline mesh cache, not raw-replace it.
//
// Defect: the handler wrote the config-derived mesh straight into
// router.inlineMeshCache via a raw `.set()`. That payload is rebuilt from
// meshes.json, so it drops inline-cache-only nodes (e.g. a worktree clone whose
// durable addNode was skipped) — the exact NODE-MEMBERSHIP-SHRINK-ON-MERGE
// regression re-introduced through a side door, on the one handler that had
// just MUTATED membership. The raw set survived until the next command carrying
// an inlineMesh re-warmed the cache, but get_mesh served the shrunken membership
// in between.
//
// This test pins the fix: after a join is accepted, the cache must contain BOTH
// the pre-existing cache-only worktree node AND the newly joined member node.
// Reverting the handler to `inlineMeshCache.set(meshId, applied.mesh)` turns it
// red (the worktree node disappears from the cache).
import { describe, expect, it } from 'vitest';

import { meshHostPairingHandlers } from '../../src/commands/med-family/mesh-host-pairing.js';
import { createMesh, createMeshHostPairingToken } from '../../src/config/mesh-config.js';
import { reconcileInlineMeshCache } from '../../src/mesh/mesh-node-identity.js';

// Minimal MedFamilyContext double. getCachedInlineMesh mirrors the router's
// warm path (warmInlineMeshCache → reconcileInlineMeshCache union merge);
// inlineMeshCache is a plain Map so a handler that bypasses the warm path with
// a raw set exhibits the shrink this test guards against.
function makeCtx() {
    const inlineMeshCache = new Map<string, any>();
    const tombstones = new Set<string>();
    const ctx: any = {
        inlineMeshCache,
        getCachedInlineMesh: (meshId: string, inlineMesh?: unknown) => {
            if (inlineMesh && typeof inlineMesh === 'object') {
                const cached = inlineMeshCache.get(meshId);
                if (cached) {
                    const merged = reconcileInlineMeshCache(cached, inlineMesh, tombstones);
                    inlineMeshCache.set(meshId, merged);
                    return merged;
                }
                inlineMeshCache.set(meshId, inlineMesh);
                return inlineMesh;
            }
            return inlineMeshCache.get(meshId);
        },
        invalidateAggregateMeshStatus: () => {},
        deps: {},
    };
    return ctx;
}

describe('apply_mesh_host_join inline-cache write', () => {
    it('preserves cache-only worktree nodes while adding the joined member', async () => {
        const mesh = createMesh({ name: 'host-join-union', repoIdentity: 'example/host-join-union' });
        const { token } = createMeshHostPairingToken(mesh.id, { token: 'mhj_test_union_guard' })!;

        const ctx = makeCtx();
        // Warm the cache with a node that exists ONLY in the inline cache (no
        // config twin) — the shape a worktree clone takes when its durable
        // addNode was skipped.
        ctx.getCachedInlineMesh(mesh.id, {
            ...mesh,
            nodes: [
                { id: 'node_host_base', workspace: '/host/repo', daemonId: 'daemon_host' },
                {
                    id: 'node_cacheonly_wt',
                    workspace: '/host/wt',
                    daemonId: 'daemon_host',
                    isLocalWorktree: true,
                    worktreeBranch: 'feat/cache-only',
                    clonedFromNodeId: 'node_host_base',
                },
            ],
        });

        const res: any = await meshHostPairingHandlers.apply_mesh_host_join(ctx, {
            meshId: mesh.id,
            token,
            memberNode: { id: 'node_member_joined', workspace: '/member/repo', daemonId: 'daemon_member' },
        });

        expect(res.success).toBe(true);
        expect(res.code).toBe('mesh_host_join_accepted');

        const cached = ctx.inlineMeshCache.get(mesh.id);
        const cachedIds = (cached?.nodes ?? []).map((n: any) => n.id);
        expect(cachedIds).toContain('node_member_joined');
        expect(cachedIds).toContain('node_cacheonly_wt');
    });
});
