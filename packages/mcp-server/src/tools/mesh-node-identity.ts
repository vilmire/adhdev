/**
 * Node identity / locality resolution helpers for the mesh_* tools.
 *
 * Physically split out of mesh-tools.ts (RF-SURVEY candidate C1) with no behavior
 * change. Resolves machine/daemon/hostname identity for a mesh node and decides
 * whether a node is the local control-plane / coordinator node. Imports only leaf
 * deps (mesh-tool-shared, daemon-core) plus the MeshContext type (type-only, so no
 * runtime import cycle); mesh-tools.ts imports the exported helpers back.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/daemon-core';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { readString } from './mesh-tool-shared.js';
import type { MeshContext } from './mesh-tools.js';

export function resolveCoordinatorNode(ctx: MeshContext): LocalMeshNodeEntry | undefined {
    const preferredNodeId = typeof ctx.mesh.coordinator?.preferredNodeId === 'string'
        ? ctx.mesh.coordinator.preferredNodeId.trim()
        : '';
    if (preferredNodeId) {
        const preferred = ctx.mesh.nodes.find(n => n.id === preferredNodeId && typeof n.daemonId === 'string' && n.daemonId.trim());
        if (preferred) return preferred;
    }
    if (ctx.localMachineId) {
        const byMachine = ctx.mesh.nodes.find(n => readNodeMachineId(n) === ctx.localMachineId);
        if (byMachine) return byMachine;
    }
    if (ctx.localDaemonId) {
        return ctx.mesh.nodes.find(n => readNodeDaemonId(n) === ctx.localDaemonId);
    }
    return undefined;
}

/**
 * Resolve the coordinator anchor id stamped into a worker dispatch's meshContext
 * (`coordinatorDaemonId`), which the remote router turns into the worker
 * session's `meshCoordinatorDaemonId` relay anchor (router.ts buildMeshWorkerRelayStamp).
 * Without a non-empty value the forwarder gate treats the worker as relay-unsafe
 * and the completion event sits in the pending queue until a later read_chat
 * forces a reconcile.
 *
 * Order: the coordinator mesh node's daemonId → the IPC daemon instanceId
 * (ctx.localDaemonId) → the local machine registry id (ctx.localMachineId). The
 * final fallback mirrors the queue-assignment dispatch path, which stamps
 * `loadConfig().machineId` (== ctx.localMachineId; see server.ts) — so the
 * direct-dispatch path now resolves an anchor whenever the queue path would.
 */
export function resolveCoordinatorDaemonId(ctx: MeshContext): string | undefined {
    return readString(resolveCoordinatorNode(ctx)?.daemonId)
        || readString(ctx.localDaemonId)
        || readString(ctx.localMachineId);
}

export function readNodeMachineId(node: LocalMeshNodeEntry): string | undefined {
    return readString((node as any).machineId)
        || readString((node as any).machine_id)
        || readString((node as any).machine?.id)
        || readString((node as any).machine?.machineId)
        || readString((node as any).lastProbe?.machineId)
        || readString((node as any).last_probe?.machine_id)
        || readString((node as any).lastProbe?.machine?.id)
        || readString((node as any).lastProbe?.machine?.machineId)
        || readString((node as any).last_probe?.machine?.id)
        || readString((node as any).last_probe?.machine?.machine_id);
}

export function readNodeDaemonId(node: LocalMeshNodeEntry): string | undefined {
    return readString(node.daemonId)
        || readString((node as any).daemon_id)
        || readString((node as any).machine?.daemonId)
        || readString((node as any).machine?.daemon_id)
        || readString((node as any).lastProbe?.daemonId)
        || readString((node as any).last_probe?.daemon_id)
        || readString((node as any).lastProbe?.machine?.daemonId)
        || readString((node as any).lastProbe?.machine?.daemon_id)
        || readString((node as any).last_probe?.machine?.daemonId)
        || readString((node as any).last_probe?.machine?.daemon_id);
}

function normalizeHostname(value: unknown): string | undefined {
    const hostname = readString(value);
    if (!hostname) return undefined;
    return hostname.toLowerCase().replace(/\.$/, '');
}

function readNodeHostname(node: LocalMeshNodeEntry): string | undefined {
    return readString((node as any).hostname)
        || readString((node as any).host)
        || readString((node as any).machineHostname)
        || readString((node as any).machine_hostname)
        || readString((node as any).machine?.hostname)
        || readString((node as any).machine?.host)
        || readString((node as any).lastProbe?.hostname)
        || readString((node as any).last_probe?.hostname)
        || readString((node as any).lastProbe?.machine?.hostname)
        || readString((node as any).last_probe?.machine?.hostname);
}

