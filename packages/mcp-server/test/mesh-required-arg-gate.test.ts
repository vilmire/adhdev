import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL, MESH_SEND_TASK_TOOL } from '../src/tools/mesh-tool-schemas.js';
import {
    missingRequiredToolArgsError,
    rejectUnknownMeshToolArgs,
    validateMeshToolArgs,
} from '../src/tools/validate-tool-args.js';

/**
 * Required-argument gate (wiring-unification A3, "node_id validation gap").
 *
 * Each schema's `required` list was nominal: the dispatcher enforced unknown keys
 * only, so a call missing `node_id` reached the handler and failed deep inside
 * node resolution with an unrelated error. `validateMeshToolArgs` makes the
 * schema's `required` list real at the tool boundary, alias-aware (task_id /
 * taskId) and blank-aware (an empty string is missing).
 */

test('every published tool rejects an empty call iff its schema declares required keys', () => {
    let enforced = 0;
    for (const tool of [...ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL]) {
        const required = (tool.inputSchema as { required?: string[] }).required ?? [];
        const error = validateMeshToolArgs(tool.name, {});
        if (required.length === 0) {
            assert.equal(error, null, `${tool.name} declares no required keys and must accept {}`);
        } else {
            assert.ok(error, `${tool.name} requires ${required.join(', ')} and must reject {}`);
            for (const key of required) assert.match(error, new RegExp(`"${key}"`), `${tool.name}: "${key}" must be named as missing`);
            enforced += 1;
        }
    }
    // The gate covers a substantial slice of the surface; a drop here means schemas lost their required lists.
    assert.ok(enforced >= 30, `expected at least 30 tools with required keys, saw ${enforced}`);
});

test('the unknown-key gate alone still accepts an empty call (its contract is unchanged)', () => {
    for (const tool of ALL_MESH_TOOLS) {
        assert.equal(rejectUnknownMeshToolArgs(tool.name, {}), null);
    }
});

test('a declared camelCase alias satisfies a snake_case required key', () => {
    assert.equal(validateMeshToolArgs('mesh_queue_cancel', { taskId: 't_x' }), null);
    assert.equal(validateMeshToolArgs('mesh_queue_cancel', { task_id: 't_x' }), null);
    assert.equal(validateMeshToolArgs('mesh_node_slots_list', { nodeId: 'n_x' }), null);
});

test('a blank required value counts as missing', () => {
    const error = validateMeshToolArgs('mesh_queue_cancel', { task_id: '   ' });
    assert.ok(error);
    assert.match(error, /Missing required parameter\(s\) for mesh_queue_cancel: "task_id"/);
});

test('unknown keys are reported before missing keys, so a typo gets the did-you-mean hint', () => {
    const error = validateMeshToolArgs('mesh_read_chat', { nod_id: 'n', session_id: 's' });
    assert.ok(error);
    assert.match(error, /Unknown parameter/);
    assert.match(error, /did you mean "node_id"\?/);
});

test('missing node_id / session_id on a session tool is named explicitly', () => {
    const error = validateMeshToolArgs('mesh_read_chat', {});
    assert.ok(error);
    assert.match(error, /"node_id"/);
    assert.match(error, /"session_id"/);
    assert.match(error, /Required: node_id, session_id/);
});

test('mesh_send_task: session_id is optional (sessionless node dispatch is a supported path), node_id is not', () => {
    assert.deepEqual(MESH_SEND_TASK_TOOL.inputSchema.required, ['node_id', 'message', 'difficulty']);
    assert.equal(validateMeshToolArgs('mesh_send_task', { node_id: 'n', message: 'm', difficulty: 'easy' }), null);
    const error = validateMeshToolArgs('mesh_send_task', { session_id: 's', message: 'm', difficulty: 'easy' });
    assert.ok(error);
    assert.match(error, /"node_id"/);
    assert.doesNotMatch(error, /"session_id"/);
});

test('hidden 1-release aliases and the flag-gated worker tool are validated against their real schema', () => {
    // The alias exists to inject `mode`, so the caller is not asked for it.
    assert.equal(validateMeshToolArgs('mesh_validate_refine_config', { node_id: 'n1' }), null);
    assert.equal(validateMeshToolArgs('mesh_refine_config_schema', {}), null);
    // The unified tool itself still requires it.
    assert.match(validateMeshToolArgs('mesh_refine_config', {}) ?? '', /"mode"/);
    const error = validateMeshToolArgs('mesh_notify_worker', { node_id: 'n' });
    assert.ok(error);
    assert.match(error, /"task_id"/);
    assert.match(error, /"message"/);
});

test('unknown tool names fall through to the dispatcher (null)', () => {
    assert.equal(validateMeshToolArgs('mesh_not_a_tool', {}), null);
    assert.equal(missingRequiredToolArgsError('x', undefined, {}), null);
});
