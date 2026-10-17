/**
 * The command-layer half of the mesh node-limit refusal (config/mesh-node-limit.ts).
 *
 * addNode runs deep in the config layer, which knows the node LIST but not whether a
 * worktree is finished. A command handler knows more: the inline mesh cache carries each
 * node's last-known git state (`lastGit`), and the convergence classifier mesh_status
 * uses (applyInlineMeshBranchConvergence) is pure. So the handler re-reads the same
 * evidence the status surfaces read, marks which worktree nodes are cleanup_candidate,
 * and hands the coordinator a refusal that says what to clean up first — without one git
 * spawn (a refusal must stay fast, and win32 git spawns cost seconds).
 *
 * Advisory only: it steers a suggestion. Every removal path (mesh_refine_node,
 * mesh_cleanup_worktree_nodes, mesh_remove_node) proves convergence for itself.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import {
    DEFAULT_MESH_MAX_NODES,
    MESH_MAX_NODES_MAX,
} from '../repo-mesh-types.js';
import {
    MESH_NODE_LIMIT_CODE,
    formatMeshNodeLimitMessage,
    isMeshNodeLimitError,
    type MeshNodeLimitDetails,
} from '../config/mesh-node-limit.js';
import {
    applyInlineMeshBranchConvergence,
    buildInlineMeshTransitGitStatus,
    isDeadLocalWorktreeNode,
    readObjectRecord,
    readStringValue,
} from './mesh-node-identity.js';

/** What the refusing handler holds beyond the config node list. */
export interface NodeLimitEvidence {
    /** The persisted mesh — supplies defaultBranch and each node's workspace / daemonId. */
    configMesh?: { defaultBranch?: string; nodes?: unknown[] } | null;
    /** The inline cache's nodes for the same mesh; they carry the held git state. */
    inlineNodes?: unknown[] | null;
    /** This daemon's id: a worktree whose directory is gone is only judged on its own machine. */
    selfDaemonId?: string;
}

function findNode(nodes: unknown[] | null | undefined, nodeId: string): any {
    return Array.isArray(nodes) ? nodes.find(node => meshNodeIdMatches(node as any, nodeId)) : undefined;
}

/** convergence status for one worktree node, or undefined when nothing is known about it. */
function judgeWorktree(nodeId: string, evidence: NodeLimitEvidence): string | undefined {
    const configNode = findNode(evidence.configMesh?.nodes, nodeId);
    const heldNode = findNode(evidence.inlineNodes, nodeId) ?? configNode;
    const git = heldNode ? buildInlineMeshTransitGitStatus(heldNode) : undefined;
    if (git) {
        // Only with git evidence in hand: the classifier's own "no evidence" branches would
        // otherwise judge a REMOTE worktree by probing a path that only exists on its machine.
        const status: Record<string, unknown> = { git };
        applyInlineMeshBranchConvergence({ defaultBranch: evidence.configMesh?.defaultBranch }, heldNode, status);
        const verdict = readStringValue(readObjectRecord(status.branchConvergence).status);
        if (verdict && verdict !== 'unknown') return verdict;
    }
    // A worktree directory that is gone on THIS daemon's own disk is a cleanup_candidate
    // by definition (mesh-branch-convergence.ts worktree_path_missing) — and cheap to see.
    const selfDaemonId = readStringValue(evidence.selfDaemonId);
    const ownerDaemonId = readStringValue(configNode?.daemonId);
    if (configNode && selfDaemonId && ownerDaemonId
        && daemonIdsEquivalent(ownerDaemonId, selfDaemonId)
        && isDeadLocalWorktreeNode(configNode)) {
        return 'cleanup_candidate';
    }
    return undefined;
}

/** `details` with each worktree's convergence filled in wherever the evidence allows. */
export function classifyWorktreesForNodeLimit(details: MeshNodeLimitDetails, evidence: NodeLimitEvidence): MeshNodeLimitDetails {
    return {
        ...details,
        worktrees: details.worktrees.map(worktree => {
            const convergence = judgeWorktree(worktree.nodeId, evidence);
            return convergence ? { ...worktree, convergence } : worktree;
        }),
    };
}

/**
 * The command result for a refused registration: the full actionable message in `error`
 * plus the same facts structured (`nodeLimit`, `cleanupCandidates`) for the dashboard,
 * the CLI and MCP callers that pass the whole result through.
 */
export function meshNodeLimitFailure(details: MeshNodeLimitDetails, evidence: NodeLimitEvidence): Record<string, unknown> {
    const judged = classifyWorktreesForNodeLimit(details, evidence);
    return {
        success: false,
        code: MESH_NODE_LIMIT_CODE,
        error: formatMeshNodeLimitMessage(judged),
        meshId: judged.meshId,
        nodeLimit: {
            count: judged.count,
            limit: judged.limit,
            baseNodes: judged.baseNodes,
            worktreeNodes: judged.worktreeNodes,
            limitIsOverride: judged.limitIsOverride,
            defaultLimit: DEFAULT_MESH_MAX_NODES,
            maxAllowed: MESH_MAX_NODES_MAX,
            raiseWith: { command: 'update_mesh', args: { meshId: judged.meshId, policy: { maxNodes: '<N>' } } },
            // The same change by hand: this mesh's policy block in this instance's meshes.json.
            ...(judged.configPath ? { configPath: judged.configPath } : {}),
            worktrees: judged.worktrees,
        },
        cleanupCandidates: judged.worktrees.filter(worktree => worktree.convergence === 'cleanup_candidate'),
    };
}

/**
 * Handler adapter: `null` when `error` is not a node-limit refusal (the caller keeps its own
 * error shape), otherwise the enriched failure. Reads the persisted mesh itself so a caller
 * that only has the thrown error (the clone handler's outer catch) needs nothing else.
 */
export async function nodeLimitFailureFromError(
    error: unknown,
    args: { meshId: string; inlineNodes?: unknown[] | null; selfDaemonId?: string },
): Promise<Record<string, unknown> | null> {
    if (!isMeshNodeLimitError(error)) return null;
    let configMesh: NodeLimitEvidence['configMesh'] = null;
    try {
        const { getMesh } = await import('../config/mesh-config.js');
        configMesh = getMesh(args.meshId) ?? null;
    } catch { /* evidence only — the refusal itself must still be delivered */ }
    return meshNodeLimitFailure(error.details, {
        configMesh,
        inlineNodes: args.inlineNodes,
        selfDaemonId: args.selfDaemonId,
    });
}
