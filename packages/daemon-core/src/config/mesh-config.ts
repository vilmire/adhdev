/**
 * Repo Mesh Config — Local mesh configuration stored in ~/.adhdev/meshes.json
 *
 * Manages repo mesh definitions for OSS standalone mode.
 * Cloud mode syncs these to D1 via server routes; standalone mode
 * uses this file as the single source of truth.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { shortHash } from '../system/hash.js';
import { getConfigDir } from './config.js';
import type {
    LocalMeshConfig,
    LocalMeshEntry,
    LocalMeshNodeEntry,
    RepoMeshPolicy,
    RepoMeshNodePolicy,
    RepoMeshNodeCapabilities,
    RepoMeshCoordinatorConfig,
    RepoMeshHostMetadata,
    RepoMeshDaemonRole,
} from '../repo-mesh-types.js';
import type { MagiPanel, MagiPanelMember, MagiPanelDefaultKind } from '@adhdev/mesh-shared';
import { mergeAndNormalizePolicy } from '../repo-mesh-types.js';
import { createDefaultMeshHostMetadata } from '../mesh/mesh-host-ownership.js';

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
        const config = raw as LocalMeshConfig;
        const migrated = migrateLoadedMeshConfig(config);
        // Persist eagerly when the on-load migration changed anything, so the
        // dead field is gone from disk even on a pure-read path (mesh_status /
        // mesh_list_nodes) that never otherwise mutates the config. Best-effort:
        // a write failure (e.g. read-only fs) must not break reads, so swallow.
        if (migrated) {
            try {
                saveMeshConfig(config);
            } catch {
                // keep the in-memory strip; disk converges on the next mutating op
            }
        }
        return config;
    } catch {
        return { meshes: [] };
    }
}

/**
 * In-place migration applied to every loaded meshes.json. Strips data that
 * outlived the feature that wrote it so the persisted config converges on the
 * current schema the next time it is saved.
 *
 * Currently: drops the dead `role` field from each node policy's providerRoles
 * entries. providerRoles is retained for its `maxParallel` per-(node, provider)
 * cap, but the routing `role` was removed (routing is governed solely by
 * required_tags). A meshes.json written before the removal still carries
 * `role: "validator"` etc.; this drops it on load so mesh_status / mesh_list_nodes
 * never surface the dead field and the next saveMeshConfig() persists it gone.
 *
 * Returns true when the config was mutated (caller may persist eagerly).
 */
function migrateLoadedMeshConfig(config: LocalMeshConfig): boolean {
    let changed = false;
    for (const mesh of config.meshes) {
        if (!mesh || !Array.isArray(mesh.nodes)) continue;
        for (const node of mesh.nodes) {
            if (stripDeadRoleFromProviderRoles(node?.policy)) changed = true;
        }
    }
    return changed;
}

/**
 * Drop the legacy `role` field from each providerRoles entry of a node policy,
 * in place. Keeps providerType + maxParallel (the still-meaningful per-(node,
 * provider) cap). Defensive against malformed entries — non-object items are
 * left untouched. Returns true when at least one `role` field was removed.
 */
function stripDeadRoleFromProviderRoles(policy: unknown): boolean {
    if (!policy || typeof policy !== 'object') return false;
    const roles = (policy as { providerRoles?: unknown }).providerRoles;
    if (!Array.isArray(roles)) return false;
    let changed = false;
    for (const entry of roles) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)
            && Object.prototype.hasOwnProperty.call(entry, 'role')) {
            delete (entry as Record<string, unknown>).role;
            changed = true;
        }
    }
    return changed;
}

