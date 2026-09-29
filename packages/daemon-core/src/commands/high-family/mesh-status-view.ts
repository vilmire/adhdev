/**
 * The coordinator daemon's answers for mesh TOOLS (the MCP server) — so a tool
 * talks to ONE daemon command per question and renders only presentation
 * (data-path audit 2026-09-29 P1-6, owner principle ④: users and tools talk only
 * to the coordinator daemon, which holds every node's latest state because
 * members push).
 *
 * mesh_status_view: every input the MCP `mesh_status` tool reads, composed HERE
 *   from the daemon's own commands in-process (never a remote read — remote
 *   nodes come only from the coordinator-held state, a node with nothing held
 *   is reported as such, not probed):
 *     status        — `mesh_status` (the SAME held view the dashboard gets; node section)
 *     membership    — `get_mesh` (membershipOnly)
 *     localStatus   — `get_status_metadata` of THIS daemon (its own nodes' sessions / build)
 *     recovery      — `recovery_context_query` for every node
 *     activeWork    — `active_work_query` over the held node sessions (+ inputs / summary / scheduling)
 *     missions      — `mission_list_query` (+ one batched `task_stats_query` for the verbose view)
 *     pendingEvents — `get_pending_mesh_events` (the caller's inbox drain), when asked
 *     toolCall      — `tool_call_record` (the polling-rate advisory), when asked
 *     relatedRepoGit — `git_status` of related repos of nodes whose checkout is on this machine
 *     routes        — every roster node's route (mesh_node_route's rule, below)
 *   Each part is best-effort: a part that fails is reported as its own failed
 *   result, the rest still answers.
 *
 * mesh_dispatch_route: the routing DECISION for a direct dispatch to a node —
 *   `local` (this daemon serves the node's checkout; send in-process),
 *   `remote` (another daemon owns it; relay to `ownerDaemonId` over the mesh
 *   channel) or `unreachable` (another daemon owns it and this daemon has no
 *   mesh channel). The MCP asks, the daemon decides — from its roster and its own
 *   identity, the same locality rule its mesh_status overlay uses.
 *
 * mesh_node_route: the same decision for EVERY node a tool is about to reason
 *   over (the roster, plus nodes the tool describes that the roster lacks), in
 *   one call — so no tool decides locality itself (read_chat's replica hop,
 *   related-repo git, launch / session targeting, refine config reads …).
 */
import * as fs from 'fs';
import { daemonIdsEquivalent, meshNodeIdMatches, TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';
import { getMachineId } from '../../config/config.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { defineCommandSpecs } from '../command-registry.js';
import type { CommandRouterResult } from '../router.js';
import { isForeignDaemonMeshNode } from './mesh-status-node-state.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';

/** The command sources a tool reaches the coordinator over (local IPC / standalone HTTP). */
const TOOL_SOURCES = ['ipc', 'standalone'] as const;

type Execute = (cmd: string, args: Record<string, unknown>) => Promise<CommandRouterResult>;

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

async function settle(run: () => Promise<CommandRouterResult>): Promise<CommandRouterResult> {
    try {
        return await run();
    } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
    }
}

/** The node fields active work reads (id + every session-list shape) — a full node is ~9 KB. */
const ACTIVE_WORK_NODE_KEYS = [
    'nodeId', 'id', 'activeSessions', 'activeSessionDetails', 'sessions',
] as const;

function slimActiveWorkNodes(nodes: unknown[]): Record<string, unknown>[] {
    return nodes.map((node) => {
        const src = readRecord(node) ?? {};
        const out: Record<string, unknown> = {};
        for (const key of ACTIVE_WORK_NODE_KEYS) if (src[key] !== undefined) out[key] = src[key];
        if (out.id === undefined && typeof src.nodeId === 'string') out.id = src.nodeId;
        // A node served by another daemon: its sessions are the held (pushed) runtime.
        const held = readRecord(src.heldRuntime);
        if (out.sessions === undefined && Array.isArray(held?.sessions)) out.sessions = held!.sessions;
        return out;
    });
}

