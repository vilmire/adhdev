import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION — M-GATE-STUCK-DECLARED: a coordinator gate with an empty
// `depends_on` never opened.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :373-423 — declared → awaiting_coordinator → claimed → released; the ONLY
//                way through a gate is a fenced release.
//     :402-405 — once its predecessors are SATISFIED the gate moves to
//                `awaiting_coordinator`, blocks downstream with
//                `coordinator_gate:<gateId>` and emits graph_gate_awaiting.
//
// THE DEFECT: `maybeOpenCoordinatorGate` was reachable only from an edge
// traversal out of a node that had just reached a terminal state (the runner's
// completion frontier, and the release frontier in mesh-graph-gates). A gate
// with no `depends_on` has no incoming edge, so no completion ever named it as
// a downstream target and the opener was never called. The gate sat `declared`
// indefinitely; `mesh_graph_gate_claim` answered `gate_not_awaiting`
// ("predecessors have not completed yet") for a gate with ZERO predecessors,
// and every downstream task stayed pinned under `graph_materialization_pending`.
//
// Measured live 2026-09-06: batch `queued-send-fix-land-deploy-rc91`
// (graph 585ba216, gate 19bcdfe4, action=refinery, no depends_on) held for 2h+.
//
// "No predecessors" is ALREADY "predecessors satisfied" — the opener's own
// `incoming.every(...)` predicate is vacuously true for the empty set. The fix
// only makes commit time ASK.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-gate-nopred-${randomUUID().slice(0, 8)}`);
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

import { commitMeshGraphPlan } from '../../src/mesh/mesh-graph-plan.js';
import {
    claimMeshGraphGate,
    coordinatorGateBlockReason,
    releaseMeshGraphGate,
} from '../../src/mesh/mesh-graph-gates.js';
import { __resetMeshGraphTransitionRunnerForTests } from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    getQueue,
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function meshId(tag: string): string {
    return `mesh_gatenopred_${tag}_${randomUUID().slice(0, 8)}`;
}

function gs() {
    return MeshRuntimeStore.getInstance().graphStore();
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

/**
 * The live shape: a `refinery` gate with NO depends_on, and a deploy task gated
 * behind it. Nothing upstream of the gate exists at all.
 */
function planNoPredecessorGate(mesh: string) {
    const result = commitMeshGraphPlan({
        meshId: mesh,
        tasks: [
            {
                ref: 'deploy',
                message: 'deploy rc',
                taskMode: 'code_change',
                difficulty: 'medium',
                gated_by: ['land'],
            } as any,
        ],
        gates: [{ ref: 'land', action: 'refinery', instructions: 'Land it.' }],
    });
    const gate = result.gates.find(g => g.ref === 'land')!;
    return {
        graphId: result.graphId,
        gateId: gate.gateId,
        nodeG: gate.nodeId,
        nodeDeploy: result.nodeIdByIndex[0],
        taskDeploy: result.tasks[0],
    };
}

describe('★ M-GATE-STUCK-DECLARED — a gate with no predecessors opens at commit', () => {
    it('moves to awaiting_coordinator immediately, with no upstream completion to trigger it', () => {
        const id = meshId('open');
        try {
            const g = planNoPredecessorGate(id);

            // ★ THE REGRESSION: pre-fix this was 'declared' and stayed there
            // forever — there was no event left that could ever move it.
            expect(gs().getGate(g.gateId)!.state).toBe('awaiting_coordinator');
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('awaiting_coordinator');

            // The gate is an intentional STOP: downstream is blocked by the
            // gate-owned reason, NOT left under graph_materialization_pending.
            expect(gs().getNode(g.graphId, g.nodeDeploy)!.state).toBe('blocked');
            const entry = getQueue(id).find(e => e.id === g.taskDeploy.id)!;
            expect(entry.blockedReason).toBe(coordinatorGateBlockReason(g.gateId));

            // graph_gate_awaiting committed in the SAME transaction as the open.
            const awaiting = gs().listOutboxEvents(id, g.graphId)
                .filter(e => e.kind === 'graph_gate_awaiting');
            expect(awaiting).toHaveLength(1);
            expect(JSON.parse(awaiting[0].payload).gateId).toBe(g.gateId);

            // An open gate rolls the graph to waiting_gate.
            expect(gs().getGraph(g.graphId)!.status).toBe('waiting_gate');
        } finally { cleanup(id); }
    });

    it('is CLAIMABLE right away — the live symptom was gate_not_awaiting on a zero-predecessor gate', () => {
        const id = meshId('claim');
        try {
            const g = planNoPredecessorGate(id);
            const claim = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-coord',
            });
            // Pre-fix: { claimed: false, reason: 'gate_not_awaiting' }.
            expect(claim.claimed).toBe(true);
            expect(claim.fencingToken).toBeTruthy();
        } finally { cleanup(id); }
    });

    it('releases through the normal fenced path and unblocks downstream', () => {
        const id = meshId('release');
        try {
            const g = planNoPredecessorGate(id);
            const claim = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-coord',
            });
            const released = releaseMeshGraphGate({
                meshId: id, gateId: g.gateId,
                fencingToken: claim.fencingToken!, leaseGeneration: claim.leaseGeneration!,
                idempotencyKey: 'rel-1', outcome: 'passed',
            });
            expect(released.released).toBe(true);
            expect(gs().getGate(g.gateId)!.state).toBe('released');

            // The deploy task is no longer held by the gate.
            const entry = getQueue(id).find(e => e.id === g.taskDeploy.id)!;
            expect(entry.blockedReason).not.toBe(coordinatorGateBlockReason(g.gateId));
        } finally { cleanup(id); }
    });
});

