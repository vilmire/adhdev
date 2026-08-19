import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase G — coordinator gate CHAOS / fault-injection.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :815-816 — crash simulations: (a) before side effect, (b) after side
//                effect / before release, (c) DURING the release transaction,
//                (d) after commit / before notification.
//     :185-190 — the release state change and its outbox events commit in ONE
//                SQLite transaction; a crash mid-transaction must roll back
//                EVERYTHING (no partial gate patch, no orphan outbox rows).
//
//   Coverage split with mesh-graph-gates.test.ts (do not duplicate):
//     (b) after side effect / before release — covered there :290-318
//         (lease-lapse takeover, ambiguousExternalOutcome, stale_fence) and
//         :392-414 (expired lease can never release).
//     (d) after commit / before notification — covered there :556-583
//         (failing wake handler leaves the outbox row pending; the release
//         committed; the drain redelivers without a duplicate).
//   This file newly covers (c) — the mid-transaction crash — and adds the
//   explicit (a) crash-before-side-effect assertions :290-318 does not pin
//   (sweep-report path, dead-claimant re-claim refusal, takeover release
//   exactly-once, post-release stale rejection).

const testTmpDir = path.join(tmpdir(), `adhdev-graph-gate-crash-${randomUUID().slice(0, 8)}`);
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
    registerMeshGraphQueueWakeHandler,
    __resetMeshGraphTransitionRunnerForTests,
} from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    claimMeshGraphGate,
    coordinatorGateBlockReason,
    releaseMeshGraphGate,
    sweepMeshGraphGateTimeouts,
} from '../../src/mesh/mesh-graph-gates.js';
import type {
    MeshGraphGateRow,
    MeshTaskGraphEdgeRow,
    MeshTaskGraphNodeRow,
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
    return `mesh_graphg_${tag}_${randomUUID().slice(0, 8)}`;
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

/** Hand-build A --requires--> G(coordinator_gate) --gate--> B over real queue rows. */
function buildGateGraph(mesh: string) {
    const taskA = enqueue(mesh, 'do A');
    const taskB = enqueue(mesh, 'placeholder B — replaced at release');
    const graphId = randomUUID();
    const gateId = randomUUID();
    const nodeA = randomUUID();
    const nodeG = randomUUID();
    const nodeB = randomUUID();
    const now = nowIso();
    gs().insertGraph({
        graphId, meshId: mesh, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'active', taskCount: 2, gateCount: 1, workspaceCount: 0,
        dependencyEdgeCount: 2,
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    const node = (nodeId: string, ref: string, kind: MeshTaskGraphNodeRow['kind'], queueTaskId: string | undefined, spec: Record<string, unknown>): MeshTaskGraphNodeRow => ({
        graphId, nodeId, meshId: mesh, ref, kind, queueTaskId,
        state: 'declared', baseSpecJson: JSON.stringify(spec), materializationVersion: 0,
        createdAt: now, updatedAt: now,
    });
    gs().insertNode(node(nodeA, 'a', 'worker_task', taskA.id, { message: 'do A' }));
    gs().insertNode(node(nodeG, 'land', 'coordinator_gate', undefined, {}));
    gs().insertNode(node(nodeB, 'b', 'worker_task', taskB.id, { message: 'do B work' }));
    const edge = (from: string, to: string, kind: MeshTaskGraphEdgeRow['kind']): MeshTaskGraphEdgeRow => ({
        graphId, meshId: mesh, fromNodeId: from, toNodeId: to, kind, omitOnSkip: false, createdAt: now,
    });
    gs().insertEdge(edge(nodeA, nodeG, 'requires'));
    gs().insertEdge(edge(nodeG, nodeB, 'gate'));
    gs().insertGate({
        gateId, graphId, nodeId: nodeG, meshId: mesh, ref: 'land',
        state: 'declared', action: 'refinery',
        instructions: 'Land after verifying patch equivalence.',
        leaseGeneration: 0, onTimeout: 'hold',
        createdAt: now, updatedAt: now,
    });
    return { graphId, gateId, nodeA, nodeG, nodeB, taskA, taskB };
}

/** Claim helper: complete A (opens the gate) + claim in one step. */
function openAndClaim(id: string, g: ReturnType<typeof buildGateGraph>, session = 'sess-coord', nowMs?: number) {
    updateTaskStatus(id, g.taskA.id, 'completed');
    const claim = claimMeshGraphGate({ meshId: id, gateId: g.gateId, coordinatorSessionId: session, nowMs });
    expect(claim.claimed).toBe(true);
    return claim;
}

function outboxKinds(id: string, graphId: string): string[] {
    return gs().listOutboxEvents(id, graphId).map(e => e.kind);
}

// ── Crash point (c): DURING the release transaction (design :815-816, :185-190) ─

describe('crash during the release transaction — atomic rollback + exactly-once retry', () => {
    it('a crash at the final outbox insert rolls back EVERYTHING; the same release then commits exactly once', () => {
        const id = meshId('crash_outbox');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);
            const releaseInput = {
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-crash', outcome: 'passed',
                result: { landed_sha: 'abc123' },
            };

            // Simulate power loss AFTER downstream materialization, at the deep
            // graph_gate_released outbox insert — inside the transaction.
            const graphStore = gs();
            const realInsert = graphStore.insertOutboxEvent.bind(graphStore);
            const crashSpy = vi.spyOn(graphStore, 'insertOutboxEvent').mockImplementation((row) => {
                if (row.kind === 'graph_gate_released') {
                    throw new Error('simulated crash: power loss mid-transaction');
                }
                return realInsert(row);
            });
            const outboxBefore = gs().listOutboxEvents(id, g.graphId).length;

            expect(() => releaseMeshGraphGate(releaseInput)).toThrow(/simulated crash/);
            crashSpy.mockRestore();

            // Atomic rollback: nothing the transaction wrote may survive.
            const gate = gs().getGate(g.gateId)!;
            expect(gate.state).toBe('claimed');
            expect(gate.leaseGeneration).toBe(claim.leaseGeneration);
            expect(gate.fencingToken).toBe(claim.fencingToken);
            expect(gate.leaseOwnerSessionId).toBe('sess-coord');
            expect(gate.releaseOutcome).toBeUndefined();
            expect(gate.releaseEvidenceDigest).toBeUndefined();
            expect(gate.releaseIdempotencyKey).toBeUndefined(); // no idempotency key recorded
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('awaiting_coordinator');
            expect(gs().getNode(g.graphId, g.nodeB)!.state).toBe('blocked');
            const entryB = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryB.status).toBe('pending');
            expect(entryB.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));
            expect(entryB.message).toBe('placeholder B — replaced at release');
            expect(gs().getGraph(g.graphId)!.status).toBe('waiting_gate');
            // Zero outbox rows leaked from the crashed transaction.
            const kindsAfter = outboxKinds(id, g.graphId);
            expect(kindsAfter.length).toBe(outboxBefore);
            expect(kindsAfter).not.toContain('graph_gate_released');
            expect(kindsAfter).not.toContain('graph_node_materialized');
            expect(kindsAfter).not.toContain('queue_wake');

            // Retry the SAME release (same key, same fence) after the crash:
            // it must succeed exactly once.
            const wakes: string[] = [];
            registerMeshGraphQueueWakeHandler(m => wakes.push(m));
            const rel = releaseMeshGraphGate(releaseInput);
            expect(rel.released).toBe(true);
            expect(rel.duplicate).toBe(false);
            expect(rel.materializedNodeIds).toEqual([g.nodeB]);

            const released = gs().getGate(g.gateId)!;
            expect(released.state).toBe('released');
            expect(released.releaseIdempotencyKey).toBe('rel-crash');
            expect(gs().getNode(g.graphId, g.nodeB)!.state).toBe('materialized');
            const entryBAfter = getQueue(id).find(t => t.id === g.taskB.id)!;
            expect(entryBAfter.blockedReason).toBeUndefined();
            expect(entryBAfter.message).toBe('do B work');

            // Exactly one set of outbox rows across crash + retry.
            const finalKinds = outboxKinds(id, g.graphId);
            expect(finalKinds.filter(k => k === 'graph_gate_released')).toHaveLength(1);
            expect(finalKinds.filter(k => k === 'queue_wake')).toHaveLength(1);
            expect(finalKinds.filter(k => k === 'graph_node_materialized')).toHaveLength(1);
            expect(wakes).toEqual([id]);

            // A post-crash replay of the same key is a no-op duplicate, never a
            // second release.
            const replay = releaseMeshGraphGate(releaseInput);
            expect(replay.duplicate).toBe(true);
            expect(replay.materializedNodeIds).toEqual([]);
            expect(outboxKinds(id, g.graphId).filter(k => k === 'graph_gate_released')).toHaveLength(1);
        } finally {
            cleanup(id);
        }
    });

    it('a crash right after the release CAS write rolls back the gate patch itself', () => {
        const id = meshId('crash_cas');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);

            // Crash between the release CAS patchGate and the node-state update:
            // if the CAS write survived, the gate would sit half-released with a
            // recorded idempotency key but a still-claimed node — a split-brain row.
            const graphStore = gs();
            const realUpdateNodeState = graphStore.updateNodeState.bind(graphStore);
            const crashSpy = vi.spyOn(graphStore, 'updateNodeState').mockImplementation((graphId, nodeId, state, now, opts) => {
                if (nodeId === g.nodeG && state === 'released') {
                    throw new Error('simulated crash: power loss after the release CAS');
                }
                return realUpdateNodeState(graphId, nodeId, state, now, opts);
            });

            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-cas-crash', outcome: 'passed',
            })).toThrow(/simulated crash/);
            crashSpy.mockRestore();

            // The CAS patchGate did NOT leak: the gate row is byte-for-byte the
            // claimed row, with no release fields recorded.
            const gate = gs().getGate(g.gateId)!;
            expect(gate.state).toBe('claimed');
            expect(gate.leaseGeneration).toBe(claim.leaseGeneration);
            expect(gate.fencingToken).toBe(claim.fencingToken);
            expect(gate.releaseIdempotencyKey).toBeUndefined();
            expect(gate.releaseOutcome).toBeUndefined();
            expect(outboxKinds(id, g.graphId)).not.toContain('graph_gate_released');

            // The retried release is not mistaken for a duplicate: it performs
            // the release for real, exactly once.
            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-cas-crash', outcome: 'passed',
            });
            expect(rel.released).toBe(true);
            expect(rel.duplicate).toBe(false);
            expect(rel.materializedNodeIds).toEqual([g.nodeB]);
            expect(gs().getGate(g.gateId)!.state).toBe('released');
            expect(outboxKinds(id, g.graphId).filter(k => k === 'graph_gate_released')).toHaveLength(1);
        } finally {
            cleanup(id);
        }
    });
});

