// Test helper: answer the coordinator daemon's `mesh_status` command (the MCP
// mesh_status tool's ONE held-node-state read, mesh-status-held-git.ts) from a
// fixture's per-workspace git answers — the shape the daemon renders from its
// coordinator-held node-git store (member pushes / background refresh).
//
// `gitFor(node)` returns the node's git status (or a git_status-shaped
// `{ status, reporterNodeFacts }` envelope), or throws / returns null when the
// coordinator holds nothing for it. A throw maps to "refreshes failing"
// (gitObservation.unreachableSince), mirroring what the daemon store records.

type AnyRecord = Record<string, any>;

export interface HeldMeshStatusOptions {
    /** Nodes owned by this daemon render as source 'self'. */
    localDaemonId?: string;
    /** Epoch ms stamped as observedAt (default: now). */
    observedAt?: number;
    /** Node ids reported as refreshing (a background refresh in flight). */
    refreshingNodeIds?: string[];
}

export async function heldMeshStatusResponse(
    mesh: { nodes: AnyRecord[] },
    gitFor: (node: AnyRecord) => unknown | Promise<unknown>,
    opts: HeldMeshStatusOptions = {},
): Promise<AnyRecord> {
    const observedAt = opts.observedAt ?? Date.now();
    const nodes: AnyRecord[] = [];
    for (const node of mesh.nodes) {
        const isSelf = !!opts.localDaemonId && node.daemonId === opts.localDaemonId;
        const refreshing = (opts.refreshingNodeIds ?? []).includes(node.id);
        let answer: any;
        let failed: string | null = null;
        try {
            answer = await gitFor(node);
        } catch (error: any) {
            failed = error?.message || 'refresh failed';
        }
        const git = answer?.status && typeof answer.status === 'object' ? answer.status : answer;
        const facts = answer?.reporterNodeFacts;
        if (failed || !git || typeof git !== 'object') {
            nodes.push({
                nodeId: node.id,
                gitObservation: {
                    source: 'none',
                    observedAt: null,
                    refreshing,
                    unreachableSince: failed ? observedAt - 60_000 : null,
                    ...(failed ? { lastRefreshError: failed } : {}),
                },
            });
            continue;
        }
        nodes.push({
            nodeId: node.id,
            git: { lastCheckedAt: observedAt, ...git },
            ...(facts ? { nodeFacts: facts } : {}),
            gitObservation: {
                source: isSelf ? 'self' : 'member_push',
                observedAt,
                refreshing,
                unreachableSince: null,
            },
        });
    }
    return { success: true, meshId: (mesh as AnyRecord).id, nodes };
}

/**
 * Adapt a fixture's `(command, args)` responder: answers `mesh_status` from the
 * responder's own `git_status` answers per node workspace.
 */
export function heldMeshStatusFromResponder(
    mesh: { nodes: AnyRecord[] },
    responder: (command: string, args?: any) => unknown | Promise<unknown>,
    opts: HeldMeshStatusOptions = {},
): Promise<AnyRecord> {
    return heldMeshStatusResponse(mesh, (node) => responder('git_status', { workspace: node.workspace }), opts);
}
