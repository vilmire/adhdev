import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import {
    meshEnqueueBatch,
    meshGraphGateClaim,
    meshGraphGateRelease,
    meshGraphGateAbandon,
    meshGraphView,
    ALL_MESH_TOOLS,
} from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { getQueue, updateTaskStatus, readLedgerEntries } from '@adhdev/daemon-core';

// GRAPH-ORCHESTRATION Phase E — the MCP exposure of the phase-C2 gate contract
// and the batch v2 plan surface.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :566-592 — batch v2; ★ "the prior two batches and 14 tasks would execute
//                identically" — the OLD REQUEST PATH MUST STAY GREEN.
//     :407-421 — claim hands out a monotonic generation + opaque fencing token;
//                release rejects stale fences and conflicting digests, and a
//                replay of the same key+digest is a no-op success.
//     :425-439 — NO auto_release. A timeout can only EXPIRE a gate.
//     :759-763 — the graph view.
//
// ★ The point of this file: before phase E, C2's claim/release existed but were
// unreachable from MCP, so a declared gate could never be passed by a coordinator.
// Every test below drives the gate through the REAL MCP tool functions — not the
// daemon-core core directly — because "callable as a tool" is the deliverable.

const NODE_MAC = 'node_mac_base';

function nextMeshId(): string {
    return `mesh_graph_e_${randomUUID().slice(0, 8)}`;
}

function recordingLocalTransport() {
    const commands: Array<{ cmd: string; args: any }> = [];
    return {
        commands,
        command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
        getStatus: async () => ({ sessions: [] }),
    } as any;
}

function recordingIpcTransport() {
    const commands: Array<{ cmd: string; args: any }> = [];
    const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
    const t = {
        commands,
        meshCommands,
        command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
        meshCommand: async (daemonId: string, cmd: string, args: any) => {
            meshCommands.push({ daemonId, cmd, args });
            return { success: true, sessions: [] };
        },
        getStatus: async () => ({ sessions: [] }),
    } as any;
    Object.setPrototypeOf(t, IpcTransport.prototype);
    return t;
}

function makeCtx(meshId: string, transport: any, coordinatorSessionId = 'sess-coord') {
    return {
        mesh: {
            id: meshId,
            nodes: [{ id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' }],
        },
        transport,
        coordinatorSessionId,
    } as any;
}

/** The canonical E fixture: build → gate(land) → deploy. */
async function enqueueGatedBatch(ctx: any, extra: Record<string, unknown> = {}) {
    return JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'build', message: 'build the thing', difficulty: 'easy' },
            { ref: 'deploy', message: 'deploy the thing', difficulty: 'easy', gated_by: ['land'] },
        ],
        gates: [
            { ref: 'land', action: 'refinery', instructions: 'Land after verifying patch equivalence.', depends_on: ['build'] },
        ],
        ...extra,
    } as any));
}

// ── E-1: the gate verbs are REACHABLE AS MCP TOOLS ───────────────────────────

test('E-1: the three graph tools are registered in ALL_MESH_TOOLS with required fields', () => {
    const byName = new Map(ALL_MESH_TOOLS.map(t => [t.name, t]));
    for (const name of ['mesh_graph_gate_claim', 'mesh_graph_gate_release', 'mesh_graph_view']) {
        assert.ok(byName.has(name), `${name} is not published in ALL_MESH_TOOLS`);
    }
    // The release tool must DEMAND the fence: a schema that made these optional
    // would invite callers to omit them and get a confusing runtime rejection.
    const release = byName.get('mesh_graph_gate_release')!;
    for (const field of ['gate_id', 'fencing_token', 'lease_generation', 'idempotency_key', 'outcome']) {
        assert.ok(
            (release.inputSchema as any).required.includes(field),
            `mesh_graph_gate_release must require ${field}`,
        );
    }
    // ★ design :431-432 — there is deliberately NO tool that force-passes a gate.
    const forceish = ALL_MESH_TOOLS.filter(t =>
        /gate/.test(t.name) && /(force|auto_release|expire|skip)/.test(t.name));
    assert.deepEqual(forceish.map(t => t.name), [], 'no tool may force/auto-release a gate');
});