function normalizeCapabilityTags(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const tags = value
        .map(tag => typeof tag === 'string' ? tag.trim() : '')
        .filter(Boolean)
        .filter(tag => {
            if (seen.has(tag)) return false;
            seen.add(tag);
            return true;
        });
    return tags.length ? tags : undefined;
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

// Single source of truth for default+merge+per-field normalization is
// mergeAndNormalizePolicy in repo-mesh-types.ts. This thin alias keeps the local
// call sites (createMesh/updateMesh) reading naturally while ensuring config
// writes go through the exact same normalizer the scheduler/display paths use.
const mergeMeshPolicy = mergeAndNormalizePolicy;

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
    meshHost?: RepoMeshHostMetadata;
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
        meshHost: opts.meshHost || createDefaultMeshHostMetadata(),
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

export function updateMesh(meshId: string, opts: UpdateMeshOptions): LocalMeshEntry | undefined {
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

export function deleteMesh(meshId: string): boolean {
    const config = loadMeshConfig();
    const idx = config.meshes.findIndex(m => m.id === meshId);
    if (idx === -1) return false;
    config.meshes.splice(idx, 1);
    saveMeshConfig(config);
    return true;
}

function normalizeManualHostAddress(hostAddress: string): string {
    const normalized = hostAddress.trim().replace(/\/+$/, '');
    if (!normalized) throw new Error('hostAddress required');
    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error('hostAddress must be a valid http(s) or ws(s) URL');
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
        throw new Error('hostAddress must use http, https, ws, or wss');
    }
    return normalized;
}

export function tokenIdForManualPairing(token: string): string {
    return `tok_${shortHash(token)}`;
}

function normalizeTokenExpiry(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('expiresAt must be a valid ISO date');
    return date.toISOString();
}

function assertPairingTokenValid(pairing: RepoMeshHostMetadata['pairing'], rawToken: string, nowIso: string): { ok: true; tokenId: string } | { ok: false; reason: string; expectedTokenId?: string; presentedTokenId?: string } {
    const token = rawToken.trim();
    if (!token) return { ok: false, reason: 'token required' };
    const presentedTokenId = tokenIdForManualPairing(token);
    const expectedTokenId = pairing?.tokenId;
    if (!expectedTokenId || pairing?.status === 'not_configured' || pairing?.status === 'revoked') {
        return { ok: false, reason: 'host pairing token is not configured', presentedTokenId };
    }
    if (pairing.expiresAt && new Date(pairing.expiresAt).getTime() <= new Date(nowIso).getTime()) {
        return { ok: false, reason: 'host pairing token expired', expectedTokenId, presentedTokenId };
    }
    if (presentedTokenId !== expectedTokenId) {
        return { ok: false, reason: 'invalid pairing token', expectedTokenId, presentedTokenId };
    }
    return { ok: true, tokenId: presentedTokenId };
}

export interface ConfigureMeshHostPairingOptions {
    hostAddress: string;
    token: string;
    now?: string;
}

export function configureMeshHostPairing(
    meshId: string,
    opts: ConfigureMeshHostPairingOptions,
): { mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata; hostAddress: string } | undefined {
    const hostAddress = normalizeManualHostAddress(opts.hostAddress);
    const token = opts.token.trim();
    if (!token) throw new Error('token required');

    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    const now = opts.now || new Date().toISOString();
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    const meshHost: RepoMeshHostMetadata = {
        ...previous,
        role: 'member',
        hostAddress,
        pairing: {
            status: 'pairing',
            tokenId: tokenIdForManualPairing(token),
            lastPairedAt: now,
        },
    };

    mesh.meshHost = meshHost;
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { mesh, meshHost, hostAddress };
}

export interface CreateMeshHostPairingTokenOptions {
    token?: string;
    expiresAt?: string;
    now?: string;
}

export function createMeshHostPairingToken(
    meshId: string,
    opts: CreateMeshHostPairingTokenOptions = {},
): { mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata; token: string; tokenId: string; expiresAt?: string } | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;
    const now = opts.now || new Date().toISOString();
    const token = (opts.token || `mhj_${randomBytes(24).toString('base64url')}`).trim();
    if (!token) throw new Error('token required');
    const tokenId = tokenIdForManualPairing(token);
    const expiresAt = normalizeTokenExpiry(opts.expiresAt);
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    if (previous.role === 'member') {
        throw new Error('Mesh Host daemon required to create host pairing tokens; member daemons cannot mint host join tokens.');
    }
    const meshHost: RepoMeshHostMetadata = {
        ...previous,
        role: 'host',
        pairing: {
            status: 'pairing',
            tokenId,
            lastPairedAt: now,
            ...(expiresAt ? { expiresAt } : {}),
        },
    };
    mesh.meshHost = meshHost;
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { mesh, meshHost, token, tokenId, ...(expiresAt ? { expiresAt } : {}) };
}

