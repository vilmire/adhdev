// DRY-RUN-SILENTLY-IGNORED — `dry_run:false` alone must never be a silent no-op.
//
// In mesh_fast_forward_node / mesh_cleanup_sessions mode=prune_stale_direct, `dry_run` is a VETO on
// execution, not a trigger for it: `execute:true` is the only thing that runs
// anything. A caller passing `dry_run:false` on its own is plainly asking to
// execute, but used to get a silent dry-run back (dryRun:true / executed:false)
// with no indication the request had been dropped. A coordinator that believes
// it executed can then report a convergence that never happened — the failure
// is a FALSE SUCCESS REPORT, not merely a wasted call.
//
// Note the field evidence: in the same call, `update_submodules:true` WAS
// honored, so the argument reached the tool; only `dry_run` was inert.
//
// These tools now refuse that shape with `dry_run_false_requires_execute` and
// send nothing to the daemon. Tools where `dry_run` is the SOLE control (e.g.
// mesh_cleanup_worktree_nodes, where dry_run:false genuinely executes) are a
// different, correct contract and are deliberately untouched.
import test from 'node:test';
import assert from 'node:assert/strict';

import { meshFastForwardNode } from '../src/tools/mesh-tools-git.js';
import { meshPruneStaleDirect } from '../src/tools/mesh-tools-session.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { meshRefineNode, meshRefineBatch } from '../src/tools/mesh-tools-refine.js';

function makeCtx(calls: Array<{ verb: string; args: any }>) {
    const transport: any = {
        command: async (verb: string, args: any) => {
            calls.push({ verb, args });
            return { success: true };
        },
        meshCommand: async (_daemonId: string, verb: string, args: any) => {
            calls.push({ verb, args });
            return { success: true };
        },
    };
    return {
        mesh: {
            id: 'mesh-test',
            name: 'mesh-test',
            updatedAt: new Date().toISOString(),
            nodes: [
                { id: 'node-base', workspace: '/repo/base', isLocalWorktree: false },
                { id: 'node-wt-1', workspace: '/wt/one', isLocalWorktree: true, worktreeBranch: 'feat/a' },
            ],
        },
        transport,
        localDaemonId: 'daemon-local',
    } as any;
}

test('mesh_fast_forward_node: dry_run:false without execute is refused, not silently previewed', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    const out = JSON.parse(await meshFastForwardNode(ctx, { node_id: 'node-wt-1', dry_run: false }));

    assert.equal(out.success, false);
    assert.equal(out.code, 'dry_run_false_requires_execute');
    assert.equal(out.executed, false);
    assert.match(out.nextAction, /execute:\s*true/);
    // The critical property: nothing was dispatched, so no state could change
    // while the caller believed it had executed.
    assert.equal(calls.some(c => c.verb === 'fast_forward_mesh_node'), false);
});

test('mesh_fast_forward_node: execute:true still executes (dry_run omitted)', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    await meshFastForwardNode(ctx, { node_id: 'node-wt-1', execute: true });

    const dispatched = calls.find(c => c.verb === 'fast_forward_mesh_node');
    assert.ok(dispatched, 'expected the fast-forward to be dispatched');
    assert.equal(dispatched!.args.execute, true);
    assert.equal(dispatched!.args.dryRun, false);
});

test('mesh_fast_forward_node: dry_run:true still vetoes execute:true', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    await meshFastForwardNode(ctx, { node_id: 'node-wt-1', execute: true, dry_run: true });

    const dispatched = calls.find(c => c.verb === 'fast_forward_mesh_node');
    assert.ok(dispatched, 'expected a dry-run plan to be dispatched');
    assert.equal(dispatched!.args.execute, false);
    assert.equal(dispatched!.args.dryRun, true);
});

test('mesh_fast_forward_node: omitting both flags previews (default dry-run preserved)', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    await meshFastForwardNode(ctx, { node_id: 'node-wt-1' });

    const dispatched = calls.find(c => c.verb === 'fast_forward_mesh_node');
    assert.ok(dispatched, 'expected a dry-run plan to be dispatched');
    assert.equal(dispatched!.args.dryRun, true);
});