export interface MeshStatusViewArgs {
    meshId: string;
    /** Explicit refresh: the coordinator nudges members whose held state is old (never a read). */
    refresh?: boolean;
    /** Missions: the compact projection (default) or the verbose rows with stats. */
    compact?: boolean;
    includeTerminalDirect?: boolean;
    /** Drain the caller's pending coordinator events with these args (omit = no drain). */
    pendingEvents?: Record<string, unknown> | null;
    /** Record the tool call for the polling-rate advisory (omit = not recorded). */
    toolCall?: { tool: string; sessionId?: string; callerRole?: string } | null;
    /** The daemon the caller believes it talks to (the handler refuses a mismatch). */
    callerDaemonId?: string;
}

/** Compose the view from the daemon's own commands (exported for tests / a tool harness). */
export async function composeMeshStatusView(execute: Execute, args: MeshStatusViewArgs, opts: {
    /** Whether this daemon serves `node`'s checkout (related-repo git is read only for those). */
    isLocalNode?: (node: any) => boolean;
} = {}): Promise<Record<string, unknown>> {
    const meshId = args.meshId;
    const v = TURN_IPC_PROTOCOL_VERSION;
    const [toolCall, membership, status, localStatus] = await Promise.all([
        args.toolCall
            ? settle(() => execute('tool_call_record', { v, meshId, tool: args.toolCall!.tool, ...(args.toolCall!.sessionId ? { sessionId: args.toolCall!.sessionId } : {}), callerRole: args.toolCall!.callerRole || 'unknown' }))
            : Promise.resolve(null),
        settle(() => execute('get_mesh', { meshId, membershipOnly: true })),
        settle(() => execute('mesh_status', { meshId, sections: ['nodes'], ...(args.refresh ? { refresh: true } : {}) })),
        settle(() => execute('get_status_metadata', {})),
    ]);
    const memberNodes: any[] = Array.isArray(readRecord(membership)?.mesh?.nodes) ? readRecord(membership)!.mesh.nodes : [];
    const statusNodes: any[] = Array.isArray(readRecord(status)?.nodes) ? readRecord(status)!.nodes : [];
    const nodeIds = [...new Set(memberNodes.map((n) => readString(n?.id)).filter(Boolean))];
    const compact = args.compact !== false;

    const missionsRead = async (): Promise<Record<string, unknown>> => {
        const list = await settle(() => execute('mission_list_query', { v, meshId, meshStatusView: compact ? 'compact' : 'verbose' }));
        if (compact || list.success === false) return { list };
        const ids = (Array.isArray((list as any).missions) ? (list as any).missions : []).map((m: any) => String(m?.id)).filter(Boolean);
        const stats = ids.length > 0 ? await settle(() => execute('task_stats_query', { v, meshId, missionIds: ids })) : null;
        return { list, ...(stats ? { stats } : {}) };
    };

    const relatedRepoGit: Record<string, CommandRouterResult> = {};
    const relatedReads = async () => {
        const isLocal = opts.isLocalNode ?? ((node: any) => !!readString(node?.workspace) && fs.existsSync(readString(node.workspace)));
        const workspaces = new Set<string>();
        for (const node of memberNodes) {
            if (!isLocal(node)) continue;
            const related = Array.isArray(node?.relatedRepos) ? node.relatedRepos
                : Array.isArray(node?.policy?.relatedRepos) ? node.policy.relatedRepos : [];
            for (const repo of related) {
                const path = readString(repo?.workspace);
                if (path) workspaces.add(path);
            }
        }
        await Promise.all([...workspaces].map(async (workspace) => {
            relatedRepoGit[workspace] = await settle(() => execute('git_status', { workspace, refreshUpstream: true }));
        }));
    };

    const [recovery, activeWork, missions, pendingEvents] = await Promise.all([
        nodeIds.length > 0 ? settle(() => execute('recovery_context_query', { v, meshId, nodeIds })) : Promise.resolve(null),
        settle(() => execute('active_work_query', {
            v,
            meshId,
            nodes: slimActiveWorkNodes(statusNodes),
            recordTail: 200,
            includeInputs: true,
            includeSummary: true,
            includeSchedulingRuntime: true,
            ...(args.includeTerminalDirect ? { includeTerminalDirect: true } : {}),
        })),
        missionsRead(),
        args.pendingEvents ? settle(() => execute('get_pending_mesh_events', { meshId, ...args.pendingEvents })) : Promise.resolve(null),
        relatedReads(),
    ]);

    return {
        meshId,
        status,
        membership,
        localStatus,
        ...(recovery ? { recovery } : {}),
        activeWork,
        missions,
        ...(pendingEvents ? { pendingEvents } : {}),
        ...(toolCall ? { toolCall } : {}),
        relatedRepoGit,
    };
}