export interface MeshHostJoinMemberNodeInput {
    id?: string;
    workspace: string;
    repoRoot?: string;
    daemonId?: string;
    machineId?: string;
    userOverrides?: Partial<RepoMeshNodeCapabilities>;
    policy?: RepoMeshNodePolicy;
    role?: RepoMeshDaemonRole;
}

export interface ApplyMeshHostJoinOptions {
    token: string;
    memberNode: MeshHostJoinMemberNodeInput;
    memberMeshId?: string;
    now?: string;
}

export function applyMeshHostJoinRequest(
    meshId: string,
    opts: ApplyMeshHostJoinOptions,
): { accepted: true; mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata; node: LocalMeshNodeEntry; tokenId: string } | { accepted: false; mesh?: LocalMeshEntry; meshHost?: RepoMeshHostMetadata; tokenId?: string; reason: string } | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;
    const now = opts.now || new Date().toISOString();
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    if (previous.role === 'member') {
        return { accepted: false, mesh, meshHost: previous, reason: 'Mesh Host daemon required to accept join requests' };
    }
    const meshHost: RepoMeshHostMetadata = { ...previous, role: 'host' };
    const validation = assertPairingTokenValid(meshHost.pairing, opts.token, now);
    if (!validation.ok) {
        mesh.meshHost = {
            ...meshHost,
            pairing: {
                ...(meshHost.pairing || { status: 'not_configured' as const }),
                status: 'rejected',
                lastRejectedAt: now,
            },
        };
        mesh.updatedAt = now;
        saveMeshConfig(config);
        return { accepted: false, mesh, meshHost: mesh.meshHost, tokenId: validation.presentedTokenId, reason: validation.reason };
    }

    const workspace = opts.memberNode.workspace.trim();
    if (!workspace) throw new Error('memberNode.workspace required');
    const memberId = opts.memberNode.id?.trim();
    let node = mesh.nodes.find(n => (memberId && n.id === memberId) || n.workspace === workspace);
    if (node) {
        node.workspace = workspace;
        node.repoRoot = opts.memberNode.repoRoot;
        node.daemonId = opts.memberNode.daemonId;
        node.machineId = opts.memberNode.machineId;
        node.userOverrides = opts.memberNode.userOverrides || node.userOverrides || {};
        node.policy = { ...(node.policy || {}), ...(opts.memberNode.policy || {}) };
        node.role = 'member';
    } else {
        if (mesh.nodes.length >= 10) throw new Error('Maximum 10 nodes per mesh');
        node = {
            id: memberId || `node_${randomUUID().replace(/-/g, '')}`,
            workspace,
            repoRoot: opts.memberNode.repoRoot,
            daemonId: opts.memberNode.daemonId,
            machineId: opts.memberNode.machineId,
            userOverrides: opts.memberNode.userOverrides || {},
            policy: opts.memberNode.policy || {},
            role: 'member',
        };
        mesh.nodes.push(node);
    }
    mesh.meshHost = {
        ...meshHost,
        pairing: {
            ...(meshHost.pairing || {}),
            status: 'paired',
            tokenId: validation.tokenId,
            joinedAt: now,
            lastPairedAt: meshHost.pairing?.lastPairedAt || now,
            ...(meshHost.pairing?.expiresAt ? { expiresAt: meshHost.pairing.expiresAt } : {}),
        },
    };
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { accepted: true, mesh, meshHost: mesh.meshHost, node, tokenId: validation.tokenId };
}

