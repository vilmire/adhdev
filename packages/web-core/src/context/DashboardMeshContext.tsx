/**
 * DashboardMeshContext
 *
 * Optional context for overriding mesh listing / launch in the Dashboard.
 *
 * Standalone (OSS): no provider → Dashboard falls back to local daemon
 * `list_meshes` commands.
 *
 * Cloud: provides overrides that route mesh setup/runtime through the selected
 * daemon instead of a server-persisted Repo Mesh control plane.
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { LaunchResult, MeshLaunchOption } from '../hooks/useDashboardCommandActions'

export interface DashboardMeshOverrides {
    /**
     * List meshes available in the + session dialog.
     * Cloud: calls the selected daemon for locally persisted meshes.
     * The machineId is provided for context (e.g. which machine will run
     * the coordinator), but cloud meshes are not per-machine.
     */
    listMeshes: (machineId: string) => Promise<MeshLaunchOption[]>

    /**
     * Load live mesh status for graph / observability surfaces.
     * Cloud: can refresh inline mesh snapshots from REST before probing a daemon.
     */
    loadMeshStatus?: (
        machineId: string,
        meshId: string,
        options?: { refresh?: boolean; retryProfile?: 'interactive' | 'settled' },
    ) => Promise<any>

    /**
     * Launch a mesh coordinator session.
     * Cloud: may differ from standalone in how it routes the command.
     */
    launchMeshCoordinator?: (
        machineId: string,
        meshId: string,
        cliType: string,
        opts?: { initialModel?: string | null; initialThinkingLevel?: string | null },
    ) => Promise<LaunchResult>
}

const DashboardMeshContext = createContext<DashboardMeshOverrides | null>(null)

export function useDashboardMeshOverrides(): DashboardMeshOverrides | null {
    return useContext(DashboardMeshContext)
}

export function DashboardMeshProvider({
    value,
    children,
}: {
    value: DashboardMeshOverrides
    children: ReactNode
}) {
    return (
        <DashboardMeshContext.Provider value={value}>
            {children}
        </DashboardMeshContext.Provider>
    )
}
