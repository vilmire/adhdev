import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import {
    meshEnqueueTask,
    meshEnqueueBatch,
    meshGraphGateClaim,
    meshGraphGateRelease,
    ALL_MESH_TOOLS,
} from '../src/tools/mesh-tools.js';
import { updateTaskStatus, readLedgerEntries } from '@adhdev/daemon-core';

// GRAPH-ADOPTION signals — P2 (single-surface orchestration_decision) and
// P3 (the materializedCount: 0 advisory).
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :692     — "The single tool should require an orchestration_decision"; optional
//                during compatibility rollout, producing a decision_missing metric.
//     :697-731 — the enqueue-decision record, the closed single_reason enum, the
//                superseded reasons, and the two adoption metrics.
//
// ★ WHY THIS FILE EXISTS. The adoption problem it measures is real and observed:
// a coordinator session that had graph-shaped work in front of it called
// mesh_enqueue_batch ZERO times. Phase E built the whole decision record but wired it
// to the BATCH surface only — so the one path worth measuring, the single enqueue,
// recorded nothing, and "declared eligible singles" (design :722-724) could not be
// computed at all. These tests pin the wiring, not the wording.
//
// ★ WARN-ONLY, deliberately. Nothing here asserts a single enqueue is rejected:
// orchestration_decision stays OPTIONAL (a required field breaks legacy/external
// clients and contradicts the warn-only staging in mesh-tool-schemas.ts :58-59), and
// an omitted record degrades to the decision_missing datapoint rather than an error.

const NODE_MAC = 'node_mac_base';

function nextMeshId(): string {
    return `mesh_adopt_${randomUUID().slice(0, 8)}`;
}

function recordingLocalTransport() {
    return {
        command: async () => ({ success: true }),
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

function singleDecisions(meshId: string) {
    return readLedgerEntries(meshId, { kind: ['single_enqueue_decision'] } as any);
}

// ── P2: the single tool accepts and records an orchestration_decision ─────────

test('P2: mesh_enqueue_task exposes orchestration_decision and does NOT require it', () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_enqueue_task')!;
    const props = (tool.inputSchema as any).properties;
    assert.ok(props.orchestration_decision, 'mesh_enqueue_task must expose orchestration_decision');
    assert.ok(props.orchestrationDecision, 'and its camelCase alias, like every other field here');

    // ★ The optionality is the contract, not an oversight — see the file header.
    assert.deepEqual(
        (tool.inputSchema as any).required, ['message', 'difficulty'],
        'orchestration_decision must stay OPTIONAL: requiring it breaks legacy clients and '
        + 'contradicts the warn-only rollout',
    );

    // The closed single_reason enum (design :707-713) must be discoverable from the
    // field's own description, otherwise a caller cannot know which values are legal.
    const decisionDoc: string = props.orchestration_decision.description;
    for (const reason of [
        'only_one_step_known', 'future_step_not_specifiable', 'same_session_continuation',
        'legacy_client', 'operator_override',
    ]) {
        assert.ok(
            decisionDoc.includes(reason),
            `the single_reason enum value '${reason}' must be documented on orchestration_decision`,
        );
    }
    // And the superseded reasons must be named as NOT blockers, so a caller does not
    // reach for one believing it justifies the single surface.
    for (const superseded of ['output_needed', 'workspace_unresolved', 'coordinator_action_between']) {
        assert.ok(decisionDoc.includes(superseded), `${superseded} must be documented as superseded`);
    }
});

test('P2: a declared single reason is recorded in the ledger against the enqueued task', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const res = JSON.parse(await meshEnqueueTask(ctx, {
        message: 'one terminal step',
        difficulty: 'easy',
        orchestration_decision: {
            decision: 'single',
            ready_worker_tasks: 1,
            known_graph_steps: 1,
            single_reason: 'only_one_step_known',
        },
    } as any));
    assert.equal(res.success, true);

    const entries = singleDecisions(meshId);
    assert.equal(entries.length, 1, 'a single enqueue must leave exactly one decision entry');
    const payload = entries[0].payload as any;
    assert.equal(payload.taskId, res.taskId);
    assert.equal(payload.enqueueSurface, 'single');
    assert.equal(payload.orchestrationDecision.decision, 'single');
    assert.equal(payload.orchestrationDecision.single_reason, 'only_one_step_known');
    assert.equal(payload.orchestrationDecision.known_graph_steps, 1);
    assert.equal(payload.coordinatorSessionId, 'sess-coord');
    // A correctly-declared single is not flagged at all.
    assert.equal(payload.declaredEligibleSingle, undefined);
    assert.equal(payload.decisionMissing, undefined);
    assert.equal(res.declaredEligibleSingle, undefined);
});