export function markMeshHostPairingJoined(
    meshId: string,
    opts: { hostDaemonId?: string; hostNodeId?: string; joinedAt?: string; token?: string; tokenId?: string },
): { mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata } | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;
    const now = opts.joinedAt || new Date().toISOString();
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    const tokenId = opts.tokenId || (opts.token ? tokenIdForManualPairing(opts.token) : previous.pairing?.tokenId);
    mesh.meshHost = {
        ...previous,
        role: 'member',
        ...(opts.hostDaemonId ? { hostDaemonId: opts.hostDaemonId } : {}),
        ...(opts.hostNodeId ? { hostNodeId: opts.hostNodeId } : {}),
        pairing: {
            ...(previous.pairing || {}),
            status: 'paired',
            ...(tokenId ? { tokenId } : {}),
            joinedAt: now,
            lastPairedAt: previous.pairing?.lastPairedAt || now,
        },
    };
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { mesh, meshHost: mesh.meshHost };
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
        capabilities: normalizeCapabilityTags(opts.capabilities),
        userOverrides: opts.userOverrides || {},
        policy: opts.policy || {},
        isLocalWorktree: opts.isLocalWorktree,
        worktreeBranch: opts.worktreeBranch,
        clonedFromNodeId: opts.clonedFromNodeId,
        worktreeBootstrap: opts.worktreeBootstrap,
        role: opts.role,
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
    opts: {
        userOverrides?: Partial<RepoMeshNodeCapabilities>;
        policy?: RepoMeshNodePolicy;
        worktreeBootstrap?: LocalMeshNodeEntry['worktreeBootstrap'];
        /** Per-node instruction surfaced in the coordinator prompt. Pass an
         *  empty string or undefined to clear it. */
        systemPrompt?: string;
        /** Live self-reported platform/arch from the owning daemon's git_status
         *  envelope. Persisted distinctly from userOverrides (auto-detected, not
         *  operator intent) so capability-tag os=/arch= self-heals across loads. */
        reportedPlatform?: string;
        reportedArch?: string;
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
    if (opts.policy) node.policy = { ...node.policy, ...opts.policy };
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

// ─── MAGI Panels (machine-local cross-verification quorums) ──

/** Hard cap on members per panel — a sanity bound, not the per-invocation replica cap. */
const MAX_MAGI_PANEL_MEMBERS = 24;

function normalizeReplicaCount(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const n = Math.floor(value);
    return n >= 1 ? n : undefined;
}

/**
 * Normalize a panel `defaultKind` (the non-binding default output kind). Returns
 * undefined (drop, don't throw) for any absent / unknown value so a stray field
 * never blocks a panel write. 'freeform' is explicitly DROPPED with a warning: a
 * panel is a cross-verification tool and freeform contributes no structured claims
 * (claims:[]), so defaulting to it would silently zero out the very thing the panel
 * exists for. Only the evidence-bearing kinds (claim_audit / rca / design) survive.
 */
function normalizeMagiPanelDefaultKind(raw: unknown): MagiPanelDefaultKind | undefined {
    if (raw == null) return undefined;
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (s === 'claim_audit' || s === 'rca' || s === 'design') return s;
    if (s === 'freeform') {
        // eslint-disable-next-line no-console
        console.warn(
            "[magi] panel defaultKind='freeform' rejected — freeform contributes no structured claims to cross-verification; dropping (use claim_audit / rca / design, or omit).",
        );
        return undefined;
    }
    // Any other value (typo / unsupported kind): drop silently — the panel still
    // resolves to the claim_audit fallback at review time.
    return undefined;
}

/**
 * Validate + normalize a panel config before persisting. Mirrors the node-config
 * normalization style (mesh-config addNode/updateNode): trims strings, drops
 * empties, requires a provider per member, clamps replica counts. Throws on
 * structurally invalid input so the calling tool returns a clear error rather than
 * writing a malformed panel.
 */
export function normalizeMagiPanel(config: unknown): MagiPanel {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('invalid_magi_panel: config must be an object');
    }
    const raw = config as Record<string, unknown>;
    const rawMembers = raw.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
        throw new Error('invalid_magi_panel: members must be a non-empty array');
    }
    if (rawMembers.length > MAX_MAGI_PANEL_MEMBERS) {
        throw new Error(`invalid_magi_panel: too many members (max ${MAX_MAGI_PANEL_MEMBERS})`);
    }
    const members: MagiPanelMember[] = rawMembers.map((entry, idx) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`invalid_magi_panel: member[${idx}] must be an object`);
        }
        const m = entry as Record<string, unknown>;
        const provider = typeof m.provider === 'string' ? m.provider.trim() : '';
        if (!provider) {
            throw new Error(`invalid_magi_panel: member[${idx}].provider is required`);
        }
        const nodeId = typeof m.nodeId === 'string' && m.nodeId.trim() ? m.nodeId.trim() : undefined;
        const capabilityTags = normalizeCapabilityTags(m.capabilityTags);
        const n = normalizeReplicaCount(m.n);
        return {
            provider,
            ...(nodeId ? { nodeId } : {}),
            ...(capabilityTags ? { capabilityTags } : {}),
            ...(n !== undefined ? { n } : {}),
        };
    });
    const description = typeof raw.description === 'string' && raw.description.trim()
        ? raw.description.trim().slice(0, 200)
        : undefined;
    const defaultN = normalizeReplicaCount(raw.defaultN);
    const defaultKind = normalizeMagiPanelDefaultKind(raw.defaultKind);
    return {
        ...(description ? { description } : {}),
        members,
        ...(defaultN !== undefined ? { defaultN } : {}),
        ...(defaultKind !== undefined ? { defaultKind } : {}),
        // dedupExempt is always meaningful for a MAGI panel (intentional same-prompt
        // fan-out). Persist it true unless the caller explicitly disables it.
        dedupExempt: raw.dedupExempt === false ? false : true,
    };
}

