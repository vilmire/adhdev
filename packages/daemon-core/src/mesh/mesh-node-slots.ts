/**
 * Node capability-slot resolution — the single source of truth for a node's
 * effective slots (node capability slots design, 2026-07-09). Every layer that needs a node's
 * slots (queue claim/launch caps, scheduling-runtime status projection, coordinator
 * prompt) resolves them here so the "explicit policy.slots, else legacy-derived"
 * rule is applied identically everywhere.
 *
 * Kept as a tiny standalone module (rather than living in mesh-queue-assignment)
 * so importing slot resolution does not drag in the whole assignment engine and to
 * avoid an import cycle between the status builder and the assignment engine.
 */
import {
    defaultProviderPriorityFromNodeFacts,
    deriveSlotsFromLegacy,
    normalizeNodeCapabilitySlots,
    orderProvidersByBuiltinPreference,
    type NodeCapabilitySlot,
} from '@adhdev/mesh-shared';
import { getDifficultyBrains } from '../config/mesh-config-routing.js';

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
 * The provider order a node with NO providerPriority and NO slots defaults to,
 * from what the node itself reports (mesh-shared `defaultProviderPriorityFromNodeFacts`
 * — enabled providers, narrowed to detected ones, in the built-in order).
 *
 * There is no mesh-level default priority field in RepoMeshPolicy (checked
 * 2026-10-09; `allowedProviders` is an unenforced allow-list, not an order), so
 * the built-in order is the only ordering source. The dashboards' add-node
 * default (web-core `defaultProviderPriorityFromInventory`) applies the same
 * "what this machine has enabled + detected" rule, stamped at add time; this
 * covers nodes added by any other path (MCP, pairing, member join).
 */
export function defaultProviderPriorityForNode(node: any): string[] {
    return defaultProviderPriorityFromNodeFacts(node?.nodeFacts);
}

/**
 * "Which CLI providers are enabled on THIS machine, if `node` is hosted here?"
 * Installed at boot (`installLocalNodeProviderFallback`, mesh-slot-provider-usability.ts)
 * — the local-node test lives in mesh-candidacy-predicates, which imports this
 * module, so it is injected rather than imported. Returns [] for a remote node.
 */
let localNodeProviderFallback: ((node: any) => readonly string[]) | null = null;

export function setLocalNodeProviderFallback(fn: ((node: any) => readonly string[]) | null): void {
    localNodeProviderFallback = fn;
}

function localNodeDefaultProviders(node: any): string[] {
    if (!localNodeProviderFallback) return [];
    try { return orderProvidersByBuiltinPreference(localNodeProviderFallback(node) ?? []); } catch { return []; }
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
 *   3. With no providerPriority: the same derivation over a default order — this
 *      machine's enabled CLI providers for a node it hosts (the installed
 *      `setLocalNodeProviderFallback` port), else the providers the node reports
 *      enabled (`defaultProviderPriorityForNode`).
 *
 * (The former per-provider `providerRoles` cap has been removed; a persisted
 * meshes.json is migrated to slots on load, so by the time a node reaches routing
 * its cap already lives on `slots[].maxParallel`.)
 */
export function resolveNodeCapabilitySlots(node: any, meshId?: string): NodeCapabilitySlot[] {
    const explicit = normalizeNodeCapabilitySlots(node?.policy?.slots);
    if (explicit.length) return explicit;
    // 2. explicit providerPriority; 3. with none, a DEFAULT order — this machine's
    // live enabled CLI providers for a node it hosts (its record carries no facts
    // bundle), else the node's own reported enabled providers. The default feeds
    // the same legacy derivation, so difficulty presets fold in exactly as for an
    // explicit order, and every consumer (claim, launch, caps, route preview,
    // coordinator prompt) sees the same slots.
    let providerPriority = normalizeProviderPriority(node?.policy);
    if (!providerPriority.length) providerPriority = localNodeDefaultProviders(node);
    if (!providerPriority.length) providerPriority = defaultProviderPriorityForNode(node);
    if (!providerPriority.length) return [];
    // Legacy derivation folds the difficulty presets into the derived slots' models,
    // so those presets must come from the mesh that OWNS this node — otherwise the
    // derived slot declares a model a different mesh chose, and the slot-model guard
    // then enforces a model this mesh never selected. `meshId` is optional: omitted,
    // it resolves to the sole mesh, which is what every pre-scope caller assumed.
    let difficultyBrains: any;
    try { difficultyBrains = getDifficultyBrains(meshId); } catch { difficultyBrains = undefined; }
    return deriveSlotsFromLegacy({ providerPriority, difficultyBrains });
}