export const meshStatusViewHandlers: Record<string, HighFamilyHandler> = {
    mesh_status_view: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        if (!meshId) return { success: false, error: 'meshId required' };
        const callerDaemonId = readString(args?.callerDaemonId);
        const selfId = readString(ctx.deps.statusInstanceId);
        if (callerDaemonId && selfId && !daemonIdsEquivalent(callerDaemonId, selfId)) {
            return { success: false, code: 'mesh_status_view_wrong_daemon', error: `This is daemon ${selfId}, not ${callerDaemonId}` };
        }
        const execute: Execute = (cmd, cmdArgs) => ctx.execute(cmd, cmdArgs, 'ipc', { inProcess: true });
        const locality = { localDaemonId: selfId, localMachineId: getMachineId() || '' };
        const view = await composeMeshStatusView(execute, {
            meshId,
            refresh: args?.refresh === true,
            compact: args?.compact !== false,
            includeTerminalDirect: args?.includeTerminalDirect === true,
            pendingEvents: readRecord(args?.pendingEvents),
            toolCall: readRecord(args?.toolCall) as MeshStatusViewArgs['toolCall'],
        }, {
            isLocalNode: (node) => !isForeignDaemonMeshNode(node, locality)
                || (!!readString(node?.workspace) && fs.existsSync(readString(node.workspace))),
        });
        // Every node's route, decided here (mesh_node_route's rule) — the tool's
        // renderer never judges locality itself and needs no second call for it.
        const membershipNodes: any[] = Array.isArray(readRecord(view.membership)?.mesh?.nodes) ? readRecord(view.membership)!.mesh.nodes : [];
        const routes = decideNodeRoutes(membershipNodes, [], {
            localDaemonId: ctx.deps.statusInstanceId,
            localMachineId: getMachineId() || '',
            hasMeshTransport: typeof ctx.deps.dispatchMeshCommand === 'function',
        });
        return { success: true, ...view, routes };
    },

    mesh_dispatch_route: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const nodeId = readString(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const record = await ctx.getMeshForCommand(meshId, undefined, { preferInline: true });
        // The roster record is authoritative; a node the tool just learned of (a
        // clone another tool process made) is judged from the record it sends.
        const rostered = Array.isArray(record?.mesh?.nodes) ? record!.mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId)) : undefined;
        const described = readRecord(args?.node);
        const node = rostered ?? (described && meshNodeIdMatches(described, nodeId) ? described : undefined);
        if (!node) return { success: false, code: 'mesh_node_unknown', error: `Node ${nodeId} is not on mesh ${meshId}` };
        // The daemon the caller believes it is talking to: a mismatch means the tool is
        // attached to the wrong daemon — refuse rather than route from someone else's view.
        const callerDaemonId = readString(args?.callerDaemonId);
        const selfId = readString(ctx.deps.statusInstanceId);
        if (callerDaemonId && selfId && !daemonIdsEquivalent(callerDaemonId, selfId)) {
            return { success: false, code: 'mesh_dispatch_route_wrong_daemon', error: `This is daemon ${selfId}, not ${callerDaemonId}` };
        }
        return { success: true, meshId, nodeId: readString(node.id) || nodeId, ...decideDispatchRoute(node, {
            localDaemonId: ctx.deps.statusInstanceId,
            localMachineId: getMachineId() || '',
            hasMeshTransport: typeof ctx.deps.dispatchMeshCommand === 'function',
        }) };
    },

    mesh_node_route: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        if (!meshId) return { success: false, error: 'meshId required' };
        const callerDaemonId = readString(args?.callerDaemonId);
        const selfId = readString(ctx.deps.statusInstanceId);
        if (callerDaemonId && selfId && !daemonIdsEquivalent(callerDaemonId, selfId)) {
            return { success: false, code: 'mesh_node_route_wrong_daemon', error: `This is daemon ${selfId}, not ${callerDaemonId}` };
        }
        const record = await ctx.getMeshForCommand(meshId, undefined, { preferInline: true });
        const roster: any[] = Array.isArray(record?.mesh?.nodes) ? record!.mesh.nodes : [];
        const described: any[] = Array.isArray(args?.nodes) ? args.nodes.filter((n: unknown) => !!readRecord(n) && !!readString((n as any).id)) : [];
        const wanted = Array.isArray(args?.nodeIds) ? new Set<string>(args.nodeIds.map(readString).filter(Boolean)) : null;
        return { success: true, meshId, routes: decideNodeRoutes(roster, described, {
            localDaemonId: ctx.deps.statusInstanceId,
            localMachineId: getMachineId() || '',
            hasMeshTransport: typeof ctx.deps.dispatchMeshCommand === 'function',
        }, wanted) };
    },
};

