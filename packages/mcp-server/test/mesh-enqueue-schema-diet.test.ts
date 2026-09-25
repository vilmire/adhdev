import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ALL_MESH_TOOLS,
    MESH_ENQUEUE_BATCH_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_GRAPH_GATE_CLAIM_TOOL,
} from '../src/tools/mesh-tool-schemas.js';
import {
    MESH_ACCEPTED_ARG_ALIASES,
    MESH_RETIRED_ARGS,
    TOP_LEVEL_SCOPE,
    canonicalizeMeshToolArgs,
    validateMeshToolArgs,
} from '../src/tools/validate-tool-args.js';
import { MESH_GRAPH_GATE_EXTEND_COMMAND, meshGraphGateClaim } from '../src/tools/mesh-tools-graph.js';
import { meshStatus, pickDaemonGraphUsage } from '../src/tools/mesh-tools-status.js';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

/**
 * graph-orchestration-simplification D2 + the MCP half of D3(c)/D6
 * (docs/design/2026-09-25-graph-orchestration-simplification.md).
 *
 *  1. Schema diet — the enqueue schemas publish ONE canonical snake_case name per
 *     field and stay under a byte ceiling (the 18 KB batch schema was the measured
 *     reason coordinators never reached for it). The old aliases are still ACCEPTED
 *     by the validator, silently, so existing coordinators keep working.
 *  2. run_if / on_false / on_upstream_skip are retired at the surface: rejected with
 *     a message that names depends_on + on_dependency_failure.
 *  3. The gate EXTEND verb rides on mesh_graph_gate_claim (tool count is pinned at 60)
 *     and dispatches the daemon command `mesh_graph_gate_extend`.
 *  4. mesh_status verbose passes the daemon's graphUsage through untouched.
 */

const TASK_SCHEMA_MAX_BYTES = 4000;
const BATCH_SCHEMA_MAX_BYTES = 6000;

type Props = Record<string, unknown>;
const taskProps = MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as Props;
const batchProps = MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties as Props;
const batchTaskProps = (batchProps.tasks as any).items.properties as Props;
const batchWorkspaceProps = (batchProps.workspaces as any).items.properties as Props;
const batchGateProps = (batchProps.gates as any).items.properties as Props;

// ── 1. size ceilings ─────────────────────────────────────────────────────────

test('D2: mesh_enqueue_task schema JSON stays within 4 KB', () => {
    const bytes = JSON.stringify(MESH_ENQUEUE_TASK_TOOL).length;
    assert.ok(bytes <= TASK_SCHEMA_MAX_BYTES, `mesh_enqueue_task schema is ${bytes} bytes (ceiling ${TASK_SCHEMA_MAX_BYTES}) — compress prose instead of raising the ceiling`);
});

test('D2: mesh_enqueue_batch schema JSON stays within 6 KB', () => {
    const bytes = JSON.stringify(MESH_ENQUEUE_BATCH_TOOL).length;
    assert.ok(bytes <= BATCH_SCHEMA_MAX_BYTES, `mesh_enqueue_batch schema is ${bytes} bytes (ceiling ${BATCH_SCHEMA_MAX_BYTES}) — compress prose instead of raising the ceiling`);
});

test('D2: the published tool count is unchanged at 60 (scripts/verify-docs.mjs counts it)', () => {
    assert.equal(ALL_MESH_TOOLS.length, 60);
    assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_graph_gate_extend'), false, 'extend rides on claim, not a 61st tool');
});

// ── 2. one canonical name per field ─────────────────────────────────────────

