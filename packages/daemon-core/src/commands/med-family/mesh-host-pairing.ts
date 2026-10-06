/**
 * RF-ROUTER MED family — Mesh Host manual-pairing commands.
 *
 * get_mesh_host_pairing, configure_mesh_host_pairing,
 * create_mesh_host_pairing_token, apply_mesh_host_join,
 * join_mesh_host_pairing and revoke_mesh_peer. These read/mutate the mesh host
 * pairing metadata and, for join, apply the request to the host over
 * mesh-command dispatch or the standalone join endpoint
 * (`POST /api/v1/mesh/join`). Pairing helpers are imported from router.js.
 *
 * ── Peer secrets (standalone multi-machine mesh, design 2026-10-07 §4.4) ────
 * An accepted join mints a 32-byte per-member peer secret on the host
 * (mesh-peer-secrets.json, role 'host') and hands it to the member ONCE in the
 * apply_mesh_host_join answer; the member stores it (role 'member', with the
 * host address to dial). The WS mesh transport authenticates every
 * `/ws/mesh` / `/ws/mesh-seqscribe` socket with it (mesh-peer-handshake.ts).
 * The secret value never reaches a log line, meshes.json, the join command's
 * own result (the member stores it and echoes the host answer masked), or any
 * manualPairing description.
 */
import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { buildMemberJoinNode } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { defineCommandSpecs, type CommandSource } from '../command-registry.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { mintPeerSecret, putPeerSecret, removePeerSecret } from '../../mesh/transport/mesh-peer-secrets.js';
import { MESH_HANDSHAKE_PROTOCOL_VERSION } from '../../mesh/transport/mesh-peer-handshake.js';
import { LOG } from '../../logging/logger.js';
import { maskDaemonId } from '../../mesh/transport/mask-daemon-id.js';
import {
    MESH_JOIN_HTTP_PATH,
    MESH_RPC_WS_PATH,
    MESH_SEQSCRIBE_WS_PATH,
    meshHostHttpUrl,
    computeMeshHostAddressCandidates,
    type MeshHostAddressCandidates,
    type MeshNetworkInterfaces,
} from '../../shared/mesh-host-endpoints.js';
import { networkInterfaces } from 'node:os';

// Paths and host-address parsing live in shared/mesh-host-endpoints.ts — the one
// source shared with the WS transport, the seqscribe lane and the standalone server.
export { MESH_JOIN_HTTP_PATH, MESH_RPC_WS_PATH, MESH_SEQSCRIBE_WS_PATH };

/** What the host tells an admitted member about how to reach its mesh transport. */
export interface MeshJoinTransportDescriptor {
    wsPath: string;
    seqscribePath: string;
    protocolVersion: number;
}

export const MESH_JOIN_TRANSPORT: Readonly<MeshJoinTransportDescriptor> = Object.freeze({
    wsPath: MESH_RPC_WS_PATH,
    seqscribePath: MESH_SEQSCRIBE_WS_PATH,
    protocolVersion: MESH_HANDSHAKE_PROTOCOL_VERSION,
});

/** Placeholder written over a peer secret wherever a host answer is echoed back. */
export const REDACTED_PEER_SECRET = '[redacted]';

/**
 * The host's join endpoint for a member-configured host address — always
 * `<origin>/api/v1/mesh/join`. Accepts bare `ip:port` / `hostname:port` /
 * `[v6]:port` as well as http(s):// and ws(s):// URLs (any path is replaced).
 */
export function normalizeStandaloneHostJoinUrl(hostAddress: string): string {
    return meshHostHttpUrl(hostAddress, MESH_JOIN_HTTP_PATH);
}

/** A copy of a host join answer that is safe to return / log: the peer secret is masked. */
export function redactHostJoinResult(hostResult: unknown): unknown {
    if (!hostResult || typeof hostResult !== 'object' || Array.isArray(hostResult)) return hostResult;
    const record = hostResult as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, 'peerSecret')) return hostResult;
    return { ...record, peerSecret: REDACTED_PEER_SECRET };
}

function readTrimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Host side of a join: mint and store the admitted member's peer secret.
 * Re-joining replaces (and so revokes) the member's previous secret. Returns
 * null — and the join stays accepted without a secret — when either side's
 * daemon id is unknown (the WS transport cannot authenticate an anonymous
 * peer) or the member claims this daemon's own id.
 */
function issueHostPeerSecret(
    meshId: string,
    memberDaemonIdRaw: unknown,
    hostDaemonIdRaw: unknown,
): { secret: string; memberDaemonId: string; hostDaemonId: string } | { skipped: string } {
    const memberDaemonId = canonicalDaemonId(readTrimmed(memberDaemonIdRaw));
    const hostDaemonId = canonicalDaemonId(readTrimmed(hostDaemonIdRaw));
    if (!memberDaemonId) return { skipped: 'member_daemon_id_missing' };
    if (!hostDaemonId) return { skipped: 'host_daemon_id_unknown' };
    if (daemonIdsEquivalent(memberDaemonId, hostDaemonId)) return { skipped: 'member_is_host' };
    const secret = mintPeerSecret();
    putPeerSecret({ meshId, peerDaemonId: memberDaemonId, role: 'host', secret, createdAt: new Date().toISOString() });
    LOG.info('MeshPairing', `issued peer secret mesh=${meshId} member=${maskDaemonId(memberDaemonId)}`);
    return { secret, memberDaemonId, hostDaemonId };
}

/**
 * The `ip:port` addresses a member could type to reach this host (design §4.6),
 * when the runtime knows where its server listens (standalone). Absent fields
 * when it does not (cloud, embedders) — the card then shows no candidates.
 */
function resolveHostAddressCandidates(ctx: MedFamilyContext): Partial<MeshHostAddressCandidates> {
    let listen: ReturnType<NonNullable<MedFamilyContext['deps']['getMeshListenAddress']>> | undefined;
    try {
        listen = ctx.deps.getMeshListenAddress?.();
    } catch {
        listen = null;
    }
    if (!listen) return {};
    let interfaces: MeshNetworkInterfaces = {};
    try {
        interfaces = networkInterfaces() as MeshNetworkInterfaces;
    } catch { /* no interface list (sandbox) — no wildcard candidates */ }
    return computeMeshHostAddressCandidates(listen, interfaces);
}

