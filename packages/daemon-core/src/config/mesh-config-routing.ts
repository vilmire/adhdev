/**
 * Per-mesh routing knobs persisted in meshes.json: MAGI kind panels (and their
 * slot normalization, including the pruning when a node is removed), the
 * difficulty → brain presets, and the quota-routing overrides.
 */
import { normalizeDifficultyBrainMap, DEFAULT_DIFFICULTY_BRAINS, type MagiTaskKind, type MagiSlot, type MagiKindPanelMap, type DifficultyBrainMap } from '@adhdev/mesh-shared';
import { normalizeCapabilityTags, loadMeshConfig, withMeshConfigWriteLock, saveMeshConfig } from './mesh-config-store.js';
import { normalizeQuotaRoutingPolicy, mergeAndNormalizePolicy, type LocalMeshConfig, type LocalMeshEntry, type RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';

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
 * The keys a MagiSlot accepts. A kind-panel slot is DELIBERATELY a reduced schema —
 * see the MagiSlot doc comment in mesh-shared for why the node-capability axes
 * (thinkingLevel / difficulty / maxParallel) are absent rather than missing.
 *
 * Used only to REPORT what a write silently dropped (see collectIgnoredMagiSlotFields).
 * normalizeMagiSlots itself keeps ignoring unknown keys: rejecting them would break
 * read-back of slots already on disk, which is a far worse failure than a dropped hint.
 */
const MAGI_SLOT_KNOWN_KEYS: readonly string[] = ['provider', 'nodeId', 'model', 'capabilityTags', 'n'];

/**
 * Per-field explanation for a dropped key, so the caller can say WHY rather than only
 * THAT something was ignored. A key with no entry gets a generic message.
 */
const MAGI_SLOT_IGNORED_FIELD_REASONS: Readonly<Record<string, string>> = Object.freeze({
    thinkingLevel: "not part of a MAGI slot — a panel selects WHO answers independently, not how hard each replica thinks. Set thinkingLevel on the node's capability slots (mesh_node_slots action 'set'), which is the routing axis.",
    difficulty: "not part of a MAGI slot — MAGI always enqueues its replicas with the fixed 'freeform' difficulty sentinel because the panel has already chosen the (node, provider) target. Set difficulty on the node's capability slots instead.",
    maxParallel: "not part of a MAGI slot — per-slot concurrency is a node capability-slot axis. Use the per-slot `n` replica count to control MAGI fan-out width.",
    capability: 'not a MAGI slot key — did you mean `capabilityTags`?',
});

/**
 * Report the keys a MagiSlot payload carries that {@link normalizeMagiSlots} will
 * silently drop, WITHOUT changing what that normalizer does.
 *
 * ─── Why report instead of reject ────────────────────────────────────────────
 *
 * The normalizer is an allow-list: it rebuilds each slot from the five known keys and
 * ignores the rest. That is correct for reads — a slot already persisted with an extra
 * key must stay readable — but on a WRITE it meant an operator could set `thinkingLevel`
 * on a panel slot and get no rejection, no warning, and no effect. Silent data loss is
 * its own defect class, independent of whether the reduced schema is right (it is).
 *
 * So this is a pure, additive side channel: callers surface its result as
 * `ignoredFields` on the response. It NEVER throws and is NEVER consulted by the
 * normalizer, so no read path can regress on a payload that this function would flag.
 *
 * Returns [] for valid, fully-recognized input — a clean write stays silent.
 */
export function collectIgnoredMagiSlotFields(
    slots: unknown,
): Array<{ slot: number; field: string; reason: string }> {
    if (!Array.isArray(slots)) return [];
    const out: Array<{ slot: number; field: string; reason: string }> = [];
    slots.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        for (const key of Object.keys(entry as Record<string, unknown>)) {
            if (MAGI_SLOT_KNOWN_KEYS.includes(key)) continue;
            out.push({
                slot: idx,
                field: key,
                reason: MAGI_SLOT_IGNORED_FIELD_REASONS[key]
                    ?? `not a recognized MAGI slot key (accepted: ${MAGI_SLOT_KNOWN_KEYS.join(', ')}); it was dropped and has no effect.`,
            });
        }
    });
    return out;
}

/**
 * Validate + normalize a kind-panel's slots (the SOLE MAGI slot normalizer): provider
 * required per slot, trims strings, drops empties, clamps replica counts, and carries
 * an optional per-slot `model`. Throws on structurally invalid input (empty list / no
 * provider) so the write returns a clear error. Returns the normalized slot array.
 *
 * Unknown keys are IGNORED, not rejected — a slot persisted by an older or newer
 * writer must remain readable. Write paths pair this with
 * {@link collectIgnoredMagiSlotFields} to report what was dropped instead of losing it
 * silently.
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
export function setMagiKindPanel(...args: Parameters<typeof setMagiKindPanelUnlocked>): ReturnType<typeof setMagiKindPanelUnlocked> {
    return withMeshConfigWriteLock(() => setMagiKindPanelUnlocked(...args));
}

function setMagiKindPanelUnlocked(kind: string, slots: unknown, meshId?: string): MagiSlot[] {
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
export function removeMagiKindPanel(...args: Parameters<typeof removeMagiKindPanelUnlocked>): ReturnType<typeof removeMagiKindPanelUnlocked> {
    return withMeshConfigWriteLock(() => removeMagiKindPanelUnlocked(...args));
}

function removeMagiKindPanelUnlocked(kind: string, meshId?: string): boolean {
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
