/**
 * RF-ROUTER MED family — mesh CRUD + node CRUD commands.
 *
 * Mesh records (list/get/create/update/delete_mesh) and node lifecycle
 * (add/update/remove/clone_mesh_node, cleanup_mesh_sessions,
 * retry_mesh_node_bootstrap). get_mesh hydrates direct git truth; the mutating
 * node commands gate on the Mesh Host owner check and bust the aggregate-status
 * cache; clone/remove/retry forward to the owning daemon for remote worktrees.
 * Extracted verbatim from executeDaemonCommand; the inline-cache, session/worktree
 * cleanup and aggregate-status collaborators come from ctx.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus, normalizeMeshDaemonRole } from '../../mesh/mesh-host-ownership.js';
import {
    loadMeshWorktreeBootstrapConfig,
    runMeshWorktreeBootstrap,
    type WorktreeBootstrapState,
} from '../../mesh/worktree-bootstrap-config.js';
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../../mesh/mesh-events.js';
import { loadConfig } from '../../config/config.js';
import {
    hydrateInlineMeshDirectTruth,
    normalizeProviderRoles,
    readMeshNodeMachineId,
} from '../router.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

export const meshCrudHandlers: Record<string, MedFamilyHandler> = {
    list_meshes: async (_ctx: MedFamilyContext, _args: any) => {
        try {
            const { listMeshes } = await import('../../config/mesh-config.js');
            return { success: true, meshes: listMeshes() };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    get_mesh: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        if (!meshRecord?.mesh) return { success: false, error: 'Mesh not found' };

        const requireDirectPeerTruth = args?.requireDirectPeerTruth === true;
        // Only an explicit refresh fans out a blocking peer probe.
        // Default loads are satisfied from held standing-state git truth.
        const probeRemotePeers = args?.refresh === true || args?.forceRefresh === true;
        const directTruth = await hydrateInlineMeshDirectTruth({
            mesh: meshRecord.mesh,
            meshSource: meshRecord.source,
            dispatchMeshCommand: ctx.deps.dispatchMeshCommand,
            getMeshPeerConnectionStatus: ctx.deps.getMeshPeerConnectionStatus,
            statusInstanceId: ctx.deps.statusInstanceId,
            localMachineId: loadConfig().machineId || '',
            probeRemotePeers,
            probeCache: ctx.meshGitProbeCache,
        });
        const directTruthSatisfied = meshRecord.source !== 'inline_bootstrap' || directTruth.directEvidenceCount > 0;
        const sourceOfTruth = {
            membership: meshRecord.source === 'inline_cache'
                ? 'coordinator_inline_mesh_cache'
                : meshRecord.source === 'local_config'
                    ? 'local_mesh_config'
                    : 'inline_bootstrap_snapshot',
            coordinatorOwnsLiveTruth: directTruthSatisfied,
            directPeerTruth: {
                required: requireDirectPeerTruth,
                satisfied: directTruthSatisfied,
                directEvidenceCount: directTruth.directEvidenceCount,
                localConfirmedCount: directTruth.localConfirmedCount,
                peerAttemptedCount: directTruth.peerAttemptedCount,
                peerConfirmedCount: directTruth.peerConfirmedCount,
                unavailableNodeIds: directTruth.unavailableNodeIds,
            },
        };
        if (requireDirectPeerTruth && !directTruthSatisfied) {
            return {
                success: false,
                code: 'mesh_direct_peer_truth_unavailable',
                error: 'Selected coordinator could not confirm direct mesh truth yet. Bootstrap inventory stays unavailable until direct get_mesh probes succeed.',
                sourceOfTruth,
            };
        }
        return { success: true, mesh: meshRecord.mesh, sourceOfTruth };
    },

    create_mesh: async (_ctx: MedFamilyContext, args: any) => {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        const repoIdentity = typeof args?.repoIdentity === 'string' ? args.repoIdentity.trim() : '';
        const repoRemoteUrl = typeof args?.repoRemoteUrl === 'string' ? args.repoRemoteUrl.trim() : undefined;
        const defaultBranch = typeof args?.defaultBranch === 'string' ? args.defaultBranch.trim() : undefined;
        if (!name) return { success: false, error: 'name required' };
        try {
            const { createMesh } = await import('../../config/mesh-config.js');
            const meshHost = args?.meshHost && typeof args.meshHost === 'object' && !Array.isArray(args.meshHost)
                ? args.meshHost
                : undefined;
            const mesh = createMesh({ name, repoIdentity, repoRemoteUrl, defaultBranch, policy: args?.policy, meshHost });
            return { success: true, mesh };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    update_mesh: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { updateMesh } = await import('../../config/mesh-config.js');
            const patch: Record<string, unknown> = {};
            if (typeof args?.name === 'string') patch.name = args.name;
            if (typeof args?.defaultBranch === 'string') patch.defaultBranch = args.defaultBranch;
            if (args?.policy && typeof args.policy === 'object' && !Array.isArray(args.policy)) patch.policy = args.policy;
            if (args?.coordinator && typeof args.coordinator === 'object' && !Array.isArray(args.coordinator)) patch.coordinator = args.coordinator;
            if (args?.meshHost && typeof args.meshHost === 'object' && !Array.isArray(args.meshHost)) patch.meshHost = args.meshHost;
            if (!Object.keys(patch).length) return { success: false, error: 'No updates provided' };
            const mesh = updateMesh(meshId, patch as any);
            if (!mesh) return { success: false, error: 'Mesh not found' };
            ctx.inlineMeshCache.set(meshId, mesh);
            ctx.invalidateAggregateMeshStatus(meshId);
            return { success: true, mesh };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    delete_mesh: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { deleteMesh } = await import('../../config/mesh-config.js');
            const deleted = deleteMesh(meshId);
            return { success: true, deleted };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    add_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!workspace) return { success: false, error: 'workspace required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node addition');
        if (ownerFailure) return ownerFailure;
        try {
            const { addNode } = await import('../../config/mesh-config.js');
            const providerPriority = Array.isArray(args?.providerPriority)
                ? args.providerPriority.map((type: any) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
                : [];
            const readOnly = args?.readOnly === true;
            const providerRoles = normalizeProviderRoles(args?.providerRoles);
            const policy = {
                ...(readOnly ? { readOnly: true } : {}),
                ...(providerPriority.length ? { providerPriority } : {}),
                ...(providerRoles.length ? { providerRoles } : {}),
            };
            const role = normalizeMeshDaemonRole(args?.role);
            const daemonId = typeof args?.daemonId === 'string' && args.daemonId.trim() ? args.daemonId.trim() : undefined;
            const machineId = typeof args?.machineId === 'string' && args.machineId.trim() ? args.machineId.trim() : undefined;
            const repoRoot = typeof args?.repoRoot === 'string' && args.repoRoot.trim() ? args.repoRoot.trim() : undefined;
            const node = addNode(meshId, {
                workspace,
                ...(repoRoot ? { repoRoot } : {}),
                ...(daemonId ? { daemonId } : {}),
                ...(machineId ? { machineId } : {}),
                ...(policy ? { policy } : {}),
                ...(role ? { role } : {}),
            });
            if (!node) return { success: false, error: 'Mesh not found' };
            // mesh_status hands back a coordinator-memory aggregate
            // snapshot keyed on (meshId, queueRevision). Adding a
            // node touches neither, so without an explicit cache
            // bust the dashboard graph keeps rendering the pre-add
            // node list (empty for a fresh mesh) even after the
            // user clicks Refresh.
            ctx.invalidateAggregateMeshStatus(meshId);
            return { success: true, node };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    update_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node update');
        if (ownerFailure) return ownerFailure;
        try {
            const { updateNode } = await import('../../config/mesh-config.js');
            const policy = args?.policy && typeof args.policy === 'object' && !Array.isArray(args.policy)
                ? { ...(args.policy as Record<string, unknown>) }
                : {};
            if (Array.isArray(args?.providerPriority)) {
                const providerPriority = args.providerPriority
                    .map((type: any) => typeof type === 'string' ? type.trim() : '')
                    .filter(Boolean);
                delete (policy as any).provider_priority;
                if (providerPriority.length) {
                    (policy as any).providerPriority = providerPriority;
                } else {
                    delete (policy as any).providerPriority;
                }
            }
            // providerRoles: per-(node, provider) role label + maxParallel cap.
            // Passing an explicit (possibly empty) array clears/replaces the
            // declarations; omitting the arg leaves any value already on policy
            // untouched (a full policy object passed by the caller still carries it).
            if (Array.isArray(args?.providerRoles)) {
                const providerRoles = normalizeProviderRoles(args.providerRoles);
                if (providerRoles.length) {
                    (policy as any).providerRoles = providerRoles;
                } else {
                    delete (policy as any).providerRoles;
                }
            }
            const patch: Record<string, unknown> = { policy: policy as any };
            if (typeof args?.systemPrompt === 'string') {
                const trimmed = (args.systemPrompt as string).trim();
                patch.systemPrompt = trimmed || undefined;
            } else if (args?.systemPrompt === null) {
                patch.systemPrompt = undefined;
            }
            const node = updateNode(meshId, nodeId, patch as any);
            if (!node) return { success: false, error: 'Mesh node not found' };
            // Provider priority / systemPrompt changes don't touch
            // the queue revision, so without a manual bust the
            // cached aggregate keeps surfacing pre-update values
            // (priority chip, coordinator prompt preview, etc.).
            ctx.invalidateAggregateMeshStatus(meshId);
            return { success: true, node };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    cleanup_mesh_sessions: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node removal');
        if (ownerFailure) return ownerFailure;
        try {
            // preferInline so inline-cache-only clone nodes resolve (matches owner check above).
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            if (!mesh) return { success: false, error: 'Mesh not found' };
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
            const mode = ctx.normalizeMeshSessionCleanupMode(args?.mode ?? mesh?.policy?.sessionCleanupOnNodeRemove);
            const sessionIds = Array.isArray(args?.sessionIds)
                ? args.sessionIds.map((id: any) => typeof id === 'string' ? id.trim() : '').filter(Boolean)
                : undefined;
            const result = await ctx.cleanupMeshSessions({
                meshId,
                nodeId,
                node,
                mode,
                sessionIds,
                dryRun: args?.dryRun === true,
                source: 'mesh_cleanup_sessions',
            });
            return result;
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    remove_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
        try {
            // preferInline so removal can resolve inline-cache-only clone worktree nodes.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));

            // Guard: refuse to remove the coordinator's OWN local base node
            // (same machine, NOT a worktree). Removing it breaks live mesh
            // membership — the coordinator can no longer be reached and has
            // to be restarted. Worktree clones are always safe to remove;
            // only the non-worktree node bound to this daemon is protected.
            // An explicit force:true overrides for intentional mesh teardown.
            if (node && !args?._meshDirectDispatch && node.isLocalWorktree !== true && args?.force !== true) {
                const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : '';
                const nodeMachineId = readMeshNodeMachineId(node as Record<string, unknown>) || '';
                const selfDaemonId = ctx.deps.statusInstanceId || '';
                const selfMachineId = (() => { try { return loadConfig().machineId || ''; } catch { return ''; } })();
                // Identity match is form-safe: a daemon answers to the same machine
                // under interchangeable id forms (bare `mach_X`, cloud `daemon_mach_X`,
                // standalone `standalone_mach_X`). statusInstanceId/loadConfig().machineId
                // and the node's stored daemonId/machineId frequently hold DIFFERENT forms
                // of the same machine, so a raw `===` would miss the self-match and let the
                // coordinator delete its own live base node (the very accident this guard
                // exists to prevent). daemonIdsEquivalent collapses every form to its
                // machine core before comparing, so a same-machine match is caught
                // regardless of which form each side carries. This only widens matches
                // (every raw-`===` hit still matches) — fail-open → fail-closed.
                const isCoordinatorBaseNode =
                    (!!selfDaemonId && (daemonIdsEquivalent(nodeDaemonId, selfDaemonId) || daemonIdsEquivalent(nodeMachineId, selfDaemonId)))
                    || (!!selfMachineId && (daemonIdsEquivalent(nodeDaemonId, selfMachineId) || daemonIdsEquivalent(nodeMachineId, selfMachineId)));
                if (isCoordinatorBaseNode) {
                    return {
                        success: false,
                        removed: false,
                        code: 'mesh_remove_coordinator_base_node_protected',
                        error: `Refusing to remove the coordinator's own base node '${typeof node.workspace === 'string' ? node.workspace : nodeId}'. `
                            + `It is the local non-worktree node bound to this coordinator daemon; removing it breaks live mesh membership and forces a restart.`,
                        recoveryHint: 'Remove worktree clone nodes instead, or pass force:true only if you are intentionally tearing down this mesh and accept that the coordinator must be re-registered/restarted.',
                    };
                }
            }

            const sessionCleanupMode = ctx.normalizeMeshSessionCleanupMode(
                args?.sessionCleanupMode ?? args?.session_cleanup_mode ?? mesh?.policy?.sessionCleanupOnNodeRemove,
            );
            // Explicit sessionIds (e.g. supplied by refine auto-cleanup) bypass the
            // workspace-only-match guard so a delegate session that lacks a
            // meta.meshNodeId binding can still be stopped/deleted.
            const explicitSessionIds = Array.isArray(args?.sessionIds)
                ? (args.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
                : undefined;
            let sessionCleanup: Record<string, unknown> | undefined;
            if (node && sessionCleanupMode !== 'preserve') {
                sessionCleanup = await ctx.cleanupMeshSessions({
                    meshId,
                    nodeId,
                    node,
                    mode: sessionCleanupMode,
                    ...(explicitSessionIds && explicitSessionIds.length > 0 ? { sessionIds: explicitSessionIds } : {}),
                    source: 'mesh_remove_node',
                });
                if (sessionCleanup.success === false) return { success: false, removed: false, sessionCleanup };
            }

            let worktreeCleanup: Record<string, unknown> | undefined;
            if (node?.isLocalWorktree) {
                const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : undefined;
                // daemonIdsEquivalent: an equivalent-form daemonId is this machine —
                // clean up locally, do not forward. Equivalent → local.
                const isRemoteWorktree = nodeDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.deps.statusInstanceId) && ctx.deps.dispatchMeshCommand
                    && !args?._meshDirectDispatch;
                if (isRemoteWorktree) {
                    // Worktree lives on a different machine — ask that daemon to clean it up.
                    // _meshDirectDispatch prevents re-forwarding when stored daemonId uses legacy format.
                    const forwarded = await ctx.deps.dispatchMeshCommand!(nodeDaemonId!, 'remove_mesh_node', {
                        ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                        _meshDirectDispatch: true,
                    });
                    return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                }
                const cleanupResult = await ctx.cleanupLocalWorktreeNode({ mesh, node, nodeId, force: args?.force === true });
                // De-gating: membership removal is NOT gated on the worktree
                // directory actually being deleted. cleanupLocalWorktreeNode now
                // returns success:true (with a residue flag) whenever the path is
                // proven managed and the only remaining problem is leftover
                // directory bytes (e.g. Windows EINVAL). A success:false here means
                // a genuinely-unsafe condition — missing metadata, a non-managed /
                // unexpected path, a branch mismatch, a dirty worktree, or an
                // unverified force fallback — and those still block removal.
                if (cleanupResult.success === false) {
                    return {
                        success: false,
                        removed: false,
                        code: cleanupResult.code,
                        error: cleanupResult.error,
                        recoveryHint: cleanupResult.recoveryHint,
                        ...(sessionCleanup ? { sessionCleanup } : {}),
                        worktreeCleanup: cleanupResult,
                    };
                }
                worktreeCleanup = cleanupResult;
            }

            let removed = false;
            if (meshRecord?.inline) {
                removed = ctx.removeInlineMeshNode(meshId, mesh, nodeId);
                // Inline meshes share the same aggregate snapshot cache as
                // local-config meshes; without this bust the removed node
                // keeps showing up in the dashboard graph until the cache
                // ages out on its own.
                if (removed) ctx.invalidateAggregateMeshStatus(meshId);
                // Node was already absent from the inline mesh (e.g. removed by a
                // prior refine cleanup). Treat as removed so caller gets removed:true.
                if (!removed && !node) removed = true;
            } else {
                const { removeNode } = await import('../../config/mesh-config.js');
                removed = removeNode(meshId, nodeId);
                // Node already absent from config (e.g. removed by a prior refine
                // cleanup after a successful Refinery merge). Treat as removed so
                // the response is accurate.
                if (!removed && !node) removed = true;
                if (removed) ctx.invalidateAggregateMeshStatus(meshId);
            }

            // Record in task ledger
            if (removed) {
                try {
                    const { appendLedgerEntry } = await import('../../mesh/mesh-ledger.js');
                    appendLedgerEntry(meshId, {
                        kind: 'node_removed',
                        nodeId,
                        payload: {
                            worktree: !!node?.isLocalWorktree,
                            sessionCleanupMode,
                            workspace: typeof node?.workspace === 'string' ? node.workspace : undefined,
                            daemonId: typeof node?.daemonId === 'string' ? node.daemonId : undefined,
                            worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                            worktreeCleanupFallback: typeof worktreeCleanup?.fallback === 'string' ? worktreeCleanup.fallback : undefined,
                            forced: worktreeCleanup?.forced === true ? true : undefined,
                            forceFallbackReason: typeof worktreeCleanup?.reason === 'string' ? worktreeCleanup.reason : undefined,
                        },
                    });
                } catch { /* ledger append is best-effort */ }
            }

            // Surface leftover-directory residue at the top level so callers
            // see the node was dropped from the mesh even though the worktree
            // directory could not be fully removed (best-effort, non-gating).
            const residueWarning = worktreeCleanup?.residue === true && typeof worktreeCleanup?.residueWarning === 'string'
                ? worktreeCleanup.residueWarning
                : undefined;
            return {
                success: true,
                removed,
                ...(residueWarning ? { residueWarning } : {}),
                ...(sessionCleanup ? { sessionCleanup } : {}),
                ...(worktreeCleanup ? { worktreeCleanup } : {}),
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    clone_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const sourceNodeId = typeof args?.sourceNodeId === 'string' ? args.sourceNodeId.trim() : '';
        const branch = typeof args?.branch === 'string' ? args.branch.trim() : '';
        const baseBranch = typeof args?.baseBranch === 'string' ? args.baseBranch.trim() : undefined;
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!sourceNodeId) return { success: false, error: 'sourceNodeId required' };
        if (!branch) return { success: false, error: 'branch required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'worktree clone');
        if (ownerFailure) return ownerFailure;

        try {
            // Resolve with preferInline so the clone writes the new node into the
            // same representation that get_mesh reads back. The MCP coordinator
            // passes inlineMesh on every mesh command, so when it owns an inline
            // mesh the membership read path (get_mesh, preferInline: true) returns
            // the inline cache. Without preferInline here, clone could resolve to a
            // local-config mesh and write the node only to config — leaving the
            // inline cache (and therefore get_mesh / refreshMeshFromDaemon) without
            // the node, so the new worktree node is never visible in live mesh
            // membership even though worktree_bootstrap_complete fires.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            if (!mesh) return { success: false, error: 'Mesh not found' };

            const sourceNode = mesh.nodes?.find((n: any) => meshNodeIdMatches(n, sourceNodeId));
            if (!sourceNode) return { success: false, error: `Source node '${sourceNodeId}' not found in mesh` };

            // Forward to the source node's daemon if it's on a different machine.
            // _meshDirectDispatch prevents infinite re-forwarding when the stored daemonId
            // uses a legacy format that doesn't match the receiving daemon's statusInstanceId.
            const sourceDaemonId = typeof sourceNode.daemonId === 'string' ? sourceNode.daemonId.trim() : undefined;
            // daemonIdsEquivalent: an equivalent-form source daemonId is this machine —
            // clone locally, do not forward. Equivalent → local.
            if (sourceDaemonId && !daemonIdsEquivalent(sourceDaemonId, ctx.deps.statusInstanceId) && ctx.deps.dispatchMeshCommand
                && !args?._meshDirectDispatch) {
                const forwarded = await ctx.deps.dispatchMeshCommand(sourceDaemonId, 'clone_mesh_node', {
                    ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                    _meshDirectDispatch: true,
                });
                return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
            }

            const repoRoot = sourceNode.repoRoot || sourceNode.workspace;
            const { createWorktree } = await import('../../git/git-worktree.js');
            const result = await createWorktree({
                repoRoot,
                branch,
                baseBranch,
                meshName: mesh.name,
            });

            let node: any;
            if (meshRecord.inline) {
                const { randomUUID } = await import('crypto');
                node = {
                    id: `node_${randomUUID().replace(/-/g, '')}`,
                    workspace: result.worktreePath,
                    repoRoot: result.worktreePath,
                    daemonId: sourceNode.daemonId,
                    machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                    userOverrides: { ...(sourceNode.userOverrides || {}) },
                    policy: { ...(sourceNode.policy || {}) },
                    isLocalWorktree: true,
                    worktreeBranch: result.branch,
                    clonedFromNodeId: sourceNodeId,
                };
                ctx.updateInlineMeshNode(meshId, mesh, node);
            } else {
                const { addNode } = await import('../../config/mesh-config.js');
                node = addNode(meshId, {
                    workspace: result.worktreePath,
                    repoRoot: result.worktreePath,
                    daemonId: sourceNode.daemonId,
                    machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                    userOverrides: { ...(sourceNode.userOverrides || {}) },
                    isLocalWorktree: true,
                    worktreeBranch: result.branch,
                    clonedFromNodeId: sourceNodeId,
                    policy: { ...(sourceNode.policy || {}) },
                });
                if (!node) return { success: false, error: 'Failed to register worktree node' };
                // Also reconcile the freshly-registered node into any warmed inline
                // cache for this mesh. get_mesh (preferInline: true) reads the inline
                // cache first when one exists; if we only wrote to local config the
                // node would be invisible to membership reads. updateInlineMeshNode is
                // a no-op when no inline cache is present.
                const inlineForReconcile = ctx.getCachedInlineMesh(meshId);
                if (inlineForReconcile) ctx.updateInlineMeshNode(meshId, inlineForReconcile, node);
                ctx.invalidateAggregateMeshStatus(meshId);
            }

            const persistWorktreeSetupState = async (bootstrapState: WorktreeBootstrapState): Promise<void> => {
                node.worktreeBootstrap = bootstrapState;
                if (meshRecord.inline) {
                    ctx.updateInlineMeshNode(meshId, mesh, node);
                    return;
                }
                try {
                    const { updateNode } = await import('../../config/mesh-config.js');
                    updateNode(meshId, node.id, { worktreeBootstrap: bootstrapState });
                    ctx.invalidateAggregateMeshStatus(meshId);
                } catch { /* bootstrap status persistence is best-effort */ }
            };

            const appendCloneLedger = async (initSubmodules: boolean, bootstrapState: WorktreeBootstrapState): Promise<void> => {
                try {
                    const { appendLedgerEntry } = await import('../../mesh/mesh-ledger.js');
                    appendLedgerEntry(meshId, {
                        kind: 'node_cloned',
                        nodeId: node.id,
                        payload: {
                            sourceNodeId,
                            branch: result.branch,
                            worktreePath: result.worktreePath,
                            submodulesInitialized: initSubmodules,
                            worktreeBootstrap: {
                                status: bootstrapState.status,
                                required: bootstrapState.required,
                                configSource: bootstrapState.configSource,
                                configSourceType: bootstrapState.configSourceType,
                                lastCommand: bootstrapState.lastCommand,
                                exitCode: bootstrapState.exitCode,
                            },
                        },
                    });
                } catch { /* ledger append is best-effort */ }
            };

            const initSubmodules = (sourceNode.policy as any)?.initSubmodulesOnClone !== false;
            const loadedBootstrap = loadMeshWorktreeBootstrapConfig(mesh, result.worktreePath);
            const runningBootstrapState: WorktreeBootstrapState = {
                status: 'running',
                required: loadedBootstrap.config?.required !== false,
                configSource: loadedBootstrap.path || loadedBootstrap.source,
                configSourceType: loadedBootstrap.sourceType,
                startedAt: new Date().toISOString(),
            };
            await persistWorktreeSetupState(runningBootstrapState);

            const finishWorktreeSetup = async (): Promise<{ submodulesInitialized: boolean; bootstrapState: WorktreeBootstrapState }> => {
                let submodulesInitialized = false;
                if (initSubmodules) {
                    try {
                        const { runGit } = await import('../../git/git-executor.js');
                        await runGit(
                            { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
                            ['submodule', 'update', '--init', '--recursive'],
                            { timeoutMs: 120000 },
                        );
                        submodulesInitialized = true;

                        // Sync oss submodule to source node HEAD (best-effort)
                        const sourceWorkspace = sourceNode.repoRoot || sourceNode.workspace;
                        if (sourceWorkspace) {
                            try {
                                const { runGit: rg } = await import('../../git/git-executor.js');
                                const sourceCtx = { workspace: sourceWorkspace, repoRoot: sourceWorkspace, isGitRepo: true };
                                const worktreeCtx = { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true };

                                // Read source node's oss submodule SHA
                                const sourceStatusOut = await rg(sourceCtx, ['submodule', 'status', 'oss'], { timeoutMs: 10000 });
                                const sourceStatusLine = (typeof sourceStatusOut === 'string' ? sourceStatusOut : (sourceStatusOut as any)?.stdout ?? '').trim();
                                const sourceShaMatch = sourceStatusLine.match(/^[+\- ]?([0-9a-f]{40})/);
                                const sourceSha = sourceShaMatch?.[1];

                                if (sourceSha) {
                                    // Read worktree's current oss HEAD
                                    const ossCtx = { workspace: `${result.worktreePath}/oss`, repoRoot: `${result.worktreePath}/oss`, isGitRepo: true };
                                    const worktreeOssHeadOut = await rg(ossCtx, ['rev-parse', 'HEAD'], { timeoutMs: 10000 });
                                    const worktreeOssSha = (typeof worktreeOssHeadOut === 'string' ? worktreeOssHeadOut : (worktreeOssHeadOut as any)?.stdout ?? '').trim();

                                    if (worktreeOssSha !== sourceSha) {
                                        // Fetch target SHA from source node's oss directory
                                        await rg(ossCtx, ['fetch', `${sourceWorkspace}/oss`, 'HEAD'], { timeoutMs: 60000 });
                                        await rg(ossCtx, ['checkout', sourceSha], { timeoutMs: 10000 });
                                        await rg(worktreeCtx, ['add', 'oss'], { timeoutMs: 10000 });
                                        await rg(worktreeCtx, ['commit', '-m', 'chore: sync oss to source node HEAD on clone'], { timeoutMs: 10000 });
                                        console.log(`[mesh] Synced oss submodule to source HEAD ${sourceSha.slice(0, 8)} in worktree`);
                                    }
                                }
                            } catch (ossErr: any) {
                                console.warn('[mesh] oss submodule sync to source HEAD failed (best-effort):', ossErr.message);
                            }
                        }
                    } catch (subErr: any) {
                        // Submodule init is best-effort; don't fail the clone
                        console.warn('[mesh] Submodule init failed for worktree:', subErr.message);
                    }
                }
                const bootstrapState: WorktreeBootstrapState = await runMeshWorktreeBootstrap(mesh, result.worktreePath);
                await persistWorktreeSetupState(bootstrapState);
                await appendCloneLedger(submodulesInitialized, bootstrapState);
                return { submodulesInitialized, bootstrapState };
            };

            const requestedSetupWaitMs = Number(args?.setupWaitMs ?? args?.bootstrapWaitMs ?? 8000);
            const setupWaitMs = Number.isFinite(requestedSetupWaitMs)
                ? Math.min(Math.max(requestedSetupWaitMs, 0), 14000)
                : 8000;
            const setupPromise = finishWorktreeSetup();
            const setupResult = await Promise.race([
                setupPromise.then((value) => ({ completed: true as const, value })),
                new Promise<{ completed: false }>((resolve) => setTimeout(() => resolve({ completed: false }), setupWaitMs)),
            ]);

            const emitBootstrapEvent = (eventStatus: 'bootstrap_complete' | 'bootstrap_failed', bootstrapState: WorktreeBootstrapState, startedAtMs: number, extraPayload?: Record<string, unknown>): void => {
                try {
                    const durationMs = Date.now() - startedAtMs;
                    const event = `worktree_${eventStatus}` as const;
                    const metadataEvent = {
                        source: 'clone_mesh_node_bootstrap',
                        nodeId: node.id,
                        status: eventStatus,
                        worktreePath: result.worktreePath,
                        durationMs,
                        bootstrapStatus: bootstrapState.status,
                        ...(bootstrapState.error ? { error: bootstrapState.error } : {}),
                        ...(bootstrapState.exitCode !== undefined ? { exitCode: bootstrapState.exitCode } : {}),
                        ...(extraPayload || {}),
                    };
                    if (typeof ctx.deps.instanceManager?.getByCategory === 'function') {
                        const forwarded = handleMeshForwardEvent(
                            { instanceManager: ctx.deps.instanceManager } as any,
                            { event, meshId, nodeId: node.id, workspace: result.worktreePath, metadataEvent },
                        );
                        if (forwarded?.success === true) return;
                    }
                    queuePendingMeshCoordinatorEvent({
                        event,
                        meshId,
                        nodeLabel: node.id,
                        nodeId: node.id,
                        workspace: result.worktreePath,
                        metadataEvent,
                        queuedAt: Date.now(),
                    });
                } catch { /* event emission is best-effort */ }
            };

            const bootstrapStartedMs = Date.now();

            if (!setupResult.completed) {
                setupPromise
                    .then(({ bootstrapState }) => {
                        emitBootstrapEvent('bootstrap_complete', bootstrapState, bootstrapStartedMs);
                    })
                    .catch((error: any) => {
                        const failedState: WorktreeBootstrapState = {
                            ...runningBootstrapState,
                            status: 'failed',
                            completedAt: new Date().toISOString(),
                            error: error?.message || String(error),
                        };
                        void persistWorktreeSetupState(failedState);
                        void appendCloneLedger(false, failedState);
                        emitBootstrapEvent('bootstrap_failed', failedState, bootstrapStartedMs, { error: error?.message || String(error) });
                    });
                return {
                    success: true,
                    async: true,
                    status: 'accepted',
                    node,
                    worktreePath: result.worktreePath,
                    branch: result.branch,
                    worktreeBootstrap: runningBootstrapState,
                    worktreeSetup: {
                        status: 'running',
                        setupWaitMs,
                        message: 'Worktree node is registered; submodule/bootstrap setup is continuing in the background.',
                    },
                };
            }

            const { submodulesInitialized, bootstrapState } = setupResult.value;
            emitBootstrapEvent('bootstrap_complete', bootstrapState, bootstrapStartedMs);
            return {
                success: true,
                node,
                worktreePath: result.worktreePath,
                branch: result.branch,
                submodulesInitialized,
                worktreeBootstrap: bootstrapState,
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    retry_mesh_node_bootstrap: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!nodeId) return { success: false, error: 'nodeId required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'bootstrap retry');
        if (ownerFailure) return ownerFailure;

        try {
            // preferInline so bootstrap-retry can resolve inline-cache-only clone worktree nodes.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            if (!mesh) return { success: false, error: 'Mesh not found' };

            const node = mesh.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
            if (!node.isLocalWorktree) return { success: false, error: 'Node is not a local worktree node' };

            // Bootstrap runs scripts in the worktree path — forward to the node's daemon if remote.
            // _meshDirectDispatch prevents re-forwarding when stored daemonId uses legacy format.
            const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : undefined;
            // daemonIdsEquivalent: an equivalent-form daemonId is this machine —
            // bootstrap locally, do not forward. Equivalent → local.
            if (nodeDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.deps.statusInstanceId) && ctx.deps.dispatchMeshCommand
                && !args?._meshDirectDispatch) {
                const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId, 'retry_mesh_node_bootstrap', {
                    ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                    _meshDirectDispatch: true,
                });
                return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
            }

            const currentBootstrap = node.worktreeBootstrap as WorktreeBootstrapState | undefined;
            if (currentBootstrap?.status === 'running') {
                return { success: false, error: 'Bootstrap is already running for this node' };
            }

            const worktreePath: string = node.workspace || node.repoRoot;
            if (!worktreePath) return { success: false, error: 'Node has no workspace path' };

            const loadedBootstrap = loadMeshWorktreeBootstrapConfig(mesh, worktreePath);
            const runningState: WorktreeBootstrapState = {
                status: 'running',
                required: loadedBootstrap.config?.required !== false,
                configSource: loadedBootstrap.path || loadedBootstrap.source,
                configSourceType: loadedBootstrap.sourceType,
                startedAt: new Date().toISOString(),
            };

            const persistState = async (bootstrapState: WorktreeBootstrapState): Promise<void> => {
                node.worktreeBootstrap = bootstrapState;
                if (meshRecord.inline) {
                    ctx.updateInlineMeshNode(meshId, mesh, node);
                    return;
                }
                try {
                    const { updateNode } = await import('../../config/mesh-config.js');
                    updateNode(meshId, node.id, { worktreeBootstrap: bootstrapState });
                    ctx.invalidateAggregateMeshStatus(meshId);
                } catch { /* best-effort */ }
            };

            await persistState(runningState);
            const bootstrapState = await runMeshWorktreeBootstrap(mesh, worktreePath);
            await persistState(bootstrapState);

            return { success: true, bootstrapState };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },
};
