/** Member-join payload construction, re-exported by the command router. */
import { meshNodeIdMatches } from '@adhdev/mesh-shared';

export function buildMemberJoinNode(mesh: any, args: any, fallbackDaemonId?: string): Record<string, unknown> | null {
    const requestedNodeId = typeof args?.memberNodeId === 'string' ? args.memberNodeId.trim() : '';
    const explicit = args?.memberNode && typeof args.memberNode === 'object' && !Array.isArray(args.memberNode)
        ? args.memberNode as Record<string, any>
        : null;
    const configured = Array.isArray(mesh?.nodes)
        ? (requestedNodeId
            ? mesh.nodes.find((node: any) => meshNodeIdMatches(node, requestedNodeId))
            : mesh.nodes[0])
        : null;
    const source = explicit || configured;
    const workspace = typeof source?.workspace === 'string' && source.workspace.trim()
        ? source.workspace.trim()
        : typeof args?.workspace === 'string' && args.workspace.trim()
            ? args.workspace.trim()
            : process.cwd();
    if (!workspace) return null;
    const nodeId = typeof source?.id === 'string' && source.id.trim()
        ? source.id.trim()
        : typeof source?.nodeId === 'string' && source.nodeId.trim()
            ? source.nodeId.trim()
            : undefined;
    const baseOverrides = source?.userOverrides && typeof source.userOverrides === 'object' && !Array.isArray(source.userOverrides)
        ? source.userOverrides as Record<string, unknown>
        : {};
    // This payload is built ON THE MEMBER DAEMON, so process.platform/process.arch
    // are the member's OWN machine. Stamp them into userOverrides so the host
    // stores the member's real platform/arch on the node record — the coordinator's
    // buildMeshNodeCapabilityTags then advertises os=<member-os> instead of the
    // coordinator's own platform. Only fill values the operator hasn't already set.
    const userOverrides: Record<string, unknown> = {
        ...baseOverrides,
        ...(typeof baseOverrides.platform === 'string' && baseOverrides.platform.trim() ? {} : { platform: process.platform }),
        ...(typeof baseOverrides.arch === 'string' && baseOverrides.arch.trim() ? {} : { arch: process.arch }),
    };
    return {
        ...(nodeId ? { id: nodeId } : {}),
        workspace,
        ...(typeof source?.repoRoot === 'string' && source.repoRoot.trim() ? { repoRoot: source.repoRoot.trim() } : {}),
        ...(typeof source?.daemonId === 'string' && source.daemonId.trim() ? { daemonId: source.daemonId.trim() } : fallbackDaemonId ? { daemonId: fallbackDaemonId } : {}),
        ...(typeof source?.machineId === 'string' && source.machineId.trim() ? { machineId: source.machineId.trim() } : {}),
        userOverrides,
        policy: source?.policy && typeof source.policy === 'object' && !Array.isArray(source.policy) ? source.policy : {},
        role: 'member',
    };
}
