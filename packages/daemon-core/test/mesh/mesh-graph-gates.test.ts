import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase C2 — coordinator gate contract characterization.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :373-423 — gate contract: declared → awaiting_coordinator → claimed →
//                released; the ONLY way through a gate is a fenced release.
//     :402-405 — upstream completion OPENS the gate, blocks downstream with
//                `coordinator_gate:<gateId>`, emits graph_gate_awaiting, and
//                deliberately does NOT wake downstream.
//     :407-421 — claim hands out a monotonically increasing generation + opaque
//                fencing token; release rejects stale generations, expired
//                leases, conflicting digests, and assigned downstream patches.
//     :425-439 — lease expiry ≠ deadline expiry; on_timeout ∈ {hold,
//                cancel_downstream, fail_graph}; NO auto_release — ★ elapsed
//                time is NEVER completion evidence (the M-TERMINAL-ADMISSION-
//                GATE defect class: a timeout must never pass a gate).
//     :185-190 — gate state transitions and their wake/notification events
//                commit in ONE SQLite transaction (transactional outbox).
//     :808-817 — the design's own C2 test list.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-gates-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

const meshConfigMocks = vi.hoisted(() => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: meshConfigMocks.getMesh,
    getMeshByRepo: meshConfigMocks.getMeshByRepo,
    listMeshes: meshConfigMocks.listMeshes,
}));

import {
    drainMeshGraphOutbox,
    graphMaterializationBlockReason,
    registerMeshGraphQueueWakeHandler,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    claimMeshGraphGate,
    coordinatorGateBlockReason,
    releaseMeshGraphGate,
    sweepMeshGraphGateTimeouts,
} from '../../src/mesh/mesh-graph-gates.js';
import {
    MESH_GRAPH_GATE_TIMEOUT_POLICIES,
    type MeshGraphGateRow,
    type MeshTaskGraphEdgeRow,
    type MeshTaskGraphNodeRow,
} from '../../src/mesh/mesh-graph-types.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function meshId(tag: string): string {
    return `mesh_graphc2_${tag}_${randomUUID().slice(0, 8)}`;
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
    __resetMeshGraphTransitionRunnerForTests();
    meshConfigMocks.getMesh.mockReset();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function enqueue(mesh: string, message: string) {
    return enqueueTask(mesh, message, { taskMode: 'code_change', difficulty: 'medium' } as any);
}

function nowIso(): string {
    return new Date().toISOString();
}

function gs() {
    return MeshRuntimeStore.getInstance().graphStore();
}

interface GateGraphOpts {
    gateRef?: string;
    action?: MeshGraphGateRow['action'];
    onTimeout?: MeshGraphGateRow['onTimeout'];
    eligibleCoordinatorSessionId?: string;
    /** Node base spec for the gate: lease_seconds / deadline_seconds. */
    gateSpec?: Record<string, unknown>;
    bBaseSpec?: Record<string, unknown>;
    /** Also wire C --requires--> B (a second upstream completing AFTER the gate opened). */
    withExtraUpstream?: boolean;
    /** No downstream worker at all — the gate is the graph's terminal node (design :423). */
    terminalGate?: boolean;
}

