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
 * never written to config), the host daemon MAY be this local daemon, so we
 * synthesize `hostDaemonId = localDaemonId` (and, when the mesh has a node
 * representing this daemon, `hostNodeId`). This is the read-side default — it avoids
 * a config migration to backfill every already-created mesh.
 *
 * HARD guard 1: the synthesis fires ONLY for `role:'host'`. A `role:'member'` daemon
 * must NEVER fill itself in as host — that would make a member falsely claim
 * coordinator/queue ownership.
 *
 * HARD guard 2 (HOST-SELF-SYNTHESIS-GUARD): the synthesis fires only when NO OTHER
 * daemon could plausibly be the host. `meshHost.role` defaults to 'host' for every
 * peer, so on a multi-peer mesh whose pin was never persisted, EVERY daemon would
 * otherwise answer "I am the host" — and the dashboard shows whichever daemon
 * happened to answer mesh_status (P2P arrival order). That is not merely a wrong
 * badge: the same id is the coordinator-Launch target, and the launch is what
 * permanently pins the host, so an arbitrary peer gets pinned for good. When the mesh
 * has a node bound to a daemon other than the evaluating one, the host is genuinely
 * UNKNOWN and we say so (leave hostDaemonId undefined) instead of guessing ourselves.
 * Consumers then render the neutral first-setup state, which requires an explicit
 * operator choice.
 *
 * A node already flagged `role:'host'` IS authoritative (add_mesh_node persists it
 * daemon-side), so it resolves the host even on a multi-peer mesh — and, being a real
 * declaration rather than a guess, it is not marked `hostSynthesized`.
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
    let hostSynthesized = false;
    const nodes = Array.isArray(meshRecord?.nodes) ? meshRecord!.nodes as unknown[] : [];
    const nodeDaemonIdOf = (node: unknown): string | undefined => {
        const record = readObject(node);
        return readString(record?.daemonId) ?? readString(record?.daemon_id);
    };
    // An explicit daemon-side host declaration on a node (persisted by add_mesh_node)
    // is authoritative — it outranks the local-self default and is valid even on a
    // multi-peer mesh. This is a real declaration, not a guess, so it is not flagged
    // as synthesized.
    if (role === 'host' && !hostDaemonId) {
        const declaredHostNode = nodes.find(n => normalizeMeshDaemonRole(readObject(n)?.role) === 'host');
        if (declaredHostNode) {
            const declaredDaemonId = nodeDaemonIdOf(declaredHostNode);
            if (declaredDaemonId) {
                hostDaemonId = declaredDaemonId;
                if (!hostNodeId) hostNodeId = readString(readObject(declaredHostNode)?.id);
            }
        }
    }
    // HOST-MISSEED-FIRSTSETUP read-side default: a host mesh with no persisted
    // hostDaemonId MAY be hosted by THIS daemon, so fill the pin from the evaluating
    // daemon. Member daemons are never synthesized.
    //
    // HOST-SELF-SYNTHESIS-GUARD: only when no OTHER daemon is attached to this mesh.
    // With a foreign peer present and no persisted pin, every peer would claim the
    // host (role defaults to 'host' everywhere) and the answer would depend on which
    // daemon was asked — so we leave the pin unresolved instead. `hostNodeId` alone is
    // also treated as a persisted pin: it names the host node, so we must not
    // overwrite it with ourselves.
    const localDaemonId = readString(opts?.localDaemonId);
    const hasForeignDaemonNode = localDaemonId
        ? nodes.some(n => {
            const nodeDaemonId = nodeDaemonIdOf(n);
            return nodeDaemonId ? !daemonIdsEquivalent(nodeDaemonId, localDaemonId) : false;
        })
        : false;
    if (role === 'host' && !hostDaemonId && !hostNodeId && localDaemonId && !hasForeignDaemonNode) {
        hostDaemonId = localDaemonId;
        hostSynthesized = true;
        // Anchor hostNodeId to the node representing this local daemon, when present.
        const selfNode = nodes.find(n => {
            const nodeDaemonId = nodeDaemonIdOf(n);
            return nodeDaemonId ? daemonIdsEquivalent(nodeDaemonId, localDaemonId) : false;
        });
        const selfNodeId = readString(readObject(selfNode)?.id);
        if (selfNodeId) hostNodeId = selfNodeId;
    }
    if (hostDaemonId) normalized.hostDaemonId = hostDaemonId;
    if (hostNodeId) normalized.hostNodeId = hostNodeId;
    // Tell consumers this pin was inferred from the evaluating daemon rather than read
    // from config, so the dashboard can render the neutral "host not established yet"
    // state instead of a confident (possibly wrong) host badge.
    if (hostSynthesized) normalized.hostSynthesized = true;
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
