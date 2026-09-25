import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MESH_DELIVERY_MODES,
    MESH_SESSION_CLEANUP_MODES,
    MESH_TASK_DIFFICULTIES,
    MESH_TASK_MODES,
    MESH_TASK_PRIORITIES,
    MESH_THINKING_LEVELS,
} from '@adhdev/mesh-shared';
import { ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL } from '../src/tools/mesh-tool-schemas.js';

/**
 * Schema enum VALUES ↔ mesh-shared vocabulary parity (wiring-unification A3).
 *
 * mesh-schema-handler-parity.test.ts checks argument KEYS. This file checks the
 * member lists: every schema property that carries a vocabulary enum must equal
 * the ONE tuple declared in mesh-shared (mesh-vocabulary.ts / brain-routing.ts).
 * Before A3 the task-mode list was hand-written six times in the schema file;
 * a member added to the code would not have reached the published schema.
 *
 * Two mappings: by property NAME where the name is unambiguous across tools
 * (task_mode, priority, difficulty, …) and by tool.path where the same property
 * name means different things in different tools (`mode`). Every other enum is
 * tool-local and must NOT be a hand copy of a vocabulary list.
 */

const VOCABULARY_BY_PROPERTY: Record<string, { name: string; values: readonly string[] }> = {
    task_mode: { name: 'MESH_TASK_MODES', values: MESH_TASK_MODES },
    taskMode: { name: 'MESH_TASK_MODES', values: MESH_TASK_MODES },
    priority: { name: 'MESH_TASK_PRIORITIES', values: MESH_TASK_PRIORITIES },
    thinkingLevel: { name: 'MESH_THINKING_LEVELS', values: MESH_THINKING_LEVELS },
    thinking_level: { name: 'MESH_THINKING_LEVELS', values: MESH_THINKING_LEVELS },
    difficulty: { name: 'MESH_TASK_DIFFICULTIES', values: MESH_TASK_DIFFICULTIES },
    delivery_mode: { name: 'MESH_DELIVERY_MODES', values: MESH_DELIVERY_MODES },
    deliveryMode: { name: 'MESH_DELIVERY_MODES', values: MESH_DELIVERY_MODES },
};

const VOCABULARY_BY_PATH: Record<string, { name: string; values: readonly string[] }> = {
    'mesh_remove_node.session_cleanup_mode': { name: 'MESH_SESSION_CLEANUP_MODES', values: MESH_SESSION_CLEANUP_MODES },
    'mesh_cleanup_sessions.mode': { name: 'MESH_SESSION_CLEANUP_MODES', values: MESH_SESSION_CLEANUP_MODES },
};

const EVERY_VOCABULARY = [
    MESH_TASK_MODES, MESH_TASK_PRIORITIES, MESH_THINKING_LEVELS,
    MESH_TASK_DIFFICULTIES, MESH_DELIVERY_MODES, MESH_SESSION_CLEANUP_MODES,
].map(values => JSON.stringify([...values]));

/**
 * Number of schema properties that carry a vocabulary enum. Moves only with a
 * deliberate schema change. rc.37#2 bumped 18→20: `mesh_enqueue_task.thinking_level`
 * and `mesh_enqueue_batch.tasks.items.thinking_level` were added as the previously-
 * missing snake_case alias of `thinkingLevel` (the schema declared only the
 * camelCase form, so the pre-dispatch unknown-key gate rejected the documented
 * snake_case spelling). Both use `enumOf(MESH_THINKING_LEVELS)` and are already
 * covered by the `thinking_level` entry in VOCABULARY_BY_PROPERTY above.
 * graph-orchestration-simplification D2 dropped it 20→16: the enqueue schemas stopped
 * publishing their camelCase aliases (`taskMode` + `thinkingLevel` on
 * mesh_enqueue_task and on mesh_enqueue_batch tasks[]). The aliases are still
 * accepted — and enum-checked as their canonical key — by validate-tool-args.ts.
 */
const EXPECTED_VOCABULARY_PROPERTY_COUNT = 16;

interface EnumSite { tool: string; path: string; leaf: string; values: unknown }

function collectEnumSites(tool: string, node: unknown, path: string[], out: EnumSite[]): void {
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if (Array.isArray(schema.enum)) {
        out.push({ tool, path: path.join('.'), leaf: path[path.length - 1] ?? '', values: schema.enum });
    }
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties && typeof properties === 'object') {
        for (const [key, child] of Object.entries(properties)) collectEnumSites(tool, child, [...path, key], out);
    }
    if (schema.items) collectEnumSites(tool, schema.items, [...path, 'items'], out);
}

function allEnumSites(): EnumSite[] {
    const sites: EnumSite[] = [];
    for (const tool of [...ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL]) {
        collectEnumSites(tool.name, tool.inputSchema, [], sites);
    }
    return sites;
}

function vocabularyFor(site: EnumSite): { name: string; values: readonly string[] } | undefined {
    return VOCABULARY_BY_PATH[`${site.tool}.${site.path}`] ?? VOCABULARY_BY_PROPERTY[site.leaf];
}

test('every vocabulary enum in the mesh tool schemas equals its mesh-shared tuple', () => {
    const sites = allEnumSites();
    const covered = sites.filter(site => vocabularyFor(site));
    for (const site of covered) {
        const vocabulary = vocabularyFor(site)!;
        assert.deepEqual(
            site.values,
            [...vocabulary.values],
            `${site.tool}.${site.path} must be enumOf(${vocabulary.name}) — got ${JSON.stringify(site.values)}`,
        );
    }
    assert.equal(
        covered.length,
        EXPECTED_VOCABULARY_PROPERTY_COUNT,
        `vocabulary-enum property count drifted: ${covered.map(s => `${s.tool}.${s.path}`).join(', ')}`,
    );
});

test('the vocabulary map names every tuple mesh-shared declares for the schemas', () => {
    const named = new Set([...Object.values(VOCABULARY_BY_PROPERTY), ...Object.values(VOCABULARY_BY_PATH)].map(v => v.name));
    assert.deepEqual(
        [...named].sort(),
        ['MESH_DELIVERY_MODES', 'MESH_SESSION_CLEANUP_MODES', 'MESH_TASK_DIFFICULTIES', 'MESH_TASK_MODES', 'MESH_TASK_PRIORITIES', 'MESH_THINKING_LEVELS'],
    );
});

test('no tool-local enum is a hand copy of a vocabulary list, and no vocabulary property name is left unmapped', () => {
    const sites = allEnumSites();
    const local = sites.filter(site => !vocabularyFor(site));
    assert.ok(local.length > 0, 'tool-local enums (gate outcomes, mission status, key names, …) are expected to exist');
    for (const site of local) {
        assert.ok(
            !EVERY_VOCABULARY.includes(JSON.stringify(site.values)),
            `${site.tool}.${site.path} spells out a vocabulary list by hand — derive it with enumOf() and register the path here`,
        );
        assert.ok(
            !(site.leaf in VOCABULARY_BY_PROPERTY),
            `${site.tool}.${site.path} uses a vocabulary property name without being mapped`,
        );
    }
});
