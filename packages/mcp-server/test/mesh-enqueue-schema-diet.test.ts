import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { MESH_ENQUEUE_BATCH_TOOL, MESH_ENQUEUE_TASK_TOOL } from '../src/tools/mesh-tool-schemas-queue.js';
import {
    MESH_ACCEPTED_ARG_ALIASES,
    MESH_RETIRED_ARGS,
    TOP_LEVEL_SCOPE,
    canonicalizeMeshToolArgs,
    validateMeshToolArgs,
} from '../src/tools/validate-tool-args.js';
/**
 * The enqueue schema diet + the retired graph-orchestration surface.
 *
 *  1. Schema diet — the enqueue schemas publish ONE canonical snake_case name per
 *     field and stay under a byte ceiling. The old aliases are still ACCEPTED by
 *     the validator, silently, so existing coordinators keep working.
 *  2. Graph orchestration is retired: gates / workspaces / inputs_from / run_if /
 *     batch_id / on_dependency_failure / orchestration_decision are rejected with
 *     a message that names the replacement (depends_on, the mesh policy).
 *  3. The graph tools are gone from the published list.
 */

const TASK_SCHEMA_MAX_BYTES = 4000;
const BATCH_SCHEMA_MAX_BYTES = 6000;

type Props = Record<string, unknown>;
const taskProps = MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as Props;
const batchProps = MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties as Props;
const batchTaskProps = (batchProps.tasks as any).items.properties as Props;

// ── 1. size ceilings ─────────────────────────────────────────────────────────

test('D2: mesh_enqueue_task schema JSON stays within 4 KB', () => {
    const bytes = JSON.stringify(MESH_ENQUEUE_TASK_TOOL).length;
    assert.ok(bytes <= TASK_SCHEMA_MAX_BYTES, `mesh_enqueue_task schema is ${bytes} bytes (ceiling ${TASK_SCHEMA_MAX_BYTES}) — compress prose instead of raising the ceiling`);
});

test('D2: mesh_enqueue_batch schema JSON stays within 6 KB', () => {
    const bytes = JSON.stringify(MESH_ENQUEUE_BATCH_TOOL).length;
    assert.ok(bytes <= BATCH_SCHEMA_MAX_BYTES, `mesh_enqueue_batch schema is ${bytes} bytes (ceiling ${BATCH_SCHEMA_MAX_BYTES}) — compress prose instead of raising the ceiling`);
});

test('the graph tools are no longer published', () => {
    for (const name of ['mesh_graph_view', 'mesh_graph_gate', 'mesh_graph_node_patch', 'mesh_graph_gate_extend']) {
        assert.equal(ALL_MESH_TOOLS.some(t => t.name === name), false, `${name} must not be published`);
    }
});

// ── 2. one canonical name per field ─────────────────────────────────────────

