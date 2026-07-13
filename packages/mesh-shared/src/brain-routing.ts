/**
 * Brain-routing (task difficulty → provider/model/thinking) types.
 *
 * The coordinator classifies each task it enqueues by execution difficulty, and a
 * per-difficulty "brain" preset resolves that into a concrete provider / model /
 * thinking-level for the launched session. The goal is token economy: an `easy`
 * task runs on a cheaper model at low reasoning effort; a `difficult` task gets a
 * stronger model at high effort. This is a separate axis from MAGI's review kinds
 * (rca/design/…) — MAGI fans out review replicas; this picks the single brain that
 * *executes* a task — but it reuses the same slot shape (provider/model) and the
 * same machine-local storage (`~/.adhdev/meshes.json`).
 */

/** The fixed difficulty axis the coordinator classifies a task into. */
export type MeshTaskDifficulty = 'easy' | 'medium' | 'difficult' | 'freeform'

export const MESH_TASK_DIFFICULTIES: MeshTaskDifficulty[] = ['easy', 'medium', 'difficult', 'freeform']

/**
 * A per-difficulty brain preset: which provider / model / thinking level a task of
 * that difficulty should run on. Every field is optional — a preset may set only a
 * model (keep the routed provider) or only a thinking level. Applied at enqueue:
 * an explicit model/thinkingLevel on the task always wins over the preset.
 */
export interface BrainSlot {
    /** Optional provider type, e.g. 'claude-cli' | 'codex-cli'. Absent → keep the tag/priority-routed provider. */
    provider?: string
    /** Optional model, e.g. 'opus' | 'sonnet' | 'haiku'. Best-effort at launch (initialModel). */
    model?: string
    /** Optional standard thinking level, 'low' | 'medium' | 'high'. Best-effort (initialThinkingLevel). */
    thinkingLevel?: 'low' | 'medium' | 'high'
}

/**
 * Per-difficulty brain bindings, stored machine-local in `~/.adhdev/meshes.json`
 * under the top-level `difficultyBrains` map (sibling of `magiKindPanels`). A
 * difficulty absent from the map has no preset — the task runs with no
 * difficulty-derived model/thinking (ordinary routing).
 */
export type DifficultyBrainMap = Partial<Record<MeshTaskDifficulty, BrainSlot>>

/** True for a recognized difficulty value. */
export function isMeshTaskDifficulty(value: unknown): value is MeshTaskDifficulty {
    return typeof value === 'string' && (MESH_TASK_DIFFICULTIES as string[]).includes(value)
}

/**
 * Sensible default presets, seeded when a mesh has no `difficultyBrains` configured
 * yet. Model names are provider-agnostic strings (opus/sonnet/haiku); a provider
 * that cannot honor a given model or thinking level ignores it (best-effort). The
 * operator can edit these. `freeform` has no preset by default (untouched routing).
 */
export const DEFAULT_DIFFICULTY_BRAINS: DifficultyBrainMap = {
    easy: { model: 'haiku', thinkingLevel: 'low' },
    medium: { model: 'sonnet', thinkingLevel: 'medium' },
    difficult: { model: 'opus', thinkingLevel: 'high' },
}

/** Normalize a raw thinking level to the standard union, or undefined. */
export function normalizeThinkingLevel(value: unknown): 'low' | 'medium' | 'high' | undefined {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return v === 'low' || v === 'medium' || v === 'high' ? v : undefined
}

/** Normalize a raw BrainSlot (trim strings, drop empties, clamp thinkingLevel). */
export function normalizeBrainSlot(raw: unknown): BrainSlot {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    const provider = typeof r.provider === 'string' ? r.provider.trim() : ''
    const model = typeof r.model === 'string' ? r.model.trim() : ''
    const thinkingLevel = normalizeThinkingLevel(r.thinkingLevel)
    return {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
    }
}

