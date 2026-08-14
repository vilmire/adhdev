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
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId, deriveProviderPriorityFromSlots, normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';
import { DEFAULT_QUOTA_ROUTING_POLICY, resolveQuotaRoutingPolicy } from '../../repo-mesh-types.js';
import { resolveMeshHostStatus, normalizeMeshDaemonRole } from '../../mesh/mesh-host-ownership.js';
import {
    getRegisteredSubmodulePaths,
    loadMeshWorktreeBootstrapConfig,
    runMeshWorktreeBootstrap,
    type WorktreeBootstrapState,
} from '../../mesh/worktree-bootstrap-config.js';
import { loadRepoSettings } from '../../config/repo-settings.js';
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../../mesh/mesh-events.js';
import { noteRecentlyClonedNode } from '../../mesh/mesh-clone-grace.js';
import { loadConfig } from '../../config/config.js';
import {
    hydrateInlineMeshDirectTruth,
    normalizeProviderRoles,
    readMeshNodeMachineId,
} from '../router.js';
import type { CommandRouterResult } from '../router.js';
import type { GitRepoIdentity } from '../../git/git-types.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

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
 * PROVIDER-PRIORITY-FROM-SLOTS write-path sync: slots order = preference
 * (ORCHESTRATION_NODE_SLOTS.md), and the read paths already fall back to the
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

