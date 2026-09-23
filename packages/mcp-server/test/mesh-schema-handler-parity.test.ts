import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    ALL_MESH_TOOLS,
    MESH_NOTIFY_WORKER_TOOL,
    MESH_FORGET_NOTE_TOOL,
    MESH_MAGI_COLLECT_TOOL,
    MESH_MAGI_KIND_PANEL_LIST_TOOL,
    MESH_MAGI_KIND_PANEL_SET_TOOL,
    MESH_MAGI_REVIEW_TOOL,
    MESH_MISSION_LIST_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_NODE_SLOTS_LIST_TOOL,
    MESH_NODE_SLOTS_PROPOSE_TOOL,
    MESH_NODE_SLOTS_SET_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_WRITE_MESH_JSON_CONFIG_TOOL,
} from '../src/tools/mesh-tool-schemas.js';
import { rejectUnknownMeshToolArgs } from '../src/tools/validate-tool-args.js';

/**
 * D2 audit — schema↔handler parity for the unknown-arg gate.
 *
 * validate-tool-args.ts rejects any argument key absent from inputSchema.properties
 * BEFORE dispatch. That makes the schema, not the handler signature, the real contract:
 * a key a handler reads but the schema does not declare is unreachable dead code, and
 * the caller gets a confusing "Unknown parameter" instead of the behavior the handler
 * documents. Two such divergences were found and fixed:
 *
 *   D2#1 mesh_write_mesh_json_config — the handler routes on args.node_id
 *        (resolveRefineConfigNode(ctx, args.node_id)) but the schema declared only
 *        write/overwrite/workspace, so every {node_id} call was rejected and the
 *        repo-committed write could only target the coordinator's default node. Its
 *        read-only sibling mesh_refine_config declared node_id all along — the
 *        asymmetry is what made the omission easy to miss. Fixed by declaring node_id.
 *
 *   D2#2 mesh_magi_kind_panel_set / _list — the handlers read
 *        `readString(args.task_kind) || readString(args.kind)`, but the schemas declare
 *        only task_kind, so the `kind` half could never execute. Fixed by DELETING the
 *        dead fallback rather than declaring `kind`: the repo's alias convention is
 *        camelCase↔snake_case pairs of the SAME word (task_mode/taskMode, gate_id/gateId,
 *        mission_id/missionId), and `kind` is a different, shorter word — declaring it
 *        would mint a second name for the panel key, and collide with the unrelated
 *        `kind` field these very handlers return in their scope descriptor.
 */

const here = dirname(fileURLToPath(import.meta.url));
const magiHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-magi.ts'), 'utf8');
const refineHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-refine.ts'), 'utf8');

test('D2#1: mesh_write_mesh_json_config accepts node_id through the unknown-arg gate', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_write_mesh_json_config', { node_id: 'node_abc' }), null);
    // The full realistic call shape the handler supports.
    assert.equal(
        rejectUnknownMeshToolArgs('mesh_write_mesh_json_config', {
            node_id: 'node_abc',
            write: true,
            overwrite: false,
            workspace: '/ws/repo',
        }),
        null,
    );
});

test('D2#1: node_id is declared in the schema, matching the sibling mesh_refine_config', () => {
    const props = MESH_WRITE_MESH_JSON_CONFIG_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.ok('node_id' in props, 'schema must declare node_id — the handler routes on it');
    // The handler really does route on it; this pins the reason the schema key exists,
    // so deleting the routing without deleting the key fails here too.
    assert.match(refineHandlerSrc, /resolveRefineConfigNode\(ctx, args\.node_id\)/);
});

test('D2#1: an undeclared key is still rejected (the gate was not widened wholesale)', () => {
    const error = rejectUnknownMeshToolArgs('mesh_write_mesh_json_config', { nod_id: 'node_abc' });
    assert.ok(error, 'a typo must still be rejected');
    assert.match(error, /did you mean "node_id"\?/);
});

test('D2#2: the dead `kind` fallback is gone from both kind-panel handlers', () => {
    // The gate rejects `kind`, so a handler reading it is unreachable. Assert the
    // source no longer pretends to accept it. Comments are stripped first — the
    // fix's own explanatory comments quote the removed expression, and matching
    // those would make this assertion trivially unfalsifiable.
    const code = magiHandlerSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
    assert.doesNotMatch(code, /readString\(args\.kind\)/);
    assert.doesNotMatch(code, /args\.task_kind\s*\?\?\s*args\.kind\b/);
    // Guard the strip itself: the declared key must still be read, so a regex that
    // accidentally blanked the file cannot pass this test vacuously.
    assert.match(code, /readString\(args\.task_kind\)/);
});

