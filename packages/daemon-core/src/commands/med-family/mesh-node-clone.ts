/**
 * RF-ROUTER MED family — clone a worktree node (local git worktree + submodule
 * sync + bootstrap, or forwarded to the owning daemon) and re-run a node's
 * worktree bootstrap. Split out of mesh-crud.ts (merged into meshCrudHandlers
 * there).
 */
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId, readText } from '@adhdev/mesh-shared';
import {
    getRegisteredSubmodulePaths,
    loadMeshWorktreeBootstrapConfig,
    runMeshWorktreeBootstrap,
    startMeshWorktreeBootstrap,
    type WorktreeBootstrapState,
} from '../../mesh/worktree-bootstrap-config.js';
import { loadRepoSettings } from '../../config/repo-settings.js';
import { handleMeshForwardEvent, notifyMeshCoordinator } from '../../mesh/mesh-events.js';
import { noteRecentlyClonedNode } from '../../mesh/mesh-clone-grace.js';
import { getMachineId } from '../../config/config.js';
import { readMeshNodeMachineId, readMeshNodeDaemonId } from '../router.js';
import type { CommandRouterResult } from '../router.js';
import type { GitRepoIdentity } from '../../git/git-types.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { readMeshDirectDispatchFlag, withMeshDirectDispatch } from '../command-args.js';
import { rosterEvidenceExtra } from '../mesh-sender.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';

/**
 * Decision for syncing a freshly-cloned worktree's `oss` submodule to its clone
 * source node, applying resolveWorktreeBaseStartPoint's origin-tip-priority
 * policy to the submodule.
 *
 * On clone, `submodule update --init` checks the worktree's `oss` out at the
 * gitlink recorded in the FRESH root base — which the root base-stale fix
 * branches from origin/main, so it is the up-to-date origin tip. The clone
 * source node's *working* `oss` SHA can lag that tip. The original sync blindly
 * checked out the source SHA whenever it merely differed, which REWINDS the
 * submodule back onto the stale source and re-introduces staleness.
 *
 * Guard policy (never rewind, mirror the base-start-point resolver):
 *   - source SHA == worktree SHA            → `noop`
 *   - source SHA is an ancestor of worktree → `skip_rewind`  (source is behind; keep fresh tip)
 *   - worktree SHA is an ancestor of source → `advance`      (source strictly newer; safe fast-forward)
 *   - neither is an ancestor (diverged)     → `skip_diverged` (keep fresh tip; coordinator reconciles)
 *
 * Both SHAs must already be resolvable in `ossCtx` (the caller fetches the
 * source SHA first). A non-1 git exit (unresolvable SHA / real failure) is
 * rethrown so the caller can fall back to keeping the fresh worktree HEAD.
 */
export type OssCloneSyncAction = 'noop' | 'advance' | 'skip_rewind' | 'skip_diverged';

export async function decideOssCloneSync(
    ossCtx: GitRepoIdentity,
    worktreeOssSha: string,
    sourceSha: string,
    rg: (ctx: GitRepoIdentity, argv: string[], opts?: { timeoutMs?: number }) => Promise<unknown>,
): Promise<OssCloneSyncAction> {
    if (!worktreeOssSha || !sourceSha || worktreeOssSha === sourceSha) return 'noop';

    const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
        try {
            await rg(ossCtx, ['merge-base', '--is-ancestor', ancestor, descendant], { timeoutMs: 10000 });
            return true;
        } catch (err: any) {
            // `merge-base --is-ancestor` exits 1 for a clean "not an ancestor".
            // Any other exit (128 = unresolvable commit, etc.) is a real failure.
            if (err?.exitCode === 1 || err?.code === 1) return false;
            throw err;
        }
    };

    // Source is an ancestor of the fresh worktree tip → checking it out rewinds.
    if (await isAncestor(sourceSha, worktreeOssSha)) return 'skip_rewind';
    // Worktree tip is an ancestor of source → source is strictly newer → safe FF.
    if (await isAncestor(worktreeOssSha, sourceSha)) return 'advance';
    // Neither is an ancestor → diverged → keep the fresh worktree HEAD.
    return 'skip_diverged';
}

