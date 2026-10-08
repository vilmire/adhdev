/**
 * meshes.json on disk: its path, the cross-process write lock every mutator takes,
 * read / stat / save, and the load-time migrations (legacy top-level settings,
 * provider roles → capability slots, repo identity normalization) that bring an
 * older file up to the current shape. The CRUD modules build on this.
 */
import { join } from 'path';
import { getConfigDir } from './config.js';
import { mkdirSync, rmSync, statSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import type { LocalMeshConfig, LocalMeshEntry } from '../repo-mesh-types.js';
import { migratePolicyToSparseOverrides, MESH_POLICY_STORAGE_VERSION } from '../repo-mesh-policy-resolve.js';
import { stripRemovedCoordinatorPromptFields } from './mesh-json-config.js';
import { normalizeDifficultyBrainMap, DEFAULT_DIFFICULTY_BRAINS, normalizeNodeCapabilitySlots, deriveSlotsFromLegacy, type DifficultyBrainMap, type NodeCapabilitySlot } from '@adhdev/mesh-shared';

// ─── Persistence ────────────────────────────────

function getMeshConfigPath(): string {
    return join(getConfigDir(), 'meshes.json');
}

// ─── Write serialization (lockless read-modify-write fix) ─────────────────
//
// Every mutator below is a read-modify-write over the WHOLE meshes.json
// document, and every save is a whole-file overwrite. Two writers on the same
// machine interleaving (observed live: clone_mesh_node's addNode against
// apply_mesh_host_join; and plan_mesh_onboarding's eager-migration persist
// rewriting a copy loaded BEFORE nodes were added — updatedAt 15:50:06 older
// than nodes stamped 15:50:13/15:50:31) is a last-writer-wins overwrite that
// silently drops the other writer's entries. Node-level fixes:
//   1. every mutator's load→mutate→save span runs under a cross-process
//      mkdir lock (withMeshConfigWriteLock), so a writer always reads what the
//      previous writer committed;
//   2. the save itself is atomic (tmp sibling + rename), so a reader never
//      sees a torn half-written file.
// The lock is best-effort: on acquisition timeout the write proceeds unlocked
// (degrades to the pre-fix behavior) rather than wedging the registry, and a
// lock abandoned by a crashed process is broken after STALE_MS.

const MESH_CONFIG_LOCK_WAIT_MS = 2000;
const MESH_CONFIG_LOCK_STALE_MS = 15_000;
const MESH_CONFIG_LOCK_POLL_MS = 25;

// In-process reentrancy: loadMeshConfig's eager-migration persist runs INSIDE
// mutators that already hold the lock. Node is single-threaded and every
// writer here is synchronous, so a plain boolean is a correct guard.
let meshConfigLockHeldInProcess = false;

function sleepBlockingMs(ms: number): void {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireMeshConfigLock(): (() => void) | null {
    const lockPath = `${getMeshConfigPath()}.lock`;
    const deadline = Date.now() + MESH_CONFIG_LOCK_WAIT_MS;
    while (Date.now() <= deadline) {
        try {
            mkdirSync(lockPath);
            return () => {
                try {
                    rmSync(lockPath, { recursive: true, force: true });
                } catch {
                    // Ignore lock cleanup failures.
                }
            };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') return null;
            try {
                const stat = statSync(lockPath);
                if (Date.now() - stat.mtimeMs > MESH_CONFIG_LOCK_STALE_MS) {
                    // Abandoned by a crashed writer; break it.
                    rmSync(lockPath, { recursive: true, force: true });
                    continue;
                }
            } catch {
                // Lock disappeared between stat attempts; retry immediately.
                continue;
            }
            sleepBlockingMs(MESH_CONFIG_LOCK_POLL_MS);
        }
    }
    return null;
}

/**
 * Run a full load→mutate→save span under the cross-process meshes.json lock.
 * Reentrant within this process (see meshConfigLockHeldInProcess). When the
 * lock cannot be acquired the span still runs — a slow or wedged peer must
 * degrade write isolation, never block mesh operations outright.
 */
export function withMeshConfigWriteLock<T>(fn: () => T): T {
    if (meshConfigLockHeldInProcess) return fn();
    const release = acquireMeshConfigLock();
    if (!release) return fn();
    meshConfigLockHeldInProcess = true;
    try {
        return fn();
    } finally {
        meshConfigLockHeldInProcess = false;
        release();
    }
}

/**
 * Raw read of meshes.json with failure distinguishable from empty: returns null
 * when the file is missing or unparseable (e.g. a torn mid-edit write). Callers
 * that hold an in-memory copy of policy data use this to KEEP that copy on a
 * failed read instead of falling back to defaults — the safe direction for
 * security flags (requireApprovalForPush / requireApprovalForDestructiveGit),
 * which must never silently loosen because an operator's editor wrote half a file.
 */
export function readMeshConfigFromDisk(): LocalMeshConfig | null {
    const path = getMeshConfigPath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw || !Array.isArray(raw.meshes)) return null;
        return raw as LocalMeshConfig;
    } catch {
        return null;
    }
}

/** Cheap change signal for meshes.json; null when the file is absent/unreadable. */
export function statMeshConfigFile(): { mtimeMs: number; size: number } | null {
    try {
        const stat = statSync(getMeshConfigPath());
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
        return null;
    }
}

