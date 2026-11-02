/**
 * A standalone member keeps its own mesh id and stores the host's id on
 * `meshHost.hostMeshId` (mesh-host-pairing). Handoff protocol messages use the
 * host id. Resolve that back to the one local record, or refuse.
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';

export interface HandoffMeshIdentity {
    id: string;
    meshHost?: { role?: string; hostDaemonId?: string; hostMeshId?: string } | null;
    nodes?: Array<{ id?: string; daemonId?: string; workspace?: string }>;
}

const IDENTITY_CHANGED = 'target node identity changed during config apply';
const ID_COLLISION = 'handoff mesh id collision';

/** Exact id wins. Otherwise exactly one paired member of this host id. */
export function findHandoffMesh<T extends HandoffMeshIdentity>(meshes: readonly T[], protocolMeshId: string, selfDaemonId: string): T | undefined {
    const exact = meshes.find(m => m.id === protocolMeshId);
    if (exact) return exact;
    const id = protocolMeshId.trim();
    if (!id || !selfDaemonId.trim()) return undefined;
    const hits = meshes.filter(m => {
        const host = m.meshHost;
        if (!host || host.role !== 'member') return false;
        if (typeof host.hostMeshId !== 'string' || host.hostMeshId.trim() !== id) return false;
        if (typeof host.hostDaemonId !== 'string' || !host.hostDaemonId.trim()) return false;
        if (daemonIdsEquivalent(host.hostDaemonId, selfDaemonId)) return false;
        return true;
    });
    return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Readiness view only. A paired member's own node is often stored without a
 * daemon id. Stamp that one blank node as this daemon. Never write it back,
 * and never choose among several blank nodes.
 */
export function presentHandoffMesh<T extends HandoffMeshIdentity>(mesh: T, protocolMeshId: string, selfDaemonId: string): T {
    if (mesh.id === protocolMeshId || !selfDaemonId.trim()) return mesh;
    const nodes = mesh.nodes ?? [];
    if (nodes.some(n => !!n.daemonId && daemonIdsEquivalent(n.daemonId, selfDaemonId))) return mesh;
    const blanks = nodes.filter(n => !n.daemonId);
    if (blanks.length !== 1) return mesh;
    return {
        ...mesh,
        nodes: nodes.map(n => n === blanks[0] ? { ...n, daemonId: selfDaemonId } : n),
    };
}

/** Keep the local workspace. A blank local id may adopt only this daemon's id, and only on the aliased member mesh. */
export function mergeIncomingHandoffNode(
    local: { daemonId?: string; workspace?: string },
    incoming: Record<string, unknown>,
    opts: { aliased: boolean; selfDaemonId: string },
): { ok: true; node: Record<string, unknown> } | { ok: false; error: string } {
    const localId = typeof local.daemonId === 'string' ? local.daemonId : '';
    const incomingId = typeof incoming.daemonId === 'string' ? incoming.daemonId : '';
    if (localId && incomingId) {
        if (!daemonIdsEquivalent(localId, incomingId)) return { ok: false, error: IDENTITY_CHANGED };
        return { ok: true, node: { ...incoming, workspace: local.workspace } };
    }
    if (localId || !incomingId) return { ok: false, error: IDENTITY_CHANGED };
    if (!opts.aliased || !opts.selfDaemonId || !daemonIdsEquivalent(incomingId, opts.selfDaemonId)) return { ok: false, error: IDENTITY_CHANGED };
    return { ok: true, node: { ...incoming, daemonId: incomingId, workspace: local.workspace } };
}

/** Point the paired member record at the protocol mesh id. An existing different record with that id is a collision. */
export function retargetHandoffMeshId<T extends { id: string }>(meshes: readonly T[], mesh: T, protocolMeshId: string): { ok: true } | { ok: false; error: string } {
    if (mesh.id === protocolMeshId) return { ok: true };
    if (meshes.some(m => m !== mesh && m.id === protocolMeshId)) return { ok: false, error: ID_COLLISION };
    mesh.id = protocolMeshId;
    return { ok: true };
}