/** Hand-build A --requires--> G(coordinator_gate) --gate--> B over real queue rows. */
function buildGateGraph(mesh: string, opts: GateGraphOpts = {}) {
    const taskA = enqueue(mesh, 'do A');
    const taskB = opts.terminalGate ? undefined : enqueue(mesh, 'placeholder B — replaced at release');
    const taskC = opts.withExtraUpstream ? enqueue(mesh, 'do C') : undefined;
    const graphId = randomUUID();
    const gateId = randomUUID();
    const nodeA = randomUUID();
    const nodeG = randomUUID();
    const nodeB = taskB ? randomUUID() : undefined;
    const nodeC = taskC ? randomUUID() : undefined;
    const now = nowIso();
    gs().insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: taskB ? 2 : 1, gateCount: 1, workspaceCount: 0,
        dependencyEdgeCount: 1 + (taskB ? 1 : 0) + (taskC ? 1 : 0),
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    const node = (nodeId: string, ref: string, kind: MeshTaskGraphNodeRow['kind'], queueTaskId: string | undefined, spec: Record<string, unknown>): MeshTaskGraphNodeRow => ({
        graphId, nodeId, meshId: mesh, ref, kind, queueTaskId,
        state: 'declared', baseSpecJson: JSON.stringify(spec), materializationVersion: 0,
        createdAt: now, updatedAt: now,
    });
    gs().insertNode(node(nodeA, 'a', 'worker_task', taskA.id, { message: 'do A' }));
    gs().insertNode(node(nodeG, opts.gateRef ?? 'land', 'coordinator_gate', undefined, opts.gateSpec ?? {}));
    if (nodeB && taskB) gs().insertNode(node(nodeB, 'b', 'worker_task', taskB.id, opts.bBaseSpec ?? { message: 'do B work' }));
    if (nodeC && taskC) gs().insertNode(node(nodeC, 'c', 'worker_task', taskC.id, { message: 'do C' }));
    const edge = (from: string, to: string, kind: MeshTaskGraphEdgeRow['kind']): MeshTaskGraphEdgeRow => ({
        graphId, meshId: mesh, fromNodeId: from, toNodeId: to, kind, omitOnSkip: false, createdAt: now,
    });
    gs().insertEdge(edge(nodeA, nodeG, 'requires'));
    if (nodeB) gs().insertEdge(edge(nodeG, nodeB, 'gate'));
    if (nodeC && nodeB) gs().insertEdge(edge(nodeC, nodeB, 'requires'));
    gs().insertGate({
        gateId, graphId, nodeId: nodeG, meshId: mesh, ref: opts.gateRef ?? 'land',
        state: 'declared', action: opts.action ?? 'refinery',
        instructions: 'Land after verifying patch equivalence.',
        eligibleCoordinatorSessionId: opts.eligibleCoordinatorSessionId,
        leaseGeneration: 0, onTimeout: opts.onTimeout ?? 'hold',
        createdAt: now, updatedAt: now,
    });
    return { graphId, gateId, nodeA, nodeG, nodeB, nodeC, taskA, taskB, taskC };
}

/** Open the gate by completing A; returns the gate row. */
function openGate(id: string, g: ReturnType<typeof buildGateGraph>) {
    updateTaskStatus(id, g.taskA.id, 'completed');
    return gs().getGate(g.gateId)!;
}

/** Claim helper: open + claim in one step. */
function openAndClaim(id: string, g: ReturnType<typeof buildGateGraph>, session = 'sess-coord', nowMs?: number) {
    openGate(id, g);
    const claim = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: session, nowMs });
    expect(claim.claimed).toBe(true);
    return claim;
}

function outboxKinds(id: string, graphId: string): string[] {
    return gs().listOutboxEvents(id, graphId).map(e => e.kind);
}

// ── Gate opening (design :402-405) ────────────────────────────────────────────

describe('gate opening — upstream completion stops the graph at the gate', () => {
    it('moves the gate to awaiting_coordinator, blocks downstream, and does NOT wake it', () => {
        const id = meshId('open');
        try {
            const g = buildGateGraph(id, { gateSpec: { deadline_seconds: 3600 } });
            updateTaskStatus(id, g.taskA.id, 'completed');

            const gate = gs().getGate(g.gateId)!;
            expect(gate.state).toBe('awaiting_coordinator');
            expect(gate.deadlineAt).toBeTruthy();
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('awaiting_coordinator');
            expect(gs().getGraph(g.graphId)!.status).toBe('waiting_gate');

            // Downstream intentionally STOPPED: blocked, not materialized, not woken.
            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            expect(entryB.message).toBe('placeholder B — replaced at release');
            expect(gs().getNode(g.graphId, g.nodeB!)!.state).toBe('blocked');

            const kinds = outboxKinds(id, g.graphId);
            expect(kinds).toContain('graph_gate_awaiting');
            expect(kinds).not.toContain('queue_wake');
            expect(kinds).not.toContain('graph_node_materialized');
        } finally {
            cleanup(id);
        }
    });

    it('a LATER upstream completion cannot side-step the unreleased gate (bypass guard)', () => {
        const id = meshId('guard');
        try {
            const g = buildGateGraph(id, { withExtraUpstream: true });
            openGate(id, g);
            // C completes after the gate opened — B's worker inputs are now fully
            // settled, but the gate edge must still stop materialization.
            updateTaskStatus(id, g.taskC!.id, 'completed');

            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            expect(entryB.message).toBe('placeholder B — replaced at release');
            expect(gs().getNode(g.graphId, g.nodeB!)!.state).toBe('blocked');
        } finally {
            cleanup(id);
        }
    });
});

