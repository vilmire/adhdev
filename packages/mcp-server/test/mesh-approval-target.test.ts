import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const fixture = { activeWork: [] as any[], nodes: [] as any[] };

const originalLoad = (Module as any)._load;
(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
    if (request.includes('mesh-held-node-state.js')) {
        return {
            collectMeshNodesWithRuntime: async () => fixture.nodes,
            readNodeRuntime: async () => {},
        };
    }
    if (request.includes('mesh-status-background.js')) {
        return {
            scheduleBackgroundDirectReconcile: () => {},
        };
    }
    if (request.includes('mesh-tools-internal.js')) {
        return {
            commandForNode: async (_ctx: any, _node: any, _command: string, args: any) => ({ success: true, forwarded: args }),
            findNodeWithRefresh: async () => ({ id: 'n', workspace: '/tmp/worktree' }),
            drainCoordinatorPendingEvents: () => {},
            findOptionalNodeWithRefresh: () => {},
            readActiveWorkFromDaemon: async () => ({ activeWork: { activeWork: fixture.activeWork }, directDispatches: [], records: [] }),
            recordMeshCoordinatorToolCall: async () => {},
            refreshMeshFromDaemon: async () => {},
            triggerMeshQueueAndReport: async () => {},
        };
    }
    return originalLoad.apply(this, arguments);
};

// Now import the modules that depend on the mocked ones
const { validateMeshToolArgs } = require('../src/tools/validate-tool-args.js');
const { meshApprove, meshListPendingApprovals } = require('../src/tools/mesh-tools-session.js');
const { MESH_APPROVE_TOOL } = require('../src/tools/mesh-tool-schemas-admin.js');

const target = { modalKey: 'modal:exact', attemptId: 'a1', generation: 2 };

describe('exact Inbox permission target protocol', () => {
    it('schema accepts exact identity while preserving ordinary yes/no vocabulary', () => {
        assert.equal(validateMeshToolArgs('mesh_approve', { node_id: 'n', session_id: 's', action: 'approve', approval_target: target }), null);
        assert.deepEqual(MESH_APPROVE_TOOL.inputSchema.properties.action.enum, ['approve', 'reject']);
        assert.notEqual(validateMeshToolArgs('mesh_approve', { node_id: 'n', session_id: 's', action: 'always', approval_target: target }), null);
    });
    it('forwards the exact target through membership-checked node routing', async () => {
        const result = JSON.parse(await meshApprove({} as any, { node_id: 'n', session_id: 's', action: 'reject', approval_target: target }));
        assert.deepEqual(result.forwarded, { sessionId: 's', targetSessionId: 's', workspace: '/tmp/worktree', action: 'reject', approvalTarget: target });
    });
    it('schema declares the exact-button fields and the gate accepts them', () => {
        const props = MESH_APPROVE_TOOL.inputSchema.properties as Record<string, any>;
        assert.equal(props.button.type, 'string');
        assert.equal(props.button_index.type, 'integer');
        assert.deepEqual(MESH_APPROVE_TOOL.inputSchema.required, ['node_id', 'session_id', 'action']);
        assert.equal(validateMeshToolArgs('mesh_approve', { node_id: 'n', session_id: 's', action: 'approve', approval_target: target, button: 'Yes', button_index: 0 }), null);
        assert.notEqual(validateMeshToolArgs('mesh_approve', { node_id: 'n', session_id: 's', action: 'approve', approval_target: target, buttonText: 'Yes' }), null);
    });
    it('forwards the exact button with its episode target as the exact-button form of resolve_action', async () => {
        const result = JSON.parse(await meshApprove({} as any, { node_id: 'n', session_id: 's', action: 'approve', approval_target: target, button: "Yes, and don't ask again", button_index: 1 }));
        assert.deepEqual(result.forwarded, { sessionId: 's', targetSessionId: 's', workspace: '/tmp/worktree', action: 'approve', approvalTarget: target, button: "Yes, and don't ask again", buttonIndex: 1 });
    });
    it('refuses an exact button without an exact episode target instead of fuzzy-matching it', async () => {
        const noTarget = JSON.parse(await meshApprove({} as any, { node_id: 'n', session_id: 's', action: 'approve', button: 'Yes' }));
        assert.equal(noTarget.success, false);
        assert.equal(noTarget.code, 'approval_target_required');
        assert.equal(noTarget.forwarded, undefined);
        const indexOnly = JSON.parse(await meshApprove({} as any, { node_id: 'n', session_id: 's', action: 'approve', approval_target: target, button_index: 0 }));
        assert.equal(indexOnly.success, false);
        assert.equal(indexOnly.code, 'approval_button_required');
    });
    it('without button the forwarded call is unchanged (no button fields)', async () => {
        const result = JSON.parse(await meshApprove({} as any, { node_id: 'n', session_id: 's', action: 'approve', approval_target: target }));
        assert.equal('button' in result.forwarded, false);
        assert.equal('buttonIndex' in result.forwarded, false);
    });
});

