/**
 * Mesh node limit — the one rule behind "this mesh is full" and the one place its
 * refusal is worded.
 *
 * Two meshes.json writers register nodes, and both must refuse at the same count in the
 * same words: addNode (a base node, a worktree clone, a member worktree the host adopts)
 * and applyMeshHostJoinRequest (a member joining the host's mesh). The limit is the
 * mesh's policy.maxNodes (repo-mesh-policy.ts) — never a literal; it used to be a
 * hard-coded 10 in both places.
 *
 * The thrown error is structured. The config layer knows the node LIST, so it can name
 * the worktree nodes that could free a slot; a command handler that also holds the inline
 * cache can say which of them are cleanup_candidate (mesh/mesh-node-limit-advice.ts) and
 * re-renders the same details through formatMeshNodeLimitMessage.
 */
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { DEFAULT_MESH_MAX_NODES, MESH_MAX_NODES_MAX, resolveMaxNodes } from '../repo-mesh-types.js';
import { getMeshConfigPath } from './mesh-config-store.js';

/** Stable machine-readable code carried by the error and by the command result. */
export const MESH_NODE_LIMIT_CODE = 'mesh_node_limit_exceeded';

/** How many nodes of each group the message spells out; the structured details keep all of them. */
const LISTED_PER_GROUP = 8;

/** One worktree node the owner could finish to free a slot. */
export interface MeshNodeLimitWorktree {
    nodeId: string;
    branch?: string;
    /** Owning machine's nickname, when the node record carries one. */
    machine?: string;
    /**
     * Last-known branchConvergence.status. Absent from the config layer's own details; set
     * only by a caller that held git evidence for the node (mesh-node-limit-advice.ts).
     */
    convergence?: string;
}

export interface MeshNodeLimitDetails {
    meshId: string;
    meshName: string;
    /** Nodes the mesh holds now. */
    count: number;
    /** The effective policy.maxNodes. */
    limit: number;
    baseNodes: number;
    worktreeNodes: number;
    /** True when the owner set policy.maxNodes; false when the built-in default applies. */
    limitIsOverride: boolean;
    /**
     * Absolute path of the meshes.json that holds this mesh's policy block — where the limit
     * can be raised by hand. Per instance (~/.adhdev vs ~/.adhdev-preview vs ADHDEV_CONFIG_DIR),
     * so the message names it rather than letting the reader guess.
     */
    configPath?: string;
    /** Every worktree node, in registration order (oldest first). */
    worktrees: MeshNodeLimitWorktree[];
}

/** The slice of a mesh the limit reads — config entries and inline-cache meshes both fit. */
export type MeshNodeLimitSubject = Pick<LocalMeshEntry, 'id' | 'name' | 'nodes'> & {
    policy?: { maxNodes?: unknown } | null;
};

// Named for what it labels (not the generic `nodeLabel`): daemon-core is inlined into the
// vendored mcp-server bundle, where a module-level `nodeLabel` makes esbuild rename every
// unrelated `nodeLabel` local in the bundle and floods the committed diff with churn.
function worktreeLabel(node: MeshNodeLimitWorktree): string {
    const where = [node.branch, node.machine ? `@${node.machine}` : ''].filter(Boolean).join(' ');
    // cleanup_candidate is what the group heading already says; any other verdict is
    // worth showing next to the node ("not_mergeable" = do not remove it blindly).
    const verdict = node.convergence && node.convergence !== 'cleanup_candidate' ? ` [${node.convergence}]` : '';
    return `${node.nodeId}${where ? ` (${where})` : ''}${verdict}`;
}

function listNodes(nodes: MeshNodeLimitWorktree[]): string {
    const shown = nodes.slice(0, LISTED_PER_GROUP).map(worktreeLabel).join(', ');
    return nodes.length > LISTED_PER_GROUP ? `${shown}, +${nodes.length - LISTED_PER_GROUP} more` : shown;
}

/**
 * The refusal text: what is full (count / limit), how to raise it, and what to clean up
 * first. One paragraph on purpose — it travels as a thrown message, a CLI line and an MCP
 * `error` string alike.
 */
