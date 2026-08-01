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
 * Resolve a node's capability slots — coordinator-owned config is the single source
 * of truth for ALL nodes (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix).
 *
 * The coordinator's local meshes.json owns `policy.slots` for every node in the mesh
 * (self AND remote members alike — a remote member's mesh config lives on the
 * coordinator, its own on-disk meshes.json is empty). So slots resolve directly from
 * the coordinator's locally-owned `node.policy.slots`, with no remote reporter
 * round-trip: there is no per-node "reported slots" mirror to consult.
 *
 * Precedence:
 *   1. `policy.slots` — coordinator-owned, authoritative for self and remote alike.
 *   2. Legacy-derived from `providerPriority` + the OWNING MESH's difficultyBrains.
 *
 * (The former per-provider `providerRoles` cap has been removed; a persisted
 * meshes.json is migrated to slots on load, so by the time a node reaches routing
 * its cap already lives on `slots[].maxParallel`.)
 */
export function resolveNodeCapabilitySlots(node: any, meshId?: string): NodeCapabilitySlot[] {
    const explicit = normalizeNodeCapabilitySlots(node?.policy?.slots);
    if (explicit.length) return explicit;
    // Legacy derivation folds the difficulty presets into the derived slots' models,
    // so those presets must come from the mesh that OWNS this node — otherwise the
    // derived slot declares a model a different mesh chose, and the slot-model guard
    // then enforces a model this mesh never selected. `meshId` is optional: omitted,
    // it resolves to the sole mesh, which is what every pre-scope caller assumed.
    let difficultyBrains: any;
    try { difficultyBrains = getDifficultyBrains(meshId); } catch { difficultyBrains = undefined; }
    return deriveSlotsFromLegacy({
        providerPriority: normalizeProviderPriority(node?.policy),
        difficultyBrains,
    });
}