describe('pending approval compatibility protocol', () => {
    it('enumerates ledger-only and older IDE/extension resources without claiming actionable consent', async () => {
        fixture.activeWork = [{ taskId: 't', taskTitle: 'Worker', source: 'direct', status: 'awaiting_approval', nodeId: 'n', sessionId: 'ledger', terminalKind: 'task_approval_needed', terminalAt: new Date(8000).toISOString(), createdAt: new Date(1000).toISOString(), elapsedMs: 9000 }];
        fixture.nodes = [{ nodeId: 'n', health: 'online', sessions: [{ sessionId: 'ide', providerType: 'cursor', status: 'waiting_approval', activeChat: { activeModal: { buttons: ['Run', 'Cancel'] } } }] }];
        const result = JSON.parse(await meshListPendingApprovals({} as any));
        assert.equal(result.count, 1);
        assert.equal(result.waitingCount, 2);
        assert.equal(result.attentionCount, 2);
        assert.equal(result.actionableCount, 0);
        assert.equal(result.approvals[0].sessionId, 'ledger');
        assert.equal(result.approvals[0].waitingSince, new Date(8000).toISOString());
        assert.equal(result.approvals[0].actionable, false);
        assert.equal(result.approvals[0].providerApproval.source, 'ledger_approval');
        assert.equal(result.approvals[0].providerApproval.evidence, 'unavailable');
        assert.equal(result.needsAttention[0].nodeId, 'n');
        assert.equal(result.needsAttention[0].sessionId, 'ide');
        assert.equal(result.needsAttention[0].source, 'legacy_provider');
        assert.equal(result.needsAttention[0].compatibility, 'session_only');
        assert.equal(result.needsAttention[0].actionable, false);
        assert.equal(result.nextStep, undefined);
    });
    it('keeps natural exact CLI permission count distinct from waiting and cached unknowns', async () => {
        const approval = { source: 'provider_modal', type: 'tool_permission', evidence: 'live', lifecycle: 'pending', modalKey: 'modal:live', attemptId: 'a', generation: 1, createdAt: 8000, resolvedAt: null, buttons: ['Yes', 'No'], description: '', actionable: true };
        const record = { taskId: 't', taskTitle: 'Worker', source: 'direct', status: 'awaiting_approval', nodeId: 'n', sessionId: 'cli', createdAt: new Date(1000).toISOString(), elapsedMs: 9000, providerApproval: approval };
        fixture.activeWork = [record, { ...record, taskId: 'old', sessionId: 'cached', providerApproval: { ...approval, evidence: 'cached', actionable: false } }];
        fixture.nodes = [];
        const result = JSON.parse(await meshListPendingApprovals({} as any));
        assert.equal(result.count, 2);
        assert.equal(result.waitingCount, 2);
        assert.equal(result.attentionCount, 1);
        assert.equal(result.actionableCount, 1);
        assert.equal(result.approvals.filter((item: any) => item.actionable).length, 1);
        assert.ok(result.nextStep.includes('approval_target'));
    });
});
