import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';

// ---------------------------------------------------------------------------
// MCP coordinator pending-event queue
// ---------------------------------------------------------------------------
// When a mesh event fires but no CLI coordinator session is registered (e.g.
// the coordinator is Claude Code running via MCP), we buffer the event here.
// The MCP server drains this queue on every mesh_status / mesh_send_task poll.
// ---------------------------------------------------------------------------

export interface PendingMeshCoordinatorEvent {
    event: string;
    meshId: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    queuedAt: number;
}

const MAX_PENDING_EVENTS = 50;
const pendingMeshCoordinatorEvents: PendingMeshCoordinatorEvent[] = [];

/** Drain and return all pending coordinator events, clearing the queue. */
export function drainPendingMeshCoordinatorEvents(): PendingMeshCoordinatorEvent[] {
    return pendingMeshCoordinatorEvents.splice(0);
}

function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

const MESH_COORDINATOR_EVENTS = new Set([
    'agent:generating_completed',
    'agent:waiting_approval',
    'agent:stopped',
    'monitor:long_generating',
]);

function isMeshCoordinatorEvent(eventName: unknown): eventName is string {
    return typeof eventName === 'string' && MESH_COORDINATOR_EVENTS.has(eventName);
}

function formatCompletionMetadata(event: Record<string, unknown>): string {
    const parts = [
        readNonEmptyString(event.targetSessionId) ? `session_id=${readNonEmptyString(event.targetSessionId)}` : '',
        readNonEmptyString(event.providerType) ? `provider=${readNonEmptyString(event.providerType)}` : '',
        readNonEmptyString(event.providerSessionId) ? `provider_session_id=${readNonEmptyString(event.providerSessionId)}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function buildMeshSystemMessage(args: {
    event: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
}): string {
    const metadata = formatCompletionMetadata(args.metadataEvent);
    if (args.event === 'agent:generating_completed') {
        return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. This completion came from the agent status event path; use mesh_read_chat once to review its final progress, but do not poll repeatedly.`;
    }
    if (args.event === 'agent:waiting_approval') {
        return `[System] ${args.nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
    }
    if (args.event === 'agent:stopped') {
        return `[System] ${args.nodeLabel} has stopped${metadata}. Use mesh_read_chat once if you need to inspect its last output.`;
    }
    if (args.event === 'monitor:long_generating') {
        return `[System] ${args.nodeLabel} has been generating for a long time${metadata}. Use mesh_read_chat once for a status check, but do not poll repeatedly.`;
    }
    return '';
}

function injectMeshSystemMessage(components: DaemonComponents, args: {
    meshId: string;
    sourceInstanceId?: string;
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
}) {
    const coordinatorInstances = components.instanceManager.getByCategory('cli').filter((inst) => {
        const instState = inst.getState();
        if (instState.settings?.meshCoordinatorFor !== args.meshId) return false;
        if (args.sourceInstanceId && instState.instanceId === args.sourceInstanceId) return false;
        return true;
    });

    if (coordinatorInstances.length === 0) {
        // No CLI coordinator session found — buffer for MCP-based coordinators.
        if (pendingMeshCoordinatorEvents.length < MAX_PENDING_EVENTS) {
            pendingMeshCoordinatorEvents.push({
                event: args.event,
                meshId: args.meshId,
                nodeLabel: args.nodeLabel,
                metadataEvent: args.metadataEvent,
                queuedAt: Date.now(),
            });
            LOG.info('MeshEvents', `Queued ${args.event} for MCP coordinator (mesh ${args.meshId})`);
        }
        return { success: true, forwarded: 0 };
    }

    const messageText = buildMeshSystemMessage({
        event: args.event,
        nodeLabel: args.nodeLabel,
        metadataEvent: args.metadataEvent,
    });
    if (!messageText) return { success: false, error: 'unsupported mesh event' };

    for (const coord of coordinatorInstances) {
        const coordState = coord.getState();
        LOG.info('MeshEvents', `Forwarding mesh event to coordinator ${coordState.instanceId}`);
        coord.onEvent('send_message', { input: { text: messageText, textFallback: messageText } });
    }
    return { success: true, forwarded: coordinatorInstances.length };
}

export function handleMeshForwardEvent(components: DaemonComponents, payload: Record<string, unknown>) {
    const eventName = readNonEmptyString(payload.event);
    if (!isMeshCoordinatorEvent(eventName)) {
        return { success: false, error: 'unsupported mesh event' };
    }
    const meshId = readNonEmptyString(payload.meshId);
    if (!meshId) return { success: false, error: 'meshId required' };

    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);
    const nodeLabel = nodeId ? `Node '${nodeId}'` : workspace ? `Agent at ${workspace}` : 'Remote agent';
    return injectMeshSystemMessage(components, {
        meshId,
        nodeLabel,
        event: eventName,
        metadataEvent: {
            targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
            providerType: readNonEmptyString(payload.providerType),
            providerSessionId: readNonEmptyString(payload.providerSessionId),
        },
    });
}

export function setupMeshEventForwarding(components: DaemonComponents) {
    components.instanceManager.onEvent((event) => {
        // We only care about lightweight Repo Mesh coordinator control/status hints.
        if (!isMeshCoordinatorEvent(event.event)) return;

        const instanceId = readNonEmptyString(event.instanceId);
        if (!instanceId) return;

        // Try to find the workspace and mesh metadata of the sub-agent.
        const sourceInstance = components.instanceManager.getInstance(instanceId);
        if (!sourceInstance || sourceInstance.category !== 'cli') return;
        const state = sourceInstance.getState();
        const workspace = readNonEmptyString(state.workspace);
        if (!workspace) return;
        const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};

        // Coordinator sessions must never inject events into themselves.
        // A coordinator instance carries meshCoordinatorFor but not meshNodeFor/launchedByCoordinator.
        if (readNonEmptyString(settings.meshCoordinatorFor)) return;

        const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor);

        // Only forward events for sessions that were explicitly launched as mesh-node delegates
        // (meshNodeFor set by mesh_launch_session) or that carry the launchedByCoordinator flag.
        // Do NOT fall back to workspace-based mesh lookup: that would pick up coordinator sessions
        // and any other CLI session that happens to share the same workspace, causing spurious
        // system-message injection into the coordinator's own conversation.
        const isMeshDelegate = Boolean(meshIdFromRuntime || settings.launchedByCoordinator);
        if (!isMeshDelegate) return;

        const mesh = meshIdFromRuntime ? getMesh(meshIdFromRuntime) : getMeshByRepo(workspace);
        const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
        if (!meshId) return;

        // Determine node label. Inline/cloud meshes may be unavailable here, so preserve runtime node id.
        const targetNode = mesh?.nodes?.find((n: any) => n.workspace === workspace);
        const runtimeNodeId = readNonEmptyString(settings.meshNodeId);
        const nodeLabel = targetNode
            ? `Node '${targetNode.id}'`
            : runtimeNodeId
                ? `Node '${runtimeNodeId}'`
                : `Agent at ${workspace}`;

        injectMeshSystemMessage(components, {
            meshId,
            sourceInstanceId: instanceId,
            nodeLabel,
            event: event.event,
            metadataEvent: event,
        });
    });
}
