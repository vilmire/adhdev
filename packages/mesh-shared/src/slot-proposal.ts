/**
 * CLI auto-detect → capability-slot / MAGI-panel PROPOSAL generator.
 *
 * Detection of installed CLI providers already exists per node (the status
 * snapshot's `availableProviders`), and applying a slot profile already exists
 * (`mesh_node_slots_set`, dry-run by default). What was missing is the bit in
 * between: turning "these CLIs are installed on this node" into a concrete
 * `NodeCapabilitySlot[]` draft the operator can review. This module is that
 * bridge, and nothing more — it is a PURE proposal generator. It never writes;
 * the caller feeds its output into the existing dry-run/approve tools.
 *
 * ─── Why the mapping is a static table ───────────────────────────────────────
 *
 * Provider manifests carry NO difficulty or capability-grade information. The
 * fields that look like they might (`modelOptions`, `thinkingLevelOptions`)
 * describe what a provider ACCEPTS, not what it is GOOD AT — a provider listing
 * `opus` says nothing about whether opus should get the hard tasks. So there is
 * no honest way to derive difficulty from the manifest today.
 *
 * The table below is therefore seeded from the operator's real, in-use slot
 * configuration rather than from a guess. That makes it a starting point with
 * actual provenance, and it is deliberately isolated in ONE constant so the
 * planned usage-data-driven replacement has a single, obvious swap point.
 *
 * Kept in the dependency-free mesh-shared leaf because both daemon-core (which
 * has the detection data) and mcp-server (which owns the propose/apply tools)
 * need it, and it is pure data + pure functions on plain objects.
 */
import {
    normalizeNodeCapabilitySlot,
    type MeshTaskDifficulty,
    type NodeCapabilitySlot,
} from './brain-routing'
import type { MagiSlot } from './magi'

/**
 * One provider's seeded slot recipe. A provider may map to MORE THAN ONE slot
 * (claude-cli does: a wide sonnet slot plus a narrow opus slot for the hard
 * work), which is why the table's values are arrays.
 */
export interface CliSlotRecipe {
    /** Optional model to pin on the slot. Best-effort at launch. */
    model?: string
    /** Optional thinking level, in the provider's own vocabulary. */
    thinkingLevel?: string
    /** Difficulty range this slot handles. Empty = general-purpose. */
    difficulty?: MeshTaskDifficulty[]
    /** Per-slot concurrency cap. */
    maxParallel?: number
    /**
     * Set when this recipe is an unvalidated guess rather than a transcription
     * of a slot the operator actually runs. Surfaced on the proposal so the
     * reviewer knows which lines to scrutinize.
     */
    provisional?: boolean
    /** Short human-readable justification, echoed into the proposal. */
    rationale?: string
}

/**
 * ★ THE MAPPING TABLE — the single swap point.
 *
 * Seeded (2026-08-03) from the operator's live slot configuration, on the
 * reasoning that a transcription of what is actually in production beats an
 * invented heuristic. Replace wholesale once usage data (success rate, cost,
 * turn latency per provider×difficulty) can drive it.
 *
 * Every entry except `hermes-cli` reflects a real configured slot. `hermes-cli`
 * is a conservative GUESS — see its `provisional` flag.
 */
export const CLI_SLOT_RECIPES: Readonly<Record<string, readonly CliSlotRecipe[]>> = Object.freeze<Record<string, readonly CliSlotRecipe[]>>({
    'claude-cli': [
        {
            model: 'sonnet',
            thinkingLevel: 'high',
            difficulty: ['medium', 'easy'],
            maxParallel: 5,
            rationale: 'Primary workhorse — widest parallelism for routine work.',
        },
        {
            model: 'opus',
            thinkingLevel: 'high',
            difficulty: ['difficult'],
            maxParallel: 1,
            rationale: 'Reserved for hard tasks; capped at 1 to bound cost.',
        },
    ],
    'kimi': [
        {
            model: 'kimi-code/k3',
            difficulty: ['medium', 'difficult'],
            maxParallel: 2,
            rationale: 'Independent second opinion on mid/hard work.',
        },
    ],
    'codex-cli': [
        {
            difficulty: ['medium', 'difficult', 'freeform'],
            maxParallel: 2,
            rationale: 'Broad range including freeform; no model pin.',
        },
    ],
    'antigravity-cli': [
        {
            model: 'Gemini 3.1 Pro (High)',
            difficulty: ['easy'],
            maxParallel: 2,
            rationale: 'Cheap capacity for easy tasks.',
        },
    ],
    'cursor-cli': [
        {
            model: 'auto',
            difficulty: ['easy'],
            maxParallel: 1,
            rationale: 'Easy tasks only; auto model selection.',
        },
    ],
    'hermes-cli': [
        {
            difficulty: ['medium'],
            maxParallel: 2,
            provisional: true,
            // NOTE: ESTIMATE, NOT OBSERVED. hermes-cli is absent from the live
            // slot configuration this table was seeded from, so `medium` is a
            // conservative placement rather than a transcription. Revisit once
            // it has real usage data.
            rationale: 'ESTIMATE — no live slot to transcribe; conservative mid placement. Adjust after real use.',
        },
    ],
})

