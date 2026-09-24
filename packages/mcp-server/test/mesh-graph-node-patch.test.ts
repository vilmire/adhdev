import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import {
    meshEnqueueBatch,
    meshGraphNodePatch,
    meshGraphView,
    ALL_MESH_TOOLS,
} from '../src/tools/mesh-tools.js';
import { getQueue, updateTaskStatus, __writeTaskStatusForTests, readLocalRecords } from '@adhdev/daemon-core';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { MESH_GRAPH_NODE_PATCH_TOOL } from '../src/tools/mesh-tool-schemas.js';
// GRAPH-ORCHESTRATION — M-GRAPH-INPUTS-LATE-REJECT, part (b): the RECOVERY path.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :278-283 — a materialization failure blocks the still-pending node with a
//                `materialization_error:*` reason.
//     :285, :332-334 — a coordinator may patch a STILL-PENDING node's spec; an
//                assigned task is immutable (`task_already_claimed`).
//
// ★ THE DEFECT THIS FILE EXISTS FOR. `blockWithMaterializationError` documented
// the contract "the coordinator may then patch the node's selector and retry",
// and daemon-core's `patchPendingGraphNodeBaseSpec` implemented it — with a
// PASSING regression test. But that function had NO production caller and no MCP
// tool wrapping it, so the only way to reach the recovery was a unit test that
// imported it DIRECTLY. Live, the contract was unreachable: the sole patch
// surface was `mesh_graph_gate_release`, which demands a claimed gate and a
// direct gate edge, so a plain `inputs_from` node with no gate could not be
// patched at all. The graph's own re-settle loop does retry such a node on later
// upstream terminals, but it re-reads the SAME baked spec and so fails
// identically forever — "baked into the graph, unrecoverable" was literal.
//
// ★ Which is exactly why every test here drives the recovery through the MCP
// TOOL. A test that imported the core function would pass against the broken
// build too — that is the hole that let this ship.

const NODE_MAC = 'node_mac_base';

function nextMeshId(): string {
    return `mesh_nodepatch_${randomUUID().slice(0, 8)}`;
}

function recordingLocalTransport() {
    return {
        command: async (__ipcCmd: string, __ipcArgs?: Record<string, unknown>) => { if (isTurnIpcCommand(__ipcCmd)) return answerTurnIpc(__ipcCmd, __ipcArgs ?? {}); return ({ success: true }); },
        getStatus: async () => ({ sessions: [] }),
    } as any;
}

function makeCtx(meshId: string, coordinatorSessionId = 'sess-coord') {
    return {
        mesh: {
            id: meshId,
            nodes: [{ id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' }],
        },
        transport: recordingLocalTransport(),
        coordinatorSessionId,
    } as any;
}

/**
 * The live failure shape: produce → consume, where `consume` binds a field the
 * producer never emits. The binding is well-FORMED, so part (a)'s enqueue
 * validation cannot catch it — only the producer's actual output can, and by
 * then the upstream work is already done. This is precisely the case that still
 * needs a recovery path.
 */
async function enqueueBindingBatch(ctx: any, select: string) {
    return JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'produce', message: 'produce the report', difficulty: 'easy' },
            {
                ref: 'consume',
                message: 'summarize the report',
                difficulty: 'easy',
                inputs_from: [{ from: 'produce', select, as: 'report', required: true }],
            },
        ],
    } as any));
}

/** Complete `produce` with an envelope that has `rootCause` but NOT `wrongField`. */
function completeProducer(meshId: string, taskId: string) {
    __writeTaskStatusForTests(meshId, taskId, 'completed', {
        envelope: { workerResult: { rootCause: 'the real field' } },
    } as any);
}

async function blockedFixture(ctx: any, meshId: string) {
    const batch = await enqueueBindingBatch(ctx, '/worker_result/wrongField');
    assert.equal(batch.success, true, JSON.stringify(batch));
    const produceTaskId = batch.tasks.find((t: any) => t.ref === 'produce').taskId;
    const consumeTaskId = batch.tasks.find((t: any) => t.ref === 'consume').taskId;
    completeProducer(meshId, produceTaskId);

    // ★ The defect's signature: the upstream SUCCEEDED and the consumer died.
    const consume = getQueue(meshId).find(t => t.id === consumeTaskId)!;
    assert.equal(consume.status, 'pending');
    assert.equal(
        consume.blockedReason,
        'materialization_error:required_input_missing:report',
        'the consumer must be blocked on the missing input, after its upstream completed',
    );
    return { batch, produceTaskId, consumeTaskId };
}

