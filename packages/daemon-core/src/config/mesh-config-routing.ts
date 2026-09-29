/**
 * Per-mesh routing knobs persisted in meshes.json: the difficulty → brain presets
 * and the quota-routing overrides.
 */
import { normalizeDifficultyBrainMap, DEFAULT_DIFFICULTY_BRAINS, type DifficultyBrainMap } from '@adhdev/mesh-shared';
import { loadMeshConfig, withMeshConfigWriteLock, saveMeshConfig } from './mesh-config-store.js';
import { normalizeQuotaRoutingPolicy, mergeAndNormalizePolicy, type LocalMeshConfig, type LocalMeshEntry, type RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';

/**
 * Resolve which mesh a per-mesh setting applies to when the caller did not name one.
 *
 * The per-mesh machine-local settings (difficulty brains, quota routing) are
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

// ─── Brain routing: per-difficulty brain presets (PER MESH, machine-local) ───
//
// Scoped through the shared helpers (resolveScopedMesh /
// foldLegacyTopLevelMeshSetting): the map lives on the mesh
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
export function setDifficultyBrains(...args: Parameters<typeof setDifficultyBrainsUnlocked>): ReturnType<typeof setDifficultyBrainsUnlocked> {
    return withMeshConfigWriteLock(() => setDifficultyBrainsUnlocked(...args));
}

function setDifficultyBrainsUnlocked(map: unknown, meshId?: string): DifficultyBrainMap {
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

// ─── Quota-aware routing thresholds (PER MESH, machine-local) ───
//
// The write path for RepoMeshPolicy.quotaRouting (the launch GATE / SPREAD
// thresholds — see mesh/mesh-quota-routing.ts). Scoped exactly like the
// difficulty-brain presets above: the overrides live on the mesh entry's
// policy in meshes.json, `meshId` is optional and resolves to the sole mesh,
// and an ambiguous write fails loud rather than silently re-tuning another
// mesh's routing.
//
// Validation is STRICT here at the writer (unknown field / non-number /
// out-of-range → throw) even though resolveQuotaRoutingPolicy already clamps
// defensively at read time: a setup-wizard typo must surface as an error the
// user can fix, not as a silently clamped threshold that gates the mesh in a
// way nobody configured. The read-side clamp stays as the second line of
// defense so even a hand-edited meshes.json can never wedge the gate (a
// clamped percent is bounded 0..100 and stale/missing data still fails open).

/** quotaRouting fields expressed as percentages (0..100). */
const QUOTA_ROUTING_PERCENT_FIELDS = new Set(['sessionMinRemainingPercent', 'weeklyMinRemainingPercent', 'sessionAxisWeeklyHeadroomPercent']);
/** quotaRouting fields that just need to be finite, non-negative numbers. */
const QUOTA_ROUTING_NONNEGATIVE_FIELDS = new Set(['staleAfterMs', 'sessionResetImminentMs', 'spreadBonusMax']);
/** quotaRouting fields that are booleans, not numbers. */
const QUOTA_ROUTING_BOOLEAN_FIELDS = new Set(['quotaBusyFallback']);

/**
 * Strictly validate a quotaRouting overrides object from an external caller
 * (tool / UI). Returns a clean RepoMeshQuotaRoutingPolicy carrying only the
 * known fields; throws `invalid_quota_routing: ...` on anything else. An
 * absent/null input validates to `{}` (clear-all-overrides semantics for the
 * setter).
 */
function validateQuotaRoutingOverrides(input: unknown): RepoMeshQuotaRoutingPolicy {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('invalid_quota_routing: quotaRouting must be an object of threshold overrides');
    }
    const out: RepoMeshQuotaRoutingPolicy = {};
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
        const isPercent = QUOTA_ROUTING_PERCENT_FIELDS.has(key);
        const isBoolean = QUOTA_ROUTING_BOOLEAN_FIELDS.has(key);
        if (!isPercent && !isBoolean && !QUOTA_ROUTING_NONNEGATIVE_FIELDS.has(key)) {
            throw new Error(
                `invalid_quota_routing: unknown field '${key}' (known fields: `
                + [...QUOTA_ROUTING_PERCENT_FIELDS, ...QUOTA_ROUTING_NONNEGATIVE_FIELDS, ...QUOTA_ROUTING_BOOLEAN_FIELDS].join(', ') + ')',
            );
        }
        // Booleans validate on type alone — the numeric range checks below are
        // meaningless for an on/off switch, and `false` must survive them.
        if (isBoolean) {
            if (typeof raw !== 'boolean') {
                throw new Error(`invalid_quota_routing: ${key} must be a boolean (got ${JSON.stringify(raw)})`);
            }
            (out as Record<string, boolean>)[key] = raw;
            continue;
        }
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new Error(`invalid_quota_routing: ${key} must be a finite number (got ${JSON.stringify(raw)})`);
        }
        if (isPercent && (raw < 0 || raw > 100)) {
            throw new Error(`invalid_quota_routing: ${key} must be between 0 and 100 (got ${raw})`);
        }
        if (!isPercent && raw < 0) {
            throw new Error(`invalid_quota_routing: ${key} must be >= 0 (got ${raw})`);
        }
        (out as Record<string, number>)[key] = raw;
    }
    return out;
}

/**
 * The stored quotaRouting overrides for one mesh (normalized; `{}` when the
 * mesh has none, is unknown, or is ambiguous). Readers that need the EFFECTIVE
 * thresholds resolve these through resolveQuotaRoutingPolicy — never read the
 * defaults from here.
 */
export function getMeshQuotaRouting(meshId?: string): RepoMeshQuotaRoutingPolicy {
    const config = loadMeshConfig();
    const stored = resolveScopedMesh(config, meshId)?.policy?.quotaRouting;
    return normalizeQuotaRoutingPolicy(stored) ?? {};
}

/**
 * Replace one mesh's quotaRouting overrides WHOLESALE (the editor pushes the
 * full sub-policy, same contract as setDifficultyBrains). Passing an empty
 * object (or one whose fields all equal the defaults) clears the override
 * entirely — mergeAndNormalizePolicy's persistence economy drops the key, so
 * readers fall back to DEFAULT_QUOTA_ROUTING_POLICY. Returns the normalized,
 * persisted overrides.
 */
export function setMeshQuotaRouting(...args: Parameters<typeof setMeshQuotaRoutingUnlocked>): ReturnType<typeof setMeshQuotaRoutingUnlocked> {
    return withMeshConfigWriteLock(() => setMeshQuotaRoutingUnlocked(...args));
}

function setMeshQuotaRoutingUnlocked(input: unknown, meshId?: string): RepoMeshQuotaRoutingPolicy {
    const overrides = validateQuotaRoutingOverrides(input);
    const stored = loadMeshConfig();
    const mesh = resolveScopedMesh(stored, meshId);
    if (!mesh) {
        throw new Error(
            meshId?.trim()
                ? `invalid_quota_routing: mesh '${meshId.trim()}' not found`
                : `quota_routing_mesh_ambiguous: this machine hosts ${stored.meshes.length} meshes, `
                  + `so a quota-routing write must name its mesh explicitly (meshId). Thresholds are per mesh — `
                  + `they decide which (node, provider) pairs the launch gate skips, so writing to the wrong `
                  + `mesh changes what work that mesh refuses.`,
        );
    }
    mesh.policy = mergeAndNormalizePolicy(mesh.policy, { quotaRouting: overrides });
    mesh.updatedAt = new Date().toISOString();
    saveMeshConfig(stored);
    return normalizeQuotaRoutingPolicy(overrides) ?? {};
}
