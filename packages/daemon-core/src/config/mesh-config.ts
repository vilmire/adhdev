/**
 * Repo Mesh Config — Local mesh configuration stored in ~/.adhdev/meshes.json
 *
 * Manages repo mesh definitions for OSS standalone mode.
 * Cloud mode syncs these to D1 via server routes; standalone mode
 * uses this file as the single source of truth.
 */

import { randomUUID, createHash } from 'crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { readLocalRecords } from '../mesh/mesh-local-records.js';
import { selectOpenRefineDispatches } from '../mesh/mesh-refine-zombie-sweep.js';
import { pendingLaunchReservation } from '../mesh/mesh-task-routing-contract.js';
import { attestLocalOwnership } from '../mesh/mesh-physical-ownership.js';
import { getMachineNickname } from './config.js';
import type {
    AssistantRemoteAccessBinding,
    LocalMeshEntry,
    LocalMeshNodeEntry,
    RepoMeshPolicy,
    RepoMeshNodePolicy,
    RepoMeshNodeCapabilities,
    RepoMeshCoordinatorConfig,
    RepoMeshHostMetadata,
    RepoMeshDaemonRole,
    MeshReportedMemberState,
} from '../repo-mesh-types.js';
import {
    ASSISTANT_ACCOUNT_SLOT,
    ASSISTANT_FOLLOWER_ALLOWED_OPS,
    canonicalDaemonId,
    daemonIdsEquivalent,
    isAssistantFollowerAllowedOp,
} from '@adhdev/mesh-shared';
import { mergePolicyOverrides, normalizePolicyOverrides, MESH_POLICY_STORAGE_VERSION } from '../repo-mesh-types.js';
import { resolveMeshHostStatus, createDefaultMeshHostMetadata } from '../mesh/mesh-host-ownership.js';
import { withStrictMeshConfigWriteLock, readMeshConfigFromDisk, saveMeshConfigDurable, withMeshConfigWriteLock, loadMeshConfigEntry, loadMeshConfig, normalizeCapabilityTags, saveMeshConfig, normalizeRepoIdentity, peekMeshNodes } from './mesh-config-store.js';
import { assertMeshNodeCapacity } from './mesh-node-limit.js';
import { stripRemovedCoordinatorPromptFields } from './mesh-json-config.js';
import { selectReportedQuotaFacts } from '../quota/reported-snapshot.js';

/**
 * Strictly validate a persisted `assistantRemoteAccess` binding from `meshes.json`.
 * Returns `null` when absent, malformed, or carrying an invalid revision/status/slot
 * so callers fail closed on corrupt ACL state.
 */