test('E-1: full gate lifecycle through the MCP tools — declared → awaiting → claimed → released → downstream runs', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    assert.equal(batch.success, true);
    assert.equal(batch.gates.length, 1);
    const gateId = batch.gates[0].gateId;
    const buildTaskId = batch.tasks.find((t: any) => t.ref === 'build').taskId;
    const deployTaskId = batch.tasks.find((t: any) => t.ref === 'deploy').taskId;

    // A gate whose predecessor has not completed is NOT claimable yet.
    const early = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    assert.equal(early.success, false);
    assert.equal(early.code, 'gate_not_awaiting');

    // Completing the predecessor OPENS the gate and blocks downstream.
    updateTaskStatus(meshId, buildTaskId, 'completed');
    const deployBlocked = getQueue(meshId).find(t => t.id === deployTaskId)!;
    assert.equal(deployBlocked.status, 'pending');
    assert.ok(deployBlocked.blockedReason, 'the gate must hold its downstream task');

    // ★ CLAIM through the tool: this is what phase E adds.
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    assert.equal(claim.success, true, JSON.stringify(claim));
    assert.equal(claim.claimed, true);
    assert.equal(claim.action, 'refinery');
    assert.ok(claim.fencingToken, 'claim must hand out an opaque fencing token');
    assert.equal(typeof claim.leaseGeneration, 'number');
    assert.ok(claim.leaseGeneration >= 1, 'the generation must advance on claim');

    // ★ RELEASE through the tool — the only way through the gate.
    const release = JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'release-1',
        outcome: 'passed',
        result: { merged_sha: 'abc123' },
    }));
    assert.equal(release.success, true, JSON.stringify(release));
    assert.equal(release.released, true);
    assert.equal(release.duplicate, false);
    assert.equal(release.materializedCount, 1, 'the release must materialize the gated task');

    // Downstream is now claimable — the whole point of passing the gate.
    const deployAfter = getQueue(meshId).find(t => t.id === deployTaskId)!;
    assert.equal(deployAfter.status, 'pending');
    assert.equal(deployAfter.blockedReason, undefined, 'a released gate must clear its own hold');
});

test('E-1: a stale fence can never release (design :417)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    const gateId = batch.gates[0].gateId;
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));

    const wrongToken = JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId,
        fencing_token: 'not-the-real-token',
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'bad-1',
        outcome: 'passed',
    }));
    assert.equal(wrongToken.success, false);
    assert.equal(wrongToken.code, 'stale_fence');

    const wrongGeneration = JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration + 5,
        idempotency_key: 'bad-2',
        outcome: 'passed',
    }));
    assert.equal(wrongGeneration.success, false);
    assert.equal(wrongGeneration.code, 'stale_fence');

    // The gate survived both rejections and is still releasable by its real owner.
    const good = JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'good-1',
        outcome: 'passed',
    }));
    assert.equal(good.success, true);
});

test('E-1: replayed release is a no-op success; the same key with a different payload conflicts (design :420-421)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    const gateId = batch.gates[0].gateId;
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));

    const payload = {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'same-key',
        outcome: 'passed',
    };
    const first = JSON.parse(await meshGraphGateRelease(ctx, payload));
    assert.equal(first.success, true);
    assert.equal(first.duplicate, false);

    const replay = JSON.parse(await meshGraphGateRelease(ctx, payload));
    assert.equal(replay.success, true, 'an identical replay is a SAFE no-op, not an error');
    assert.equal(replay.duplicate, true);

    const conflicting = JSON.parse(await meshGraphGateRelease(ctx, { ...payload, outcome: 'rejected' }));
    assert.equal(conflicting.success, false);
    assert.equal(conflicting.code, 'gate_release_conflict');
});