// ── Regression guard: the fix must NOT open gates that DO have predecessors ───

describe('★ gates WITH predecessors still open only on upstream completion', () => {
    function planDependentGate(mesh: string) {
        const result = commitMeshGraphPlan({
            meshId: mesh,
            tasks: [
                { ref: 'a', message: 'do A', taskMode: 'code_change', difficulty: 'medium' } as any,
                {
                    ref: 'deploy', message: 'deploy rc', taskMode: 'code_change',
                    difficulty: 'medium', gated_by: ['land'],
                } as any,
            ],
            gates: [{ ref: 'land', action: 'refinery', depends_on: ['a'], instructions: 'Land it.' }],
        });
        const gate = result.gates.find(g => g.ref === 'land')!;
        return {
            graphId: result.graphId, gateId: gate.gateId, nodeG: gate.nodeId,
            taskA: result.tasks[0], taskDeploy: result.tasks[1],
        };
    }

    it('stays `declared` at commit — an unmet predecessor must never open early', () => {
        const id = meshId('dep');
        try {
            const g = planDependentGate(id);
            expect(gs().getGate(g.gateId)!.state).toBe('declared');
            expect(gs().getNode(g.graphId, g.nodeG)!.state).toBe('declared');
            expect(
                gs().listOutboxEvents(id, g.graphId).filter(e => e.kind === 'graph_gate_awaiting'),
            ).toHaveLength(0);

            const claim = claimMeshGraphGate({
                meshId: id, gateId: g.gateId, coordinatorSessionId: 'sess-coord',
            });
            expect(claim.claimed).toBe(false);
            expect(claim.reason).toBe('gate_not_awaiting');
        } finally { cleanup(id); }
    });

    it('opens once the predecessor completes — the pre-existing path is intact', () => {
        const id = meshId('depdone');
        try {
            const g = planDependentGate(id);
            expect(gs().getGate(g.gateId)!.state).toBe('declared');
            updateTaskStatus(id, g.taskA.id, 'completed');
            expect(gs().getGate(g.gateId)!.state).toBe('awaiting_coordinator');
            expect(
                gs().listOutboxEvents(id, g.graphId).filter(e => e.kind === 'graph_gate_awaiting'),
            ).toHaveLength(1);
        } finally { cleanup(id); }
    });
});
