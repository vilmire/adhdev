// Repo Mesh policy normalization — the single source of truth for merging and
// clamping stored policy (parallelism, idle TTLs, cleanup modes, delegated-worker
// auto-approve, per-provider / per-slot parallelism). Re-exported by
// ./repo-mesh-types.ts.

import { MESH_SESSION_CLEANUP_MODES, type NodeCapabilitySlot } from '@adhdev/mesh-shared';
import {
    DEFAULT_MESH_POLICY,
    type RepoMeshSpawnedSessionVisibility,
    type RepoMeshPolicy,
    DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES,
    MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES,
    MESH_DELEGATED_SESSION_IDLE_TTL_MAX_MINUTES,
    type RepoMeshSessionCleanupMode,
    normalizeMeshSchedulingStrategy,
    normalizeQuotaRoutingPolicy,
    resolveQuotaRoutingPolicy,
    type RepoMeshNodePolicy,
} from './repo-mesh-policy.js';
import type { ProviderModule } from './providers/contracts.js';
// Type-only import (no runtime cycle) — mesh-json-config imports types from the
// repo-mesh-types barrel, and this direction is `import type` so tsc erases it.
import type { RepoMeshDeclarativeConfig } from './config/mesh-json-config.js';
import { deriveAutoApproveModeRisk } from './providers/auto-approve-modes.js';

// ─── Policy normalization (single source of truth) ──────────────────────────
//
// Storage model (docs/design/2026-10-07-mesh-workspace-policy.md §A): meshes.json
// stores only the keys the owner set (normalizePolicyOverrides / mergePolicyOverrides);
// every reader resolves the effective policy through resolveMeshPolicy. The per-key
// rules (default, clamp, canonical stored form) live in ONE table below, so the
// write path, the reader and the migration can never disagree on what a key means.

const SESSION_CLEANUP_MODES: ReadonlySet<string> = new Set<string>(MESH_SESSION_CLEANUP_MODES);

const SPAWNED_SESSION_VISIBILITY_MODES = new Set<RepoMeshSpawnedSessionVisibility>([
    'visible', 'hidden',
]);

/** Min/max bounds for the global write-task parallel cap. */
export const MESH_MAX_PARALLEL_TASKS_MIN = 1;
export const MESH_MAX_PARALLEL_TASKS_MAX = 64;

/**
 * Default multiplier applied to the write cap to derive the read-only diagnosis
 * cap. Read-only (live_debug_readonly) tasks carry no isolation/merge cost so they
 * run under a separate, looser cap; a missing/invalid readonlyMultiplier resolves
 * to this value, preserving the historical `max(2, write × 2)` behavior.
 */
export const DEFAULT_MESH_READONLY_MULTIPLIER = 2;

/**
 * SINGLE source of truth for the read-only diagnosis cap derivation. Both the live
 * claim path (maybeAutoLaunchOneQueueSession) and the observability projection
 * (buildMeshSchedulingRuntime) read it through here so the exposed cap and the
 * enforced cap can never drift. Floors at 2 so a write cap of 1 still allows two
 * concurrent read-only diagnoses. An out-of-range multiplier falls back to the
 * default (2) — identical to the previous inline `Math.max(2, maxParallel * 2)`.
 */
export function resolveMaxReadonlyParallelTasks(maxParallelTasks: number, multiplier?: unknown): number {
    const raw = Number(multiplier);
    const mult = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MESH_READONLY_MULTIPLIER;
    return Math.max(2, Math.floor(maxParallelTasks) * mult);
}

/**
 * Resolve the effective global write-task parallel cap from a raw policy value,
 * clamped to [MESH_MAX_PARALLEL_TASKS_MIN, MESH_MAX_PARALLEL_TASKS_MAX] and
 * defaulting to DEFAULT_MESH_POLICY.maxParallelTasks for a missing/NaN value.
 * Both the config write path and the runtime scheduler read the cap through this
 * helper so they can never disagree on what "max parallel" means.
 */
