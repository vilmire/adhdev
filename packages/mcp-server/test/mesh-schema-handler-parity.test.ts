import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { MESH_NOTIFY_WORKER_TOOL, MESH_CONFIG_TOOL, MESH_NODE_SLOTS_TOOL } from '../src/tools/mesh-tool-schemas-refine-config.js';
import { MESH_MISSION_LIST_TOOL, MESH_MISSION_UPSERT_TOOL, MESH_NOTE_TOOL } from '../src/tools/mesh-tool-schemas-admin.js';
import { MESH_ENQUEUE_BATCH_TOOL, MESH_ENQUEUE_TASK_TOOL, MESH_QUEUE_CANCEL_TOOL, MESH_QUEUE_REQUEUE_TOOL } from '../src/tools/mesh-tool-schemas-queue.js';
import { MESH_TOOL_ACTIONS, rejectUnknownMeshToolArgs, validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

/**
 * D2 audit — schema↔handler parity for the unknown-arg gate.
 *
 * validate-tool-args.ts rejects any argument key absent from inputSchema.properties
 * BEFORE dispatch. That makes the schema, not the handler signature, the real contract:
 * a key a handler reads but the schema does not declare is unreachable dead code, and
 * the caller gets a confusing "Unknown parameter" instead of the behavior the handler
 * documents. One such divergence was found and fixed:
 *
 *   D2#1 mesh_write_mesh_json_config (now mesh_config kind=mesh_json) — the handler routes on args.node_id
 *        (resolveRefineConfigNode(ctx, args.node_id)) but the schema declared only
 *        write/overwrite/workspace, so every {node_id} call was rejected and the
 *        repo-committed write could only target the coordinator's default node. Its
 *        read-only sibling mesh_refine_config declared node_id all along — the
 *        asymmetry is what made the omission easy to miss. Fixed by declaring node_id.
 */

const here = dirname(fileURLToPath(import.meta.url));
const refineHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-refine.ts'), 'utf8');

test('D2#1: mesh_config kind=mesh_json accepts node_id through the unknown-arg gate', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_config', { kind: 'mesh_json', node_id: 'node_abc' }), null);
    // The full realistic call shape the handler supports.
    assert.equal(
        rejectUnknownMeshToolArgs('mesh_config', {
            kind: 'mesh_json',
            node_id: 'node_abc',
            write: true,
            overwrite: false,
            workspace: '/ws/repo',
        }),
        null,
    );
});

test('D2#1: node_id is declared in the schema and accepted by kind=mesh_json', () => {
    const props = MESH_CONFIG_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.ok(MESH_TOOL_ACTIONS.mesh_config.actions.mesh_json.args.includes('node_id'));
    assert.ok('node_id' in props, 'schema must declare node_id — the handler routes on it');
    // The handler really does route on it; this pins the reason the schema key exists,
    // so deleting the routing without deleting the key fails here too.
    assert.match(refineHandlerSrc, /resolveRefineConfigNode\(ctx, args\.node_id\)/);
});

test('D2#1: an undeclared key is still rejected (the gate was not widened wholesale)', () => {
    const error = rejectUnknownMeshToolArgs('mesh_config', { kind: 'mesh_json', nod_id: 'node_abc' });
    assert.ok(error, 'a typo must still be rejected');
    assert.match(error, /did you mean "node_id"\?/);
});

/**
 * D2#4 (this fix) — a follow-up sweep of the SAME class of bug found by D2#1/#2, this
 * time for genuine camelCase↔snake_case ALIAS pairs (task_kind/taskKind, mission_id/
 * missionId, etc — same word, not a different word). Each handler
 * below already reads BOTH spellings (readString(args.x) || readString(args.xCamel), or
 * args.x ?? args.xCamel), but the schema declared only the snake_case half, so the
 * camelCase half was unreachable dead code exactly like D2#1's node_id. Fixed by
 * declaring the missing camelCase alias, following the repo's established "CamelCase
 * alias for x_y" convention (never by deleting the handler's read, since these ARE the
 * same-word alias pairs the convention covers).
 */
const missionHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-mission.ts'), 'utf8');
// View / cancel / requeue moved out of mesh-tools-queue.ts into mesh-tools-queue-manage.ts;
// the queue-handler pins read both.
const queueHandlerSrc = ['mesh-tools-queue.ts', 'mesh-tools-queue-manage.ts']
    .map((file) => readFileSync(join(here, '../src/tools', file), 'utf8'))
    .join('\n');
const slotsHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-slots.ts'), 'utf8');
const slotAutodetectHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-slot-autodetect.ts'), 'utf8');

// 2026-09-27 tools/list schema diet: every camelCase alias in this file used to be
// its own published schema property (D2#4, below). They are now accepted via
// MESH_ACCEPTED_ARG_ALIASES (canonicalized to the snake_case key before the
// unknown-arg gate runs) instead of published — same pattern the enqueue family
// already used (rc.37#1: "aliases are accepted, not published"). The acceptance
// behavior these tests were written to pin (rejectUnknownMeshToolArgs returns
// null for the alias spelling) is unchanged; only the "and it's a published
// property" half of each assertion flips to "and it's NOT a published property".

test('D2#4: mesh_mission_upsert accepts missionId and missionIds (unpublished)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_mission_upsert', { missionId: 'm_x', title: 't' }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_mission_upsert', { missionIds: ['a', 'b'], status: 'completed' }), null);
    const props = MESH_MISSION_UPSERT_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.equal('missionId' in props, false);
    assert.equal('missionIds' in props, false);
    assert.match(missionHandlerSrc, /args\.mission_ids\s*\?\?\s*args\.missionIds/);
    assert.match(missionHandlerSrc, /readString\(args\.mission_id\)\s*\|\|\s*readString\(args\.missionId\)/);
});

test('D2#4: mesh_mission_list accepts includeStats (unpublished)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_mission_list', { includeStats: true }), null);
    const props = MESH_MISSION_LIST_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.equal('includeStats' in props, false);
    assert.match(missionHandlerSrc, /args\.include_stats\s*\?\?\s*args\.includeStats/);
});

test('D2#4: mesh_note action=forget accepts noteId (unpublished)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_note', { action: 'forget', noteId: 'n_x' }), null);
    assert.equal('noteId' in (MESH_NOTE_TOOL.inputSchema.properties as object), false);
    assert.match(missionHandlerSrc, /readString\(args\.note_id\)\s*\|\|\s*readString\(args\.noteId\)/);
});

test('D2#4: mesh_queue_cancel accepts taskId (unpublished)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_queue_cancel', { taskId: 't_x' }), null);
    assert.equal('taskId' in (MESH_QUEUE_CANCEL_TOOL.inputSchema.properties as object), false);
    assert.match(queueHandlerSrc, /args\.task_id\s*\|\|\s*args\.taskId/);
});

test('D2#4: mesh_queue_requeue accepts every camelCase alias its handler reads (unpublished)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_queue_requeue', {
        taskId: 't_x',
        targetNodeId: 'n_x',
        targetSessionId: 's_x',
        clearTargetNode: true,
        keepTargetSession: true,
    }), null);
    const props = MESH_QUEUE_REQUEUE_TOOL.inputSchema.properties as Record<string, unknown>;
    for (const key of ['taskId', 'targetNodeId', 'targetSessionId', 'clearTargetNode', 'keepTargetSession']) {
        assert.equal(key in props, false, `mesh_queue_requeue schema must not publish ${key}`);
    }
    assert.match(queueHandlerSrc, /args\.target_node_id\s*\|\|\s*args\.targetNodeId/);
});