// ── Claim contract (design :407-408, :429-430) ────────────────────────────────

describe('mesh_graph_gate_claim — lease generations and fencing', () => {
    it('refuses to claim a gate whose upstream is not satisfied yet', () => {
        const id = meshId('claim_early');
        try {
            const g = buildGateGraph(id);
            const claim = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1' });
            expect(claim.claimed).toBe(false);
            expect(claim.reason).toBe('gate_not_awaiting');
        } finally {
            cleanup(id);
        }
    });

    it('claims with generation 1 + fencing token; a live foreign lease blocks other coordinators; same owner refreshes', () => {
        const id = meshId('claim');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id);
            openGate(id, g);

            const c1 = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1', nowMs: t0 });
            expect(c1.claimed).toBe(true);
            expect(c1.leaseGeneration).toBe(1);
            expect(c1.fencingToken).toBeTruthy();
            expect(c1.leaseExpiresAt).toBe(new Date(t0 + 900_000).toISOString());
            expect(c1.ambiguousExternalOutcome).toBe(false);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');

            const c2 = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-2', nowMs: t0 + 1_000 });
            expect(c2.claimed).toBe(false);
            expect(c2.reason).toBe('gate_lease_held');

            const refresh = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1', nowMs: t0 + 2_000 });
            expect(refresh.claimed).toBe(true);
            expect(refresh.leaseGeneration).toBe(1); // same owner: generation kept
            expect(refresh.fencingToken).toBe(c1.fencingToken);
            expect(outboxKinds(id, g.graphId)).toContain('graph_gate_claimed');
        } finally {
            cleanup(id);
        }
    });

    it('honours the eligible coordinator session', () => {
        const id = meshId('claim_eligible');
        try {
            const g = buildGateGraph(id, { eligibleCoordinatorSessionId: 'sess-owner' });
            openGate(id, g);
            const wrong = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-x' });
            expect(wrong.claimed).toBe(false);
            expect(wrong.reason).toBe('gate_not_eligible');
            const right = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-owner' });
            expect(right.claimed).toBe(true);
        } finally {
            cleanup(id);
        }
    });

    it('lease lapse lets a live coordinator take over with a HIGHER generation — and flags ambiguous_external_outcome', () => {
        const id = meshId('takeover');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id);
            openGate(id, g);
            const c1 = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1', leaseSeconds: 1, nowMs: t0 });
            expect(c1.claimed).toBe(true);

            // sess-1 dies after the side effect but before release. Its lease lapses.
            const c2 = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-2', nowMs: t0 + 2_000 });
            expect(c2.claimed).toBe(true);
            expect(c2.leaseGeneration).toBe(2);
            expect(c2.fencingToken).not.toBe(c1.fencingToken);
            // design :436-439 — the new claimant MUST reconcile external evidence first.
            expect(c2.ambiguousExternalOutcome).toBe(true);
            expect(c2.previousLeaseOwnerSessionId).toBe('sess-1');
            expect(outboxKinds(id, g.graphId)).toContain('graph_gate_lease_expired');

            // The dead coordinator's fenced release is now stale and rejected.
            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: c1.fencingToken!, leaseGeneration: 1,
                idempotencyKey: 'rel-dead', outcome: 'passed', nowMs: t0 + 3_000,
            })).toThrow(/stale_fence/);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');
        } finally {
            cleanup(id);
        }
    });
});

