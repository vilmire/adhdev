import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import {
    meshEnqueueBatch,
    meshGraphGateClaim,
    meshGraphGateRelease,
    meshGraphView,
} from '../src/tools/mesh-tools.js';
import { getQueue, updateTaskStatus, readLedgerEntries, runWorkspaceSagaTick } from '@adhdev/daemon-core';

// GRAPH-ORCHESTRATION Phase G — dogfood of the FOUR REAL OBSERVED CHAINS.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :921-933 — the four observed chains after implementation, and the claim
//                under test: "The result is 4/4 expressible as persistent graphs."
//     :373-423 — the coordinator gate contract (claim → fenced release; the daemon
//                never performs the action and never auto-passes a gate).
//     :338, :415 — a released gate exposes its outcome envelope (`/gate_outcome`,
//                `/result/...`, `/evidence/...`) to downstream run_if/inputs_from;
//                a release may patch still-pending DIRECT downstream nodes
//                (run_if/on_false/inputs_from/workspace_ref only).
//     :441-512 — delayed workspace_ref: preparation is a compensated saga that
//                runs in PARALLEL with the graph; binding a target is not passage.
//
// Every chain is driven end-to-end through the REAL MCP tool functions
// (mesh_enqueue_batch with v2 graph blocks → mesh_graph_gate_claim →
// mesh_graph_gate_release → mesh_graph_view), with worker completions injected
// through daemon-core's in-process store API — exactly like the phase-E harness
// in mesh-graph-tools.test.ts. The claim under test is the design's "4/4": any
// divergence is reported as a DEFECT, not patched over.
//
// One such divergence WAS found and is now fixed: an admission-time
// inputs_from/run_if binding against a gate ref deadlocked the downstream node.
// The last test in this file pins the designed (:338) behaviour it now has.

const NODE_MAC = 'node_mac_base';

function nextMeshId(): string {
    return `mesh_graph_g_${randomUUID().slice(0, 8)}`;
}

function recordingLocalTransport() {
    const commands: Array<{ cmd: string; args: any }> = [];
    return {
        commands,
        command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
        getStatus: async () => ({ sessions: [] }),
    } as any;
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

function taskId(batch: any, ref: string): string {
    return batch.tasks.find((t: any) => t.ref === ref).taskId;
}

function gateId(batch: any, ref: string): string {
    return batch.gates.find((g: any) => g.ref === ref).gateId;
}

function queueRow(meshId: string, id: string) {
    return getQueue(meshId).find(t => t.id === id)!;
}

async function claimGate(ctx: any, id: string) {
    const claim = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: id }));
    assert.equal(claim.success, true, `claim must succeed: ${JSON.stringify(claim)}`);
    assert.equal(claim.claimed, true);
    assert.ok(claim.fencingToken, 'claim must hand out an opaque fencing token');
    assert.equal(typeof claim.leaseGeneration, 'number');
    return claim;
}

async function releaseGate(ctx: any, claim: any, extra: Record<string, unknown>) {
    return JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: claim.gateId,
        fencing_token: claim.fencingToken,
        lease_generation: claim.leaseGeneration,
        ...extra,
    }));
}

async function viewGraph(ctx: any, graphId: string) {
    const view = JSON.parse(await meshGraphView(ctx, { graph_id: graphId }));
    assert.equal(view.success, true, JSON.stringify(view));
    assert.equal(view.graphs.length, 1);
    return view.graphs[0];
}

/**
 * Fake workspace saga ports, modelled on daemon-core's
 * test/mesh/mesh-graph-workspace-saga.test.ts createFakePorts: the clone is
 * injected, never modelled as an agent task, and no real git is touched.
 */
function fakeWorkspacePorts() {
    const state = { clones: 0, removes: 0 };
    const ports = {
        nowMs: () => Date.now(),
        createWorktree: async (req: any) => {
            state.clones += 1;
            return {
                nodeId: `node_ws_${req.workspaceRef}`,
                worktreePath: req.desiredPath || `/tmp/fake-ws/${req.graphId}/${req.workspaceRef}`,
                ownerTag: req.ownerTag,
            };
        },
        findOwnedWorktree: async () => null,
        inspectWorktree: async () => ({ pathExists: true, dirty: false, ahead: false, stashed: false, sessionBound: false }),
        removeWorktree: async () => { state.removes += 1; return { removed: true }; },
        listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: false }),
        listAssignedTasksOnNode: async () => [],
        registerNode: async () => true,
        unregisterNode: async () => true,
    } as any;
    return { ports, state };
}