export function resolveMaxParallelTasks(value: unknown): number {
    // An unset value goes through the SAME clamp as a stored one: the default (200,
    // "effectively unlimited") used to be returned unclamped while a stored 200 was
    // clamped to 64, so "unset" and "default stored" meant different caps — and
    // sparse policy storage (which drops a stored default) would have silently
    // raised every mesh's cap from 64 to 200.
    const raw = value === undefined || value === null ? DEFAULT_MESH_POLICY.maxParallelTasks : Number(value);
    const n = Number.isFinite(raw) ? raw : DEFAULT_MESH_POLICY.maxParallelTasks;
    return Math.max(MESH_MAX_PARALLEL_TASKS_MIN, Math.min(MESH_MAX_PARALLEL_TASKS_MAX, Math.floor(n)));
}

/**
 * Resolve the delegate idle TTL in MINUTES from a raw policy value.
 * Returns 0 when the reaper is disabled (explicit `0`, `false`, or a negative value).
 * A missing/NaN value takes the default; any other positive value is clamped into
 * [MIN, MAX] so a typo can neither disable the reaper silently nor make it aggressive
 * enough to kill working delegates.
 */
export function resolveDelegatedSessionIdleTtlMinutes(value: unknown): number {
    if (value === false || value === 0) return 0;
    if (value === undefined || value === null) return DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES;
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES;
    if (n <= 0) return 0;
    return Math.max(
        MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES,
        Math.min(MESH_DELEGATED_SESSION_IDLE_TTL_MAX_MINUTES, Math.floor(n)),
    );
}

/** Same resolution, in milliseconds — what the reaper compares `lastActivityAt` against. */
export function resolveDelegatedSessionIdleTtlMs(value: unknown): number {
    return resolveDelegatedSessionIdleTtlMinutes(value) * 60_000;
}

/**
 * Normalize an autoFastForward sub-policy, filling defaults and dropping an
 * invalid maxBehind. Mirrors the (previously mesh-config-local) shape so the merge
 * always emits a fully-populated, valid autoFastForward object.
 */
export function normalizeAutoFastForwardPolicy(value: unknown): NonNullable<RepoMeshPolicy['autoFastForward']> {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const maxBehind = Number(record.maxBehind);
    // Persistence economy: remoteNodes is emitted only when explicitly true and mode
    // only when explicitly 'continuous', so an untouched autoFastForward stays
    // byte-for-byte { enabled, requireCleanSubmodules, [maxBehind] } — the historical
    // self-only / idle-edge default shape.
    return {
        enabled: record.enabled !== false,
        ...(Number.isFinite(maxBehind) && maxBehind >= 0 ? { maxBehind: Math.floor(maxBehind) } : {}),
        requireCleanSubmodules: record.requireCleanSubmodules !== false,
        ...(record.remoteNodes === true ? { remoteNodes: true } : {}),
        ...(record.mode === 'continuous' ? { mode: 'continuous' as const } : {}),
    };
}

/**
 * Stored mesh policy = the keys the mesh owner actually set (sparse overrides).
 * Readers never read it raw for a defaulted key — they go through resolveMeshPolicy.
 * Unknown keys (e.g. refineConfig / worktreeBootstrapConfig, which ride the policy
 * block) pass through untouched in both directions.
 */
export type RepoMeshPolicyOverrides = Partial<RepoMeshPolicy>;

/**
 * Policy keys that no longer exist. Deleted on every write and by the load-time
 * migration; never emitted by resolveMeshPolicy. `requirePre/PostTaskCheckpoint` and
 * `dirtyWorkspaceBehavior` were retired by docs/design/2026-10-07-mesh-workspace-policy.md
 * (B4): dirty handling is a fixed per-node-type rule (mesh-dirty-write-verdict.ts) and
 * Refinery blocks a branch worktree carrying uncommitted work (branch_worktree_dirty).
 */
export const RETIRED_MESH_POLICY_KEYS: readonly string[] = [
    'requirePreTaskCheckpoint',
    'requirePostTaskCheckpoint',
    'dirtyWorkspaceBehavior',
    'magiSessionCleanup',
];
const RETIRED_KEYS: ReadonlySet<string> = new Set(RETIRED_MESH_POLICY_KEYS);

