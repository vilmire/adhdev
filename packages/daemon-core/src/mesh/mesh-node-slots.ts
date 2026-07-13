/**
 * Node capability-slot resolution — the single source of truth for a node's
 * effective slots (ORCHESTRATION_NODE_SLOTS.md). Every layer that needs a node's
 * slots (queue claim/launch caps, scheduling-runtime status projection, coordinator
 * prompt) resolves them here so the "explicit policy.slots, else legacy-derived"
 * rule is applied identically everywhere.
 *
 * Kept as a tiny standalone module (rather than living in mesh-queue-assignment)
 * so importing slot resolution does not drag in the whole assignment engine and to
 * avoid an import cycle between the status builder and the assignment engine.
 */
import {
    deriveSlotsFromLegacy,
    normalizeNodeCapabilitySlots,
    type NodeCapabilitySlot,
} from '@adhdev/mesh-shared';
import { getDifficultyBrains } from '../config/mesh-config.js';

/** Ordered, de-duplicated providerPriority from a node policy (defensive). */
export function normalizeProviderPriority(policy: unknown): string[] {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

/**
 * Resolve a node's capability slots: explicit `policy.slots` when present, else
 * derived from the legacy `providerPriority` + machine-global difficultyBrains.
 * (The former per-provider `providerRoles` cap has been removed; a persisted
 * meshes.json is migrated to slots on load, so by the time a node reaches routing
 * its cap already lives on `slots[].maxParallel`.)
 */
export function resolveNodeCapabilitySlots(node: any): NodeCapabilitySlot[] {
    const explicit = normalizeNodeCapabilitySlots(node?.policy?.slots);
    if (explicit.length) return explicit;
    let difficultyBrains: any;
    try { difficultyBrains = getDifficultyBrains(); } catch { difficultyBrains = undefined; }
    return deriveSlotsFromLegacy({
        providerPriority: normalizeProviderPriority(node?.policy),
        difficultyBrains,
    });
}