export const meshHostPairingHandlers: Record<string, MedFamilyHandler> = {
    get_mesh_host_pairing: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        if (!mesh) return { success: false, error: 'Mesh not found' };
        const meshHost = resolveMeshHostStatus(mesh);
        const pairingStatus = meshHost.pairing?.status || 'not_configured';
        return {
            success: true,
            code: pairingStatus === 'not_configured' ? 'mesh_host_pairing_not_configured' : 'mesh_host_pairing_pending',
            meshId,
            hostAddress: meshHost.hostAddress,
            meshHost,
            ...resolveHostAddressCandidates(ctx),
            manualPairing: {
                status: pairingStatus,
                joinImplemented: true,
                protocol: 'standalone_command_direct_v1',
                description: 'Standalone manual pairing can save address/token metadata, apply a host join over direct standalone command HTTP or injected mesh command dispatch, and check persisted status. P2P signaling remains outside this slice.',
            },
        };
    },

    configure_mesh_host_pairing: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const hostAddress = typeof args?.hostAddress === 'string' ? args.hostAddress.trim() : '';
        const token = typeof args?.token === 'string' ? args.token.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!hostAddress || !token) return { success: false, error: 'hostAddress and token required' };
        try {
            const { configureMeshHostPairing } = await import('../../config/mesh-config-host-pairing.js');
            const configured = configureMeshHostPairing(meshId, { hostAddress, token });
            if (!configured) return { success: false, error: 'Mesh not found' };
            ctx.inlineMeshCache.set(meshId, configured.mesh);
            const meshHost = resolveMeshHostStatus(configured.mesh);
            return {
                success: true,
                code: 'mesh_host_pairing_pending',
                meshId,
                hostAddress: configured.hostAddress,
                meshHost,
                manualPairing: {
                    status: meshHost.pairing?.status || 'pairing',
                    joinImplemented: true,
                    protocol: 'standalone_command_direct_v1',
                    description: 'Manual Mesh Host pairing config was saved locally. Use join_mesh_host_pairing to apply it to the host. Raw token was not persisted.',
                },
            };
        } catch (e: any) {
            return { success: false, code: 'mesh_host_pairing_invalid', meshId, hostAddress, error: e.message };
        }
    },

    create_mesh_host_pairing_token: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { createMeshHostPairingToken } = await import('../../config/mesh-config-host-pairing.js');
            const created = createMeshHostPairingToken(meshId, {
                token: typeof args?.token === 'string' ? args.token : undefined,
                expiresAt: typeof args?.expiresAt === 'string' ? args.expiresAt : undefined,
            });
            if (!created) return { success: false, error: 'Mesh not found' };
            ctx.inlineMeshCache.set(meshId, created.mesh);
            ctx.invalidateAggregateMeshStatus(meshId);
            return {
                success: true,
                code: 'mesh_host_pairing_token_created',
                meshId,
                token: created.token,
                tokenId: created.tokenId,
                expiresAt: created.expiresAt,
                meshHost: resolveMeshHostStatus(created.mesh),
                warning: 'Raw token is returned once and is not persisted; share it with member daemons over a trusted channel.',
            };
        } catch (e: any) {
            return { success: false, code: 'mesh_host_pairing_token_invalid', meshId, error: e.message };
        }
    },

    apply_mesh_host_join: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const token = typeof args?.token === 'string' ? args.token.trim() : '';
        const memberNode = args?.memberNode && typeof args.memberNode === 'object' && !Array.isArray(args.memberNode)
            ? args.memberNode
            : null;
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!token || !memberNode) return { success: false, error: 'token and memberNode required' };
        try {
            const { applyMeshHostJoinRequest } = await import('../../config/mesh-config-host-pairing.js');
            const applied = applyMeshHostJoinRequest(meshId, {
                token,
                memberNode: memberNode as any,
                memberMeshId: typeof args?.memberMeshId === 'string' ? args.memberMeshId : undefined,
            });
            if (!applied) return { success: false, error: 'Mesh not found' };
            // The host may have resolved its mesh from the token (the member
            // named its own mesh id); everything below is keyed by the real one.
            const requestedMeshId = meshId;
            const hostMeshId = applied.mesh?.id || requestedMeshId;
            if (!applied.accepted) {
                return {
                    success: false,
                    code: 'mesh_host_join_rejected',
                    meshId: hostMeshId,
                    tokenId: applied.tokenId,
                    meshHost: applied.meshHost ? resolveMeshHostStatus({ meshHost: applied.meshHost }) : undefined,
                    error: applied.reason,
                };
            }
            // Union-warm instead of a raw set. applied.mesh is rebuilt from the
            // config file, so a raw replace drops inline-cache-only nodes (e.g. a
            // worktree clone whose durable addNode was skipped) — the exact
            // NODE-MEMBERSHIP-SHRINK-ON-MERGE regression, re-introduced through
            // a side door, on the one handler that just MUTATED membership.
            // getCachedInlineMesh with a payload routes through
            // warmInlineMeshCache → reconcileInlineMeshCache (union merge,
            // tombstones still honored); with no warm cache it sets the same
            // value the raw set would have.
            ctx.getCachedInlineMesh(hostMeshId, applied.mesh);
            ctx.invalidateAggregateMeshStatus(hostMeshId);
            try {
                const { meshRecord } = await import('../../mesh/mesh-record.js');
                meshRecord(hostMeshId, 'node_joined', {
                    nodeId: applied.node.id,
                    payload: { role: 'member', tokenId: applied.tokenId, workspace: applied.node.workspace },
                }, { local: true });
            } catch { /* ledger append is best-effort */ }
            const meshHost = resolveMeshHostStatus(applied.mesh);
            // This daemon's own id is the host id the member will dial and prove
            // against; the persisted host pin is only a fallback for embedders
            // that run the router without a status identity.
            let issued: ReturnType<typeof issueHostPeerSecret>;
            try {
                issued = issueHostPeerSecret(hostMeshId, applied.node.daemonId, ctx.deps.statusInstanceId || meshHost.hostDaemonId);
            } catch (e: any) {
                // The member is on the roster but holds no credential: it must
                // pair again with a fresh token. The error names no secret.
                return {
                    success: false,
                    code: 'mesh_host_peer_secret_failed',
                    meshId: hostMeshId,
                    node: applied.node,
                    tokenId: applied.tokenId,
                    meshHost,
                    error: `Failed to store the member's peer secret: ${e?.message || String(e)}`,
                };
            }
            if ('skipped' in issued) {
                LOG.warn('MeshPairing', `join accepted without a peer secret mesh=${hostMeshId} reason=${issued.skipped}`);
            }
            return {
                success: true,
                code: 'mesh_host_join_accepted',
                meshId: hostMeshId,
                node: applied.node,
                tokenId: applied.tokenId,
                meshHost,
                ...('skipped' in issued
                    ? { peerSecretSkipped: issued.skipped }
                    : {
                        // Returned exactly once — the host keeps its own copy in
                        // mesh-peer-secrets.json and never re-sends it.
                        peerSecret: issued.secret,
                        hostDaemonId: issued.hostDaemonId,
                        memberDaemonId: issued.memberDaemonId,
                        meshTransport: { ...MESH_JOIN_TRANSPORT },
                    }),
            };
        } catch (e: any) {
            return { success: false, code: 'mesh_host_join_failed', meshId, error: e.message };
        }
    },

    join_mesh_host_pairing: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const token = typeof args?.token === 'string' ? args.token.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!token) return { success: false, error: 'token required because raw pairing tokens are not persisted' };
        const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        if (!mesh) return { success: false, error: 'Mesh not found' };
        const meshHost = resolveMeshHostStatus(mesh);
        if (meshHost.role !== 'member') {
            return { success: false, code: 'mesh_host_join_not_member', meshId, meshHost, error: 'join_mesh_host_pairing must run from a member daemon configured with a Mesh Host address/token.' };
        }
        try {
            const { tokenIdForManualPairing, markMeshHostPairingJoined } = await import('../../config/mesh-config-host-pairing.js');
            const tokenId = tokenIdForManualPairing(token);
            if (meshHost.pairing?.tokenId && meshHost.pairing.tokenId !== tokenId) {
                return { success: false, code: 'mesh_host_join_rejected', meshId, tokenId, meshHost, error: 'invalid pairing token' };
            }
            const memberNode = buildMemberJoinNode(mesh, args, ctx.deps.statusInstanceId);
            if (!memberNode) return { success: false, error: 'member node metadata unavailable' };
            const hostMeshId = typeof args?.hostMeshId === 'string' && args.hostMeshId.trim() ? args.hostMeshId.trim() : meshId;
            const explicitHostDaemonId = typeof args?.hostDaemonId === 'string' && args.hostDaemonId.trim()
                ? args.hostDaemonId.trim()
                : '';
            const hostDaemonId = explicitHostDaemonId || meshHost.hostDaemonId;
            // Transport choice. A manual (standalone) pairing has a host address
            // and — before this join — no credential the mesh transport could
            // dial with, so it MUST go over the HTTP join endpoint: the WS mesh
            // dispatch would only wait out its connect budget. The mesh dispatch
            // is used when the caller names the host daemon explicitly (cloud,
            // where the account already connects the daemons) or when there is
            // no address at all; never towards this daemon itself (a member's
            // own mesh is created pinned to itself).
            const dispatchTarget = hostDaemonId && !daemonIdsEquivalent(hostDaemonId, readTrimmed(ctx.deps.statusInstanceId))
                ? hostDaemonId
                : '';
            const useDispatch = !!ctx.deps.dispatchMeshCommand && !!dispatchTarget
                && (!!explicitHostDaemonId || !meshHost.hostAddress);
            let hostResult: any;
            let transport: string;
            if (useDispatch) {
                transport = 'mesh_command_dispatch';
                hostResult = unwrapMeshRelayResult(await ctx.deps.dispatchMeshCommand!(dispatchTarget, 'apply_mesh_host_join', {
                    meshId: hostMeshId,
                    token,
                    memberMeshId: meshId,
                    memberNode,
                }), { command: 'apply_mesh_host_join', peerDaemonId: dispatchTarget });
            } else if (meshHost.hostAddress) {
                // The dedicated join endpoint, not /api/v1/command: the host's
                // dashboard token / password gate would answer 401 there, and a
                // member must not need the host's dashboard credential to pair.
                transport = 'standalone_http_mesh_join';
                const joinUrl = normalizeStandaloneHostJoinUrl(meshHost.hostAddress);
                const response = await fetch(joinUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ meshId: hostMeshId, token, memberMeshId: meshId, memberNode }),
                });
                hostResult = await response.json().catch(() => ({ success: false, error: `Host returned HTTP ${response.status}` }));
                if (!response.ok && hostResult?.success !== false) hostResult = { success: false, error: `Host returned HTTP ${response.status}` };
            } else {
                return {
                    success: false,
                    code: 'mesh_host_join_transport_unavailable',
                    meshId,
                    meshHost,
                    error: 'No hostDaemonId dispatch path or hostAddress HTTP command path is available. P2P signaling join is not implemented in this slice.',
                };
            }
            if (!hostResult?.success) {
                return { success: false, code: hostResult?.code || 'mesh_host_join_rejected', meshId, meshHost, transport, error: hostResult?.error || 'Mesh Host rejected join request', hostResult: redactHostJoinResult(hostResult) };
            }
            // Store the peer secret BEFORE marking the pairing joined: a member
            // that cannot keep the credential must not look paired.
            const pairedHostDaemonIdForSecret = readTrimmed(hostResult.hostDaemonId)
                || readTrimmed(hostResult.meshHost?.hostDaemonId)
                || readTrimmed(hostDaemonId);
            const peerSecret = readTrimmed(hostResult.peerSecret);
            const secretMeshId = readTrimmed(hostResult.meshId) || hostMeshId;
            let peerSecretStored = false;
            if (peerSecret && pairedHostDaemonIdForSecret) {
                try {
                    putPeerSecret({
                        // The host keyed its record by ITS mesh id, and the
                        // handshake hello must name that id — so the member
                        // stores the host's mesh id, not its local one.
                        meshId: secretMeshId,
                        peerDaemonId: canonicalDaemonId(pairedHostDaemonIdForSecret) || pairedHostDaemonIdForSecret,
                        role: 'member',
                        secret: peerSecret,
                        ...(meshHost.hostAddress ? { hostAddress: meshHost.hostAddress } : {}),
                        createdAt: new Date().toISOString(),
                    });
                    peerSecretStored = true;
                    LOG.info('MeshPairing', `stored host peer secret mesh=${secretMeshId} host=${maskDaemonId(pairedHostDaemonIdForSecret)}`);
                } catch (e: any) {
                    return {
                        success: false,
                        code: 'mesh_host_peer_secret_store_failed',
                        meshId,
                        meshHost,
                        transport,
                        error: `Host accepted the join but the peer secret could not be stored: ${e?.message || String(e)}`,
                        hostResult: redactHostJoinResult(hostResult),
                    };
                }
            }
            const joined = meshRecord.inline
                ? null
                : markMeshHostPairingJoined(meshId, {
                    tokenId: hostResult.tokenId || tokenId,
                    hostDaemonId: hostResult.meshHost?.hostDaemonId || hostDaemonId,
                    hostNodeId: hostResult.meshHost?.hostNodeId,
                    joinedAt: hostResult.meshHost?.pairing?.joinedAt,
                });
            if (joined) {
                ctx.inlineMeshCache.set(meshId, joined.mesh);
                ctx.invalidateAggregateMeshStatus(meshId);
            }
            // The host this member just paired with is its mesh host for the
            // mesh sender gate (commands/mesh-sender.ts) — persisted per mesh so
            // it holds for an inline-only mesh and across daemon restarts.
            const pairedHostDaemonId = typeof hostResult.meshHost?.hostDaemonId === 'string' && hostResult.meshHost.hostDaemonId.trim()
                ? hostResult.meshHost.hostDaemonId.trim()
                : hostDaemonId;
            if (pairedHostDaemonId) {
                const { writeMeshHostRecord } = await import('../../mesh/mesh-host-memory.js');
                writeMeshHostRecord(meshId, pairedHostDaemonId, 'pairing');
            }
            return {
                success: true,
                code: 'mesh_host_join_applied',
                meshId,
                hostMeshId,
                transport,
                node: hostResult.node,
                tokenId: hostResult.tokenId || tokenId,
                meshHost: joined ? resolveMeshHostStatus(joined.mesh) : { ...meshHost, pairing: { ...(meshHost.pairing || {}), status: 'paired', tokenId: hostResult.tokenId || tokenId } },
                peerSecretStored,
                ...(peerSecretStored ? { peerSecretMeshId: secretMeshId } : {}),
                ...(hostResult.meshTransport && typeof hostResult.meshTransport === 'object' ? { meshTransport: hostResult.meshTransport } : {}),
                hostResult: redactHostJoinResult(hostResult),
                manualPairing: {
                    status: 'paired',
                    joinImplemented: true,
                    protocol: 'standalone_command_direct_v1',
                    description: peerSecretStored
                        ? 'Mesh Host accepted the join; local member pairing status was marked paired and the host peer credential was stored locally.'
                        : 'Mesh Host accepted the join and local member pairing status was marked paired. The host returned no peer credential, so the direct mesh transport cannot authenticate to it.',
                },
            };
        } catch (e: any) {
            return { success: false, code: 'mesh_host_join_failed', meshId, meshHost, error: e.message };
        }
    },

    /**
     * Forget one peer's secret (design §4.4 step 6). Either side may run it:
     * the host revokes a member, a member forgets its host. The WS transport
     * closes the peer's open sockets through onPeerSecretsChanged; this command
     * only edits the store. Absent record → success with removed=false.
     */
    revoke_mesh_peer: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readTrimmed(args?.meshId);
        const rawPeer = readTrimmed(args?.peerDaemonId);
        if (!meshId) return { success: false, error: 'meshId required' };
        if (!rawPeer) return { success: false, error: 'peerDaemonId required' };
        const peerDaemonId = canonicalDaemonId(rawPeer) || rawPeer;
        try {
            const removed = removePeerSecret(meshId, peerDaemonId);
            if (removed) LOG.info('MeshPairing', `revoked peer secret mesh=${meshId} peer=${maskDaemonId(peerDaemonId)}`);
            return {
                success: true,
                code: removed ? 'mesh_peer_revoked' : 'mesh_peer_not_paired',
                meshId,
                peerDaemonId,
                removed,
            };
        } catch (e: any) {
            return { success: false, code: 'mesh_peer_revoke_failed', meshId, peerDaemonId, error: e?.message || String(e) };
        }
    },
};

/**
 * revoke_mesh_peer is a local operator action: a mesh peer must never be able
 * to revoke another peer's credential, so the mesh relay source is excluded.
 */
const LOCAL_OPERATOR_SOURCES: readonly CommandSource[] = ['ws', 'p2p', 'ext', 'api', 'standalone', 'ipc', 'internal'];

export const meshHostPairingSpecs = defineCommandSpecs('med', meshHostPairingHandlers, {
    // The joining member is not on the host's roster yet (the pairing token
    // authorises it): the sender must be the daemon its memberNode names.
    apply_mesh_host_join: { meshSender: 'pairing_member' },
    revoke_mesh_peer: { sources: LOCAL_OPERATOR_SOURCES, meshSender: undefined },
}, { meshSender: 'authenticated_peer' });