/**
 * Sync every registered submodule of a freshly-cloned worktree to its clone source
 * node's working submodule HEAD, applying decideOssCloneSync's origin-tip-priority
 * rewind guard per submodule.
 *
 * Generic over the submodule set: the paths come from `.gitmodules` via
 * getRegisteredSubmodulePaths, so this operates identically over EVERY registered
 * submodule (oss, adhdev-providers, …) instead of a hardcoded 'oss' literal. In a
 * repo whose only synced submodule is `oss` the emitted git commands are byte-identical
 * to the original oss-only path.
 *
 * Best-effort by design: a failure on one submodule is logged and skipped; it never
 * blocks the other submodules or the clone. A submodule is only ever advanced to a
 * STRICTLY-NEWER source SHA — the fresh (origin/main-derived) worktree tip is never
 * rewound onto a behind/diverged source.
 */
export async function syncClonedWorktreeSubmodules(
    worktreePath: string,
    sourceWorkspace: string,
    rg: (ctx: GitRepoIdentity, argv: string[], opts?: { timeoutMs?: number }) => Promise<unknown>,
): Promise<void> {
    const submodulePaths = getRegisteredSubmodulePaths(worktreePath);
    if (submodulePaths.size === 0) return;

    const sourceCtx: GitRepoIdentity = { workspace: sourceWorkspace, repoRoot: sourceWorkspace, isGitRepo: true };
    const worktreeCtx: GitRepoIdentity = { workspace: worktreePath, repoRoot: worktreePath, isGitRepo: true };
    const readStdout = (out: unknown): string =>
        (typeof out === 'string' ? out : (out as any)?.stdout ?? '').trim();

    for (const submodulePath of submodulePaths) {
        try {
            // Read the source node's working submodule SHA.
            const sourceStatusOut = await rg(sourceCtx, ['submodule', 'status', submodulePath], { timeoutMs: 10000 });
            const sourceSha = readStdout(sourceStatusOut).match(/^[+\- ]?([0-9a-f]{40})/)?.[1];
            if (!sourceSha) continue;

            // Read the worktree's freshly-checked-out submodule HEAD.
            const subCtx: GitRepoIdentity = {
                workspace: `${worktreePath}/${submodulePath}`,
                repoRoot: `${worktreePath}/${submodulePath}`,
                isGitRepo: true,
            };
            const worktreeSubSha = readStdout(await rg(subCtx, ['rev-parse', 'HEAD'], { timeoutMs: 10000 }));
            if (!worktreeSubSha || worktreeSubSha === sourceSha) continue;

            // Bring the source node's submodule HEAD into the worktree submodule object
            // DB so both SHAs are resolvable for the ancestry (rewind) guard below.
            await rg(subCtx, ['fetch', `${sourceWorkspace}/${submodulePath}`, 'HEAD'], { timeoutMs: 60000 });

            // Rewind guard: the worktree submodule HEAD was just checked out from the
            // FRESH (origin/main-derived) root base. Only advance to the source SHA when
            // it is strictly newer — never rewind to a stale source.
            let action: OssCloneSyncAction;
            try {
                action = await decideOssCloneSync(subCtx, worktreeSubSha, sourceSha, rg);
            } catch (decideErr: any) {
                action = 'skip_diverged';
                console.warn(`[mesh] ${submodulePath} submodule sync guard could not resolve ancestry (kept fresh worktree HEAD): ${decideErr?.message ?? decideErr}`);
            }

            if (action === 'advance') {
                await rg(subCtx, ['checkout', sourceSha], { timeoutMs: 10000 });
                await rg(worktreeCtx, ['add', submodulePath], { timeoutMs: 10000 });
                await rg(worktreeCtx, ['commit', '-m', `chore: sync ${submodulePath} to source node HEAD on clone`], { timeoutMs: 10000 });
                console.log(`[mesh] Advanced ${submodulePath} submodule to newer source HEAD ${sourceSha.slice(0, 8)} in worktree`);
            } else if (action === 'skip_rewind') {
                console.warn(`[mesh] Skipped ${submodulePath} submodule rewind on clone: source node ${submodulePath} ${sourceSha.slice(0, 8)} is an ancestor of the fresh worktree ${submodulePath} ${worktreeSubSha.slice(0, 8)} — kept fresher worktree HEAD`);
            } else if (action === 'skip_diverged') {
                console.warn(`[mesh] Skipped ${submodulePath} submodule sync on clone: source node ${submodulePath} ${sourceSha.slice(0, 8)} diverged from the fresh worktree ${submodulePath} ${worktreeSubSha.slice(0, 8)} — kept worktree HEAD (coordinator reconciles)`);
            }
        } catch (subErr: any) {
            // Per-submodule best-effort: never let one submodule's failure block the rest.
            console.warn(`[mesh] ${submodulePath} submodule sync to source HEAD failed (best-effort):`, subErr?.message ?? subErr);
        }
    }
}

