import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION — M-GRAPH-INPUTS-LATE-REJECT: a malformed `inputs_from`
// was accepted at enqueue and only rejected at MATERIALIZATION.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :204-246 — the binding spec + its strict grammar.
//     :278-283 — materialization_error:* blocks the still-pending node.
//
// ★ THE DEFECT. The strict validator `parseInputBindings` had exactly ONE
// production caller: `settleDownstreamNode`'s materialization step, which only
// runs once every predecessor has COMPLETED. At enqueue, the MCP schema was a
// bare `items: {type:'object'}` and the plan's own `collectInputSourceRefs`
// deliberately skipped malformed entries ("Shape errors are left to C1's strict
// parser"), so a typo was accepted, persisted into the node's IMMUTABLE
// baseSpecJson, and rejected hours later — at the exact moment the plan was
// finally ready to pay off.
//
// That is the worst possible failure shape: all the upstream work SUCCEEDS, and
// the one step that was supposed to consume it dies. Measured live on graph
// `69103049` — nodes A/B/C/D all `completed`, the synthesis node blocked.
//
// A shape error is knowable from the request ALONE, so it now rejects at
// enqueue, atomically, like every other malformed-plan rejection.
//
// ★ Scope: this deliberately cannot catch `required_input_missing` — a
// well-formed binding whose source never produced that field is only knowable
// after the upstream completes. That case stays a materialization error, and
// recovering from it is what mesh_graph_node_patch is for.

