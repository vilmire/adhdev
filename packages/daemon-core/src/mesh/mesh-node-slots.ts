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
    meshWorkspacesEquivalent,
    type NodeCapabilitySlot,
} from '@adhdev/mesh-shared';
import { getDifficultyBrains, listMeshes } from '../config/mesh-config.js';

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
 * Resolve a node's capability slots with EXPLICIT self-vs-remote precedence
 * (REMOTE-NODE-SLOT-CAP-CHIP fix, Direction B).
 *
 * Precedence, avoiding the precedence-inversion a blind `policy.slots || mirror`
 * would introduce:
 *   1. Local `policy.slots` — authoritative for the SELF/locally-owned node (the
 *      node owns its own config locally). This ALSO wins for a remote node in the
 *      unusual case an operator configured slots on the coordinator side.
 *   2. `reportedMemberState.slots` — the remote member's OWN resolved slots,
 *      mirrored wholesale over P2P. Authoritative for a REMOTE mirrored node whose
 *      coordinator-side policy copy is the stale join-time empty `{}` (which
 *      normalizes to []). This is the field the coordinator's join-time copy lacks
 *      — the reason remote slot-cap chips were missing.
 *   3. Legacy-derived from `providerPriority` + machine-global difficultyBrains.
 *
 * The mirror only ever fills the gap left by an empty local policy — it can never
 * shadow a populated local policy — so there is no inversion. And a self node never
 * carries a reportedMemberState (the ingest path stamps it ONLY for remote
 * members), so a self node's local policy is always used directly.
 * (The former per-provider `providerRoles` cap has been removed; a persisted
 * meshes.json is migrated to slots on load, so by the time a node reaches routing
 * its cap already lives on `slots[].maxParallel`.)
 */
export function resolveNodeCapabilitySlots(node: any): NodeCapabilitySlot[] {
    const explicit = normalizeNodeCapabilitySlots(node?.policy?.slots);
    if (explicit.length) return explicit;
    // Remote mirror: the member's own resolved slots, carried on the git_status
    // envelope and ingested onto the node record. Preferred over the legacy derive
    // (it is the member's real resolved profile), but only when the local policy is
    // empty — so it fills the coordinator's join-time gap without overriding an
    // explicit local override.
    const mirrored = normalizeNodeCapabilitySlots(node?.reportedMemberState?.slots);
    if (mirrored.length) return mirrored;
    let difficultyBrains: any;
    try { difficultyBrains = getDifficultyBrains(); } catch { difficultyBrains = undefined; }
    return deriveSlotsFromLegacy({
        providerPriority: normalizeProviderPriority(node?.policy),
        difficultyBrains,
    });
}

/**
 * Reporter-side helper (Direction B): resolve THIS daemon's own capability slots for
 * a given workspace by finding the local meshes.json node whose workspace matches
 * and running the same {@link resolveNodeCapabilitySlots} over its real local policy.
 * Used at the git_status reporter wiring so a member node self-reports its own
 * resolved slots inside the unified reporterMemberState envelope. Returns [] when no
 * local node matches the workspace or slots can't be resolved (best-effort, never
 * throws) so the reporter simply omits the field.
 */
export function resolveLocalNodeSlotsForWorkspace(workspace: string | undefined): NodeCapabilitySlot[] {
    const ws = typeof workspace === 'string' ? workspace.trim() : '';
    if (!ws) return [];
    let meshes: any[];
    try { meshes = listMeshes(); } catch { return []; }
    for (const mesh of Array.isArray(meshes) ? meshes : []) {
        for (const node of Array.isArray(mesh?.nodes) ? mesh.nodes : []) {
            const nodeWs = typeof node?.workspace === 'string' ? node.workspace : '';
            if (nodeWs && meshWorkspacesEquivalent(nodeWs, ws)) {
                // Resolve from the LOCAL node's real policy only — never re-read its
                // own reportedMemberState (a member does not mirror itself).
                const slots = resolveNodeCapabilitySlots({ policy: node?.policy });
                if (slots.length) return slots;
            }
        }
    }
    return [];
}
