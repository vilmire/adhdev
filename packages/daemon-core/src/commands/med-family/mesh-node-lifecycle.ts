/**
 * RF-ROUTER MED family — mesh node lifecycle: add / update / remove a node and
 * clean up its sessions. The mutating node commands gate on the Mesh Host owner
 * check and bust the aggregate-status cache; remove forwards to the owning daemon
 * for a remote worktree. Split out of mesh-crud.ts (merged into meshCrudHandlers
 * there).
 */
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId, deriveProviderPriorityFromSlots, normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';
import { normalizeMeshDaemonRole } from '../../mesh/mesh-host-ownership.js';
import { getMachineId } from '../../config/config.js';
import { normalizeProviderRoles, readMeshNodeMachineId } from '../router.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { readMeshDirectDispatchFlag, withMeshDirectDispatch } from '../command-args.js';
import { rosterEvidenceExtra } from '../mesh-sender.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';

/**
 * PROVIDER-PRIORITY-FROM-SLOTS write-path sync: slots order = preference
 * (node capability slots design, 2026-07-09), and the read paths already fall back to the
 * slots-derived order (readProviderPriorityFromPolicy). Persist that same order
 * on every node write with slots so the compatibility field cannot drift.
 *
 * Slots are authoritative even when a caller also states providerPriority. For
 * slotless legacy nodes, an explicit providerPriority remains untouched. This
 * helper never invents a priority without slots and never clears a legacy value.
 */
function syncProviderPriorityFromSlots(policy: Record<string, unknown>, slots: unknown = policy.slots): void {
    const derived = deriveProviderPriorityFromSlots(slots);
    if (derived.length) policy.providerPriority = derived;
}

type MeshCommandRecord = Awaited<ReturnType<MedFamilyContext['getMeshForCommand']>>;

/**
 * Refuse to remove the coordinator's OWN local base node (same machine, NOT a
 * worktree): removing it breaks live mesh membership — the coordinator can no
 * longer be reached and has to be restarted. Worktree clones are always safe to
 * remove; an explicit force:true overrides for intentional mesh teardown.
 *
 * Identity match is form-safe: a daemon answers to the same machine under
 * interchangeable id forms (bare `mach_X`, cloud `daemon_mach_X`, standalone
 * `standalone_mach_X`), and statusInstanceId/getMachineId() and the node's stored
 * daemonId/machineId frequently hold DIFFERENT forms, so a raw `===` would miss the
 * self-match. daemonIdsEquivalent collapses every form to its machine core
 * (this only widens matches — fail-open → fail-closed).
 */
function refuseCoordinatorBaseNodeRemoval(ctx: MedFamilyContext, node: any, nodeId: string, args: any): CommandRouterResult | null {
    if (!node || readMeshDirectDispatchFlag(args) || node.isLocalWorktree === true || args?.force === true) return null;
    const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : '';
    const nodeMachineId = readMeshNodeMachineId(node as Record<string, unknown>) || '';
    const selfDaemonId = ctx.deps.statusInstanceId || '';
    const selfMachineId = (() => { try { return getMachineId() || ''; } catch { return ''; } })();
    const isCoordinatorBaseNode =
        (!!selfDaemonId && (daemonIdsEquivalent(nodeDaemonId, selfDaemonId) || daemonIdsEquivalent(nodeMachineId, selfDaemonId)))
        || (!!selfMachineId && (daemonIdsEquivalent(nodeDaemonId, selfMachineId) || daemonIdsEquivalent(nodeMachineId, selfMachineId)));
    if (!isCoordinatorBaseNode) return null;
    return {
        success: false,
        removed: false,
        code: 'mesh_remove_coordinator_base_node_protected',
        error: `Refusing to remove the coordinator's own base node '${typeof node.workspace === 'string' ? node.workspace : nodeId}'. `
            + `It is the local non-worktree node bound to this coordinator daemon; removing it breaks live mesh membership and forces a restart.`,
        recoveryHint: 'Remove worktree clone nodes instead, or pass force:true only if you are intentionally tearing down this mesh and accept that the coordinator must be re-registered/restarted.',
    };
}

/**
 * The owning daemon of a worktree node that lives on a DIFFERENT machine (an
 * equivalent-form daemonId is this machine → undefined, clean up locally).
 * _meshDirectDispatch prevents re-forwarding when the stored daemonId uses a legacy
 * format.
 */