test('E-1: a foreign live lease blocks a second claimant (design :407)', async () => {
    const meshId = nextMeshId();
    const ctxA = makeCtx(meshId, recordingLocalTransport(), 'sess-A');
    const ctxB = makeCtx(meshId, recordingLocalTransport(), 'sess-B');
    const batch = await enqueueGatedBatch(ctxA);
    const gateId = batch.gates[0].gateId;
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const claimA = JSON.parse(await meshGraphGateClaim(ctxA, { gate_id: gateId }));
    assert.equal(claimA.claimed, true);

    const claimB = JSON.parse(await meshGraphGateClaim(ctxB, { gate_id: gateId }));
    assert.equal(claimB.success, false);
    assert.equal(claimB.code, 'gate_lease_held');

    // B cannot release what it never claimed, even guessing A's generation.
    const stealAttempt = JSON.parse(await meshGraphGateRelease(ctxB, {
        gate_id: gateId,
        fencing_token: 'guessed',
        lease_generation: claimA.leaseGeneration,
        idempotency_key: 'steal',
        outcome: 'passed',
    }));
    assert.equal(stealAttempt.success, false);
    assert.equal(stealAttempt.code, 'stale_fence');
});

test('E-1: an unknown gate and a missing fence fail with structured codes, not prose', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());

    const noGate = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: randomUUID() }));
    assert.equal(noGate.success, false);
    assert.equal(noGate.code, 'gate_not_found');

    const noId = JSON.parse(await meshGraphGateClaim(ctx, {}));
    assert.equal(noId.code, 'missing_gate_id');

    const missingFields = JSON.parse(await meshGraphGateRelease(ctx, { gate_id: 'g' } as any));
    assert.equal(missingFields.code, 'missing_release_fields');
    assert.deepEqual(
        missingFields.missing.sort(),
        ['fencing_token', 'idempotency_key', 'lease_generation', 'outcome'],
    );
});

// ── E-2: batch v2, and the OLD PATH staying green ────────────────────────────

test('E-2 ★ OLD PATH GREEN: a plain depends_on batch creates NO graph and blocks nothing', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const res = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'verify', message: 'verify the fix', depends_on: ['fix'], difficulty: 'easy' },
            { ref: 'fix', message: 'apply the fix', depends_on: ['investigate'], difficulty: 'easy' },
            { ref: 'investigate', message: 'find the bug', difficulty: 'easy' },
        ],
    } as any));

    assert.equal(res.success, true);
    assert.equal(res.enqueued, 3);
    // ★ design :582 — graph fields are additive and must be ABSENT on the old path.
    assert.equal(res.graphId, undefined, 'a static batch must not manufacture a graph');
    assert.equal(res.batchId, undefined);
    assert.equal(res.graphHeldTasks, undefined);

    // ★ design :580 — "no graph-owned block is added merely because a task has
    // dependencies". Every row, roots and dependents alike, is unblocked; the
    // unchanged queue predicate is what keeps dependents from being claimed.
    const queue = getQueue(meshId);
    assert.equal(queue.length, 3);
    for (const row of queue) {
        assert.equal(row.status, 'pending');
        assert.equal(row.blockedReason, undefined, `task ${row.id} must not carry a graph block`);
    }
    // Dependency wiring is untouched.
    const fix = queue.find(t => t.message === 'apply the fix')!;
    const investigate = queue.find(t => t.message === 'find the bug')!;
    assert.deepEqual(fix.dependsOn, [investigate.id]);
});

test('E-2 ★ OLD PATH GREEN: eager push still fires for roots and defers dependents', async () => {
    const meshId = nextMeshId();
    const transport = recordingIpcTransport();
    const ctx = makeCtx(meshId, transport);
    const res = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'root', message: 'root work', difficulty: 'easy' },
            { ref: 'child', message: 'child work', depends_on: ['root'], difficulty: 'easy' },
        ],
    } as any));
    assert.equal(res.success, true);
    assert.equal(res.eagerPushDeferred, 1, 'the dependent must be deferred, the root pushed');
    assert.ok(transport.meshCommands.length > 0, 'the root must still be eager-pushed');
});

