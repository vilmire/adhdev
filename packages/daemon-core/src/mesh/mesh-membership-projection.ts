/**
 * get_mesh `membershipOnly` projection (MCP read-latency pass, 2026-09-27).
 *
 * The MCP server refreshes its mesh snapshot with `get_mesh` before EVERY mesh
 * tool call, and plain get_mesh hydrates each local workspace's git
 * (getGitRepoStatus with refreshUpstream — ~300 ms cold, 12 s reuse) and returns
 * every node's `lastGit` twice (`lastGit` + the `last_git` alias). The MCP reads
 * membership from it (ids, workspaces, identity, policy, facts) — git truth comes
 * from the coordinator-held state (`mesh_status`). This projection is what
 * `membershipOnly: true` answers instead: no git read, no git blob, and a LOCAL
 * node's `nodeFacts` rebuilt with the same producer the hydration uses, so the
 * direct-dispatch quota gate (nodeFacts.quota) still reads current local quota.
 *
 * Pure over its inputs apart from the facts builder; never mutates the record
 * (the mesh object may be the daemon's shared inline cache).
 */
import * as fs from 'fs';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';

export const MEMBERSHIP_ONLY_DROPPED_NODE_KEYS = ['lastGit', 'last_git'] as const;

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function isLocalMembershipNode(node: any, locality: { localMachineId?: string; localDaemonId?: string }): boolean {
    const daemonId = readString(node?.daemonId);
    if (daemonId) {
        return Boolean(
            (locality.localMachineId && daemonIdsEquivalent(daemonId, locality.localMachineId))
            || (locality.localDaemonId && daemonIdsEquivalent(daemonId, locality.localDaemonId)),
        );
    }
    const workspace = readString(node?.workspace);
    return Boolean(workspace) && fs.existsSync(workspace);
}

export function projectMeshMembershipOnly(
    mesh: any,
    opts: {
        localMachineId?: string;
        localDaemonId?: string;
        /** Fresh facts for this daemon's own nodes; null/throw keeps the record's facts. */
        localNodeFacts?: () => unknown;
    },
): any {
    if (!mesh || typeof mesh !== 'object' || !Array.isArray(mesh.nodes)) return mesh;
    let localFacts: unknown;
    let localFactsRead = false;
    const nodes = mesh.nodes.map((node: any) => {
        if (!node || typeof node !== 'object') return node;
        const view: Record<string, unknown> = { ...node };
        for (const key of MEMBERSHIP_ONLY_DROPPED_NODE_KEYS) delete view[key];
        if (opts.localNodeFacts && isLocalMembershipNode(node, opts)) {
            if (!localFactsRead) {
                localFactsRead = true;
                try { localFacts = opts.localNodeFacts(); } catch { localFacts = null; }
            }
            if (localFacts) view.nodeFacts = localFacts;
        }
        return view;
    });
    return { ...mesh, nodes };
}