// ── G-1: Implementation → Refinery → standalone gate validation ──────────────
// design :925 — implementation worker → `refinery` coordinator gate →
// validation worker; the gate release patches the landed SHA/target.

test('G-1: implementation → refinery gate → validation — the release patches the landed SHA/target through', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'implement', message: 'Implement the session-token fix.', difficulty: 'easy' },
            { ref: 'validate', message: 'Run the standalone gate validation.', difficulty: 'easy', gated_by: ['refine'] },
        ],
        gates: [
            { ref: 'refine', action: 'refinery', instructions: 'Land after verifying patch equivalence.', depends_on: ['implement'] },
        ],
    } as any));

    // Admission: one graph, one gate, the gated task held from the start.
    assert.equal(batch.success, true, JSON.stringify(batch));
    assert.ok(batch.graphId, 'a gated batch must create a persistent graph');
    assert.equal(batch.gates.length, 1);
    assert.equal(batch.gates[0].action, 'refinery');
    assert.equal(batch.graphHeldTasks, 1, 'exactly the gated task is held');

    const admitted = await viewGraph(ctx, batch.graphId);
    assert.equal(admitted.counts.tasks, 2);
    assert.equal(admitted.counts.gates, 1);
    assert.deepEqual(
        admitted.edges.map((e: any) => `${e.from}-${e.kind}->${e.to}`).sort(),
        ['implement-requires->refine', 'refine-gate->validate'],
        'the plan is registered up front: worker → gate → worker',
    );

    // The gate is not claimable before its predecessor completes.
    const early = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId(batch, 'refine') }));
    assert.equal(early.success, false);
    assert.equal(early.code, 'gate_not_awaiting');

    // ★ Upstream completion alone does NOT wake the downstream — the gate opens
    // and HOLDS the validation worker.
    updateTaskStatus(meshId, taskId(batch, 'implement'), 'completed');
    const held = queueRow(meshId, taskId(batch, 'validate'));
    assert.equal(held.status, 'pending');
    assert.equal(held.blockedReason, `coordinator_gate:${gateId(batch, 'refine')}`);
    const waiting = await viewGraph(ctx, batch.graphId);
    assert.equal(waiting.status, 'waiting_gate');
    assert.equal(waiting.gates[0].state, 'awaiting_coordinator');
    assert.deepEqual(waiting.gates[0].blocking, ['validate']);

    // A stale fence can never release — only the lease holder gets through.
    const claim = await claimGate(ctx, gateId(batch, 'refine'));
    assert.equal(claim.action, 'refinery');
    const stale = JSON.parse(await meshGraphGateRelease(ctx, {
        gate_id: gateId(batch, 'refine'),
        fencing_token: 'not-the-real-token',
        lease_generation: claim.leaseGeneration,
        idempotency_key: 'stale-1',
        outcome: 'passed',
    }));
    assert.equal(stale.success, false);
    assert.equal(stale.code, 'stale_fence');
    assert.equal(queueRow(meshId, taskId(batch, 'validate')).blockedReason, `coordinator_gate:${gateId(batch, 'refine')}`);

    // ★ The fenced release carries the landed SHA/target — as the gate result —
    // and PATCHES the still-pending validation node to bind them (design :415).
    const landedSha = `landed-${randomUUID().slice(0, 12)}`;
    const release = await releaseGate(ctx, claim, {
        idempotency_key: 'refine-release-1',
        outcome: 'passed',
        result: { landed_sha: landedSha, landed_target: 'main' },
        patches: [{
            node: 'validate',
            base_spec_patch: {
                inputs_from: [
                    { from: 'refine', select: '/result/landed_sha', as: 'landed_sha', required: true },
                    { from: 'refine', select: '/result/landed_target', as: 'landed_target', required: true },
                ],
            },
        }],
    });
    assert.equal(release.success, true, JSON.stringify(release));
    assert.equal(release.released, true);
    assert.equal(release.materializedCount, 1, 'the release materializes the gated validation worker');

    // The validation worker wakes EXACTLY ONCE, with the patch applied: the
    // landed SHA/target are bound into its message as untrusted evidence.
    const validate = queueRow(meshId, taskId(batch, 'validate'));
    assert.equal(validate.status, 'pending');
    assert.equal(validate.blockedReason, undefined, 'a released gate must clear its own hold');
    assert.ok(validate.message.startsWith('Run the standalone gate validation.'), 'the base instruction is immutable and first');
    assert.ok(validate.message.includes(landedSha), 'the landed SHA reached the validation worker');
    assert.ok(validate.message.includes('landed_target'), 'the landed target binding reached the validation worker');
    assert.match(validate.message, /trust="untrusted"/);
    assert.match(validate.message, /source_ref="refine"/);

    // A replayed release is a no-op success — it must not wake downstream twice.
    const replay = await releaseGate(ctx, claim, {
        idempotency_key: 'refine-release-1',
        outcome: 'passed',
        result: { landed_sha: landedSha, landed_target: 'main' },
        patches: [{
            node: 'validate',
            base_spec_patch: {
                inputs_from: [
                    { from: 'refine', select: '/result/landed_sha', as: 'landed_sha', required: true },
                    { from: 'refine', select: '/result/landed_target', as: 'landed_target', required: true },
                ],
            },
        }],
    });
    assert.equal(replay.success, true);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.materializedCount, 0, 'a replayed release never re-materializes');

    // Ledger provenance: the release is recorded with its outcome and a DIGEST
    // of the release payload — never the result body itself (design :737-738).
    // The replay is recorded too, marked duplicate and waking nothing.
    const releasedEntries = readLedgerEntries(meshId, { kind: ['graph_gate_released'] } as any);
    assert.equal(releasedEntries.length, 2, 'the real release AND its idempotent replay are both recorded');
    const [realRelease, duplicateRelease] = releasedEntries.map(e => e.payload as any);
    assert.equal(realRelease.outcome, 'passed');
    assert.ok(realRelease.releaseDigest);
    assert.equal(realRelease.duplicate, undefined);
    assert.deepEqual(realRelease.materializedNodeIds?.length, 1, 'the real release woke the validation worker');
    assert.equal(duplicateRelease.duplicate, true);
    assert.equal(duplicateRelease.materializedNodeIds, undefined, 'the duplicate release woke nothing');
    assert.equal(
        JSON.stringify(releasedEntries).includes(landedSha), false,
        'the landed SHA must not be copied into the ledger — only its digest',
    );

    // End state: validation completes and the whole graph rolls up.
    updateTaskStatus(meshId, taskId(batch, 'validate'), 'completed');
    const end = await viewGraph(ctx, batch.graphId);
    assert.equal(end.status, 'completed');
    assert.deepEqual(end.nodeStates, { completed: 2, released: 1 });
    assert.equal(end.gates[0].releaseOutcome, 'passed');
});

