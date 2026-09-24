import assert from 'node:assert/strict';
import test from 'node:test';

import { meshReviewInbox } from '../src/tools/mesh-tools.js';

/**
 * mesh_review_inbox always forwarded `inlineMesh: ctx.mesh` regardless of
 * whether the caller's `mesh_id` argument named the coordinator's OWN mesh or
 * a DIFFERENT one. inlineMesh is a cache-priming hint for the mesh it belongs
 * to — the daemon merges it into its own record for that mesh id — so sending
 * ctx.mesh's inline node statuses alongside a foreign mesh_id contaminates
 * that foreign mesh's ledger read with unrelated data. Fixed: inlineMesh is
 * only attached when the requested meshId equals ctx.mesh.id.
 */

function buildCtx(ownMeshId: string) {
    const calls: Array<{ command: string; args: any }> = [];
    const ctx: any = {
        mesh: {
            id: ownMeshId,
            name: 'own-mesh',
            nodes: [{ id: 'node-a', workspace: '/repo/a' }],
            updatedAt: new Date().toISOString(),
        },
        transport: {
            command: async (command: string, args: any) => {
                calls.push({ command, args });
                if (command === 'get_mesh') return { success: true, mesh: { nodes: [] } };
                return { success: true, inbox: [] };
            },
        },
    };
    return { ctx, calls };
}

test('mesh_review_inbox: does NOT attach inlineMesh when mesh_id names a DIFFERENT mesh', async () => {
    const { ctx, calls } = buildCtx('mesh-own');

    await meshReviewInbox(ctx, { mesh_id: 'mesh-foreign' });

    const inboxCall = calls.find(c => c.command === 'get_mesh_review_inbox');
    assert.ok(inboxCall, 'expected get_mesh_review_inbox to be called');
    assert.equal(inboxCall!.args.meshId, 'mesh-foreign');
    assert.equal('inlineMesh' in inboxCall!.args, false, 'inlineMesh must not be attached for a foreign mesh_id');
});

test('mesh_review_inbox: DOES attach inlineMesh when mesh_id is omitted (defaults to own mesh)', async () => {
    const { ctx, calls } = buildCtx('mesh-own');

    await meshReviewInbox(ctx, {});

    const inboxCall = calls.find(c => c.command === 'get_mesh_review_inbox');
    assert.ok(inboxCall, 'expected get_mesh_review_inbox to be called');
    assert.equal(inboxCall!.args.meshId, 'mesh-own');
    assert.equal(inboxCall!.args.inlineMesh, ctx.mesh);
});

test('mesh_review_inbox: DOES attach inlineMesh when mesh_id explicitly names the caller\'s own mesh', async () => {
    const { ctx, calls } = buildCtx('mesh-own');

    await meshReviewInbox(ctx, { mesh_id: 'mesh-own' });

    const inboxCall = calls.find(c => c.command === 'get_mesh_review_inbox');
    assert.ok(inboxCall, 'expected get_mesh_review_inbox to be called');
    assert.equal(inboxCall!.args.inlineMesh, ctx.mesh);
});