export function formatMeshNodeLimitMessage(details: MeshNodeLimitDetails): string {
    // At the ceiling there is nothing to raise; pointing the owner at a limit that cannot
    // move would send them round in a circle, so say so and go straight to freeing slots.
    const raisable = details.limit < MESH_MAX_NODES_MAX;
    const parts: string[] = [
        `${MESH_NODE_LIMIT_CODE}: mesh "${details.meshName}" already holds ${details.count} of its ${details.limit} allowed nodes `
        + `(${details.baseNodes} base, ${details.worktreeNodes} worktree), so no node can be added.`,
        raisable
            ? `To raise the limit, set policy.maxNodes (${details.limitIsOverride ? 'set on this mesh' : `default ${DEFAULT_MESH_MAX_NODES}`}, `
                + `max ${MESH_MAX_NODES_MAX}): edit this mesh's "policy" block in ${details.configPath ?? 'meshes.json'} (no restart needed) `
                + `or send update_mesh {"meshId":"${details.meshId}","policy":{"maxNodes":<N>}}; null resets it to the default.`
            : `policy.maxNodes is already at its maximum (${MESH_MAX_NODES_MAX}), so the limit cannot be raised further.`,
    ];
    const instead = raisable ? 'To free slots instead' : 'To free slots';
    if (details.worktrees.length === 0) {
        parts.push(`${instead}, remove a node that is no longer in use with mesh_remove_node (every node here is a base node, so there is no worktree to clean up).`);
    } else {
        const candidates = details.worktrees.filter(w => w.convergence === 'cleanup_candidate');
        const others = details.worktrees.filter(w => w.convergence !== 'cleanup_candidate');
        const judged = details.worktrees.some(w => w.convergence);
        parts.push(`${instead}, finish worktree nodes that are no longer needed.`);
        if (candidates.length > 0) parts.push(`cleanup_candidate worktrees (${candidates.length}): ${listNodes(candidates)}.`);
        if (others.length > 0) {
            parts.push(
                `${candidates.length > 0 ? 'Other worktree nodes' : 'Worktree nodes'} (${others.length}): ${listNodes(others)}`
                + `${judged ? '' : ' — no git evidence was held here to tell which are cleanup_candidate; mesh_status shows it'}.`,
            );
        }
        parts.push(
            'mesh_refine_node merges a finished branch and removes its worktree, mesh_cleanup_worktree_nodes (dry-run by default) '
            + 'reclaims worktrees that are already converged, mesh_remove_node removes a single node.',
        );
    }
    return parts.join(' ');
}

/** Counts and worktree summaries for `mesh` — no limit check, so callers can also describe a full mesh. */
export function buildMeshNodeLimitDetails(mesh: MeshNodeLimitSubject): MeshNodeLimitDetails {
    const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];
    const worktrees: MeshNodeLimitWorktree[] = [];
    for (const node of nodes) {
        if (node.isLocalWorktree !== true) continue;
        const branch = typeof node.worktreeBranch === 'string' ? node.worktreeBranch.trim() : '';
        const machine = typeof node.machineNickname === 'string' ? node.machineNickname.trim() : '';
        worktrees.push({
            nodeId: node.id,
            ...(branch ? { branch } : {}),
            ...(machine ? { machine } : {}),
        });
    }
    const raw = mesh.policy?.maxNodes;
    // Describing a full mesh must never fail because the config dir cannot be resolved.
    let configPath: string | undefined;
    try { configPath = getMeshConfigPath(); } catch { /* the message falls back to the bare file name */ }
    return {
        meshId: mesh.id,
        meshName: mesh.name,
        count: nodes.length,
        limit: resolveMaxNodes(raw),
        baseNodes: nodes.length - worktrees.length,
        worktreeNodes: worktrees.length,
        limitIsOverride: raw !== undefined && raw !== null,
        ...(configPath ? { configPath } : {}),
        worktrees,
    };
}

export class MeshNodeLimitError extends Error {
    readonly code = MESH_NODE_LIMIT_CODE;

    constructor(readonly details: MeshNodeLimitDetails) {
        super(formatMeshNodeLimitMessage(details));
        this.name = 'MeshNodeLimitError';
    }
}

/**
 * Structural check rather than `instanceof`: the daemon is bundled into several dist
 * artifacts, and an error crossing a bundle boundary is not an instance of this copy's class.
 */
export function isMeshNodeLimitError(error: unknown): error is MeshNodeLimitError {
    const candidate = error as { code?: unknown; details?: { worktrees?: unknown } } | null | undefined;
    return !!candidate
        && candidate.code === MESH_NODE_LIMIT_CODE
        && !!candidate.details
        && Array.isArray(candidate.details.worktrees);
}

/**
 * Refuse registration when the mesh already holds its policy.maxNodes nodes. Called inside
 * the meshes.json write lock, before anything is mutated or saved — a refused join leaves
 * the pairing token unconsumed, so the member can retry once the limit is raised.
 */
export function assertMeshNodeCapacity(mesh: MeshNodeLimitSubject): void {
    const count = Array.isArray(mesh.nodes) ? mesh.nodes.length : 0;
    if (count < resolveMaxNodes(mesh.policy?.maxNodes)) return;
    throw new MeshNodeLimitError(buildMeshNodeLimitDetails(mesh));
}
