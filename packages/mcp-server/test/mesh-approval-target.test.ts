import { describe, expect, it, vi } from 'vitest';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { meshApprove, meshListPendingApprovals } from '../src/tools/mesh-tools-session.js';
import { MESH_APPROVE_TOOL } from '../src/tools/mesh-tool-schemas-admin.js';

const fixture = vi.hoisted(() => ({ activeWork: [] as any[], nodes: [] as any[] }));
vi.mock('../src/tools/mesh-held-node-state.js', () => ({ collectMeshNodesWithRuntime: vi.fn(async () => fixture.nodes), readNodeRuntime: vi.fn() }));
vi.mock('../src/tools/mesh-status-background.js', () => ({ scheduleBackgroundDirectReconcile: vi.fn() }));

vi.mock('../src/tools/mesh-tools-internal.js', () => ({
    commandForNode: vi.fn(async (_ctx, _node, _command, args) => ({ success: true, forwarded: args })),
    findNodeWithRefresh: vi.fn(async () => ({ id: 'n', workspace: '/tmp/worktree' })),
    drainCoordinatorPendingEvents: vi.fn(), findOptionalNodeWithRefresh: vi.fn(),
    readActiveWorkFromDaemon: vi.fn(async () => ({ activeWork: { activeWork: fixture.activeWork }, directDispatches: [], records: [] })), recordMeshCoordinatorToolCall: vi.fn(),
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

describe('pending approval compatibility protocol', () => {
    it('enumerates ledger-only and older IDE/extension resources without claiming actionable consent', async () => {
        fixture.activeWork = [{ taskId: 't', taskTitle: 'Worker', source: 'direct', status: 'awaiting_approval', nodeId: 'n', sessionId: 'ledger', terminalKind: 'task_approval_needed', terminalAt: new Date(8000).toISOString(), createdAt: new Date(1000).toISOString(), elapsedMs: 9000 }];
        fixture.nodes = [{ nodeId: 'n', health: 'online', sessions: [{ sessionId: 'ide', providerType: 'cursor', status: 'waiting_approval', activeChat: { activeModal: { buttons: ['Run', 'Cancel'] } } }] }];
        const result = JSON.parse(await meshListPendingApprovals({} as any));
        expect(result).toMatchObject({ count: 1, waitingCount: 2, attentionCount: 2, actionableCount: 0 });
        expect(result.approvals[0]).toMatchObject({ sessionId: 'ledger', waitingSince: new Date(8000).toISOString(), actionable: false, providerApproval: { source: 'ledger_approval', evidence: 'unavailable' } });
        expect(result.needsAttention[0]).toMatchObject({ nodeId: 'n', sessionId: 'ide', source: 'legacy_provider', compatibility: 'session_only', actionable: false });
        expect(result.nextStep).toBeUndefined();
    });
    it('keeps natural exact CLI permission count distinct from waiting and cached unknowns', async () => {
        const approval = { source: 'provider_modal', type: 'tool_permission', evidence: 'live', lifecycle: 'pending', modalKey: 'modal:live', attemptId: 'a', generation: 1, createdAt: 8000, resolvedAt: null, buttons: ['Yes', 'No'], description: '', actionable: true };
        const record = { taskId: 't', taskTitle: 'Worker', source: 'direct', status: 'awaiting_approval', nodeId: 'n', sessionId: 'cli', createdAt: new Date(1000).toISOString(), elapsedMs: 9000, providerApproval: approval };
        fixture.activeWork = [record, { ...record, taskId: 'old', sessionId: 'cached', providerApproval: { ...approval, evidence: 'cached', actionable: false } }];
        fixture.nodes = [];
        const result = JSON.parse(await meshListPendingApprovals({} as any));
        expect(result).toMatchObject({ count: 2, waitingCount: 2, attentionCount: 1, actionableCount: 1 });
        expect(result.approvals.filter((item: any) => item.actionable)).toHaveLength(1);
        expect(result.nextStep).toContain('approval_target');
    });
});
