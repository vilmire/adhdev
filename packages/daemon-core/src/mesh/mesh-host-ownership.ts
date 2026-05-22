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

export function resolveMeshHostStatus(mesh: unknown): RepoMeshHostStatus {
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
    const hostDaemonId = readString(raw?.hostDaemonId);
    const hostNodeId = readString(raw?.hostNodeId);
    const hostAddress = readString(raw?.hostAddress);
    if (hostDaemonId) normalized.hostDaemonId = hostDaemonId;
    if (hostNodeId) normalized.hostNodeId = hostNodeId;
    if (hostAddress) normalized.hostAddress = hostAddress;
    if (pairing) {
        const status = pairing.status === 'pairing' || pairing.status === 'paired' || pairing.status === 'revoked'
            ? pairing.status
            : 'not_configured';
        normalized.pairing = {
            status,
            ...(readString(pairing.tokenId) ? { tokenId: readString(pairing.tokenId) } : {}),
            ...(readString(pairing.joinedAt) ? { joinedAt: readString(pairing.joinedAt) } : {}),
            ...(readString(pairing.lastPairedAt) ? { lastPairedAt: readString(pairing.lastPairedAt) } : {}),
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
