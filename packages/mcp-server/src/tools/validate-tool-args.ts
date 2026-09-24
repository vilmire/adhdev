/**
 * Unknown-argument rejection for MCP tool calls.
 *
 * Incident (2026-08-25): a coordinator called
 *   mesh_cleanup_sessions({ node_id, session_id })
 * but the schema names the array parameter `session_ids`. The unknown key was
 * silently ignored, the remaining `node_id` matched every session on the node
 * ("sessions are matched by node/workspace metadata"), and a live worker
 * session was deleted. The tool behaved as documented — the defect was that
 * the typo was never reported. No mesh tool schema uses additionalProperties
 * and no validation layer existed, so every tool silently dropped mistyped
 * parameters. Every call now passes through this gate before dispatch: an
 * argument key absent from inputSchema.properties is rejected with the
 * offending key names, close-match suggestions ("did you mean session_ids?"),
 * and the allowed key list. Rejection happens before execution, so it is
 * fail-safe — a typo can never widen a destructive operation's match set
 * again, and retrying with the corrected key always works.
 *
 * Required arguments (wiring-unification A3): each schema's `required` list was
 * nominal — the dispatcher never enforced it, so a call missing `node_id` reached
 * the handler and failed deep inside node resolution with an unrelated error
 * ("owner unreachable", a NOT NULL crash) instead of naming the missing key.
 * `validateMeshToolArgs` is the single pre-dispatch gate: unknown keys first,
 * then missing required keys, where a required snake_case key is satisfied by
 * its declared camelCase alias (task_id / taskId). The schema is the table;
 * mesh-schema-handler-parity.test.ts asserts every handler that dereferences
 * node_id / session_id / task_id has that key declared required.
 */

import { ALL_MESH_TOOLS, MESH_CHANGE_IMPACT_CONFIG_TOOL, MESH_NOTIFY_WORKER_TOOL, MESH_REFINE_CONFIG_TOOL } from './mesh-tool-schemas.js';

export interface ToolSchemaLike {
    name: string;
    inputSchema?: { properties?: Record<string, unknown>; required?: readonly string[] };
}

/** Narrow shape of a JSON-Schema `array` property whose `items` is an object schema. */
interface ArrayOfObjectsPropertyLike {
    type?: string;
    items?: { type?: string; properties?: Record<string, unknown> };
}

/** Narrow shape of a JSON-Schema scalar property declaring an `enum`. */
interface EnumPropertyLike {
    enum?: readonly unknown[];
}

function isEnumProperty(value: unknown): value is EnumPropertyLike {
    return !!value && typeof value === 'object' && Array.isArray((value as EnumPropertyLike).enum);
}

function isArrayOfObjectsProperty(value: unknown): value is ArrayOfObjectsPropertyLike {
    if (!value || typeof value !== 'object') return false;
    const prop = value as ArrayOfObjectsPropertyLike;
    return prop.type === 'array' && !!prop.items && typeof prop.items === 'object' && prop.items.type === 'object' && !!prop.items.properties;
}

// Protocol-level meta keys a client may legitimately attach; not tool
// parameters. MCP carries _meta/progressToken at the params level (outside
// `arguments`), but a client that inlines it must not be rejected.
const META_KEYS = new Set(['_meta']);

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/_/g, '');
}

function editDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    let prev = new Array<number>(n + 1);
    let curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

// Case/underscore-insensitive edit distance covers the common typo classes:
// singular/plural (session_id vs session_ids, distance 1), one-off characters,
// and camelCase vs snake_case (distance 0 after normalization).
const MAX_SUGGESTION_DISTANCE = 2;

function suggestKeys(unknownKey: string, allowed: string[]): string[] {
    const target = normalizeKey(unknownKey);
    return allowed
        .map(key => ({ key, distance: editDistance(target, normalizeKey(key)) }))
        .filter(entry => entry.distance <= MAX_SUGGESTION_DISTANCE)
        .sort((x, y) => x.distance - y.distance || x.key.localeCompare(y.key))
        .slice(0, 3)
        .map(entry => entry.key);
}

/**
 * Returns an error message when `args` contains keys the tool schema does not
 * declare, or null when the call is clean. An empty/missing properties object
 * means the tool takes no parameters, so any key is rejected — the safe
 * reading, since every published schema enumerates its keys explicitly.
 */
export function unknownToolArgsError(toolName: string, properties: Record<string, unknown> | undefined, args: Record<string, unknown>): string | null {
    const allowed = Object.keys(properties ?? {});
    const unknown = Object.keys(args).filter(key => !META_KEYS.has(key) && !(key in (properties ?? {})));
    if (unknown.length === 0) return null;
    const parts = unknown.map(key => {
        const suggestions = suggestKeys(key, allowed);
        return suggestions.length > 0
            ? `"${key}" — did you mean ${suggestions.map(s => `"${s}"`).join(', ')}?`
            : `"${key}"`;
    });
    const allowedList = allowed.length > 0
        ? ` Allowed parameters: ${allowed.join(', ')}.`
        : ' This tool takes no parameters.';
    return `Unknown parameter(s) for ${toolName}: ${parts.join('; ')}.${allowedList}`;
}