// ── G-2: Type fix → landing → deployment ─────────────────────────────────────
// design :926 — fix worker → `refinery` gate → `deploy` TERMINAL gate, with
// release outcomes and evidence. The graph legitimately ENDS at a gate
// (design :423).

test('G-2: type fix → refinery landing → terminal deploy gate — outcomes and evidence land in the ledger', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'fix', message: 'Fix the TS2322 in session-store.', difficulty: 'easy' },
        ],
        gates: [
            { ref: 'land', action: 'refinery', instructions: 'Land the type fix.', depends_on: ['fix'] },
            { ref: 'deploy', action: 'deploy', instructions: 'Deploy the landed build to production.', depends_on: ['land'] },
        ],
    } as any));
    assert.equal(batch.success, true, JSON.stringify(batch));
    assert.equal(batch.gates.length, 2);

    // Enqueue provenance: one worker, two gates, digested plan (design :733-743).
    const committed = readLedgerEntries(meshId, { kind: ['graph_enqueue_committed'] } as any);
    assert.equal(committed.length, 1);
    assert.equal((committed[0].payload as any).taskCount, 1);
    assert.equal((committed[0].payload as any).gateCount, 2);
    assert.ok((committed[0].payload as any).planDigest);

    // The deploy gate must not open before the landing it follows.
    updateTaskStatus(meshId, taskId(batch, 'fix'), 'completed');
    const earlyDeploy = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId(batch, 'deploy') }));
    assert.equal(earlyDeploy.success, false);
    assert.equal(earlyDeploy.code, 'gate_not_awaiting', 'a terminal gate still waits for its own predecessor');

    // Landing: fenced release with an outcome and review evidence.
    const landClaim = await claimGate(ctx, gateId(batch, 'land'));
    const landEvidenceSecret = `review-note-${randomUUID()}`;
    const landRelease = await releaseGate(ctx, landClaim, {
        idempotency_key: 'land-1',
        outcome: 'passed',
        result: { merged_sha: 'c0ffee42' },
        evidence: { note: landEvidenceSecret },
    });
    assert.equal(landRelease.success, true, JSON.stringify(landRelease));
    assert.equal(landRelease.materializedCount, 0, 'a gate downstream of a gate opens it instead of materializing a task');

    // The landing's release OPENS the terminal deploy gate (design :402-405).
    const awaiting = await viewGraph(ctx, batch.graphId);
    assert.equal(awaiting.gates.find((g: any) => g.ref === 'deploy').state, 'awaiting_coordinator');

    // Deploy: the terminal gate. Its release ends the graph (design :423).
    const deployClaim = await claimGate(ctx, gateId(batch, 'deploy'));
    assert.equal(deployClaim.action, 'deploy');
    const deployEvidenceSecret = `deploy-log-${randomUUID()}`;
    const deployRelease = await releaseGate(ctx, deployClaim, {
        idempotency_key: 'deploy-1',
        outcome: 'passed',
        result: { deploy_url: 'https://example.test/v1' },
        evidence: { log: deployEvidenceSecret },
    });
    assert.equal(deployRelease.success, true, JSON.stringify(deployRelease));

    // ★ Ledger provenance for BOTH gate decisions: outcome recorded, evidence
    // recorded as a digest, evidence BODIES never copied (design :737-738).
    const releases = readLedgerEntries(meshId, { kind: ['graph_gate_released'] } as any);
    assert.equal(releases.length, 2, 'both gate releases must be recorded');
    for (const entry of releases) {
        assert.equal((entry.payload as any).outcome, 'passed');
        assert.ok((entry.payload as any).releaseDigest, 'the evidence is recorded as a digest');
    }
    assert.equal(JSON.stringify(releases).includes(landEvidenceSecret), false, 'the land evidence body stays out of the ledger');
    assert.equal(JSON.stringify(releases).includes(deployEvidenceSecret), false, 'the deploy evidence body stays out of the ledger');
    const claims = readLedgerEntries(meshId, { kind: ['graph_gate_claimed'] } as any);
    assert.equal(claims.length, 2);

    // End state: the graph completed at its terminal gate.
    const end = await viewGraph(ctx, batch.graphId);
    assert.equal(end.status, 'completed', 'a graph may legitimately END at a released terminal gate');
    assert.deepEqual(end.nodeStates, { completed: 1, released: 2 });
    assert.equal(end.gates.find((g: any) => g.ref === 'land').releaseOutcome, 'passed');
    assert.equal(end.gates.find((g: any) => g.ref === 'deploy').releaseOutcome, 'passed');
    assert.equal(end.nextCoordinatorAction, undefined, 'a completed graph stops asking for attention');
});