export function normalizeAssistantRemoteAccessBinding(
    raw: unknown,
    expectedMeshId?: string,
): AssistantRemoteAccessBinding | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const rawHostDaemonId = typeof rec.hostDaemonId === 'string' ? rec.hostDaemonId.trim() : '';
    const meshId = typeof rec.meshId === 'string' ? rec.meshId.trim() : '';
    const rawActiveDaemonId = typeof rec.activeDaemonId === 'string' ? rec.activeDaemonId.trim() : '';
    if (!rawHostDaemonId || !meshId || !rawActiveDaemonId) return null;
    if (expectedMeshId && meshId !== expectedMeshId) return null;
    if (rec.accountSlot !== ASSISTANT_ACCOUNT_SLOT) return null;
    const status = rec.status === 'active' || rec.status === 'revoked' ? rec.status : null;
    if (!status) return null;
    const hostDaemonId = canonicalDaemonId(rawHostDaemonId);
    const activeDaemonId = canonicalDaemonId(rawActiveDaemonId);
    if (!hostDaemonId || !hostDaemonId.startsWith('daemon_mach_')) return null;
    if (status === 'active') {
        if (!activeDaemonId || !activeDaemonId.startsWith('daemon_mach_')) return null;
        if (daemonIdsEquivalent(hostDaemonId, activeDaemonId)) return null;
    }
    const bindingRevision = typeof rec.bindingRevision === 'number' && Number.isInteger(rec.bindingRevision) && rec.bindingRevision >= 1
        ? rec.bindingRevision
        : null;
    const grantRevision = typeof rec.grantRevision === 'number' && Number.isInteger(rec.grantRevision) && rec.grantRevision >= 1
        ? rec.grantRevision
        : null;
    if (bindingRevision === null || grantRevision === null) return null;
    const grantedAt = typeof rec.grantedAt === 'number' && Number.isFinite(rec.grantedAt) && rec.grantedAt > 0
        ? rec.grantedAt
        : null;
    if (grantedAt === null) return null;
    const revokedAt = typeof rec.revokedAt === 'number' && Number.isFinite(rec.revokedAt) && rec.revokedAt > 0
        ? rec.revokedAt
        : undefined;
    const rawOps = Array.isArray(rec.allowedOps) ? rec.allowedOps : ASSISTANT_FOLLOWER_ALLOWED_OPS;
    // Artifact reading is explicit opt-in: a missing field (pre-existing grant) never grants it (the flag is enforced in the ACL check; ops are only auto-added when true).
    const allowArtifactRead = rec.allowArtifactRead === true;
    const allowedOps = rawOps.filter(isAssistantFollowerAllowedOp);
    if (allowedOps.length === 0) return null;
    const allowCoordinatorLaunch = rec.allowCoordinatorLaunch !== false;
    if (allowArtifactRead && allowedOps.includes('read')) {
        if (!allowedOps.includes('artifact_list')) allowedOps.push('artifact_list');
        if (!allowedOps.includes('artifact_read')) allowedOps.push('artifact_read');
    }
    return {
        hostDaemonId,
        meshId,
        accountSlot: ASSISTANT_ACCOUNT_SLOT,
        activeDaemonId: activeDaemonId ?? rawActiveDaemonId,
        bindingRevision,
        grantRevision,
        status,
        allowedOps,
        allowCoordinatorLaunch,
        allowArtifactRead,
        grantedAt,
        ...(revokedAt !== undefined ? { revokedAt } : {}),
    };
}

// ─── CRUD Operations ────────────────────────────

// policy.drivers?: Record<type, { actions: string[] }> is defined by RepoMeshPolicy (optional restriction; no entry for a type = all declared actions of an owner-activated driver are allowed).
// Policy storage is SPARSE (docs/design/2026-10-07-mesh-workspace-policy.md §A):
// create stores normalizePolicyOverrides(opts.policy), update applies the patch via
// mergePolicyOverrides (`null` clears a key). Readers resolve through resolveMeshPolicy.

/**
 * Count of `listMeshes()` calls that actually reached disk (readFileSync +
 * JSON.parse + migration rebuild). Test-only instrumentation for the reconcile
 * tick's per-tick read budget — see test/mesh/mesh-reconcile-listmeshes-budget.test.ts.
 *
 * Incremented in `listMeshes` rather than in `loadMeshConfig` on purpose: the
 * budget being asserted is "how many times does ONE reconcile tick re-read
 * meshes.json", and mutators (createMesh/updateMesh) legitimately load under a
 * write lock without being part of that budget.
 */
let listMeshesDiskReadCount = 0;

export function listMeshes(): LocalMeshEntry[] {
    listMeshesDiskReadCount++;
    return loadMeshConfig().meshes;
}

/** Read-only inventory snapshot for discovery/planning surfaces. */
export function listMeshesReadOnly(): LocalMeshEntry[] {
    return loadMeshConfig({ persistMigrations: false }).meshes;
}

export function getMesh(meshId: string): LocalMeshEntry | undefined {
    return loadMeshConfigEntry(meshId);
}

/** Read-only node list of one mesh from the cached snapshot (no clone) — see peekMeshNodes. */
export function getMeshNodesReadonly(meshId: string): readonly unknown[] | undefined {
    return peekMeshNodes(meshId);
}

export function getMeshByRepo(repoIdentity: string): LocalMeshEntry | undefined {
    const normalized = normalizeRepoIdentity(repoIdentity);
    return loadMeshConfig().meshes.find(m => normalizeRepoIdentity(m.repoIdentity) === normalized);
}