function readNodeDisplayMachineName(node: LocalMeshNodeEntry): string | undefined {
    return readString((node as any).machineName)
        || readString((node as any).machine_name)
        || readString((node as any).machineLabel)
        || readString((node as any).machine_label)
        || readString((node as any).machineNickname)
        || readString((node as any).machine_nickname)
        || readString((node as any).alias)
        || readString((node as any).machine?.name)
        || readString((node as any).machine?.displayName)
        || readString((node as any).machine?.display_name)
        || readString((node as any).lastProbe?.machineName)
        || readString((node as any).last_probe?.machine_name)
        || readString((node as any).lastProbe?.machine?.name)
        || readString((node as any).last_probe?.machine?.name)
        || readNodeHostname(node);
}

function compactIdentityEvidence(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function pushIdentityEvidence(evidence: string[], label: string, value: string | undefined): void {
    const compact = compactIdentityEvidence(value);
    if (compact) evidence.push(`${label}:${compact}`);
}

export function buildNodeMachineIdentity(ctx: MeshContext, node: LocalMeshNodeEntry): Record<string, unknown> {
    const machineId = readNodeMachineId(node);
    const daemonId = readNodeDaemonId(node);
    const hostname = readNodeHostname(node);
    const machineName = readNodeDisplayMachineName(node);
    const coordinatorHostname = readString(ctx.coordinatorHostname);
    const localControlPlaneReason = getLocalControlPlaneMatchReason(ctx, node);
    const directLocal = !!localControlPlaneReason;
    const hostnameMatches = Boolean(
        normalizeHostname(hostname)
        && normalizeHostname(coordinatorHostname)
        && normalizeHostname(hostname) === normalizeHostname(coordinatorHostname),
    );
    const sameMachine = directLocal || hostnameMatches;
    const evidence: string[] = [];
    pushIdentityEvidence(evidence, 'machineName', machineName);
    pushIdentityEvidence(evidence, 'hostname', hostname);
    pushIdentityEvidence(evidence, 'machineId', machineId);
    pushIdentityEvidence(evidence, 'daemonId', daemonId);
    if (localControlPlaneReason) {
        pushIdentityEvidence(evidence, 'localMatch', localControlPlaneReason);
        pushIdentityEvidence(evidence, 'localMachineId', ctx.localMachineId);
        pushIdentityEvidence(evidence, 'localDaemonId', ctx.localDaemonId);
    }
    const locality = sameMachine ? 'same_machine' : (evidence.length > 0 ? 'remote_known' : 'remote_or_unknown');
    const localityReason = sameMachine
        ? (localControlPlaneReason || 'matched coordinator hostname')
        : evidence.length > 0
            ? `known remote/other machine identity; no local coordinator match (${evidence.join(', ')})`
            : 'no useful machine identity evidence available';
    return {
        daemonId,
        machineId,
        hostname,
        machineName,
        displayName: machineName || hostname || daemonId || machineId,
        coordinatorHostname,
        sameMachine,
        locality,
        localityReason,
        identityEvidence: evidence,
    };
}

function nodeHasLocalDaemonEvidence(ctx: MeshContext, node: any): boolean {
    const isLocal = (session: any) => {
        if (!session || typeof session !== 'object') return false;
        // meshCoordinatorDaemonId identifies where a worker should relay completion events.
        // Remote workers also point this at the local coordinator, so it is not locality evidence.
        // Likewise launchedByCoordinator only proves the coordinator created the session, not
        // that the session is running on this daemon.
        if (ctx.localDaemonId && session.runtime?.owner === ctx.localDaemonId) return true;
        if (ctx.localDaemonId && session.daemonClient?.daemonId === ctx.localDaemonId) return true;
        return false;
    };

    const sessionArrays = [
        node?.sessions,
        node?.activeSessions,
        node?.active_sessions,
        node?.lastProbe?.sessions,
        node?.last_probe?.sessions,
        node?.lastProbe?.status?.sessions,
        node?.last_probe?.status?.sessions,
    ];
    for (const arr of sessionArrays) {
        if (Array.isArray(arr) && arr.some(isLocal)) return true;
    }

    const sessionRecords = [
        node?.activeSession,
        node?.active_session,
        node?.currentSession,
        node?.current_session,
        node?.runtimeSession,
        node?.runtime_session,
        node?.session,
        node?.lastProbe?.activeSession,
        node?.last_probe?.active_session,
        node?.lastProbe?.currentSession,
        node?.last_probe?.current_session,
        node?.lastProbe?.session,
        node?.last_probe?.session,
    ];
    for (const session of sessionRecords) {
        if (isLocal(session)) return true;
    }
    
    return false;
}

function isDirectLocalNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    const machineId = readNodeMachineId(node);
    const daemonId = readNodeDaemonId(node);
    // id-form robust: a node's daemon/machine id may be stored in a DIFFERENT form
    // (bare `mach_X` vs `daemon_mach_X` vs `standalone_mach_X`) than the coordinator's
    // resolved ctx ids. A strict `===` misclassified the coordinator's own node as
    // REMOTE, so the enqueue fan-out dispatched the task body to this very daemon — where
    // it fuzzy-injected into the coordinator's own CLI session (TASKECHO). daemonIdsEquivalent
    // canonicalizes both sides to the machine core before comparing.
    return Boolean(
        (ctx.localMachineId && daemonIdsEquivalent(machineId, ctx.localMachineId))
        || (ctx.localDaemonId && daemonIdsEquivalent(daemonId, ctx.localDaemonId))
        || nodeHasLocalDaemonEvidence(ctx, node)
    );
}

function isConfiguredCoordinatorNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    if (!ctx.localMachineId && !ctx.localDaemonId) return false;
    const nodeId = readString(node.id) || readString((node as any).nodeId) || readString((node as any).node_id);
    if (!nodeId) return false;
    // If the node carries explicit daemon/machine identity that doesn't match the
    // coordinator, it is definitively a remote node — skip the positional fallback.
    // Compare under canonical id form (daemonIdsEquivalent), NOT a raw `!==`: a local
    // coordinator node stored in a different daemon-id form (bare vs `daemon_`/`standalone_`)
    // would otherwise be wrongly excluded here and treated as remote.
    const nodeDaemonId = readNodeDaemonId(node);
    const nodeMachineId = readNodeMachineId(node);
    if (nodeDaemonId && ctx.localDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.localDaemonId)) return false;
    if (nodeMachineId && ctx.localMachineId && !daemonIdsEquivalent(nodeMachineId, ctx.localMachineId)) return false;
    const preferredNodeId = readString(ctx.mesh.coordinator?.preferredNodeId)
        || readString((ctx.mesh.coordinator as any)?.preferred_node_id);
    if (preferredNodeId) return nodeId === preferredNodeId;
    const first = ctx.mesh.nodes?.[0] as any;
    const firstNodeId = readString(first?.id) || readString(first?.nodeId) || readString(first?.node_id);
    return !!firstNodeId && nodeId === firstNodeId;
}

function getLocalControlPlaneMatchReason(ctx: MeshContext, node: LocalMeshNodeEntry): string | undefined {
    if (isDirectLocalNode(ctx, node)) return 'matched coordinator daemon or machine id';
    if (isConfiguredCoordinatorNode(ctx, node)) return 'matched configured coordinator node';
    if (node.isLocalWorktree === true) {
        const sourceNode = findClonedFromNode(ctx, node);
        if (sourceNode && isDirectLocalNode(ctx, sourceNode)) return 'matched local cloned-from node';
        if (sourceNode && isConfiguredCoordinatorNode(ctx, sourceNode)) return 'matched configured coordinator source node';
    }
    return undefined;
}

function findClonedFromNode(ctx: MeshContext, node: LocalMeshNodeEntry): LocalMeshNodeEntry | undefined {
    const clonedFromNodeId = readString(node.clonedFromNodeId) || readString((node as any).cloned_from_node_id);
    if (!clonedFromNodeId) return undefined;
    return ctx.mesh.nodes.find(n => meshNodeIdMatches(n, clonedFromNodeId));
}

/**
 * Resolve the node id a `prefer_worktree` enqueue should target.
 *
 * Worktree clones (mesh_clone_node) are appended to `ctx.mesh.nodes`, so the
 * LAST worktree node in array order is the most recently created one — the one
 * the coordinator most likely just spun up for isolated work. Without an
 * explicit target, an unconstrained queue task is claimed by whichever node
 * polls first (typically the base/main workspace), defeating the isolation
 * intent. Returning a concrete node id lets enqueueTask stamp targetNodeId so
 * the existing node-targeted claim tier routes the task to the worktree.
 *
 * Returns undefined when no worktree node exists (the caller treats this as a
 * no-op and falls back to normal unconstrained queueing).
 */
export function resolvePreferredWorktreeNodeId(ctx: MeshContext): string | undefined {
    const worktreeNodes = (ctx.mesh.nodes || []).filter(n => (n as any).isLocalWorktree === true);
    if (worktreeNodes.length === 0) return undefined;
    const chosen = worktreeNodes[worktreeNodes.length - 1] as any;
    return readString(chosen?.id) || readString(chosen?.nodeId) || readString(chosen?.node_id);
}

export function isLocalControlPlaneNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    return !!getLocalControlPlaneMatchReason(ctx, node);
}
