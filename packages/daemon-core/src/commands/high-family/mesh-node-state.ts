/**
 * RF-ROUTER HIGH family — coordinator-held node state commands.
 *
 * mesh_node_git_report: a member daemon pushes its own git state for a mesh
 *   node (mesh/mesh-node-state-pusher.ts). The coordinator records it in the
 *   node-state store and, when the visible content changed, invalidates the
 *   aggregate snapshot + publishes a mesh-state revision so dashboards refetch.
 *   Sender gate `node_owner`: only the daemon that owns the node on this
 *   coordinator's roster may report it. The report may also carry (or, between
 *   git ticks, carry ONLY) the member's content-free runtime summary — or, when
 *   it did not change, only its `runtimeSignature` (answered with `runtimeHeld`) — sessions,
 *   build, upgrade marker, facts incl. quota (mesh/mesh-node-runtime-summary.ts,
 *   re-sanitized at ingest). Any runtime change flushes the mesh's keyed
 *   mesh.status lane (only the changed node's fields travel). The git half is
 *   symmetric: an unchanged checkout (heartbeat / nudge) travels as
 *   `gitSignature` + its upstream fetch stamp only, answered with `gitHeld`;
 *   `false` (nothing / something else held) makes the member send the body at once.
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
 *   node's state NOW (first contact, (re)connect handshake, explicit refresh);
 *   a node not yet pushed to that coordinator is subscribed on the spot (the
 *   nudge carries its workspace). Answers whether a subscription exists; the
 *   push itself runs in the background.
 *
 * mesh_node_git_log: the node detail's "recent commits" read, routed THROUGH the
 *   coordinator (the dashboard never talks to a remote node's daemon itself):
 *   local node → git_log here; remote node → forwarded to its daemon over the
 *   mesh channel with a bounded wait.
 */
import * as fs from 'fs';
import { daemonIdsEquivalent, meshNodeIdMatches, readText, readOptionalRecord } from '@adhdev/mesh-shared';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { defineCommandSpecs } from '../command-registry.js';
import { withMeshDirectDispatch } from '../command-args.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { readMeshSender } from '../mesh-sender.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';