// ── The tool is REACHABLE ────────────────────────────────────────────────────

test('node-patch: the tool is published in ALL_MESH_TOOLS and demands node + base_spec_patch', () => {
    const byName = new Map(ALL_MESH_TOOLS.map(t => [t.name, t]));
    const tool = byName.get('mesh_graph_node_patch');
    assert.ok(tool, 'mesh_graph_node_patch is not published — the recovery stays unreachable');
    for (const field of ['node', 'base_spec_patch']) {
        assert.ok(
            (tool!.inputSchema as any).required.includes(field),
            `mesh_graph_node_patch must require ${field}`,
        );
    }
});

// ── The recovery actually WORKS, through the tool ────────────────────────────

test('★ node-patch: a node blocked on required_input_missing RECOVERS through the tool', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const { batch, consumeTaskId } = await blockedFixture(ctx, meshId);

    // ★ THE DELIVERABLE: repair the selector through the MCP surface.
    const patch = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
        },
    }));
    assert.equal(patch.success, true, JSON.stringify(patch));
    // The patch and the retry are ONE call: the caller learns NOW whether it worked.
    assert.equal(patch.recovered, true, JSON.stringify(patch));
    assert.equal(patch.retryOutcome, 'materialized');
    assert.equal(patch.graphId, batch.graphId);
    assert.deepEqual(patch.patchedKeys, ['inputs_from']);

    // The queue row is claimable again, and its message carries the bound value.
    const consume = getQueue(meshId).find(t => t.id === consumeTaskId)!;
    assert.equal(consume.status, 'pending');
    assert.equal(consume.blockedReason, undefined, 'the recovered node must not stay blocked');
    assert.match(consume.message, /the real field/, 'the repaired binding must be materialized into the message');
});

// Parity audit gap: the handler read `args.ref` as a 4th node-identifier
// fallback (`node ?? node_id ?? nodeId ?? ref`) and the tool's own description
// says "Node id or `ref` of the node to patch", but the schema declared no
// `ref` property at all — so a caller using the exact alias the description
// documents was rejected by the unknown-arg gate. Pins the schema fix and
// proves `ref` alone resolves the node end-to-end (not just node/node_id/nodeId).
test('node-patch: schema declares the `ref` alias its own description documents', () => {
    assert.ok('ref' in MESH_GRAPH_NODE_PATCH_TOOL.inputSchema.properties, 'ref missing from schema');
    // The unknown-ARG gate (as opposed to the missing-required-key gate, which has
    // a pre-existing quirk that node_id/nodeId/ref alone don't satisfy `required:
    // ['node']` either — unrelated to this fix) must not reject a `ref`-only call.
    const err = validateMeshToolArgs('mesh_graph_node_patch', { node: 'consume', ref: 'consume', base_spec_patch: { run_if: 'always' } });
    assert.equal(err, null);
});

test('★ node-patch: `ref` alone (no node/node_id/nodeId) resolves and recovers the blocked node', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const { batch, consumeTaskId } = await blockedFixture(ctx, meshId);

    const patch = JSON.parse(await meshGraphNodePatch(ctx, {
        ref: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
        },
    } as any));
    assert.equal(patch.success, true, JSON.stringify(patch));
    assert.equal(patch.recovered, true, JSON.stringify(patch));
    assert.equal(patch.graphId, batch.graphId);

    const consume = getQueue(meshId).find(t => t.id === consumeTaskId)!;
    assert.equal(consume.status, 'pending');
    assert.equal(consume.blockedReason, undefined, 'the recovered node must not stay blocked');
});

test('node-patch: the generation bumps, so a pre-patch digest can never win a later CAS', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    await blockedFixture(ctx, meshId);

    const before = JSON.parse(await meshGraphView(ctx, {}));
    const beforeNode = before.graphs[0].nodes.find((n: any) => n.ref === 'consume');

    const patch = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
        },
    }));
    assert.equal(patch.success, true);
    assert.ok(
        patch.materializationVersion > (beforeNode?.materializationVersion ?? 0),
        'the patch must bump materialization_version (design :285)',
    );
});