function remoteWorktreeOwner(ctx: MedFamilyContext, node: any, args: any): string | undefined {
    const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : undefined;
    return nodeDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.deps.statusInstanceId) && ctx.deps.dispatchMeshCommand
        && !readMeshDirectDispatchFlag(args)
        ? nodeDaemonId
        : undefined;
}

/**
 * Remove a worktree node's checkout: forwarded to its owning daemon when remote,
 * then the local cleanup. Returns the refusal to answer with, or the cleanup detail.
 */
async function removeNodeWorktree(
    ctx: MedFamilyContext,
    p: { mesh: any; node: any; nodeId: string; args: any; sessionCleanup: Record<string, unknown> | undefined },
): Promise<{ refusal: CommandRouterResult } | { worktreeCleanup?: Record<string, unknown>; remoteForwardedResult?: Record<string, unknown> }> {
    const { mesh, node, nodeId, args } = p;
    let worktreeCleanup: Record<string, unknown> | undefined;
    // Set only when the worktree was removed by its owning remote daemon and this
    // coordinator is reconciling its own membership copy afterwards.
    let remoteForwardedResult: Record<string, unknown> | undefined;
    const remoteOwner = remoteWorktreeOwner(ctx, node, args);
    if (remoteOwner) {
        const forwarded = await ctx.deps.dispatchMeshCommand!(remoteOwner, 'remove_mesh_node', withMeshDirectDispatch(args, rosterEvidenceExtra(args, mesh)));
        const forwardedResult: Record<string, unknown> = unwrapMeshRelayResult(forwarded, { command: 'remove_mesh_node', peerDaemonId: remoteOwner });
        // MESH-REMOTE-REMOVE-MEMBERSHIP-DESYNC: the owning daemon ran this same handler
        // and fixed ITS meshes.json, but this coordinator holds an independent
        // membership record for the same node — so the removal falls through to the
        // shared membership block (never re-instructing the remote daemon). Gated on
        // explicit success: a forwarded failure means the node is still alive on the
        // owning machine, and splicing it out here would hide a node that still exists
        // (the operator loses the handle needed to retry). `removed !== false` mirrors
        // the local path's treatment of an already-absent node as removed.
        const forwardedRemoved = forwardedResult.success === true && forwardedResult.removed !== false;
        if (!forwardedRemoved) return { refusal: forwardedResult as CommandRouterResult };
        remoteForwardedResult = forwardedResult;
        worktreeCleanup = forwardedResult.worktreeCleanup !== null && typeof forwardedResult.worktreeCleanup === 'object'
            ? forwardedResult.worktreeCleanup as Record<string, unknown>
            : undefined;
    }
    const cleanupResult = await ctx.cleanupLocalWorktreeNode({ mesh, node, nodeId, force: args?.force === true });
    // De-gating: membership removal is NOT gated on the worktree directory actually
    // being deleted. cleanupLocalWorktreeNode returns success:true (with a residue
    // flag) whenever the path is proven managed and the only remaining problem is
    // leftover directory bytes (e.g. Windows EINVAL). A success:false means a
    // genuinely-unsafe condition — missing metadata, a non-managed / unexpected path,
    // a branch mismatch, a dirty worktree, or an unverified force fallback.
    if (cleanupResult.success === false) {
        return {
            refusal: {
                success: false,
                removed: false,
                code: cleanupResult.code,
                error: cleanupResult.error,
                recoveryHint: cleanupResult.recoveryHint,
                ...(p.sessionCleanup ? { sessionCleanup: p.sessionCleanup } : {}),
                worktreeCleanup: cleanupResult,
            } as CommandRouterResult,
        };
    }
    worktreeCleanup = cleanupResult;
    return { worktreeCleanup, ...(remoteForwardedResult ? { remoteForwardedResult } : {}) };
}