interface PolicyKeySpec {
    /** Effective value for a raw stored value (undefined = unset). May return undefined: no default. */
    effective(value: unknown): unknown;
    /** Canonical stored form (defaults to `effective`). Throws to reject an invalid write. */
    stored?(value: unknown): unknown;
}

const boolDefault = (fallback: boolean): PolicyKeySpec => ({
    effective: (v) => (typeof v === 'boolean' ? v : fallback),
});

/**
 * One row per known policy key: how a stored value resolves, and how it is stored.
 * A key absent here is opaque — stored and resolved verbatim.
 */
const POLICY_KEY_SPECS: Record<string, PolicyKeySpec> = {
    requireApprovalForPush: boolDefault(DEFAULT_MESH_POLICY.requireApprovalForPush),
    allowAutoPublishSubmoduleMainCommits: { effective: (v) => v === true },
    maxParallelTasks: { effective: (v) => resolveMaxParallelTasks(v) },
    schedulingStrategy: { effective: (v) => normalizeMeshSchedulingStrategy(v) },
    spawnedSessionVisibility: {
        effective: (v) => (SPAWNED_SESSION_VISIBILITY_MODES.has(v as RepoMeshSpawnedSessionVisibility)
            ? v
            : DEFAULT_MESH_POLICY.spawnedSessionVisibility),
    },
    delegatedWorkerAutoApprove: boolDefault(DEFAULT_MESH_POLICY.delegatedWorkerAutoApprove !== false),
    delegatedWorkerDangerousModeAllow: { effective: (v) => v === true },
    allowSendKeysDestructive: { effective: (v) => v === true },
    // No single default: an unset value means "the context's default" (a refine /
    // worktree removal → stop_and_delete, a base-node removal → preserve), which is
    // why an EXPLICIT 'preserve' is a real override and is kept.
    sessionCleanupOnNodeRemove: {
        effective: (v) => (SESSION_CLEANUP_MODES.has(v as RepoMeshSessionCleanupMode) ? v : undefined),
    },
    autoFastForward: {
        effective: (v) => normalizeAutoFastForwardPolicy({
            ...DEFAULT_MESH_POLICY.autoFastForward,
            ...(v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
        }),
    },
    maxTaskRetries: {
        effective: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MESH_POLICY.maxTaskRetries),
    },
    idleActiveMissionReminder: { effective: (v) => v !== false },
    delegatedSessionIdleTtlMinutes: { effective: (v) => resolveDelegatedSessionIdleTtlMinutes(v) },
    coordinatorIdlePushPolicy: {
        effective: (v) => (v === 'auto_silent_on_dispatch' ? 'auto_silent_on_dispatch' : 'always'),
    },
    quotaRouting: {
        effective: (v) => resolveQuotaRoutingPolicy(normalizeQuotaRoutingPolicy(v) ?? null),
        stored: (v) => normalizeQuotaRoutingPolicy(v),
    },
    onDependencyFailure: {
        effective: (v) => (v === 'cancel' ? 'cancel' : 'block'),
        // C3: an invalid value fails the write instead of silently becoming `block`.
        stored: (v) => {
            if (v === 'block' || v === 'cancel') return v;
            throw new Error(
                `invalid_on_dependency_failure: must be 'block' or 'cancel' (got ${JSON.stringify(v)}). `
                + 'Invalid values are rejected; they do not silently become \'block\'.',
            );
        },
    },
    worktreeBaseDir: {
        effective: (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
    },
};

function policyRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameValue(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * THE policy reader: the effective policy for a stored (sparse) override block —
 * DEFAULT ⊕ overrides, every known key normalized. Readers of a defaulted key go
 * through here (or a per-key resolver it uses) instead of `mesh.policy.X`; a reader
 * whose meaning is "did the owner set this" asks `key in mesh.policy` instead.
 * Never throws; retired keys are never emitted.
 */
export function resolveMeshPolicy(overrides: unknown): RepoMeshPolicy {
    const src = policyRecord(overrides);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
        if (RETIRED_KEYS.has(key) || key in POLICY_KEY_SPECS) continue;
        if (value !== undefined && value !== null) out[key] = value;
    }
    for (const [key, spec] of Object.entries(POLICY_KEY_SPECS)) {
        const raw = src[key];
        const value = spec.effective(raw === null ? undefined : raw);
        if (value !== undefined) out[key] = value;
    }
    return out as unknown as RepoMeshPolicy;
}

/**
 * Canonical stored form of a policy block: each known key normalized, and dropped
 * when it resolves exactly as an unset key would (`effective(undefined)`). Retired
 * keys and null/undefined values are dropped; unknown keys are kept verbatim.
 * Idempotent, and resolve-neutral: resolveMeshPolicy(normalizePolicyOverrides(p))
 * deep-equals resolveMeshPolicy(p) for every p. Throws only for a value a write must
 * reject (an invalid onDependencyFailure).
 */
export function normalizePolicyOverrides(value: unknown): RepoMeshPolicyOverrides {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(policyRecord(value))) {
        if (RETIRED_KEYS.has(key) || raw === undefined || raw === null) continue;
        const spec = POLICY_KEY_SPECS[key];
        if (!spec) {
            out[key] = raw;
            continue;
        }
        const stored = (spec.stored ?? spec.effective)(raw);
        if (stored === undefined) continue;
        if (sameValue(spec.effective(stored), spec.effective(undefined))) continue;
        out[key] = stored;
    }
    return out as RepoMeshPolicyOverrides;
}