test('P2: an omitted decision still enqueues, and is recorded as decision_missing', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const res = JSON.parse(await meshEnqueueTask(ctx, {
        message: 'legacy caller, no decision',
        difficulty: 'easy',
    } as any));
    // ★ The enqueue must SUCCEED. Omission is a datapoint, never a rejection.
    assert.equal(res.success, true);
    assert.equal(res.orchestrationDecisionMissing, true);

    const payload = singleDecisions(meshId)[0].payload as any;
    assert.equal(payload.decisionMissing, true);
    assert.equal(payload.orchestrationDecision.decision, 'single');
    assert.equal(payload.orchestrationDecision.single_reason, null);
});

test('P2: declaring known_graph_steps >= 2 on the single tool is the declared-eligible-single metric', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const res = JSON.parse(await meshEnqueueTask(ctx, {
        message: 'first of several known steps',
        difficulty: 'easy',
        orchestration_decision: { decision: 'single', known_graph_steps: 3, single_reason: 'operator_override' },
    } as any));
    // Warn, never block (design :722-724 — rejection is phase F).
    assert.equal(res.success, true);
    assert.equal(res.declaredEligibleSingle, true);
    assert.match(res.declaredEligibleSingleHint, /mesh_enqueue_batch/);

    const payload = singleDecisions(meshId)[0].payload as any;
    assert.equal(payload.declaredEligibleSingle, true);
    assert.equal(payload.orchestrationDecision.known_graph_steps, 3);
});

test('P2: a superseded blocker on the single tool warns that batch already covers it', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    // 'output_needed' is exactly what inputs_from exists for — reporting it means the
    // caller has not adopted the batch surface, not that batching was impossible.
    const res = JSON.parse(await meshEnqueueTask(ctx, {
        message: 'needs the previous task output',
        difficulty: 'easy',
        orchestration_decision: { decision: 'single', single_reason: 'output_needed' },
    } as any));
    assert.equal(res.success, true, 'a superseded reason WARNS; it never rejects');
    assert.equal(res.batchCapabilityAvailable.code, 'batch_capability_available');
    assert.equal(res.batchCapabilityAvailable.reportedReason, 'output_needed');
    assert.match(res.batchCapabilityAvailable.message, /inputs_from/);

    const payload = singleDecisions(meshId)[0].payload as any;
    assert.equal(payload.batchCapabilityAvailable, 'output_needed');
});

test('P2: the decision payload carries no task message (content boundary)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const secret = `do-not-log-${randomUUID()}`;
    await meshEnqueueTask(ctx, {
        message: secret,
        difficulty: 'easy',
        orchestration_decision: { decision: 'single', single_reason: 'only_one_step_known' },
    } as any);
    // design :737-738 — identifiers, counts, enums and digests only. The WHOLE entry
    // is searched, not just the fields named above.
    assert.equal(
        JSON.stringify(singleDecisions(meshId)[0]).includes(secret), false,
        'a task message must never reach an enqueue-decision payload',
    );
});

