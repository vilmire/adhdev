// mesh_retry_node_bootstrap + mesh_direct_cancel — registration, argument gate,
// and the wire mapping onto the existing daemon commands:
//   mesh_retry_node_bootstrap -> retry_mesh_node_bootstrap({meshId,nodeId,inlineMesh})
//   mesh_direct_cancel        -> mesh_direct_cancel({meshId, taskId|attemptId, reason?})
import test from 'node:test';
import assert from 'node:assert/strict';

import { CANONICAL_MESH_TOOL_NAMES } from '@adhdev/mesh-shared';
import { ALL_MESH_TOOLS, meshDirectCancel, meshRetryNodeBootstrap } from '../src/tools/mesh-tools.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { TOOL_ANNOTATIONS } from '../src/tools/tool-annotations.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

type Call = { verb: string; args: any; daemonId?: string };

function makeCtx(result: any, calls: Call[], opts: { remote?: boolean } = {}) {
    const respond = async () => { if (result instanceof Error) throw result; return result; };
    const transport: any = {
        command: async (verb: string, args: any) => { calls.push({ verb, args }); return respond(); },
        ...(opts.remote ? {
            supportsMeshRelay: true,
            meshCommand: async (daemonId: string, verb: string, args: any) => { calls.push({ verb, args, daemonId }); return respond(); },
        } : {}),
    };
    return {
        mesh: {
            id: 'mesh-test', name: 'mesh-test', updatedAt: new Date().toISOString(),
            nodes: [
                { id: 'node-base', workspace: '/repo/base', isLocalWorktree: false },
                { id: 'node-wt', workspace: '/wt/one', isLocalWorktree: true, ...(opts.remote ? { daemonId: 'daemon-remote' } : {}) },
            ],
        },
        transport,
        localDaemonId: 'daemon-local',
    } as any;
}

test('both tools are canonical, published, dispatchable and annotated', () => {
    for (const name of ['mesh_retry_node_bootstrap', 'mesh_direct_cancel']) {
        assert.ok((CANONICAL_MESH_TOOL_NAMES as readonly string[]).includes(name), `${name} canonical`);
        assert.ok(ALL_MESH_TOOLS.some(t => t.name === name), `${name} published`);
        assert.equal(typeof resolveMeshToolHandler(name), 'function', `${name} dispatchable`);
        assert.ok(TOOL_ANNOTATIONS[name], `${name} annotated`);
        assert.equal(TOOL_ANNOTATIONS[name].readOnlyHint, false);
    }
    assert.equal(TOOL_ANNOTATIONS.mesh_direct_cancel.destructiveHint, true);
});

test('argument gate: node_id required for retry; unknown keys rejected for both', () => {
    assert.match(String(validateMeshToolArgs('mesh_retry_node_bootstrap', {})), /node_id/);
    assert.equal(validateMeshToolArgs('mesh_retry_node_bootstrap', { node_id: 'n' }), null);
    assert.match(String(validateMeshToolArgs('mesh_retry_node_bootstrap', { node_id: 'n', force: true })), /force/);
    assert.equal(validateMeshToolArgs('mesh_direct_cancel', { task_id: 't', reason: 'superseded' }), null);
    assert.match(String(validateMeshToolArgs('mesh_direct_cancel', { task_id: 't', force: true })), /force/);
});

test('retry: a local node calls retry_mesh_node_bootstrap with mesh/node ids', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ success: true, started: true }, calls);
    const out = JSON.parse(await meshRetryNodeBootstrap(ctx, { node_id: 'node-wt' }));
    assert.equal(out.success, true);
    // Route lookups (mesh_node_route) may precede the command; assert on the retry call itself.
    const retries = calls.filter(c => c.verb === 'retry_mesh_node_bootstrap');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].args.meshId, 'mesh-test');
    assert.equal(retries[0].args.nodeId, 'node-wt');
    assert.equal(retries[0].args.inlineMesh.id, 'mesh-test');
});

test('retry: a remote node is relayed to its own daemon', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ success: true }, calls, { remote: true });
    await meshRetryNodeBootstrap(ctx, { node_id: 'node-wt' });
    const retry = calls.find(c => c.verb === 'retry_mesh_node_bootstrap');
    assert.equal(retry?.daemonId, 'daemon-remote');
});

test('retry: daemon refusals pass through verbatim; transport failures are coded', async () => {
    const refused = { success: false, error: 'Bootstrap is already running for this node' };
    assert.deepEqual(JSON.parse(await meshRetryNodeBootstrap(makeCtx(refused, []), { node_id: 'node-wt' })), refused);
    const failed = JSON.parse(await meshRetryNodeBootstrap(makeCtx(new Error('boom'), []), { node_id: 'node-wt' }));
    assert.equal(failed.success, false);
    assert.equal(failed.code, 'mesh_retry_node_bootstrap_failed');
});

test('direct cancel: task_id maps to taskId on the wire with the mesh id and reason', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ success: true, noop: false, stopPending: true, state: 'stopping', attemptRef: { attemptId: 'a1', generation: 0 } }, calls);
    const out = JSON.parse(await meshDirectCancel(ctx, { task_id: ' t1 ', reason: 'superseded' }));
    assert.deepEqual(calls[0], { verb: 'mesh_direct_cancel', args: { meshId: 'mesh-test', taskId: 't1', reason: 'superseded' } });
    assert.equal(out.stopPending, true);
    assert.match(out.nextStepHint, /not yet proven stopped/);
});

test('direct cancel: attempt_id maps to attemptId; reason omitted when not given', async () => {
    const calls: Call[] = [];
    await meshDirectCancel(makeCtx({ success: true, noop: true, state: 'completed' }, calls), { attempt_id: 'a9' });
    assert.deepEqual(calls[0].args, { meshId: 'mesh-test', attemptId: 'a9' });
});

test('direct cancel: needs exactly one id and a valid reason; nothing is sent otherwise', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ success: true }, calls);
    for (const args of [{}, { task_id: 't', attempt_id: 'a' }, { task_id: 't', reason: 'because' }]) {
        const out = JSON.parse(await meshDirectCancel(ctx, args));
        assert.equal(out.success, false);
        assert.equal(out.code, 'bad_request');
    }
    assert.equal(calls.length, 0);
});

test('direct cancel: daemon refusals (unknown / not owner / queue attempt) pass through; no hint on no-op', async () => {
    for (const code of ['attempt_not_found', 'ledger_not_owner', 'not_direct_attempt']) {
        const out = JSON.parse(await meshDirectCancel(makeCtx({ success: false, code, error: code }, []), { task_id: 't' }));
        assert.equal(out.success, false);
        assert.equal(out.code, code);
    }
    const noop = JSON.parse(await meshDirectCancel(makeCtx({ success: true, noop: true, state: 'completed' }, []), { task_id: 't' }));
    assert.equal(noop.noop, true);
    assert.equal(noop.nextStepHint, undefined);
    const failed = JSON.parse(await meshDirectCancel(makeCtx(new Error('Unknown command'), []), { task_id: 't' }));
    assert.equal(failed.code, 'mesh_direct_cancel_failed');
});