// ── Release contract (design :409-421) ────────────────────────────────────────

describe('mesh_graph_gate_release — fenced, idempotent, transactional', () => {
    it('a valid fenced release materializes downstream exactly once and wakes the queue', () => {
        const id = meshId('release');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);

            const wakes: string[] = [];
            registerMeshGraphQueueWakeHandler(m => wakes.push(m));

            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed',
                result: { landed_sha: 'abc123' }, evidence: { ci: 'green' },
            });
            expect(rel.released).toBe(true);
            expect(rel.duplicate).toBe(false);
            expect(rel.materializedNodeIds).toEqual([g.nodeB]);

            const gate = gs().getGate(g.gateId)!;
            expect(gate.state).toBe('released');
            expect(gate.releaseOutcome).toBe('passed');
            expect(gate.releaseEvidenceDigest).toBeTruthy();
            expect(gate.releaseIdempotencyKey).toBe('rel-1');
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('released');
            expect(gs().getNode(g.graphId, g.nodeB!)!.state).toBe('materialized');

            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            expect(entryB.status).toBe('pending'); // claimable now
            expect(entryB.blockedReason).toBeUndefined();
            expect(entryB.message).toBe('do B work');
            expect(entryB.dependsOn).toEqual([]);

            // Graph leaves waiting_gate once no gate is open (B is still running work).
            expect(gs().getGraph(g.graphId)!.status).toBe('active');

            const kinds = outboxKinds(id, g.graphId);
            expect(kinds).toContain('graph_gate_released');
            expect(kinds).toContain('queue_wake');
            expect(wakes).toEqual([id]);
        } finally {
            cleanup(id);
        }
    });

    it('replaying the same release key + digest is a no-op success; a different digest is a conflict', () => {
        const id = meshId('release_idem');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);
            const base = {
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed',
            };
            const first = releaseMeshGraphGate(base);
            expect(first.duplicate).toBe(false);
            const replay = releaseMeshGraphGate(base);
            expect(replay.released).toBe(true);
            expect(replay.duplicate).toBe(true);
            expect(replay.materializedNodeIds).toEqual([]);
            expect(outboxKinds(id, g.graphId).filter(k => k === 'graph_gate_released')).toHaveLength(1);
            expect(() => releaseMeshGraphGate({ ...base, outcome: 'failed' })).toThrow(/gate_release_conflict/);
        } finally {
            cleanup(id);
        }
    });

    it('★ an EXPIRED lease can never release — elapsed time is not completion evidence', () => {
        const id = meshId('release_expired');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id);
            openGate(id, g);
            const claim = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1', leaseSeconds: 1, nowMs: t0 });
            expect(claim.claimed).toBe(true);

            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-late', outcome: 'passed', nowMs: t0 + 2_000,
            })).toThrow(/gate_lease_expired/);

            // Nothing moved: still claimed, downstream still gate-blocked, no release event.
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');
            expect(getQueue(id).find(t => t.id === g.taskB!.id)!.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            expect(outboxKinds(id, g.graphId)).not.toContain('graph_gate_released');
        } finally {
            cleanup(id);
        }
    });

    it('rejects a release while the gate upstream is unsettled', () => {
        const id = meshId('release_unsettled');
        try {
            const g = buildGateGraph(id);
            // Hand-forge a claimed gate WITHOUT completing A (a corrupt/legacy row).
            gs().patchGate(g.gateId, {
                state: 'claimed', leaseOwnerSessionId: 'sess-1', leaseGeneration: 1,
                fencingToken: 'tok', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }, nowIso());
            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: 'tok', leaseGeneration: 1,
                idempotencyKey: 'rel-x', outcome: 'passed',
            })).toThrow(/gate_upstream_unsettled/);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');
        } finally {
            cleanup(id);
        }
    });

    it('gate outcome drives downstream run_if: failed outcome skips, passed materializes', () => {
        const idFail = meshId('outcome_fail');
        const idPass = meshId('outcome_pass');
        try {
            const bSpec = {
                message: 'Publish the landed change.',
                run_if: { from: 'land', select: '/gate_outcome', op: 'eq', value: 'passed' },
            };
            const gf = buildGateGraph(idFail, { bBaseSpec: bSpec });
            const cf = openAndClaim(idFail, gf);
            releaseMeshGraphGate({
                meshId: idFail, gateId: gf.gateId, fencingToken: cf.fencingToken!, leaseGeneration: cf.leaseGeneration!,
                idempotencyKey: 'rel-f', outcome: 'failed',
            });
            const nodeBF = gs().getNode(gf.graphId, gf.nodeB!)!;
            expect(nodeBF.state).toBe('skipped');
            expect(nodeBF.skipReason).toMatch(/^run_if_false:/);
            const entryBF = getQueue(idFail).find(t => t.id === gf.taskB!.id)!;
            expect(entryBF.status).toBe('cancelled'); // never "completed" (design :357-359)
            // A completed + gate released + B skipped → the graph rolls up.
            expect(gs().getGraph(gf.graphId)!.status).toBe('completed');

            const gp = buildGateGraph(idPass, { bBaseSpec: bSpec });
            const cp = openAndClaim(idPass, gp);
            releaseMeshGraphGate({
                meshId: idPass, gateId: gp.gateId, fencingToken: cp.fencingToken!, leaseGeneration: cp.leaseGeneration!,
                idempotencyKey: 'rel-p', outcome: 'passed',
            });
            expect(gs().getNode(gp.graphId, gp.nodeB!)!.state).toBe('materialized');
            expect(getQueue(idPass).find(t => t.id === gp.taskB!.id)!.message).toBe('Publish the landed change.');
        } finally {
            cleanup(idFail);
            cleanup(idPass);
        }
    });

    it('downstream inputs_from binds the gate release result as untrusted evidence', () => {
        const id = meshId('bind_gate');
        try {
            const g = buildGateGraph(id, {
                bBaseSpec: {
                    message: 'Validate the landed patch.',
                    inputs_from: [{ from: 'land', select: '/result/landed_sha', as: 'landed_sha', required: true }],
                },
            });
            const claim = openAndClaim(id, g);
            releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed', result: { landed_sha: 'deadbeef' },
            });
            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBeUndefined();
            expect(entryB.message.startsWith('Validate the landed patch.')).toBe(true);
            expect(entryB.message).toContain('deadbeef');
            expect(entryB.message).toMatch(/trust="untrusted"/);
            expect(entryB.message).toMatch(/source_ref="land"/);
        } finally {
            cleanup(id);
        }
    });

    it('patch surface: forbidden keys and assigned downstream tasks abort the WHOLE release (rollback)', () => {
        const id = meshId('patch_guard');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);

            // Forbidden key (message is immutable, design :294-299) → throw + rollback.
            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-bad', outcome: 'passed',
                patches: [{ node: 'b', baseSpecPatch: { message: 'hijacked instruction' } }],
            })).toThrow(/gate_patch_forbidden/);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed'); // rollback: still claimed
            expect(gs().getGate(g.gateId)!.releaseIdempotencyKey).toBeUndefined();
            expect(getQueue(id).find(t => t.id === g.taskB!.id)!.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            expect(outboxKinds(id, g.graphId)).not.toContain('graph_gate_released');

            // Assigned downstream task is immutable (design :334) → throw + rollback.
            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...entryB, status: 'assigned', assignedNodeId: 'node_main', assignedSessionId: 'sess-w', updatedAt: nowIso(),
            } as any);
            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-bad2', outcome: 'passed',
                patches: [{ node: 'b', baseSpecPatch: { run_if: { from: 'land', select: '/gate_outcome', op: 'eq', value: 'passed' } } }],
            })).toThrow(/task_already_claimed/);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');
        } finally {
            cleanup(id);
        }
    });

    it('a valid patch to a still-pending downstream node applies (version bumps, hold re-arms)', () => {
        const id = meshId('patch_ok');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);
            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed',
                patches: [{ node: 'b', baseSpecPatch: { workspace_ref: 'ws_precreated' } }],
            });
            expect(rel.released).toBe(true);
            // The workspace intent does not exist → deferred, not claimable, gate hold
            // replaced by the generic graph materialization hold at the bumped version.
            expect(rel.materializedNodeIds).toEqual([]);
            const nodeB = gs().getNode(g.graphId, g.nodeB!)!;
            expect(nodeB.materializationVersion).toBe(1);
            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBe(graphMaterializationBlockReason(g.nodeB!, 1));
            expect(entryB.blockedReason).not.toBe(coordinatorGateBlockReason(g.gateId));
            expect(JSON.parse(nodeB.baseSpecJson).workspace_ref).toBe('ws_precreated');
        } finally {
            cleanup(id);
        }
    });

    it('outbox durability: a failing wake handler leaves the row pending but the release COMMITTED', () => {
        const id = meshId('outbox_durable');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);
            registerMeshGraphQueueWakeHandler(() => { throw new Error('wake transport down'); });
            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed',
            });
            expect(rel.released).toBe(true);
            expect(gs().getGate(g.gateId)!.state).toBe('released'); // state stands
            const wakeRows = gs().listOutboxEvents(id, g.graphId).filter(e => e.kind === 'queue_wake');
            expect(wakeRows).toHaveLength(1);
            expect(wakeRows[0].status).toBe('pending'); // not lost — retried later
            expect(wakeRows[0].attemptCount).toBe(1);

            // Transport recovers → the SAME row drains; no duplicate event was inserted.
            __resetMeshGraphTransitionRunnerForTests();
            const wakes: string[] = [];
            registerMeshGraphQueueWakeHandler(m => wakes.push(m));
            drainMeshGraphOutbox(id);
            expect(wakes).toEqual([id]);
            expect(gs().listOutboxEvents(id, g.graphId).filter(e => e.kind === 'queue_wake')).toHaveLength(1);
        } finally {
            cleanup(id);
        }
    });

    it('a terminal gate is valid: the graph completes when its last gate releases (design :423)', () => {
        const id = meshId('terminal_gate');
        try {
            const g = buildGateGraph(id, { terminalGate: true, action: 'deploy' });
            const claim = openAndClaim(id, g);
            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed', result: { deploy_url: 'https://example.test' },
            });
            expect(rel.released).toBe(true);
            expect(rel.materializedNodeIds).toEqual([]);
            expect(gs().getGraph(g.graphId)!.status).toBe('completed');
            expect(outboxKinds(id, g.graphId)).toContain('graph_completed');
        } finally {
            cleanup(id);
        }
    });
});