/** Raw read of meshes.json: no migration, no persist, never throws. */
function readMeshConfigFile(): LocalMeshConfig {
    return readMeshConfigFromDisk() ?? { meshes: [] };
}

export function loadMeshConfig(options: { persistMigrations?: boolean } = {}): LocalMeshConfig {
    const config = readMeshConfigFile();
    const migrated = migrateLoadedMeshConfig(config);
    // Persist eagerly when the on-load migration changed anything, so the
    // dead field is gone from disk even on a pure-read path (mesh_status /
    // mesh_list_nodes) that never otherwise mutates the config. Best-effort:
    // a write failure (e.g. read-only fs) must not break reads, so swallow.
    if (migrated && options.persistMigrations !== false) {
        try {
            // RE-READ under the write lock and re-migrate the fresh copy.
            // Persisting the copy loaded above would itself be a lockless
            // read-modify-write: a peer's commit landing between our read and
            // our save would be overwritten with the stale copy (the exact
            // 2026-08-22 live evidence this module's lock now fixes).
            withMeshConfigWriteLock(() => {
                const fresh = readMeshConfigFile();
                const policyMigrationPending = fresh.meshes.some(meshNeedsPolicyStorageMigration);
                if (migrateLoadedMeshConfig(fresh)) {
                    if (policyMigrationPending) backupMeshConfigBeforePolicyMigration();
                    saveMeshConfig(fresh);
                }
            });
        } catch {
            // keep the in-memory strip; disk converges on the next mutating op
        }
    }
    return config;
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
    if (foldLegacyTopLevelMeshSetting(config, 'difficultyBrains', 'difficulty_brains_set({ meshId, difficultyBrains })')) changed = true;
    // The retired MAGI review panels (`magiKindPanels`, config root or per mesh) have
    // no reader any more — strip them so the next save persists them gone.
    const rootRecord = config as unknown as Record<string, unknown>;
    if ('magiKindPanels' in rootRecord) {
        delete rootRecord.magiKindPanels;
        changed = true;
    }
    for (const mesh of config.meshes) {
        const meshRecord = mesh as unknown as Record<string, unknown> | undefined;
        if (meshRecord && 'magiKindPanels' in meshRecord) {
            delete meshRecord.magiKindPanels;
            changed = true;
        }
        if (migrateMeshPolicyStorage(mesh)) changed = true;
        // Removed coordinator prompt keys (systemPromptOverride / the
        // systemPromptSuffix alias, 2026-10-08): ignore them in memory. Not
        // counted as a migration — the file is not rewritten just for this;
        // the keys drop off disk on the next save that happens anyway.
        if (mesh?.coordinator) mesh.coordinator = stripRemovedCoordinatorPromptFields(mesh.coordinator);
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

/** True when a mesh entry still stores its policy in the pre-sparse (full copy) form. */
function meshNeedsPolicyStorageMigration(mesh: LocalMeshEntry | undefined): boolean {
    return !!mesh && typeof mesh === 'object' && mesh.policyStorage !== MESH_POLICY_STORAGE_VERSION;
}

/**
 * SPARSE POLICY migration (docs/design/2026-10-07-mesh-workspace-policy.md §A), once per
 * mesh: the stored policy becomes the owner's overrides only (see
 * migratePolicyToSparseOverrides for the provenance rule and the one deliberate
 * behavior change, E2), retired keys are dropped, and `policyStorage: 2` marks it done.
 * Returns true when the entry was mutated.
 */
export function migrateMeshPolicyStorage(mesh: LocalMeshEntry | undefined): boolean {
    if (!meshNeedsPolicyStorageMigration(mesh)) return false;
    const entry = mesh as LocalMeshEntry;
    entry.policy = migratePolicyToSparseOverrides(entry.policy);
    entry.policyStorage = MESH_POLICY_STORAGE_VERSION;
    return true;
}

/**
 * One backup of meshes.json taken right before the sparse-policy migration first
 * persists (`meshes.json.bak-policy-sparse`). Never overwritten — the first copy is
 * the pre-migration file. Best-effort: a failed backup does not block the migration.
 */
function backupMeshConfigBeforePolicyMigration(): void {
    const path = getMeshConfigPath();
    const backupPath = `${path}.bak-policy-sparse`;
    try {
        if (existsSync(path) && !existsSync(backupPath)) copyFileSync(path, backupPath);
    } catch {
        // best-effort
    }
}

/**
 * PER-MESH SCOPE migration: fold a legacy config-root setting map into its owning
 * mesh entry, in place, then delete the root key.
 *
 * `difficultyBrains` was keyed by difficulty alone, so on a two-mesh machine a
 * write in one mesh silently overwrote the other's — and this map decides which
 * MODEL a task runs on: the shipped DEFAULT_DIFFICULTY_BRAINS (difficult → opus)
 * applied to every mesh on the machine, so a model nobody selected got stamped
 * onto tasks. It is now stored per mesh, which is what the docs already described.
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
    key: 'difficultyBrains',
    rebindHint: string,
): boolean {
    // The key is gone from LocalMeshConfig's type now that it lives on the mesh
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

export function saveMeshConfig(config: LocalMeshConfig): void {
    const path = getMeshConfigPath();
    // Atomic publish: write a per-process tmp sibling, then rename over the
    // target — a concurrent reader never sees a torn, half-written file.
    // (Overwrite ORDERING between writers is the write lock's job, not this.)
    const tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, path);
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