test('D2#2: `kind` stays rejected on both kind-panel tools', () => {
    for (const name of ['mesh_magi_kind_panel_set', 'mesh_magi_kind_panel_list']) {
        const error = rejectUnknownMeshToolArgs(name, { kind: 'rca' });
        assert.ok(error, `${name} must reject the undeclared alias`);
        assert.match(error, /Unknown parameter\(s\) for /);
        assert.match(error, /"kind"/);
        // No "did you mean" here by design: kind→task_kind is edit distance 5, past
        // MAX_SUGGESTION_DISTANCE (2). The allowed-parameter list is what points the
        // caller at the right key.
        assert.match(error, /Allowed parameters: .*task_kind/);
    }
});

test('D2#2: task_kind — the declared key — passes on both kind-panel tools', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_magi_kind_panel_set', { task_kind: 'rca', slots: [], write: false }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_magi_kind_panel_list', { task_kind: 'rca' }), null);
    assert.ok('task_kind' in (MESH_MAGI_KIND_PANEL_SET_TOOL.inputSchema.properties as object));
    assert.ok('task_kind' in (MESH_MAGI_KIND_PANEL_LIST_TOOL.inputSchema.properties as object));
});

/**
 * D2#4 (this fix) — a follow-up sweep of the SAME class of bug found by D2#1/#2, this
 * time for genuine camelCase↔snake_case ALIAS pairs (task_kind/taskKind, mission_id/
 * missionId, etc — same word, not a different one like D2#2's `kind`). Each handler
 * below already reads BOTH spellings (readString(args.x) || readString(args.xCamel), or
 * args.x ?? args.xCamel), but the schema declared only the snake_case half, so the
 * camelCase half was unreachable dead code exactly like D2#1's node_id. Fixed by
 * declaring the missing camelCase alias, following the repo's established "CamelCase
 * alias for x_y" convention (never by deleting the handler's read, since these ARE the
 * same-word alias pairs D2#2 said the convention covers).
 */
const magiFullSrc = readFileSync(join(here, '../src/tools/mesh-tools-magi.ts'), 'utf8');
const missionHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-mission.ts'), 'utf8');
const queueHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-queue.ts'), 'utf8');
const slotsHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-slots.ts'), 'utf8');
const slotAutodetectHandlerSrc = readFileSync(join(here, '../src/tools/mesh-tools-slot-autodetect.ts'), 'utf8');

test('D2#4: mesh_magi_review accepts every camelCase alias its handler reads', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_magi_review', {
        question: 'q',
        taskKind: 'rca',
        includeStale: true,
        requireIndependentEvidence: false,
        waitTimeoutMs: 60000,
        autoCleanup: false,
    }), null);
    const props = MESH_MAGI_REVIEW_TOOL.inputSchema.properties as Record<string, unknown>;
    for (const key of ['taskKind', 'includeStale', 'requireIndependentEvidence', 'waitTimeoutMs', 'autoCleanup']) {
        assert.ok(key in props, `mesh_magi_review schema must declare ${key}`);
    }
    assert.match(magiFullSrc, /args\.task_kind\s*\?\?\s*args\.taskKind/);
    assert.match(magiFullSrc, /args\.include_stale\s*\?\?\s*args\.includeStale/);
});

test('D2#4: mesh_magi_collect accepts every camelCase alias its handler reads', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_magi_collect', {
        consensusGroupId: 'magi_x',
        taskKind: 'rca',
        requireIndependentEvidence: false,
        waitTimeoutMs: 60000,
        autoCleanup: false,
        verbose: true,
    }), null);
    const props = MESH_MAGI_COLLECT_TOOL.inputSchema.properties as Record<string, unknown>;
    for (const key of ['consensusGroupId', 'taskKind', 'requireIndependentEvidence', 'waitTimeoutMs', 'autoCleanup']) {
        assert.ok(key in props, `mesh_magi_collect schema must declare ${key}`);
    }
    assert.match(magiFullSrc, /readString\(args\.consensus_group_id\)\s*\|\|\s*readString\(args\.consensusGroupId\)/);
});