test('D2#4: mesh_node_slots set / list / propose accept nodeId, unpublished', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_node_slots', { action: 'set', nodeId: 'n_x', slots: [{ provider: 'claude-cli' }] }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_node_slots', { action: 'list', nodeId: 'n_x' }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_node_slots', { action: 'propose', nodeId: 'n_x' }), null);
    const proposeProps = MESH_NODE_SLOTS_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.equal('nodeId' in proposeProps, false);
    assert.match(slotsHandlerSrc, /String\(args\.node_id\s*\|\|\s*args\.nodeId\s*\|\|\s*''\)/);
    assert.match(slotAutodetectHandlerSrc, /String\(args\.node_id\s*\|\|\s*args\.nodeId\s*\|\|\s*''\)/);
});

test('D2#4: an undeclared key is still rejected on the fixed tools (the gate was not widened wholesale)', () => {
    const error = rejectUnknownMeshToolArgs('mesh_queue_cancel', { taskld: 't_x' });
    assert.ok(error, 'a typo must still be rejected');
    assert.match(error, /Unknown parameter/);
});

// ─── A3: required-argument table ↔ handler signatures ───────────────────────
//
// The schema's `required` list is the required-arg table (enforced at dispatch by
// validateMeshToolArgs). Each handler declares in its own `args: { … }` parameter
// type whether it needs node_id / session_id / task_id (`node_id: string`) or
// tolerates its absence (`node_id?: string`). A handler that requires the key
// while the schema does not is the "node_id validation gap": a call omitting it
// reaches the handler and fails deep inside node resolution instead of at the
// boundary. The reverse (schema requires, handler optional) over-constrains a
// supported call shape — mesh_send_task's sessionless dispatch was exactly that.
// Both directions are asserted, so the signature and the table cannot drift.

const ID_KEYS = ['node_id', 'session_id', 'task_id'] as const;

const toolsDir = join(here, '../src/tools');
const dispatchSrc = readFileSync(join(toolsDir, 'mesh-tool-dispatch.ts'), 'utf8');

function handlerRegistry(): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of dispatchSrc.matchAll(/^\s*(mesh_[a-z_]+): \([^)]*\) => (mesh[A-Za-z]+)\(/gm)) map.set(m[1], m[2]);
    return map;
}