/**
 * Returns an error message when `args` supplies a value for a property the
 * schema declares an `enum` for, but the value is not one of the declared
 * options — else null.
 *
 * Incident class: `approve`/`mesh_approve`'s `action` field failed OPEN — any
 * value other than exactly `'reject'` (e.g. `'deny'`, `'rejected'`, a typo)
 * was silently treated as `'approve'` by the handler
 * (`a.action === 'reject' ? 'reject' : 'approve'`), so a caller that meant to
 * decline an action could have it approved instead with no error at all. This
 * mirrors {@link unknownToolArgsError}'s incident shape — a mistyped/wrong
 * value silently accepted rather than rejected — but for VALUES instead of
 * KEYS, and runs before the handler for the same fail-closed reason.
 */
export function enumValueError(toolName: string, properties: Record<string, unknown> | undefined, args: Record<string, unknown>): string | null {
    if (!properties) return null;
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined) continue;
        const propSchema = properties[key];
        if (!isEnumProperty(propSchema)) continue;
        const allowedValues = propSchema.enum!;
        if (allowedValues.includes(value)) continue;
        const allowedList = allowedValues.map(v => JSON.stringify(v)).join(', ');
        return `Invalid value for "${key}" in ${toolName}: ${JSON.stringify(value)}. Allowed values: ${allowedList}.`;
    }
    return null;
}

/**
 * Nested counterpart to {@link enumValueError}, mirroring
 * {@link nestedArrayItemArgsError}: walks every declared array-of-objects
 * property and re-runs the enum check against each item's own properties.
 */
export function nestedArrayItemEnumValueError(toolName: string, properties: Record<string, unknown> | undefined, args: Record<string, unknown>): string | null {
    if (!properties) return null;
    for (const [propName, propSchema] of Object.entries(properties)) {
        if (!isArrayOfObjectsProperty(propSchema)) continue;
        const rawItems = args[propName];
        if (!Array.isArray(rawItems)) continue;
        const itemProperties = propSchema.items!.properties as Record<string, unknown>;
        for (let i = 0; i < rawItems.length; i++) {
            const item = rawItems[i];
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const label = typeof (item as Record<string, unknown>).ref === 'string' && (item as Record<string, unknown>).ref
                ? `${propName}[${i}] (ref '${(item as Record<string, unknown>).ref}')`
                : `${propName}[${i}]`;
            const itemError = enumValueError(`${toolName} ${label}`, itemProperties, item as Record<string, unknown>);
            if (itemError) return itemError;
        }
    }
    return null;
}

/**
 * Nested counterpart to {@link unknownToolArgsError}. The top-level gate only ever
 * looked at `Object.keys(args)`, so a typo INSIDE an array-of-objects field (e.g.
 * `mesh_enqueue_batch`'s `tasks[]`) was invisible to it — the item was forwarded to
 * the handler with the bad key silently ignored, exactly the class of bug the
 * top-level gate exists to catch. This walks every top-level property the schema
 * declares as `{type:'array', items:{type:'object', properties:{...}}}` and
 * re-runs the same unknown-key check against each array entry, using the item
 * schema's own properties as the allow-list.
 *
 * Scoped generically (not hardcoded to `tasks`/`workspaces`/`gates`) so it applies
 * to any tool whose schema declares an array-of-objects property — today that is
 * `mesh_enqueue_batch`'s three, but a future one gets the same coverage for free.
 */
export function nestedArrayItemArgsError(toolName: string, properties: Record<string, unknown> | undefined, args: Record<string, unknown>): string | null {
    if (!properties) return null;
    for (const [propName, propSchema] of Object.entries(properties)) {
        if (!isArrayOfObjectsProperty(propSchema)) continue;
        const rawItems = args[propName];
        if (!Array.isArray(rawItems)) continue;
        const itemProperties = propSchema.items!.properties as Record<string, unknown>;
        for (let i = 0; i < rawItems.length; i++) {
            const item = rawItems[i];
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const label = typeof (item as Record<string, unknown>).ref === 'string' && (item as Record<string, unknown>).ref
                ? `${propName}[${i}] (ref '${(item as Record<string, unknown>).ref}')`
                : `${propName}[${i}]`;
            const itemError = unknownToolArgsError(`${toolName} ${label}`, itemProperties, item as Record<string, unknown>);
            if (itemError) return itemError;
        }
    }
    return null;
}

const MESH_TOOL_BY_NAME = new Map<string, ToolSchemaLike>(
    (ALL_MESH_TOOLS as ToolSchemaLike[]).map(tool => [tool.name, tool]),
);