// ── G-3: Codex investigation → owner decision → fix ──────────────────────────
// design :927 — investigation output binding (inputs_from) → `approval` gate
// carrying the owner decision → fix on a DELAYED workspace_ref (design :441-512).

test('G-3: investigation → approval gate → fix on a delayed workspace_ref (in-process workspace saga)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const rootCause = `mutex-ordering-inversion-${randomUUID().slice(0, 8)}`;
    const ownerDecision = `take-locks-in-lexical-order-${randomUUID().slice(0, 8)}`;
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'investigate', message: 'Investigate the codex deadlock (read-only).', difficulty: 'easy' },
            {
                ref: 'fix', message: 'Apply the owner-approved fix.', difficulty: 'easy',
                gated_by: ['approve'],
                workspace_ref: 'fix_ws',
                inputs_from: [{ from: 'investigate', select: '/worker_result/root_cause', as: 'root_cause', required: true }],
            },
        ],
        gates: [
            { ref: 'approve', action: 'approval', instructions: 'Owner decides the fix approach.', depends_on: ['investigate'] },
        ],
        workspaces: [{ ref: 'fix_ws', source_node_id: NODE_MAC, base_revision: 'main' }],
    } as any));

    // Admission: the whole plan — including the delayed worktree — is registered
    // up front. `atomic` covers the DB plan only; preparation is the saga
    // (design :585-588).
    assert.equal(batch.success, true, JSON.stringify(batch));
    assert.equal(batch.workspacePreparation, 'pending', 'DB atomicity never implies the git worktree exists');
    assert.equal(batch.workspaces.length, 1);
    assert.equal(batch.workspaces[0].sagaState, 'declared', 'the workspace intent is declared/registered for the graph');
    assert.ok(batch.workspaces[0].branchIdentity);
    const heldFix = queueRow(meshId, taskId(batch, 'fix'));
    assert.match(heldFix.blockedReason ?? '', /^graph_materialization_pending:/, 'an advanced node is held until the graph settles it');
    assert.equal(heldFix.targetNodeId, undefined, 'no target before the saga prepares the worktree');

    // Phase D saga, in-process with fake ports: the clone is injected, never
    // modelled as a queue task (design :441-478).
    const fake = fakeWorkspacePorts();
    const tick = await runWorkspaceSagaTick(meshId, fake.ports);
    assert.equal(fake.state.clones, 1);
    assert.equal(tick.steps[0]?.sagaState, 'ready');
    const wsReady = await viewGraph(ctx, batch.graphId);
    assert.equal(wsReady.workspaces[0].sagaState, 'ready');
    assert.equal(wsReady.workspaces[0].createdNodeId, 'node_ws_fix_ws');

    // ★ Preparation ran in PARALLEL, but binding a target is not passage: the
    // fix task is workspace-bound yet still held by the graph.
    const boundFix = queueRow(meshId, taskId(batch, 'fix'));
    assert.equal(boundFix.targetNodeId, 'node_ws_fix_ws');
    assert.ok(boundFix.requiredTags?.some((t: string) => t.startsWith('worktree=')));
    assert.ok(boundFix.blockedReason, 'the fix must not be claimable before investigation + approval');

    // Investigation completes with a structured output. The approval gate opens;
    // the fix stays gate-held and its message carries NOTHING bound yet.
    updateTaskStatus(meshId, taskId(batch, 'investigate'), 'completed', {
        envelope: { workerResult: { root_cause: rootCause } },
    } as any);
    const gatedFix = queueRow(meshId, taskId(batch, 'fix'));
    assert.equal(gatedFix.blockedReason, `coordinator_gate:${gateId(batch, 'approve')}`);
    assert.equal(gatedFix.message, 'Apply the owner-approved fix.', 'no binding lands before the fenced release');
    assert.equal(gatedFix.message.includes(rootCause), false);
    assert.equal(gatedFix.message.includes(ownerDecision), false);

    // ★ The owner decision rides the approval release (design :338, :415): the
    // release result carries it and the patch binds it into the fix — alongside
    // the investigation's root cause declared at admission time.
    const claim = await claimGate(ctx, gateId(batch, 'approve'));
    assert.equal(claim.action, 'approval');
    const release = await releaseGate(ctx, claim, {
        idempotency_key: 'approve-1',
        outcome: 'passed',
        result: { decision: 'approve', approved_approach: ownerDecision },
        patches: [{
            node: 'fix',
            base_spec_patch: {
                inputs_from: [
                    { from: 'investigate', select: '/worker_result/root_cause', as: 'root_cause', required: true },
                    { from: 'approve', select: '/result/approved_approach', as: 'owner_decision', required: true },
                ],
            },
        }],
    });
    assert.equal(release.success, true, JSON.stringify(release));
    assert.equal(release.materializedCount, 1);

    // ONLY NOW does the fix worker's message contain both bound values — the
    // investigation output bound through inputs_from, and the owner decision
    // carried by the approval gate release.
    const fix = queueRow(meshId, taskId(batch, 'fix'));
    assert.equal(fix.status, 'pending');
    assert.equal(fix.blockedReason, undefined);
    assert.ok(fix.message.startsWith('Apply the owner-approved fix.'));
    assert.ok(fix.message.includes(rootCause), 'the investigation output bound through inputs_from');
    assert.ok(fix.message.includes(ownerDecision), 'the owner decision arrived via the approval release');
    assert.match(fix.message, /source_ref="investigate"/);
    assert.match(fix.message, /source_ref="approve"/);
    assert.equal(fix.targetNodeId, 'node_ws_fix_ws', 'the delayed workspace_ref is the dispatch target');

    // End state: the fix lands on its prepared worktree and the graph completes.
    updateTaskStatus(meshId, taskId(batch, 'fix'), 'completed');
    const end = await viewGraph(ctx, batch.graphId);
    assert.equal(end.status, 'completed');
    assert.deepEqual(end.nodeStates, { completed: 2, released: 1 });
    assert.equal(end.workspaces[0].sagaState, 'ready');
});