export const meshCrudHandlers: Record<string, MedFamilyHandler> = {
    list_meshes: async (ctx: MedFamilyContext, _args: any) => {
        try {
            const { listMeshes } = await import('../../config/mesh-config.js');
            const meshes = listMeshes();
            // HOST-MISSEED-CLOUD-SURFACE: surface the SAME resolved host pin that
            // mesh_status synthesizes (resolveMeshHostStatus) onto each list entry's
            // meshHost. The cloud dashboard's host banner reads hostPinned from the
            // list_meshes payload (selectedMesh.meshHost), NOT from mesh_status — so
            // without this a host mesh whose hostDaemonId was never persisted shows
            // 'no host yet' even though the daemon resolves this daemon as host.
            // resolveMeshHostStatus only synthesizes localDaemonId for role:'host'
            // (member meshes keep hostDaemonId undefined), so member meshes are not
            // polluted. localDaemonId mirrors mesh-status.ts; when absent, the resolver
            // falls back to the raw persisted meshHost.
            const localDaemonId = ctx?.deps?.statusInstanceId;
            const meshesWithHost = Array.isArray(meshes)
                ? meshes.map((mesh: any) => {
                    try {
                        return { ...mesh, meshHost: resolveMeshHostStatus(mesh, { localDaemonId }) };
                    } catch {
                        // Resolver failure on a single mesh must not drop the whole list.
                        return mesh;
                    }
                })
                : meshes;
            return { success: true, meshes: meshesWithHost };
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

    create_mesh: async (ctx: MedFamilyContext, args: any) => {
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
            // HOST-PIN-WRITER: a mesh is created BY the daemon that hosts it, so pin the
            // host at creation — the one moment it is knowable without guessing. Without
            // this a mesh is born with role-only host metadata, and every peer then
            // synthesizes ITSELF as host on read (the answer depending on which daemon was
            // asked). An explicit meshHost arg still wins; a caller may also pass
            // hostDaemonId to name a different creating daemon (cloud-relayed create).
            const requestedHostDaemonId = typeof args?.hostDaemonId === 'string' && args.hostDaemonId.trim()
                ? args.hostDaemonId.trim()
                : (ctx.deps.statusInstanceId || '');
            const mesh = createMesh({
                name,
                repoIdentity,
                repoRemoteUrl,
                defaultBranch,
                policy: args?.policy,
                meshHost,
                ...(requestedHostDaemonId ? { hostDaemonId: requestedHostDaemonId } : {}),
            });
            return { success: true, mesh };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    // HOST-PIN-WRITER — establish this mesh's host daemon as a DELIBERATE operator act.
    //
    // The dashboard's first-setup flow lets the operator pick which connected daemon
    // becomes the host; this is the command that actually persists that choice. It is a
    // separate surface from coordinator launch on purpose: the pin is effectively
    // permanent ("Fixed when the mesh is created — it cannot be reassigned here"), so it
    // must not be an incidental side effect of a button whose stated job is launching a
    // session. A mis-click must not permanently re-home a mesh.
    //
    // Reassignment to a DIFFERENT daemon is refused unless the caller passes
    // force:true — the mutator returns code 'host_already_pinned' and changes nothing.
    // Re-pinning the same daemon is a no-op, so retries/races are safe.
    set_mesh_host: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const hostDaemonId = typeof args?.hostDaemonId === 'string' ? args.hostDaemonId.trim() : '';
        const hostNodeId = typeof args?.hostNodeId === 'string' ? args.hostNodeId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!hostDaemonId && !hostNodeId) return { success: false, error: 'hostDaemonId or hostNodeId required' };
        try {
            const { setMeshHostPin, getMesh } = await import('../../config/mesh-config.js');
            const result = setMeshHostPin(meshId, {
                ...(hostDaemonId ? { hostDaemonId } : {}),
                ...(hostNodeId ? { hostNodeId } : {}),
                force: args?.force === true,
            });
            if (!result) return { success: false, error: 'Mesh not found' };
            if (!result.applied && result.reason !== 'already_pinned_same') {
                return {
                    success: false,
                    code: result.reason,
                    error: result.reason === 'host_already_pinned'
                        ? `Mesh host is already pinned to ${result.hostDaemonId}. Pass force:true to reassign it.`
                        : result.reason === 'not_host_role'
                            ? 'This daemon joined the mesh as a member; its host lives on the daemon it paired with.'
                            : 'hostDaemonId or hostNodeId required',
                    meshId,
                    meshHost: resolveMeshHostStatus(result.mesh),
                };
            }
            // Keep the live views coherent: the inline cache is what mesh_status /
            // get_mesh serve once any command has warmed it, and the aggregate status
            // snapshot is keyed on (meshId, queueRevision) — neither of which the pin
            // write touches, so both would keep serving the pre-pin host.
            const fresh = getMesh(meshId) || result.mesh;
            if (ctx.getCachedInlineMesh(meshId)) ctx.inlineMeshCache.set(meshId, fresh);
            ctx.invalidateAggregateMeshStatus(meshId);
            return {
                success: true,
                code: result.reason,
                meshId,
                applied: result.applied,
                meshHost: resolveMeshHostStatus(fresh),
                mesh: fresh,
            };
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

    // OPSRULES — emit a `.adhdev/mesh.json` DRAFT from the machine-local mesh
    // entry. This is an export scaffold for the operator to review and commit to
    // the repo, NOT an automatic data migration: nothing is written to disk and
    // meshes.json is untouched. The returned `scaffold` (object) + `scaffoldJson`
    // (2-space text) capture the coordinator prompt override/append (policy is
    // machine-local and is intentionally NOT exported into mesh.json).
    export_mesh_json_config: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { getMesh } = await import('../../config/mesh-config.js');
            const mesh = getMesh(meshId);
            if (!mesh) return { success: false, error: 'Mesh not found' };
            const { buildMeshJsonConfigScaffold, serializeMeshJsonConfigScaffold, MESH_JSON_CONFIG_LOCATIONS } =
                await import('../../config/mesh-json-config.js');
            const scaffold = buildMeshJsonConfigScaffold(mesh);
            const scaffoldJson = serializeMeshJsonConfigScaffold(scaffold);
            return {
                success: true,
                meshId,
                suggestedPath: MESH_JSON_CONFIG_LOCATIONS[0],
                scaffold,
                scaffoldJson,
                note: 'Draft only — review and commit to the repo at the suggested path. Nothing was written; meshes.json is unchanged (local-wins).',
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    // Gated WRITE path for `.adhdev/mesh.json` — the sibling of export_mesh_json_config
    // (which only DRAFTS). Same write/overwrite/dry-run contract as mesh_init's config
    // writer: defaults to dry-run (no write), never clobbers an existing repo mesh.json
    // unless overwrite=true, and validates the scaffold before persisting. The scaffold
    // is built from the machine-local mesh entry (coordinator prompt override/append);
    // policy/operating-notes are intentionally NOT exported (see buildMeshJsonConfigScaffold).
    write_mesh_json_config: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
        const write = args?.write === true;
        const overwrite = args?.overwrite === true;
        try {
            const { getMesh } = await import('../../config/mesh-config.js');
            const mesh = getMesh(meshId);
            if (!mesh) return { success: false, error: 'Mesh not found' };
            const {
                buildMeshJsonConfigScaffold,
                serializeMeshJsonConfigScaffold,
                loadRepoMeshJsonConfig,
                normalizeRepoMeshDeclarativeConfig,
                MESH_JSON_CONFIG_LOCATIONS,
            } = await import('../../config/mesh-json-config.js');
            const { mkdirSync, writeFileSync } = await import('fs');
            const { dirname, join } = await import('path');

            const scaffold = buildMeshJsonConfigScaffold(mesh);
            const scaffoldJson = serializeMeshJsonConfigScaffold(scaffold);
            const relativePath = MESH_JSON_CONFIG_LOCATIONS[0];
            const absolutePath = join(workspace, relativePath);

            // Validate before we ever touch disk — never write an unusable mesh.json.
            const validation = normalizeRepoMeshDeclarativeConfig(scaffold);
            if (!validation.valid) {
                return { success: false, meshId, error: `invalid mesh.json scaffold: ${validation.errors.join('; ')}` };
            }

            // existing-wins: a repo mesh.json already present is kept unless overwrite=true.
            const existing = loadRepoMeshJsonConfig(workspace);
            const existingPresent = existing.sourceType === 'repo_file' || existing.sourceType === 'invalid';
            if (existingPresent && !overwrite) {
                return {
                    success: true,
                    meshId,
                    written: false,
                    dryRun: !write,
                    skippedReason: 'already_exists',
                    path: absolutePath,
                    relativePath,
                    existing: existing.config,
                    existingSourceType: existing.sourceType,
                    scaffold,
                    scaffoldJson,
                    note: 'A repo mesh.json already exists — kept as-is. Re-run with overwrite=true to replace it (this silently drops operator hand-edits, so present a current-vs-suggested diff first).',
                };
            }

            if (!write) {
                return {
                    success: true,
                    meshId,
                    written: false,
                    dryRun: true,
                    path: absolutePath,
                    relativePath,
                    scaffold,
                    scaffoldJson,
                    note: 'Dry-run: nothing written. Re-run with write=true to persist to the repo (commit target). meshes.json is untouched.',
                };
            }

            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, `${scaffoldJson}\n`, 'utf-8');
            return {
                success: true,
                meshId,
                written: true,
                dryRun: false,
                path: absolutePath,
                relativePath,
                scaffold,
                scaffoldJson,
                note: 'Wrote .adhdev/mesh.json (repo commit target). Commit it to the repo; meshes.json (machine-local) is unchanged.',
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    // READ path for `.adhdev/mesh.json` — returns the currently-committed repo
    // config (parsed + normalized) for a workspace so a UI can render/edit the
    // existing declarative zones (notably `providerDefaults.autoApproveModes`)
    // WITHOUT re-deriving them from the machine-local scaffold. Never writes.
    // `config` is undefined when no repo file exists (sourceType 'unavailable') or
    // it is unparseable (sourceType 'invalid', with the parse error surfaced).
    read_mesh_json_config: async (_ctx: MedFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
        try {
            const { loadRepoMeshJsonConfig } = await import('../../config/mesh-json-config.js');
            const loaded = loadRepoMeshJsonConfig(workspace);
            return {
                success: true,
                workspace,
                sourceType: loaded.sourceType,
                source: loaded.source,
                ...(loaded.path ? { path: loaded.path } : {}),
                ...(loaded.error ? { error: loaded.error } : {}),
                config: loaded.config,
                // Convenience projection so the UI does not have to reach into config.
                providerDefaults: loaded.config?.providerDefaults,
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    // Partial-edit WRITE path for `.adhdev/mesh.json` `providerDefaults` — a
    // READ-MODIFY-WRITE that preserves operator hand-edits. Unlike
    // write_mesh_json_config (which rebuilds the WHOLE file from the machine-local
    // scaffold and can silently drop hand-edited zones), this parses the existing
    // repo file, merges ONLY the providerDefaults.autoApproveModes zone, and
    // re-serializes — coordinator prompt, operating notes and limits authored in
    // the repo are carried through untouched. Defaults to dry-run.
    //
    // args: { workspace?, autoApproveModes: Record<providerType,modeId>, write?, merge? }
    //   merge=true (default): per-provider merge into the existing map; a modeId of
    //     '' | null removes that provider's entry. merge=false: REPLACE the whole
    //     autoApproveModes map with the supplied one.
    set_mesh_provider_defaults: async (_ctx: MedFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
        const write = args?.write === true;
        const merge = args?.merge !== false; // default true
        const inputModes = args?.autoApproveModes;
        if (inputModes !== undefined && (typeof inputModes !== 'object' || inputModes === null || Array.isArray(inputModes))) {
            return { success: false, error: 'autoApproveModes must be an object (providerType → modeId) when provided' };
        }
        try {
            const {
                loadRepoMeshJsonConfig,
                normalizeRepoMeshDeclarativeConfig,
                MESH_JSON_CONFIG_LOCATIONS,
            } = await import('../../config/mesh-json-config.js');
            const { existsSync, readFileSync, mkdirSync, writeFileSync } = await import('fs');
            const { dirname, join } = await import('path');
            const yaml = await import('js-yaml');

            const relativePath = MESH_JSON_CONFIG_LOCATIONS[0];

            // Read-modify-write: parse the EXISTING on-disk document (preferring the
            // first existing json/yaml variant) so unrelated zones survive verbatim.
            let baseDoc: Record<string, any> = { version: 1 };
            let existingPath = join(workspace, relativePath);
            let existedAsYaml = false;
            for (const relative of MESH_JSON_CONFIG_LOCATIONS) {
                const candidate = join(workspace, relative);
                if (!existsSync(candidate)) continue;
                try {
                    const text = readFileSync(candidate, 'utf-8');
                    const parsed = /\.json$/i.test(candidate) ? JSON.parse(text) : yaml.load(text);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        baseDoc = parsed as Record<string, any>;
                        existingPath = candidate;
                        existedAsYaml = !/\.json$/i.test(candidate);
                    }
                } catch (e: any) {
                    return { success: false, error: `existing ${relative} is unparseable, refusing to overwrite: ${e?.message || e}` };
                }
                break;
            }

            // Merge ONLY the providerDefaults.autoApproveModes zone.
            const existingPd = baseDoc.providerDefaults && typeof baseDoc.providerDefaults === 'object' && !Array.isArray(baseDoc.providerDefaults)
                ? baseDoc.providerDefaults as Record<string, any>
                : {};
            const existingModes = existingPd.autoApproveModes && typeof existingPd.autoApproveModes === 'object' && !Array.isArray(existingPd.autoApproveModes)
                ? { ...existingPd.autoApproveModes as Record<string, string> }
                : {};

            const nextModes: Record<string, string> = merge ? existingModes : {};
            if (inputModes) {
                for (const [providerType, modeId] of Object.entries(inputModes as Record<string, unknown>)) {
                    const type = typeof providerType === 'string' ? providerType.trim() : '';
                    if (!type) continue;
                    const id = typeof modeId === 'string' ? modeId.trim() : '';
                    if (id) nextModes[type] = id;
                    else delete nextModes[type]; // '' / null → remove this provider's entry
                }
            }

            const nextDoc: Record<string, any> = { ...baseDoc, version: 1 };
            if (Object.keys(nextModes).length) {
                nextDoc.providerDefaults = { ...existingPd, autoApproveModes: nextModes };
            } else {
                // No entries left → drop the zone entirely so we don't leave an empty stub.
                if (nextDoc.providerDefaults) {
                    const { autoApproveModes, ...restPd } = nextDoc.providerDefaults;
                    if (Object.keys(restPd).length) nextDoc.providerDefaults = restPd;
                    else delete nextDoc.providerDefaults;
                }
            }

            // Validate the merged document before it ever touches disk.
            const validation = normalizeRepoMeshDeclarativeConfig(nextDoc);
            if (!validation.valid) {
                return { success: false, error: `merged mesh.json is invalid: ${validation.errors.join('; ')}` };
            }

            // Serialize in the on-disk format (JSON unless the existing file was YAML).
            const absolutePath = existingPath;
            const serialized = existedAsYaml
                ? yaml.dump(nextDoc, { indent: 2 })
                : `${JSON.stringify(nextDoc, null, 2)}\n`;

            if (!write) {
                return {
                    success: true,
                    written: false,
                    dryRun: true,
                    path: absolutePath,
                    relativePath,
                    merge,
                    providerDefaults: nextDoc.providerDefaults,
                    preview: serialized,
                    note: 'Dry-run: nothing written. Re-run with write=true to persist. Only the providerDefaults zone is merged; other repo zones are preserved.',
                };
            }

            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, serialized, 'utf-8');
            return {
                success: true,
                written: true,
                dryRun: false,
                path: absolutePath,
                relativePath,
                merge,
                providerDefaults: nextDoc.providerDefaults,
                note: 'Wrote providerDefaults into .adhdev/mesh.json (read-modify-write; other zones preserved). Commit it to the repo.',
            };
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

    // ─── MAGI kind → panel bindings (MAGI-KIND-PANEL, machine-local config) ───
    // Per-task_kind slot lists stored PER MESH in ~/.adhdev/meshes.json
    // (`meshes[].magiKindPanels`) — the SOLE MAGI panel-resolution surface (the former
    // named-panel magi_panel_* handlers were removed). `meshId` is optional on all three
    // so existing callers keep working: it resolves to the sole mesh on a single-mesh
    // machine, and is REQUIRED (loud error, never a silent pick) when several meshes
    // exist. Owner-only gating: intentionally NOT listed in
    // canPeerUsePrivilegedShareCommand (daemon-cloud data-channel-router), so a peer
    // holding ANY share permission hits its `default → false` branch — identical
    // owner-only gating to create_mesh / update_mesh / list_meshes. A trusted peer (no
    // permission = the owner) passes the top `!permission → true` guard. set/remove are
    // WRITE commands; list is read-only. normalizeMagiSlots (inside setMagiKindPanel)
    // surfaces invalid_magi_kind_panel: … messages verbatim for the editor, including
    // a nodeId that is not a member of the target mesh.
    magi_kind_panel_list: async (_ctx: MedFamilyContext, args: any) => {
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { listMagiKindPanels, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            // Report WHICH mesh the panels were read from. The old flat
            // scope: 'machine_local' hid that these are per-mesh bindings and was the
            // reason the scope read as global.
            const meshId = requestedMeshId || resolveScopedMeshId();
            return {
                success: true,
                kindPanels: listMagiKindPanels(requestedMeshId || undefined),
                scope: {
                    kind: 'mesh',
                    storage: 'machine_local',
                    meshId: meshId ?? null,
                    resolvedFrom: requestedMeshId ? 'explicit' : (meshId ? 'sole_mesh' : 'ambiguous'),
                    ...(requestedMeshId || meshId ? {} : {
                        note: 'Several meshes are configured and no meshId was given, so no panels could be read. Pass meshId.',
                    }),
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    magi_kind_panel_set: async (_ctx: MedFamilyContext, args: any) => {
        const kind = typeof args?.kind === 'string' ? args.kind.trim() : '';
        if (!kind) return { success: false, error: 'invalid_magi_kind_panel: task_kind is required' };
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { setMagiKindPanel, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            // normalizeMagiTaskKindKey + normalizeMagiSlots (inside setMagiKindPanel)
            // validate the kind and each slot (provider required; model optional;
            // replica counts clamped; nodeId must belong to the target mesh).
            // Structured errors flow back as `error`.
            const slots = setMagiKindPanel(kind, args?.slots, requestedMeshId || undefined);
            const meshId = requestedMeshId || resolveScopedMeshId();
            return { success: true, kind, slots, meshId: meshId ?? null };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    magi_kind_panel_remove: async (_ctx: MedFamilyContext, args: any) => {
        const kind = typeof args?.kind === 'string' ? args.kind.trim() : '';
        if (!kind) return { success: false, error: 'invalid_magi_kind_panel: task_kind is required' };
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { removeMagiKindPanel, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            const removed = removeMagiKindPanel(kind, requestedMeshId || undefined);
            const meshId = requestedMeshId || resolveScopedMeshId();
            return { success: true, removed, meshId: meshId ?? null };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    // ─── Brain routing: per-difficulty brain presets (PER MESH, machine-local) ───
    // getDifficultyBrains returns the seeded defaults when the mesh has nothing
    // configured, so the editor always shows a usable mapping. set replaces the whole
    // map for ONE mesh. `meshId` is optional and resolves to the sole mesh, so
    // existing callers keep working; with several meshes a write must name its mesh
    // (these presets choose the model a task runs on — writing to the wrong mesh
    // changes what that mesh costs).
    difficulty_brains_get: async (_ctx: MedFamilyContext, args: any) => {
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { getDifficultyBrains, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            const meshId = requestedMeshId || resolveScopedMeshId();
            return {
                success: true,
                difficultyBrains: getDifficultyBrains(requestedMeshId || undefined),
                scope: {
                    kind: 'mesh',
                    storage: 'machine_local',
                    meshId: meshId ?? null,
                    resolvedFrom: requestedMeshId ? 'explicit' : (meshId ? 'sole_mesh' : 'ambiguous'),
                    ...(requestedMeshId || meshId ? {} : {
                        note: 'Several meshes are configured and no meshId was given, so these are the shipped defaults, not any mesh\'s saved presets. Pass meshId.',
                    }),
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    difficulty_brains_set: async (_ctx: MedFamilyContext, args: any) => {
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { setDifficultyBrains, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            // normalizeDifficultyBrainMap (inside setDifficultyBrains) drops unknown
            // keys and empty slots. An empty result clears this mesh's override →
            // defaults, leaving every other mesh untouched.
            const difficultyBrains = setDifficultyBrains(args?.difficultyBrains, requestedMeshId || undefined);
            const meshId = requestedMeshId || resolveScopedMeshId();
            return { success: true, difficultyBrains, meshId: meshId ?? null };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    // ─── Quota-aware routing thresholds (PER MESH, machine-local) ───
    // The dedicated write path for RepoMeshPolicy.quotaRouting — previously only
    // reachable as a raw JSON patch through update_mesh's general `policy`
    // passthrough. The launch gate / fitness spread read the EFFECTIVE thresholds
    // through resolveQuotaRoutingPolicy, so `resolved` below is exactly what the
    // gate will apply; `quotaRouting` is the persisted overrides-only view
    // (fields equal to the defaults are never persisted — persistence economy).
    mesh_quota_routing_get: async (_ctx: MedFamilyContext, args: any) => {
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { getMeshQuotaRouting, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            const overrides = getMeshQuotaRouting(requestedMeshId || undefined);
            const meshId = requestedMeshId || resolveScopedMeshId();
            return {
                success: true,
                quotaRouting: overrides,
                resolved: resolveQuotaRoutingPolicy(overrides),
                defaults: DEFAULT_QUOTA_ROUTING_POLICY,
                scope: {
                    kind: 'mesh',
                    storage: 'machine_local',
                    meshId: meshId ?? null,
                    resolvedFrom: requestedMeshId ? 'explicit' : (meshId ? 'sole_mesh' : 'ambiguous'),
                    ...(requestedMeshId || meshId ? {} : {
                        note: 'Several meshes are configured and no meshId was given, so these are the shipped defaults, not any mesh\'s saved thresholds. Pass meshId.',
                    }),
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    mesh_quota_routing_set: async (ctx: MedFamilyContext, args: any) => {
        const requestedMeshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        try {
            const { setMeshQuotaRouting, getMesh, resolveScopedMeshId } = await import('../../config/mesh-config.js');
            // setMeshQuotaRouting validates STRICTLY (unknown field / non-number /
            // percent outside 0..100 / negative duration → invalid_quota_routing)
            // and replaces the sub-policy wholesale; an all-default or empty input
            // clears the override so the gate falls back to the defaults.
            const quotaRouting = setMeshQuotaRouting(args?.quotaRouting, requestedMeshId || undefined);
            const meshId = requestedMeshId || resolveScopedMeshId();
            // Keep the live views coherent: once any command has warmed the inline
            // cache, mesh_status / get_mesh serve from it — without refreshing it
            // here the dashboard would keep showing the pre-write thresholds (the
            // claim/launch gate itself reads meshes.json fresh via getMeshWithCache,
            // so it picks the new thresholds up on the next drain tick regardless).
            if (meshId) {
                const fresh = getMesh(meshId);
                if (fresh && ctx.getCachedInlineMesh(meshId)) ctx.inlineMeshCache.set(meshId, fresh);
                ctx.invalidateAggregateMeshStatus(meshId);
            }
            return {
                success: true,
                quotaRouting,
                resolved: resolveQuotaRoutingPolicy(quotaRouting),
                meshId: meshId ?? null,
            };
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
            const { addNode, migrateProviderRolesToSlots } = await import('../../config/mesh-config.js');
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
            const { updateNode, normalizeCapabilityTags, migrateProviderRolesToSlots, getMesh } = await import('../../config/mesh-config.js');
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
            // MAGI post-review auto-cleanup routes through this same command with
            // source:'magi_session_cleanup' and a per-session autoLaunchedForQueueTaskId
            // map, which gates cleanup to sessions THIS fan-out actually auto-launched.
            const source = args?.source === 'magi_session_cleanup' ? 'magi_session_cleanup' : 'mesh_cleanup_sessions';
            const requireAutoLaunchedForTaskIds = (args?.requireAutoLaunchedForTaskIds
                && typeof args.requireAutoLaunchedForTaskIds === 'object'
                && !Array.isArray(args.requireAutoLaunchedForTaskIds))
                ? args.requireAutoLaunchedForTaskIds as Record<string, string>
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
                source,
                requireAutoLaunchedForTaskIds,
                reclaimOrphans,
                liveMeshNodeIds,
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

            // Default worktree session cleanup ON: when the caller OMITS a mode and the
            // node is a local worktree, default to 'stop_and_delete' instead of the mesh
            // policy ('preserve' by default). A worktree's chat session has no reason to
            // outlive the worktree's node + directory + branch, and leaving it on
            // 'preserve' is what orphaned chats after a worktree remove. An explicit mode
            // (including an explicit 'preserve') is always honored — only the OMITTED case
            // changes, and only for worktrees. Base nodes keep arg ?? policy ?? preserve.
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
            // Precheck-first: for a LOCAL worktree removal, validate removability
            // with a purely non-destructive precheck BEFORE touching the session.
            // The session cleanup below is destructive and irreversible
            // (stop_and_delete), so a refusal that fires only AFTER it — as the old
            // ordering did when removeWorktree rejected a dirty worktree — orphaned
            // the delegated session. Running the precheck here means a refusal
            // (dirty worktree, missing/mismatched metadata, etc.) returns with the
            // session left fully intact. Remote-forwarded worktrees are prechecked
            // on the owning daemon (it runs this same handler), so we only gate the
            // local case here. Success/skip cases return ok:true and fall through to
            // the unchanged normal flow.
            if (node?.isLocalWorktree) {
                const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : undefined;
                const isRemoteWorktree = nodeDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.deps.statusInstanceId) && ctx.deps.dispatchMeshCommand
                    && !args?._meshDirectDispatch;
                if (!isRemoteWorktree) {
                    const precheck = await ctx.precheckLocalWorktreeRemovable({ mesh, node, nodeId, force: args?.force === true });
                    if (precheck.ok === false) {
                        return {
                            success: false,
                            removed: false,
                            code: precheck.code,
                            error: precheck.error,
                            recoveryHint: precheck.recoveryHint,
                            // No sessionCleanup key: the session was deliberately NOT
                            // touched. worktreeCleanup mirrors the destructive path's
                            // refusal shape so existing callers see the same code.
                            worktreeCleanup: { success: false, code: precheck.code, error: precheck.error, recoveryHint: precheck.recoveryHint },
                        };
                    }
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
            // Set only when the worktree was removed by its owning remote daemon and
            // this coordinator is reconciling its own membership copy afterwards.
            let remoteForwardedResult: Record<string, unknown> | undefined;
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
                    const forwardedResult = (forwarded ?? { success: false, error: 'no response from remote node' }) as Record<string, unknown>;
                    // MESH-REMOTE-REMOVE-MEMBERSHIP-DESYNC: the owning daemon ran this
                    // same handler and has already fixed ITS meshes.json. What it cannot
                    // do is fix OUR copy — this coordinator holds an independent
                    // membership record for the same node. Returning here (as this code
                    // used to) skipped the shared membership block below entirely, so the
                    // node stayed in the coordinator's meshes.json / inline cache and
                    // reappeared on the next mesh_status. Any in-memory splice a caller
                    // applied (e.g. mcp-server's optimistic one) was silently undone by
                    // the next read from the untouched persistent layer.
                    //
                    // Only the COORDINATOR-side membership is reconciled here; we never
                    // re-instruct the remote daemon, whose own removal already succeeded.
                    //
                    // Gating on explicit success: a forwarded failure (refusal, dirty
                    // worktree, transport error, no response) means the node is still
                    // alive on the owning machine. Splicing it out of the coordinator's
                    // membership then would hide a node that genuinely still exists —
                    // strictly worse than the desync we are fixing, because the operator
                    // loses the handle needed to retry. `removed !== false` mirrors the
                    // local path's own treatment of an already-absent node as removed.
                    const forwardedRemoved = forwardedResult.success === true && forwardedResult.removed !== false;
                    if (!forwardedRemoved) return forwardedResult as CommandRouterResult;
                    // Fall through to the shared membership/ledger/cache-invalidation
                    // block with the remote daemon's own cleanup detail preserved, so
                    // local and forwarded removals converge on identical bookkeeping.
                    remoteForwardedResult = forwardedResult;
                    worktreeCleanup = forwardedResult.worktreeCleanup !== null && typeof forwardedResult.worktreeCleanup === 'object'
                        ? forwardedResult.worktreeCleanup as Record<string, unknown>
                        : undefined;
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
                // MESH-INLINE-NODE-RESURRECTION: removeInlineMeshNode only mutates
                // the in-memory inlineMeshCache + tombstones — it does NOT touch
                // the file-backed config (meshes.json). When the SAME node also
                // lives in meshes.json (a worktree node that was persisted to the
                // file config, then resolved through the inline cache on removal),
                // the file record survives. On daemon restart the in-memory
                // tombstone is lost, getMesh falls back to the file config, and
                // mesh-status renders the dead node again. So a node present in
                // BOTH the inline cache AND meshes.json must be spliced+saved from
                // the file config here too. Pure-inline meshes (no matching file
                // mesh/node) are untouched — getMesh returns undefined and we skip.
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
                // MESH-MEMBERSHIP-INLINE-CACHE-SYNC: mirror-image of the inline
                // branch above. This mesh resolved from local_config (nothing had
                // warmed inlineMeshCache for it YET at getMeshForCommand time), but
                // another command (e.g. a cloud coordinator launch with inlineMesh)
                // may have already warmed the cache for this same meshId from an
                // earlier read. Splice the node out of the cached copy too, and
                // tombstone it, so a dashboard's stale inlineMesh echo cannot merge
                // the removed node back in (see removeInlineMeshNode's tombstone
                // comment).
                if (removed) {
                    const cachedMesh = ctx.getCachedInlineMesh(meshId);
                    if (cachedMesh) ctx.removeInlineMeshNode(meshId, cachedMesh, nodeId);
                }
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
                            // Distinguish a removal executed by a remote owning daemon
                            // (this entry records only the coordinator-side membership
                            // reconciliation) from a fully local one.
                            ...(remoteForwardedResult ? { removedByRemoteDaemon: true } : {}),
                            sessionCleanupMode,
                            workspace: typeof node?.workspace === 'string' ? node.workspace : undefined,
                            daemonId: typeof node?.daemonId === 'string' ? node.daemonId : undefined,
                            worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                            worktreeCleanupFallback: typeof worktreeCleanup?.fallback === 'string' ? worktreeCleanup.fallback : undefined,
                            forced: worktreeCleanup?.forced === true ? true : undefined,
                            forceFallbackReason: typeof worktreeCleanup?.reason === 'string' ? worktreeCleanup.reason : undefined,
                            branchRefDeleted: typeof worktreeCleanup?.branchRefDeleted === 'boolean' ? worktreeCleanup.branchRefDeleted : undefined,
                            branchRefReason: typeof worktreeCleanup?.branchRefReason === 'string' ? worktreeCleanup.branchRefReason : undefined,
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

            // Surface a preserved-branch warning at the top level so callers see
            // that the branch ref was intentionally NOT deleted (unmerged work is
            // never silently dropped). When the branch ref WAS deleted, the nested
            // worktreeCleanup.branchRefDeleted flag already records it.
            const branchRefWarning = typeof worktreeCleanup?.branchRefWarning === 'string'
                ? worktreeCleanup.branchRefWarning
                : undefined;

            // Orphan guard: if the session cleanup still left any LIVE session skipped
            // (e.g. a future skip reason, or a workspace-only session on a base node),
            // surface it at the top level so the caller knows a manual mesh_cleanup_sessions
            // is still required for those sessionIds. Without this, a skipped-live session
            // silently outlives a removed node (the very NODE-REMOVE-SESSION-ORPHAN bug).
            const skippedLiveSessionIds = Array.isArray(sessionCleanup?.skippedLiveSessionIds)
                ? (sessionCleanup!.skippedLiveSessionIds as unknown[]).filter((v): v is string => typeof v === 'string')
                : [];
            const orphanedSessionsRemaining = skippedLiveSessionIds.length > 0;
            const orphanNextAction = orphanedSessionsRemaining
                ? `Live session(s) [${skippedLiveSessionIds.join(', ')}] were skipped and still survive this node removal. `
                    + `Run mesh_cleanup_sessions with mode:'stop_and_delete' and sessionIds:[${skippedLiveSessionIds.map(id => `'${id}'`).join(', ')}] to release them.`
                : undefined;
            return {
                // Remote-forwarded removal: start from the owning daemon's own response
                // so its detail fields survive, then overlay this coordinator's
                // membership bookkeeping (removed/ledger/cache) computed above.
                ...(remoteForwardedResult ?? {}),
                success: true,
                removed,
                ...(residueWarning ? { residueWarning } : {}),
                ...(branchRefWarning ? { branchRefWarning } : {}),
                ...(sessionCleanup ? { sessionCleanup } : {}),
                ...(worktreeCleanup ? { worktreeCleanup } : {}),
                ...(orphanedSessionsRemaining
                    ? { orphanedSessionsRemaining: true, nextAction: orphanNextAction }
                    : {}),
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
                // REMOTE-CLONE-CACHE-SEED: register the remotely-created node in THIS
                // coordinator's inline cache immediately, mirroring what the local clone branch
                // below already does via updateInlineMeshNode/addNode.
                //
                // Without this the node was visible to every read TOOL yet permanently invisible
                // to the QUEUE: the scheduler (mesh-queue-assignment getMeshWithCache) is a purely
                // passive cache reader with no network call, while the read tools actively refresh
                // (refreshMeshFromDaemon) and mesh_git_status fans out over P2P. Cache reflection
                // therefore rested entirely on the one-shot `worktree_bootstrap_complete` P2P push,
                // which has neither retry nor periodic resync — a single dropped event stranded the
                // node forever (`target_node_id_unmatched` / `no_node_satisfies_required_tags`),
                // observed on two machines including one that had already finished bootstrap.
                //
                // The forwarded reply carries the FULL node the remote daemon registered — the
                // scheduling identity (daemonId, machineId, policy, userOverrides, workspace,
                // worktreeBranch) that the bootstrap event's minimal hydrate-on-miss shell lacks.
                // seedRemoteClonedWorktreeNode merges order-independently with that hydrate, so
                // whichever of the two lands first, the node ends up both addressable and
                // correctly gated (see its doc comment for the ordering argument).
                const forwardedNode = (forwarded as { node?: unknown } | null | undefined)?.node;
                const forwardedNodeId = normalizeMeshNodeId(forwardedNode as any);
                if (forwardedNode && forwardedNodeId) ctx.seedRemoteClonedWorktreeNode(meshId, forwardedNode);
                // FALSE-BLOCKER-CLONE-QUEUE: also open the transient grace window. The seed above
                // makes the node addressable, but its bootstrap may still be 'running' on the
                // remote machine, so a task pinned to it can still transiently defer — that skip
                // must stay classified as transient rather than a permanent actionable blocker.
                if (forwardedNodeId) noteRecentlyClonedNode(forwardedNodeId);
                return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
            }

            const repoRoot = sourceNode.repoRoot || sourceNode.workspace;
            // Mesh-policy override for where worktrees are physically placed. When
            // unset, createWorktree defaults to <home>/.adhdev/worktrees. The cleanup
            // guard resolves the same base from mesh.policy, so the override must stay
            // set on the mesh for the node's lifetime.
            const worktreeBaseDir = typeof mesh.policy?.worktreeBaseDir === 'string' && mesh.policy.worktreeBaseDir.trim()
                ? mesh.policy.worktreeBaseDir.trim()
                : undefined;
            const { createWorktree } = await import('../../git/git-worktree.js');
            const result = await createWorktree({
                repoRoot,
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

            let node: any;
            const { migrateProviderRolesToSlots } = await import('../../config/mesh-config.js');
            if (meshRecord.inline) {
                const { randomUUID } = await import('crypto');
                const clonedPolicy: Record<string, unknown> = { ...(sourceNode.policy || {}) };
                // Defensive: a source policy that still carries the removed legacy
                // providerRoles (e.g. an inline node not yet load-migrated) has its cap
                // folded into slots so the clone never re-seeds providerRoles.
                migrateProviderRolesToSlots(clonedPolicy);
                node = {
                    id: `node_${randomUUID().replace(/-/g, '')}`,
                    workspace: result.worktreePath,
                    repoRoot: result.worktreePath,
                    daemonId: sourceNode.daemonId,
                    machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                    userOverrides: { ...(sourceNode.userOverrides || {}) },
                    policy: clonedPolicy as any,
                    isLocalWorktree: true,
                    worktreeBranch: result.branch,
                    clonedFromNodeId: sourceNodeId,
                };
                ctx.updateInlineMeshNode(meshId, mesh, node);
                // NODE-MEMBERSHIP-SHRINK-ON-MERGE (durability half): the inline
                // branch used to register the clone ONLY in the in-memory inline
                // cache. That cache-only node had no durable twin, so a daemon
                // restart (or, before the reconcile fix above, a stale-timestamped
                // merge) lost it with no recovery path. Best-effort also persist to
                // meshes.json when this meshId has a config-file twin — a pure
                // inline mesh (cloud-originating, no local config mesh) has no such
                // twin, so addNode returns undefined and this is a silent no-op;
                // the node still lives on in the inline cache as before, now
                // additionally protected by the union-merge fix.
                try {
                    const { addNode: addDurableNode } = await import('../../config/mesh-config.js');
                    addDurableNode(meshId, {
                        id: node.id,
                        workspace: result.worktreePath,
                        repoRoot: result.worktreePath,
                        daemonId: sourceNode.daemonId,
                        machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                        userOverrides: { ...(sourceNode.userOverrides || {}) },
                        isLocalWorktree: true,
                        worktreeBranch: result.branch,
                        clonedFromNodeId: sourceNodeId,
                        policy: clonedPolicy as any,
                    });
                } catch { /* no config-file twin for this mesh (pure inline/cloud mesh) — inline cache remains source of truth */ }
            } else {
                const { addNode } = await import('../../config/mesh-config.js');
                const clonedPolicy: Record<string, unknown> = { ...(sourceNode.policy || {}) };
                migrateProviderRolesToSlots(clonedPolicy);
                node = addNode(meshId, {
                    workspace: result.worktreePath,
                    repoRoot: result.worktreePath,
                    daemonId: sourceNode.daemonId,
                    machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                    userOverrides: { ...(sourceNode.userOverrides || {}) },
                    isLocalWorktree: true,
                    worktreeBranch: result.branch,
                    clonedFromNodeId: sourceNodeId,
                    policy: clonedPolicy as any,
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

            // FALSE-BLOCKER-CLONE-QUEUE: open the transient grace window for the freshly cloned
            // node. A queue task pinned to it (target_node pin) enqueued before bootstrap
            // completes / the inline-cache entry fully settles must be classified as a transient
            // skip, not a permanent 'target_node_id_unmatched' actionable blocker.
            if (typeof node?.id === 'string' && node.id) noteRecentlyClonedNode(node.id);

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
            // Read the worktree bootstrap config through the unified RepoSettings
            // loader (file-separated `.adhdev/worktree_bootstrap.json`; machine-local
            // inline seam honored). runMeshWorktreeBootstrap below re-loads it to run.
            const loadedBootstrap = loadRepoSettings({ workspace: result.worktreePath, mesh }).worktreeBootstrap;
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

                        // Sync every registered submodule to the clone source node's
                        // working HEAD (best-effort, generic over .gitmodules — no
                        // hardcoded 'oss'; the rewind guard is applied per submodule).
                        const sourceWorkspace = sourceNode.repoRoot || sourceNode.workspace;
                        if (sourceWorkspace) {
                            const { runGit: rg } = await import('../../git/git-executor.js');
                            await syncClonedWorktreeSubmodules(result.worktreePath, sourceWorkspace, rg);
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
                    ...(result.baseSync ? { baseSync: result.baseSync } : {}),
                    ...(result.baseSync?.warning ? { baseStaleWarning: result.baseSync.warning } : {}),
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