/** Drop the node from the mesh membership (inline cache and/or meshes.json). */
async function removeNodeMembership(ctx: MedFamilyContext, meshId: string, meshRecord: MeshCommandRecord, mesh: any, node: any, nodeId: string): Promise<boolean> {
    let removed = false;
    if (meshRecord?.inline) {
        removed = ctx.removeInlineMeshNode(meshId, mesh, nodeId);
        // Inline meshes share the same aggregate snapshot cache as local-config meshes;
        // without this bust the removed node keeps showing up in the dashboard graph.
        if (removed) ctx.invalidateAggregateMeshStatus(meshId);
        // MESH-INLINE-NODE-RESURRECTION: removeInlineMeshNode only mutates the
        // in-memory cache + tombstones. A node that ALSO lives in meshes.json would
        // otherwise come back on restart (the tombstone is lost, getMesh falls back to
        // the file config), so it is spliced+saved from the file config too. Pure-inline
        // meshes (no matching file mesh/node) are untouched.
        try {
            const { getMesh, removeNode } = await import('../../config/mesh-config.js');
            const fileMesh = getMesh(meshId);
            const fileNode = fileMesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (fileNode?.id) {
                const fileRemoved = removeNode(meshId, fileNode.id);
                if (fileRemoved) {
                    removed = true;
                    ctx.invalidateAggregateMeshStatus(meshId);
                }
            }
        } catch { /* file config absent / unreadable — inline-only mesh, nothing to durably delete */ }
        // Node was already absent from the inline mesh (e.g. removed by a prior refine
        // cleanup). Treat as removed so caller gets removed:true.
        if (!removed && !node) removed = true;
        return removed;
    }
    const { removeNode } = await import('../../config/mesh-config.js');
    removed = removeNode(meshId, nodeId);
    // Node already absent from config (e.g. removed by a prior refine cleanup after a
    // successful Refinery merge). Treat as removed so the response is accurate.
    if (!removed && !node) removed = true;
    if (removed) {
        ctx.invalidateAggregateMeshStatus(meshId);
        // MESH-MEMBERSHIP-INLINE-CACHE-SYNC: another command may have warmed the inline
        // cache for this meshId from an earlier read — splice the node out of the cached
        // copy too, and tombstone it (even with no warmed cache: a late clone reply or a
        // stale member worktree report racing this removal must not re-register it).
        const cachedMesh = ctx.getCachedInlineMesh(meshId);
        if (cachedMesh) ctx.removeInlineMeshNode(meshId, cachedMesh, nodeId);
        ctx.tombstoneRemovedMeshNode(meshId, nodeId);
    }
    return removed;
}

/**
 * Removal bookkeeping: purge the node's remote_idle_sessions rows, record the
 * worktree directory deletion and the node removal in the ledger. Best-effort.
 */