function normalizePanelName(name: unknown): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('invalid_magi_panel: panel name is required');
    return trimmed.slice(0, 100);
}

/** All configured MAGI panels (machine-local), keyed by name. Empty when none. */
export function listMagiPanels(): Record<string, MagiPanel> {
    return loadMeshConfig().magiPanels ?? {};
}

/** A single panel by name, or undefined when not configured. */
export function getMagiPanel(name: string): MagiPanel | undefined {
    const key = typeof name === 'string' ? name.trim() : '';
    if (!key) return undefined;
    return loadMeshConfig().magiPanels?.[key];
}

/**
 * Upsert a named panel into meshes.json. Defaults to refusing to clobber an
 * existing panel (overwrite=false) — mirrors the mesh_init write/overwrite
 * precedent. Returns the normalized, persisted panel.
 */
export function upsertMagiPanel(
    name: string,
    config: unknown,
    opts: { overwrite?: boolean } = {},
): MagiPanel {
    const key = normalizePanelName(name);
    const panel = normalizeMagiPanel(config);
    const stored = loadMeshConfig();
    const panels = stored.magiPanels ?? {};
    if (panels[key] && opts.overwrite !== true) {
        throw new Error(`magi_panel_exists: panel '${key}' already exists — pass overwrite=true to replace it`);
    }
    panels[key] = panel;
    stored.magiPanels = panels;
    saveMeshConfig(stored);
    return panel;
}

/** Remove a named panel. Returns true when a panel was removed. */
export function removeMagiPanel(name: string): boolean {
    const key = typeof name === 'string' ? name.trim() : '';
    if (!key) return false;
    const stored = loadMeshConfig();
    if (!stored.magiPanels || !stored.magiPanels[key]) return false;
    delete stored.magiPanels[key];
    saveMeshConfig(stored);
    return true;
}
