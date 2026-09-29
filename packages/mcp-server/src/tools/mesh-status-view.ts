// The MCP `mesh_status` tool's ONE daemon call (data-path audit 2026-09-29 P1-6).
//
// Owner principle ④: tools talk only to the coordinator daemon, which holds every
// node's latest state because members push it. So `mesh_status` asks the
// coordinator ONE question — `mesh_status_view` (daemon-core
// commands/high-family/mesh-status-view.ts) — and the daemon composes every
// input the tool reads, in-process: its held `mesh_status` (the same view the
// dashboard gets), membership, its own status, recovery contexts, active work,
// missions, the caller's pending-event drain and the polling-rate record. This
// module only RENDERS: it never reads a member, and there is no live-probe
// fallback — a remote node with nothing held is reported as such.
//
// The node runtime, held state and routes are read straight from the view
// (mesh-held-node-state.ts parses them). The typed IPC answers the view carries
// (membership, recovery, active work, missions, pending events, tool-call
// record, related-repo git) keep their one decoder each: the renderer's shared
// helpers read them through `createMeshStatusViewTransport`, which answers from
// the view and throws for anything else — any remote (meshCommand) read, or a
// read the view does not carry — so the tool cannot regrow a second round trip.

import type { MeshContext } from './mesh-tools-internal.js';
import { nodeSetKey, type MeshNodeRoute } from './mesh-node-routes.js';

export interface MeshStatusViewRequest {
    refresh?: boolean;
    compact: boolean;
    includeTerminalDirect?: boolean;
    pendingEvents?: Record<string, unknown> | null;
    toolCall?: { tool: string; sessionId?: string; callerRole?: string } | null;
}

export type MeshStatusView = Record<string, any>;

function readRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** The ONE daemon call. Throws when the coordinator cannot answer at all. */
export async function readMeshStatusView(ctx: MeshContext, request: MeshStatusViewRequest): Promise<MeshStatusView> {
    const raw = await ctx.transport.command('mesh_status_view', {
        meshId: ctx.mesh.id,
        ...(request.refresh ? { refresh: true } : {}),
        compact: request.compact,
        ...(request.includeTerminalDirect ? { includeTerminalDirect: true } : {}),
        ...(request.pendingEvents ? { pendingEvents: request.pendingEvents } : {}),
        ...(request.toolCall ? { toolCall: request.toolCall } : {}),
        // The daemon refuses when it is not the one this process believes it talks to.
        ...(ctx.localDaemonId ? { callerDaemonId: ctx.localDaemonId } : {}),
    });
    const view = readRecord(readRecord(raw)?.result) ?? readRecord(raw);
    if (!view || view.success === false) {
        throw new Error(typeof view?.error === 'string' ? view.error : 'coordinator mesh_status_view returned no view');
    }
    return view;
}

class MeshStatusViewMiss extends Error {
    constructor(what: string) {
        super(`mesh_status renders only the coordinator's view — ${what} is not part of it`);
    }
}

/**
 * A transport that answers the renderer's reads from `view`. It keeps the base
 * transport's prototype (the renderer's locality checks read it) but can reach
 * nothing: every read is served from the view or refused.
 */
export function createMeshStatusViewTransport<T extends object>(base: T, view: MeshStatusView): T {
    const replay = Object.create(base) as T;
    const missions = readRecord(view.missions) ?? {};
    const command = async (command: string, args: Record<string, unknown> = {}) => {
        switch (command) {
            case 'get_mesh': return view.membership;
            case 'recovery_context_query': return view.recovery ?? { success: true, contexts: {} };
            case 'active_work_query': return view.activeWork;
            case 'mission_list_query': return missions.list;
            case 'task_stats_query': return missions.stats ?? { success: true, missions: {} };
            case 'get_pending_mesh_events': return view.pendingEvents ?? { events: [] };
            case 'mesh_node_route':
                // The coordinator decided every node's route in the same answer.
                if (readRecord(view.routes)) return { success: true, meshId: view.meshId, routes: view.routes };
                throw new MeshStatusViewMiss('mesh_node_route');
            case 'tool_call_record':
                if (view.toolCall) return view.toolCall;
                throw new MeshStatusViewMiss('tool_call_record');
            case 'git_status': {
                const workspace = typeof args.workspace === 'string' ? args.workspace : '';
                const hit = readRecord(view.relatedRepoGit)?.[workspace];
                if (hit) return hit;
                throw new MeshStatusViewMiss(`git_status(${workspace})`);
            }
            default:
                throw new MeshStatusViewMiss(command);
        }
    };
    const meshCommand = async (daemonId: string, command: string) => {
        throw new MeshStatusViewMiss(`a remote ${command} to ${daemonId}`);
    };
    // Own properties (never an assignment: the base may carry accessors / read-only slots).
    Object.defineProperty(replay, 'command', { value: command });
    Object.defineProperty(replay, 'meshCommand', { value: meshCommand });
    return replay;
}

/** Hold the coordinator's per-node routes (carried in the view) on the context. */
export function applyMeshStatusViewRoutes(ctx: MeshContext, view: MeshStatusView): void {
    const routes = new Map<string, MeshNodeRoute>();
    for (const [id, value] of Object.entries(readRecord(view.routes) ?? {})) {
        const route = value?.route;
        if (route !== 'local' && route !== 'remote' && route !== 'unreachable') continue;
        routes.set(id, {
            route,
            ...(typeof value.ownerDaemonId === 'string' && value.ownerDaemonId ? { ownerDaemonId: value.ownerDaemonId } : {}),
            reason: typeof value.reason === 'string' ? value.reason : '',
        });
    }
    ctx.nodeRoutes = { at: Date.now(), key: nodeSetKey(ctx), routes };
}