/**
 * Fallback for a detected CLI provider absent from {@link CLI_SLOT_RECIPES}.
 * Deliberately timid: one general-purpose slot at the lowest parallelism, so an
 * unrecognized provider can be used but never silently soaks up the queue.
 */
export const UNKNOWN_CLI_SLOT_RECIPE: Readonly<CliSlotRecipe> = Object.freeze<CliSlotRecipe>({
    difficulty: ['medium'],
    maxParallel: 1,
    provisional: true,
    rationale: 'Unrecognized provider — conservative default (medium, maxParallel 1). Review before relying on it.',
})

/** A detected, installed CLI provider on one node — the generator's input. */
export interface DetectedCliProvider {
    /** Provider type id, e.g. 'claude-cli'. */
    type: string
    /** Human-readable name, for display in the proposal. */
    displayName?: string
    /** Detected version, when known. Display only — never affects the mapping. */
    version?: string
}

/** One proposed slot plus why it was proposed. */
export interface ProposedSlotEntry {
    slot: NodeCapabilitySlot
    /** True when the provider had no table entry and took the conservative fallback. */
    unknownProvider: boolean
    /** True when the recipe behind this slot is flagged as an unvalidated estimate. */
    provisional: boolean
    rationale?: string
}

/** The full slot proposal for one node, including what a write would DESTROY. */
export interface SlotProposal {
    /** The draft slot list — a WHOLESALE replacement for the node's policy.slots. */
    proposedSlots: NodeCapabilitySlot[]
    /** Per-slot provenance, index-aligned with `proposedSlots`. */
    entries: ProposedSlotEntry[]
    /** Provider types detected but not present in the mapping table. */
    unknownProviders: string[]
    /** Provider types whose proposal rests on an unvalidated estimate. */
    provisionalProviders: string[]
    /**
     * Slots currently configured on the node that the proposal does NOT
     * reproduce — i.e. what applying this proposal would DELETE. Slot writes are
     * wholesale replacements, so an operator-hand-tuned slot absent from the
     * detection-derived draft is silently destroyed unless it is named here.
     */
    droppedSlots: NodeCapabilitySlot[]
    /** Provider types that appear in `droppedSlots` but in no proposed slot at all. */
    droppedProviders: string[]
    /** True when applying the proposal would remove at least one existing slot. */
    destructive: boolean
}

/** Stable key identifying a slot's identity for current-vs-proposed diffing. */
function slotKey(slot: NodeCapabilitySlot): string {
    return [
        slot.provider,
        slot.model ?? '',
        slot.thinkingLevel ?? '',
        [...(slot.difficulty ?? [])].sort().join('|'),
        [...(slot.capability ?? [])].sort().join('|'),
        slot.maxParallel ?? '',
    ].join(' ')
}

/** Dedupe detected providers by type, preserving first-seen order. */
function dedupeDetected(detected: readonly DetectedCliProvider[]): DetectedCliProvider[] {
    const seen = new Set<string>()
    const out: DetectedCliProvider[] = []
    for (const d of detected) {
        const type = typeof d?.type === 'string' ? d.type.trim() : ''
        if (!type || seen.has(type)) continue
        seen.add(type)
        out.push({ ...d, type })
    }
    return out
}

/**
 * Build a capability-slot proposal from a node's detected CLI providers.
 *
 * Pure and total: zero detections yields an empty proposal (never throws), which
 * the caller should treat as "nothing to propose" rather than "replace the
 * node's slots with nothing".
 *
 * `currentSlots` is optional but strongly recommended — it is the only way the
 * returned proposal can report what a wholesale write would destroy.
 */