/** `args` parameter type text of every exported mesh* handler, keyed by function name. */
function handlerArgTypes(): Map<string, string | null> {
    const types = new Map<string, string | null>();
    for (const file of readdirSync(toolsDir).filter(f => f.startsWith('mesh-tools') && f.endsWith('.ts'))) {
        const src = readFileSync(join(toolsDir, file), 'utf8');
        for (const m of src.matchAll(/^export (?:async )?function (mesh[A-Za-z]+)\(/gm)) {
            const open = src.indexOf('(', (m.index ?? 0) + m[0].length - 1);
            // Parameter list: balanced parentheses from the opening one.
            let depth = 0; let i = open;
            for (; i < src.length; i++) {
                if (src[i] === '(') depth += 1;
                else if (src[i] === ')') { depth -= 1; if (depth === 0) break; }
            }
            const params = src.slice(open + 1, i);
            const argsAt = params.search(/\bargs\??:\s*\{/);
            if (argsAt < 0) { types.set(m[1], null); continue; }
            const braceOpen = params.indexOf('{', argsAt);
            let bd = 0; let j = braceOpen;
            for (; j < params.length; j++) {
                if (params[j] === '{') bd += 1;
                else if (params[j] === '}') { bd -= 1; if (bd === 0) break; }
            }
            types.set(m[1], params.slice(braceOpen + 1, j));
        }
    }
    return types;
}

type Need = 'required' | 'optional' | 'alias-pair' | 'unused';
function camelAlias(key: string): string {
    return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}
/**
 * What the handler's `args` type says about `key`. An `alias-pair` handler
 * declares both spellings optional (`task_id?` and `taskId?`) because EITHER
 * satisfies it (`args.task_id ?? args.taskId`); the schema may then require the
 * snake_case key, since the dispatch gate accepts the declared alias in its place.
 */
function handlerNeed(argType: string, key: string): Need {
    const declared = (name: string, optional: boolean) => new RegExp(`(^|[\\s;{])${name}${optional ? '\\?' : ''}:`).test(argType);
    if (declared(key, true)) return declared(camelAlias(key), true) ? 'alias-pair' : 'optional';
    if (declared(key, false)) return 'required';
    return 'unused';
}

/**
 * 2026-09-26 tool consolidation: a merged tool dispatches each action to the
 * per-verb handler that existed before the merge, so the A3 audit above sees
 * only the dispatcher (typed `Args`, invisible to it). This table names the
 * per-verb handler of every action; the test checks (a) the dispatcher source
 * really routes that action to that handler, and (b) each handler's
 * node_id / session_id / task_id need agrees with the action's required set in
 * MESH_TOOL_ACTIONS — the same two directions A3 checks for a plain tool.
 */
const MERGED_ACTION_HANDLERS: Record<string, Record<string, string>> = {
    mesh_node_slots: { list: 'meshNodeSlotsList', propose: 'meshNodeSlotsPropose', set: 'meshNodeSlotsSet' },
    mesh_coordinator_prompt_append: { get: 'meshCoordinatorPromptAppendGet', set: 'meshCoordinatorPromptAppendSet' },
    mesh_note: { record: 'meshRecordNote', forget: 'meshForgetNote' },
    mesh_config: { refine: 'meshRefineConfig', change_impact: 'meshChangeImpactConfig', mesh_json: 'meshWriteMeshJsonConfig' },
    mesh_init: { init: 'meshInit', reinit: 'meshReinit' },
    mesh_create: { create: 'meshCreate', plan: 'meshPlanOnboarding' },
};

test('A3: the required-arg table agrees with every handler signature on node_id / session_id / task_id', () => {
    const registry = handlerRegistry();
    const argTypes = handlerArgTypes();
    assert.ok(registry.size >= 48, `registry parse failed (${registry.size} entries)`);
    const schemaByName = new Map<string, any>([...ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL].map(t => [t.name, t]));
    const audited: string[] = [];
    const untyped: string[] = [];
    const failures: string[] = [];
    for (const [tool, handler] of registry) {
        const schema = schemaByName.get(tool);
        if (!schema) continue; // hidden 1-release aliases forward to a published schema
        // Merged tools are audited per action by the 'A3 (merged tools)' test below.
        if (tool in MERGED_ACTION_HANDLERS || tool === 'mesh_cleanup_sessions') continue;
        assert.ok(argTypes.has(handler), `handler source for ${tool} (${handler}) not found`);
        const argType = argTypes.get(handler);
        if (argType === null || argType === undefined) { untyped.push(tool); continue; }
        const required: string[] = schema.inputSchema?.required ?? [];
        for (const key of ID_KEYS) {
            const need = handlerNeed(argType, key);
            if (need === 'unused') continue;
            audited.push(`${tool}.${key}:${need}`);
            if (need === 'required' && !required.includes(key)) {
                failures.push(`${tool}: handler ${handler} declares ${key}: string (required) but the schema does not require it`);
            }
            if (need === 'optional' && required.includes(key)) {
                failures.push(`${tool}: schema requires ${key} but handler ${handler} declares ${key}?: string (a call without it is supported)`);
            }
        }
    }
    assert.deepEqual(failures, []);
    // Coverage floor: the audit must keep seeing the session/node tool family. A handler
    // typed `args: any` is invisible to it — keep that set from silently growing.
    // (27 since the 2026-09-26 consolidation moved the slot / config / init tools to
    // the per-action audit in 'A3 (merged tools)' below, which carries its own floor.)
    assert.ok(audited.length >= 25, `expected at least 25 audited (tool, key) pairs, saw ${audited.length}: ${audited.join(', ')}`);
    assert.ok(untyped.length <= 3, `handlers without an inline args type (invisible to the audit): ${untyped.join(', ')}`);
});

test('A3 (merged tools): every action routes to its per-verb handler and the per-action required set matches its signature', () => {
    const mergedSrc = readFileSync(join(toolsDir, 'mesh-tools-merged.ts'), 'utf8');
    const argTypes = handlerArgTypes();
    const failures: string[] = [];
    const mergedAudited: string[] = [];
    for (const [tool, actions] of Object.entries(MERGED_ACTION_HANDLERS)) {
        const spec = MESH_TOOL_ACTIONS[tool];
        assert.ok(spec, `${tool} has no MESH_TOOL_ACTIONS entry`);
        assert.deepEqual(Object.keys(actions).sort(), Object.keys(spec.actions).sort(), `${tool}: action table drifted from MESH_TOOL_ACTIONS`);
        const schemaEnum = (ALL_MESH_TOOLS.find(t => t.name === tool)!.inputSchema as any).properties[spec.key].enum as string[];
        assert.deepEqual([...schemaEnum].sort(), Object.keys(spec.actions).sort(), `${tool}: schema ${spec.key} enum drifted from MESH_TOOL_ACTIONS`);
        for (const [action, handler] of Object.entries(actions)) {
            assert.match(mergedSrc, new RegExp(`case '${action}':[^]{0,1200}?\\b${handler}\\(`), `${tool} ${spec.key}=${action} must dispatch to ${handler}`);
            const argType = argTypes.get(handler);
            assert.ok(argType !== undefined, `handler source for ${tool}/${action} (${handler}) not found`);
            if (argType === null) continue;
            const required = spec.actions[action].required ?? [];
            for (const key of ID_KEYS) {
                const need = handlerNeed(argType, key);
                if (need !== 'unused') mergedAudited.push(`${tool}.${action}.${key}:${need}`);
                if (need === 'required' && !required.includes(key)) failures.push(`${tool} ${action}: ${handler} requires ${key} but the action does not`);
                if (need === 'optional' && required.includes(key)) failures.push(`${tool} ${action}: action requires ${key} but ${handler} treats it as optional`);
            }
        }
    }
    // mesh_cleanup_sessions is mode-dispatched with an if, not a switch: the four
    // session modes go to meshCleanupSessions (node_id required), prune to its own core.
    assert.match(mergedSrc, /mode === 'prune_stale_direct'\) return meshPruneStaleDirect\(/);
    assert.equal(handlerNeed(argTypes.get('meshCleanupSessions') ?? '', 'node_id'), 'required');
    assert.deepEqual(MESH_TOOL_ACTIONS.mesh_cleanup_sessions.actions.stop.required, ['node_id']);
    assert.deepEqual(MESH_TOOL_ACTIONS.mesh_cleanup_sessions.actions.prune_stale_direct.required ?? [], []);
    assert.deepEqual(failures, []);
    // Coverage floor: node_slots ×3 + config ×3 + init ×2 handlers carry node_id.
    assert.ok(mergedAudited.length >= 8, `expected at least 8 audited merged (tool, action, key) triples, saw ${mergedAudited.length}: ${mergedAudited.join(', ')}`);
});

test('A3: mesh_notify_worker (flag-gated, not in ALL_MESH_TOOLS) declares node_id and task_id required', () => {
    assert.deepEqual(MESH_NOTIFY_WORKER_TOOL.inputSchema.required, ['node_id', 'task_id', 'message']);
});

/**
 * ── rc.37 owned_paths audit — enqueue-family schema↔handler↔gate parity ──────
 *
 * Preview rc.37 found `mesh_enqueue_task` advertised `owned_paths` in its schema
 * but the handler dropped it before the fix on the tree. A parity audit of the
 * rest of the enqueue family found the same axis recurring three more times:
 *
 *   1. `mesh_enqueue_batch` per-task `owned_paths`/`ownedPaths` was normalized by
 *      the shared `normalizeEnqueueTaskArgs` but never copied onto the `specs.push`
 *      object, so a batch entry's declaration never reached the daemon.
 *   2. `mesh_enqueue_task` top-level `not_before` was REJECTED by the pre-dispatch
 *      unknown-key gate — the schema declared only `notBefore`, so the snake_case
 *      form the tool's own description and `max_retries`' wording tell callers to
 *      use was unreachable. Same for `thinking_level` (schema had only
 *      `thinkingLevel`).
 *   3. `notBefore`/`not_before` were declared `type:'number'` though the
 *      description and `resolveNotBefore` accept an ISO string too.
 *   4. The unknown-key gate only checked TOP-LEVEL keys, so a typo'd key inside a
 *      batch `tasks[]` item was silently dropped —
 *      exactly how the owned_paths class recurred *inside* batch in the first
 *      place. Extended to validate nested array-of-object items.
 */

test('rc.37#2: mesh_enqueue_task accepts not_before and thinking_level snake_case (previously unreachable)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_enqueue_task', {
        message: 'm', difficulty: 'medium', not_before: 60_000, thinking_level: 'high',
    }), null);
    assert.equal(validateMeshToolArgs('mesh_enqueue_task', {
        message: 'm', difficulty: 'medium', not_before: 60_000, thinking_level: 'high',
    }), null);
    const props = MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.ok('not_before' in props, 'schema must declare not_before (handler reads args.not_before)');
    assert.ok('thinking_level' in props, 'schema must declare thinking_level (handler reads args.thinking_level)');
    assert.match(queueHandlerSrc, /args\.notBefore\s*!==\s*undefined\s*\?\s*args\.notBefore\s*:\s*args\.not_before/);
    assert.match(queueHandlerSrc, /readString\(args\.thinkingLevel\)\s*\|\|\s*readString\(args\.difficulty\)|thinkingLevel/);
});

