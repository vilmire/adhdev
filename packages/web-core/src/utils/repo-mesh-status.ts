import type { RepoMeshStatus } from '@adhdev/daemon-core'

export function extractRepoMeshStatus(response: any): RepoMeshStatus | null {
    const body = response?.result ?? response
    const candidates = [response?.status, body?.status, body, response]
    for (const candidate of candidates) {
        if (candidate && Array.isArray(candidate.nodes) && typeof candidate.meshId === 'string') {
            return candidate as RepoMeshStatus
        }
    }
    return null
}