type MeshCommandRecord = NonNullable<Awaited<ReturnType<MedFamilyContext['getMeshForCommand']>>>;

/**
 * Persist a worktree node's bootstrap state into the representation the mesh was
 * resolved from (inline cache, or meshes.json + aggregate-status bust).
 * Best-effort: a persistence failure never fails the clone / retry.
 */
async function persistNodeBootstrapState(
    ctx: MedFamilyContext,
    meshId: string,
    meshRecord: MeshCommandRecord,
    node: any,
    bootstrapState: WorktreeBootstrapState,
): Promise<void> {
    node.worktreeBootstrap = bootstrapState;
    if (meshRecord.inline) {
        ctx.updateInlineMeshNode(meshId, meshRecord.mesh, node);
        return;
    }
    try {
        const { updateNode } = await import('../../config/mesh-config.js');
        updateNode(meshId, node.id, { worktreeBootstrap: bootstrapState });
        ctx.invalidateAggregateMeshStatus(meshId);
    } catch { /* bootstrap status persistence is best-effort */ }
}

/**
 * CLONE-AFTER-IDLE-REMINDER guard (2026-09-24 incident): a coordinator
 * autonomously cloned two worktrees in direct response to the idle-mission
 * reminder's nudge, which only ever intended "check state and report". See
 * mesh-idle-reminder.ts's CLONE_AFTER_IDLE_REMINDER_GUARD_MS doc for why this — a
 * short reason-required window keyed off the reminder's own timestamp — was chosen
 * over gating on mission/task counts.
 */
async function checkCloneAfterIdleReminder(meshId: string, args: any): Promise<CommandRouterResult | null> {
    if (readMeshDirectDispatchFlag(args)) return null;
    const { MeshRuntimeStore } = await import('../../mesh/mesh-runtime-store.js');
    const { cloneRequiresIdleReminderReason } = await import('../../mesh/mesh-idle-reminder.js');
    const lastReminder = MeshRuntimeStore.getInstance().getIdleReminderState(meshId);
    if (!cloneRequiresIdleReminderReason(lastReminder, Date.now(), args)) return null;
    return {
        success: false,
        code: 'clone_requires_reason_after_idle_reminder',
        error: 'An idle-mission reminder just fired for this mesh. Pass an explicit `reason` '
            + '(or `taskId`) explaining why this clone is needed, or wait for the guard window '
            + 'to elapse. This is not a refusal to clone — it exists so an idle nudge to "check '
            + 'state and report" cannot be read as license to clone/launch/enqueue on its own.',
    };
}

/**
 * Forward a clone to the source node's daemon (a different machine) and register
 * the remotely-created node here.
 *
 * REMOTE-CLONE-CACHE-SEED: the node is seeded into THIS coordinator's inline cache
 * immediately, mirroring what the local clone branch does. Without it the node was
 * visible to every read TOOL yet permanently invisible to the QUEUE: the scheduler
 * (getMeshWithCache) is a purely passive cache reader, and cache reflection rested
 * entirely on the one-shot `worktree_bootstrap_complete` P2P push, which has neither
 * retry nor periodic resync — a single dropped event stranded the node forever. The
 * forwarded reply carries the FULL node the remote daemon registered (daemonId,
 * machineId, policy, userOverrides, workspace, worktreeBranch);
 * seedRemoteClonedWorktreeNode merges order-independently with the bootstrap
 * event's minimal hydrate-on-miss shell. REMOTE-CLONE-DURABLE: the seed is in-memory
 * only, so the node is also written into this coordinator's meshes.json.
 * FALSE-BLOCKER-CLONE-QUEUE: the transient grace window opens too — the remote
 * bootstrap may still be 'running', so a task pinned to it can transiently defer.
 */