test('E-2: on_dependency_failure is PERSISTED on the graph row (C3 left this to E)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const res = await enqueueGatedBatch(ctx, { on_dependency_failure: 'cancel' });
    assert.equal(res.success, true);
    assert.equal(res.on_dependency_failure, 'cancel');
    assert.ok(res.graphId, 'a gated batch must create a graph');

    // Read it back from the persisted graph — the echo alone was C3's behavior.
    const view = JSON.parse(await meshGraphView(ctx, { graph_id: res.graphId }));
    assert.equal(view.success, true);
    assert.equal(view.graphs.length, 1);
    assert.equal(
        view.graphs[0].onDependencyFailure, 'cancel',
        'on_dependency_failure must survive as graph state, not just an echoed argument',
    );

    // An invalid value is still rejected loudly rather than silently defaulting.
    const bad = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'a', message: 'x', difficulty: 'easy' }],
        on_dependency_failure: 'explode',
    } as any));
    assert.equal(bad.success, false);
    assert.equal(bad.code, 'invalid_on_dependency_failure');
});

test('E-2: advanced tasks are held, static siblings are not', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const res = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'scan', message: 'scan the repo', difficulty: 'easy' },
            { ref: 'plain', message: 'unrelated static work', difficulty: 'easy' },
            {
                ref: 'summarize', message: 'summarize the scan', difficulty: 'easy',
                depends_on: ['scan'],
                inputs_from: [{ from: 'scan', select: '/summary', as: 'scan_summary' }],
            },
        ],
    } as any));
    assert.equal(res.success, true);
    assert.ok(res.graphId, 'inputs_from must take the graph path');
    assert.equal(res.graphHeldTasks, 1, 'exactly the bound task is held');

    const queue = getQueue(meshId);
    const held = queue.find(t => t.message === 'summarize the scan')!;
    const plain = queue.find(t => t.message === 'unrelated static work')!;
    const scan = queue.find(t => t.message === 'scan the repo')!;
    assert.ok(held.blockedReason, 'a task binding upstream output cannot run before it is bound');
    assert.equal(plain.blockedReason, undefined, 'a static sibling must not be swept into the hold');
    assert.equal(scan.blockedReason, undefined, 'a root must never be held');
});

test('E-2: ref namespace and gate wiring are validated before anything is inserted', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());

    // A gate ref colliding with a task ref.
    const collision = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'land', message: 'work', difficulty: 'easy' }],
        gates: [{ ref: 'land', action: 'refinery' }],
    } as any));
    assert.equal(collision.success, false);
    assert.equal(collision.code, 'duplicate_graph_ref');

    // ★ A gate in depends_on is refused: a gate is an intentional stop, and
    // projecting it into the queue's dependsOn would let ordinary completion
    // logic satisfy it, side-stepping the gate entirely.
    const gateAsDep = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'deploy', message: 'deploy', difficulty: 'easy', depends_on: ['land'] }],
        gates: [{ ref: 'land', action: 'deploy' }],
    } as any));
    assert.equal(gateAsDep.success, false);
    assert.equal(gateAsDep.code, 'gate_ref_in_depends_on');

    const unknownGate = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'deploy', message: 'deploy', difficulty: 'easy', gated_by: ['nope'] }],
        gates: [{ ref: 'land', action: 'deploy' }],
    } as any));
    assert.equal(unknownGate.success, false);
    assert.equal(unknownGate.code, 'unknown_gate_ref');

    const badTimeout = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'deploy', message: 'deploy', difficulty: 'easy', gated_by: ['land'] }],
        gates: [{ ref: 'land', action: 'deploy', on_timeout: 'auto_release' }],
    } as any));
    assert.equal(badTimeout.success, false, 'auto_release is not a policy and must be rejected');
    assert.equal(badTimeout.code, 'invalid_gate_on_timeout');

    assert.equal(getQueue(meshId).length, 0, 'no rejected plan may leave rows behind');
});

