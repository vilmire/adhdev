import type { ActiveConversation } from '../../components/dashboard/types'

/**
 * Build a minimal synthetic ActiveConversation so the /mesh pages (list rows and
 * the settings page) can launch DashboardMeshGraphDialog without a real
 * coordinator conversation. The dialog only needs `daemonId` + a mesh id (read
 * from `coordinator.meshId` / `settings.meshCoordinatorFor`) to load
 * `mesh_status` and render the observability surface; the live-session overlay
 * (built from `sessionId`) is simply absent here, which the dialog handles.
 */
export function buildMeshGraphLaunchConversation(args: { meshId: string; daemonId: string; meshName: string }): ActiveConversation {
    return {
        routeId: `mesh-settings:${args.meshId}`,
        daemonId: args.daemonId,
        agentName: args.meshName,
        agentType: 'mesh',
        status: 'idle',
        title: args.meshName,
        messages: [],
        workspaceName: args.meshName,
        displayPrimary: args.meshName,
        displaySecondary: '',
        streamSource: 'native',
        tabKey: `mesh-settings:${args.meshId}`,
        coordinator: { meshId: args.meshId, role: 'coordinator' },
        settings: { meshCoordinatorFor: args.meshId },
    }
}
