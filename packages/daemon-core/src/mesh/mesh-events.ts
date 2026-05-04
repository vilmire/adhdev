import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getMeshByRepo } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';

export function setupMeshEventForwarding(components: DaemonComponents) {
    components.instanceManager.onEvent((event) => {
        // We only care about agent sub-session completion or waiting approval
        if (event.event !== 'agent:generating_completed' && event.event !== 'agent:waiting_approval') return;
        
        const instanceId = event.instanceId as string;
        if (!instanceId) return;

        // Try to find the workspace of the sub-agent
        const sourceInstance = components.instanceManager.getInstance(instanceId);
        if (!sourceInstance || sourceInstance.category !== 'cli') return;
        const state = sourceInstance.getState();
        const workspace = state.workspace;
        if (!workspace) return;

        // Find the mesh that this workspace belongs to
        const mesh = getMeshByRepo(workspace);
        if (!mesh) return;

        // Find the coordinator session(s)
        const allInstances = components.instanceManager.getByCategory('cli');
        const coordinatorInstances = allInstances.filter((inst) => {
            const instState = inst.getState();
            
            // The coordinator session was launched with meshCoordinatorFor setting
            if (instState.settings?.meshCoordinatorFor !== mesh.id) return false;
            
            // Exclude the source instance itself (just in case)
            if (instState.instanceId === instanceId) return false;
            
            return true;
        });

        if (coordinatorInstances.length === 0) return;

        // Determine node label
        const targetNode = mesh.nodes.find((n) => n.workspace === workspace);
        const nodeLabel = targetNode ? `Node '${targetNode.id}'` : `Agent at ${workspace}`;

        // Construct a system message in English
        let messageText = '';
        if (event.event === 'agent:generating_completed') {
            messageText = `[System] ${nodeLabel} has completed its task and is now idle. You may use mesh_read_chat to review its progress.`;
        } else if (event.event === 'agent:waiting_approval') {
            messageText = `[System] ${nodeLabel} is waiting for approval to proceed. You may use mesh_read_chat and mesh_approve to handle it.`;
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
