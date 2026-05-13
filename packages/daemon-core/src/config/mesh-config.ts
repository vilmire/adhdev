/**
 * Repo Mesh Config — Local mesh configuration stored in ~/.adhdev/meshes.json
 *
 * Manages repo mesh definitions for OSS standalone mode.
 * Cloud mode syncs these to D1 via server routes; standalone mode
 * uses this file as the single source of truth.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getConfigDir } from './config.js';
import type {
    LocalMeshConfig,
    LocalMeshEntry,
    LocalMeshNodeEntry,
    RepoMeshPolicy,
    RepoMeshNodePolicy,
    RepoMeshNodeCapabilities,
    RepoMeshCoordinatorConfig,
} from '../repo-mesh-types.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';

// ─── Persistence ────────────────────────────────

function getMeshConfigPath(): string {
    return join(getConfigDir(), 'meshes.json');
}

function loadMeshConfig(): LocalMeshConfig {
    const path = getMeshConfigPath();
    if (!existsSync(path)) return { meshes: [] };
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw || !Array.isArray(raw.meshes)) return { meshes: [] };
        return raw as LocalMeshConfig;
    } catch {
        return { meshes: [] };
    }
}

function saveMeshConfig(config: LocalMeshConfig): void {
    const path = getMeshConfigPath();
    writeFileSync(path, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ─── Repo Identity Normalization ────────────────

/**
 * Normalize a Git remote URL into a stable identity string.
 * e.g. "git@github.com:user/repo.git" → "github.com/user/repo"
 *      "https://github.com/user/repo.git" → "github.com/user/repo"
 */
export function normalizeRepoIdentity(remoteUrl: string): string {
    let identity = remoteUrl.trim();

    // HTTPS format first (takes priority over SSH fallback)
    if (identity.startsWith('http://') || identity.startsWith('https://')) {
        try {
            const url = new URL(identity);
            const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
            return `${url.hostname}/${path}`;
        } catch {
            // fall through
        }
    }

    // SSH format: git@host:owner/repo.git or ssh://git@host/owner/repo.git
    const sshMatch = identity.match(/^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)[:/]([\w.\-/]+?)(?:\.git)?$/);
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

    return identity;
}

// ─── CRUD Operations ────────────────────────────

const SESSION_CLEANUP_MODES = new Set(['preserve', 'stop', 'delete_stopped', 'stop_and_delete']);
const SPAWNED_SESSION_VISIBILITY_MODES = new Set(['visible', 'hidden']);

function mergeMeshPolicy(base: RepoMeshPolicy | undefined, patch: Partial<RepoMeshPolicy> | undefined): RepoMeshPolicy {
    const policy: RepoMeshPolicy = { ...DEFAULT_MESH_POLICY, ...(base || {}), ...(patch || {}) };
    if (!['block', 'warn', 'checkpoint_then_continue'].includes(policy.dirtyWorkspaceBehavior)) {
        policy.dirtyWorkspaceBehavior = 'warn';
    }
    const maxParallelTasks = Number(policy.maxParallelTasks);
    policy.maxParallelTasks = Number.isFinite(maxParallelTasks) ? Math.max(1, Math.min(8, Math.floor(maxParallelTasks))) : 2;
    if (!SESSION_CLEANUP_MODES.has(String(policy.sessionCleanupOnNodeRemove))) {
        policy.sessionCleanupOnNodeRemove = 'preserve';
    }
    if (!SPAWNED_SESSION_VISIBILITY_MODES.has(String(policy.spawnedSessionVisibility))) {
        policy.spawnedSessionVisibility = 'visible';
    }
    return policy;
}

export function listMeshes(): LocalMeshEntry[] {
    return loadMeshConfig().meshes;
}

export function getMesh(meshId: string): LocalMeshEntry | undefined {
    return loadMeshConfig().meshes.find(m => m.id === meshId);
}

export function getMeshByRepo(repoIdentity: string): LocalMeshEntry | undefined {
    return loadMeshConfig().meshes.find(m => m.repoIdentity === repoIdentity);
}

export interface CreateMeshOptions {
    name: string;
    repoRemoteUrl?: string;
    repoIdentity?: string;
    defaultBranch?: string;
    policy?: Partial<RepoMeshPolicy>;
    coordinator?: RepoMeshCoordinatorConfig;
}

export function createMesh(opts: CreateMeshOptions): LocalMeshEntry {
    const config = loadMeshConfig();

    if (config.meshes.length >= 20) {
        throw new Error('Maximum 20 meshes allowed');
    }

    const repoIdentity = opts.repoIdentity || (opts.repoRemoteUrl ? normalizeRepoIdentity(opts.repoRemoteUrl) : '');
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
}

export function updateMesh(meshId: string, opts: UpdateMeshOptions): LocalMeshEntry | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    if (opts.name !== undefined) mesh.name = opts.name.trim().slice(0, 100);
    if (opts.defaultBranch !== undefined) mesh.defaultBranch = opts.defaultBranch;
    if (opts.policy) mesh.policy = mergeMeshPolicy(mesh.policy, opts.policy);
    if (opts.coordinator) mesh.coordinator = opts.coordinator;
    mesh.updatedAt = new Date().toISOString();

    saveMeshConfig(config);
    return mesh;
}

export function deleteMesh(meshId: string): boolean {
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
    userOverrides?: Partial<RepoMeshNodeCapabilities>;
    policy?: RepoMeshNodePolicy;
    isLocalWorktree?: boolean;
    worktreeBranch?: string;
    clonedFromNodeId?: string;
}

export function addNode(meshId: string, opts: AddNodeOptions): LocalMeshNodeEntry | undefined {
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

    const node: LocalMeshNodeEntry = {
        id: `node_${randomUUID().replace(/-/g, '')}`,
        workspace: opts.workspace.trim(),
        repoRoot: opts.repoRoot,
        daemonId: opts.daemonId,
        machineId: opts.machineId,
        userOverrides: opts.userOverrides || {},
        policy: opts.policy || {},
        isLocalWorktree: opts.isLocalWorktree,
        worktreeBranch: opts.worktreeBranch,
        clonedFromNodeId: opts.clonedFromNodeId,
    };

    mesh.nodes.push(node);
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(config);
    return node;
}

export function removeNode(meshId: string, nodeId: string): boolean {
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
    meshId: string,
    nodeId: string,
    opts: { userOverrides?: Partial<RepoMeshNodeCapabilities>; policy?: RepoMeshNodePolicy },
): LocalMeshNodeEntry | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    const node = mesh.nodes.find(n => n.id === nodeId);
    if (!node) return undefined;

    if (opts.userOverrides) node.userOverrides = { ...node.userOverrides, ...opts.userOverrides };
    if (opts.policy) node.policy = { ...node.policy, ...opts.policy };
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(config);
    return node;
}
