import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshReattachSourceParent } from '../src/tools/mesh-tools-crud.js';
import { MESH_REATTACH_SOURCE_PARENT_TOOL } from '../src/tools/mesh-tool-schemas-admin.js';
test('owner repair carries explicit CAS through supported command transport and defaults to dry-run', async () => {
    const calls: unknown[] = [];
    const transport = { command: async (...args: unknown[]) => { calls.push(args); return { success: true, dryRun: true }; } } as any;
    const args = { node_id: 'node_existing', parent_node_id: 'node_main', expected_old_parent_id: 'node_missing' };
    await meshReattachSourceParent(transport, args, 'mesh_fixture');
    await meshReattachSourceParent(transport, { ...args, write: true }, 'mesh_fixture');
    assert.deepEqual(calls, [false, true].map(write => ['reattach_mesh_source_parent', {
        meshId: 'mesh_fixture', nodeId: args.node_id, parentNodeId: args.parent_node_id, expectedOldParentId: args.expected_old_parent_id, write,
    }]));
    assert.deepEqual(MESH_REATTACH_SOURCE_PARENT_TOOL.inputSchema.required, ['node_id', 'parent_node_id', 'expected_old_parent_id']);
});