test('E-2: batch_id makes a retry idempotent and a changed plan a conflict (design :118-120)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batchId = `batch-${randomUUID().slice(0, 8)}`;

    const first = await enqueueGatedBatch(ctx, { batch_id: batchId });
    assert.equal(first.success, true);
    assert.equal(first.replayed, undefined);
    assert.equal(getQueue(meshId).length, 2);

    const replay = await enqueueGatedBatch(ctx, { batch_id: batchId, allow_duplicate: true });
    assert.equal(replay.success, true);
    assert.equal(replay.replayed, true, 'an identical retry must replay, not double-insert');
    assert.equal(replay.graphId, first.graphId);
    assert.equal(getQueue(meshId).length, 2, 'a replay must not insert new rows');

    const changed = JSON.parse(await meshEnqueueBatch(ctx, {
        batch_id: batchId,
        allow_duplicate: true,
        tasks: [{ ref: 'build', message: 'a DIFFERENT plan', difficulty: 'easy' }],
    } as any));
    assert.equal(changed.success, false);
    assert.equal(changed.code, 'batch_id_conflict');
});

// ── E-3: the graph view ──────────────────────────────────────────────────────

test('E-3: the view reports node states, the waiting gate, and the next coordinator action', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const view = JSON.parse(await meshGraphView(ctx, {}));
    assert.equal(view.success, true);
    assert.equal(view.graphCount, 1);
    const graph = view.graphs[0];
    assert.equal(graph.counts.tasks, 2);
    assert.equal(graph.counts.gates, 1);
    assert.equal(graph.gates[0].state, 'awaiting_coordinator');
    assert.deepEqual(graph.gates[0].blocking, ['deploy'], 'the view must say WHAT the gate is holding');

    // ★ The action must name the gate the coordinator has to act on.
    assert.ok(Array.isArray(view.pendingCoordinatorActions));
    assert.equal(view.pendingCoordinatorActions[0].kind, 'gate_awaiting');
    assert.equal(view.pendingCoordinatorActions[0].gateId, batch.gates[0].gateId);

    // After the release the graph is settled and stops asking for attention.
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: batch.gates[0].gateId }));
    await meshGraphGateRelease(ctx, {
        gate_id: batch.gates[0].gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'k1',
        outcome: 'passed',
    });
    const after = JSON.parse(await meshGraphView(ctx, { graph_id: graph.graphId }));
    assert.equal(after.graphs[0].gates[0].state, 'released');
    assert.equal(after.pendingCoordinatorActions, undefined, 'a released gate must stop requesting action');
});

test('E-3: an old-path batch produces no graph, and the view says so instead of inventing one', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'a', message: 'static work', difficulty: 'easy' }],
    } as any);

    const view = JSON.parse(await meshGraphView(ctx, {}));
    assert.equal(view.success, true);
    assert.equal(view.graphCount, 0);
    assert.match(view.hint, /plain depends_on batch/);
});

// ── E-4: ledger provenance ───────────────────────────────────────────────────

test('E-4: a committed graph writes provenance with counts and digests — and no message text', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const secret = `do-not-log-${randomUUID()}`;
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'build', message: secret, difficulty: 'easy' },
            { ref: 'deploy', message: 'deploy the thing', difficulty: 'easy', gated_by: ['land'] },
        ],
        gates: [{ ref: 'land', action: 'refinery', depends_on: ['build'] }],
        orchestration_decision: { decision: 'batch', ready_worker_tasks: 1, known_graph_steps: 3 },
    } as any));
    assert.equal(batch.success, true);

    const entries = readLedgerEntries(meshId, { kind: ['graph_enqueue_committed'] } as any);
    assert.equal(entries.length, 1, 'a committed graph must leave exactly one provenance entry');
    const payload = entries[0].payload as any;
    assert.equal(payload.graphId, batch.graphId);
    assert.equal(payload.taskCount, 2);
    assert.equal(payload.gateCount, 1);
    assert.equal(payload.onDependencyFailure, 'block');
    assert.ok(payload.planDigest, 'the plan digest makes the plan auditable without storing it');
    assert.equal(payload.orchestrationDecision.known_graph_steps, 3);

    // ★ design :737-738 — "Message contents and bound output values are excluded".
    // The whole ledger entry is searched, not just the fields we happen to name.
    assert.equal(
        JSON.stringify(entries[0]).includes(secret), false,
        'a task message must never reach a graph provenance payload',
    );
});

