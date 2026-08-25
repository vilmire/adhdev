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
 */

import { ALL_MESH_TOOLS, MESH_CHANGE_IMPACT_CONFIG_TOOL, MESH_REFINE_CONFIG_TOOL } from './mesh-tool-schemas.js';

export interface ToolSchemaLike {
    name: string;
    inputSchema?: { properties?: Record<string, unknown> };
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

const MESH_TOOL_BY_NAME = new Map<string, ToolSchemaLike>(
    (ALL_MESH_TOOLS as ToolSchemaLike[]).map(tool => [tool.name, tool]),
);

// Hidden 1-release aliases (Part 8-4 and its change-impact symmetric) are not
// published in ALL_MESH_TOOLS but stay dispatchable in server.ts, forwarding to
// the unified tool with `mode` injected. Validate their arguments against the
// unified schema they forward to — its properties (mode/node_id/config) are a
// superset of anything the pre-consolidation callers could pass.
const MESH_ALIAS_TOOL: Record<string, ToolSchemaLike> = {
    mesh_refine_config_schema: MESH_REFINE_CONFIG_TOOL,
    mesh_validate_refine_config: MESH_REFINE_CONFIG_TOOL,
    mesh_suggest_refine_config: MESH_REFINE_CONFIG_TOOL,
    mesh_change_impact_config_schema: MESH_CHANGE_IMPACT_CONFIG_TOOL,
    mesh_validate_change_impact_config: MESH_CHANGE_IMPACT_CONFIG_TOOL,
    mesh_suggest_change_impact_config: MESH_CHANGE_IMPACT_CONFIG_TOOL,
};

/**
 * Mesh-mode gate: error text when the call carries unknown arguments, else
 * null. Unknown tool names return null and fall through to the dispatcher's
 * existing "Unknown tool" response.
 */
export function rejectUnknownMeshToolArgs(name: string, args: Record<string, unknown>): string | null {
    const tool = MESH_TOOL_BY_NAME.get(name) ?? MESH_ALIAS_TOOL[name];
    if (!tool) return null;
    return unknownToolArgsError(name, tool.inputSchema?.properties, args);
}