/**
 * Apply a policy PATCH to stored overrides (update_mesh): a key in the patch sets
 * that override, `null` clears it (the key returns to its default), an absent key
 * is untouched. `autoFastForward` merges per sub-key; every other key is replaced
 * wholesale. The result is normalized (sparse).
 */
export function mergePolicyOverrides(base: unknown, patch: unknown): RepoMeshPolicyOverrides {
    const merged: Record<string, unknown> = { ...policyRecord(base) };
    for (const [key, value] of Object.entries(policyRecord(patch))) {
        if (value === undefined) continue;
        if (value === null) {
            delete merged[key];
            continue;
        }
        if (key === 'autoFastForward' && value && typeof value === 'object' && !Array.isArray(value)) {
            merged[key] = { ...policyRecord(merged[key]), ...(value as Record<string, unknown>) };
            continue;
        }
        merged[key] = value;
    }
    return normalizePolicyOverrides(merged);
}

/** Bumped on a mesh entry once its stored policy is in the sparse form (load-time migration). */
export const MESH_POLICY_STORAGE_VERSION = 2;

/**
 * One-time load migration of a mesh's stored policy to sparse overrides.
 *
 * PROVENANCE RULE: a stored value that resolves exactly as an unset key would is
 * treated as a default. Meshes created before sparse storage carry a full copy of the
 * then-defaults, and nothing on disk distinguishes that copy from an owner who chose
 * the same value — resolve-equality is the only rule that is behavior-neutral by
 * construction. The cost: an owner who deliberately chose today's default follows
 * future default changes. A PAST default that differs from today's resolution (e.g. a
 * pre-07-09 `maxParallelTasks: 2`) is kept: dropping it would change behavior.
 *
 * Plus (owner decision E2): a copied `sessionCleanupOnNodeRemove: 'preserve'` is
 * removed — it was the creation-time default copy, and keeping it made refine's
 * worktree session cleanup ignore its stop_and_delete default (REFINE-CLEANUP-DEFAULT).
 * This is the one deliberate behavior change of the migration.
 *
 * Returns the migrated overrides; never throws (an invalid value a write would reject
 * is kept verbatim so the owner's data is not lost).
 */
export function migratePolicyToSparseOverrides(stored: unknown): RepoMeshPolicyOverrides {
    const record = { ...policyRecord(stored) };
    if (record.sessionCleanupOnNodeRemove === 'preserve') delete record.sessionCleanupOnNodeRemove;
    try {
        return normalizePolicyOverrides(record);
    } catch {
        const out: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(record)) {
            if (RETIRED_KEYS.has(key) || raw === undefined || raw === null) continue;
            try {
                const one = normalizePolicyOverrides({ [key]: raw }) as Record<string, unknown>;
                if (key in one) out[key] = one[key];
            } catch {
                out[key] = raw;
            }
        }
        return out as RepoMeshPolicyOverrides;
    }
}