export function buildSlotProposal(
    detected: readonly DetectedCliProvider[],
    currentSlots: readonly NodeCapabilitySlot[] = [],
): SlotProposal {
    const providers = dedupeDetected(detected ?? [])
    const proposedSlots: NodeCapabilitySlot[] = []
    const entries: ProposedSlotEntry[] = []
    const unknownProviders: string[] = []
    const provisionalProviders: string[] = []

    for (const provider of providers) {
        const known = CLI_SLOT_RECIPES[provider.type]
        const recipes: readonly CliSlotRecipe[] = known ?? [UNKNOWN_CLI_SLOT_RECIPE]
        const isUnknown = !known
        if (isUnknown) unknownProviders.push(provider.type)

        let providerProvisional = false
        for (const recipe of recipes) {
            // Normalize through the SAME normalizer the daemon applies on write, so
            // a proposal can never preview a shape the write would reshape.
            const slot = normalizeNodeCapabilitySlot({
                provider: provider.type,
                model: recipe.model,
                thinkingLevel: recipe.thinkingLevel,
                difficulty: recipe.difficulty,
                maxParallel: recipe.maxParallel,
            })
            if (!slot) continue
            const provisional = recipe.provisional === true
            if (provisional) providerProvisional = true
            proposedSlots.push(slot)
            entries.push({
                slot,
                unknownProvider: isUnknown,
                provisional,
                ...(recipe.rationale ? { rationale: recipe.rationale } : {}),
            })
        }
        if (providerProvisional) provisionalProviders.push(provider.type)
    }

    // What a wholesale write would destroy: every currently-configured slot with
    // no exact counterpart in the draft.
    const proposedKeys = new Set(proposedSlots.map(slotKey))
    const droppedSlots = currentSlots.filter(slot => !proposedKeys.has(slotKey(slot)))
    const proposedProviders = new Set(proposedSlots.map(s => s.provider))
    const droppedProviders = [...new Set(
        droppedSlots.map(s => s.provider).filter(p => !proposedProviders.has(p)),
    )]

    return {
        proposedSlots,
        entries,
        unknownProviders,
        provisionalProviders,
        droppedSlots,
        droppedProviders,
        destructive: droppedSlots.length > 0,
    }
}

/**
 * Build a MAGI panel proposal from the same detections.
 *
 * ─── Deliberately narrow ──────────────────────────────────────────────────────
 *
 * MAGI's value is provider INDEPENDENCE: replicas from different providers
 * (ideally different machines) answering the same question, so agreement means
 * something. Detection tells us which providers exist — that is exactly enough
 * to propose one panel of distinct providers, and no more.
 *
 * What detection does NOT tell us is which provider suits which review KIND
 * (rca vs design vs claim_audit). Nothing in any manifest grades a provider for
 * root-cause analysis over design review, and inventing a per-kind assignment
 * would fabricate a rationale that does not exist. So this proposes ONE panel of
 * the detected providers and leaves the kind binding to the operator; the caller
 * decides which `task_kind` to bind it to via the existing dry-run tool.
 *
 * Ordering follows {@link CLI_SLOT_RECIPES} insertion order (recipe-known
 * providers first, in table order), so the panel leads with the providers whose
 * suitability is actually attested.
 */
export function buildMagiPanelProposal(
    detected: readonly DetectedCliProvider[],
    opts: { nodeId?: string; maxSlots?: number } = {},
): MagiSlot[] {
    const providers = dedupeDetected(detected ?? [])
    const tableOrder = Object.keys(CLI_SLOT_RECIPES)
    const rank = (type: string): number => {
        const i = tableOrder.indexOf(type)
        return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    const ordered = [...providers].sort((a, b) => rank(a.type) - rank(b.type))
    const limit = Number.isFinite(opts.maxSlots) && (opts.maxSlots as number) > 0
        ? Math.floor(opts.maxSlots as number)
        : ordered.length

    return ordered.slice(0, limit).map((p): MagiSlot => ({
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        provider: p.type,
        // A model is intentionally NOT pinned: the panel's job is cross-provider
        // independence, and pinning models here would silently couple the panel
        // to this table's cost assumptions rather than to review quality.
    }))
}
