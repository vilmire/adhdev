import assert from 'node:assert/strict';
import test from 'node:test';

import { RETIRED_MESH_TOOLS, CANONICAL_MESH_TOOL_NAMES } from '@adhdev/mesh-shared';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import {
    MESH_TOOL_ACTIONS,
    rejectUnknownMeshToolArgs,
    validateMeshToolArgs,
} from '../src/tools/validate-tool-args.js';

/**
 * 2026-09-26 tool-surface consolidation (owner decision): 60 published mesh
 * tools → 48, by merging tools that were verbs on one object into one tool
 * selected by a discriminator (`action` / `kind` / `mode`).
 *
 * Two contracts are pinned here:
 *
 *  1. RETIRED NAMES NEVER FAIL SILENTLY. A coordinator running an old prompt
 *     calls e.g. `mesh_graph_gate_claim`. It must get an error that names the
 *     replacement tool AND the discriminator value, so the very next call is
 *     correct — not a bare "Unknown tool", and not a silent alias that keeps the
 *     old spelling alive forever.
 *
 *  2. PER-ACTION ARGUMENTS. The published schema of a merged tool is the UNION of
 *     its actions' arguments, so the generic unknown-key gate would accept an
 *     argument that belongs to a different action and the handler would ignore
 *     it — the silent-drop class validate-tool-args.ts exists to close. Each
 *     action therefore accepts only its own arguments and enforces its own
 *     required set.
 */

const published = new Set(ALL_MESH_TOOLS.map(tool => tool.name));

test('the published surface is 48 tools and contains no retired name', () => {
    assert.equal(ALL_MESH_TOOLS.length, 48);
    assert.equal(CANONICAL_MESH_TOOL_NAMES.length, 48);
    for (const name of Object.keys(RETIRED_MESH_TOOLS)) {
        assert.equal(published.has(name), false, `${name} is retired but still published`);
        assert.equal(resolveMeshToolHandler(name), undefined, `${name} is retired but still silently dispatchable`);
    }
});

test('every retired name maps to a published tool and a discriminator value that tool accepts', () => {
    for (const [oldName, entry] of Object.entries(RETIRED_MESH_TOOLS)) {
        assert.ok(published.has(entry.tool), `${oldName} → ${entry.tool} is not published`);
        const spec = MESH_TOOL_ACTIONS[entry.tool];
        assert.ok(spec, `${entry.tool} has no per-action table`);
        const value = entry.args[spec.key];
        assert.ok(value, `${oldName}: redirect does not set ${entry.tool}'s discriminator "${spec.key}"`);
        assert.ok(Object.prototype.hasOwnProperty.call(spec.actions, value), `${oldName}: ${spec.key}="${value}" is not an action of ${entry.tool}`);
    }
});

test('calling a retired name returns an error naming the new tool + discriminator (both validation gates)', () => {
    for (const [oldName, entry] of Object.entries(RETIRED_MESH_TOOLS)) {
        const [[key, value]] = Object.entries(entry.args);
        for (const gate of [validateMeshToolArgs, rejectUnknownMeshToolArgs]) {
            const error = gate(oldName, { gate_id: 'g' });
            assert.ok(error, `${oldName} returned no error from ${gate.name} — it would fall through to a bare "Unknown tool"`);
            assert.match(error, new RegExp(`was retired`));
            assert.ok(error.includes(`Call ${entry.tool} with ${key}: "${value}"`), `${oldName}: ${error}`);
        }
    }
    // The gate-expiry notice used to name the non-tool mesh_graph_gate_extend.
    assert.match(validateMeshToolArgs('mesh_graph_gate_extend', {}) ?? '', /Call mesh_graph_gate with action: "extend"/);
    // The claim redirect also explains where the old extend-only flag went.
    assert.match(validateMeshToolArgs('mesh_graph_gate_claim', {}) ?? '', /extend_seconds/);
});