test('prune_stale_direct core: dry_run:false without execute is refused', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    const out = JSON.parse(await meshPruneStaleDirect(ctx, { dry_run: false }));

    assert.equal(out.success, false);
    assert.equal(out.code, 'dry_run_false_requires_execute');
    assert.equal(out.executed, false);
});

// 2026-09-26 tool consolidation: the prune is published as mesh_cleanup_sessions
// mode=prune_stale_direct. Drive it through the REAL dispatch table so the merge
// cannot route the mode to the per-node session cleanup (which would need node_id
// and never reach the prune core's veto).
test('mesh_cleanup_sessions mode=prune_stale_direct reaches the prune core through dispatch (dry_run:false refused)', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);
    const handler = resolveMeshToolHandler('mesh_cleanup_sessions')!;
    const out = JSON.parse(await handler(ctx, { mode: 'prune_stale_direct', dry_run: false }));
    assert.equal(out.success, false);
    assert.equal(out.code, 'dry_run_false_requires_execute');
    assert.match(out.nextAction, /mesh_cleanup_sessions\(mode: "prune_stale_direct", execute: true\)/);
});

// DRY-RUN-VETO-PRECEDENCE (safety) — parity audit gap: refine_mesh_node /
// mesh_refine_batch forwarded `dry_run`/`execute` straight to the daemon with
// no MCP-side veto at all, unlike mesh_fast_forward_node above. Combined with
// the daemon-side `isDryRun = dryRun !== false && execute !== true` bug (fixed
// in command-args.ts resolveDryRunVeto), `{execute:true, dry_run:true}` used
// to run the REAL validate→merge→push job. These pin the MCP-boundary refusal
// for the bare dry_run:false shape; the daemon-side dry_run:true-always-wins
// fix is pinned separately in
// oss/packages/daemon-core/test/commands/mesh-refine-dry-run-veto-precedence.test.ts.

test('mesh_refine_node: dry_run:false without execute is refused, not silently previewed', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    const out = JSON.parse(await meshRefineNode(ctx, { node_id: 'node-base', dry_run: false }));

    assert.equal(out.success, false);
    assert.equal(out.code, 'dry_run_false_requires_execute');
    assert.equal(out.executed, false);
    assert.match(out.nextAction, /execute:\s*true/);
    // Nothing dispatched to the daemon — no state could change under a caller
    // that believed it had executed.
    assert.equal(calls.some(c => c.verb === 'refine_mesh_node'), false);
});

test('mesh_refine_node: execute:true + dry_run:true still forwards a dry-run request (mcp side does not silently execute)', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    await meshRefineNode(ctx, { node_id: 'node-base', execute: true, dry_run: true });

    const dispatched = calls.find(c => c.verb === 'refine_mesh_node');
    assert.ok(dispatched, 'expected refine_mesh_node to be dispatched');
    assert.equal(dispatched!.args.execute, true);
    assert.equal(dispatched!.args.dryRun, true);
});

test('mesh_refine_batch: dry_run:false without execute is refused', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    const out = JSON.parse(await meshRefineBatch(ctx, { dry_run: false }));

    assert.equal(out.success, false);
    assert.equal(out.code, 'dry_run_false_requires_execute');
    assert.equal(out.executed, false);
    assert.equal(calls.some(c => c.verb === 'batch_refine_mesh_nodes'), false);
});

test('mesh_refine_batch: execute:true still executes (dry_run omitted)', async () => {
    const calls: Array<{ verb: string; args: any }> = [];
    const ctx = makeCtx(calls);

    await meshRefineBatch(ctx, { execute: true });

    const dispatched = calls.find(c => c.verb === 'batch_refine_mesh_nodes');
    assert.ok(dispatched, 'expected batch_refine_mesh_nodes to be dispatched');
    assert.equal(dispatched!.args.execute, true);
});