test('P2: a rejected enqueue records no decision entry', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    // difficulty is required — this never inserts a task, so it must never leave a
    // decision row claiming one was planned.
    const res = JSON.parse(await meshEnqueueTask(ctx, {
        message: 'no difficulty given',
        orchestration_decision: { decision: 'single', single_reason: 'only_one_step_known' },
    } as any));
    assert.equal(res.success, false);
    assert.equal(singleDecisions(meshId).length, 0);
});

// ── P3: interpreting materializedCount: 0 ────────────────────────────────────

async function claimAndRelease(ctx: any, gateId: string, key: string) {
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    return JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: key,
        outcome: 'passed',
    }));
}

test('P3: a gate nothing depends on, released while work remains, gets the no-downstream advisory', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    // 'approve' gates NOTHING — no task names it in gated_by — while 'later' is still
    // outstanding, so this release buys no scheduling at all.
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'build', message: 'build the thing', difficulty: 'easy' },
            { ref: 'later', message: 'unrelated remaining work', difficulty: 'easy' },
        ],
        gates: [{ ref: 'approve', action: 'approval', depends_on: ['build'] }],
    } as any));
    assert.equal(batch.success, true);
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const rel = await claimAndRelease(ctx, batch.gates[0].gateId, 'k-orphan');
    assert.equal(rel.success, true);
    assert.equal(rel.materializedCount, 0);
    assert.equal(rel.downstreamNodeCount, 0);
    assert.ok(rel.noDownstreamAdvisory, 'a gate that opened nothing must say so');
    assert.match(rel.noDownstreamAdvisory, /gated_by/);
});

test('P3: a TERMINAL gate that completes the graph is NOT flagged', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    // The approval IS the last act: build runs, then the gate ends the graph. This is
    // a legitimate shape (a graph may end at a gate) and must not be advised against.
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'build', message: 'build the thing', difficulty: 'easy' }],
        gates: [{ ref: 'signoff', action: 'approval', depends_on: ['build'] }],
    } as any));
    assert.equal(batch.success, true);
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const rel = await claimAndRelease(ctx, batch.gates[0].gateId, 'k-terminal');
    assert.equal(rel.success, true);
    assert.equal(rel.materializedCount, 0, 'a terminal gate materializes nothing by construction');
    assert.equal(rel.downstreamNodeCount, 0);
    assert.equal(
        rel.noDownstreamAdvisory, undefined,
        'a graph may legitimately END at a gate — flagging that would be a false positive',
    );
});

test('P3: a gate that DOES open downstream work reports the count and no advisory', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'build', message: 'build the thing', difficulty: 'easy' },
            { ref: 'deploy', message: 'deploy the thing', difficulty: 'easy', gated_by: ['land'] },
        ],
        gates: [{ ref: 'land', action: 'refinery', depends_on: ['build'] }],
    } as any));
    assert.equal(batch.success, true);
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const rel = await claimAndRelease(ctx, batch.gates[0].gateId, 'k-real');
    assert.equal(rel.success, true);
    assert.equal(rel.materializedCount, 1, 'releasing this gate dispatched the deploy');
    assert.equal(rel.downstreamNodeCount, 1);
    assert.equal(rel.noDownstreamAdvisory, undefined);
});

test('P3: a replayed release is a no-op success and carries no advisory', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId);
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'build', message: 'build the thing', difficulty: 'easy' }],
        gates: [{ ref: 'signoff', action: 'approval', depends_on: ['build'] }],
    } as any));
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');
    const gateId = batch.gates[0].gateId;

    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    const args = {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'k-replay',
        outcome: 'passed',
    };
    assert.equal(JSON.parse(await meshGraphGateRelease(ctx, args as any)).success, true);

    const replay = JSON.parse(await meshGraphGateRelease(ctx, args as any));
    assert.equal(replay.success, true);
    assert.equal(replay.duplicate, true);
    // ★ The replay path returns before the edges are read, so it has no downstream
    // knowledge — it must stay silent rather than guess.
    assert.equal(replay.noDownstreamAdvisory, undefined);
});