/** Remote git_log forward budget — well under the dashboard's 30s command deadline. */
export const MESH_NODE_GIT_LOG_TIMEOUT_MS = 15_000;

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
        const meshId = readText(args?.meshId);
        const nodeId = readText(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const git = readOptionalRecord(args?.git);
        const runtime = readOptionalRecord(args?.runtime);
        // Unchanged runtime / git travel as their signature only (mesh-node-state-pusher.ts).
        const runtimeSignature = !runtime ? readText(args?.runtimeSignature) : '';
        const hasGit = !!git && typeof git.isGitRepo === 'boolean';
        const gitSignature = !hasGit ? readText(args?.gitSignature) : '';
        if (!hasGit && !runtime && !gitSignature) return { success: false, error: 'git status required' };
        const resolved = await resolveMeshNode(ctx, meshId, nodeId);
        if (!resolved.ok) return resolved.result;
        const nodeWorkspace = readText(resolved.node.workspace);
        const reportedWorkspace = readText(args?.workspace);
        if (nodeWorkspace && reportedWorkspace && nodeWorkspace !== reportedWorkspace) {
            // The node was re-pointed at another checkout: this subscription is obsolete.
            return { success: false, code: 'mesh_node_unknown', error: 'workspace does not match the node on this roster', accepted: false };
        }
        const observedAt = typeof args?.observedAt === 'number' && Number.isFinite(args.observedAt) ? args.observedAt : undefined;
        const workspace = nodeWorkspace || reportedWorkspace;
        let changed = hasGit
            ? ctx.meshNodeGitState.recordObservation({ meshId, nodeId, workspace, git, source: 'member_push', observedAt }).changed
            : false;
        // Signature-only git (a heartbeat / nudge over an unchanged checkout): renew the
        // held observation when it matches, else ask for the body (`gitHeld: false`).
        let gitHeld: boolean | undefined;
        if (gitSignature) {
            const upstreamFetchedAt = typeof args?.upstreamFetchedAt === 'number' && Number.isFinite(args.upstreamFetchedAt)
                ? args.upstreamFetchedAt
                : undefined;
            const confirmed = ctx.meshNodeGitState.confirmObservation({ meshId, nodeId, signature: gitSignature, observedAt, upstreamFetchedAt });
            gitHeld = confirmed.held;
            changed = changed || confirmed.changed;
        }
        let runtimeChanged = false;
        let factsChanged = false;
        let sessionsChanged = false;
        // A different daemon process / build than held (restart, upgrade) — always a revision.
        let instanceChanged = false;
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
            instanceChanged = recorded.instanceChanged;
            const heal = (healNodeId: string, facts: unknown) => {
                try { ctx.selfHealNodeFromFacts?.(meshId, healNodeId, facts); } catch { /* best-effort */ }
            };
            if (recorded.factsChanged && recorded.entry?.runtime?.nodeFacts) heal(nodeId, recorded.entry.runtime.nodeFacts);
            // Runtime is DAEMON-wide: the same summary is the truth for every node this
            // daemon serves on the mesh (worktrees), not only the subscribed one.
            for (const sibling of Array.isArray(resolved.mesh.nodes) ? resolved.mesh.nodes : []) {
                if (!sibling || sibling === resolved.node || meshNodeIdMatches(sibling, nodeId)) continue;
                const siblingDaemonId = readMeshNodeDaemonId(sibling) ?? '';
                const siblingId = readText(sibling.id);
                if (!ownerDaemonId || !siblingId || !siblingDaemonId || !daemonIdsEquivalent(siblingDaemonId, ownerDaemonId)) continue;
                const siblingRecorded = ctx.meshNodeGitState.recordRuntimeObservation({
                    meshId, nodeId: siblingId, workspace: readText(sibling.workspace), runtime, source: 'member_push', observedAt: runtimeObservedAt, daemonId: siblingDaemonId,
                });
                factsChanged = factsChanged || siblingRecorded.factsChanged;
                sessionsChanged = sessionsChanged || siblingRecorded.sessionsChanged;
                instanceChanged = instanceChanged || siblingRecorded.instanceChanged;
                if (siblingRecorded.factsChanged && siblingRecorded.entry?.runtime?.nodeFacts) heal(siblingId, siblingRecorded.entry.runtime.nodeFacts);
            }
        }
        // Signature-only runtime: renew the held summary's age when it matches — for
        // every node of that daemon, like a full report — else ask for the summary.
        let runtimeHeld: boolean | undefined;
        if (runtimeSignature) {
            const runtimeObservedAt = typeof args?.runtimeObservedAt === 'number' && Number.isFinite(args.runtimeObservedAt)
                ? args.runtimeObservedAt
                : undefined;
            runtimeHeld = ctx.meshNodeGitState.confirmRuntime(meshId, nodeId, runtimeSignature, runtimeObservedAt);
            const ownerDaemonId = readMeshNodeDaemonId(resolved.node) ?? '';
            if (runtimeHeld && ownerDaemonId) {
                for (const sibling of Array.isArray(resolved.mesh.nodes) ? resolved.mesh.nodes : []) {
                    if (!sibling || sibling === resolved.node || meshNodeIdMatches(sibling, nodeId)) continue;
                    const siblingDaemonId = readMeshNodeDaemonId(sibling) ?? '';
                    const siblingId = readText(sibling.id);
                    if (!siblingId || !siblingDaemonId || !daemonIdsEquivalent(siblingDaemonId, ownerDaemonId)) continue;
                    ctx.meshNodeGitState.confirmRuntime(meshId, siblingId, runtimeSignature, runtimeObservedAt);
                }
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
        // Anything a viewer sees change — git content, or any held-runtime change
        // (session status, facts / provider catalog, a launch / terminate, a
        // restarted / upgraded daemon) — flushes the mesh's mesh.status
        // subscribers. That lane is keyed per node, so it carries only this
        // node's changed fields; a confirming (signature-only) heartbeat changes
        // nothing and sends nothing.
        if (changed) ctx.invalidateAggregateMeshStatus(meshId);
        else if (runtimeChanged || factsChanged || sessionsChanged || instanceChanged) ctx.deps.onMeshStateChange?.(meshId);
        return {
            success: true,
            accepted: true,
            changed,
            ...(runtime ? { runtimeChanged } : {}),
            ...(runtimeHeld !== undefined ? { runtimeHeld } : {}),
            ...(gitHeld !== undefined ? { gitHeld } : {}),
            ...(ctx.meshCoordinatorBootId ? { coordinatorBootId: ctx.meshCoordinatorBootId } : {}),
            ...(reconciliation ?? {}),
        };
    },

    mesh_node_state_nudge: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readText(args?.meshId);
        const nodeId = readText(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const coordinatorDaemonId = readMeshSender(args);
        // Keyed by the SENDER: a peer can only nudge (or subscribe) pushes to itself.
        const subscribed = !!coordinatorDaemonId
            && ctx.meshNodeStatePusher?.nudge(coordinatorDaemonId, meshId, nodeId, readText(args?.workspace)) === true;
        return { success: true, subscribed };
    },

    mesh_node_git_log: async (ctx: HighFamilyContext, args: any) => {
        const meshId = readText(args?.meshId);
        const nodeId = readText(args?.nodeId);
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const limit = typeof args?.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(50, Math.floor(args.limit)))
            : 5;
        const resolved = await resolveMeshNode(ctx, meshId, nodeId);
        if (!resolved.ok) return resolved.result;
        const workspace = readText(resolved.node.workspace);
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