// ── G-4: OSS bump → CI publish wait → root bump → production deploy ──────────
// design :928 — bump worker → `ci_wait` gate with pass/fail outcome → root-bump
// worker → `deploy` terminal gate.

test('G-4 pass: ci_wait released with a pass outcome runs root-bump and ends at the deploy terminal gate', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'bump', message: 'Bump the OSS package version and publish.', difficulty: 'easy' },
            { ref: 'root_bump', message: 'Bump the root package to the published OSS version.', difficulty: 'easy', gated_by: ['ci'] },
        ],
        gates: [
            { ref: 'ci', action: 'ci_wait', instructions: 'Wait for the publish CI run.', depends_on: ['bump'] },
            { ref: 'deploy', action: 'deploy', instructions: 'Deploy the root bump to production.', depends_on: ['root_bump'] },
        ],
    } as any));
    assert.equal(batch.success, true, JSON.stringify(batch));
    assert.equal(batch.gates.length, 2);

    // Root-bump does NOT wake on the bump completing alone — CI is an
    // intentional stop; nor can the deploy gate open early.
    updateTaskStatus(meshId, taskId(batch, 'bump'), 'completed');
    assert.equal(queueRow(meshId, taskId(batch, 'root_bump')).blockedReason, `coordinator_gate:${gateId(batch, 'ci')}`);
    const earlyDeploy = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId(batch, 'deploy') }));
    assert.equal(earlyDeploy.code, 'gate_not_awaiting');

    // CI went green: fenced release with the pass outcome + run evidence.
    const ciClaim = await claimGate(ctx, gateId(batch, 'ci'));
    assert.equal(ciClaim.action, 'ci_wait');
    const ciRelease = await releaseGate(ctx, ciClaim, {
        idempotency_key: 'ci-pass-1',
        outcome: 'passed',
        evidence: { ci_run: 'https://ci.example/run/42', conclusion: 'success' },
    });
    assert.equal(ciRelease.success, true, JSON.stringify(ciRelease));
    assert.equal(ciRelease.materializedCount, 1, 'the pass outcome wakes root-bump exactly once');
    assert.equal(queueRow(meshId, taskId(batch, 'root_bump')).blockedReason, undefined);

    // Root-bump runs and completes, which OPENS the terminal deploy gate.
    updateTaskStatus(meshId, taskId(batch, 'root_bump'), 'completed');
    const awaiting = await viewGraph(ctx, batch.graphId);
    assert.equal(awaiting.gates.find((g: any) => g.ref === 'deploy').state, 'awaiting_coordinator');

    const deployClaim = await claimGate(ctx, gateId(batch, 'deploy'));
    const deployRelease = await releaseGate(ctx, deployClaim, {
        idempotency_key: 'deploy-1',
        outcome: 'passed',
        result: { deploy_url: 'https://example.test/prod' },
    });
    assert.equal(deployRelease.success, true, JSON.stringify(deployRelease));

    // Ledger: the CI gate's pass outcome is recorded with its evidence digest.
    const releases = readLedgerEntries(meshId, { kind: ['graph_gate_released'] } as any);
    assert.equal(releases.length, 2);
    assert.deepEqual(releases.map(e => (e.payload as any).outcome).sort(), ['passed', 'passed']);
    for (const entry of releases) assert.ok((entry.payload as any).releaseDigest);

    const end = await viewGraph(ctx, batch.graphId);
    assert.equal(end.status, 'completed');
    assert.deepEqual(end.nodeStates, { completed: 2, released: 2 });
});