async function forwardCloneToSourceDaemon(ctx: MedFamilyContext, meshId: string, args: any, mesh: any, sourceDaemonId: string): Promise<CommandRouterResult> {
    const forwarded = unwrapMeshRelayResult(
        await ctx.deps.dispatchMeshCommand!(sourceDaemonId, 'clone_mesh_node', withMeshDirectDispatch(args, rosterEvidenceExtra(args, mesh))),
        { command: 'clone_mesh_node', peerDaemonId: sourceDaemonId },
    );
    const forwardedNode = forwarded.success ? (forwarded as { node?: unknown }).node : undefined;
    const forwardedNodeId = normalizeMeshNodeId(forwardedNode as any);
    if (forwardedNode && forwardedNodeId) {
        ctx.seedRemoteClonedWorktreeNode(meshId, forwardedNode);
        try {
            await ctx.persistRemoteClonedWorktreeNode(meshId, forwardedNode);
        } catch { /* best-effort: member reconciliation re-reports it after a restart */ }
    }
    if (forwardedNodeId) noteRecentlyClonedNode(forwardedNodeId);
    return forwarded as CommandRouterResult;
}

type CreatedWorktree = Awaited<ReturnType<typeof import('../../git/git-worktree.js')['createWorktree']>>;

/**
 * Register the freshly created worktree as a mesh node in the representation the
 * mesh was resolved from. Returns null when the config write failed.
 *
 * Inline mesh: the node lives in the inline cache and is ALSO persisted to
 * meshes.json when this meshId has a config-file twin (NODE-MEMBERSHIP-SHRINK-ON-
 * MERGE durability half — a cache-only node was lost on restart); a pure inline /
 * cloud mesh has no twin and addNode is a silent no-op. Config mesh: the node is
 * added to config and reconciled into any warmed inline cache, because get_mesh
 * (preferInline) reads the inline cache first. A source policy still carrying the
 * removed legacy providerRoles has its cap folded into slots so the clone never
 * re-seeds providerRoles.
 */
async function registerClonedWorktreeNode(
    ctx: MedFamilyContext,
    meshId: string,
    meshRecord: MeshCommandRecord,
    sourceNode: any,
    sourceNodeId: string,
    result: CreatedWorktree,
    identity: { daemonId: string | undefined; machineId: string | undefined },
): Promise<any | null> {
    const { addNode } = await import('../../config/mesh-config.js');
    const { migrateProviderRolesToSlots } = await import('../../config/mesh-config-store.js');
    const clonedPolicy: Record<string, unknown> = { ...(sourceNode.policy || {}) };
    migrateProviderRolesToSlots(clonedPolicy);
    const fields = {
        workspace: result.worktreePath,
        repoRoot: result.worktreePath,
        daemonId: identity.daemonId,
        machineId: identity.machineId,
        userOverrides: { ...(sourceNode.userOverrides || {}) },
        isLocalWorktree: true,
        worktreeBranch: result.branch,
        clonedFromNodeId: sourceNodeId,
        policy: clonedPolicy as any,
    };
    if (meshRecord.inline) {
        const { randomUUID } = await import('crypto');
        const node = {
            id: `node_${randomUUID().replace(/-/g, '')}`,
            workspace: fields.workspace,
            repoRoot: fields.repoRoot,
            daemonId: fields.daemonId,
            machineId: fields.machineId,
            userOverrides: fields.userOverrides,
            policy: fields.policy,
            isLocalWorktree: true,
            worktreeBranch: fields.worktreeBranch,
            clonedFromNodeId: sourceNodeId,
        };
        ctx.updateInlineMeshNode(meshId, meshRecord.mesh, node);
        try {
            addNode(meshId, { id: node.id, ...fields, userOverrides: { ...(sourceNode.userOverrides || {}) } });
        } catch { /* no config-file twin for this mesh (pure inline/cloud mesh) — inline cache remains source of truth */ }
        return node;
    }
    const node = addNode(meshId, fields);
    if (!node) return null;
    const inlineForReconcile = ctx.getCachedInlineMesh(meshId);
    if (inlineForReconcile) ctx.updateInlineMeshNode(meshId, inlineForReconcile, node);
    ctx.invalidateAggregateMeshStatus(meshId);
    return node;
}

