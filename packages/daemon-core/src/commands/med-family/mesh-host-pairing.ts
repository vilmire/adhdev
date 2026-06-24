/**
 * RF-ROUTER MED family — Mesh Host manual-pairing commands.
 *
 * get_mesh_host_pairing, configure_mesh_host_pairing,
 * create_mesh_host_pairing_token, apply_mesh_host_join and
 * join_mesh_host_pairing. These read/mutate the mesh host pairing metadata and,
 * for join, apply the request to the host over mesh-command dispatch or a
 * standalone HTTP command. Extracted verbatim from executeDaemonCommand; pairing
 * helpers are imported from router.js, identical to the original references.
 */
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { buildMemberJoinNode, normalizeStandaloneHostCommandUrl } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

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
            const { configureMeshHostPairing } = await import('../../config/mesh-config.js');
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
            const { createMeshHostPairingToken } = await import('../../config/mesh-config.js');
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
            const { applyMeshHostJoinRequest } = await import('../../config/mesh-config.js');
            const applied = applyMeshHostJoinRequest(meshId, {
                token,
                memberNode: memberNode as any,
                memberMeshId: typeof args?.memberMeshId === 'string' ? args.memberMeshId : undefined,
            });
            if (!applied) return { success: false, error: 'Mesh not found' };
            if (!applied.accepted) {
                return {
                    success: false,
                    code: 'mesh_host_join_rejected',
                    meshId,
                    tokenId: applied.tokenId,
                    meshHost: applied.meshHost ? resolveMeshHostStatus({ meshHost: applied.meshHost }) : undefined,
                    error: applied.reason,
                };
            }
            ctx.inlineMeshCache.set(meshId, applied.mesh);
            ctx.invalidateAggregateMeshStatus(meshId);
            try {
                const { appendLedgerEntry } = await import('../../mesh/mesh-ledger.js');
                appendLedgerEntry(meshId, {
                    kind: 'node_joined',
                    nodeId: applied.node.id,
                    payload: { role: 'member', tokenId: applied.tokenId, workspace: applied.node.workspace },
                });
            } catch { /* ledger append is best-effort */ }
            return {
                success: true,
                code: 'mesh_host_join_accepted',
                meshId,
                node: applied.node,
                tokenId: applied.tokenId,
                meshHost: resolveMeshHostStatus(applied.mesh),
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
            const { tokenIdForManualPairing, markMeshHostPairingJoined } = await import('../../config/mesh-config.js');
            const tokenId = tokenIdForManualPairing(token);
            if (meshHost.pairing?.tokenId && meshHost.pairing.tokenId !== tokenId) {
                return { success: false, code: 'mesh_host_join_rejected', meshId, tokenId, meshHost, error: 'invalid pairing token' };
            }
            const memberNode = buildMemberJoinNode(mesh, args, ctx.deps.statusInstanceId);
            if (!memberNode) return { success: false, error: 'member node metadata unavailable' };
            const hostMeshId = typeof args?.hostMeshId === 'string' && args.hostMeshId.trim() ? args.hostMeshId.trim() : meshId;
            const hostDaemonId = typeof args?.hostDaemonId === 'string' && args.hostDaemonId.trim()
                ? args.hostDaemonId.trim()
                : meshHost.hostDaemonId;
            let hostResult: any;
            let transport: string;
            if (hostDaemonId && ctx.deps.dispatchMeshCommand) {
                transport = 'mesh_command_dispatch';
                hostResult = await ctx.deps.dispatchMeshCommand(hostDaemonId, 'apply_mesh_host_join', {
                    meshId: hostMeshId,
                    token,
                    memberMeshId: meshId,
                    memberNode,
                });
            } else if (meshHost.hostAddress) {
                transport = 'standalone_http_command';
                const commandUrl = normalizeStandaloneHostCommandUrl(meshHost.hostAddress);
                const response = await fetch(commandUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'apply_mesh_host_join', payload: { meshId: hostMeshId, token, memberMeshId: meshId, memberNode } }),
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
                return { success: false, code: hostResult?.code || 'mesh_host_join_rejected', meshId, meshHost, transport, error: hostResult?.error || 'Mesh Host rejected join request', hostResult };
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
            return {
                success: true,
                code: 'mesh_host_join_applied',
                meshId,
                hostMeshId,
                transport,
                node: hostResult.node,
                tokenId: hostResult.tokenId || tokenId,
                meshHost: joined ? resolveMeshHostStatus(joined.mesh) : { ...meshHost, pairing: { ...(meshHost.pairing || {}), status: 'paired', tokenId: hostResult.tokenId || tokenId } },
                hostResult,
                manualPairing: {
                    status: 'paired',
                    joinImplemented: true,
                    protocol: 'standalone_command_direct_v1',
                    description: 'Mesh Host accepted the join and local member pairing status was marked paired. P2P runtime signaling remains outside this slice.',
                },
            };
        } catch (e: any) {
            return { success: false, code: 'mesh_host_join_failed', meshId, meshHost, error: e.message };
        }
    },
};