test('D2#4: mesh_mission_upsert accepts missionId and missionIds', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_mission_upsert', { missionId: 'm_x', title: 't' }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_mission_upsert', { missionIds: ['a', 'b'], status: 'completed' }), null);
    const props = MESH_MISSION_UPSERT_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.ok('missionId' in props);
    assert.ok('missionIds' in props);
    assert.match(missionHandlerSrc, /args\.mission_ids\s*\?\?\s*args\.missionIds/);
    assert.match(missionHandlerSrc, /readString\(args\.mission_id\)\s*\|\|\s*readString\(args\.missionId\)/);
});

test('D2#4: mesh_mission_list accepts includeMagi and includeStats', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_mission_list', { includeMagi: true, includeStats: true }), null);
    const props = MESH_MISSION_LIST_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.ok('includeMagi' in props);
    assert.ok('includeStats' in props);
    assert.match(missionHandlerSrc, /args\.include_magi\s*\?\?\s*args\.includeMagi/);
    assert.match(missionHandlerSrc, /args\.include_stats\s*\?\?\s*args\.includeStats/);
});

test('D2#4: mesh_forget_note accepts noteId', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_forget_note', { noteId: 'n_x' }), null);
    assert.ok('noteId' in (MESH_FORGET_NOTE_TOOL.inputSchema.properties as object));
    assert.match(missionHandlerSrc, /readString\(args\.note_id\)\s*\|\|\s*readString\(args\.noteId\)/);
});

test('D2#4: mesh_queue_cancel accepts taskId', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_queue_cancel', { taskId: 't_x' }), null);
    assert.ok('taskId' in (MESH_QUEUE_CANCEL_TOOL.inputSchema.properties as object));
    assert.match(queueHandlerSrc, /args\.task_id\s*\|\|\s*args\.taskId/);
});

test('D2#4: mesh_queue_requeue accepts every camelCase alias its handler reads', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_queue_requeue', {
        taskId: 't_x',
        targetNodeId: 'n_x',
        targetSessionId: 's_x',
        clearTargetNode: true,
        keepTargetSession: true,
    }), null);
    const props = MESH_QUEUE_REQUEUE_TOOL.inputSchema.properties as Record<string, unknown>;
    for (const key of ['taskId', 'targetNodeId', 'targetSessionId', 'clearTargetNode', 'keepTargetSession']) {
        assert.ok(key in props, `mesh_queue_requeue schema must declare ${key}`);
    }
    assert.match(queueHandlerSrc, /args\.target_node_id\s*\|\|\s*args\.targetNodeId/);
});

test('D2#4: mesh_node_slots_set / _list / _propose accept nodeId (and propose accepts includeMagi)', () => {
    assert.equal(rejectUnknownMeshToolArgs('mesh_node_slots_set', { nodeId: 'n_x', slots: [{ provider: 'claude-cli' }] }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_node_slots_list', { nodeId: 'n_x' }), null);
    assert.equal(rejectUnknownMeshToolArgs('mesh_node_slots_propose', { nodeId: 'n_x', includeMagi: true }), null);
    assert.ok('nodeId' in (MESH_NODE_SLOTS_SET_TOOL.inputSchema.properties as object));
    assert.ok('nodeId' in (MESH_NODE_SLOTS_LIST_TOOL.inputSchema.properties as object));
    const proposeProps = MESH_NODE_SLOTS_PROPOSE_TOOL.inputSchema.properties as Record<string, unknown>;
    assert.ok('nodeId' in proposeProps);
    assert.ok('includeMagi' in proposeProps);
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

test('A3: the required-arg table agrees with every handler signature on node_id / session_id / task_id', () => {
    const registry = handlerRegistry();
    const argTypes = handlerArgTypes();
    assert.ok(registry.size >= 60, `registry parse failed (${registry.size} entries)`);
    const schemaByName = new Map<string, any>([...ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL].map(t => [t.name, t]));
    const audited: string[] = [];
    const untyped: string[] = [];
    const failures: string[] = [];
    for (const [tool, handler] of registry) {
        const schema = schemaByName.get(tool);
        if (!schema) continue; // hidden 1-release aliases forward to a published schema
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
    assert.ok(audited.length >= 30, `expected at least 30 audited (tool, key) pairs, saw ${audited.length}: ${audited.join(', ')}`);
    assert.ok(untyped.length <= 3, `handlers without an inline args type (invisible to the audit): ${untyped.join(', ')}`);
});

test('A3: mesh_notify_worker (flag-gated, not in ALL_MESH_TOOLS) declares node_id and task_id required', () => {
    assert.deepEqual(MESH_NOTIFY_WORKER_TOOL.inputSchema.required, ['node_id', 'task_id', 'message']);
});
