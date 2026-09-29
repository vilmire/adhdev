/**
 * Node locality is the COORDINATOR DAEMON's decision, never this process's
 * (data-path audit 2026-09-29, owner principle ④ — tools talk only to the
 * coordinator daemon, which holds the roster and knows its own identity).
 *
 * One `mesh_node_route` call answers the route of EVERY node a tool reasons
 * over — the daemon's roster plus the nodes this process knows of (a clone
 * another tool process just made) — with the same rule its mesh_status overlay
 * and `mesh_dispatch_route` use (daemon-core `decideDispatchRoute`):
 *   local       — this daemon serves the node's checkout (in-process);
 *   remote      — another daemon owns it (relayed over the mesh channel);
 *   unreachable — another daemon owns it and there is no mesh channel.
 *
 * The answer is held on the MeshContext (`ctx.nodeRoutes`) for a few seconds
 * and re-asked whenever the node set changes, so the synchronous locality reads
 * (`isLocalControlPlaneNode`) answer from it. Every tool call asks first
 * (server.ts), and the async paths that route (commandForNode, the read_chat
 * replica hop, related-repo git, refine config reads …) ensure it again.
 */
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { readString } from './mesh-tool-shared.js';
import type { MeshContext } from './mesh-tools.js';

export interface MeshNodeRoute {
    route: 'local' | 'remote' | 'unreachable';
    ownerDaemonId?: string;
    reason: string;
}

export interface MeshNodeRoutesCache {
    /** Epoch ms the daemon answered. */
    at: number;
    /** The node set the answer was for (a changed set re-asks). */
    key: string;
    routes: Map<string, MeshNodeRoute>;
}

/** A held answer is re-asked after this long even when the node set did not change. */
export const MESH_NODE_ROUTES_TTL_MS = 5_000;

function nodeIdOf(node: LocalMeshNodeEntry | null | undefined): string {
    const n = node as any;
    return readString(n?.id) || readString(n?.nodeId) || readString(n?.node_id) || '';
}

/** The identity fields of a node the daemon routes by (never its transient / session fields). */
function describeNode(node: LocalMeshNodeEntry): Record<string, unknown> | null {
    const n = node as any;
    const id = nodeIdOf(node);
    if (!id) return null;
    return {
        id,
        ...(readString(n.daemonId) ? { daemonId: readString(n.daemonId) } : {}),
        ...(readString(n.machineId) ? { machineId: readString(n.machineId) } : {}),
        ...(readString(n.workspace) ? { workspace: readString(n.workspace) } : {}),
    };
}

function nodeSetKey(ctx: MeshContext): string {
    const nodes = Array.isArray(ctx.mesh?.nodes) ? ctx.mesh.nodes : [];
    return nodes
        .map((node) => {
            const d = describeNode(node);
            return d ? `${d.id}|${d.daemonId ?? ''}|${d.machineId ?? ''}|${d.workspace ?? ''}` : '';
        })
        .filter(Boolean)
        .sort()
        .join('\n');
}

function unwrap(raw: any): any {
    let cursor = raw;
    for (let depth = 0; depth < 3 && cursor && typeof cursor === 'object'; depth += 1) {
        if (cursor.routes && typeof cursor.routes === 'object') return cursor;
        cursor = cursor.result ?? cursor.payload ?? cursor.data;
    }
    return raw;
}

/**
 * Ask the coordinator daemon for every node's route when the held answer is
 * missing, stale, or for another node set. Never throws; a daemon that cannot
 * answer leaves the previous answer (or none) in place.
 */
export async function ensureMeshNodeRoutes(ctx: MeshContext, opts: { force?: boolean; now?: number } = {}): Promise<void> {
    if (!ctx?.mesh?.id || typeof (ctx.transport as any)?.command !== 'function') return;
    const now = opts.now ?? Date.now();
    const key = nodeSetKey(ctx);
    const held = ctx.nodeRoutes;
    if (!opts.force && held && held.key === key && now - held.at < MESH_NODE_ROUTES_TTL_MS) return;
    const nodes = (Array.isArray(ctx.mesh.nodes) ? ctx.mesh.nodes : []).map(describeNode).filter(Boolean);
    let raw: any;
    try {
        raw = await ctx.transport.command('mesh_node_route', {
            meshId: ctx.mesh.id,
            nodes,
            // The daemon refuses when it is not the one this process believes it talks to.
            ...(ctx.localDaemonId ? { callerDaemonId: ctx.localDaemonId } : {}),
        });
    } catch {
        return;
    }
    const result = unwrap(raw);
    if (!result || result.success === false || !result.routes || typeof result.routes !== 'object') return;
    const routes = new Map<string, MeshNodeRoute>();
    for (const [id, value] of Object.entries(result.routes as Record<string, any>)) {
        const route = value?.route;
        if (route !== 'local' && route !== 'remote' && route !== 'unreachable') continue;
        routes.set(id, {
            route,
            ...(readString(value.ownerDaemonId) ? { ownerDaemonId: readString(value.ownerDaemonId) } : {}),
            reason: readString(value.reason) ?? '',
        });
    }
    ctx.nodeRoutes = { at: now, key, routes };
}

/** The coordinator daemon's route for `node`, if it has answered for it. */
export function meshNodeRouteOf(ctx: MeshContext, node: LocalMeshNodeEntry | null | undefined): MeshNodeRoute | undefined {
    const id = nodeIdOf(node);
    return id ? ctx?.nodeRoutes?.routes.get(id) : undefined;
}