/** Who and where a clone's bootstrap events are about. */
interface CloneBootstrapTarget {
    meshId: string;
    mesh: any;
    node: any;
    worktreePath: string;
    daemonId: string | undefined;
    machineId: string | undefined;
}

/**
 * Emit the clone's worktree_bootstrap_{complete,failed} event. Addressed at the
 * mesh HOST (the daemon that will PHASE-1 pull this worker's queue), not at this
 * worker — an ownerless emit used to self-fallback-stamp THIS machineId, so the
 * host's drain never matched the row. Carries the worker's daemon/machine identity
 * so the host's hydrate-on-miss upsert is addressable over P2P.
 *
 * WORKTREE-BOOTSTRAP-COORD-STATE: this runs on the WORKER daemon that owns the
 * cloned worktree; the in-process handleMeshForwardEvent gets the REAL components
 * (router bootstrap stamp + inline cache + turn ledger for the queue re-fire it
 * schedules). A throw there (incl. daemon_components_not_ready in the boot window)
 * falls through to the notifyMeshCoordinator fallback. Best-effort.
 */
function emitCloneBootstrapEvent(
    ctx: MedFamilyContext,
    target: CloneBootstrapTarget,
    eventStatus: 'bootstrap_complete' | 'bootstrap_failed',
    bootstrapState: WorktreeBootstrapState,
    startedAtMs: number,
    extraPayload?: Record<string, unknown>,
): void {
    try {
        const { meshId, node, worktreePath, daemonId, machineId } = target;
        const event = `worktree_${eventStatus}` as const;
        const hostDaemonId = readText((target.mesh as { meshHost?: { hostDaemonId?: unknown } })?.meshHost?.hostDaemonId);
        const metadataEvent = {
            source: 'clone_mesh_node_bootstrap',
            nodeId: node.id,
            status: eventStatus,
            worktreePath,
            durationMs: Date.now() - startedAtMs,
            bootstrapStatus: bootstrapState.status,
            ...(hostDaemonId ? { targetCoordinatorDaemonId: hostDaemonId } : {}),
            ...(daemonId ? { originDaemonId: daemonId } : {}),
            ...(machineId ? { originMachineId: machineId } : {}),
            ...(bootstrapState.error ? { error: bootstrapState.error } : {}),
            ...(bootstrapState.exitCode !== undefined ? { exitCode: bootstrapState.exitCode } : {}),
            ...(extraPayload || {}),
        };
        if (typeof ctx.deps.instanceManager?.getByCategory === 'function') {
            try {
                const forwarded = handleMeshForwardEvent(
                    ctx.components(),
                    {
                        event,
                        meshId,
                        nodeId: node.id,
                        workspace: worktreePath,
                        metadataEvent,
                        ...(hostDaemonId ? { targetCoordinatorDaemonId: hostDaemonId } : {}),
                        ...(daemonId ? { originDaemonId: daemonId } : {}),
                        ...(machineId ? { originMachineId: machineId } : {}),
                    },
                );
                if (forwarded?.success === true) return;
            } catch { /* falls through to the queue fallback below */ }
        }
        notifyMeshCoordinator({
            event,
            meshId,
            nodeLabel: node.id,
            nodeId: node.id,
            workspace: worktreePath,
            metadataEvent,
            queuedAt: Date.now(),
            ...(hostDaemonId ? { targetCoordinatorDaemonId: hostDaemonId } : {}),
        });
    } catch { /* event emission is best-effort */ }
}

/** The clone's `node_cloned` ledger record. Best-effort. */
async function appendCloneLedger(
    target: CloneBootstrapTarget,
    sourceNodeId: string,
    branch: string,
    submodulesInitialized: boolean,
    bootstrapState: WorktreeBootstrapState,
): Promise<void> {
    try {
        const { meshRecord } = await import('../../mesh/mesh-record.js');
        meshRecord(target.meshId, 'node_cloned', {
            nodeId: target.node.id,
            payload: {
                sourceNodeId,
                branch,
                worktreePath: target.worktreePath,
                submodulesInitialized,
                worktreeBootstrap: {
                    status: bootstrapState.status,
                    required: bootstrapState.required,
                    configSource: bootstrapState.configSource,
                    configSourceType: bootstrapState.configSourceType,
                    lastCommand: bootstrapState.lastCommand,
                    exitCode: bootstrapState.exitCode,
                },
            },
        }, { local: true });
    } catch { /* ledger append is best-effort */ }
}