const testTmpDir = path.join(tmpdir(), `adhdev-graph-inputs-enq-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
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

import { commitMeshGraphPlan, MeshGraphPlanError } from '../../src/mesh/mesh-graph-plan.js';
import { __resetMeshGraphTransitionRunnerForTests } from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    getQueue,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function meshId(tag: string): string {
    return `mesh_inputsenq_${tag}_${randomUUID().slice(0, 8)}`;
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

/** produce → consume, where the consumer binds the producer's output. */
function planWithBinding(mesh: string, inputsFrom: unknown) {
    return commitMeshGraphPlan({
        meshId: mesh,
        tasks: [
            { ref: 'produce', message: 'produce the thing', difficulty: 'easy' },
            { ref: 'consume', message: 'consume it', difficulty: 'easy', inputs_from: inputsFrom },
        ] as any,
    });
}

function planError(mesh: string, inputsFrom: unknown): MeshGraphPlanError {
    try {
        planWithBinding(mesh, inputsFrom);
    } catch (e) {
        expect(e).toBeInstanceOf(MeshGraphPlanError);
        return e as MeshGraphPlanError;
    }
    throw new Error('expected the plan to be REJECTED, but it was accepted');
}

describe('★ M-GRAPH-INPUTS-LATE-REJECT — inputs_from shape is validated at ENQUEUE', () => {
    // Each case is a plausible authoring mistake that used to be accepted and
    // then killed the batch after every predecessor had already completed.
    const malformed: Array<[string, unknown]> = [
        ['not an array', { from: 'produce', select: '/summary', as: 'out' }],
        ['entry is not an object', ['produce']],
        ['missing `from`', [{ select: '/summary', as: 'out' }]],
        ['empty `from`', [{ from: '   ', select: '/summary', as: 'out' }]],
        ['missing `select`', [{ from: 'produce', as: 'out' }]],
        ['`select` is not a JSON Pointer (no leading slash)', [{ from: 'produce', select: 'summary', as: 'out' }]],
        ['missing `as`', [{ from: 'produce', select: '/summary' }]],
        ['`as` violates the name grammar', [{ from: 'produce', select: '/summary', as: '9-bad name' }]],
        ['duplicate `as`', [
            { from: 'produce', select: '/summary', as: 'out' },
            { from: 'produce', select: '/detail', as: 'out' },
        ]],
        ['unknown `format`', [{ from: 'produce', select: '/summary', as: 'out', format: 'yaml' }]],
        ['unknown `overflow`', [{ from: 'produce', select: '/summary', as: 'out', overflow: 'clamp' }]],
        ['non-boolean `required`', [{ from: 'produce', select: '/summary', as: 'out', required: 'yes' }]],
        ['`max_bytes` over the hard maximum', [{ from: 'produce', select: '/summary', as: 'out', max_bytes: 1 << 20 }]],
    ];

    for (const [label, inputsFrom] of malformed) {
        it(`rejects at enqueue: ${label}`, () => {
            const id = meshId('bad');
            try {
                const err = planError(id, inputsFrom);
                expect(err.code).toBe('invalid_binding_spec');
                // The offending task is NAMED — a batch-wide "something is wrong"
                // would leave the author hunting through the plan.
                expect(err.extra?.taskRef).toBe('consume');
                expect(err.extra?.taskIndex).toBe(1);
            } finally {
                cleanup(id);
            }
        });
    }

    it('★ the rejection is ATOMIC — a rejected batch writes NO queue row and NO graph', () => {
        const id = meshId('atomic');
        try {
            planError(id, [{ from: 'produce', select: 'summary', as: 'out' }]);

            // The valid sibling task must not survive either: the whole batch is
            // refused, exactly like a cycle or an unresolvable target node.
            expect(getQueue(id)).toHaveLength(0);
            expect(gs().listGraphsByMesh(id)).toHaveLength(0);
        } finally {
            cleanup(id);
        }
    });

    it('★ rejects a binding whose `from` names nothing in the batch', () => {
        const id = meshId('unknownref');
        try {
            // Shape-valid, but `typo` is not a ref here. The edge builder silently
            // skips an unresolvable source (correct for depends_on, which may name
            // a pre-existing queue task id) — for a BINDING that means no ordering
            // edge AND no source envelope, so the node would materialize against
            // nothing instead of waiting.
            const err = planError(id, [{ from: 'typo', select: '/summary', as: 'out' }]);
            expect(err.code).toBe('unknown_input_source_ref');
            expect(err.extra?.sourceRef).toBe('typo');
            expect(getQueue(id)).toHaveLength(0);
        } finally {
            cleanup(id);
        }
    });

    it('accepts a well-formed binding, and still wires the requires edge + hold', () => {
        const id = meshId('good');
        try {
            const plan = planWithBinding(id, [
                { from: 'produce', select: '/summary', as: 'summary', required: true },
            ]);
            const [nodeProduce, nodeConsume] = plan.nodeIdByIndex;

            // The binding implies an execution prerequisite: a `requires` edge.
            const edges = gs().listEdges(plan.graphId);
            expect(edges.some(e =>
                e.fromNodeId === nodeProduce && e.toNodeId === nodeConsume && e.kind === 'requires')).toBe(true);

            // And the consumer is HELD until the graph settles it — validating the
            // shape early must not accidentally let an unbound node run.
            expect(plan.heldNodeIds).toContain(nodeConsume);
            expect(gs().getNode(plan.graphId, nodeConsume)!.state).toBe('blocked');

            // The spec is persisted verbatim for the C1 parser to re-read.
            const spec = JSON.parse(gs().getNode(plan.graphId, nodeConsume)!.baseSpecJson);
            expect(spec.inputs_from).toEqual([
                { from: 'produce', select: '/summary', as: 'summary', required: true },
            ]);
        } finally {
            cleanup(id);
        }
    });

    it('accepts a binding that reads a GATE ref (the designed gate-outcome usage)', () => {
        const id = meshId('gateref');
        try {
            // A gate ref is a legitimate binding source (design P3: "gate outcome
            // drives run_if and conditional skip"), so the new ref check must
            // resolve against gates too, not only tasks.
            const plan = commitMeshGraphPlan({
                meshId: id,
                tasks: [
                    { ref: 'build', message: 'build', difficulty: 'easy' },
                    {
                        ref: 'deploy', message: 'deploy', difficulty: 'easy',
                        inputs_from: [{ from: 'land', select: '/gate_outcome', as: 'outcome' }],
                    },
                ],
                gates: [{ ref: 'land', action: 'refinery', depends_on: ['build'] }],
            } as any);
            expect(plan.gates).toHaveLength(1);
            // Binding a gate ref implies a `gate` edge, never a `requires` one —
            // a released gate terminates at `released`, so a requires edge would
            // be unsatisfiable (the gate-ref binding deadlock).
            const gateNodeId = plan.gates[0].nodeId;
            const deployNodeId = plan.nodeIdByIndex[1];
            const edges = gs().listEdges(plan.graphId).filter(e =>
                e.fromNodeId === gateNodeId && e.toNodeId === deployNodeId);
            expect(edges.map(e => e.kind)).toEqual(['gate']);
        } finally {
            cleanup(id);
        }
    });

    it('leaves a batch with no inputs_from completely untouched (old-path compatibility)', () => {
        const id = meshId('oldpath');
        try {
            // The compatibility rule (design :576-583): a plain depends_on task is
            // NOT held. The new validation must not drag it onto the graph path.
            const plan = commitMeshGraphPlan({
                meshId: id,
                tasks: [
                    { ref: 'a', message: 'a', difficulty: 'easy' },
                    { ref: 'b', message: 'b', difficulty: 'easy', dependsOn: ['a'], gated_by: ['g'] },
                ],
                gates: [{ ref: 'g', action: 'approval' }],
            } as any);
            expect(plan.tasks).toHaveLength(2);
            expect(plan.heldNodeIds).not.toContain(plan.nodeIdByIndex[0]);
        } finally {
            cleanup(id);
        }
    });
});
