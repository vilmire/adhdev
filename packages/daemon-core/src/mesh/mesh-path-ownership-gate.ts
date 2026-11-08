import { getMesh } from '../config/mesh-config.js';
import { resolveMeshPolicy } from '../repo-mesh-types.js';

/**
 * Whether owned_paths / path-ownership conflicts gate claims. Default 'off': owned_paths are advisory
 * metadata (recorded, reported, never a hold). See RepoMeshPolicy.pathOwnershipGate. The per-node
 * one-writer rule and light-workspace isolation are NOT part of this gate and always apply.
 */
export type PathOwnershipGate = 'off' | 'same_checkout' | 'mesh_wide';

let override: PathOwnershipGate | undefined;
/** Test seam: force the gate for every mesh (undefined restores the policy lookup). */
export function setPathOwnershipGateForTests(mode: PathOwnershipGate | undefined): void { override = mode; }

export function resolvePathOwnershipGate(meshId: string): PathOwnershipGate {
    if (override) return override;
    try {
        const v = resolveMeshPolicy(getMesh(meshId)?.policy).pathOwnershipGate;
        return v === 'same_checkout' || v === 'mesh_wide' ? v : 'off';
    } catch { return 'off'; }
}
