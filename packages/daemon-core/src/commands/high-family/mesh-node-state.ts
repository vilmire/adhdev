/**
 * RF-ROUTER HIGH family — coordinator-held node state commands.
 *
 * mesh_node_git_report: a member daemon pushes its own git state for a mesh
 *   node (mesh/mesh-node-state-pusher.ts). The coordinator records it in the
 *   node-state store and, when the visible content changed, invalidates the
 *   aggregate snapshot + publishes a mesh-state revision so dashboards refetch.
 *   Sender gate `node_owner`: only the daemon that owns the node on this
 *   coordinator's roster may report it. The report may also carry (or, between
 *   git ticks, carry ONLY) the member's content-free runtime summary — sessions,
 *   build, upgrade marker, facts incl. quota (mesh/mesh-node-runtime-summary.ts,
 *   re-sanitized at ingest). A runtime change is served by the per-call overlay;
 *   only a facts (quota/build) change publishes a revision, so session status
 *   churn does not make every dashboard refetch.
 *
 * mesh_node_git_log: the node detail's "recent commits" read, routed THROUGH the
 *   coordinator (the dashboard never talks to a remote node's daemon itself):
 *   local node → git_log here; remote node → forwarded to its daemon over the
 *   mesh channel with a bounded wait.
 */
import * as fs from 'fs';
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { defineCommandSpecs } from '../command-registry.js';
import { withMeshDirectDispatch } from '../command-args.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';

/** Remote git_log forward budget — well under the dashboard's 30s command deadline. */
export const MESH_NODE_GIT_LOG_TIMEOUT_MS = 15_000;

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function resolveMeshNode(ctx: HighFamilyContext, meshId: string, nodeId: string): Promise<
    | { ok: true; mesh: any; node: any }
    | { ok: false; result: CommandRouterResult }
> {
    const record = await ctx.getMeshForCommand(meshId, undefined, { preferInline: true });
    const mesh = record?.mesh;
    if (!mesh) return { ok: false, result: { success: false, code: 'mesh_not_found', error: 'Mesh not found', accepted: false } };
    const node = Array.isArray(mesh.nodes) ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId)) : undefined;
    if (!node) return { ok: false, result: { success: false, code: 'mesh_node_unknown', error: `Node ${nodeId} is not on mesh ${meshId}`, accepted: false } };
    return { ok: true, mesh, node };
}

export const meshNodeStateHandlers: Record<string, HighFamilyHandler> = {
    mesh_node_git_report: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const nodeId = readString(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const git = readRecord(args?.git);
        const runtime = readRecord(args?.runtime);
        const hasGit = !!git && typeof git.isGitRepo === 'boolean';
        if (!hasGit && !runtime) return { success: false, error: 'git status required' };
        const resolved = await resolveMeshNode(ctx, meshId, nodeId);
        if (!resolved.ok) return resolved.result;
        const nodeWorkspace = readString(resolved.node.workspace);
        const reportedWorkspace = readString(args?.workspace);
        if (nodeWorkspace && reportedWorkspace && nodeWorkspace !== reportedWorkspace) {
            // The node was re-pointed at another checkout: this subscription is obsolete.
            return { success: false, code: 'mesh_node_unknown', error: 'workspace does not match the node on this roster', accepted: false };
        }
        const observedAt = typeof args?.observedAt === 'number' && Number.isFinite(args.observedAt) ? args.observedAt : undefined;
        const workspace = nodeWorkspace || reportedWorkspace;
        const changed = hasGit
            ? ctx.meshNodeGitState.recordObservation({ meshId, nodeId, workspace, git, source: 'member_push', observedAt }).changed
            : false;
        let runtimeChanged = false;
        let factsChanged = false;
        if (runtime) {
            const runtimeObservedAt = typeof args?.runtimeObservedAt === 'number' && Number.isFinite(args.runtimeObservedAt)
                ? args.runtimeObservedAt
                : undefined;
            const recorded = ctx.meshNodeGitState.recordRuntimeObservation({
                meshId, nodeId, workspace, runtime, source: 'member_push', observedAt: runtimeObservedAt,
            });
            runtimeChanged = recorded.changed;
            factsChanged = recorded.factsChanged;
            // Runtime is DAEMON-wide: the same summary is the truth for every node this
            // daemon serves on the mesh (worktrees), not only the subscribed one.
            const ownerDaemonId = readMeshNodeDaemonId(resolved.node) ?? '';
            for (const sibling of Array.isArray(resolved.mesh.nodes) ? resolved.mesh.nodes : []) {
                if (!sibling || sibling === resolved.node || meshNodeIdMatches(sibling, nodeId)) continue;
                const siblingDaemonId = readMeshNodeDaemonId(sibling) ?? '';
                const siblingId = readString(sibling.id);
                if (!ownerDaemonId || !siblingId || !siblingDaemonId || !daemonIdsEquivalent(siblingDaemonId, ownerDaemonId)) continue;
                const siblingRecorded = ctx.meshNodeGitState.recordRuntimeObservation({
                    meshId, nodeId: siblingId, workspace: readString(sibling.workspace), runtime, source: 'member_push', observedAt: runtimeObservedAt,
                });
                factsChanged = factsChanged || siblingRecorded.factsChanged;
            }
        }
        if (changed) ctx.invalidateAggregateMeshStatus(meshId);
        else if (factsChanged) ctx.deps.onMeshStateChange?.(meshId);
        return { success: true, accepted: true, changed, ...(runtime ? { runtimeChanged } : {}) };
    },

    mesh_node_git_log: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const nodeId = readString(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const limit = typeof args?.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(50, Math.floor(args.limit)))
            : 5;
        const resolved = await resolveMeshNode(ctx, meshId, nodeId);
        if (!resolved.ok) return resolved.result;
        const workspace = readString(resolved.node.workspace);
        if (!workspace) return { success: false, error: `Node ${nodeId} has no workspace` };
        const nodeDaemonId = readMeshNodeDaemonId(resolved.node) ?? '';
        const selfDaemonId = ctx.deps.statusInstanceId ?? '';
        const isRemote = !!nodeDaemonId && !(selfDaemonId && daemonIdsEquivalent(nodeDaemonId, selfDaemonId))
            && !fs.existsSync(workspace);
        if (!isRemote) return ctx.execute('git_log', { workspace, limit }, 'internal', { inProcess: true });
        if (!ctx.deps.dispatchMeshCommand) return { success: false, error: 'Remote node is not reachable from this daemon' };
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const forwarded = await Promise.race([
                ctx.deps.dispatchMeshCommand(nodeDaemonId, 'git_log', withMeshDirectDispatch({ workspace, limit })),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('mesh_node_git_log_timeout')), MESH_NODE_GIT_LOG_TIMEOUT_MS);
                }),
            ]);
            return unwrapMeshRelayResult(forwarded, { command: 'git_log', peerDaemonId: nodeDaemonId }) as CommandRouterResult;
        } catch (error: any) {
            return { success: false, code: 'mesh_node_unreachable', error: error?.message || 'git_log forward failed' };
        } finally {
            if (timer) clearTimeout(timer);
        }
    },
};

export const meshNodeStateSpecs = defineCommandSpecs('high', meshNodeStateHandlers, {
    // A member daemon reporting its OWN node: the sender must own the node the
    // payload names on this coordinator's roster.
    mesh_node_git_report: { meshSender: 'node_owner' },
}, { meshSender: 'authenticated_peer' });