/**
 * Resolve delegated worker auto-approve. Legacy providers return a boolean. Providers
 * with modes return a mode id, except a dangerous mode is downgraded to a
 * non-dangerous PTY mode unless mesh/node policy explicitly opts in.
 *
 * THREE EXPLICIT STAGES — do not collapse them; the ordering is a hard
 * invariant:
 *
 *   ① ENABLE gate (machine-local policy only): node boolean > mesh boolean.
 *      `enabled=false` returns `false` IMMEDIATELY, BEFORE any mode selection.
 *      The repo `mesh.json` providerDefaults has ZERO influence here — a
 *      node/mesh opt-out is never overridden by a repo-declared requested mode.
 *
 *   ② MODE selection (only when enabled === true):
 *        task override [FUTURE — param reserved below, not yet wired] >
 *        repo mesh.json providerDefaults.autoApproveModes[providerType] >
 *        provider spec autoApproveModes.default.
 *      A repo-requested mode ID is adopted ONLY when it exists in the provider's
 *      own `autoApproveModes.modes`; an unknown/stale/typo'd ID is IGNORED and we
 *      fall back to the provider default (fail-closed: never coerce into a
 *      dangerous mode via a bad ID).
 *
 *   ③ DANGEROUS gate: whichever mode stage ② picked, if it is dangerous and the
 *      machine-local delegatedWorkerDangerousModeAllow is not set, downgrade to a
 *      non-dangerous PTY-parse mode (or `false` if none exists).
 */
export function resolveDelegatedWorkerAutoApprove(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    provider?: Pick<ProviderModule, 'autoApproveModes'> | null,
    repoConfig?: RepoMeshDeclarativeConfig | null,
    // providerType is needed to look up the repo-declared requested mode; it is
    // separate from `provider` because the caller resolves the spec independently.
    providerType?: string | null,
    // Per-launch mode override (e.g. a mode explicitly chosen at coordinator-launch
    // time). Wins over repoConfig.providerDefaults when set to a mode ID the spec knows.
    overrideModeId?: string | null,
    // Per-launch boolean override for legacy providers with no declared modes
    // (AutoApproveModesConfig absent) — mirrors the workspace dialog's
    // LegacyAutoApproveToggle. Ignored when the provider declares modes.
    overrideLegacyAutoApprove?: boolean | null,
): boolean | string {
    // ── ① ENABLE gate — machine-local only. false short-circuits before mode. ──
    let enabled = true;
    if (typeof nodePolicy?.delegatedWorkerAutoApprove === 'boolean') {
        enabled = nodePolicy.delegatedWorkerAutoApprove;
    } else if (typeof meshPolicy?.delegatedWorkerAutoApprove === 'boolean') {
        enabled = meshPolicy.delegatedWorkerAutoApprove;
    }
    if (!enabled) return false;

    const modes = provider?.autoApproveModes;
    if (!modes) return typeof overrideLegacyAutoApprove === 'boolean' ? overrideLegacyAutoApprove : true;

    // ── ② MODE selection (enabled only). A per-launch override (e.g. a mode picked
    //     in the new-coordinator dialog) takes precedence over the repo-declared
    //     providerDefaults, which in turn may override the provider spec default —
    //     but only with a mode ID the spec knows. ──
    const overrideModeIdTrimmed = typeof overrideModeId === 'string' ? overrideModeId.trim() : '';
    const requestedModeRaw = overrideModeIdTrimmed
        ? overrideModeIdTrimmed
        : typeof providerType === 'string'
            ? repoConfig?.providerDefaults?.autoApproveModes?.[providerType.trim()]
            : undefined;
    const requestedModeId = typeof requestedModeRaw === 'string' && requestedModeRaw.trim()
        ? requestedModeRaw.trim()
        : '';
    const requestedMode = requestedModeId
        ? modes.modes.find((mode) => mode.id === requestedModeId)
        : undefined;
    const selectedMode = requestedMode
        ?? modes.modes.find((mode) => mode.id === modes.default);
    if (!selectedMode || selectedMode.strategy === 'post-boot-command') return false;

    // ── ③ DANGEROUS gate — downgrade a dangerous selection without machine opt-in. ──
    const dangerousAllowed = resolveDelegatedWorkerDangerousModeAllow(meshPolicy, nodePolicy);
    if (deriveAutoApproveModeRisk(selectedMode) === 'dangerous' && !dangerousAllowed) {
        const ptyFallback = modes.modes.find((mode) =>
            mode.strategy === 'pty-parse-default' && deriveAutoApproveModeRisk(mode) !== 'dangerous');
        return ptyFallback?.id || false;
    }
    return selectedMode.id;
}