// ── Death & timeout policy (design :425-439) ──────────────────────────────────

describe('coordinator death and timeout — sweep never releases', () => {
    it('there is NO auto_release timeout policy at all', () => {
        expect(MESH_GRAPH_GATE_TIMEOUT_POLICIES).toEqual(['hold', 'cancel_downstream', 'fail_graph']);
        expect(MESH_GRAPH_GATE_TIMEOUT_POLICIES).not.toContain('auto_release');
    });

    it('hold: deadline expiry moves the gate to expired, RETAINS downstream blocks, and allows explicit reclaim', () => {
        const id = meshId('timeout_hold');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id, { gateSpec: { deadline_seconds: 1 }, onTimeout: 'hold' });
            const claim = openAndClaim(id, g, 'sess-1', t0);

            const sweep = sweepMeshGraphGateTimeouts(id, t0 + 2_000);
            expect(sweep.expiredGateIds).toEqual([g.gateId]);

            const gate = gs().getGate(g.gateId)!;
            expect(gate.state).toBe('expired'); // ★ expired — NEVER released by time
            expect(gate.releaseOutcome).toBeUndefined();
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('expired');
            expect(gs().getGraph(g.graphId)!.status).toBe('waiting_gate');
            // Downstream hold retained.
            expect(getQueue(id).find(t => t.id === g.taskB!.id)!.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            const kinds = outboxKinds(id, g.graphId);
            expect(kinds).toContain('graph_gate_expired');
            expect(kinds).not.toContain('graph_gate_released');

            // Explicit reclaim with a fresh deadline, then a normal fenced release.
            const reclaim = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-2',
                extendDeadlineSeconds: 3600, nowMs: t0 + 3_000,
            });
            expect(reclaim.claimed).toBe(true);
            expect(reclaim.leaseGeneration).toBe(claim.leaseGeneration! + 1);
            expect(reclaim.ambiguousExternalOutcome).toBe(true); // sess-1 had claimed before dying
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('awaiting_coordinator');

            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId, fencingToken: reclaim.fencingToken!, leaseGeneration: reclaim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed', nowMs: t0 + 4_000,
            });
            expect(rel.released).toBe(true);
            expect(gs().getNode(g.graphId, g.nodeB!)!.state).toBe('materialized');
        } finally {
            cleanup(id);
        }
    });

    it('cancel_downstream: deadline expiry cancels the downstream subtree but never releases the gate', () => {
        const id = meshId('timeout_cancel');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id, { gateSpec: { deadline_seconds: 1 }, onTimeout: 'cancel_downstream' });
            openAndClaim(id, g, 'sess-1', t0);

            const sweep = sweepMeshGraphGateTimeouts(id, t0 + 2_000);
            expect(sweep.expiredGateIds).toEqual([g.gateId]);
            const gate = gs().getGate(g.gateId)!;
            expect(gate.state).toBe('expired');
            expect(gs().getNode(g.graphId, g.nodeB!)!.state).toBe('cancelled');
            const entryB = getQueue(id).find(t => t.id === g.taskB!.id)!;
            expect(entryB.status).toBe('cancelled');
            expect(entryB.blockedReason).toMatch(/^coordinator_gate_timeout:/);
            // The expired gate is terminal — no reclaim path for non-hold policies.
            const reclaim = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-2', nowMs: t0 + 3_000 });
            expect(reclaim.claimed).toBe(false);
        } finally {
            cleanup(id);
        }
    });

    it('fail_graph: deadline expiry fails the whole graph', () => {
        const id = meshId('timeout_fail');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id, { gateSpec: { deadline_seconds: 1 }, onTimeout: 'fail_graph' });
            openGate(id, g); // deadline fires even while merely awaiting a claimant

            const sweep = sweepMeshGraphGateTimeouts(id, t0 + 2_000);
            expect(sweep.expiredGateIds).toEqual([g.gateId]);
            expect(gs().getGate(g.gateId)!.state).toBe('expired');
            const graph = gs().getGraph(g.graphId)!;
            expect(graph.status).toBe('failed');
            expect(graph.terminalAt).toBeTruthy();
        } finally {
            cleanup(id);
        }
    });

    it('a lapsed lease is REPORTED but never auto-actioned; the sweep is idempotent', () => {
        const id = meshId('sweep_idem');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id); // no deadline_seconds → no deadline at all
            openAndClaim(id, g, 'sess-1', t0);
            // Let the 900s default lease lapse "in spirit" by sweeping far in the future.
            const sweep = sweepMeshGraphGateTimeouts(id, t0 + 1_000_000);
            expect(sweep.expiredGateIds).toEqual([]); // no deadline → nothing expires
            expect(sweep.expiredLeaseGateIds).toEqual([g.gateId]); // reported only
            expect(gs().getGate(g.gateId)!.state).toBe('claimed'); // lease lapse never alters the graph

            // A second sweep reports the same lapsed lease without state changes or new events.
            const before = outboxKinds(id, g.graphId).length;
            sweepMeshGraphGateTimeouts(id, t0 + 2_000_000);
            expect(outboxKinds(id, g.graphId).length).toBe(before);
        } finally {
            cleanup(id);
        }
    });
});