// ── Crash point (a): BEFORE the side effect (design :815) ─────────────────────

describe('crash before any side effect — the dead claimant is fenced out forever', () => {
    it('lease lapse is only REPORTED; the takeover releases exactly once; the dead claimant can never release', () => {
        const id = meshId('crash_before');
        try {
            const t0 = Date.now();
            const g = buildGateGraph(id);
            updateTaskStatus(id, g.taskA.id, 'completed');

            // sess-1 claims and dies having done NOTHING (no side effect, no release).
            const c1 = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1', leaseSeconds: 1, nowMs: t0,
            });
            expect(c1.claimed).toBe(true);

            // The sweep REPORTS the lapsed lease but never alters the graph
            // (★ no auto-release, no force-release — the C2 contract).
            const sweep = sweepMeshGraphGateTimeouts(id, t0 + 2_000);
            expect(sweep.expiredGateIds).toEqual([]);
            expect(sweep.expiredLeaseGateIds).toEqual([g.gateId]);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');
            expect(outboxKinds(id, g.graphId)).not.toContain('graph_gate_released');

            // sess-2 takes over with a higher generation; the system reports the
            // ambiguity (sess-1 MIGHT have acted before dying — the system cannot
            // distinguish crash-before from crash-after the side effect).
            const c2 = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-2', nowMs: t0 + 2_000,
            });
            expect(c2.claimed).toBe(true);
            expect(c2.leaseGeneration).toBe(2);
            expect(c2.fencingToken).not.toBe(c1.fencingToken);
            expect(c2.ambiguousExternalOutcome).toBe(true);
            expect(c2.previousLeaseOwnerSessionId).toBe('sess-1');

            // While sess-2's lease is live, the dead claimant cannot even re-claim.
            const zombie = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-1', nowMs: t0 + 3_000,
            });
            expect(zombie.claimed).toBe(false);
            expect(zombie.reason).toBe('gate_lease_held');

            // The dead claimant's fenced release is stale and rejected; nothing moves.
            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: c1.fencingToken!, leaseGeneration: 1,
                idempotencyKey: 'rel-dead', outcome: 'passed', nowMs: t0 + 3_000,
            })).toThrow(/stale_fence/);
            expect(gs().getGate(g.gateId)!.state).toBe('claimed');

            // The live coordinator releases exactly once.
            const rel = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: c2.fencingToken!, leaseGeneration: c2.leaseGeneration!,
                idempotencyKey: 'rel-live', outcome: 'passed', nowMs: t0 + 4_000,
            });
            expect(rel.released).toBe(true);
            expect(rel.duplicate).toBe(false);
            expect(rel.materializedNodeIds).toEqual([g.nodeB]);
            expect(gs().getNode(g.graphId, g.nodeB)!.state).toBe('materialized');
            expect(outboxKinds(id, g.graphId).filter(k => k === 'graph_gate_released')).toHaveLength(1);

            // Even AFTER a legitimate release, the dead claimant's retry is not a
            // duplicate success — it is a hard rejection.
            expect(() => releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: c1.fencingToken!, leaseGeneration: 1,
                idempotencyKey: 'rel-dead', outcome: 'passed', nowMs: t0 + 5_000,
            })).toThrow(/gate_already_released/);
            expect(outboxKinds(id, g.graphId).filter(k => k === 'graph_gate_released')).toHaveLength(1);
        } finally {
            cleanup(id);
        }
    });
});

