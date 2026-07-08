import { describe, expect, it } from 'vitest';
import { buildMeshSchedulingRuntime } from '../../src/mesh/mesh-scheduling-runtime.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue.js';

function task(partial: Partial<MeshWorkQueueEntry>): MeshWorkQueueEntry {
    return {
        id: partial.id ?? 't',
        meshId: 'm',
        message: 'msg',
        status: partial.status ?? 'pending',
        ...partial,
    } as MeshWorkQueueEntry;
}

describe('buildMeshSchedulingRuntime', () => {
    it('resolves strategy + global caps, defaulting to first_eligible / max 2', () => {
        const rt = buildMeshSchedulingRuntime({ policy: {}, nodes: [] }, []);
        expect(rt.strategy).toBe('first_eligible');
        expect(rt.maxParallelTasks).toBe(2);
        expect(rt.maxReadonlyParallelTasks).toBe(4); // max(2, 2*2)
        expect(rt.activeWriteAssigned).toBe(0);
        expect(rt.globalWriteCapReached).toBe(false);
    });

    it('clamps maxParallelTasks and honors an explicit strategy', () => {
        const rt = buildMeshSchedulingRuntime(
            { policy: { schedulingStrategy: 'least_loaded', maxParallelTasks: 99 }, nodes: [] },
            [],
        );
        expect(rt.strategy).toBe('least_loaded');
        expect(rt.maxParallelTasks).toBe(64); // clamp to MESH_MAX_PARALLEL_TASKS_MAX
        expect(rt.maxReadonlyParallelTasks).toBe(128); // 2× the write cap
    });

    it('counts global write vs readonly load and flags global cap exhaustion', () => {
        const queue = [
            task({ id: 'a', status: 'assigned', assignedNodeId: 'node_1' }),
            task({ id: 'b', status: 'assigned', assignedNodeId: 'node_2' }),
            task({ id: 'r', status: 'assigned', taskMode: 'live_debug_readonly', assignedNodeId: 'node_1' }),
            task({ id: 'p', status: 'pending' }),
        ];
        const rt = buildMeshSchedulingRuntime(
            { policy: { maxParallelTasks: 2 }, nodes: [{ id: 'node_1' }, { id: 'node_2' }] },
            queue,
        );
        expect(rt.activeWriteAssigned).toBe(2);
        expect(rt.activeReadonlyAssigned).toBe(1);
        expect(rt.globalWriteCapReached).toBe(true);
        // Each node's reasons include the global cap; node_1 also has an active write.
        const n1 = rt.nodes.find(n => n.nodeId === 'node_1')!;
        expect(n1.load).toBe(2); // 1 write + 1 readonly
        expect(n1.capReasons).toContain('global_max_parallel_tasks_reached');
        expect(n1.capReasons).toContain('node_has_active_assignment');
        expect(n1.capReached).toBe(true);
    });

    it('exposes per-node priority and per-(node, provider) cap consumption', () => {
        const queue = [
            task({ id: 'a', status: 'assigned', assignedNodeId: 'node_1', assignedProviderType: 'claude-cli' }),
            task({ id: 'b', status: 'assigned', assignedNodeId: 'node_1', assignedProviderType: 'claude-cli' }),
        ];
        const rt = buildMeshSchedulingRuntime(
            {
                policy: { maxParallelTasks: 8 },
                nodes: [{
                    id: 'node_1',
                    policy: {
                        schedulingPriority: 5,
                        providerRoles: [{ providerType: 'claude-cli', maxParallel: 2 }],
                    },
                }],
            },
            queue,
        );
        const n1 = rt.nodes[0];
        expect(n1.schedulingPriority).toBe(5);
        expect(n1.providerRoles).toEqual([
            { providerType: 'claude-cli', maxParallel: 2, activeAssigned: 2, capReached: true },
        ]);
        expect(n1.capReasons).toContain('max_provider_parallel_reached:claude-cli');
    });

    it('is empty-safe for missing mesh/queue', () => {
        const rt = buildMeshSchedulingRuntime(null, []);
        expect(rt.nodes).toEqual([]);
        expect(rt.maxParallelTasks).toBe(2);
    });
});