test('G-4 fail: ci_wait released with a FAIL outcome — root-bump never runs and production deploy never opens', async () => {
    // NOTE — the gate-outcome condition is declared through the release-time
    // PATCH surface (design :415: the permitted patch keys are exactly
    // run_if/on_false/inputs_from/workspace_ref). The admission-time spelling of
    // the same condition (`run_if` with `from: <gate ref>` in the batch) is
    // equivalent and covered by the design-:338 test below; it deadlocked until
    // the gate-ref binding fix, which is why this chain uses the patch surface.
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());
    const batch = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [
            { ref: 'bump', message: 'Bump the OSS package version and publish.', difficulty: 'easy' },
            { ref: 'root_bump', message: 'Bump the root package to the published OSS version.', difficulty: 'easy', gated_by: ['ci'] },
        ],
        gates: [
            { ref: 'ci', action: 'ci_wait', instructions: 'Wait for the publish CI run.', depends_on: ['bump'] },
            { ref: 'deploy', action: 'deploy', instructions: 'Deploy the root bump to production.', depends_on: ['root_bump'] },
        ],
    } as any));
    assert.equal(batch.success, true, JSON.stringify(batch));

    updateTaskStatus(meshId, taskId(batch, 'bump'), 'completed');
    const ciClaim = await claimGate(ctx, gateId(batch, 'ci'));

    // ★ CI FAILED. The fenced release carries the fail outcome and patches the
    // designed gate-outcome condition onto the still-pending root-bump node.
    const ciRelease = await releaseGate(ctx, ciClaim, {
        idempotency_key: 'ci-fail-1',
        outcome: 'failed',
        evidence: { ci_run: 'https://ci.example/run/43', conclusion: 'failure' },
        patches: [{
            node: 'root_bump',
            base_spec_patch: { run_if: { from: 'ci', select: '/gate_outcome', op: 'eq', value: 'passed' } },
        }],
    });
    assert.equal(ciRelease.success, true, JSON.stringify(ciRelease));

    // ★ The designed failure propagation (C1 condition + C3 skip semantics,
    // design :336-369): root-bump is SKIPPED — terminal for graph accounting,
    // deliberately NOT completed — and its queue placeholder is cancelled, so
    // the unchanged dependency predicate can never dispatch it.
    const rootBump = queueRow(meshId, taskId(batch, 'root_bump'));
    assert.equal(rootBump.status, 'cancelled', 'root-bump must NEVER run on a failed CI outcome');
    assert.match(rootBump.blockedReason ?? '', /^graph_skipped:run_if_false:ci\/gate_outcome/);

    // The deploy terminal gate never opens: its predecessor skipped, and a skip
    // is not passage. No coordinator action can legitimately deploy.
    const earlyDeploy = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: gateId(batch, 'deploy') }));
    assert.equal(earlyDeploy.success, false);
    assert.equal(earlyDeploy.code, 'gate_not_awaiting', 'a failed CI outcome must never open production deploy');

    // The fail outcome is on the ledger with its evidence digest.
    const releases = readLedgerEntries(meshId, { kind: ['graph_gate_released'] } as any);
    assert.equal(releases.length, 1);
    assert.equal((releases[0].payload as any).outcome, 'failed');
    assert.ok((releases[0].payload as any).releaseDigest);

    // End state: the graph reflects the failure policy — the failed branch is
    // terminally skipped, the deploy gate is still declared shut, and the graph
    // does NOT roll up to completed.
    const end = await viewGraph(ctx, batch.graphId);
    assert.notEqual(end.status, 'completed');
    assert.equal(end.gates.find((g: any) => g.ref === 'ci').releaseOutcome, 'failed');
    assert.equal(end.gates.find((g: any) => g.ref === 'deploy').state, 'declared');
    const byRef = new Map(end.nodes.map((n: any) => [n.ref, n]));
    assert.equal((byRef.get('root_bump') as any).state, 'skipped');
    assert.match((byRef.get('root_bump') as any).skipReason ?? '', /^run_if_false:/);
});