test('rc.37#3: not_before accepts a string (ISO timestamp), not just number (notBefore: accepted alias since D2)', () => {
    const taskProps = MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as Record<string, any>;
    for (const key of ['not_before']) {
        const typeDecl = taskProps[key]?.type;
        assert.ok(Array.isArray(typeDecl) ? typeDecl.includes('string') && typeDecl.includes('number') : typeDecl === 'string',
            `mesh_enqueue_task.${key} must accept string (ISO) in addition to number, got ${JSON.stringify(typeDecl)}`);
    }
    const taskItemProps = (MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties as any).tasks.items.properties as Record<string, any>;
    for (const key of ['not_before']) {
        const typeDecl = taskItemProps[key]?.type;
        assert.ok(Array.isArray(typeDecl) && typeDecl.includes('string') && typeDecl.includes('number'),
            `mesh_enqueue_batch tasks[].${key} must accept string (ISO) in addition to number, got ${JSON.stringify(typeDecl)}`);
    }
    // A real ISO string must clear the gate (previously type:'number' would not have
    // rejected it here since the gate does not type-check values — but pin the
    // declared type itself above so a future value-level validator stays correct).
    assert.equal(rejectUnknownMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', not_before: new Date().toISOString() }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_enqueue_task', { message: 'm', difficulty: 'medium', notBefore: new Date().toISOString() }), null);
});

