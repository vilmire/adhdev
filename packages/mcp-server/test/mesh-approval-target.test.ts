import { describe, expect, it, vi } from 'vitest';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { meshApprove } from '../src/tools/mesh-tools-session.js';
import { MESH_APPROVE_TOOL } from '../src/tools/mesh-tool-schemas-admin.js';

vi.mock('../src/tools/mesh-tools-internal.js', () => ({
    commandForNode: vi.fn(async (_ctx, _node, _command, args) => ({ success: true, forwarded: args })),
    findNodeWithRefresh: vi.fn(async () => ({ id: 'n', workspace: '/tmp/worktree' })),
    drainCoordinatorPendingEvents: vi.fn(), findOptionalNodeWithRefresh: vi.fn(),
    readActiveWorkFromDaemon: vi.fn(), recordMeshCoordinatorToolCall: vi.fn(),
    refreshMeshFromDaemon: vi.fn(), triggerMeshQueueAndReport: vi.fn(),
}));

const target = { modalKey: 'modal:exact', attemptId: 'a1', generation: 2 };

describe('exact Inbox permission target protocol', () => {
    it('schema accepts exact identity while preserving ordinary yes/no vocabulary', () => {
        expect(validateMeshToolArgs('mesh_approve', { node_id: 'n', session_id: 's', action: 'approve', approval_target: target })).toBeNull();
        expect(MESH_APPROVE_TOOL.inputSchema.properties.action.enum).toEqual(['approve', 'reject']);
        expect(validateMeshToolArgs('mesh_approve', { node_id: 'n', session_id: 's', action: 'always', approval_target: target })).not.toBeNull();
    });
    it('forwards the exact target through membership-checked node routing', async () => {
        const result = JSON.parse(await meshApprove({} as any, { node_id: 'n', session_id: 's', action: 'reject', approval_target: target }));
        expect(result.forwarded).toMatchObject({ sessionId: 's', targetSessionId: 's', action: 'reject', approvalTarget: target });
    });
});
