import type { RepoMeshStatus } from '@adhdev/daemon-core'

type RefreshableMeshNode = Pick<RepoMeshStatus['nodes'][number], 'git' | 'gitProbePending' | 'machineStatus' | 'launchReady' | 'connection'>

const DASHBOARD_PENDING_MESH_REFRESH_DELAYS_MS = [1500, 3000, 5000, 8000, 12000] as const

function hasLivePeerGitTruth(node: RefreshableMeshNode): boolean {
    return Boolean(
        node.git?.isGitRepo === true
        || node.git?.branch
        || node.git?.upstream
        || node.git?.headCommit
        || node.git?.workspace
        || node.git?.repoRoot,
    )
}

export function hasPendingDashboardMeshRefresh(nodes?: RefreshableMeshNode[] | null): boolean {
    if (!Array.isArray(nodes) || nodes.length === 0) return false
    return nodes.some(node => {
        if (hasLivePeerGitTruth(node)) return false
        if (node.gitProbePending) return true
        if (node.connection?.state === 'connecting') return true
        return node.machineStatus === 'online' || node.launchReady === true
    })
}

export function nextDashboardMeshRefreshDelayMs(attempt: number): number | null {
    if (!Number.isInteger(attempt) || attempt < 0) return DASHBOARD_PENDING_MESH_REFRESH_DELAYS_MS[0] ?? null
    return DASHBOARD_PENDING_MESH_REFRESH_DELAYS_MS[attempt] ?? null
}
