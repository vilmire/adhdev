import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { meshQueueRevise } from '../src/tools/mesh-tools-queue-manage.js';
import { decodeQueueReviseRequest, TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';

test('pending revision tool is shipped and preserves typed CAS through daemon IPC', async () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_queue_revise');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ['task_id', 'expected_revision', 'patch']);
    const calls: any[] = [];
    const ctx = { mesh: { id: 'mesh' }, transport: { command: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { success: true, task: { id: 'task', status: 'pending', revision: 8 } };
    } } } as any;
    const result = JSON.parse(await meshQueueRevise(ctx, { task_id: 'task', expected_revision: 7, patch: { message: 'Narrow phase', ownedPaths: ['src/file.ts'], phase: 'source' } }));
    assert.equal(result.success, true);
    assert.equal(result.task.revision, 8);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'queue_revise');
    assert.deepEqual(calls[0].args, { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'mesh', taskId: 'task', expectedRevision: 7, patch: { message: 'Narrow phase', ownedPaths: ['src/file.ts'], phase: 'source' } });
});
test('revision wire rejects context spoofing, force, invalid status and bad revision', () => {
    const valid = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'mesh', taskId: 'task', expectedRevision: 0, patch: { message: 'Source' } };
    assert.ok(decodeQueueReviseRequest(valid));
    for (const value of [ { ...valid, force: true }, { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 1.5 },
        { ...valid, patch: { phase: 'assigned' } }, { ...valid, patch: { workspace: '/spoof' } }, { ...valid, patch: { ownershipScope: {} } } ]) assert.equal(decodeQueueReviseRequest(value), null);
});