export interface CreateMeshOptions {
    name: string;
    repoRemoteUrl?: string;
    repoIdentity?: string;
    defaultBranch?: string;
    policy?: Partial<RepoMeshPolicy>;
    coordinator?: RepoMeshCoordinatorConfig;
    meshHost?: RepoMeshHostMetadata;
    /**
     * HOST-PIN-WRITER: the daemon creating this mesh, recorded as its host pin.
     *
     * A mesh is created BY the daemon that will host it, so the host is known at
     * creation — the one moment it is knowable without guessing. Persisting it here is
     * what stops meshes being born pin-less (the root of this defect class): with no pin,
     * every peer synthesizes itself as host on read and the answer depends on which
     * daemon was asked. Omitted (legacy/unknown callers) still yields a valid role-only
     * host mesh, exactly as before.
     */
    hostDaemonId?: string;
}

export function createMesh(...args: Parameters<typeof createMeshUnlocked>): ReturnType<typeof createMeshUnlocked> {
    return withMeshConfigWriteLock(() => createMeshUnlocked(...args));
}

function createMeshUnlocked(opts: CreateMeshOptions): LocalMeshEntry {
    const config = loadMeshConfig();

    if (config.meshes.length >= 20) {
        throw new Error('Maximum 20 meshes allowed');
    }

    const repoIdentity = normalizeRepoIdentity(opts.repoIdentity || opts.repoRemoteUrl || '');
    if (!repoIdentity) throw new Error('Either repoRemoteUrl or repoIdentity is required');

    const now = new Date().toISOString();
    const mesh: LocalMeshEntry = {
        id: `mesh_${randomUUID().replace(/-/g, '')}`,
        name: opts.name.trim().slice(0, 100),
        repoIdentity,
        repoRemoteUrl: opts.repoRemoteUrl,
        defaultBranch: opts.defaultBranch,
        policy: normalizePolicyOverrides(opts.policy),
        policyStorage: MESH_POLICY_STORAGE_VERSION,
        coordinator: stripRemovedCoordinatorPromptFields(opts.coordinator) || {},
        meshHost: opts.meshHost || (() => {
            const base = createDefaultMeshHostMetadata();
            const creatingDaemonId = typeof opts.hostDaemonId === 'string' ? opts.hostDaemonId.trim() : '';
            // The creating daemon IS the host — pin it now (see CreateMeshOptions.hostDaemonId).
            return creatingDaemonId ? { ...base, hostDaemonId: creatingDaemonId } : base;
        })(),
        nodes: [],
        createdAt: now,
        updatedAt: now,
    };

    config.meshes.push(mesh);
    saveMeshConfig(config);
    return mesh;
}

export interface UpdateMeshOptions {
    name?: string;
    defaultBranch?: string;
    /** Policy PATCH: a key sets that override, `null` resets it to the default. */
    policy?: { [K in keyof RepoMeshPolicy]?: RepoMeshPolicy[K] | null } & Record<string, unknown>;
    coordinator?: RepoMeshCoordinatorConfig;
    meshHost?: RepoMeshHostMetadata;
}

export function updateMesh(...args: Parameters<typeof updateMeshUnlocked>): ReturnType<typeof updateMeshUnlocked> {
    return withMeshConfigWriteLock(() => updateMeshUnlocked(...args));
}

function updateMeshUnlocked(meshId: string, opts: UpdateMeshOptions): LocalMeshEntry | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    if (opts.name !== undefined) mesh.name = opts.name.trim().slice(0, 100);
    if (opts.defaultBranch !== undefined) mesh.defaultBranch = opts.defaultBranch;
    if (opts.policy) {
        mesh.policy = mergePolicyOverrides(mesh.policy, opts.policy);
        mesh.policyStorage = MESH_POLICY_STORAGE_VERSION;
    }
    if (opts.coordinator) mesh.coordinator = stripRemovedCoordinatorPromptFields(opts.coordinator);
    if (opts.meshHost) mesh.meshHost = opts.meshHost;
    mesh.updatedAt = new Date().toISOString();

    saveMeshConfig(config);
    return mesh;
}