// ── Admission-time gate-outcome binding (design :338) ────────────────────────
// The four-chain table (design :921-933) claims 4/4 expressible, and the tool
// schema tells the coordinator that a release's structured result/evidence
// "become readable by downstream tasks through run_if and inputs_from"
// (mesh-tool-schemas.ts :239). Declaring that binding AT ADMISSION — the
// spelling the schema advertises — used to DEADLOCK the downstream node.
//
// ★ FIXED. The admission wired a `requires` (inputs_from) or `conditional`
// (run_if) edge FROM THE GATE NODE, and settleDownstreamNode demands
// state==='completed' from every non-`gate` incoming source. A released gate
// node is 'released', NEVER 'completed', so the downstream node deferred
// forever: the release committed, materialized nothing, and the task stayed
// behind a graph_materialization_pending block no later event cleared.
//
// mesh-graph-plan.ts now routes a bound gate ref into the SAME `gate`-edge
// emission as `gated_by` (deduplicated) instead of a requires/conditional edge,
// so the gate edge stays the one carrier of gate ordering and the runner's
// existing gateOutcomeOutputForNode supplies the outcome envelope to the
// binding. Both spellings — admission-time (here) and the release-time patch
// surface (design :415, used by G-1/G-3/G-4-fail) — now behave identically.
// Unit-level regression: daemon-core test/mesh/mesh-graph-gate-ref-binding.test.ts.

