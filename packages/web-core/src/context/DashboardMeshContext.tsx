/**
 * DashboardMeshContext
 *
 * Optional context for overriding mesh listing / launch in the Dashboard.
 *
 * Standalone (OSS): no provider → Dashboard falls back to local daemon
 * `list_meshes` commands.
 *
 * Cloud: provides overrides that call the cloud REST API for
 * server-persisted meshes visible across all connected machines.
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { MeshLaunchOption } from '../hooks/useDashboardCommandActions'

export interface DashboardMeshOverrides {
    /**
     * List meshes available in the + session dialog.
     * Cloud: calls REST API for cloud-persisted meshes.
     * The machineId is provided for context (e.g. which machine will run
     * the coordinator), but cloud meshes are not per-machine.
     */
    listMeshes: (machineId: string) => Promise<MeshLaunchOption[]>

    /**
     * Launch a mesh coordinator session.
     * Cloud: may differ from standalone in how it routes the command.
     */
    launchMeshCoordinator?: (
        machineId: string,
        meshId: string,
        cliType: string,
    ) => Promise<{ ok: boolean; error?: string }>
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