test('node-patch: a still-wrong patch reports the NEW block instead of claiming success', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const { consumeTaskId } = await blockedFixture(ctx, meshId);

    // Shape-valid, still points at a field the producer never emitted.
    const patch = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/stillWrong', as: 'report', required: true }],
        },
    }));
    // The write SUCCEEDED; the retry did not recover it. Those are different facts
    // and the response must not conflate them.
    assert.equal(patch.success, true);
    assert.equal(patch.recovered, false, JSON.stringify(patch));
    assert.equal(patch.retryOutcome, 'error');
    assert.equal(patch.blockedReason, 'materialization_error:required_input_missing:report');
    assert.match(patch.hint, /required_input_missing/);

    const consume = getQueue(meshId).find(t => t.id === consumeTaskId)!;
    assert.equal(consume.status, 'pending');
    assert.ok(consume.blockedReason, 'a failed retry must leave the node blocked');
});

// ── The invariants the patch surface must PRESERVE ───────────────────────────

test('★ node-patch: an ASSIGNED task is immutable — task_already_claimed', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const { consumeTaskId } = await blockedFixture(ctx, meshId);

    updateTaskStatus(meshId, consumeTaskId, 'assigned');
    const patch = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
        },
    }));
    assert.equal(patch.success, false, JSON.stringify(patch));
    assert.equal(patch.code, 'task_already_claimed');
    assert.match(patch.hint, /mesh_queue_cancel/);
});

test('★ node-patch: keys outside the permitted surface are REFUSED (message/routing stay immutable)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const { consumeTaskId } = await blockedFixture(ctx, meshId);

    for (const forbidden of [
        { message: 'do something else entirely' },
        { target_node_id: 'node_somewhere_else' },
        { task_mode: 'code_change' },
        { model: 'some-other-model' },
    ]) {
        const patch = JSON.parse(await meshGraphNodePatch(ctx, {
            node: 'consume',
            base_spec_patch: forbidden,
        }));
        assert.equal(patch.success, false, `${Object.keys(forbidden)[0]} must be refused`);
        assert.equal(patch.code, 'node_patch_forbidden');
    }

    // ★ And the refusals changed NOTHING: the node still carries its original
    // instruction and its original block.
    const consume = getQueue(meshId).find(t => t.id === consumeTaskId)!;
    assert.equal(consume.blockedReason, 'materialization_error:required_input_missing:report');
    assert.notEqual(consume.message, 'do something else entirely');
});

test('node-patch: a malformed REPLACEMENT binding is rejected before anything is written', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const { consumeTaskId } = await blockedFixture(ctx, meshId);

    // Swapping one malformed spec for another would just re-block the node; the
    // caller should learn that from an ERROR, not from the retry outcome. The code
    // is the PARSER's own — a bad pointer is `invalid_selector`, a bad entry shape
    // is `invalid_binding_spec` — rather than one flattened catch-all.
    const badPointer = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: { inputs_from: [{ from: 'produce', select: 'not_a_pointer', as: 'report' }] },
    }));
    assert.equal(badPointer.success, false, JSON.stringify(badPointer));
    assert.equal(badPointer.code, 'invalid_selector');

    const badShape = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: { inputs_from: [{ from: 'produce', select: '/worker_result/rootCause' }] },
    }));
    assert.equal(badShape.success, false, JSON.stringify(badShape));
    assert.equal(badShape.code, 'invalid_binding_spec');

    const consume = getQueue(meshId).find(t => t.id === consumeTaskId)!;
    assert.equal(consume.blockedReason, 'materialization_error:required_input_missing:report');
});

test('node-patch: an unknown node, an empty patch and a missing patch are all distinct refusals', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    await blockedFixture(ctx, meshId);

    const unknown = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'no_such_ref',
        base_spec_patch: { run_if: { from: 'produce', select: '/ok' } },
    }));
    assert.equal(unknown.success, false);
    assert.equal(unknown.code, 'graph_node_not_found');

    const empty = JSON.parse(await meshGraphNodePatch(ctx, { node: 'consume', base_spec_patch: {} }));
    assert.equal(empty.success, false);
    assert.equal(empty.code, 'empty_patch');

    const missing = JSON.parse(await meshGraphNodePatch(ctx, { node: 'consume' } as any));
    assert.equal(missing.success, false);
    assert.equal(missing.code, 'missing_patch_fields');
    assert.deepEqual(missing.missing, ['base_spec_patch']);
});

