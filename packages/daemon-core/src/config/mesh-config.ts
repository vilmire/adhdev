/**
 * Repo Mesh Config — Local mesh configuration stored in ~/.adhdev/meshes.json
 *
 * Manages repo mesh definitions for OSS standalone mode.
 * Cloud mode syncs these to D1 via server routes; standalone mode
 * uses this file as the single source of truth.
 */

import { randomUUID } from 'crypto';
import { getMachineNickname } from './config.js';
import type {
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
import type { MagiSlot, MagiTaskKind } from '@adhdev/mesh-shared';
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { mergeAndNormalizePolicy } from '../repo-mesh-types.js';
import { createDefaultMeshHostMetadata } from '../mesh/mesh-host-ownership.js';
import { withMeshConfigWriteLock, loadMeshConfig, normalizeCapabilityTags, saveMeshConfig, normalizeRepoIdentity } from './mesh-config-store.js';

// ─── CRUD Operations ────────────────────────────

// Single source of truth for default+merge+per-field normalization is
// mergeAndNormalizePolicy in repo-mesh-types.ts. This thin alias keeps the local
// call sites (createMesh/updateMesh) reading naturally while ensuring config
// writes go through the exact same normalizer the scheduler/display paths use.
const mergeMeshPolicy = mergeAndNormalizePolicy;

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
    return loadMeshConfig().meshes.find(m => m.id === meshId);
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
        policy: mergeMeshPolicy(undefined, opts.policy),
        coordinator: opts.coordinator || {},
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
    policy?: Partial<RepoMeshPolicy>;
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
    if (opts.policy) mesh.policy = mergeMeshPolicy(mesh.policy, opts.policy);
    if (opts.coordinator) mesh.coordinator = opts.coordinator;
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

    if (mesh.nodes.length >= 10) {
        throw new Error('Maximum 10 nodes per mesh');
    }

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
    // Panels are mesh-scoped, so a departing node's slots are now prunable — leaving
    // them would keep a binding pointing at a node the mesh no longer has.
    pruneMagiKindPanelsForRemovedNode(mesh, nodeId);
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
        /** Owning daemon's self-reported provider CLI/ACP versions + build version,
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
        // Versioned runtime-facts bundle — whole-object replace, OPAQUE (unknown
        // future fields persist untouched; deploy-lag design §a).
        node.nodeFacts = opts.nodeFacts;
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

/**
 * Drop every kind-panel slot pinned to `nodeId`, in place, and remove any kind left
 * with no slots. Called when a node leaves the mesh so a binding cannot keep naming a
 * node that no longer exists — the dangling-reference cleanup that only became
 * possible once panels were mesh-scoped and had a node list to be checked against.
 *
 * An emptied kind is deleted rather than stored as `[]`: an empty slot list is not a
 * legal binding, and mesh_magi_review reports the kind unconfigured (a clear
 * "configure this" error) instead of a silently under-quorum panel.
 *
 * Returns true when anything was pruned (caller persists).
 */
function pruneMagiKindPanelsForRemovedNode(mesh: LocalMeshEntry, nodeId: string): boolean {
    const panels = mesh.magiKindPanels;
    if (!panels) return false;
    let changed = false;
    for (const [kind, slots] of Object.entries(panels) as Array<[MagiTaskKind, MagiSlot[] | undefined]>) {
        if (!Array.isArray(slots)) continue;
        const kept = slots.filter(slot => !meshNodeIdMatches({ nodeId: slot.nodeId }, nodeId));
        if (kept.length === slots.length) continue;
        changed = true;
        if (kept.length === 0) delete panels[kind];
        else panels[kind] = kept;
    }
    if (changed && Object.keys(panels).length === 0) delete mesh.magiKindPanels;
    return changed;
}