export function resolveDelegatedWorkerDangerousModeAllow(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerDangerousModeAllow'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerDangerousModeAllow'> | null,
): boolean {
    if (typeof nodePolicy?.delegatedWorkerDangerousModeAllow === 'boolean') {
        return nodePolicy.delegatedWorkerDangerousModeAllow;
    }
    return meshPolicy?.delegatedWorkerDangerousModeAllow === true;
}

/** Shape a boolean-or-mode resolution for the settings precedence contract. */
export function delegatedWorkerAutoApproveSettings(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    provider?: Pick<ProviderModule, 'autoApproveModes'> | null,
    repoConfig?: RepoMeshDeclarativeConfig | null,
    providerType?: string | null,
    // Per-launch mode override — see resolveDelegatedWorkerAutoApprove.
    overrideModeId?: string | null,
    // Per-launch legacy boolean override — see resolveDelegatedWorkerAutoApprove.
    overrideLegacyAutoApprove?: boolean | null,
): {
    autoApprove: boolean | undefined;
    autoApproveMode: string | undefined;
    delegatedWorkerDangerousModeAllow: boolean;
} {
    const resolved = resolveDelegatedWorkerAutoApprove(meshPolicy, nodePolicy, provider, repoConfig, providerType, overrideModeId, overrideLegacyAutoApprove);
    const delegatedWorkerDangerousModeAllow = resolveDelegatedWorkerDangerousModeAllow(meshPolicy, nodePolicy);
    return typeof resolved === 'string'
        ? { autoApprove: undefined, autoApproveMode: resolved, delegatedWorkerDangerousModeAllow }
        : { autoApprove: resolved, autoApproveMode: undefined, delegatedWorkerDangerousModeAllow };
}

/**
 * MESH-SEND-KEYS (feature 3): resolve whether DESTRUCTIVE key injection
 * (CTRL_C/ESC via mesh_send_keys) is permitted for a node. Node policy overrides
 * mesh policy; DEFAULTS TO FALSE (fail-closed) — a destructive key still requires
 * a per-call confirm_destructive=true on top of this opt-in.
 */
export function resolveAllowSendKeysDestructive(
    meshPolicy?: Pick<RepoMeshPolicy, 'allowSendKeysDestructive'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'allowSendKeysDestructive'> | null,
): boolean {
    if (typeof nodePolicy?.allowSendKeysDestructive === 'boolean') {
        return nodePolicy.allowSendKeysDestructive;
    }
    if (typeof meshPolicy?.allowSendKeysDestructive === 'boolean') {
        return meshPolicy.allowSendKeysDestructive;
    }
    return false;
}

/**
 * Resolve the enforced per-(node, provider) maxParallel cap from a node's resolved
 * capability slots, or undefined when no matching slot declares a finite cap. Used
 * by the queue claim path as a stricter-wins constraint layered on top of the global
 * caps. Case-insensitive, trimmed match on the slot's provider.
 *
 * When a node declares multiple slots for the same provider (e.g. distinct
 * difficulty ranges), their caps SUM into a single per-(node, provider) pool — the
 * provider can run up to the total across all its slots. Legacy-derived slots (via
 * deriveSlotsFromLegacy) produce one slot per provider, so the sum equals that
 * single slot's cap and behavior is preserved exactly.
 *
 * Callers pass the already-resolved slots (explicit policy.slots, else legacy-
 * derived) — this keeps the resolver free of the difficultyBrains dependency and
 * usable from any layer.
 */
