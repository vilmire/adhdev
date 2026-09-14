import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MESH_MAGI_KIND_PANEL_LIST_TOOL, MESH_MAGI_KIND_PANEL_SET_TOOL, MESH_WRITE_MESH_JSON_CONFIG_TOOL } from '../src/tools/mesh-tool-schemas.js';
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