async function recordNodeRemoval(p: {
    meshId: string; nodeId: string; node: any; removed: boolean; args: any; sessionCleanupMode: string;
    worktreeCleanup: Record<string, unknown> | undefined; remoteForwardedResult: Record<string, unknown> | undefined;
}): Promise<void> {
    const { meshId, nodeId, node, removed, worktreeCleanup, remoteForwardedResult } = p;
    // CLAIM-RETRY-LOOP-LIFECYCLE (M-MESH-INFRA-0829 defect 5, evidence 4): a removed
    // node must not leave a remote_idle_sessions row behind. deleteRemoteIdleSession
    // only ever fires on a SUCCESSFUL claim, so a node removed while its
    // bootstrap/claim was stuck had no path to clear its row — the ~4s auto-launch
    // drain kept matching it against a node that no longer exists.
    if (removed) {
        try {
            const { MeshRuntimeStore } = await import('../../mesh/mesh-runtime-store.js');
            MeshRuntimeStore.getInstance().deleteRemoteIdleSessionsForNode(meshId, nodeId);
        } catch { /* best-effort cleanup */ }
    }
    // WORKTREE-DELETED-WHILE-RUNNING: record the DIRECTORY deletion on its own,
    // independently of membership removal. The worktree directory is deleted EARLIER
    // than the membership removal; if that then fails or no-ops, a directory is
    // destroyed and — without this — the ledger records nothing at all (the
    // 2026-08-16 incident). Emitted only when a directory was actually deleted.
    if (worktreeCleanup && worktreeCleanup.success === true && worktreeCleanup.skipped !== true) {
        try {
            const { meshRecord } = await import('../../mesh/mesh-record.js');
            meshRecord(meshId, 'worktree_directory_removed', {
                nodeId,
                payload: {
                    workspace: typeof worktreeCleanup.removedPath === 'string'
                        ? worktreeCleanup.removedPath
                        : typeof node?.workspace === 'string' ? node.workspace : undefined,
                    worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                    // The key field for attribution: `false` marks the orphaned shape —
                    // directory gone, node still in the mesh.
                    membershipRemoved: removed === true,
                    forced: worktreeCleanup.forced === true ? true : undefined,
                    fallback: typeof worktreeCleanup.fallback === 'string' ? worktreeCleanup.fallback : undefined,
                    reason: typeof worktreeCleanup.reason === 'string' ? worktreeCleanup.reason : undefined,
                    residue: worktreeCleanup.residue === true ? true : undefined,
                    requestedForce: p.args?.force === true ? true : undefined,
                    ...(remoteForwardedResult ? { removedByRemoteDaemon: true } : {}),
                },
            }, { local: true });
        } catch { /* ledger append is best-effort */ }
    }
    if (!removed) return;
    try {
        const { meshRecord } = await import('../../mesh/mesh-record.js');
        meshRecord(meshId, 'node_removed', {
            nodeId,
            payload: {
                worktree: !!node?.isLocalWorktree,
                // Distinguish a removal executed by a remote owning daemon (this entry
                // records only the coordinator-side membership reconciliation).
                ...(remoteForwardedResult ? { removedByRemoteDaemon: true } : {}),
                sessionCleanupMode: p.sessionCleanupMode,
                workspace: typeof node?.workspace === 'string' ? node.workspace : undefined,
                daemonId: typeof node?.daemonId === 'string' ? node.daemonId : undefined,
                worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                worktreeCleanupFallback: typeof worktreeCleanup?.fallback === 'string' ? worktreeCleanup.fallback : undefined,
                forced: worktreeCleanup?.forced === true ? true : undefined,
                forceFallbackReason: typeof worktreeCleanup?.reason === 'string' ? worktreeCleanup.reason : undefined,
                branchRefDeleted: typeof worktreeCleanup?.branchRefDeleted === 'boolean' ? worktreeCleanup.branchRefDeleted : undefined,
                branchRefReason: typeof worktreeCleanup?.branchRefReason === 'string' ? worktreeCleanup.branchRefReason : undefined,
            },
        }, { local: true });
    } catch { /* ledger append is best-effort */ }
}