export interface MeshNodeRouteDecision {
    route: 'local' | 'remote' | 'unreachable';
    ownerDaemonId?: string;
    reason: string;
}

/**
 * Route every roster node (the roster record wins) plus the described nodes the
 * roster lacks (a clone another tool process just made) — optionally only
 * `wanted` ids. Keyed by node id.
 */
export function decideNodeRoutes(
    roster: any[],
    described: any[],
    self: Parameters<typeof decideDispatchRoute>[1],
    wanted: ReadonlySet<string> | null = null,
): Record<string, MeshNodeRouteDecision> {
    const routes: Record<string, MeshNodeRouteDecision> = {};
    for (const node of [...roster, ...described]) {
        const id = readString(node?.id);
        if (!id || routes[id] || (wanted && !wanted.has(id))) continue;
        if (!roster.includes(node) && roster.some((n) => meshNodeIdMatches(n, id))) continue;
        routes[id] = decideDispatchRoute(node, self);
    }
    return routes;
}

/**
 * The routing rule: a node served by ANOTHER daemon whose checkout is not on
 * this machine is `remote` (relayed to its owner over the mesh channel); every
 * other node — this daemon's own, or a checkout on this machine — is `local`.
 */
export function decideDispatchRoute(node: any, self: { localDaemonId?: string; localMachineId?: string; hasMeshTransport: boolean; workspaceExists?: (path: string) => boolean }):
    { route: 'local' | 'remote' | 'unreachable'; ownerDaemonId?: string; reason: string } {
    const ownerDaemonId = readMeshNodeDaemonId(node) ?? '';
    const workspace = readString(node?.workspace);
    const exists = self.workspaceExists ?? ((path: string) => fs.existsSync(path));
    const foreign = !!ownerDaemonId && isForeignDaemonMeshNode(node, { localDaemonId: self.localDaemonId, localMachineId: self.localMachineId || '' });
    if (!foreign) return { route: 'local', reason: 'served_by_this_daemon' };
    if (workspace && exists(workspace)) return { route: 'local', ownerDaemonId, reason: 'checkout_on_this_machine' };
    if (!self.hasMeshTransport) return { route: 'unreachable', ownerDaemonId, reason: 'no_mesh_transport' };
    if (self.localDaemonId && daemonIdsEquivalent(ownerDaemonId, self.localDaemonId)) return { route: 'local', reason: 'served_by_this_daemon' };
    return { route: 'remote', ownerDaemonId, reason: 'owned_by_another_daemon' };
}

export const meshStatusViewSpecs = defineCommandSpecs('high', meshStatusViewHandlers, {
    mesh_status_view: { sources: [...TOOL_SOURCES] },
    mesh_dispatch_route: { sources: [...TOOL_SOURCES] },
    mesh_node_route: { sources: [...TOOL_SOURCES] },
});
