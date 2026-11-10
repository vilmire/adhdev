import { describe, expect, it } from 'vitest';
import '../../src/commands/router-command-specs.js';
import { meshNodeLifecycleHandlers } from '../../src/commands/med-family/mesh-node-lifecycle.js';
import { meshQueueHandlers } from '../../src/commands/med-family/mesh-queue.js';

/** The owner gate is told whether an operation acts on THIS machine's own node (member scope: a former
 * host that handed the project off may still run it for the current host) or with host authority. */
function probe() {
    const calls: Array<{ operation: string; scope: unknown }> = [];
    const ctx = { requireMeshHostMutationOwner: async (_m: string, _i: unknown, operation: string, scope?: unknown) => { calls.push({ operation, scope }); return { success: false, error: 'stop' }; } } as any;
    return { calls, ctx };
}

describe('mesh owner gate scope', () => {
    it.each([
        ['update_mesh_node', { meshId: 'm', nodeId: 'n' }, 'member'],
        ['cleanup_mesh_sessions', { meshId: 'm', nodeId: 'n' }, 'member'],
    ])('%s runs as member scope', async (name, args, scope) => {
        const { calls, ctx } = probe();
        await (meshNodeLifecycleHandlers as any)[name](ctx, args);
        expect(calls).toHaveLength(1);
        expect(calls[0].scope).toBe(scope);
    });
    it('queue and node-addition operations stay host scope', async () => {
        const a = probe();
        await (meshQueueHandlers as any).requeue_mesh_queue_task(a.ctx, { meshId: 'm', taskId: 't' });
        const b = probe();
        await (meshNodeLifecycleHandlers as any).add_mesh_node(b.ctx, { meshId: 'm', nodeId: 'n' });
        expect([a.calls[0]?.scope, b.calls[0]?.scope]).toEqual([undefined, undefined]);
    });
});