// ── Crash point (d): after commit / before notification — recovered release ────
//
// mesh-graph-gates.test.ts:556-583 already pins the generic case (failing wake
// handler → row stays pending → drain redelivers without a duplicate). The one
// scenario it does not combine is a wake-drain crash on the RECOVERED release of
// crash point (c); pin that composition here so a regression in the
// crash-recovery path cannot silently drop the exactly-once wake.

describe('crash after commit / before notification on a recovered release', () => {
    it('the wake of a retried-after-crash release survives a drain crash and fires exactly once', () => {
        const id = meshId('crash_notify');
        try {
            const g = buildGateGraph(id);
            const claim = openAndClaim(id, g);
            const releaseInput = {
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-notify', outcome: 'passed',
            };

            // Crash the first release mid-transaction, then recover it.
            const graphStore = gs();
            const realInsert = graphStore.insertOutboxEvent.bind(graphStore);
            const crashSpy = vi.spyOn(graphStore, 'insertOutboxEvent').mockImplementation((row) => {
                if (row.kind === 'graph_gate_released') throw new Error('simulated crash: power loss mid-transaction');
                return realInsert(row);
            });
            expect(() => releaseMeshGraphGate(releaseInput)).toThrow(/simulated crash/);
            crashSpy.mockRestore();

            // The recovered release commits while the wake transport is down:
            // the queue_wake row stays pending; the state change stands.
            registerMeshGraphQueueWakeHandler(() => { throw new Error('wake transport down'); });
            const rel = releaseMeshGraphGate(releaseInput);
            expect(rel.released).toBe(true);
            const wakeRows = gs().listOutboxEvents(id, g.graphId).filter(e => e.kind === 'queue_wake');
            expect(wakeRows).toHaveLength(1);
            expect(wakeRows[0].status).toBe('pending');

            // Transport recovers → the SAME row drains; the downstream wakes
            // exactly once across BOTH crashes.
            __resetMeshGraphTransitionRunnerForTests();
            const wakes: string[] = [];
            registerMeshGraphQueueWakeHandler(m => wakes.push(m));
            drainMeshGraphOutbox(id);
            drainMeshGraphOutbox(id); // a second drain must not re-fire
            expect(wakes).toEqual([id]);
            const finalWakes = gs().listOutboxEvents(id, g.graphId).filter(e => e.kind === 'queue_wake');
            expect(finalWakes).toHaveLength(1);
            expect(finalWakes[0].status).toBe('delivered');
        } finally {
            cleanup(id);
        }
    });
});
