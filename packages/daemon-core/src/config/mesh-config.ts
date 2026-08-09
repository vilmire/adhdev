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
import { getConfigDir, loadConfig } from './config.js';
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
    MeshReportedMemberState,
} from '../repo-mesh-types.js';
import type { MagiKindPanelMap, MagiSlot, MagiTaskKind, DifficultyBrainMap, NodeCapabilitySlot } from '@adhdev/mesh-shared';
import { normalizeDifficultyBrainMap, DEFAULT_DIFFICULTY_BRAINS, normalizeNodeCapabilitySlots, deriveSlotsFromLegacy, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { mergeAndNormalizePolicy } from '../repo-mesh-types.js';
import { createDefaultMeshHostMetadata } from '../mesh/mesh-host-ownership.js';

// ─── Persistence ────────────────────────────────

function getMeshConfigPath(): string {
    return join(getConfigDir(), 'meshes.json');
}

function loadMeshConfig(options: { persistMigrations?: boolean } = {}): LocalMeshConfig {
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
        if (migrated && options.persistMigrations !== false) {
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
 * Currently: migrates the removed `providerRoles` per-(node, provider) cap onto
 * `slots[].maxParallel`. A meshes.json written before the removal carries
 * `providerRoles: [{ providerType, maxParallel }]` (possibly alongside a dead
 * `role` field). On load we fold each cap into the node's slots — into an existing
 * matching-provider slot that has no cap, else by deriving slots from the legacy
 * providerPriority/providerRoles when the node had no explicit slots — then delete
 * `providerRoles` so mesh_status / mesh_list_nodes never surface the removed field
 * and the next saveMeshConfig() persists it gone.
 *
 * Returns true when the config was mutated (caller may persist eagerly).
 */
function migrateLoadedMeshConfig(config: LocalMeshConfig): boolean {
    let changed = false;
    // Fold the legacy config-root scoped settings FIRST, so the per-node slot
    // derivation below already sees each mesh's own difficultyBrains rather than a
    // root map that is about to be moved or dropped.
    if (foldLegacyTopLevelMeshSetting(config, 'magiKindPanels', 'mesh_magi_kind_panel_set({ meshId, task_kind, slots })')) changed = true;
    if (foldLegacyTopLevelMeshSetting(config, 'difficultyBrains', 'difficulty_brains_set({ meshId, difficultyBrains })')) changed = true;
    for (const mesh of config.meshes) {
        if (!mesh || !Array.isArray(mesh.nodes)) continue;
        // Each node's legacy slot derivation uses ITS OWN mesh's presets. Reading a
        // global map here is what let one mesh's model choice leak into another's
        // derived slots.
        const brains = normalizeDifficultyBrainMap(mesh.difficultyBrains);
        const ownerBrains = Object.keys(brains).length > 0 ? brains : { ...DEFAULT_DIFFICULTY_BRAINS };
        for (const node of mesh.nodes) {
            if (migrateProviderRolesToSlots(node?.policy, ownerBrains)) changed = true;
        }
    }
    return changed;
}

/**
 * PER-MESH SCOPE migration: fold a legacy config-root setting map into its owning
 * mesh entry, in place, then delete the root key.
 *
 * Two settings shared the identical defect and are migrated by this one helper:
 *
 *   - `magiKindPanels`  — keyed by task_kind alone, so on a two-mesh machine a write
 *     in one mesh silently overwrote the other's binding and the survivor pointed at
 *     foreign node IDs.
 *   - `difficultyBrains` — keyed by difficulty alone, with the same overwrite. Worse
 *     in effect, because this map decides which MODEL a task runs on: the shipped
 *     DEFAULT_DIFFICULTY_BRAINS (difficult → opus) applied to every mesh on the
 *     machine, so a model nobody selected got stamped onto tasks.
 *
 * Both are now stored per mesh, which is what the docs already described.
 *
 * Fold rules:
 *   - exactly one mesh → adopt the map (a mesh-scoped value already present wins;
 *     the legacy map only fills keys the mesh has not set itself)
 *   - several meshes  → DROP it and log. There is no field recording which mesh
 *     wrote it, and guessing would re-create the very cross-mesh mis-binding this
 *     migration removes. The ambiguity is itself the evidence the global key was
 *     wrong. Dropping is also the SAFE direction for difficultyBrains: the mesh
 *     falls back to defaults rather than inheriting another mesh's model choice.
 *   - no meshes       → drop (nothing could own it)
 *
 * The root key is removed in every branch: keeping a dual read path alive would
 * preserve the cross-mesh overwrite it exists to eliminate.
 *
 * Returns true when the config was mutated (caller may persist eagerly).
 */
function foldLegacyTopLevelMeshSetting(
    config: LocalMeshConfig,
    key: 'magiKindPanels' | 'difficultyBrains',
    rebindHint: string,
): boolean {
    // Both keys are gone from LocalMeshConfig's type now that they live on the mesh
    // entry, but a config loaded from disk may still carry them — hence the cast.
    const root = config as unknown as Record<string, unknown>;
    const legacy = root[key];
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
        // Strip a structurally invalid root key too, so it cannot linger.
        if (key in root) {
            delete root[key];
            return true;
        }
        return false;
    }
    delete root[key];

    const entryKeys = Object.keys(legacy as Record<string, unknown>);
    if (config.meshes.length === 1 && entryKeys.length > 0) {
        const mesh = config.meshes[0] as unknown as Record<string, unknown>;
        // Mesh-scoped values win; the legacy map only fills what the mesh has not set.
        mesh[key] = { ...(legacy as Record<string, unknown>), ...((mesh[key] as Record<string, unknown>) ?? {}) };
    } else if (entryKeys.length > 0) {
        console.warn(
            `[mesh-config] Dropped legacy top-level ${key} (keys: ${entryKeys.join(', ')}) — `
            + `${config.meshes.length} meshes are configured, so the owning mesh cannot be determined. `
            + `Re-apply it per mesh with ${rebindHint}.`,
        );
    }
    return true;
}

/**
 * Migrate a node policy's legacy `providerRoles` cap onto `slots[].maxParallel`,
 * in place, then delete the `providerRoles` field. Defensive against malformed
 * entries. Returns true when the policy was mutated.
 *
 * Behavior-preserving: the resulting slots carry the same per-(node, provider)
 * cap the queue previously enforced from providerRoles. When the node had no
 * explicit slots, slots are derived from the legacy providerPriority (folding the
 * caps in via deriveSlotsFromLegacy-equivalent logic); when it did, each cap is
 * merged into the first matching-provider slot lacking a maxParallel.
 */
export function migrateProviderRolesToSlots(
    policy: unknown,
    ownerDifficultyBrains?: DifficultyBrainMap,
): boolean {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
    const p = policy as Record<string, unknown>;
    const rawRoles = p.providerRoles;
    if (!Array.isArray(rawRoles)) return false;

    // Extract provider → cap from the legacy roles (case-insensitive key, last wins).
    const roleCap = new Map<string, { provider: string; cap: number }>();
    for (const entry of rawRoles) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        const provider = typeof rec.providerType === 'string' ? rec.providerType.trim() : '';
        if (!provider) continue;
        const cap = Number(rec.maxParallel);
        if (!Number.isFinite(cap) || cap < 0) continue;
        roleCap.set(provider.toLowerCase(), { provider, cap: Math.floor(cap) });
    }

    const explicitSlots = Array.isArray(p.slots)
        ? normalizeNodeCapabilitySlots(p.slots)
        : [];

    if (explicitSlots.length) {
        // Merge each cap into the first matching-provider slot that has no cap yet.
        for (const { provider, cap } of roleCap.values()) {
            const target = explicitSlots.find(s =>
                s.provider.trim().toLowerCase() === provider.toLowerCase()
                && s.maxParallel === undefined);
            if (target) target.maxParallel = cap;
        }
        p.slots = explicitSlots;
    } else if (roleCap.size) {
        // No explicit slots: derive from legacy providerPriority, then fold caps in.
        // Falls back to a provider-per-role slot list when providerPriority is empty
        // so the cap is never silently dropped.
        // Presets are passed in by the caller (the owning mesh's map) rather than read
        // here: this runs inside the on-load migration, so calling getDifficultyBrains()
        // would re-enter loadMeshConfig, and it would read the WRONG mesh's presets on a
        // multi-mesh machine. Undefined → derivation just omits preset models.
        const difficultyBrains: DifficultyBrainMap | undefined = ownerDifficultyBrains;
        const priority = Array.isArray(p.providerPriority)
            ? (p.providerPriority as unknown[]).map(t => typeof t === 'string' ? t.trim() : '').filter(Boolean)
            : [];
        const derived = deriveSlotsFromLegacy({ providerPriority: priority, difficultyBrains });
        const slots: NodeCapabilitySlot[] = derived.length
            ? derived
            : [...roleCap.values()].map(r => ({ provider: r.provider }));
        for (const slot of slots) {
            const match = roleCap.get(slot.provider.trim().toLowerCase());
            if (match && slot.maxParallel === undefined) slot.maxParallel = match.cap;
        }
        p.slots = slots;
    }

    delete p.providerRoles;
    return true;
}

export function normalizeCapabilityTags(value: unknown): string[] | undefined {
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
    let identity = remoteUrl.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!identity) return '';

    // URL formats: https://host/owner/repo.git, ssh://git@host/owner/repo.git,
    // git://host/owner/repo.git. Credentials and transport are deliberately not
    // part of repository identity.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(identity)) {
        try {
            const url = new URL(identity);
            const path = decodeURIComponent(url.pathname)
                .replace(/^\/+|\/+$/g, '')
                .replace(/\.git$/i, '');
            if (url.hostname && path) return `${url.hostname.toLowerCase()}/${path}`;
        } catch {
            // fall through
        }
    }

    // SCP-like SSH format: git@host:owner/repo.git (also accepts host:path).
    const scpMatch = identity.match(/^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/);
    if (scpMatch) {
        const host = scpMatch[1].replace(/^\[|\]$/g, '').toLowerCase();
        const repoPath = scpMatch[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
        if (host && repoPath) return `${host}/${repoPath}`;
    }

    // Already-normalized host/path input. This also makes explicit identities
    // converge with remote-derived identities instead of preserving ".git".
    const slash = identity.indexOf('/');
    if (slash > 0) {
        const host = identity.slice(0, slash).toLowerCase();
        const repoPath = identity.slice(slash + 1).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
        if (host && repoPath) return `${host}/${repoPath}`;
    }

    return identity.replace(/\.git$/i, '');
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

export function createMesh(opts: CreateMeshOptions): LocalMeshEntry {
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

export type SetMeshHostPinReason =
    | 'pinned'
    | 'already_pinned_same'
    | 'host_already_pinned'
    | 'not_host_role'
    | 'invalid_host_daemon_id';

export interface SetMeshHostPinResult {
    mesh: LocalMeshEntry;
    meshHost: RepoMeshHostMetadata;
    /** True only when this call actually wrote the pin. */
    applied: boolean;
    reason: SetMeshHostPinReason;
    /** The pin in force after the call (existing one when the write was refused). */
    hostDaemonId?: string;
    hostNodeId?: string;
}

/**
 * HOST-PIN-WRITER — establish THIS mesh's host daemon (`role:'host'` side).
 *
 * The mirror of `markMeshHostPairingJoined`, which records the daemon we JOINED as a
 * `role:'member'`. Nothing previously wrote the host direction, so a mesh created here
 * carried role-only host metadata and never gained a `hostDaemonId` — every peer then
 * synthesized itself as host on read, which is the defect HOST-SELF-SYNTHESIS-GUARD
 * surfaced by refusing to answer.
 *
 * The host pin is a 1:1, effectively permanent assignment (the dashboard states it
 * "cannot be reassigned here"), so this mutator is deliberately conservative:
 *   • no pin yet            → write it (`applied:true`, reason 'pinned')
 *   • same daemon re-pinned → NO-OP, `updatedAt` untouched ('already_pinned_same')
 *   • different daemon      → REFUSED unless `force` ('host_already_pinned')
 *   • `role:'member'` mesh  → REFUSED ('not_host_role') — a member must never claim
 *     local coordinator/queue ownership; its host lives on the daemon it paired with.
 *
 * Identity comparison goes through `daemonIdsEquivalent`, never a raw `!==`. The
 * persisted pin is often a config-form id (`mach_…`) while callers pass the runtime
 * form (`daemon_mach_…`); a raw compare would read the same machine as a reassignment
 * and refuse it — the recurring canon-identity defect class.
 *
 * The host NODE is flagged `role:'host'` alongside the pin. That keeps
 * `resolveMeshHostStatus`'s node-declaration path (which outranks self-synthesis and
 * works for readers that only ever see the node list) consistent with the pin, and
 * exactly one node carries the flag after a forced re-home.
 */
export function setMeshHostPin(
    meshId: string,
    opts: { hostDaemonId?: string; hostNodeId?: string; hostAddress?: string; force?: boolean; now?: string },
): SetMeshHostPinResult | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    const hostDaemonId = typeof opts.hostDaemonId === 'string' ? opts.hostDaemonId.trim() : '';
    const hostNodeId = typeof opts.hostNodeId === 'string' ? opts.hostNodeId.trim() : '';
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();

    if (!hostDaemonId && !hostNodeId) {
        return {
            mesh,
            meshHost: previous,
            applied: false,
            reason: 'invalid_host_daemon_id',
            ...(previous.hostDaemonId ? { hostDaemonId: previous.hostDaemonId } : {}),
            ...(previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
        };
    }

    // A mesh we joined as a member is hosted elsewhere — never let it pin a local host.
    if (previous.role === 'member') {
        return {
            mesh,
            meshHost: previous,
            applied: false,
            reason: 'not_host_role',
            ...(previous.hostDaemonId ? { hostDaemonId: previous.hostDaemonId } : {}),
            ...(previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
        };
    }

    const existingDaemonId = typeof previous.hostDaemonId === 'string' ? previous.hostDaemonId.trim() : '';
    if (existingDaemonId && !opts.force) {
        const sameHost = hostDaemonId ? daemonIdsEquivalent(existingDaemonId, hostDaemonId) : true;
        if (!sameHost) {
            // Refuse silently-destructive re-homing: the caller must pass force.
            return {
                mesh,
                meshHost: previous,
                applied: false,
                reason: 'host_already_pinned',
                hostDaemonId: existingDaemonId,
                ...(previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
            };
        }
        // Same host. Only a genuinely NEW node anchor is worth a write; otherwise no-op
        // so repeated launches never churn updatedAt.
        const existingNodeId = typeof previous.hostNodeId === 'string' ? previous.hostNodeId.trim() : '';
        if (!hostNodeId || hostNodeId === existingNodeId) {
            return {
                mesh,
                meshHost: previous,
                applied: false,
                reason: 'already_pinned_same',
                hostDaemonId: existingDaemonId,
                ...(existingNodeId ? { hostNodeId: existingNodeId } : {}),
            };
        }
    }

    const now = opts.now || new Date().toISOString();
    const effectiveDaemonId = hostDaemonId || existingDaemonId;
    mesh.meshHost = {
        ...previous,
        role: 'host',
        ...(effectiveDaemonId ? { hostDaemonId: effectiveDaemonId } : {}),
        ...(hostNodeId ? { hostNodeId } : previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
        ...(opts.hostAddress?.trim() ? { hostAddress: opts.hostAddress.trim() } : {}),
    };

    // Keep the node-level declaration in lockstep with the pin, and single-valued.
    const hostNode = hostNodeId
        ? mesh.nodes.find(n => n.id === hostNodeId)
        : effectiveDaemonId
            ? mesh.nodes.find(n => n.daemonId && daemonIdsEquivalent(n.daemonId, effectiveDaemonId))
            : undefined;
    if (hostNode) {
        for (const node of mesh.nodes) {
            if (node.role === 'host' && node !== hostNode) node.role = undefined;
        }
        hostNode.role = 'host';
        if (!mesh.meshHost.hostNodeId) mesh.meshHost.hostNodeId = hostNode.id;
    }

    mesh.updatedAt = now;
    saveMeshConfig(config);
    return {
        mesh,
        meshHost: mesh.meshHost,
        applied: true,
        reason: 'pinned',
        ...(mesh.meshHost.hostDaemonId ? { hostDaemonId: mesh.meshHost.hostDaemonId } : {}),
        ...(mesh.meshHost.hostNodeId ? { hostNodeId: mesh.meshHost.hostNodeId } : {}),
    };
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
    /** Owning daemon's machine nickname. Defaults to this daemon's local
     *  config.machineNickname when omitted — a node is always added by (and on)
     *  the daemon that owns its workspace (self/base node or a local worktree
     *  clone), so the local config is the correct source. */
    machineNickname?: string;
    /** Caller-supplied node id (e.g. an id already minted for an inline-cache
     *  node) so a durable config-file twin shares the SAME id as its inline
     *  counterpart. Without this, addNode mints its own id and the two
     *  representations of "the same node" would carry different ids, breaking
     *  id-keyed reconciliation between the inline cache and meshes.json.
     *  Omitted → a fresh id is minted as before (default, unchanged behavior). */
    id?: string;
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

    // A node is always added by the daemon that owns its workspace (the self/base
    // node, or a local worktree clone spawned from this daemon), so this daemon's
    // config.machineNickname is the correct owner nickname. Explicit opt wins.
    const machineNickname = (() => {
        const explicit = typeof opts.machineNickname === 'string' ? opts.machineNickname.trim() : '';
        if (explicit) return explicit;
        try {
            const local = loadConfig().machineNickname;
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

export function removeNode(meshId: string, nodeId: string): boolean {
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

// ─── MAGI Panels (machine-local cross-verification quorums) ──

// NOTE: the named-panel model (normalizeMagiPanel / list / get / upsert / remove,
// stored under meshes.json `magiPanels`) was REMOVED. MAGI now resolves its fan-out
// slots SOLELY from the per-task_kind `magiKindPanels` binding below. `normalizeMagiSlots`
// is the sole slot normalizer.

function normalizeReplicaCount(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const n = Math.floor(value);
    return n >= 1 ? n : undefined;
}

// ─── MAGI kind → panel bindings (MAGI-KIND-PANEL) ─────────
//
// Per-task_kind slot lists, scoped PER MESH (meshes.json → `meshes[].magiKindPanels`,
// machine-local storage). A bare `mesh_magi_review({task_kind})` resolves its panel
// exclusively from the calling coordinator's mesh — an unconfigured kind is a hard
// error, never a synthesized fallback. Mirrors the named panel accessors above
// (normalize / list / get / set / remove).
//
// Every accessor takes an OPTIONAL trailing `meshId`: omitted, it resolves to the sole
// mesh (see resolveScopedMeshId), which keeps every pre-scope call site working on
// the single-mesh machines that are the norm. With several meshes there is no safe
// default — reads come back empty and writes throw — because guessing is exactly what
// the old config-root map did, silently overwriting another mesh's binding.

/** The task kinds a kind-panel can be bound to. Unlike a named panel's defaultKind,
 * 'freeform' IS a valid kind-panel key (this is a direct kind→slots binding). */
const MAGI_KIND_PANEL_KINDS: readonly MagiTaskKind[] = ['claim_audit', 'rca', 'design', 'freeform'];
const MAX_MAGI_KIND_SLOTS = 24;

function normalizeMagiTaskKindKey(raw: unknown): MagiTaskKind {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!(MAGI_KIND_PANEL_KINDS as readonly string[]).includes(s)) {
        throw new Error(`invalid_magi_kind_panel: task_kind must be one of ${MAGI_KIND_PANEL_KINDS.join(' / ')} (got '${s || '(empty)'}')`);
    }
    return s as MagiTaskKind;
}

/**
 * Validate + normalize a kind-panel's slots (the SOLE MAGI slot normalizer): provider
 * required per slot, trims strings, drops empties, clamps replica counts, and carries
 * an optional per-slot `model`. Throws on structurally invalid input (empty list / no
 * provider) so the write returns a clear error. Returns the normalized slot array.
 *
 * `knownNodeIds`, when supplied, additionally rejects a slot pinned to a node that is
 * not a member of the owning mesh. Panels are mesh-scoped, so at write time there IS a
 * node list to check against — before the scope fix a `nodeId` was an opaque string
 * that could (and did) name another mesh's node. Omit it on read-back paths, where a
 * stored slot must stay readable even if its node was removed out from under it.
 */
export function normalizeMagiSlots(slots: unknown, knownNodeIds?: Iterable<string>): MagiSlot[] {
    const allowed = knownNodeIds ? new Set(knownNodeIds) : undefined;
    if (!Array.isArray(slots) || slots.length === 0) {
        throw new Error('invalid_magi_kind_panel: slots must be a non-empty array');
    }
    if (slots.length > MAX_MAGI_KIND_SLOTS) {
        throw new Error(`invalid_magi_kind_panel: too many slots (max ${MAX_MAGI_KIND_SLOTS})`);
    }
    return slots.map((entry, idx) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`invalid_magi_kind_panel: slot[${idx}] must be an object`);
        }
        const s = entry as Record<string, unknown>;
        const provider = typeof s.provider === 'string' ? s.provider.trim() : '';
        if (!provider) {
            throw new Error(`invalid_magi_kind_panel: slot[${idx}].provider is required`);
        }
        const nodeId = typeof s.nodeId === 'string' && s.nodeId.trim() ? s.nodeId.trim() : undefined;
        if (nodeId && allowed && !allowed.has(nodeId)) {
            throw new Error(
                `invalid_magi_kind_panel: slot[${idx}].nodeId '${nodeId}' is not a node of this mesh `
                + `(known: ${[...allowed].join(', ') || '(none)'}). Pin a node from this mesh, or omit `
                + `nodeId to let the fan-out pick any node offering the provider.`,
            );
        }
        const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : undefined;
        const capabilityTags = normalizeCapabilityTags(s.capabilityTags);
        const n = normalizeReplicaCount(s.n);
        return {
            provider,
            ...(nodeId ? { nodeId } : {}),
            ...(model ? { model } : {}),
            ...(capabilityTags ? { capabilityTags } : {}),
            ...(n !== undefined ? { n } : {}),
        };
    });
}

/**
 * Resolve which mesh a per-mesh setting applies to when the caller did not name one.
 *
 * Both per-mesh machine-local settings (MAGI kind-panels, difficulty brains) are
 * reached from call sites that predate the scoping and pass no meshId. On the
 * overwhelmingly common single-mesh machine the answer is unambiguous, so those
 * callers keep working untouched. With several meshes there is no safe default —
 * returning undefined makes the read fall back to nothing/defaults and the write a
 * loud `*_mesh_ambiguous` error, rather than silently picking a mesh and re-creating
 * the cross-mesh overwrite this scoping fixes.
 *
 * Pass `config` to resolve against an already-loaded config (avoids a second read).
 */
export function resolveScopedMeshId(config?: LocalMeshConfig): string | undefined {
    const meshes = (config ?? loadMeshConfig({ persistMigrations: false })).meshes;
    return meshes.length === 1 ? meshes[0].id : undefined;
}

/** Locate a mesh entry by id, or the sole mesh when no id was given. */
function resolveScopedMesh(config: LocalMeshConfig, meshId?: string): LocalMeshEntry | undefined {
    const id = meshId?.trim() || resolveScopedMeshId(config);
    if (!id) return undefined;
    return config.meshes.find(m => m.id === id);
}


/**
 * All kind-panels configured for one mesh, keyed by task_kind. Empty when the mesh
 * has none, is unknown, or when no meshId was given and the machine hosts several
 * meshes (ambiguous — see resolveScopedMeshId).
 */
export function listMagiKindPanels(meshId?: string): MagiKindPanelMap {
    const config = loadMeshConfig();
    return resolveScopedMesh(config, meshId)?.magiKindPanels ?? {};
}

/** Read-only counterpart used by dry-run onboarding; never persists migrations. */
export function listMagiKindPanelsReadOnly(meshId?: string): MagiKindPanelMap {
    const config = loadMeshConfig({ persistMigrations: false });
    return resolveScopedMesh(config, meshId)?.magiKindPanels ?? {};
}

/** The slot list for one task_kind in one mesh, or undefined when not configured. */
export function getMagiKindPanel(kind: string, meshId?: string): MagiSlot[] | undefined {
    let key: MagiTaskKind;
    try { key = normalizeMagiTaskKindKey(kind); } catch { return undefined; }
    const config = loadMeshConfig();
    return resolveScopedMesh(config, meshId)?.magiKindPanels?.[key];
}

/**
 * Upsert the slot list for one task_kind WITHIN one mesh. Unlike named panels this
 * ALWAYS overwrites (a kind has exactly one binding per mesh) — the editor pushes the
 * full desired slot set. Each slot's optional `nodeId` is validated against that mesh's
 * node list, so a slot can no longer point at a node the mesh does not have.
 * Returns the normalized, persisted slots.
 */
export function setMagiKindPanel(kind: string, slots: unknown, meshId?: string): MagiSlot[] {
    const key = normalizeMagiTaskKindKey(kind);
    const stored = loadMeshConfig();
    const mesh = resolveScopedMesh(stored, meshId);
    if (!mesh) {
        throw new Error(
            meshId?.trim()
                ? `invalid_magi_kind_panel: mesh '${meshId.trim()}' not found`
                : `magi_kind_panel_mesh_ambiguous: this machine hosts ${stored.meshes.length} meshes, `
                  + `so a MAGI kind-panel write must name its mesh explicitly (meshId). Panels are per mesh.`,
        );
    }
    const normalized = normalizeMagiSlots(slots, mesh.nodes.map(n => n.id));
    const map = mesh.magiKindPanels ?? {};
    map[key] = normalized;
    mesh.magiKindPanels = map;
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(stored);
    return normalized;
}

/** Remove one task_kind's binding from one mesh. True when a binding was removed. */
export function removeMagiKindPanel(kind: string, meshId?: string): boolean {
    let key: MagiTaskKind;
    try { key = normalizeMagiTaskKindKey(kind); } catch { return false; }
    const stored = loadMeshConfig();
    const mesh = resolveScopedMesh(stored, meshId);
    if (!mesh?.magiKindPanels?.[key]) return false;
    delete mesh.magiKindPanels[key];
    if (Object.keys(mesh.magiKindPanels).length === 0) delete mesh.magiKindPanels;
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(stored);
    return true;
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
        const kept = slots.filter(slot => slot.nodeId !== nodeId);
        if (kept.length === slots.length) continue;
        changed = true;
        if (kept.length === 0) delete panels[kind];
        else panels[kind] = kept;
    }
    if (changed && Object.keys(panels).length === 0) delete mesh.magiKindPanels;
    return changed;
}

// ─── Brain routing: per-difficulty brain presets (PER MESH, machine-local) ───
//
// Scoped exactly like the MAGI kind-panels above and through the same helpers
// (resolveScopedMesh / foldLegacyTopLevelMeshSetting): the map lives on the mesh
// entry, `meshId` is optional and resolves to the sole mesh, and a legacy config-root
// map is folded in on load.
//
// This map decides which MODEL a task of a given difficulty runs on, so the old
// config-root key was not merely untidy: the shipped DEFAULT_DIFFICULTY_BRAINS
// (difficult → opus) applied to EVERY mesh on the machine, and one mesh's override
// silently replaced another's. Per-mesh scope is what lets one mesh opt down to
// sonnet without changing what any other mesh runs.

/**
 * The difficulty→brain presets for one mesh. Returns a normalized copy — never the
 * stored reference.
 *
 * When that mesh has nothing configured this falls back to DEFAULT_DIFFICULTY_BRAINS,
 * which is now EMPTY by design (see brain-routing.ts): nothing ships pre-stamped, so
 * an unconfigured mesh resolves to no preset and the node's capability slots alone
 * decide model / thinking level. An operator who explicitly calls setDifficultyBrains
 * still gets exactly what they set.
 *
 * An omitted meshId resolves to the sole mesh; with several meshes it is ambiguous
 * and this returns the (empty) defaults rather than leaking another mesh's model choice.
 */
export function getDifficultyBrains(meshId?: string): DifficultyBrainMap {
    const config = loadMeshConfig();
    const stored = resolveScopedMesh(config, meshId)?.difficultyBrains;
    const normalized = normalizeDifficultyBrainMap(stored);
    return Object.keys(normalized).length > 0 ? normalized : { ...DEFAULT_DIFFICULTY_BRAINS };
}

/**
 * Replace one mesh's difficulty→brain presets wholesale (the editor pushes the full
 * map). Passing an empty/normalized-empty map clears that mesh's override, so
 * getDifficultyBrains falls back to the defaults again for it — other meshes are
 * untouched either way. Returns the normalized, persisted map.
 */
export function setDifficultyBrains(map: unknown, meshId?: string): DifficultyBrainMap {
    const normalized = normalizeDifficultyBrainMap(map);
    const stored = loadMeshConfig();
    const mesh = resolveScopedMesh(stored, meshId);
    if (!mesh) {
        throw new Error(
            meshId?.trim()
                ? `invalid_difficulty_brains: mesh '${meshId.trim()}' not found`
                : `difficulty_brains_mesh_ambiguous: this machine hosts ${stored.meshes.length} meshes, `
                  + `so a difficulty-brain write must name its mesh explicitly (meshId). Presets are per mesh — `
                  + `they decide which model a task runs on, so writing to the wrong mesh changes what it costs.`,
        );
    }
    if (Object.keys(normalized).length > 0) mesh.difficultyBrains = normalized;
    else delete mesh.difficultyBrains;
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(stored);
    return normalized;
}
