/** Explicit owner repair of a dangling source binding. No Git or runtime mutation. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { hiddenExecFileSync } from '../../process/hidden-spawn.js';
import { gitChildEnv } from '../../git/git-locale.js';
import { MeshConfigStrictLockError, normalizeRepoIdentity, readMeshConfigFromDisk, saveMeshConfigDurable, withStrictMeshConfigWriteLock } from '../../config/mesh-config-store.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { pendingLaunchReservation } from '../../mesh/mesh-task-routing-contract.js';
import type { MedFamilyContext } from './types.js';

class RepairRefusal extends Error {
    constructor(readonly code: string) { super(code); }
}
function requireProof(value: unknown, code: string): asserts value {
    if (!value) throw new RepairRefusal(code);
}
function git(cwd: string, ...args: string[]): string {
    return hiddenExecFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, env: gitChildEnv() }).trim();
}
function canonicalWorkspace(node: any): string {
    const path = node.workspace;
    requireProof(typeof path === 'string' && isAbsolute(path) && realpathSync(path) === resolve(path), 'source_parent_untrusted_path');
    requireProof(!node.repoRoot || resolve(node.repoRoot) === path, 'source_parent_repo_root_mismatch');
    requireProof(git(path, 'rev-parse', '--show-toplevel') === path, 'source_parent_untrusted_path');
    return path;
}
function validateLink(mesh: any, node: any, parent: any, daemonId: string): void {
    requireProof(node !== parent && !meshNodeIdMatches(parent, node.id), 'source_parent_cycle');
    requireProof(node.isLocalWorktree === true && !parent.isLocalWorktree && !parent.clonedFromNodeId, 'source_parent_cycle_or_not_base');
    for (const item of [node, parent]) {
        requireProof(typeof item.daemonId === 'string' && daemonIdsEquivalent(item.daemonId, daemonId), 'source_parent_remote_owner');
        if (item.machineId) requireProof(daemonIdsEquivalent(item.machineId, daemonId), 'source_parent_remote_owner');
    }
    const workspace = canonicalWorkspace(node);
    const base = canonicalWorkspace(parent);
    const common = realpathSync(git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    requireProof(common === join(base, '.git') && lstatSync(common).isDirectory() && !lstatSync(common).isSymbolicLink(), 'source_parent_cross_repo');
    requireProof(realpathSync(git(base, 'rev-parse', '--absolute-git-dir')) === common, 'source_parent_not_main_checkout');
    const gitDir = realpathSync(git(workspace, 'rev-parse', '--absolute-git-dir'));
    const entry = relative(join(common, 'worktrees'), gitDir);
    requireProof(entry && !entry.startsWith(`..${sep}`) && entry !== '..' && !isAbsolute(entry) && !entry.includes(sep), 'source_parent_external_worktree');
    requireProof(!lstatSync(join(workspace, '.git')).isSymbolicLink()
        && realpathSync(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()) === join(workspace, '.git'), 'source_parent_invalid_backlink');
    requireProof(git(base, 'symbolic-ref', '--short', 'HEAD') === (mesh.defaultBranch || 'main'), 'source_parent_wrong_default_branch');
    const identity = normalizeRepoIdentity(mesh.repoIdentity || '');
    requireProof(identity && normalizeRepoIdentity(git(base, 'remote', 'get-url', 'origin')) === identity
        && normalizeRepoIdentity(git(workspace, 'remote', 'get-url', 'origin')) === identity, 'source_parent_repo_identity_mismatch');
}

export async function reattachMeshSourceParent(ctx: MedFamilyContext, args: any) {
    const { meshId, nodeId, parentNodeId, expectedOldParentId } = args || {};
    if (![meshId, nodeId, parentNodeId, expectedOldParentId].every(v => typeof v === 'string' && v.trim() === v && v.length)) {
        return { success: false, code: 'source_parent_arguments_required', error: 'meshId, nodeId, parentNodeId and explicit expectedOldParentId are required.' };
    }
    const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args.inlineMesh, 'source-parent reattachment');
    if (ownerFailure) return ownerFailure;
    try {
        // Resolve BEFORE entering the synchronous critical section; no await between
        // final ownership/CAS/lease checks, durable replace and cache publication.
        await ctx.getMeshForCommand(meshId, args.inlineMesh);
        const router = ctx.components().router;
        const store = MeshRuntimeStore.getInstance();
        return store.transaction(() => withStrictMeshConfigWriteLock(() => {
            const config = readMeshConfigFromDisk();
            const mesh = config?.meshes.find(m => m.id === meshId);
            requireProof(mesh, 'source_parent_durable_mesh_required');
            const host = resolveMeshHostStatus(mesh, { localDaemonId: ctx.deps.statusInstanceId });
            requireProof(host.canOwnCoordinator && host.canOwnQueue && host.hostDaemonId
                && daemonIdsEquivalent(host.hostDaemonId, ctx.deps.statusInstanceId), 'source_parent_host_ownership_changed');
            const node = mesh.nodes.find(n => n.id === nodeId);
            const parent = mesh.nodes.find(n => n.id === parentNodeId);
            requireProof(node && parent, 'source_parent_node_not_found');
            const current = node.clonedFromNodeId;
            const alreadyAttached = current === parent.id;
            requireProof(current === expectedOldParentId || (alreadyAttached && node.sourceParentReattachment?.previousParentId === expectedOldParentId), 'source_parent_cas_conflict');
            const cached = ctx.getCachedInlineMesh(meshId);
            const cachedNode = cached?.nodes?.find((n: any) => meshNodeIdMatches(n, node.id));
            requireProof(!cached || (cachedNode && cachedNode.clonedFromNodeId === current
                && cachedNode.workspace === node.workspace && cachedNode.isLocalWorktree === node.isLocalWorktree
                && (cachedNode.repoRoot || cachedNode.workspace) === (node.repoRoot || node.workspace) && daemonIdsEquivalent(cachedNode.daemonId, node.daemonId)), 'source_parent_cache_conflict');
            const cachedParent = cached?.nodes?.find((n: any) => meshNodeIdMatches(n, parent.id));
            requireProof(!cached || (cachedParent && cachedParent.workspace === parent.workspace
                && (cachedParent.repoRoot || cachedParent.workspace) === (parent.repoRoot || parent.workspace) && daemonIdsEquivalent(cachedParent.daemonId, parent.daemonId)
                && cachedParent.isLocalWorktree === parent.isLocalWorktree
                && cachedParent.clonedFromNodeId === parent.clonedFromNodeId), 'source_parent_cache_conflict');
            validateLink(mesh, node, parent, ctx.deps.statusInstanceId || '');
            // A valid explicit existing parent is not a dangling-parent repair.
            requireProof(alreadyAttached || !mesh.nodes.some(n => n.id === current), 'source_parent_existing_binding');
            requireProof(!router.runningRefineBatchJobs.has(meshId)
                && ![...router.runningRefineJobs.keys()].some(k => k.startsWith(`${meshId}:`))
                && router.refineBaseLeases.size === 0, 'source_parent_refinery_active');
            const rows = store.assignedRowsMeshWide(meshId).map(row => JSON.parse(row.payload));
            rows.push(...store.getQueueEntries(meshId, ['pending']).filter(t => pendingLaunchReservation(t)));
            requireProof(!rows.some(t => [t.assignedNodeId, t.targetNodeId, t.ownershipScope?.nodeId, t.reviewInputScope?.nodeId, t.autoLaunch?.nodeId]
                .some(id => id && [node, parent].some(n => n.id === id))), 'source_parent_active_lease');
            if (alreadyAttached) return { success: true, changed: false, nodeId: node.id, parentNodeId: parent.id };
            if (args.write !== true) return { success: true, dryRun: true, changed: false, nodeId: node.id, expectedOldParentId: current, parentNodeId: parent.id };
            // Invalidation may be supplied by a host port: fail before committing
            // if it is unavailable. Map publication below is synchronous and does
            // not invoke lifecycle callbacks or mutate potentially frozen snapshots.
            ctx.invalidateAggregateMeshStatus(meshId);
            node.clonedFromNodeId = parent.id;
            node.sourceParentReattachment = { previousParentId: current!, parentId: parent.id };
            const saved = saveMeshConfigDurable(config!);
            if (!saved.ok && !saved.committed) throw new RepairRefusal('source_parent_persistence_failed');
            if (cached) router.inlineMeshCache.set(meshId, { ...cached, nodes: cached.nodes.map((n: any) =>
                meshNodeIdMatches(n, node.id) ? { ...n, clonedFromNodeId: parent.id, sourceParentReattachment: node.sourceParentReattachment } : n) });
            // A post-rename fsync failure still committed. Cache agrees with disk;
            // report uncertainty honestly rather than claiming a rolled-back write.
            return saved.ok
                ? { success: true, changed: true, durable: true, nodeId: node.id, previousParentId: current, parentNodeId: parent.id }
                : { success: false, changed: true, code: 'source_parent_durability_unconfirmed', error: 'Registry replace committed and cache agrees; durability was not confirmed. Inspect before retrying.' };
        }));
    } catch (error) {
        const code = error instanceof RepairRefusal || error instanceof MeshConfigStrictLockError ? error.code : 'source_parent_validation_unavailable';
        return { success: false, changed: false, code, error: 'Source-parent repair refused. Check the current binding, canonical Git linkage, host ownership and active leases; rerun the dry-run before applying.' };
    }
}
