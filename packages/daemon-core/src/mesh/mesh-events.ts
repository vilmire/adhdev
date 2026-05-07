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

        // Find the coordinator session(s)
        const allInstances = components.instanceManager.getByCategory('cli');
        const coordinatorInstances = allInstances.filter((inst) => {
            const instState = inst.getState();

            // The coordinator session was launched with meshCoordinatorFor setting
            if (instState.settings?.meshCoordinatorFor !== meshId) return false;

            // Exclude the source instance itself (just in case)
            if (instState.instanceId === instanceId) return false;

            return true;
        });

        if (coordinatorInstances.length === 0) return;

        // Determine node label. Inline/cloud meshes may be unavailable here, so preserve runtime node id.
        const targetNode = mesh?.nodes?.find((n: any) => n.workspace === workspace);
        const runtimeNodeId = readNonEmptyString(settings.meshNodeId);
        const nodeLabel = targetNode
            ? `Node '${targetNode.id}'`
            : runtimeNodeId
                ? `Node '${runtimeNodeId}'`
                : `Agent at ${workspace}`;
        const metadata = formatCompletionMetadata(event);

        // Construct a system message in English
        let messageText = '';
        if (event.event === 'agent:generating_completed') {
            messageText = `[System] ${nodeLabel} has completed its task and is now idle${metadata}. You may use mesh_read_chat to review its progress.`;
        } else if (event.event === 'agent:waiting_approval') {
            messageText = `[System] ${nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
        }

        if (!messageText) return;

        // Inject the message into the coordinator sessions
        for (const coord of coordinatorInstances) {
            const coordState = coord.getState();
            LOG.info('MeshEvents', `Forwarding event from ${workspace} to coordinator ${coordState.instanceId}`);
            coord.onEvent('send_message', { input: { text: messageText, textFallback: messageText } });
        }
    });
}
