/**
 * Mesh page deep link: `/mesh?mesh=<meshId>[&tab=overview|tasks|artifacts|map][&task=<id>][&mission=<id>]`.
 * Written by chat id links (a mission / task id in a chat bubble), consumed once by the
 * /mesh page, which selects the mesh, opens its observability dialog on that tab and
 * focuses the task. Pure helpers — no router, no React.
 */
export type MeshDeepLinkTab = 'overview' | 'tasks' | 'artifacts' | 'map'

export interface MeshDeepLink {
    meshId: string
    tab?: MeshDeepLinkTab
    taskId?: string
    missionId?: string
}

const TABS: ReadonlySet<string> = new Set(['overview', 'tasks', 'artifacts', 'map'])

export function buildMeshDeepLink(link: MeshDeepLink): string {
    const p = new URLSearchParams({ mesh: link.meshId })
    if (link.tab) p.set('tab', link.tab)
    if (link.taskId) p.set('task', link.taskId)
    if (link.missionId) p.set('mission', link.missionId)
    return `/mesh?${p.toString()}`
}

export function parseMeshDeepLink(search: string): MeshDeepLink | null {
    const p = new URLSearchParams(search)
    const meshId = (p.get('mesh') ?? '').trim()
    if (!meshId) return null
    const tab = (p.get('tab') ?? '').trim()
    const taskId = (p.get('task') ?? '').trim()
    const missionId = (p.get('mission') ?? '').trim()
    return {
        meshId,
        ...(TABS.has(tab) ? { tab: tab as MeshDeepLinkTab } : {}),
        ...(taskId ? { taskId } : {}),
        ...(missionId ? { missionId } : {}),
    }
}
