/**
 * Shared low-level helpers and constants for the mesh_* tool family.
 *
 * Leaf module: depends only on daemon-core/mesh-shared (never on mesh-tools.ts or
 * any of the split-out cluster files), so the cluster files (mesh-compact.ts,
 * mesh-queue-helpers.ts, mesh-node-identity.ts) and mesh-tools.ts can all import
 * from here without a runtime import cycle. Physically split out of mesh-tools.ts
 * (RF-SURVEY candidate C1) with no behavior change — same function bodies, same
 * constant values.
 */

export function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readNumeric(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