/** Normalize a raw DifficultyBrainMap, dropping unknown keys and empty slots. */
export function normalizeDifficultyBrainMap(raw: unknown): DifficultyBrainMap {
    const out: DifficultyBrainMap = {}
    if (!raw || typeof raw !== 'object') return out
    for (const key of MESH_TASK_DIFFICULTIES) {
        const slot = normalizeBrainSlot((raw as Record<string, unknown>)[key])
        if (slot.provider || slot.model || slot.thinkingLevel) out[key] = slot
    }
    return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Node capability slots (ORCHESTRATION_NODE_SLOTS.md)
//
// A node's "Preferred AI tools" list is redefined as an ordered array of
// capability slots. Each slot bundles what used to be scattered across
// providerPriority (order), a per-provider maxParallel cap, and the
// machine-global difficultyBrains (difficulty → model/thinking). Slot order =
// preference. This single profile is the source of truth for task routing, MAGI
// fan-out, and orchestrator-proposed edits.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One capability slot on a mesh node. Extends the BrainSlot shape
 * (provider/model/thinkingLevel) with the difficulty range it handles, capability
 * tags, and a per-slot parallelism cap.
 */
export interface NodeCapabilitySlot {
    /** Provider type this slot uses, e.g. 'claude-cli' | 'codex-cli'. Required (a slot is defined by its provider). */
    provider: string
    /** Optional model, e.g. 'opus' | 'sonnet' | 'haiku'. Best-effort at launch. */
    model?: string
    /**
     * Optional thinking level. The provider's own vocabulary (e.g. low/medium/high,
     * or codex's low/medium/high/max) passed through verbatim — best-effort at
     * launch. A string, not the standard union, so provider-declared levels like
     * 'max' are not dropped.
     */
    thinkingLevel?: string
    /**
     * Difficulty range this slot handles. Empty/absent = handles all difficulties
     * (a general-purpose slot). A task's difficulty is matched against this range;
     * no exact match falls back to the nearest/general slot (never blocks).
     */
    difficulty?: MeshTaskDifficulty[]
    /** Capability tags this slot satisfies (matched against a task's requiredTags). */
    capability?: string[]
    /** Per-node·per-slot max concurrent tasks. Omit = no per-slot cap. */
    maxParallel?: number
}

/** Normalize a raw NodeCapabilitySlot; returns null when it has no usable provider. */
export function normalizeNodeCapabilitySlot(raw: unknown): NodeCapabilitySlot | null {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    const provider = typeof r.provider === 'string' ? r.provider.trim() : ''
    if (!provider) return null
    const model = typeof r.model === 'string' ? r.model.trim() : ''
    // Pass the provider's own thinking-level vocabulary through verbatim (don't
    // clamp to low/medium/high — a provider may declare 'max' etc.).
    const thinkingLevel = typeof r.thinkingLevel === 'string' ? r.thinkingLevel.trim() : ''
    const difficulty = Array.isArray(r.difficulty)
        ? (r.difficulty.filter(isMeshTaskDifficulty) as MeshTaskDifficulty[])
        : []
    const capability = Array.isArray(r.capability)
        ? r.capability.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim())
        : []
    const maxParallelNum = Number(r.maxParallel)
    const maxParallel = Number.isFinite(maxParallelNum) && maxParallelNum > 0 ? Math.floor(maxParallelNum) : undefined
    return {
        provider,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(difficulty.length ? { difficulty } : {}),
        ...(capability.length ? { capability } : {}),
        ...(maxParallel !== undefined ? { maxParallel } : {}),
    }
}

/** Normalize a raw slot array, dropping provider-less entries. */
export function normalizeNodeCapabilitySlots(raw: unknown): NodeCapabilitySlot[] {
    if (!Array.isArray(raw)) return []
    const out: NodeCapabilitySlot[] = []
    for (const entry of raw) {
        const slot = normalizeNodeCapabilitySlot(entry)
        if (slot) out.push(slot)
    }
    return out
}

/**
 * Back-compat migration: derive capability slots from the legacy fields when a
 * node has no explicit `slots`. Order follows providerPriority; difficulty/model/
 * thinking are folded in from the machine-global difficultyBrains (each difficulty
 * attaches to the slot whose provider the brain preset names, or — when the brain
 * has no provider — to every slot as a shared model/thinking default for that
 * difficulty).
 *
 * (Legacy nodes' per-provider `maxParallel` cap has been migrated onto
 * `slots[].maxParallel` at config-load time, so it is no longer folded in here.)
 *
 * Returns [] when there's nothing to derive (caller then keeps legacy behavior:
 * first available provider).
 */
export function deriveSlotsFromLegacy(input: {
    providerPriority?: string[]
    difficultyBrains?: DifficultyBrainMap
}): NodeCapabilitySlot[] {
    const priority = Array.isArray(input.providerPriority)
        ? input.providerPriority.filter((p): p is string => typeof p === 'string' && !!p.trim()).map(p => p.trim())
        : []
    if (priority.length === 0) return []

    // Brain presets keyed by the provider they name (provider-specific), plus a
    // provider-agnostic list applied to every slot as a shared default.
    const brains = input.difficultyBrains || {}
    const byProvider = new Map<string, Array<{ difficulty: MeshTaskDifficulty; model?: string; thinkingLevel?: 'low' | 'medium' | 'high' }>>()
    const shared: Array<{ difficulty: MeshTaskDifficulty; model?: string; thinkingLevel?: 'low' | 'medium' | 'high' }> = []
    for (const diff of MESH_TASK_DIFFICULTIES) {
        const b = brains[diff]
        if (!b) continue
        const entry = { difficulty: diff, model: b.model, thinkingLevel: b.thinkingLevel }
        if (b.provider) {
            const list = byProvider.get(b.provider) ?? []
            list.push(entry)
            byProvider.set(b.provider, list)
        } else {
            shared.push(entry)
        }
    }

    return priority.map((provider): NodeCapabilitySlot => {
        // Provider-specific brain first, else the shared default, else nothing.
        const specific = byProvider.get(provider) || []
        const applied = specific.length ? specific : shared
        const difficulty = applied.map(a => a.difficulty)
        // Fold model/thinking from the applied presets: take the first that sets each.
        const model = applied.find(a => a.model)?.model
        const thinkingLevel = applied.find(a => a.thinkingLevel)?.thinkingLevel
        return {
            provider,
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            ...(difficulty.length ? { difficulty } : {}),
        }
    })
}