export function resolveProviderMaxParallel(
    slots: NodeCapabilitySlot[] | null | undefined,
    providerType: string | null | undefined,
): number | undefined {
    const wanted = typeof providerType === 'string' ? providerType.trim().toLowerCase() : '';
    if (!wanted) return undefined;
    if (!Array.isArray(slots)) return undefined;
    let total: number | undefined;
    for (const slot of slots) {
        if (!slot || typeof slot !== 'object') continue;
        const type = typeof slot.provider === 'string' ? slot.provider.trim().toLowerCase() : '';
        if (!type || type !== wanted) continue;
        const raw = Number(slot.maxParallel);
        if (!Number.isFinite(raw) || raw < 0) continue;
        total = (total ?? 0) + Math.floor(raw);
    }
    return total;
}

/**
 * Resolve the enforced per-SLOT maxParallel cap: how many tasks may run concurrently
 * on the slot identified by (provider, model), or undefined when no such slot
 * declares a finite cap (uncapped).
 *
 * WHY THIS EXISTS, SEPARATE FROM resolveProviderMaxParallel: a slot is an independent
 * unit and its `maxParallel` is that slot's own concurrency, not a contribution to a
 * shared provider pool. A node declaring
 *   { provider: 'claude-cli', model: 'opus',   difficulty: ['difficult'], maxParallel: 1 }
 *   { provider: 'claude-cli', model: 'sonnet', difficulty: ['medium'],    maxParallel: 3 }
 * means "opus runs at most ONE task on this machine, ever" — the point of pinning opus
 * to 1 is cost and rate-limit control. Summing those into a single claude-cli pool of 4
 * let opus run up to 4 concurrently as long as the sonnet slot sat idle, defeating the
 * cap entirely. Idle headroom on the sonnet slot must NOT flow to opus.
 *
 * SLOT IDENTITY is (provider, model), deliberately not the array index and not the full
 * slot shape:
 *   - The array index is unstable: slot writes are WHOLESALE replacements, so index 1
 *     can denote a different slot between when a task was claimed and when it is
 *     counted, charging in-flight work to the wrong budget.
 *   - The full composite (…+thinkingLevel+difficulty+capability) is over-specific:
 *     editing a slot's difficulty range would orphan its in-flight rows, silently
 *     freeing their budget at the exact moment an operator was retuning it.
 *   (provider, model) is the axis the cap is actually expressed on, and it is stable
 *   across edits to the fields that do not change which model runs.
 *
 * Model matching is injected (`modelMatchesSlot`) rather than imported so this module
 * stays dependency-free; callers pass isModelAllowedBySlot, which uses the same
 * canonical identity as the slot-model guard. That way the surface forms `opus`,
 * `claude-opus-4-6` and `Claude Opus 4.6 (Thinking)` all resolve to ONE slot instead of
 * fragmenting its budget (the canon-identity defect class), and a model-less slot pairs
 * with a model-less launch rather than matching everything.
 *
 * A slot with no `maxParallel` is UNCAPPED (returns undefined) — matching the prior
 * behavior for uncapped slots.
 */
export function resolveSlotMaxParallel(
    slots: NodeCapabilitySlot[] | null | undefined,
    providerType: string | null | undefined,
    model: string | null | undefined,
    modelMatchesSlot: (model: string | undefined, slot: NodeCapabilitySlot) => boolean,
): number | undefined {
    const wanted = typeof providerType === 'string' ? providerType.trim().toLowerCase() : '';
    if (!wanted) return undefined;
    if (!Array.isArray(slots)) return undefined;
    const wantedModel = typeof model === 'string' && model.trim() ? model.trim() : undefined;
    let total: number | undefined;
    for (const slot of slots) {
        if (!slot || typeof slot !== 'object') continue;
        const type = typeof slot.provider === 'string' ? slot.provider.trim().toLowerCase() : '';
        if (!type || type !== wanted) continue;
        if (!modelMatchesSlot(wantedModel, slot)) continue;
        const raw = Number(slot.maxParallel);
        if (!Number.isFinite(raw) || raw < 0) continue;
        // Sum only across slots that are the SAME (provider, model) — i.e. genuine
        // duplicates of one logical slot, not different models on one provider.
        total = (total ?? 0) + Math.floor(raw);
    }
    return total;
}