test('E-4: gate claim and release are recorded; the release records the outcome, not the evidence body', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    const gateId = batch.gates[0].gateId;
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    const evidenceSecret = `evidence-body-${randomUUID()}`;
    await meshGraphGateRelease(ctx, {
        gate_id: gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'k1',
        outcome: 'passed',
        evidence: { note: evidenceSecret },
    });

    const claimed = readLedgerEntries(meshId, { kind: ['graph_gate_claimed'] } as any);
    assert.equal(claimed.length, 1);
    assert.equal((claimed[0].payload as any).gateId, gateId);
    assert.equal((claimed[0].payload as any).action, 'refinery');

    const released = readLedgerEntries(meshId, { kind: ['graph_gate_released'] } as any);
    assert.equal(released.length, 1);
    assert.equal((released[0].payload as any).outcome, 'passed');
    assert.ok((released[0].payload as any).releaseDigest, 'the evidence is recorded as a digest');
    assert.equal(
        JSON.stringify(released[0]).includes(evidenceSecret), false,
        'the evidence BODY must not be copied into the ledger — only its digest',
    );
});

test('E-4: a rejected plan records a rollback entry and inserts nothing', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const res = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'deploy', message: 'deploy', difficulty: 'easy', gated_by: ['missing'] }],
        gates: [{ ref: 'land', action: 'deploy' }],
    } as any));
    assert.equal(res.success, false);
    assert.equal(getQueue(meshId).length, 0);

    const rolledBack = readLedgerEntries(meshId, { kind: ['graph_enqueue_rolled_back'] } as any);
    assert.equal(rolledBack.length, 1);
    assert.equal((rolledBack[0].payload as any).code, 'unknown_gate_ref');
});

test('E-4: a single-tool decision claiming a superseded blocker gets the batch_capability_available warning', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    // The batch surface itself never warns — the warning is for callers who said
    // they COULDN'T batch for a reason v2 now covers.
    const res = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'a', message: 'work', difficulty: 'easy' }],
        orchestration_decision: { decision: 'batch', known_graph_steps: 2 },
    } as any));
    assert.equal(res.success, true);
    assert.equal(res.batchCapabilityAvailable, undefined);
});

// ── E-4: `mesh_graph_gate_abandon` — the graph can reach a terminal state ────
//
// ★ The defect this closes: cancelling the work behind a gate left the gate
// `awaiting_coordinator` with no tool able to touch it — the C3 cancel cascade
// skips gate nodes by design, the deadline sweep skips gates with no deadline,
// and `classifyGraphRollup` refuses to classify while any gate is unsettled. The
// graph could reach NO terminal state, not even `cancelled`. Every test here goes
// through the REAL MCP tool, because "callable by a coordinator" is the deliverable.

test('E-4: mesh_graph_gate_abandon is registered and demands a reason', () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_graph_gate_abandon');
    assert.ok(tool, 'mesh_graph_gate_abandon is not published in ALL_MESH_TOOLS');
    for (const field of ['gate_id', 'reason']) {
        assert.ok(
            (tool!.inputSchema as any).required.includes(field),
            `mesh_graph_gate_abandon must require ${field}`,
        );
    }
    // ★ The description must not read as a way THROUGH a gate — that is the
    // force-release the module header forbids, and an LLM picks tools by prose.
    assert.match(tool!.description, /NOT A PASS/i);
    assert.match(tool!.description, /mesh_graph_gate_release/);
});