test('rc.37#1: mesh_enqueue_batch schema declares owned_paths on tasks[] and still accepts ownedPaths (handler copies it to specs)', () => {
    const taskItemProps = (MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties as any).tasks.items.properties as Record<string, unknown>;
    assert.ok('owned_paths' in taskItemProps);
    assert.equal('ownedPaths' in taskItemProps, false, 'D2: aliases are accepted, not published');
    assert.equal(rejectUnknownMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', owned_paths: ['src/foo.ts'] }] }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', ownedPaths: ['src/foo.ts'] }] }), null);
    // The BREAK-ONCE proof that the handler really copies v.ownedPaths onto the
    // pushed spec (not just that the schema accepts the key) lives in
    // mesh-enqueue-owned-paths-batch.test.ts, which reads the persisted queue row
    // back out of the real daemon-core store.
    assert.match(queueHandlerSrc, /\.\.\.\(v\.ownedPaths \? \{ ownedPaths: v\.ownedPaths \} : \{\}\)/);
});

test('rc.37#4: nested-array-item gate rejects a typo inside tasks[] with a did-you-mean hint', () => {
    const badTask = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ target_node: 'x', bogus: 1, difficulty: 'medium', message: 'm' }] });
    assert.ok(badTask, 'an unknown key inside tasks[] must be rejected');
    assert.match(badTask!, /Unknown parameter\(s\) for mesh_enqueue_batch tasks\[0\]/);
    assert.match(badTask!, /"bogus"/);

    const goodTask = validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ target_node: 'x', difficulty: 'medium', message: 'm' }] });
    assert.equal(goodTask, null, 'target_node (documented alias) must be accepted inside tasks[]');
});