test('an unrelated unknown tool name still falls through to the dispatcher (null)', () => {
    assert.equal(validateMeshToolArgs('mesh_not_a_tool', {}), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_not_a_tool', {}), null);
});

// ── per-action argument sets ─────────────────────────────────────────────────

const STRAY_CASES: Array<{ tool: string; args: Record<string, unknown>; stray: string; owner: string }> = [
    { tool: 'mesh_graph_gate', args: { action: 'claim', gate_id: 'g', outcome: 'passed' }, stray: 'outcome', owner: 'action=release' },
    { tool: 'mesh_graph_gate', args: { action: 'release', gate_id: 'g', fencing_token: 'f', lease_generation: 1, idempotency_key: 'k', outcome: 'passed', reason: 'x' }, stray: 'reason', owner: 'action=abandon' },
    { tool: 'mesh_graph_gate', args: { action: 'abandon', gate_id: 'g', reason: 'r', extend_seconds: 5 }, stray: 'extend_seconds', owner: 'action=extend' },
    { tool: 'mesh_node_slots', args: { action: 'list', node_id: 'n', slots: [] }, stray: 'slots', owner: 'action=set' },
    { tool: 'mesh_node_slots', args: { action: 'set', node_id: 'n', slots: [], include_magi: true }, stray: 'include_magi', owner: 'action=propose' },
    { tool: 'mesh_magi_kind_panel', args: { action: 'list', write: true }, stray: 'write', owner: 'action=set' },
    { tool: 'mesh_coordinator_prompt_append', args: { action: 'get', content: 'x' }, stray: 'content', owner: 'action=set' },
    { tool: 'mesh_note', args: { action: 'forget', note_id: 'n', pinned: true }, stray: 'pinned', owner: 'action=record' },
    { tool: 'mesh_note', args: { action: 'record', text: 't', note_id: 'n' }, stray: 'note_id', owner: 'action=forget' },
    { tool: 'mesh_config', args: { kind: 'mesh_json', mode: 'schema' }, stray: 'mode', owner: 'kind=refine | change_impact' },
    { tool: 'mesh_config', args: { kind: 'refine', mode: 'validate', write: true }, stray: 'write', owner: 'kind=mesh_json' },
    { tool: 'mesh_create', args: { mode: 'plan', workspace: '/w', add_current: true }, stray: 'add_current', owner: 'mode=create' },
    { tool: 'mesh_create', args: { name: 'm', operation: 'auto' }, stray: 'operation', owner: 'mode=plan' },
    { tool: 'mesh_cleanup_sessions', args: { mode: 'prune_stale_direct', node_id: 'n' }, stray: 'node_id', owner: 'mode=preserve | stop | delete_stopped | stop_and_delete' },
    { tool: 'mesh_cleanup_sessions', args: { mode: 'stop', node_id: 'n', execute: true }, stray: 'execute', owner: 'mode=prune_stale_direct' },
];

test('an argument that belongs to a different action is refused, naming the action it belongs to', () => {
    for (const { tool, args, stray, owner } of STRAY_CASES) {
        const error = validateMeshToolArgs(tool, args);
        assert.ok(error, `${tool} ${JSON.stringify(args)} was accepted — "${stray}" would be silently ignored`);
        assert.ok(error.includes(`"${stray}" (belongs to ${owner})`), `${tool}: ${error}`);
        // The published-schema-only gate refuses it too (no required check there).
        assert.ok(rejectUnknownMeshToolArgs(tool, args), `${tool}: rejectUnknownMeshToolArgs accepted a stray ${stray}`);
    }
});

test('each action enforces its own required arguments', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ['mesh_graph_gate', { action: 'release', gate_id: 'g' }, /mesh_graph_gate action="release": "fencing_token", "lease_generation", "idempotency_key", "outcome"/],
        ['mesh_graph_gate', { action: 'abandon', gate_id: 'g' }, /mesh_graph_gate action="abandon": "reason"/],
        ['mesh_node_slots', { action: 'set', node_id: 'n' }, /mesh_node_slots action="set": "slots"/],
        ['mesh_magi_kind_panel', { action: 'set', slots: [] }, /mesh_magi_kind_panel action="set": "task_kind"/],
        ['mesh_note', { action: 'record' }, /mesh_note action="record": "text"/],
        ['mesh_config', { kind: 'change_impact' }, /mesh_config kind="change_impact": "mode"/],
        ['mesh_cleanup_sessions', { mode: 'delete_stopped' }, /mesh_cleanup_sessions mode="delete_stopped": "node_id"/],
    ];
    for (const [tool, args, expected] of cases) {
        assert.match(validateMeshToolArgs(tool, args) ?? '', expected, `${tool} ${JSON.stringify(args)}`);
    }
    // A missing discriminator is named by the schema's own required check.
    assert.match(validateMeshToolArgs('mesh_graph_gate', { gate_id: 'g' }) ?? '', /"action"/);
    assert.match(validateMeshToolArgs('mesh_note', { text: 't' }) ?? '', /"action"/);
    // An unknown discriminator value is an enum error, not a per-action one.
    assert.match(validateMeshToolArgs('mesh_graph_gate', { action: 'force_release', gate_id: 'g' }) ?? '', /force_release/);
});

test('well-formed calls for every action pass validation (camelCase aliases included)', () => {
    const ok: Array<[string, Record<string, unknown>]> = [
        ['mesh_graph_gate', { action: 'claim', gateId: 'g', leaseSeconds: 60, extend_deadline_seconds: 10 }],
        ['mesh_graph_gate', { action: 'release', gate_id: 'g', fencingToken: 'f', leaseGeneration: 1, idempotencyKey: 'k', outcome: 'passed', patches: [{ ref: 'deploy', base_spec_patch: {} }] }],
        ['mesh_graph_gate', { action: 'abandon', gate_id: 'g', reason: 'obsolete', force: true }],
        ['mesh_graph_gate', { action: 'extend', gate_id: 'g', extend_seconds: 86400 }],
        ['mesh_node_slots', { action: 'propose', nodeId: 'n', includeMagi: true }],
        ['mesh_node_slots', { action: 'set', node_id: 'n', slots: [{ provider: 'claude-cli' }], write: false, reason: 'r' }],
        ['mesh_magi_kind_panel', { action: 'list' }],
        ['mesh_coordinator_prompt_append', { action: 'set', cli_type: 'claude-cli', content: '' }],
        ['mesh_note', { action: 'forget', text: 'stale' }],
        ['mesh_config', { kind: 'refine', mode: 'schema' }],
        ['mesh_config', { kind: 'mesh_json', node_id: 'n', write: true, overwrite: false, workspace: '/w' }],
        ['mesh_init', {}],
        ['mesh_init', { mode: 'reinit', write: false }],
        ['mesh_create', { name: 'm', add_current: true }],
        ['mesh_create', { mode: 'plan', workspace: '/w', operation: 'clone_worktree', branch: 'b' }],
        ['mesh_cleanup_sessions', { mode: 'prune_stale_direct', execute: true, include_terminal: true }],
        ['mesh_cleanup_sessions', { mode: 'stop_and_delete', node_id: 'n', session_ids: ['s'], dry_run: true }],
    ];
    for (const [tool, args] of ok) {
        assert.equal(validateMeshToolArgs(tool, args), null, `${tool} ${JSON.stringify(args)}`);
    }
});