// ── id-vs-ref resolution: the behavior the canon-identity disables protect ───
//
// ★ These pin WHY `patchGraphNodeAndRetry` compares graph-row ids with a raw
// `===` and NOT `meshNodeIdMatches()`. That helper reads `id ?? nodeId ??
// node_id` and returns ONE boolean, so it cannot express the asymmetry below: a
// node ID is globally unique (match ⇒ accept at once), while a `ref` is unique
// only WITHIN a graph (match ⇒ keep scanning, and refuse if another graph has
// it too). Collapsing both into one normalized read would make the id test
// identical to the combined id-or-ref test, turning the refusal in the first
// test here into "silently patch whichever graph was listed first" — the exact
// wrong-node mutation this tool must never perform. If someone later "fixes"
// the lint by swapping in the helper, the first test below goes red.

test('★ node-patch: a ref present in TWO graphs is REFUSED, not silently resolved', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);

    // Two independent batches, both declaring a node with the ref `consume`.
    const first = await blockedFixture(ctx, meshId);
    const second = await enqueueBindingBatch(ctx, '/worker_result/wrongField');
    assert.equal(second.success, true, JSON.stringify(second));
    assert.notEqual(second.graphId, first.batch.graphId, 'the fixture must produce two distinct graphs');

    const ambiguous = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
        },
    }));
    assert.equal(ambiguous.success, false, JSON.stringify(ambiguous));
    assert.equal(ambiguous.code, 'ambiguous_node_ref');
    assert.match(ambiguous.hint, /graph_id/);

    // ★ And the refusal mutated NOTHING — neither graph's node was patched.
    const consume = getQueue(meshId).find(t => t.id === first.consumeTaskId)!;
    assert.equal(consume.blockedReason, 'materialization_error:required_input_missing:report');
});

test('★ node-patch: graph_id disambiguates, and an exact node ID is unambiguous on its own', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const first = await blockedFixture(ctx, meshId);
    await enqueueBindingBatch(ctx, '/worker_result/wrongField');

    const repair = {
        inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
    };

    // (1) The same ambiguous ref + graph_id now resolves to exactly one node.
    const scoped = JSON.parse(await meshGraphNodePatch(ctx, {
        node: 'consume',
        graph_id: first.batch.graphId,
        base_spec_patch: repair,
    }));
    assert.equal(scoped.success, true, JSON.stringify(scoped));
    assert.equal(scoped.recovered, true);
    assert.equal(scoped.graphId, first.batch.graphId);

    // (2) A node ID is globally unique, so it needs NO graph_id even though the
    //     ref `consume` is still duplicated across graphs — this is the id-vs-ref
    //     asymmetry, and it is why the two comparisons must stay separate.
    const second = await enqueueBindingBatch(ctx, '/worker_result/wrongField');
    const secondConsumeNodeId = second.tasks.find((t: any) => t.ref === 'consume').nodeId;
    assert.ok(secondConsumeNodeId, 'the batch response must expose the graph node id');
    completeProducer(meshId, second.tasks.find((t: any) => t.ref === 'produce').taskId);

    const byId = JSON.parse(await meshGraphNodePatch(ctx, {
        node: secondConsumeNodeId,
        base_spec_patch: repair,
    }));
    assert.equal(byId.success, true, JSON.stringify(byId));
    assert.equal(byId.nodeId, secondConsumeNodeId);
    assert.equal(byId.recovered, true);
});

test('node-patch: the mutation is AUDITED, recording patched key names but never their values', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    await blockedFixture(ctx, meshId);

    await meshGraphNodePatch(ctx, {
        node: 'consume',
        base_spec_patch: {
            inputs_from: [{ from: 'produce', select: '/worker_result/rootCause', as: 'report', required: true }],
        },
    });

    const entries = readLocalRecords(meshId).filter((e: any) => e.kind === 'graph_node_patched');
    assert.equal(entries.length, 1, 'a spec mutation must leave an audit record');
    const payload = entries[0].payload as any;
    assert.deepEqual(payload.patchedKeys, ['inputs_from']);
    assert.equal(payload.outcome, 'materialized');
    // The base spec is otherwise the immutable plan; the ledger records THAT it
    // changed and whether the retry worked — not the plan content itself.
    assert.ok(!JSON.stringify(payload).includes('rootCause'), 'patch VALUES must not be copied into the ledger');
});
