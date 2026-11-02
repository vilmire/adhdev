/**
 * LIGHT-TASK enqueue admission that needs daemon context (design §6): the calling daemon
 * owns the mesh queue, the light base node is local, and `.adhdev/light-workspace.json`
 * is present and valid. Shape rules that need no context (mode, owned_paths) live in
 * enqueueTask itself.
 */
import { daemonIdsEquivalent, LIGHT_REJECT, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { loadLightWorkspaceConfig, type LightWorkspaceConfig } from './light-workspace-config.js';

interface MeshNodeLike { id?: string; nodeId?: string; node_id?: string; daemonId?: string; workspace?: string; isLocalWorktree?: boolean }

export interface LightAdmission {
    lightBaseNodeId: string;
    checkoutRoot: string;
    config: LightWorkspaceConfig;
}

export function admitLightBaseNode(
    mesh: { nodes?: MeshNodeLike[] } | null | undefined,
    selfDaemonId: string | undefined,
    requestedBaseNodeId?: string,
): LightAdmission {
    const nodes = (mesh?.nodes ?? []).filter(n => typeof n?.workspace === 'string' && n.workspace.trim());
    // A node with no daemonId is the mesh host's own node (standalone-created nodes carry none);
    // same rule as mission-git-env / isLocalAutoLaunchNode.
    const isLocal = (n: MeshNodeLike) => !n.daemonId || (!!selfDaemonId && daemonIdsEquivalent(n.daemonId, selfDaemonId));
    let node: MeshNodeLike | undefined;
    if (requestedBaseNodeId) {
        node = nodes.find(n => meshNodeIdMatches(n as { id: string }, requestedBaseNodeId));
        if (!node || !isLocal(node)) {
            throw new Error(`${LIGHT_REJECT.REQUIRES_LOCAL_BASE}: light_base_node_id '${requestedBaseNodeId}' is not a node on the mesh host's machine.`);
        }
    } else {
        node = nodes.find(n => isLocal(n) && n.isLocalWorktree !== true);
        if (!node) throw new Error(`${LIGHT_REJECT.REQUIRES_LOCAL_BASE}: the mesh host's machine has no base node; light tasks run on the coordinator's machine.`);
    }
    const checkoutRoot = node.workspace!.trim();
    const cfg = loadLightWorkspaceConfig(checkoutRoot);
    if (!cfg.ok) {
        throw new Error(`${LIGHT_REJECT.NOT_CONFIGURED}: ${cfg.message} at ${cfg.path}. Run mesh_init to scaffold .adhdev/light-workspace.json, or use a worktree node.`);
    }
    return { lightBaseNodeId: String(node.id ?? node.nodeId ?? node.node_id), checkoutRoot, config: cfg.config };
}