test('D2: the enqueue schemas publish no camelCase / alternate alias keys', () => {
    const scopes: Array<[string, Props]> = [
        ['mesh_enqueue_task', taskProps],
        ['mesh_enqueue_batch', batchProps],
        ['mesh_enqueue_batch tasks[]', batchTaskProps],
        ['mesh_enqueue_batch workspaces[]', batchWorkspaceProps],
        ['mesh_enqueue_batch gates[]', batchGateProps],
    ];
    const offenders: string[] = [];
    for (const [label, props] of scopes) {
        for (const key of Object.keys(props)) {
            if (/[A-Z]/.test(key) || key === 'read_only' || key === 'target_node') offenders.push(`${label}.${key}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('D2: run_if / on_false / on_upstream_skip are gone from the batch per-task schema', () => {
    for (const key of ['run_if', 'runIf', 'on_false', 'onFalse', 'on_upstream_skip', 'onUpstreamSkip']) {
        assert.equal(key in batchTaskProps, false, `tasks[].${key} must not be published`);
    }
});

test('D2: the kept surface is still published', () => {
    for (const key of ['message', 'difficulty', 'depends_on', 'owned_paths', 'mission_id', 'required_tags', 'target_node_id', 'prefer_worktree', 'priority', 'model', 'thinking_level', 'not_before', 'max_retries', 'block_duplicate', 'allow_duplicate', 'orchestration_decision', 'task_mode', 'readonly', 'input']) {
        assert.ok(key in taskProps, `mesh_enqueue_task.${key}`);
    }
    for (const key of ['message', 'difficulty', 'depends_on', 'owned_paths', 'mission_id', 'required_tags', 'target_node_id', 'prefer_worktree', 'priority', 'model', 'thinking_level', 'not_before', 'max_retries', 'inputs_from', 'gated_by', 'workspace_ref', 'ref']) {
        assert.ok(key in batchTaskProps, `mesh_enqueue_batch tasks[].${key}`);
    }
    for (const key of ['tasks', 'gates', 'workspaces', 'batch_id', 'mission_id', 'block_duplicate', 'allow_duplicate', 'on_dependency_failure', 'orchestration_decision']) {
        assert.ok(key in batchProps, `mesh_enqueue_batch.${key}`);
    }
    assert.deepEqual((taskProps.difficulty as any).enum, ['easy', 'medium', 'difficult', 'freeform']);
    assert.deepEqual((batchProps.on_dependency_failure as any).enum, ['block', 'cancel']);
});

test('D2: every alias in the accepted-alias table maps onto a PUBLISHED canonical key', () => {
    const scopeProps: Record<string, Record<string, Props>> = {
        mesh_enqueue_task: { [TOP_LEVEL_SCOPE]: taskProps },
        mesh_enqueue_batch: { [TOP_LEVEL_SCOPE]: batchProps, tasks: batchTaskProps, workspaces: batchWorkspaceProps },
    };
    for (const [tool, scopes] of Object.entries(MESH_ACCEPTED_ARG_ALIASES)) {
        for (const [scope, aliases] of Object.entries(scopes)) {
            const props = scopeProps[tool]?.[scope];
            assert.ok(props, `${tool}/${scope || '<top>'} has no schema scope`);
            for (const [alias, canonical] of Object.entries(aliases)) {
                assert.ok(canonical in props!, `${tool}/${scope || '<top>'}: alias ${alias} → ${canonical}, which is not published`);
                assert.equal(alias in props!, false, `${tool}/${scope || '<top>'}: alias ${alias} must not be published`);
            }
        }
    }
});

// ── 3. aliases are accepted silently (break-once: drop an alias from the table → red) ──

/** A value of the right shape for each canonical key, so enum checks pass. */
const SAMPLE_VALUE: Record<string, unknown> = {
    task_mode: 'code_change',
    readonly: true,
    required_tags: ['os=darwin'],
    owned_paths: ['src/**'],
    target_node_id: 'node_x',
    prefer_worktree: true,
    depends_on: ['t_1'],
    mission_id: 'm_1',
    thinking_level: 'high',
    not_before: 1000,
    max_retries: 1,
    block_duplicate: false,
    allow_duplicate: true,
    orchestration_decision: {},
    batch_id: 'b1',
    on_dependency_failure: 'cancel',
    inputs_from: [],
    workspace_ref: 'w1',
    gated_by: ['g1'],
    source_node_id: 'node_x',
    base_revision: 'HEAD',
    desired_path: '/tmp/x',
    cleanup_on_graph_failure: true,
};

test('D2: every legacy alias on mesh_enqueue_task still validates clean', () => {
    for (const [alias, canonical] of Object.entries(MESH_ACCEPTED_ARG_ALIASES.mesh_enqueue_task[TOP_LEVEL_SCOPE])) {
        const err = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', [alias]: SAMPLE_VALUE[canonical] });
        assert.equal(err, null, `alias ${alias} was rejected: ${err}`);
    }
    // The concrete spellings existing coordinators send, named explicitly so the
    // table cannot lose one without this going red.
    assert.equal(validateMeshToolArgs('mesh_enqueue_task', {
        message: 'm', difficulty: 'medium', dependsOn: ['t_1'], missionId: 'm_1', requiredTags: ['os=darwin'], ownedPaths: ['src/a.ts'],
        targetNodeId: 'n', preferWorktree: true, notBefore: 5, maxRetries: 2, thinkingLevel: 'low', blockDuplicate: true,
        allowDuplicate: false, orchestrationDecision: {}, taskMode: 'validation', read_only: true,
    }), null);
    assert.equal(validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', target_node: 'n' }), null);
    assert.equal(validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', targetNode: 'n' }), null);
});

test('D2: every legacy alias on mesh_enqueue_batch (top level, tasks[], workspaces[]) still validates clean', () => {
    const table = MESH_ACCEPTED_ARG_ALIASES.mesh_enqueue_batch;
    for (const [alias, canonical] of Object.entries(table[TOP_LEVEL_SCOPE])) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium' }], [alias]: SAMPLE_VALUE[canonical] });
        assert.equal(err, null, `top-level alias ${alias} was rejected: ${err}`);
    }
    for (const [alias, canonical] of Object.entries(table.tasks)) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', [alias]: SAMPLE_VALUE[canonical] }] });
        assert.equal(err, null, `tasks[] alias ${alias} was rejected: ${err}`);
    }
    for (const [alias, canonical] of Object.entries(table.workspaces)) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium' }], workspaces: [{ ref: 'w1', [alias]: SAMPLE_VALUE[canonical] }] });
        assert.equal(err, null, `workspaces[] alias ${alias} was rejected: ${err}`);
    }
    assert.equal(validateMeshToolArgs('mesh_enqueue_batch', {
        tasks: [{ ref: 'a', message: 'm', difficulty: 'medium', dependsOn: [], inputsFrom: [], workspaceRef: 'w', gatedBy: ['g'] }],
        missionId: 'm_1', batchId: 'b', onDependencyFailure: 'block',
    }), null);
});

test('D2: an alias is enum-checked exactly like its canonical key', () => {
    const err = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', taskMode: 'bogus_mode' });
    assert.ok(err, 'an invalid enum value must not slip through under the alias spelling');
    assert.match(err!, /Invalid value for "task_mode"/);
    const nested = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', thinkingLevel: 'ultra' }] });
    assert.ok(nested);
    assert.match(nested!, /Invalid value for "thinking_level"/);
    const top = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium' }], onDependencyFailure: 'explode' });
    assert.ok(top);
    assert.match(top!, /on_dependency_failure/);
});

test('D2: canonicalization is pure and the canonical spelling wins a collision', () => {
    const raw = { message: 'm', difficulty: 'medium', dependsOn: ['alias'], depends_on: ['canonical'] };
    const out = canonicalizeMeshToolArgs('mesh_enqueue_task', raw);
    assert.deepEqual(out.depends_on, ['canonical']);
    assert.equal('dependsOn' in out, false);
    assert.deepEqual(raw.dependsOn, ['alias'], 'the caller\'s args object must not be mutated');
    assert.equal(canonicalizeMeshToolArgs('mesh_status', raw), raw, 'tools without an alias table are untouched');
});

test('D2: the Unknown-parameter message lists canonical keys only — never an alias', () => {
    const err = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', bogus_key: 1 });
    assert.ok(err);
    assert.match(err!, /Unknown parameter\(s\) for mesh_enqueue_task: "bogus_key"/);
    const allowed = err!.split('Allowed parameters: ')[1] ?? '';
    for (const alias of Object.keys(MESH_ACCEPTED_ARG_ALIASES.mesh_enqueue_task[TOP_LEVEL_SCOPE])) {
        assert.ok(!allowed.split(/, |\.$/).includes(alias), `alias ${alias} leaked into the allowed list`);
    }
    const nested = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', bogus_key: 1 }] });
    assert.ok(nested);
    const nestedAllowed = nested!.split('Allowed parameters: ')[1] ?? '';
    for (const alias of Object.keys(MESH_ACCEPTED_ARG_ALIASES.mesh_enqueue_batch.tasks)) {
        assert.ok(!nestedAllowed.split(/, |\.$/).includes(alias), `alias ${alias} leaked into the tasks[] allowed list`);
    }
    // A near-miss typo still gets a did-you-mean pointing at the CANONICAL key.
    const typo = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', depend_on: ['t'] });
    assert.ok(typo);
    assert.match(typo!, /did you mean "depends_on"/);
});

// ── 4. retired conditional keys (break-once: drop MESH_RETIRED_ARGS → generic "Unknown") ──

test('D2: run_if & co. inside batch tasks[] are rejected with a pointer at depends_on + on_dependency_failure', () => {
    for (const key of MESH_RETIRED_ARGS.mesh_enqueue_batch.tasks.keys) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', {
            tasks: [{ ref: 'deploy', message: 'm', difficulty: 'medium', [key]: key.toLowerCase().includes('if') ? { from: 'x', select: '/ok' } : 'skip' }],
        });
        assert.ok(err, `${key} must be rejected`);
        assert.match(err!, new RegExp(`Retired parameter\\(s\\) for mesh_enqueue_batch tasks\\[0\\] \\(ref 'deploy'\\): "${key}"`));
        assert.match(err!, /depends_on/);
        assert.match(err!, /on_dependency_failure/);
        assert.doesNotMatch(err!, /Unknown parameter/);
    }
});

test('D2: run_if on mesh_enqueue_task is rejected with the same replacement message', () => {
    const err = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', run_if: { always: true } });
    assert.ok(err);
    assert.match(err!, /Retired parameter\(s\) for mesh_enqueue_task: "run_if"/);
    assert.match(err!, /depends_on/);
    assert.match(err!, /on_dependency_failure/);
});

test('D2: the retirement is scoped — graph node patch keeps its own run_if key', () => {
    // mesh_graph_node_patch / gate release patches repair already-persisted specs;
    // their schema still declares run_if and is not part of this surface cut.
    assert.equal(validateMeshToolArgs('mesh_graph_node_patch', { node: 'n1', base_spec_patch: { run_if: { always: true } } }), null);
});

// ── 5. gate extend (D3(c)) ───────────────────────────────────────────────────

function recordingCtx(reply: (command: string, args: Record<string, unknown>) => unknown) {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const transport = {
        command: async (command: string, args: Record<string, unknown> = {}) => {
            calls.push({ command, args });
            return reply(command, args);
        },
    };
    const ctx = { mesh: { id: 'mesh_ext', nodes: [] }, transport, coordinatorSessionId: 'coord_1' } as any;
    return { ctx, calls };
}

test('D3(c): claim with extend_seconds dispatches mesh_graph_gate_extend {mesh_id, gate_id, extend_seconds} and takes no lease', async () => {
    assert.equal(MESH_GRAPH_GATE_EXTEND_COMMAND, 'mesh_graph_gate_extend');
    const { ctx, calls } = recordingCtx(command => {
        if (command === 'mesh_graph_gate_extend') {
            return { success: true, extended: true, gateId: 'gate_1', gateState: 'awaiting_coordinator', deadlineAt: '2026-09-26T00:00:00.000Z', previousDeadlineAt: '2026-09-25T00:00:00.000Z' };
        }
        return { success: true };
    });
    const res = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: 'gate_1', extend_seconds: 86400 }));
    const dispatched = calls.filter(c => c.command !== 'tool_call_record' && c.command !== 'mesh_record');
    assert.deepEqual(dispatched.map(c => c.command), ['mesh_graph_gate_extend'], 'extend must not claim (no graph_gate_claim call)');
    assert.deepEqual(dispatched[0].args, { mesh_id: 'mesh_ext', gate_id: 'gate_1', extend_seconds: 86400 });
    assert.equal(res.success, true);
    assert.equal(res.extended, true);
    assert.equal(res.deadlineAt, '2026-09-26T00:00:00.000Z', 'the daemon\'s deadline is passed through, not recomputed');
    assert.equal(res.previousDeadlineAt, '2026-09-25T00:00:00.000Z');
    assert.equal(res.fencingToken, undefined, 'no lease → no fencing token');
});

test('D3(c): a daemon refusal comes back as a typed failure', async () => {
    const { ctx } = recordingCtx(command => command === 'mesh_graph_gate_extend'
        ? { success: false, code: 'gate_terminal:released', error: 'gate not extendable (gate_terminal:released)', extended: false, gateState: 'released' }
        : { success: true });
    const res = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: 'gate_1', extend_seconds: 3600 }));
    assert.equal(res.success, false);
    assert.equal(res.extended, false);
    assert.equal(res.code, 'gate_terminal:released');
    assert.equal(res.gateState, 'released');
});

test('D3(c): extend_seconds is refused (without a daemon call) when mixed with claim args or non-positive', async () => {
    const { ctx, calls } = recordingCtx(() => ({ success: true }));
    const mixed = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: 'gate_1', extend_seconds: 60, lease_seconds: 600 }));
    assert.equal(mixed.success, false);
    assert.equal(mixed.code, 'extend_with_claim_args');
    assert.deepEqual(mixed.conflicting, ['lease_seconds']);
    const zero = JSON.parse(await meshGraphGateClaim(ctx, { gate_id: 'gate_1', extend_seconds: 0 }));
    assert.equal(zero.code, 'invalid_extend_seconds');
    assert.equal(calls.some(c => c.command === 'mesh_graph_gate_extend' || c.command === 'graph_gate_claim'), false);
});

test('D3(c): the claim schema declares extend_seconds and the validator accepts it', () => {
    const props = MESH_GRAPH_GATE_CLAIM_TOOL.inputSchema.properties as Props;
    assert.ok('extend_seconds' in props);
    assert.match(MESH_GRAPH_GATE_CLAIM_TOOL.description, /extend_seconds/);
    assert.equal(validateMeshToolArgs('mesh_graph_gate_claim', { gate_id: 'g', extend_seconds: 86400 }), null);
});

// ── 6. mesh_status verbose graphUsage passthrough (D6) ───────────────────────

test('D6: pickDaemonGraphUsage returns the first object block and never synthesizes one', () => {
    const block = { graphsLast7d: 3, nodesPerGraphP50: 2, gatesExpired: 0, gatesAutoAbandoned: 1, depsChainedViaEnqueueTask: 4 };
    assert.equal(pickDaemonGraphUsage(undefined, { graphUsage: block }), block);
    assert.equal(pickDaemonGraphUsage({ graphUsage: [1] }, { graphUsage: 'x' }, null), undefined);
    assert.equal(pickDaemonGraphUsage({}), undefined);
});

function statusCtx(graphUsage: Record<string, unknown> | undefined) {
    const mesh = {
        id: 'mesh-graphusage', name: 'Mesh', repoIdentity: 'vilmire/adhdev',
        policy: {}, coordinator: {},
        defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{ id: 'node-a', workspace: '/a', repoRoot: '/a', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: {} }],
    };
    const cleanGit = { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] };
    const responder = (command: string) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        if (command === 'git_status') return { success: true, status: cleanGit };
        return { success: true };
    };
    const transport: any = {};
    transport.command = async (c: string, a?: any) => {
        if (!isTurnIpcCommand(c)) return responder(c);
        const result = await answerTurnIpc(c, a ?? {});
        if (c === 'active_work_query' && result?.activeWork && typeof result.activeWork === 'object') {
            const summary = { ...(result.activeWork.summary ?? {}) };
            delete summary.graphUsage; // make the fixture independent of the daemon-core dist in use
            if (graphUsage) summary.graphUsage = graphUsage;
            result.activeWork = { ...result.activeWork, summary };
        }
        return result;
    };
    transport.meshCommand = async (_d: string, c: string) => responder(c);
    return { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } as any;
}

test('D6: mesh_status verbose carries the daemon graphUsage block verbatim; compact does not', async () => {
    const block = { graphsLast7d: 5, nodesPerGraphP50: 2, gatesExpired: 1, gatesAutoAbandoned: 2, depsChainedViaEnqueueTask: 7 };
    const verbose = JSON.parse(await meshStatus(statusCtx(block), { verbose: true }));
    assert.deepEqual(verbose.graphUsage, block);
    assert.equal(verbose.activeWorkSummary?.graphUsage, undefined, 'hoisted, not duplicated under activeWorkSummary');

    const compact = JSON.parse(await meshStatus(statusCtx(block)));
    assert.equal(compact.graphUsage, undefined, 'graphUsage is a verbose-only block');
    assert.equal(compact.activeWorkSummary?.graphUsage, undefined, 'and must not ride along in the compact activeWorkSummary');

    const absent = JSON.parse(await meshStatus(statusCtx(undefined), { verbose: true }));
    assert.equal('graphUsage' in absent, false, 'no daemon block → no field (never synthesized)');
});
