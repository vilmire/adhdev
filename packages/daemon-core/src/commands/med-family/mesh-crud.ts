/**
 * RF-ROUTER MED family — mesh CRUD + node CRUD commands.
 *
 * This module holds the mesh-record commands (list/get/create/update/delete_mesh,
 * mesh host, repo mesh.json config, provider defaults, MAGI kind panels,
 * difficulty brains, quota routing); get_mesh hydrates direct git truth. The node
 * lifecycle (add/update/remove_mesh_node, cleanup_mesh_sessions) lives in
 * mesh-node-lifecycle.ts and clone / bootstrap retry in mesh-node-clone.ts; all
 * three handler maps merge into meshCrudHandlers below. The inline-cache,
 * session/worktree cleanup and aggregate-status collaborators come from ctx.
 */
import { DEFAULT_QUOTA_ROUTING_POLICY, resolveQuotaRoutingPolicy } from '../../repo-mesh-types.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { getMachineId } from '../../config/config.js';
import { hydrateInlineMeshDirectTruth } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';
import { hydrateMeshNodesFromGitState } from '../high-family/mesh-status-node-state.js';
import { meshNodeLifecycleHandlers } from './mesh-node-lifecycle.js';
import { meshNodeCloneHandlers } from './mesh-node-clone.js';
// Re-exported: tests and mesh-graph-workspace-ports import the clone sync helpers from here.
export { decideOssCloneSync, syncClonedWorktreeSubmodules, type OssCloneSyncAction } from './mesh-node-clone.js';

const meshRecordHandlers: Record<string, MedFamilyHandler> = {
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
        const localMachineId = getMachineId() || '';
        // MCP read-latency pass: a membership-only read (the MCP's per-tool-call
        // snapshot refresh) skips the local git hydration and the per-node git blob
        // entirely — see mesh/mesh-membership-projection.ts. Not combinable with a
        // direct-truth requirement (that IS a git question), which keeps the full path.
        if (args?.membershipOnly === true && !requireDirectPeerTruth) {
            const { projectMeshMembershipOnly } = await import('../../mesh/mesh-membership-projection.js');
            const { buildFreshLocalNodeFacts } = await import('../../mesh/mesh-node-identity.js');
            return {
                success: true,
                mesh: projectMeshMembershipOnly(meshRecord.mesh, {
                    localMachineId,
                    localDaemonId: ctx.deps.statusInstanceId,
                    localNodeFacts: buildFreshLocalNodeFacts,
                }),
                membershipOnly: true,
            };
        }
        // Remote nodes carry the coordinator-HELD git (member pushes), never a live
        // fan-out: `refresh` / `forceRefresh` no longer probe peers here — a member
        // pushes its state to the coordinator, which answers from the store.
        if (ctx.deps.dispatchMeshCommand && ctx.meshNodeGitState) {
            hydrateMeshNodesFromGitState({
                meshId,
                mesh: meshRecord.mesh,
                store: ctx.meshNodeGitState,
                locality: { localMachineId, localDaemonId: ctx.deps.statusInstanceId },
            });
        }
        const directTruth = await hydrateInlineMeshDirectTruth({
            mesh: meshRecord.mesh,
            meshSource: meshRecord.source,
            statusInstanceId: ctx.deps.statusInstanceId,
            localMachineId,
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
        let defaultBranch = typeof args?.defaultBranch === 'string' ? args.defaultBranch.trim() : undefined;
        if (!name) return { success: false, error: 'name required' };
        if (!defaultBranch) {
            // Auto-detect (F18/root-axis): callers that go through the onboarding
            // planner already supply defaultBranch (mesh-onboarding-plan.ts always
            // resolves it into createArgs); this covers a DIRECT create_mesh call
            // with no explicit branch, so a master-default repo does not silently
            // inherit the 'main' fallback every downstream reader applies when the
            // field is absent. Best-effort: detection failure must not block mesh
            // creation, so an unresolved workspace/repo just leaves the field unset.
            try {
                const { resolveRootDefaultBranch } = await import('../../mesh/mesh-onboarding-plan.js');
                const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
                const detected = await resolveRootDefaultBranch(workspace, undefined);
                if (detected) defaultBranch = detected;
            } catch { /* best-effort detection only */ }
        }
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
            const { setMagiKindPanel, resolveScopedMeshId, collectIgnoredMagiSlotFields } = await import('../../config/mesh-config.js');
            // normalizeMagiTaskKindKey + normalizeMagiSlots (inside setMagiKindPanel)
            // validate the kind and each slot (provider required; model optional;
            // replica counts clamped; nodeId must belong to the target mesh).
            // Structured errors flow back as `error`.
            //
            // Collect the dropped keys BEFORE the write: the normalizer silently ignores
            // anything outside the MagiSlot schema (a deliberate reduction — see MagiSlot
            // in mesh-shared), which used to mean an operator could set `thinkingLevel`
            // here and get no effect and no warning. Reported, never thrown, so a payload
            // carrying an unknown key still writes exactly as before.
            const ignoredFields = collectIgnoredMagiSlotFields(args?.slots);
            const slots = setMagiKindPanel(kind, args?.slots, requestedMeshId || undefined);
            const meshId = requestedMeshId || resolveScopedMeshId();
            return {
                success: true,
                kind,
                slots,
                meshId: meshId ?? null,
                ...(ignoredFields.length ? { ignoredFields } : {}),
            };
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
};

// Key order is the command order the specs below were declared against: mesh
// records first, then node lifecycle (mesh-node-lifecycle.ts), then clone +
// bootstrap retry (mesh-node-clone.ts).
export const meshCrudHandlers: Record<string, MedFamilyHandler> = {
    ...meshRecordHandlers,
    ...meshNodeLifecycleHandlers,
    ...meshNodeCloneHandlers,
};

export const meshCrudSpecs = defineCommandSpecs('med', meshCrudHandlers, {
    add_mesh_node: { invalidates: ['daemon.metadata'] },
    update_mesh_node: { invalidates: ['daemon.metadata'] },
    // DASHBOARD-GHOST-LINGER: deleted sessions linger as ghost rows until the next
    // heartbeat without an immediate daemon.metadata flush.
    cleanup_mesh_sessions: { invalidates: ['daemon.metadata'] },
    remove_mesh_node: { invalidates: ['daemon.metadata'], meshSender: 'any_member_mesh' },
    clone_mesh_node: { invalidates: ['daemon.metadata'], meshSender: 'any_member_mesh' },
    retry_mesh_node_bootstrap: { meshSender: 'any_member_mesh' },
}, { meshSender: 'authenticated_peer' });