/** The remove_mesh_node success response. */
function buildRemoveNodeResponse(p: {
    removed: boolean; sessionCleanup: Record<string, unknown> | undefined;
    worktreeCleanup: Record<string, unknown> | undefined; remoteForwardedResult: Record<string, unknown> | undefined;
}): CommandRouterResult {
    const { sessionCleanup, worktreeCleanup } = p;
    // Leftover-directory residue: the node was dropped from the mesh even though the
    // worktree directory could not be fully removed (best-effort, non-gating).
    const residueWarning = worktreeCleanup?.residue === true && typeof worktreeCleanup?.residueWarning === 'string'
        ? worktreeCleanup.residueWarning
        : undefined;
    // Preserved-branch warning: the branch ref was intentionally NOT deleted
    // (unmerged work is never silently dropped).
    const branchRefWarning = typeof worktreeCleanup?.branchRefWarning === 'string'
        ? worktreeCleanup.branchRefWarning
        : undefined;
    // Orphan guard (NODE-REMOVE-SESSION-ORPHAN): a LIVE session the cleanup still
    // skipped survives the removed node — say so, with the manual cleanup to run.
    const skippedLiveSessionIds = Array.isArray(sessionCleanup?.skippedLiveSessionIds)
        ? (sessionCleanup!.skippedLiveSessionIds as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
    const orphanedSessionsRemaining = skippedLiveSessionIds.length > 0;
    const orphanNextAction = orphanedSessionsRemaining
        ? `Live session(s) [${skippedLiveSessionIds.join(', ')}] were skipped and still survive this node removal. `
            + `Run mesh_cleanup_sessions with mode:'stop_and_delete' and sessionIds:[${skippedLiveSessionIds.map(id => `'${id}'`).join(', ')}] to release them.`
        : undefined;
    return {
        // Remote-forwarded removal: start from the owning daemon's own response so its
        // detail fields survive, then overlay this coordinator's membership bookkeeping.
        ...(p.remoteForwardedResult ?? {}),
        success: true,
        removed: p.removed,
        ...(residueWarning ? { residueWarning } : {}),
        ...(branchRefWarning ? { branchRefWarning } : {}),
        ...(sessionCleanup ? { sessionCleanup } : {}),
        ...(worktreeCleanup ? { worktreeCleanup } : {}),
        ...(orphanedSessionsRemaining
            ? { orphanedSessionsRemaining: true, nextAction: orphanNextAction }
            : {}),
    };
}

async function removeMeshNode(ctx: MedFamilyContext, args: any): Promise<CommandRouterResult> {
    const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
    const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
    if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
    try {
        // preferInline so removal can resolve inline-cache-only clone worktree nodes.
        const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));

        const baseRefusal = refuseCoordinatorBaseNodeRemoval(ctx, node, nodeId, args);
        if (baseRefusal) return baseRefusal;

        // Default worktree session cleanup ON: when the caller OMITS a mode and the node
        // is a local worktree, default to 'stop_and_delete' instead of the mesh policy
        // ('preserve' by default) — a worktree's chat session has no reason to outlive
        // the worktree. An explicit mode (including 'preserve') is always honored.
        const explicitCleanupMode = args?.sessionCleanupMode ?? args?.session_cleanup_mode;
        const sessionCleanupMode = ctx.normalizeMeshSessionCleanupMode(
            explicitCleanupMode
            ?? (node?.isLocalWorktree === true ? 'stop_and_delete' : undefined)
            ?? mesh?.policy?.sessionCleanupOnNodeRemove,
        );
        // Explicit sessionIds (e.g. supplied by refine auto-cleanup) bypass the
        // workspace-only-match guard so a delegate session that lacks a
        // meta.meshNodeId binding can still be stopped/deleted.
        const explicitSessionIds = Array.isArray(args?.sessionIds)
            ? (args.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
            : undefined;
        // Precheck-first: for a LOCAL worktree removal, validate removability with a
        // purely non-destructive precheck BEFORE touching the session — the session
        // cleanup below is destructive and irreversible, so a refusal that fired only
        // after it orphaned the delegated session. Remote worktrees are prechecked on
        // the owning daemon (it runs this same handler).
        if (node?.isLocalWorktree && !remoteWorktreeOwner(ctx, node, args)) {
            const precheck = await ctx.precheckLocalWorktreeRemovable({ mesh, node, nodeId, force: args?.force === true });
            if (precheck.ok === false) {
                return {
                    success: false,
                    removed: false,
                    code: precheck.code,
                    error: precheck.error,
                    recoveryHint: precheck.recoveryHint,
                    // No sessionCleanup key: the session was deliberately NOT touched.
                    // worktreeCleanup mirrors the destructive path's refusal shape.
                    worktreeCleanup: { success: false, code: precheck.code, error: precheck.error, recoveryHint: precheck.recoveryHint },
                };
            }
        }

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
        let remoteForwardedResult: Record<string, unknown> | undefined;
        if (node?.isLocalWorktree) {
            const worktree = await removeNodeWorktree(ctx, { mesh, node, nodeId, args, sessionCleanup });
            if ('refusal' in worktree) return worktree.refusal;
            ({ worktreeCleanup, remoteForwardedResult } = worktree);
        }

        const removed = await removeNodeMembership(ctx, meshId, meshRecord, mesh, node, nodeId);
        await recordNodeRemoval({ meshId, nodeId, node, removed, args, sessionCleanupMode, worktreeCleanup, remoteForwardedResult });
        return buildRemoveNodeResponse({ removed, sessionCleanup, worktreeCleanup, remoteForwardedResult });
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export const meshNodeLifecycleHandlers: Record<string, MedFamilyHandler> = {
    add_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!workspace) return { success: false, error: 'workspace required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node addition');
        if (ownerFailure) return ownerFailure;
        try {
            const { addNode } = await import('../../config/mesh-config.js');
            const { migrateProviderRolesToSlots } = await import('../../config/mesh-config-store.js');
            const providerPriority = Array.isArray(args?.providerPriority)
                ? args.providerPriority.map((type: any) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
                : [];
            const readOnly = args?.readOnly === true;
            // Back-compat: an incoming `providerRoles` arg (legacy callers) is folded
            // into `slots[].maxParallel` — the field itself is no longer persisted.
            const providerRoles = normalizeProviderRoles(args?.providerRoles);
            const slots = normalizeNodeCapabilitySlots(args?.slots);
            const policy: Record<string, unknown> = {
                ...(readOnly ? { readOnly: true } : {}),
                ...(providerPriority.length ? { providerPriority } : {}),
                ...(providerRoles.length ? { providerRoles } : {}),
                ...(slots.length ? { slots } : {}),
            };
            if (providerRoles.length) migrateProviderRolesToSlots(policy);
            // Slots are the source of truth. If both inputs are present, persist
            // their derived order; a slotless explicit providerPriority is kept as
            // the legacy creation contract.
            syncProviderPriorityFromSlots(policy);
            const role = normalizeMeshDaemonRole(args?.role);
            const daemonId = typeof args?.daemonId === 'string' && args.daemonId.trim() ? args.daemonId.trim() : undefined;
            const machineId = typeof args?.machineId === 'string' && args.machineId.trim() ? args.machineId.trim() : undefined;
            const repoRoot = typeof args?.repoRoot === 'string' && args.repoRoot.trim() ? args.repoRoot.trim() : undefined;
            const capabilities = Array.isArray(args?.capabilities)
                ? args.capabilities.map((t: any) => typeof t === 'string' ? t.trim() : '').filter(Boolean)
                : undefined;
            const isLocalWorktree = args?.isLocalWorktree === true;
            const node = addNode(meshId, {
                workspace,
                ...(repoRoot ? { repoRoot } : {}),
                ...(daemonId ? { daemonId } : {}),
                ...(machineId ? { machineId } : {}),
                ...(policy ? { policy } : {}),
                ...(role ? { role } : {}),
                ...(isLocalWorktree ? { isLocalWorktree: true } : {}),
                ...(capabilities && capabilities.length ? { capabilities } : {}),
            });
            if (!node) return { success: false, error: 'Mesh not found' };
            // MESH-MEMBERSHIP-INLINE-CACHE-SYNC: addNode() above only wrote the new
            // node to the file-backed meshes.json. getMeshForCommand's inline-cache-
            // preferred read (the default for mesh_status/mesh_list_nodes/get_mesh)
            // resolves this SAME meshId from `inlineMeshCache` whenever a prior
            // command warmed it (e.g. a cloud coordinator launch with inlineMesh —
            // see mesh-coordinator-launch.ts). Without pushing the new node into
            // that cache too, the live view keeps serving the pre-add snapshot until
            // the daemon restarts and the cache is re-emptied. Only touch the cache
            // when it already holds this mesh (nothing to fix for a pure local-config
            // mesh that no caller has ever warmed).
            const cachedMesh = ctx.getCachedInlineMesh(meshId);
            if (cachedMesh) {
                ctx.updateInlineMeshNode(meshId, cachedMesh, node);
            }
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
            const { updateNode, getMesh } = await import('../../config/mesh-config.js');
            const { normalizeCapabilityTags, migrateProviderRolesToSlots } = await import('../../config/mesh-config-store.js');
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
            // Back-compat: a legacy `providerRoles` arg is folded into
            // `slots[].maxParallel` — the per-(node, provider) cap now lives on slots.
            // The field itself is never persisted (migrateProviderRolesToSlots deletes
            // it). A full policy object passed by the caller that still carries
            // providerRoles is likewise migrated.
            if (Array.isArray(args?.providerRoles)) {
                const providerRoles = normalizeProviderRoles(args.providerRoles);
                if (providerRoles.length) (policy as any).providerRoles = providerRoles;
                else delete (policy as any).providerRoles;
            }
            migrateProviderRolesToSlots(policy);
            // Persist the order derived from the node's FINAL slots (the patch's
            // slots when given, else the stored ones). This intentionally repairs a
            // stale compatibility field even when the caller sent one alongside
            // slots. Slotless nodes retain the explicit legacy input semantics.
            const finalSlots = Object.prototype.hasOwnProperty.call(policy, 'slots')
                ? policy.slots
                : (getMesh(meshId)?.nodes.find(n => n.id === nodeId)?.policy as Record<string, unknown> | undefined)?.slots;
            syncProviderPriorityFromSlots(policy, finalSlots);
            const patch: Record<string, unknown> = { policy: policy as any };
            if (typeof args?.systemPrompt === 'string') {
                const trimmed = (args.systemPrompt as string).trim();
                patch.systemPrompt = trimmed || undefined;
            } else if (args?.systemPrompt === null) {
                patch.systemPrompt = undefined;
            }
            // Operator custom capability tags. An explicit (possibly empty) array
            // replaces them; omitting the arg leaves existing tags untouched.
            if (Array.isArray(args?.capabilities)) {
                patch.capabilities = args.capabilities
                    .map((t: any) => typeof t === 'string' ? t.trim() : '')
                    .filter(Boolean);
            }
            const node = updateNode(meshId, nodeId, patch as any);
            if (node) {
                // Provider priority / systemPrompt changes don't touch
                // the queue revision, so without a manual bust the
                // cached aggregate keeps surfacing pre-update values
                // (priority chip, coordinator prompt preview, etc.).
                ctx.invalidateAggregateMeshStatus(meshId);
                return { success: true, node };
            }
            // NODE-SLOTS-REMOTE-WRITE: updateNode reads ONLY this daemon's local
            // meshes.json. When update_mesh_node is forwarded to a node's home-daemon
            // that has no local config entry for a coordinator-owned mesh (a remote
            // member daemon, or a cloud coordinator that holds the mesh solely in its
            // inline cache), updateNode returns undefined and the write failed with
            // "Mesh node not found" — even though the coordinator attached the mesh
            // snapshot as inlineMesh and the read paths (get_mesh / dry-run / list)
            // resolve it fine via getMeshForCommand's inline fallback. Mirror those
            // read paths here: resolve the mesh from the inline cache and apply the
            // same field semantics as updateNode, persisting to the inline cache.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            if (!mesh) return { success: false, error: 'Mesh not found' };
            const inlineNode = Array.isArray(mesh.nodes)
                ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId))
                : undefined;
            if (!inlineNode) return { success: false, error: 'Mesh node not found' };
            // Apply the SAME field semantics updateNode uses so the inline write and a
            // local-config write are indistinguishable: shallow-merge policy, honor an
            // explicit systemPrompt clear, replace/normalize capability tags.
            inlineNode.policy = {
                ...(inlineNode.policy && typeof inlineNode.policy === 'object' && !Array.isArray(inlineNode.policy)
                    ? inlineNode.policy as Record<string, unknown>
                    : {}),
                ...(patch.policy as Record<string, unknown>),
            };
            // Same providerPriority-from-slots sync as the local-config path above,
            // applied after the inline policy merge so existing slots participate.
            syncProviderPriorityFromSlots(inlineNode.policy as Record<string, unknown>);
            if (Object.prototype.hasOwnProperty.call(patch, 'systemPrompt')) {
                const sp = (patch as any).systemPrompt;
                if (typeof sp === 'string' && sp.trim()) inlineNode.systemPrompt = sp;
                else delete inlineNode.systemPrompt;
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'capabilities')) {
                const tags = normalizeCapabilityTags((patch as any).capabilities);
                if (tags && tags.length) inlineNode.capabilities = tags;
                else delete inlineNode.capabilities;
            }
            // updateInlineMeshNode canonicalizes node identity, persists the mutated
            // mesh back to the inline cache, and busts the aggregate-status cache.
            ctx.updateInlineMeshNode(meshId, mesh, inlineNode);
            return { success: true, node: inlineNode };
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
            // Opt-in orphan reclaim (SESSION-ACCUMULATION-LEAK). The live-node id set
            // is the CURRENT mesh membership; a matched live session bound to a node
            // still in this set is an active sibling and is never reclaimed. Only when
            // the caller passes reclaimOrphans:true does the router loosen the
            // shared-daemon guard for workspace-only / dead-node-bound live sessions.
            const reclaimOrphans = args?.reclaimOrphans === true;
            const liveMeshNodeIds = Array.isArray(mesh?.nodes)
                ? mesh.nodes.map((n: any) => normalizeMeshNodeId(n)).filter(Boolean) as string[]
                : [];
            const result = await ctx.cleanupMeshSessions({
                meshId,
                nodeId,
                node,
                mode,
                sessionIds,
                dryRun: args?.dryRun === true,
                source: 'mesh_cleanup_sessions',
                reclaimOrphans,
                liveMeshNodeIds,
            });
            return result;
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    remove_mesh_node: (ctx: MedFamilyContext, args: any) => removeMeshNode(ctx, args),
};