test('D2: the enqueue schemas publish no camelCase / alternate alias keys', () => {
    const scopes: Array<[string, Props]> = [
        ['mesh_enqueue_task', taskProps],
        ['mesh_enqueue_batch', batchProps],
        ['mesh_enqueue_batch tasks[]', batchTaskProps],
    ];
    const offenders: string[] = [];
    for (const [label, props] of scopes) {
        for (const key of Object.keys(props)) {
            if (/[A-Z]/.test(key) || key === 'read_only' || key === 'target_node') offenders.push(`${label}.${key}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('the graph fields are gone from every enqueue schema', () => {
    for (const key of ['run_if', 'on_false', 'on_upstream_skip', 'inputs_from', 'gated_by', 'workspace_ref']) {
        assert.equal(key in batchTaskProps, false, `tasks[].${key} must not be published`);
        assert.equal(key in taskProps, false, `mesh_enqueue_task.${key} must not be published`);
    }
    for (const key of ['gates', 'workspaces', 'batch_id', 'on_dependency_failure', 'orchestration_decision']) {
        assert.equal(key in batchProps, false, `mesh_enqueue_batch.${key} must not be published`);
    }
    assert.equal('orchestration_decision' in taskProps, false);
});

test('D2: the kept surface is still published', () => {
    for (const key of ['message', 'difficulty', 'depends_on', 'owned_paths', 'mission_id', 'required_tags', 'target_node_id', 'prefer_worktree', 'priority', 'model', 'thinking_level', 'not_before', 'max_retries', 'block_duplicate', 'allow_duplicate', 'task_mode', 'readonly', 'input']) {
        assert.ok(key in taskProps, `mesh_enqueue_task.${key}`);
    }
    for (const key of ['message', 'difficulty', 'depends_on', 'owned_paths', 'mission_id', 'required_tags', 'target_node_id', 'prefer_worktree', 'priority', 'model', 'thinking_level', 'not_before', 'max_retries', 'ref']) {
        assert.ok(key in batchTaskProps, `mesh_enqueue_batch tasks[].${key}`);
    }
    for (const key of ['tasks', 'mission_id', 'block_duplicate', 'allow_duplicate']) {
        assert.ok(key in batchProps, `mesh_enqueue_batch.${key}`);
    }
    assert.deepEqual((taskProps.difficulty as any).enum, ['easy', 'medium', 'difficult', 'freeform']);
});

/**
 * Resolves the JSON-schema `properties` object a scope's aliases are checked
 * against: {@link TOP_LEVEL_SCOPE} is the tool's own top-level properties;
 * any other scope name is a top-level array-of-objects property, and the
 * aliases apply to ITS items' properties (`tasks[]`, `patches[]`, `brief`, …).
 * Generic over every tool in ALL_MESH_TOOLS, so a new MESH_ACCEPTED_ARG_ALIASES
 * entry is covered automatically instead of needing a hardcoded map entry.
 */
function resolveScopeProps(toolName: string, scope: string): Props | undefined {
    const tool = ALL_MESH_TOOLS.find(t => t.name === toolName) as { inputSchema?: { properties?: Props } } | undefined;
    const topProps = tool?.inputSchema?.properties;
    if (!topProps) return undefined;
    if (scope === TOP_LEVEL_SCOPE) return topProps;
    const scopeProp = topProps[scope] as { type?: string; items?: { type?: string; properties?: Props }; properties?: Props } | undefined;
    // `brief` (mesh_mission_upsert) is a single nested object; `tasks` is an
    // array-of-objects whose ITEMS carry the aliased properties.
    return scopeProp?.items?.properties ?? scopeProp?.properties;
}

test('D2: every alias in the accepted-alias table maps onto a PUBLISHED canonical key', () => {
    for (const [tool, scopes] of Object.entries(MESH_ACCEPTED_ARG_ALIASES)) {
        for (const [scope, aliases] of Object.entries(scopes)) {
            const props = resolveScopeProps(tool, scope);
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
        allowDuplicate: false, taskMode: 'validation', read_only: true,
    }), null);
    assert.equal(validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', target_node: 'n' }), null);
    assert.equal(validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', targetNode: 'n' }), null);
});

test('D2: every legacy alias on mesh_enqueue_batch (top level, tasks[]) still validates clean', () => {
    const table = MESH_ACCEPTED_ARG_ALIASES.mesh_enqueue_batch;
    for (const [alias, canonical] of Object.entries(table[TOP_LEVEL_SCOPE])) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium' }], [alias]: SAMPLE_VALUE[canonical] });
        assert.equal(err, null, `top-level alias ${alias} was rejected: ${err}`);
    }
    for (const [alias, canonical] of Object.entries(table.tasks)) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', [alias]: SAMPLE_VALUE[canonical] }] });
        assert.equal(err, null, `tasks[] alias ${alias} was rejected: ${err}`);
    }
    assert.equal(validateMeshToolArgs('mesh_enqueue_batch', {
        tasks: [{ ref: 'a', message: 'm', difficulty: 'medium', dependsOn: [] }],
        missionId: 'm_1',
    }), null);
});

test('D2: an alias is enum-checked exactly like its canonical key', () => {
    const err = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', taskMode: 'bogus_mode' });
    assert.ok(err, 'an invalid enum value must not slip through under the alias spelling');
    assert.match(err!, /Invalid value for "task_mode"/);
    const nested = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', thinkingLevel: 'ultra' }] });
    assert.ok(nested);
    assert.match(nested!, /Invalid value for "thinking_level"/);
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

// ── 4. retired graph keys (break-once: drop MESH_RETIRED_ARGS → generic "Unknown") ──

test('graph fields inside batch tasks[] are rejected with a pointer at depends_on', () => {
    for (const key of MESH_RETIRED_ARGS.mesh_enqueue_batch.tasks.keys) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', {
            tasks: [{ ref: 'deploy', message: 'm', difficulty: 'medium', [key]: 'x' }],
        });
        assert.ok(err, `${key} must be rejected`);
        assert.match(err!, new RegExp(`Retired parameter\\(s\\) for mesh_enqueue_batch tasks\\[0\\] \\(ref 'deploy'\\): "${key}"`));
        assert.match(err!, /depends_on/);
        assert.doesNotMatch(err!, /Unknown parameter/);
    }
});

test('batch-level graph fields are rejected, naming the mesh policy for on_dependency_failure', () => {
    for (const key of ['gates', 'workspaces', 'batch_id', 'on_dependency_failure', 'orchestration_decision']) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium' }], [key]: [] });
        assert.ok(err, `${key} must be rejected`);
        assert.match(err!, new RegExp(`Retired parameter\\(s\\) for mesh_enqueue_batch: "${key}"`));
    }
    assert.match(validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium' }], on_dependency_failure: 'cancel' }) ?? '', /mesh policy onDependencyFailure/);
});

test('run_if / inputs_from on mesh_enqueue_task are rejected with the same replacement message', () => {
    for (const key of ['run_if', 'inputs_from', 'orchestration_decision']) {
        const err = validateMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', [key]: {} });
        assert.ok(err);
        assert.match(err!, new RegExp(`Retired parameter\\(s\\) for mesh_enqueue_task: "${key}"`));
        assert.match(err!, /depends_on/);
    }
});

test('orchestration_decision on mesh_send_task is rejected as a retired key, and no longer published', () => {
    for (const key of ['orchestration_decision', 'orchestrationDecision']) {
        const err = validateMeshToolArgs('mesh_send_task', { node_id: 'n', message: 'm', difficulty: 'medium', [key]: { decision: 'direct' } });
        assert.ok(err, `${key} must be rejected`);
        assert.match(err!, /Retired parameter\(s\) for mesh_send_task: "orchestration_decision"|Retired parameter\(s\) for mesh_send_task: "orchestrationDecision"/);
        assert.doesNotMatch(err!, /Unknown parameter/);
    }
    const sendTool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_send_task') as any;
    assert.equal('orchestration_decision' in sendTool.inputSchema.properties, false);
});
