import { buildMeshRoutePreview } from '@adhdev/daemon-core';
import type { MeshContext } from './mesh-tools-internal.js';

const ROUTABLE_DIFFICULTIES = new Set(['easy', 'medium', 'difficult', 'freeform']);

/**
 * Read-only hypothetical routing query. Deliberately does not call
 * refreshMeshFromDaemon, commandForNode, or transport.command: quota comes from
 * the facts already on ctx.mesh and capacity from daemon-core's live queue
 * store. The returned timestamp/warning makes that snapshot lifetime explicit.
 */
export async function meshRoutePreview(
    ctx: MeshContext,
    args: {
        difficulty?: string;
        required_tags?: string[];
        requiredTags?: string[];
        readonly?: boolean;
        target_node_id?: string;
        targetNodeId?: string;
    },
): Promise<string> {
    const difficulty = typeof args?.difficulty === 'string' ? args.difficulty.trim() : '';
    if (!ROUTABLE_DIFFICULTIES.has(difficulty)) {
        return JSON.stringify({
            success: false,
            tool: 'mesh_route_preview',
            error: 'difficulty must be one of: easy, medium, difficult, freeform',
        }, null, 2);
    }
    const requiredTags = Array.isArray(args.required_tags)
        ? args.required_tags
        : Array.isArray(args.requiredTags)
            ? args.requiredTags
            : [];
    const targetNodeId = typeof args.target_node_id === 'string'
        ? args.target_node_id
        : args.targetNodeId;
    return JSON.stringify(buildMeshRoutePreview({
        mesh: ctx.mesh,
        difficulty,
        requiredTags,
        readonly: args.readonly === true,
        targetNodeId,
    }), null, 2);
}