/**
 * Submodule init + sync to the clone source node's working HEAD (best-effort,
 * generic over .gitmodules — the rewind guard is applied per submodule). A failure
 * never fails the clone.
 */
async function initClonedWorktreeSubmodules(worktreePath: string, sourceNode: any): Promise<boolean> {
    let submodulesInitialized = false;
    try {
        const { runGit } = await import('../../git/git-executor.js');
        await runGit(
            { workspace: worktreePath, repoRoot: worktreePath, isGitRepo: true },
            ['submodule', 'update', '--init', '--recursive'],
            { timeoutMs: 120000 },
        );
        submodulesInitialized = true;
        const sourceWorkspace = sourceNode.repoRoot || sourceNode.workspace;
        if (sourceWorkspace) await syncClonedWorktreeSubmodules(worktreePath, sourceWorkspace, runGit);
    } catch (subErr: any) {
        console.warn('[mesh] Submodule init failed for worktree:', subErr.message);
    }
    return submodulesInitialized;
}

export const meshNodeCloneHandlers: Record<string, MedFamilyHandler> = {
    clone_mesh_node: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const sourceNodeId = typeof args?.sourceNodeId === 'string' ? args.sourceNodeId.trim() : '';
        const branch = typeof args?.branch === 'string' ? args.branch.trim() : '';
        const baseBranch = typeof args?.baseBranch === 'string' ? args.baseBranch.trim() : undefined;
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!sourceNodeId) return { success: false, error: 'sourceNodeId required' };
        if (!branch) return { success: false, error: 'branch required' };

        const reminderRefusal = await checkCloneAfterIdleReminder(meshId, args);
        if (reminderRefusal) return reminderRefusal;

        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'worktree clone');
        if (ownerFailure) return ownerFailure;

        try {
            // Resolve with preferInline so the clone writes the new node into the
            // same representation that get_mesh reads back (the MCP coordinator passes
            // inlineMesh on every mesh command, and get_mesh reads preferInline).
            // Otherwise clone could write the node only to config — invisible to live
            // mesh membership even though worktree_bootstrap_complete fires.
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            if (!mesh) return { success: false, error: 'Mesh not found' };

            const sourceNode = mesh.nodes?.find((n: any) => meshNodeIdMatches(n, sourceNodeId));
            if (!sourceNode) return { success: false, error: `Source node '${sourceNodeId}' not found in mesh` };

            // Forward to the source node's daemon if it's on a different machine
            // (daemonIdsEquivalent: an equivalent-form daemonId is this machine).
            // _meshDirectDispatch prevents infinite re-forwarding when the stored daemonId
            // uses a legacy format that doesn't match the receiving daemon's statusInstanceId.
            const sourceDaemonId = typeof sourceNode.daemonId === 'string' ? sourceNode.daemonId.trim() : undefined;
            if (sourceDaemonId && !daemonIdsEquivalent(sourceDaemonId, ctx.deps.statusInstanceId) && ctx.deps.dispatchMeshCommand
                && !readMeshDirectDispatchFlag(args)) {
                return await forwardCloneToSourceDaemon(ctx, meshId, args, mesh, sourceDaemonId);
            }

            // REMOTE-CLONE-SELF-IDENTITY: this branch executes ON the source node's OWN
            // machine, and a machine's own self/base node routinely carries NO daemonId
            // (the onboarding add_mesh_node step never stamps one). A clone copies the
            // source identity, so an empty self-daemonId would ship a REMOTE-forwarded
            // clone back to a coordinator that can only reach it over P2P via daemonId —
            // every remote probe silently no-ops and capability tags fall back to the
            // caller's own platform. Mirror buildMemberJoinNode's fallback here.
            const identity = {
                daemonId: readMeshNodeDaemonId(sourceNode as any) || readText(ctx.deps.statusInstanceId) || undefined,
                machineId: readMeshNodeMachineId(sourceNode as any)
                    || (() => { try { return readText(getMachineId()); } catch { return ''; } })()
                    || undefined,
            };

            // Mesh-policy override for where worktrees are physically placed. When
            // unset, createWorktree defaults to <home>/.adhdev/worktrees. The cleanup
            // guard resolves the same base from mesh.policy, so the override must stay
            // set on the mesh for the node's lifetime.
            const worktreeBaseDir = typeof mesh.policy?.worktreeBaseDir === 'string' && mesh.policy.worktreeBaseDir.trim()
                ? mesh.policy.worktreeBaseDir.trim()
                : undefined;
            const { createWorktree } = await import('../../git/git-worktree.js');
            const result = await createWorktree({
                repoRoot: sourceNode.repoRoot || sourceNode.workspace,
                branch,
                baseBranch,
                meshName: mesh.name,
                worktreeBaseDir,
            });
            if (result.baseSync?.warning) {
                console.warn(`[mesh] clone_mesh_node base sync (${result.baseSync.action}): ${result.baseSync.warning}`);
            } else if (result.baseSync && result.baseSync.action !== 'up_to_date') {
                console.log(`[mesh] clone_mesh_node base sync: ${result.baseSync.action} (startRef=${result.baseSync.startRef})`);
            }

            const node = await registerClonedWorktreeNode(ctx, meshId, meshRecord, sourceNode, sourceNodeId, result, identity);
            if (!node) return { success: false, error: 'Failed to register worktree node' };

            // FALSE-BLOCKER-CLONE-QUEUE: open the transient grace window for the freshly cloned
            // node. A queue task pinned to it (target_node pin) enqueued before bootstrap
            // completes / the inline-cache entry fully settles must be classified as a transient
            // skip, not a permanent 'target_node_id_unmatched' actionable blocker.
            if (typeof node?.id === 'string' && node.id) noteRecentlyClonedNode(node.id);

            const target: CloneBootstrapTarget = { meshId, mesh, node, worktreePath: result.worktreePath, daemonId: identity.daemonId, machineId: identity.machineId };
            const persistWorktreeSetupState = (state: WorktreeBootstrapState) => persistNodeBootstrapState(ctx, meshId, meshRecord, node, state);
            const emitBootstrapEvent = (eventStatus: 'bootstrap_complete' | 'bootstrap_failed', state: WorktreeBootstrapState, startedAtMs: number, extraPayload?: Record<string, unknown>) =>
                emitCloneBootstrapEvent(ctx, target, eventStatus, state, startedAtMs, extraPayload);

            const initSubmodules = (sourceNode.policy as any)?.initSubmodulesOnClone !== false;
            // Read the worktree bootstrap config through the unified RepoSettings
            // loader (file-separated `.adhdev/worktree_bootstrap.json`; machine-local
            // inline seam honored). The bootstrap runner below re-loads it to run.
            const loadedBootstrap = loadRepoSettings({ workspace: result.worktreePath, mesh }).worktreeBootstrap;
            const runningBootstrapState: WorktreeBootstrapState = {
                status: 'running',
                required: loadedBootstrap.config?.required !== false,
                configSource: loadedBootstrap.path || loadedBootstrap.source,
                configSourceType: loadedBootstrap.sourceType,
                startedAt: new Date().toISOString(),
            };
            await persistWorktreeSetupState(runningBootstrapState);

            // Set by finishWorktreeSetup once the bootstrap is enqueued; still
            // undefined if the setupWaitMs race fires while submodule init is running.
            let queuedBehind: number | undefined;

            const finishWorktreeSetup = async (): Promise<{ submodulesInitialized: boolean; bootstrapState: WorktreeBootstrapState }> => {
                const submodulesInitialized = initSubmodules ? await initClonedWorktreeSubmodules(result.worktreePath, sourceNode) : false;
                // WORKTREE-BOOTSTRAP-SERIAL-QUEUE: bootstraps run one at a time per
                // daemon (they contend on the machine-wide npm cache), so this may sit
                // queued behind another clone before it starts. Record the position it
                // was queued at so the async response below can tell the coordinator
                // "waiting for another clone" apart from "installing" — the status
                // stays 'running' either way.
                const started = startMeshWorktreeBootstrap(mesh, result.worktreePath);
                queuedBehind = started.queuePosition;
                const bootstrapState: WorktreeBootstrapState = await started.result;
                await persistWorktreeSetupState(bootstrapState);
                await appendCloneLedger(target, sourceNodeId, result.branch, submodulesInitialized, bootstrapState);
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

            const bootstrapStartedMs = Date.now();

            // WORKTREE-BOOTSTRAP-FAILED-EVENT: runMeshWorktreeBootstrap REPORTS a failure by
            // RETURNING `status: 'failed'` — it does not throw (a non-zero command exit is a
            // verdict, not a fault). Both emit sites below used to hardcode 'bootstrap_complete'
            // for every resolved state, so a genuinely failed bootstrap reached the coordinator
            // labelled COMPLETE — while the dispatch gate in mesh-event-forwarding deliberately
            // does NOT defer on 'failed' because "a failed bootstrap surfaces its own coordinator
            // event". Route on the actual terminal status instead; the receiving side is already
            // wired for it. This does not defer anything: the gate's no-infinite-deferral design
            // is untouched.
            const terminalBootstrapEvent = (state: WorktreeBootstrapState): 'bootstrap_complete' | 'bootstrap_failed' =>
                state.status === 'failed' ? 'bootstrap_failed' : 'bootstrap_complete';

            if (!setupResult.completed) {
                setupPromise
                    .then(({ bootstrapState }) => {
                        emitBootstrapEvent(terminalBootstrapEvent(bootstrapState), bootstrapState, bootstrapStartedMs);
                    })
                    .catch((error: any) => {
                        const failedState: WorktreeBootstrapState = {
                            ...runningBootstrapState,
                            status: 'failed',
                            completedAt: new Date().toISOString(),
                            error: error?.message || String(error),
                        };
                        void persistWorktreeSetupState(failedState);
                        void appendCloneLedger(target, sourceNodeId, result.branch, false, failedState);
                        emitBootstrapEvent('bootstrap_failed', failedState, bootstrapStartedMs, { error: error?.message || String(error) });
                    });
                return {
                    success: true,
                    async: true,
                    status: 'accepted',
                    node,
                    worktreePath: result.worktreePath,
                    branch: result.branch,
                    ...(result.baseSync ? { baseSync: result.baseSync } : {}),
                    ...(result.baseSync?.warning ? { baseStaleWarning: result.baseSync.warning } : {}),
                    worktreeBootstrap: queuedBehind ? { ...runningBootstrapState, queuePosition: queuedBehind } : runningBootstrapState,
                    worktreeSetup: {
                        status: 'running',
                        setupWaitMs,
                        ...(queuedBehind ? { queuedBehind } : {}),
                        message: queuedBehind
                            // WORKTREE-BOOTSTRAP-SERIAL-QUEUE: bootstraps are serialized per
                            // daemon, so a concurrent clone waits rather than racing the
                            // machine-wide npm cache.
                            ? `Worktree node is registered; bootstrap is queued behind ${queuedBehind} other bootstrap${queuedBehind === 1 ? '' : 's'} on this daemon and will run when they finish.`
                            : 'Worktree node is registered; submodule/bootstrap setup is continuing in the background.',
                    },
                };
            }

            const { submodulesInitialized, bootstrapState } = setupResult.value;
            emitBootstrapEvent(terminalBootstrapEvent(bootstrapState), bootstrapState, bootstrapStartedMs);
            return {
                success: true,
                node,
                worktreePath: result.worktreePath,
                branch: result.branch,
                ...(result.baseSync ? { baseSync: result.baseSync } : {}),
                ...(result.baseSync?.warning ? { baseStaleWarning: result.baseSync.warning } : {}),
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
                && !readMeshDirectDispatchFlag(args)) {
                const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId, 'retry_mesh_node_bootstrap', withMeshDirectDispatch(args, rosterEvidenceExtra(args, mesh)));
                return unwrapMeshRelayResult(forwarded, { command: 'retry_mesh_node_bootstrap', peerDaemonId: nodeDaemonId }) as CommandRouterResult;
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

            await persistNodeBootstrapState(ctx, meshId, meshRecord, node, runningState);
            const bootstrapState = await runMeshWorktreeBootstrap(mesh, worktreePath);
            await persistNodeBootstrapState(ctx, meshId, meshRecord, node, bootstrapState);

            return { success: true, bootstrapState };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },
};
