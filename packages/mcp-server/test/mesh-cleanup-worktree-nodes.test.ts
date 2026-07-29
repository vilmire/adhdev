// mesh_cleanup_worktree_nodes — manual MCP plan/execute surface for lifecycle
// retention Slice 2. Verifies:
//   - dry-run is the DEFAULT (dryRun:true on the wire unless explicitly false),
//   - the daemon's reason-coded per-node plan passes through VERBATIM (dry-run
//     parity: per-node reasons are never hidden/remapped),
//   - execute mode splices removed nodes out of the in-memory mesh mirror,
//   - transport failures map to a coded failure (never a hidden success).
import test from 'node:test';
import assert from 'node:assert/strict';

import { meshCleanupWorktreeNodes } from '../src/tools/mesh-tools.js';

function makeCtx(daemonResult: any, calls: Array<{ verb: string; args: any }>) {
    const transport: any = {
        command: async (verb: string, args: any) => {
            calls.push({ verb, args });
            if (daemonResult instanceof Error) throw daemonResult;
            return daemonResult;
        },
        meshCommand: async (_daemonId: string, verb: string, args: any) => {
            calls.push({ verb, args });
            if (daemonResult instanceof Error) throw daemonResult;
            return daemonResult;
        },
    };
    const ctx: any = {
        mesh: {
            id: 'mesh-test',
            name: 'mesh-test',
            updatedAt: new Date().toISOString(),
            nodes: [
                { id: 'node-base', workspace: '/repo/base', isLocalWorktree: false },
                { id: 'node-wt-1', workspace: '/wt/one', isLocalWorktree: true, worktreeBranch: 'feat/a' },
                { id: 'node-wt-2', workspace: '/wt/two', isLocalWorktree: true, worktreeBranch: 'feat/b' },
            ],
        },
        transport,
        localDaemonId: 'daemon-local',
    };
    return ctx;
}

const PLAN_RESULT = {
    success: true,
    dryRun: true,
    meshId: 'mesh-test',
    graceMs: 48 * 60 * 60 * 1000,
    entries: [
        { nodeId: 'node-base', candidate: false, reasonCode: 'not_local_worktree', detail: 'base node' },
        { nodeId: 'node-wt-1', candidate: true, reasonCode: 'candidate', convergence: { allow: true, status: 'merged_to_main', source: 'node_branch_convergence' } },
        { nodeId: 'node-wt-2', candidate: false, reasonCode: 'convergence_unproven', detail: 'not contained' },
    ],
    summary: { scanned: 3, candidates: 1, skipped: 2, autoEligible: 0, removed: 0, removalFailures: 0, leaseConflicts: 0, byReason: { not_local_worktree: 1, candidate: 1, convergence_unproven: 1 } },
};

test('dry-run is the default and the reason-coded plan passes through verbatim', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(PLAN_RESULT, calls);
    const raw = await meshCleanupWorktreeNodes(ctx, {});
    const result = JSON.parse(raw);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].verb, 'cleanup_worktree_nodes');
    assert.equal(calls[0].args.meshId, 'mesh-test');
    assert.equal(calls[0].args.dryRun, true, 'dry_run omitted must default to true');
    assert.equal(calls[0].args.nodeId, undefined);
    // Dry-run parity: per-node entries (with reasons) reach the caller unmodified.
    assert.deepEqual(result.entries, PLAN_RESULT.entries);
    assert.deepEqual(result.summary, PLAN_RESULT.summary);
    // Dry-run never mutates the in-memory mesh mirror.
    assert.equal(ctx.mesh.nodes.length, 3);
});

test('explicit dry_run:false executes and splices removed nodes from the mesh mirror', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const executeResult = {
        ...PLAN_RESULT,
        dryRun: false,
        entries: [
            { nodeId: 'node-base', candidate: false, reasonCode: 'not_local_worktree' },
            { nodeId: 'node-wt-1', candidate: true, reasonCode: 'candidate', execution: { attempted: true, success: true, removed: true, branchRefDeleted: true } },
            { nodeId: 'node-wt-2', candidate: false, reasonCode: 'live_session' },
        ],
    };
    const ctx = makeCtx(executeResult, calls);
    const raw = await meshCleanupWorktreeNodes(ctx, { dry_run: false });
    const result = JSON.parse(raw);
    assert.equal(calls[0].args.dryRun, false);
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.entries, executeResult.entries, 'per-node execution outcomes must not be hidden');
    assert.deepEqual(ctx.mesh.nodes.map((n: any) => n.id), ['node-base', 'node-wt-2']);
});

test('failed executions keep the node in the mirror and surface the reason', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const executeResult = {
        ...PLAN_RESULT,
        dryRun: false,
        entries: [
            { nodeId: 'node-base', candidate: false, reasonCode: 'not_local_worktree' },
            { nodeId: 'node-wt-1', candidate: true, reasonCode: 'execution_cleanup_failed', execution: { attempted: true, success: false, code: 'mesh_worktree_cleanup_failed', error: 'git worktree remove failed' } },
            { nodeId: 'node-wt-2', candidate: false, reasonCode: 'live_session' },
        ],
    };
    const ctx = makeCtx(executeResult, calls);
    const result = JSON.parse(await meshCleanupWorktreeNodes(ctx, { dry_run: false }));
    assert.equal(result.entries[1].execution.code, 'mesh_worktree_cleanup_failed');
    assert.equal(ctx.mesh.nodes.length, 3, 'no node spliced when its execution failed');
});

test('transport failure maps to a coded failure, never a hidden success', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(new Error('connection refused'), calls);
    const result = JSON.parse(await meshCleanupWorktreeNodes(ctx, {}));
    assert.equal(result.success, false);
    assert.equal(result.code, 'mesh_cleanup_worktree_nodes_failed');
    assert.match(result.error, /connection refused/);
});
