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
 *   The pushed facts bundle also self-heals the node's config record (platform /
 *   arch / nickname / provider + build versions) — the held runtime, not a probe
 *   envelope, is where those come from now.
 *
 *   Member worktree reconciliation: every ack carries this daemon's per-process
 *   `coordinatorBootId`; once per boot id the member adds `memberWorktreeNodes`
 *   (the worktree nodes it owns on the mesh) and the coordinator adopts any its
 *   roster lost (mesh/mesh-remote-worktree-membership.ts), so no client ever has
 *   to ask a member which nodes exist.
 *
 * mesh_node_state_nudge: member side. A coordinator asks this daemon to push a
 *   node's state NOW (explicit refresh). Answers whether a push subscription
 *   from that coordinator exists; the push itself runs in the background.
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
import { readMeshSender } from '../mesh-sender.js';
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
        let sessionsChanged = false;
        if (runtime) {
            const runtimeObservedAt = typeof args?.runtimeObservedAt === 'number' && Number.isFinite(args.runtimeObservedAt)
                ? args.runtimeObservedAt
                : undefined;
            const ownerDaemonId = readMeshNodeDaemonId(resolved.node) ?? '';
            const recorded = ctx.meshNodeGitState.recordRuntimeObservation({
                meshId, nodeId, workspace, runtime, source: 'member_push', observedAt: runtimeObservedAt, daemonId: ownerDaemonId,
            });
            runtimeChanged = recorded.changed;
            factsChanged = recorded.factsChanged;
            sessionsChanged = recorded.sessionsChanged;
            const heal = (healNodeId: string, facts: unknown) => {
                try { ctx.selfHealNodeFromFacts?.(meshId, healNodeId, facts); } catch { /* best-effort */ }
            };
            if (recorded.factsChanged && recorded.entry?.runtime?.nodeFacts) heal(nodeId, recorded.entry.runtime.nodeFacts);
            // Runtime is DAEMON-wide: the same summary is the truth for every node this
            // daemon serves on the mesh (worktrees), not only the subscribed one.
            for (const sibling of Array.isArray(resolved.mesh.nodes) ? resolved.mesh.nodes : []) {
                if (!sibling || sibling === resolved.node || meshNodeIdMatches(sibling, nodeId)) continue;
                const siblingDaemonId = readMeshNodeDaemonId(sibling) ?? '';
                const siblingId = readString(sibling.id);
                if (!ownerDaemonId || !siblingId || !siblingDaemonId || !daemonIdsEquivalent(siblingDaemonId, ownerDaemonId)) continue;
                const siblingRecorded = ctx.meshNodeGitState.recordRuntimeObservation({
                    meshId, nodeId: siblingId, workspace: readString(sibling.workspace), runtime, source: 'member_push', observedAt: runtimeObservedAt, daemonId: siblingDaemonId,
                });
                factsChanged = factsChanged || siblingRecorded.factsChanged;
                sessionsChanged = sessionsChanged || siblingRecorded.sessionsChanged;
                if (siblingRecorded.factsChanged && siblingRecorded.entry?.runtime?.nodeFacts) heal(siblingId, siblingRecorded.entry.runtime.nodeFacts);
            }
        }
        // MEMBER-WORKTREE-RECONCILE: once per coordinator boot the member also lists the
        // worktree nodes it owns on this mesh; adopt the ones this roster lost
        // (owner-gated inside adoptMemberWorktreeNodes). Never fails the push itself.
        let reconciliation: Record<string, unknown> | undefined;
        if (Array.isArray(args?.memberWorktreeNodes) && ctx.adoptMemberWorktreeNodes) {
            try {
                const adopted = await ctx.adoptMemberWorktreeNodes(meshId, {
                    reported: args.memberWorktreeNodes,
                    senderDaemonId: readMeshSender(args),
                    ownerDaemonId: readMeshNodeDaemonId(resolved.node) ?? '',
                });
                reconciliation = {
                    worktreeNodesReconciled: true,
                    ...(adopted.adopted.length > 0 ? { adoptedNodeIds: adopted.adopted } : {}),
                    ...(adopted.healed.length > 0 ? { bootstrapHealedNodeIds: adopted.healed } : {}),
                };
            } catch { /* best-effort: the member re-reports after the next coordinator boot */ }
        }
        // A revision only for what a viewer sees change: git content, the facts
        // bundle / provider catalog, or a session launched / terminated (the
        // node's active sessions render from this held runtime). Session STATUS
        // churn is served by the per-call overlay without a refetch nudge.
        if (changed) ctx.invalidateAggregateMeshStatus(meshId);
        else if (factsChanged || sessionsChanged) ctx.deps.onMeshStateChange?.(meshId);
        return {
            success: true,
            accepted: true,
            changed,
            ...(runtime ? { runtimeChanged } : {}),
            ...(ctx.meshCoordinatorBootId ? { coordinatorBootId: ctx.meshCoordinatorBootId } : {}),
            ...(reconciliation ?? {}),
        };
    },

    mesh_node_state_nudge: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const nodeId = readString(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const coordinatorDaemonId = readMeshSender(args);
        // Keyed by the SENDER: a peer can only nudge the subscriptions it owns.
        const subscribed = !!coordinatorDaemonId && ctx.meshNodeStatePusher?.nudge(coordinatorDaemonId, meshId, nodeId) === true;
        return { success: true, subscribed };
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
    // Coordinator → member: a worker daemon may hold no roster to check the sender
    // against; the pusher answers only for subscriptions THIS sender registered.
    mesh_node_state_nudge: { meshSender: 'authenticated_peer' },
}, { meshSender: 'authenticated_peer' });
