import { meshNodeIdMatches } from '@adhdev/mesh-shared';

/** Native bindings and physical attestations pin the spelling, not just mesh
 * membership. Use the canonical node reader without accepting trimmed aliases.
 * An absent optional node stays absent on both sides of a legacy receipt. */
export function pinnedMeshNodeIdMatches(actual: unknown, expected: string | null | undefined): boolean {
    if (actual !== expected) return false;
    if (actual === undefined || actual === null) return true;
    return typeof actual === 'string' && meshNodeIdMatches({ nodeId: actual }, expected);
}
