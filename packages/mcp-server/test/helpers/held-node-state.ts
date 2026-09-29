// Test helper: answer the coordinator daemon's `mesh_status` command (the MCP
// mesh_status tool's ONE held-node-state read, mesh-status-held-git.ts) from a
// fixture's per-workspace git answers — the shape the daemon renders from its
// coordinator-held node-git store (member pushes / background refresh).
//
// `gitFor(node)` returns the node's git status (or a git_status-shaped
// `{ status, reporterNodeFacts }` envelope), or throws / returns null when the
// coordinator holds nothing for it. A throw maps to "refreshes failing"
// (gitObservation.unreachableSince), mirroring what the daemon store records.

import { applyInlineMeshBranchConvergence, deriveMeshNodeHealthFromGit } from '@adhdev/daemon-core';

type AnyRecord = Record<string, any>;

export interface HeldMeshStatusOptions {
    /** Nodes owned by this daemon render as source 'self'. */
    localDaemonId?: string;
    /** Epoch ms stamped as observedAt (default: now). */
    observedAt?: number;
    /** Node ids reported as refreshing (a background refresh in flight). */
    refreshingNodeIds?: string[];
    /** Held runtime per node (sessions / build / upgrade marker), as the daemon's overlay stamps it on nodes served by another daemon. */
    runtimeFor?: (node: AnyRecord) => AnyRecord | undefined;
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
        const heldRuntime = !isSelf && opts.runtimeFor ? opts.runtimeFor(node) : undefined;
        const runtimeStamp = heldRuntime ? { heldRuntime } : {};
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
                ...runtimeStamp,
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
        const status: AnyRecord = {
            nodeId: node.id,
            ...runtimeStamp,
            git: { lastCheckedAt: observedAt, ...git },
            ...(facts ? { nodeFacts: facts } : {}),
            gitObservation: {
                source: isSelf ? 'self' : 'member_push',
                observedAt,
                refreshing,
                unreachableSince: null,
            },
        };
        // The daemon's own verdicts ride on every node it renders (the tool passes them through).
        status.health = deriveMeshNodeHealthFromGit(status.git);
        applyInlineMeshBranchConvergence(mesh, node, status);
        nodes.push(status);
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

/**
 * Model "the member pushed its status to the coordinator" for a fixture whose
 * fake MEMBER answers `get_status_metadata`: the coordinator's `mesh_status`
 * (node section) now carries each remote node's `heldRuntime` built from what
 * that member would report, and the tool itself can no longer read a member's
 * status — a `meshCommand(…, 'get_status_metadata')` from the tool throws.
 * Apply after the fixture assigned both `command` and `meshCommand`.
 */
export function holdMemberStatusOnCoordinator(transport: any, mesh: { nodes: AnyRecord[] }, localDaemonId?: string): void {
    const member = transport.meshCommand.bind(transport);
    const coordinator = transport.command;
    transport.command = async (command: string, args: AnyRecord = {}) => {
        if (command !== 'mesh_status') return coordinator(command, args);
        const nodes = await Promise.all(mesh.nodes.map(async (node) => {
            if (!node.daemonId || node.daemonId === localDaemonId) return { nodeId: node.id };
            let raw: any;
            try {
                raw = await member(node.daemonId, 'get_status_metadata', {});
            } catch {
                return { nodeId: node.id, heldRuntime: { source: 'none', observedAt: null, refreshing: false, sessions: [] } };
            }
            const payload = raw?.result?.status ? raw.result : raw;
            return {
                nodeId: node.id,
                heldRuntime: {
                    source: 'member_push',
                    observedAt: Date.now(),
                    refreshing: false,
                    sessions: Array.isArray(payload?.status?.sessions) ? payload.status.sessions : [],
                    ...(payload?.status?.instanceId ? { daemonId: payload.status.instanceId } : {}),
                    ...(payload?.daemonBuild ? { daemonBuild: payload.daemonBuild } : {}),
                },
            };
        }));
        return { success: true, meshId: (mesh as AnyRecord).id, nodes };
    };
    transport.meshCommand = async (daemonId: string, command: string, args: AnyRecord = {}) => {
        if (command === 'get_status_metadata') throw new Error(`the tool read member ${daemonId}'s status — it must answer from the coordinator's held state`);
        return member(daemonId, command, args);
    };
}
