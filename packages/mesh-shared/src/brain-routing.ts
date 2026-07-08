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