export function deleteMesh(...args: Parameters<typeof deleteMeshUnlocked>): ReturnType<typeof deleteMeshUnlocked> {
    return withMeshConfigWriteLock(() => deleteMeshUnlocked(...args));
}

function deleteMeshUnlocked(meshId: string): boolean {
    const config = loadMeshConfig();
    const idx = config.meshes.findIndex(m => m.id === meshId);
    if (idx === -1) return false;
    config.meshes.splice(idx, 1);
    saveMeshConfig(config);
    return true;
}

// ─── Node Operations ────────────────────────────

export interface AddNodeOptions {
    workspace: string;
    repoRoot?: string;
    daemonId?: string;
    machineId?: string;
    capabilities?: string[];
    userOverrides?: Partial<RepoMeshNodeCapabilities>;
    policy?: RepoMeshNodePolicy;
    isLocalWorktree?: boolean;
    worktreeBranch?: string;
    clonedFromNodeId?: string;
    worktreeBootstrap?: LocalMeshNodeEntry['worktreeBootstrap'];
    role?: RepoMeshDaemonRole;
    /** Owning daemon's machine nickname. Defaults to this daemon's local
     *  config.machineNickname when omitted — a node is always added by (and on)
     *  the daemon that owns its workspace (self/base node or a local worktree
     *  clone), so the local config is the correct source. */
    machineNickname?: string;
    /** Owning daemon's platform/arch (raw process.platform/process.arch), stamped at
     *  creation so os=/arch= capability tags are right before the first probe. */
    reportedPlatform?: string;
    reportedArch?: string;
    /** The node is owned by ANOTHER daemon (a remote-cloned worktree registered on
     *  the coordinator): never fall back to this daemon's own nickname. */
    ownerIsRemote?: boolean;
    /** Caller-supplied node id (e.g. an id already minted for an inline-cache
     *  node) so a durable config-file twin shares the SAME id as its inline
     *  counterpart. Without this, addNode mints its own id and the two
     *  representations of "the same node" would carry different ids, breaking
     *  id-keyed reconciliation between the inline cache and meshes.json.
     *  Omitted → a fresh id is minted as before (default, unchanged behavior). */
    id?: string;
}

export function addNode(...args: Parameters<typeof addNodeUnlocked>): ReturnType<typeof addNodeUnlocked> {
    return withMeshConfigWriteLock(() => addNodeUnlocked(...args));
}

