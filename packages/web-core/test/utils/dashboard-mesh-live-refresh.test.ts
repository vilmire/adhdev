import { describe, expect, it } from 'vitest'

import { hasPendingDashboardMeshRefresh, nextDashboardMeshRefreshDelayMs } from '../../src/utils/dashboard-mesh-live-refresh'

describe('dashboard mesh live refresh helpers', () => {
  it('keeps retrying launch-ready fallback nodes until git truth arrives', () => {
    expect(hasPendingDashboardMeshRefresh([
      {
        machineStatus: 'noMesh',
        launchReady: true,
        connection: { state: 'failed' } as any,
      } as any,
    ])).toBe(true)

    expect(hasPendingDashboardMeshRefresh([
      {
        machineStatus: 'online',
        gitProbePending: true,
        connection: { state: 'unknown' } as any,
      } as any,
    ])).toBe(true)
  })

  it('stops retrying once live git truth is present', () => {
    expect(hasPendingDashboardMeshRefresh([
      {
        machineStatus: 'noMesh',
        launchReady: true,
        git: {
          isGitRepo: true,
          workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          branch: 'main',
          upstream: 'origin/main',
          headCommit: '710e11de',
        },
        connection: { state: 'failed' } as any,
      } as any,
    ])).toBe(false)
  })

  it('uses a bounded dashboard follow-up refresh window that converges', () => {
    expect(nextDashboardMeshRefreshDelayMs(-1)).toBe(1500)
    expect(nextDashboardMeshRefreshDelayMs(0)).toBe(1500)
    expect(nextDashboardMeshRefreshDelayMs(1)).toBe(4000)
    expect(nextDashboardMeshRefreshDelayMs(2)).toBe(9000)
    // The loop must STOP re-arming after the bounded attempts so a perpetually
    // pending slow peer cannot storm the daemon with refresh probes forever.
    expect(nextDashboardMeshRefreshDelayMs(3)).toBeNull()
    expect(nextDashboardMeshRefreshDelayMs(4)).toBeNull()
  })
})
