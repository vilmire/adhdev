import { describe, expect, it } from 'vitest'
import { extractRepoMeshStatus } from '../../src/utils/repo-mesh-status'

describe('extractRepoMeshStatus', () => {
  const status = {
    meshId: 'mesh_1',
    meshName: 'ADHDev',
    repoIdentity: 'github.com/vilmire/adhdev',
    defaultBranch: 'main',
    refreshedAt: '2026-01-01T00:00:00Z',
    nodes: [],
    queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
    ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
  }

  it('accepts raw standalone mesh_status payloads', () => {
    expect(extractRepoMeshStatus(status as any)).toEqual(status)
  })

  it('accepts wrapped transport payloads', () => {
    expect(extractRepoMeshStatus({ success: true, result: status } as any)).toEqual(status)
    expect(extractRepoMeshStatus({ success: true, result: { status } } as any)).toEqual(status)
  })

  it('returns null for unrelated payloads', () => {
    expect(extractRepoMeshStatus({ success: true, result: { ok: true } } as any)).toBeNull()
  })
})