function addNodeUnlocked(meshId: string, opts: AddNodeOptions): LocalMeshNodeEntry | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    // The mesh's policy.maxNodes (base + worktree nodes alike). Throws a MeshNodeLimitError
    // carrying the count, the limit, how to raise it and the worktree nodes that could
    // free a slot — see ./mesh-node-limit.ts.
    assertMeshNodeCapacity(mesh);

    // Check duplicate workspace
    if (mesh.nodes.some(n => n.workspace === opts.workspace)) {
        throw new Error('This workspace is already in the mesh');
    }

    // A node is always added by the daemon that owns its workspace (the self/base
    // node, or a local worktree clone spawned from this daemon), so this daemon's
    // config.machineNickname is the correct owner nickname. Explicit opt wins.
    const machineNickname = (() => {
        const explicit = typeof opts.machineNickname === 'string' ? opts.machineNickname.trim() : '';
        if (explicit) return explicit;
        if (opts.ownerIsRemote === true) return undefined;
        try {
            const local = getMachineNickname();
            return typeof local === 'string' && local.trim() ? local.trim() : undefined;
        } catch {
            return undefined;
        }
    })();

    const node: LocalMeshNodeEntry = {
        id: (typeof opts.id === 'string' && opts.id.trim()) ? opts.id.trim() : `node_${randomUUID().replace(/-/g, '')}`,
        workspace: opts.workspace.trim(),
        repoRoot: opts.repoRoot,
        daemonId: opts.daemonId,
        machineId: opts.machineId,
        ...(machineNickname ? { machineNickname } : {}),
        ...(opts.reportedPlatform?.trim() ? { reportedPlatform: opts.reportedPlatform.trim() } : {}),
        ...(opts.reportedArch?.trim() ? { reportedArch: opts.reportedArch.trim() } : {}),
        capabilities: normalizeCapabilityTags(opts.capabilities),
        userOverrides: opts.userOverrides || {},
        policy: opts.policy || {},
        isLocalWorktree: opts.isLocalWorktree,
        worktreeBranch: opts.worktreeBranch,
        clonedFromNodeId: opts.clonedFromNodeId,
        worktreeBootstrap: opts.worktreeBootstrap,
        role: opts.role,
    };

    // HOST-PIN-WRITER: when this node belongs to the mesh's pinned host daemon and the
    // pin still has no node anchor, adopt it. createMesh pins the host daemon before any
    // node exists, so the anchor can only be filled once the host attaches a workspace —
    // this is that moment. Only fills a MISSING anchor: an existing hostNodeId is a
    // settled assignment and is never re-pointed here.
    const pinnedHostDaemonId = typeof mesh.meshHost?.hostDaemonId === 'string' ? mesh.meshHost.hostDaemonId.trim() : '';
    const anchorMissing = !(typeof mesh.meshHost?.hostNodeId === 'string' && mesh.meshHost.hostNodeId.trim());
    if (!node.role
        && anchorMissing
        && pinnedHostDaemonId
        && mesh.meshHost?.role !== 'member'
        && node.daemonId
        && daemonIdsEquivalent(node.daemonId, pinnedHostDaemonId)
        && !mesh.nodes.some(n => n.role === 'host')) {
        node.role = 'host';
        mesh.meshHost = { ...(mesh.meshHost || createDefaultMeshHostMetadata()), hostNodeId: node.id };
    }

    mesh.nodes.push(node);
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(config);
    return node;
}

export function removeNode(...args: Parameters<typeof removeNodeUnlocked>): ReturnType<typeof removeNodeUnlocked> {
    return withMeshConfigWriteLock(() => removeNodeUnlocked(...args));
}

function removeNodeUnlocked(meshId: string, nodeId: string): boolean {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return false;

    const idx = mesh.nodes.findIndex(n => n.id === nodeId);
    if (idx === -1) return false;

    mesh.nodes.splice(idx, 1);
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(config);
    return true;
}

export function updateNode(
    ...args: Parameters<typeof updateNodeUnlocked>
): ReturnType<typeof updateNodeUnlocked> {
    return withMeshConfigWriteLock(() => updateNodeUnlocked(...args));
}