// Hidden 1-release aliases (Part 8-4 and its change-impact symmetric) are not
// published in ALL_MESH_TOOLS but stay dispatchable in server.ts, forwarding to
// the unified tool with `mode` injected. Validate their arguments against the
// unified schema they forward to — its properties (mode/node_id/config) are a
// superset of anything the pre-consolidation callers could pass.
//
// `injected` names the keys the dispatcher fills in for the alias (server.ts /
// mesh-tool-dispatch.ts inject `mode`), so the required-key check does not demand
// from the caller what the alias exists to supply.
const MESH_ALIAS_TOOL: Record<string, { schema: ToolSchemaLike; injected: readonly string[] }> = {
    mesh_refine_config_schema: { schema: MESH_REFINE_CONFIG_TOOL, injected: ['mode'] },
    mesh_validate_refine_config: { schema: MESH_REFINE_CONFIG_TOOL, injected: ['mode'] },
    mesh_suggest_refine_config: { schema: MESH_REFINE_CONFIG_TOOL, injected: ['mode'] },
    mesh_change_impact_config_schema: { schema: MESH_CHANGE_IMPACT_CONFIG_TOOL, injected: ['mode'] },
    mesh_validate_change_impact_config: { schema: MESH_CHANGE_IMPACT_CONFIG_TOOL, injected: ['mode'] },
    mesh_suggest_change_impact_config: { schema: MESH_CHANGE_IMPACT_CONFIG_TOOL, injected: ['mode'] },
    // E-T0: NOT in ALL_MESH_TOOLS on purpose (server.ts publishes it only when
    // the worker-MCP flag is on, so ListTools stays byte-identical when off —
    // see the tool's own doc comment in mesh-tool-schemas.ts). Registered here
    // unconditionally anyway: this map only affects validation of a call that
    // names the tool explicitly, and the daemon-side handler still refuses the
    // call when the flag is off, so a harmless, always-present entry is simpler
    // than threading the flag through this file too.
    mesh_notify_worker: { schema: MESH_NOTIFY_WORKER_TOOL, injected: [] },
};

function resolveMeshTool(name: string): { schema: ToolSchemaLike; injected: readonly string[] } | undefined {
    const published = MESH_TOOL_BY_NAME.get(name);
    if (published) return { schema: published, injected: [] };
    return MESH_ALIAS_TOOL[name];
}

/**
 * Mesh-mode gate: error text when the call carries unknown arguments — at the
 * top level OR inside a declared array-of-objects field (`tasks[]`,
 * `workspaces[]`, `gates[]`) — else null. Unknown tool names return null and
 * fall through to the dispatcher's existing "Unknown tool" response.
 */
export function rejectUnknownMeshToolArgs(name: string, args: Record<string, unknown>): string | null {
    const tool = resolveMeshTool(name);
    if (!tool) return null;
    const properties = tool.schema.inputSchema?.properties;
    return unknownToolArgsError(name, properties, args)
        ?? nestedArrayItemArgsError(name, properties, args)
        ?? enumValueError(name, properties, args)
        ?? nestedArrayItemEnumValueError(name, properties, args);
}

function isPresent(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

/**
 * Returns an error message when `args` lacks a key the schema declares
 * `required`, else null. A required key is satisfied by any DECLARED property
 * that normalizes to the same name (its camelCase/snake_case alias), because
 * that is exactly how the handlers read them (`args.task_id ?? args.taskId`).
 * An empty string counts as missing — every handler trims and rejects blanks.
 */
export function missingRequiredToolArgsError(
    toolName: string,
    schema: ToolSchemaLike['inputSchema'],
    args: Record<string, unknown>,
    injected: readonly string[] = [],
): string | null {
    const required = (schema?.required ?? []).filter(key => !injected.includes(key));
    if (required.length === 0) return null;
    const declared = Object.keys(schema?.properties ?? {});
    const missing = required.filter(key => {
        const wanted = normalizeKey(key);
        const aliases = declared.filter(candidate => normalizeKey(candidate) === wanted);
        const names = aliases.length > 0 ? aliases : [key];
        return !names.some(candidate => isPresent(args[candidate]));
    });
    if (missing.length === 0) return null;
    return `Missing required parameter(s) for ${toolName}: ${missing.map(key => `"${key}"`).join(', ')}. Required: ${required.join(', ')}.`;
}

/**
 * Mesh-mode gate: unknown-key rejection (top-level, then nested array items)
 * followed by required-key rejection. Unknown keys are reported first so a
 * typo'd required key ("nod_id") gets the did-you-mean suggestion rather than
 * a bare "missing node_id".
 */
export function validateMeshToolArgs(name: string, args: Record<string, unknown>): string | null {
    const tool = resolveMeshTool(name);
    if (!tool) return null;
    const properties = tool.schema.inputSchema?.properties;
    return unknownToolArgsError(name, properties, args)
        ?? nestedArrayItemArgsError(name, properties, args)
        ?? enumValueError(name, properties, args)
        ?? nestedArrayItemEnumValueError(name, properties, args)
        ?? missingRequiredToolArgsError(name, tool.schema.inputSchema, args, tool.injected);
}