test('E-4: abandoning a stranded gate cancels downstream and lets the graph go terminal', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    const gateId = batch.gates[0].gateId;
    const buildTaskId = batch.tasks.find((t: any) => t.ref === 'build').taskId;
    const deployTaskId = batch.tasks.find((t: any) => t.ref === 'deploy').taskId;

    updateTaskStatus(meshId, buildTaskId, 'completed');
    // The gate is open and holding deploy — and it has no deadline, so nothing
    // in the system will ever close it on its own.
    const before = JSON.parse(await meshGraphView(ctx, { graph_id: batch.graphId }));
    assert.equal(before.graphs[0].status, 'waiting_gate');

    const res = JSON.parse(await meshGraphGateAbandon(ctx, {
        gate_id: gateId,
        reason: 'implementation task cancelled — nothing left to land',
    }));
    assert.equal(res.success, true);
    assert.equal(res.abandoned, true);
    // ★ Abandon opened NOTHING.
    assert.deepEqual(res.materializedNodeIds, []);
    assert.equal(res.cancelledCount, 1);

    // Downstream is cancelled, not dispatched.
    const deploy = getQueue(meshId).find(t => t.id === deployTaskId)!;
    assert.equal(deploy.status, 'cancelled');

    // ★ THE DoD: a graph that could reach no terminal state now reaches one.
    const after = JSON.parse(await meshGraphView(ctx, { graph_id: batch.graphId, include_terminal: true }));
    assert.equal(after.graphs[0].status, 'cancelled');
    assert.ok(after.graphs[0].terminalAt, 'the graph must be stamped terminal');
    assert.deepEqual(after.graphs[0].nextCoordinatorAction ?? [], []);
});

test('E-4: an abandoned gate can never then be claimed or released through the tools', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    const gateId = batch.gates[0].gateId;
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');

    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    assert.equal(claim.claimed, true);
    // A live lease is protected: the holder may be mid-action.
    const refused = JSON.parse(await meshGraphGateAbandon(ctx, { gate_id: gateId, reason: 'cleanup' }));
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'gate_lease_held');

    const forced = JSON.parse(await meshGraphGateAbandon(ctx, { gate_id: gateId, reason: 'holder is dead', force: true }));
    assert.equal(forced.abandoned, true);

    const reclaim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    assert.equal(reclaim.claimed, false);
    assert.equal(reclaim.code, 'gate_terminal:cancelled');

    // The pre-abandon fence is worthless — abandon is terminal, not a pause.
    const release = JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId, fencing_token: claim.fencingToken, lease_generation: claim.leaseGeneration,
        idempotency_key: 'k-after-abandon', outcome: 'passed',
    }));
    assert.equal(release.success, false);
    assert.equal(release.code, 'gate_not_claimed');
});

test('E-4: a RELEASED gate is refused, and re-abandoning is a safe no-op', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    const gateId = batch.gates[0].gateId;
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId }));
    await meshGraphGateRelease(ctx, {
        gate_id: gateId, fencing_token: claim.fencingToken, lease_generation: claim.leaseGeneration,
        idempotency_key: 'rel-1', outcome: 'passed',
    });

    const tooLate = JSON.parse(await meshGraphGateAbandon(ctx, { gate_id: gateId, reason: 'too late' }));
    assert.equal(tooLate.success, false);
    assert.equal(tooLate.code, 'gate_terminal:released');

    // A second graph, abandoned twice.
    const ctx2 = makeCtx(nextMeshId(), recordingLocalTransport());
    const b2 = await enqueueGatedBatch(ctx2);
    updateTaskStatus(ctx2.mesh.id, b2.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');
    const first = JSON.parse(await meshGraphGateAbandon(ctx2, { gate_id: b2.gates[0].gateId, reason: 'once' }));
    assert.equal(first.duplicate, false);
    const second = JSON.parse(await meshGraphGateAbandon(ctx2, { gate_id: b2.gates[0].gateId, reason: 'twice' }));
    assert.equal(second.abandoned, true);
    assert.equal(second.duplicate, true);
});

test('E-4: the abandon is recorded in the ledger, distinctly from a release', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = await enqueueGatedBatch(ctx);
    updateTaskStatus(meshId, batch.tasks.find((t: any) => t.ref === 'build').taskId, 'completed');
    await meshGraphGateAbandon(ctx, { gate_id: batch.gates[0].gateId, reason: 'branch dropped' });

    const kinds = readLedgerEntries(meshId, { limit: 200 }).map((e: any) => e.kind);
    assert.ok(kinds.includes('graph_gate_abandoned'), 'the abandon must be auditable');
    // ★ It must NOT read as an approval in the audit trail.
    assert.ok(!kinds.includes('graph_gate_released'), 'an abandon must never be logged as a release');
});