function updateNodeUnlocked(
    meshId: string,
    nodeId: string,
    opts: {
        userOverrides?: Partial<RepoMeshNodeCapabilities>;
        policy?: RepoMeshNodePolicy;
        /** Operator-defined custom capability tags used by mesh queue matching.
         *  Passing an array replaces the node's custom tags (empty/whitespace
         *  entries dropped, deduped); an empty result clears them. Omit to leave
         *  the existing tags untouched. */
        capabilities?: string[];
        worktreeBootstrap?: LocalMeshNodeEntry['worktreeBootstrap'];
        /** Per-node instruction surfaced in the coordinator prompt. Pass an
         *  empty string or undefined to clear it. */
        systemPrompt?: string;
        /** Live self-reported platform/arch from the owning daemon's git_status
         *  envelope. Persisted distinctly from userOverrides (auto-detected, not
         *  operator intent) so capability-tag os=/arch= self-heals across loads. */
        reportedPlatform?: string;
        reportedArch?: string;
        /** Owning daemon's self-reported machine nickname, carried on the
         *  git_status envelope. Persisted so the friendly label survives across
         *  coordinator restarts (mirrors reportedPlatform/reportedArch). */
        reportedMachineNickname?: string;
        /** Owning daemon's self-reported provider CLI versions + build version,
         *  carried on the git_status envelope. Persisted distinctly from userOverrides
         *  (auto-detected observability, not operator intent), mirroring the
         *  reportedPlatform/reportedArch self-heal so the value survives restarts and
         *  is overwritten by the next report. */
        reportedProviderVersions?: Record<string, string>;
        reportedDaemonBuildVersion?: string;
        /** Unified mirrored member state (per-machine runtime facts: provider versions
         *  + daemon build + lastReportedAt) self-reported by the owning daemon on the
         *  git_status envelope. Persisted wholesale so a remote node's version chips
         *  survive a coordinator restart, mirroring the per-field reported* self-heal.
         *  Slots are NOT carried — they are coordinator-owned config
         *  (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix). */
        reportedMemberState?: MeshReportedMemberState;
        /** Versioned runtime-facts bundle — whole-object replace, opaque. */
        nodeFacts?: import('@adhdev/mesh-shared').MeshNodeFacts;
    },
): LocalMeshNodeEntry | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    const node = mesh.nodes.find(n => n.id === nodeId);
    if (!node) return undefined;

    if (opts.userOverrides) node.userOverrides = { ...node.userOverrides, ...opts.userOverrides };
    if (opts.reportedPlatform && opts.reportedPlatform.trim()) node.reportedPlatform = opts.reportedPlatform.trim();
    if (opts.reportedArch && opts.reportedArch.trim()) node.reportedArch = opts.reportedArch.trim();
    if (opts.reportedMachineNickname && opts.reportedMachineNickname.trim()) node.machineNickname = opts.reportedMachineNickname.trim();
    if (opts.reportedProviderVersions && Object.keys(opts.reportedProviderVersions).length > 0) {
        node.reportedProviderVersions = { ...opts.reportedProviderVersions };
    }
    if (opts.reportedDaemonBuildVersion && opts.reportedDaemonBuildVersion.trim()) {
        node.reportedDaemonBuildVersion = opts.reportedDaemonBuildVersion.trim();
    }
    if (opts.reportedMemberState) {
        // Whole-object replace (auto-detected observability, overwritten by the next
        // report so a stale mirror never sticks — same policy as the flat reported*
        // fields). normalizeReportedMemberState upstream guarantees a clean shape.
        node.reportedMemberState = opts.reportedMemberState;
    }
    if (opts.nodeFacts) {
        // Preserve opaque facts, but a delayed same-account report must not
        // roll back quota measured later while this config write was queued.
        node.nodeFacts = selectReportedQuotaFacts(node.nodeFacts, opts.nodeFacts, Date.now());
    }
    if (opts.policy) node.policy = { ...node.policy, ...opts.policy };
    if (Object.prototype.hasOwnProperty.call(opts, 'capabilities')) {
        // Explicit replace: normalize (trim/dedup/drop-empties); an empty result
        // clears the tags entirely so the field never persists as [].
        const tags = normalizeCapabilityTags(opts.capabilities);
        if (tags && tags.length) node.capabilities = tags;
        else delete node.capabilities;
    }
    if (opts.worktreeBootstrap) node.worktreeBootstrap = opts.worktreeBootstrap;
    if (Object.prototype.hasOwnProperty.call(opts, 'systemPrompt')) {
        // Honor explicit clears: { systemPrompt: undefined } drops the field.
        if (opts.systemPrompt && opts.systemPrompt.trim()) {
            node.systemPrompt = opts.systemPrompt;
        } else {
            delete node.systemPrompt;
        }
    }
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(config);
    return node;
}


/** A recovery of this existing record only, never a caller-supplied identity grant. */
export interface LocalNodeIdentityRecovery {
    v: 1;
    expectedDaemonId: string | null;
    expectedMachineId: string | null;
    expectedWorkspace: string;
    dryRun: boolean;
    expectedFingerprint?: string;
}

