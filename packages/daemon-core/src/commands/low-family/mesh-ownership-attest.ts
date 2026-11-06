/**
 * Physical ownership attestation across machines (mesh-remote-ownership.ts).
 *
 * `mesh_attest_node_ownership` runs on the machine that holds a checkout and answers
 * only the mesh host as this machine knows it — the host is who admits writers. It
 * reads metadata only (realpath, git rev-parse, stat); it changes nothing.
 *
 * `mesh_attest_remote_ownership` is the host's own-surface wrapper: the coordinator's
 * direct send asks it for a remote node's scope before admitting a write.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { getMachineId } from '../../config/config.js';
import { getMesh } from '../../config/mesh-config.js';
import { readMeshHostRecord } from '../../mesh/mesh-host-memory.js';
import { attestLocalOwnership } from '../../mesh/mesh-physical-ownership.js';
import { fetchRemoteOwnership, MESH_ATTEST_NODE_OWNERSHIP } from '../../mesh/mesh-remote-ownership.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { readMeshSender } from '../mesh-sender.js';
import { defineCommandSpecs } from '../command-registry.js';
import type { CommandRouterResult } from '../router.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const refuse = (code: string, error: string) => ({ success: false, code, error }) as CommandRouterResult;

/** The host of `meshId` as this machine knows it: its mesh record, else the persisted host record. */
function knownHostDaemonId(meshId: string): string {
    return text(getMesh(meshId)?.meshHost?.hostDaemonId) || text(readMeshHostRecord(meshId)?.hostDaemonId);
}

/**
 * A declaration as `{paths: [{path, subtree}]}`, an entry array, or caller strings. Entries
 * are re-validated through their string form (`dir/**` for a subtree), so `list` equals
 * `declaration.paths` only when every entry was already normalized.
 */
function declarationOf(raw: unknown) {
    const items = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { paths?: unknown }).paths : raw;
    const list = Array.isArray(items) ? items : [];
    const asStrings = list.map(item => {
        if (typeof item === 'string') return item;
        const e = item as { path?: unknown; subtree?: unknown } | null;
        if (!e || typeof e.path !== 'string') return '';
        return e.subtree === true ? (e.path ? `${e.path}/**` : '**') : e.path;
    });
    const declaration = normalizeOwnedPaths(asStrings).declaration;
    const entries = list.every(item => typeof item === 'string') ? declaration.paths : list;
    return { list: entries, declaration };
}

const attestNodeOwnership: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const sender = readMeshSender(args);
    const meshId = text(args?.meshId);
    if (!sender || !meshId) return refuse('unauthenticated', 'mesh_attest_node_ownership requires an authenticated mesh sender and meshId');
    const hostDaemonId = knownHostDaemonId(meshId);
    if (!hostDaemonId || !daemonIdsEquivalent(hostDaemonId, sender)) {
        return refuse('not_mesh_host', `Only the host of mesh ${meshId} known to this machine may ask for an ownership attestation`);
    }
    const nodeId = text(args?.nodeId);
    const workspace = text(args?.workspace);
    const repoIdentity = text(args?.repoIdentity);
    const phase = args?.phase === 'integration' ? 'integration' : 'source';
    const { list, declaration } = declarationOf(args?.ownedPaths);
    if (!nodeId || !repoIdentity || !path.isAbsolute(workspace)) return refuse('invalid_arguments', 'nodeId, repoIdentity and an absolute workspace are required');
    if (!declaration.paths.length || JSON.stringify(declaration.paths) !== JSON.stringify(list)) {
        return refuse('invalid_arguments', 'ownedPaths must be a non-empty normalized declaration');
    }
    // A local mesh record that names this node must agree on where it lives.
    const localNode = getMesh(meshId)?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
    if (localNode && typeof localNode.workspace === 'string' && localNode.workspace && localNode.workspace !== workspace) {
        return refuse('workspace_mismatch', `Node ${nodeId} is registered on this machine at a different workspace`);
    }
    if (localNode) {
        const own = readMeshNodeDaemonId(localNode as any);
        const self = text(ctx.deps.statusInstanceId);
        if (own && self && !daemonIdsEquivalent(own, self)) return refuse('node_not_local', `Node ${nodeId} is not on this machine`);
    }
    const machineId = getMachineId();
    if (!machineId) return refuse('machine_identity_unavailable', 'This machine has no machineId to attest with');
    try {
        // The session the task goes to must run in this checkout, not in another worktree.
        const sessionId = text(args?.sessionId);
        if (sessionId) {
            let workingDir = '';
            try { workingDir = text((ctx.components().cliManager?.adapters?.get(sessionId) as { workingDir?: string } | undefined)?.workingDir); } catch { /* not ready */ }
            if (workingDir && realpathSync.native(workingDir) !== realpathSync.native(workspace)) {
                return refuse('active_workspace_unproven', `Session ${sessionId} is not running in the node checkout`);
            }
        }
        const scope = attestLocalOwnership({ repoIdentity, machineId, nodeId, workspace, phase, paths: declaration });
        return { success: true, scope } as CommandRouterResult;
    } catch (e: any) {
        return refuse('ownership_unproven', typeof e?.message === 'string' ? e.message : String(e));
    }
};

const attestRemoteOwnership: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const meshId = text(args?.meshId);
    const nodeId = text(args?.nodeId);
    if (!meshId || !nodeId) return refuse('invalid_arguments', 'meshId and nodeId are required');
    const resolved = await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true }).catch(() => null);
    const mesh: any = resolved?.mesh ?? getMesh(meshId);
    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
    if (!node) return refuse('node_not_found', `Node ${nodeId} is not in mesh ${meshId}`);
    const daemonId = readMeshNodeDaemonId(node) || '';
    const self = text(ctx.deps.statusInstanceId);
    if (!daemonId || !self || daemonIdsEquivalent(daemonId, self)) return refuse('node_not_remote', `Node ${nodeId} is on this machine; attest it locally`);
    const dispatch = ctx.deps.dispatchMeshCommand;
    if (!dispatch) return refuse('mesh_transport_unavailable', 'No mesh transport to reach the remote machine');
    const { declaration } = declarationOf(args?.ownedPaths);
    if (!declaration.paths.length) return refuse('ownership_unproven', 'ownership_unproven: ownedPaths');
    const proof = await fetchRemoteOwnership(dispatch, {
        meshId,
        nodeId,
        daemonId,
        workspace: text(node.workspace),
        repoIdentity: text(mesh?.repoIdentity),
        phase: args?.phase === 'integration' ? 'integration' : 'source',
        paths: declaration,
        ...(text(args?.sessionId) ? { sessionId: text(args.sessionId) } : {}),
    });
    return 'scope' in proof ? { success: true, scope: proof.scope } as CommandRouterResult : refuse('ownership_unproven', proof.error);
};

export const meshOwnershipAttestHandlers: Record<string, LowFamilyHandler> = {
    [MESH_ATTEST_NODE_OWNERSHIP]: attestNodeOwnership,
    mesh_attest_remote_ownership: attestRemoteOwnership,
};

export const meshOwnershipAttestSpecs = defineCommandSpecs('low', meshOwnershipAttestHandlers, {
    // The handler accepts only the mesh host this machine knows (a member may hold no roster).
    [MESH_ATTEST_NODE_OWNERSHIP]: { sources: ['mesh'], meshSender: 'authenticated_peer' },
    // The coordinator's own surface (mcp direct send) only.
    mesh_attest_remote_ownership: { sources: ['ipc', 'standalone'] },
});