test('admission-time inputs_from/run_if against a GATE ref materializes off the release (design :338)', async () => {
    for (const variant of ['inputs_from', 'run_if'] as const) {
        const meshId = nextMeshId();
        const ctx = makeCtx(meshId, recordingLocalTransport());
        const downstream: Record<string, unknown> = variant === 'inputs_from'
            ? { inputs_from: [{ from: 'gate', select: '/result/landed_sha', as: 'landed_sha', required: true }] }
            : { run_if: { from: 'gate', select: '/gate_outcome', op: 'eq', value: 'passed' } };
        const batch = JSON.parse(await meshEnqueueBatch(ctx, {
            tasks: [
                { ref: 'work', message: 'do the work', difficulty: 'easy' },
                { ref: 'downstream', message: 'consume the gate outcome', difficulty: 'easy', gated_by: ['gate'], ...downstream },
            ],
            gates: [{ ref: 'gate', action: 'refinery', depends_on: ['work'] }],
        } as any));
        assert.equal(batch.success, true, JSON.stringify(batch));

        updateTaskStatus(meshId, taskId(batch, 'work'), 'completed');
        const claim = await claimGate(ctx, gateId(batch, 'gate'));
        const release = await releaseGate(ctx, claim, {
            idempotency_key: 'rel-1',
            outcome: 'passed',
            result: { landed_sha: 'deadbeef' },
        });
        assert.equal(release.success, true, JSON.stringify(release));

        // ── DESIGNED (design :338) ──────────────────────────────────────────
        // The fenced release itself materializes the downstream node: the gate
        // edge is satisfied by the release, and the outcome envelope is in scope
        // for the binding. No later event is needed, and no hold survives.
        assert.equal(release.materializedCount, 1, `(${variant}): the release must materialize the bound node`);
        const row = queueRow(meshId, taskId(batch, 'downstream'));
        assert.equal(row.status, 'pending');
        assert.equal(
            row.blockedReason,
            undefined,
            `(${variant}): no graph hold may survive a successful gate release`,
        );

        if (variant === 'inputs_from') {
            // C1 binding semantics: the release `result` is APPENDED to the
            // immutable base instruction and marked untrusted, attributed to the
            // gate ref it came from.
            assert.ok(row.message.startsWith('consume the gate outcome'));
            assert.match(row.message, /deadbeef/);
            assert.match(row.message, /trust="untrusted"/);
            assert.match(row.message, /source_ref="gate"/);
        }

        const view = await viewGraph(ctx, batch.graphId);
        const node = view.nodes.find((n: any) => n.ref === 'downstream');
        assert.equal(node.state, 'materialized', `(${variant}): the node must leave blocked on release`);

        // ★ C2 still holds: the gate went through a real fenced release, not an
        // auto-pass — the node is materialized BECAUSE the release committed.
        assert.equal(view.gates.find((g: any) => g.ref === 'gate').state, 'released');
        assert.equal(view.gates.find((g: any) => g.ref === 'gate').releaseOutcome, 'passed');
    }
});