/** Local authenticated handler only. No await between proof, CAS and persistence. */
export function recoverLocalNodeIdentity(meshId: string, nodeId: string, request: LocalNodeIdentityRecovery,
    host: { actor: string; machineId: string; refineryRunning: boolean; refineryLeaseRoots?: string[]; runningRefineMeshIds?: string[]; cachedNode?: Partial<LocalMeshNodeEntry> }) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(k => !['v', 'expectedDaemonId', 'expectedMachineId', 'expectedWorkspace', 'dryRun', 'expectedFingerprint'].includes(k))
        || request.v !== 1 || typeof request.dryRun !== 'boolean'
        || ![request.expectedDaemonId, request.expectedMachineId].every(x => x === null || (typeof x === 'string' && !!x.trim()))
        || typeof request.expectedWorkspace !== 'string' || !isAbsolute(request.expectedWorkspace)
        || (request.expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(request.expectedFingerprint))
        || (!request.dryRun && !request.expectedFingerprint)) throw new Error('invalid_node_identity_recovery');
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => withStrictMeshConfigWriteLock(() => {
        const config = readMeshConfigFromDisk();
        const mesh = config?.meshes.find(m => m.id === meshId);
        const node = mesh?.nodes.find(n => n.id === nodeId);
        if (!config || !mesh || !node) throw new Error('node_not_found');
        const cached = host.cachedNode;
        if (cached && (cached.workspace !== node.workspace || cached.daemonId !== node.daemonId || cached.machineId !== node.machineId)) throw new Error('node_identity_cache_conflict');
        const owner = resolveMeshHostStatus(mesh, { localDaemonId: host.actor });
        if (!host.actor || !host.machineId || !daemonIdsEquivalent(host.actor, host.machineId)
            || !mesh.meshHost?.hostDaemonId || !daemonIdsEquivalent(mesh.meshHost.hostDaemonId, host.actor)
            || owner.role !== 'host' || !daemonIdsEquivalent(owner.hostDaemonId, host.actor)) throw new Error('authenticated_local_mesh_host_required');
        if ((node.daemonId ?? null) !== request.expectedDaemonId || (node.machineId ?? null) !== request.expectedMachineId)
            throw new Error('stale_node_identity');
        for (const id of [node.daemonId, node.machineId]) {
            if (id != null && (!id || !daemonIdsEquivalent(id, host.actor))) throw new Error('foreign_node_identity');
        }
        const localNodes = mesh.nodes.filter(n => n.id !== node.id && n.daemonId && n.machineId
            && daemonIdsEquivalent(n.daemonId, host.actor) && daemonIdsEquivalent(n.machineId, host.machineId));
        if (!localNodes.length) throw new Error('local_repo_anchor_required');
        const git = (workspace: string, ...args: string[]) => execFileSync('git', ['-C', workspace, ...args], {
            windowsHide: true, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        const owned = (p: string) => {
            const canonical = realpathSync.native(p); const st = statSync(canonical);
            if (typeof process.getuid !== 'function' || st.uid !== process.getuid() || (st.mode & 0o022)) throw new Error('local_resource_owner_unproven');
            return { path: canonical, dev: st.dev, ino: st.ino, uid: st.uid };
        };
        const inspect = (workspace: string) => {
            const root = owned(workspace);
            if (root.path !== workspace || realpathSync.native(git(workspace, 'rev-parse', '--show-toplevel')) !== workspace)
                throw new Error('canonical_worktree_root_required');
            const gitDir = owned(git(workspace, 'rev-parse', '--absolute-git-dir'));
            const common = owned(resolve(workspace, git(workspace, 'rev-parse', '--git-common-dir')));
            const repo = normalizeRepoIdentity(git(workspace, 'remote', 'get-url', 'origin'));
            if (!repo || repo !== normalizeRepoIdentity(mesh.repoIdentity)) throw new Error('local_repository_mismatch');
            const head = git(workspace, 'rev-parse', '--verify', 'HEAD');
            return { root, gitDir, common, repo, head };
        };
        if (node.workspace !== request.expectedWorkspace) throw new Error('stale_node_workspace');
        const target = inspect(node.workspace);
        if (node.repoRoot && realpathSync.native(node.repoRoot) !== target.root.path) throw new Error('node_repository_root_mismatch');
        const anchors = localNodes.flatMap(n => {
            try { return [{ nodeId: n.id, proof: inspect(n.workspace) }]; } catch { return []; }
        });
        if (!anchors.length) throw new Error('local_repo_anchor_required');
        // An independent clone must prove a shared immutable object, not only an origin string.
        if (!anchors.some(a => {
            try { git(a.proof.root.path, 'cat-file', '-e', `${target.head}^{commit}`); return true; } catch { return false; }
        })) throw new Error('local_repository_object_unproven');
        if (mesh.nodes.some(n => {
            if (n.id === node.id) return false;
            if (n.workspace === target.root.path) return true;
            try { return realpathSync.native(n.workspace) === target.root.path; } catch { return false; }
        })) throw new Error('ambiguous_node_workspace');
        const relatedMeshIds = config.meshes.filter(m => normalizeRepoIdentity(m.repoIdentity) === target.repo).map(m => m.id);
        const sharedRoots = new Set([target.root.path, target.common.path, ...anchors.flatMap(a => [a.proof.root.path, a.proof.common.path])]);
        const leased = (host.refineryLeaseRoots ?? []).some(root => sharedRoots.has(realpathSync.native(root)));
        if (host.refineryRunning || leased || host.runningRefineMeshIds?.some(id => relatedMeshIds.includes(id))
            || relatedMeshIds.some(id => selectOpenRefineDispatches(readLocalRecords(id, { kind: ['task_dispatched', 'task_completed', 'task_failed'], turnTerminals: false })).length))
            throw new Error('node_identity_refinery_active');
        // This recovery attests integration resources: every writer in this repository mesh conflicts.
        // Only meshes with this verified repository identity are consulted; reserved launches also own a future writer.
        if (relatedMeshIds.some(id => store.assignedRowsMeshWide(id).length || store.turnStore().listOpenAttempts({ meshId: id }).length
            || store.getQueueEntries(id, ['pending']).some(t => pendingLaunchReservation(t))))
            throw new Error('node_identity_active_claims');
        const scope = attestLocalOwnership({ repoIdentity: mesh.repoIdentity, machineId: host.machineId, nodeId: node.id,
            workspace: node.workspace, phase: 'integration', paths: { paths: [] } });
        const resourceProofs: Array<ReturnType<typeof owned>> = [];
        for (const p of [...Object.values(scope.gitResources), ...scope.resources.map(r => r.path)]) {
            // Hooks can legitimately be absent; prove their containing Git directory above.
            try { resourceProofs.push(owned(p)); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({ meshId, repoIdentity: mesh.repoIdentity,
            host: { actor: host.actor, machineId: host.machineId }, node, target, anchors, scope, resourceProofs })).digest('hex');
        if (!request.dryRun && request.expectedFingerprint !== fingerprint) throw new Error('stale_node_identity_fingerprint');
        const receipt = { v: 1, meshId, nodeId, fingerprint, previous: { daemonId: node.daemonId ?? null, machineId: node.machineId ?? null },
            next: { daemonId: host.actor, machineId: host.machineId }, workspace: node.workspace, proof: target };
        if (request.dryRun) return { success: true, dryRun: true, receipt };
        const record = node as LocalMeshNodeEntry & { identityRecoveryHistory?: unknown[] };
        record.identityRecoveryHistory = [...(record.identityRecoveryHistory ?? []), { ...receipt, actor: host.actor, at: new Date().toISOString() }];
        node.daemonId = host.actor; node.machineId = host.machineId;
        const saved = saveMeshConfigDurable(config);
        if (!saved.ok && !saved.committed) throw new Error(`node_identity_persistence_failed:${saved.reason}`);
        return saved.ok
            ? { success: true, dryRun: false, changed: true, durable: true, receipt, node }
            : { success: false, dryRun: false, changed: true, code: 'node_identity_durability_unconfirmed',
                error: 'Registry replace committed; durability unconfirmed. Inspect before retrying.', receipt, node };
    }));
}
