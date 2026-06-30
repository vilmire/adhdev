import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { RepoMeshDaemonRole, RepoMeshHostMetadata, RepoMeshHostStatus } from '../repo-mesh-types.js';

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeMeshDaemonRole(value: unknown): RepoMeshDaemonRole | undefined {
    return value === 'host' || value === 'member' ? value : undefined;
}

/**
 * Options for resolveMeshHostStatus's read-side host-pin default.
 *
 * `localDaemonId` is the id of the daemon evaluating the mesh (typically
 * `deps.statusInstanceId`). When the persisted `meshHost` declares `role:'host'`
 * but carries NO `hostDaemonId` (the first-setup miss — a host mesh whose pin was
 * never written to config), the host daemon IS this local daemon by definition, so
 * we synthesize `hostDaemonId = localDaemonId` (and, when the mesh has a node
 * representing this daemon, `hostNodeId`). This is the read-side default — the SSOT
 * is computed from the role + the evaluating daemon's identity rather than requiring
 * a config migration to backfill every already-created mesh.
 *
 * HARD guard: the synthesis fires ONLY for `role:'host'`. A `role:'member'` daemon
 * must NEVER fill itself in as host — that would make a member falsely claim
 * coordinator/queue ownership.
 */
export interface ResolveMeshHostOptions {
    /** Id of the daemon evaluating this mesh (e.g. deps.statusInstanceId). */
    localDaemonId?: string;
}

export function resolveMeshHostStatus(mesh: unknown, opts?: ResolveMeshHostOptions): RepoMeshHostStatus {
    const meshRecord = readObject(mesh);
    const raw = readObject(meshRecord?.meshHost);
    const role = normalizeMeshDaemonRole(raw?.role) ?? 'host';
    const pairing = readObject(raw?.pairing);
    const normalized: RepoMeshHostStatus = {
        role,
        canOwnCoordinator: role === 'host',
        canOwnQueue: role === 'host',
        defaulted: !raw,
    };
    let hostDaemonId = readString(raw?.hostDaemonId);
    let hostNodeId = readString(raw?.hostNodeId);
    const hostAddress = readString(raw?.hostAddress);
    // HOST-MISSEED-FIRSTSETUP read-side default: a host mesh with no persisted
    // hostDaemonId is hosted by THIS daemon (role:'host' is local-relative), so
    // fill the pin from the evaluating daemon. Member daemons are never synthesized.
    const localDaemonId = readString(opts?.localDaemonId);
    if (role === 'host' && !hostDaemonId && localDaemonId) {
        hostDaemonId = localDaemonId;
        // Anchor hostNodeId to the node representing this local daemon, when present.
        if (!hostNodeId && Array.isArray(meshRecord?.nodes)) {
            const selfNode = (meshRecord!.nodes as unknown[]).find(n => {
                const nodeDaemonId = readString(readObject(n)?.daemonId);
                return nodeDaemonId ? daemonIdsEquivalent(nodeDaemonId, localDaemonId) : false;
            });
            const selfNodeId = readString(readObject(selfNode)?.id);
            if (selfNodeId) hostNodeId = selfNodeId;
        }
    }
    if (hostDaemonId) normalized.hostDaemonId = hostDaemonId;
    if (hostNodeId) normalized.hostNodeId = hostNodeId;
    if (hostAddress) normalized.hostAddress = hostAddress;
    if (pairing) {
        const status = pairing.status === 'pairing' || pairing.status === 'paired' || pairing.status === 'rejected' || pairing.status === 'revoked'
            ? pairing.status
            : 'not_configured';
        normalized.pairing = {
            status,
            ...(readString(pairing.tokenId) ? { tokenId: readString(pairing.tokenId) } : {}),
            ...(readString(pairing.joinedAt) ? { joinedAt: readString(pairing.joinedAt) } : {}),
            ...(readString(pairing.lastPairedAt) ? { lastPairedAt: readString(pairing.lastPairedAt) } : {}),
            ...(readString(pairing.lastRejectedAt) ? { lastRejectedAt: readString(pairing.lastRejectedAt) } : {}),
            ...(readString(pairing.expiresAt) ? { expiresAt: readString(pairing.expiresAt) } : {}),
        };
    }
    return normalized;
}

export function isMeshHostOwner(mesh: unknown): boolean {
    return resolveMeshHostStatus(mesh).role === 'host';
}

export function buildMeshHostRequiredFailure(mesh: unknown, operation: string): Record<string, unknown> {
    const meshHost = resolveMeshHostStatus(mesh);
    return {
        success: false,
        code: 'mesh_host_required',
        error: `Mesh Host daemon required for ${operation}; member daemons must pair with the host and cannot own coordinator/queue mutations.`,
        meshHost,
    };
}

export function requireMeshHostQueueOwner(opts?: { ownerRole?: RepoMeshDaemonRole }): void {
    if (opts?.ownerRole === 'member') {
        throw new Error('Mesh Host daemon required to mutate mesh queue; member daemons must use the host-owned queue.');
    }
}

export function createDefaultMeshHostMetadata(): RepoMeshHostMetadata {
    return {
        role: 'host',
        pairing: { status: 'not_configured' },
    };
}