test('rc.37#4: target_node / targetNode (read aliases of target_node_id) stay accepted on tasks[] by the nested gate', () => {
    // D2: accepted via MESH_ACCEPTED_ARG_ALIASES instead of being published.
    for (const key of ['target_node', 'targetNode', 'targetNodeId']) {
        assert.equal(validateMeshToolArgs('mesh_enqueue_batch', { tasks: [{ message: 'm', difficulty: 'medium', [key]: 'node_x' }] }), null, key);
    }
    assert.match(queueHandlerSrc, /readString\(args\.targetNode\)\s*\|\|\s*readString\(args\.target_node\)/);
});

test('rc.37: every mesh_enqueue_task schema property is read by the handler (no dead schema keys)', () => {
    const props = Object.keys(MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as Record<string, unknown>);
    const missing: string[] = [];
    for (const key of props) {
        const re = new RegExp(`args\\.${key}\\b`);
        if (!re.test(queueHandlerSrc)) missing.push(key);
    }
    assert.deepEqual(missing, [], `mesh_enqueue_task schema properties never read by the handler: ${missing.join(', ')}`);
});

test('rc.37: every mesh_enqueue_batch tasks[] schema property is read by the handler (no dead schema keys)', () => {
    const itemProps = Object.keys((MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties as any).tasks.items.properties as Record<string, unknown>);
    const missing: string[] = [];
    for (const key of itemProps) {
        if (key === 'ref') continue; // read via a destructure (`entry.ref`), not args.ref — see normalizeEnqueueTaskArgs callers.
        const reQueue = new RegExp(`\\b(entry|args)\\.${key}\\b`);
        if (!reQueue.test(queueHandlerSrc)) missing.push(key);
    }
    assert.deepEqual(missing, [], `mesh_enqueue_batch tasks[] schema properties never read by the handler: ${missing.join(', ')}`);
});

/**
 * Parity audit item 8 — extend the nested-object schema↔handler completeness
 * sweep (the `tasks[]` test just above) to the other nested-object schema shape
 * in the mesh tool surface: `mesh_mission_upsert`'s `brief` (a single nested
 * object, not an array). It is read through a local `raw` destructure rather
 * than `args.<key>` directly, so the regex looks for the destructured read,
 * mirroring how the tasks[] test above looks for `entry.<key>`.
 */
test('mesh_mission_upsert: every brief schema property is read by the handler (no dead schema keys)', () => {
    const briefProps = Object.keys((MESH_MISSION_UPSERT_TOOL.inputSchema.properties as any).brief.properties as Record<string, unknown>);
    const missing: string[] = [];
    for (const key of briefProps) {
        // coerceBriefArg reads camelCase directly off `raw.<key>` and snake_case
        // fields as a second positional arg to readAliasArray (`raw.done_criteria`
        // etc, not `raw.doneCriteria` again) — either form of `raw.<key>` covers it.
        const re = new RegExp(`\\braw\\.${key}\\b`);
        if (!re.test(missionHandlerSrc)) missing.push(key);
    }
    assert.deepEqual(missing, [], `mesh_mission_upsert brief schema properties never read by the handler: ${missing.join(', ')}`);
});
