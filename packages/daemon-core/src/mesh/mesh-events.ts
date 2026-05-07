import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';

function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
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
        return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. You may use mesh_read_chat to review its progress.`;
    }
    if (args.event === 'agent:waiting_approval') {
        return `[System] ${args.nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
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

    if (coordinatorInstances.length === 0) return { success: true, forwarded: 0 };

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
    if (eventName !== 'agent:generating_completed' && eventName !== 'agent:waiting_approval') {
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
        // We only care about agent sub-session completion or waiting approval
        if (event.event !== 'agent:generating_completed' && event.event !== 'agent:waiting_approval') return;

        const instanceId = readNonEmptyString(event.instanceId);
        if (!instanceId) return;

        // Try to find the workspace and mesh metadata of the sub-agent.
        const sourceInstance = components.instanceManager.getInstance(instanceId);
        if (!sourceInstance || sourceInstance.category !== 'cli') return;
        const state = sourceInstance.getState();
        const workspace = readNonEmptyString(state.workspace);
        if (!workspace) return;
        const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};
        const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor);

        // Prefer runtime mesh metadata: delegated mesh-node agents can come from inline/cloud meshes
        // that are not present in local meshes.json. Fall back to persisted mesh lookup for legacy sessions.
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
