import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// LIGHT-TASK: a lingering light worker session (settings.lightWorkspaceId) can never claim another
// row (light-claim-rule.ts), so it must not count as "the node's worker" for auto-launch gating,
// the concurrency cap or the orphan sweep — otherwise a normal task sits pending forever.

const testTmpDir = path.join(tmpdir(), `adhdev-light-not-worker-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => [] as any[]),
}))

import { isLightWorkerSession } from '@adhdev/mesh-shared'
import { liveSessionCountForNode, nodeHasLiveSessionPendingClaim } from '../../src/mesh/mesh-candidacy-predicates.js'

const MESH = 'mesh_light_not_worker'
const NODE = 'node_main'

function inst(sessionId: string, extra: Record<string, unknown> = {}) {
  const settings = { meshNodeFor: MESH, meshNodeId: NODE, ...extra }
  const state = { instanceId: sessionId, status: 'idle', type: 'codex-cli', workspace: '/repo', activeChat: null, settings }
  return { category: 'cli', settings, getState: () => state }
}
const comps = (instances: any[]) => ({ instanceManager: { getByCategory: (c: string) => (c === 'cli' ? instances : []) } }) as any

describe('light worker sessions are never the node worker', () => {
  it('isLightWorkerSession reads settings.lightWorkspaceId from a state, a record or bare settings', () => {
    expect(isLightWorkerSession({ settings: { lightWorkspaceId: 'lw_1' } })).toBe(true)
    expect(isLightWorkerSession({ launchRecord: { settings: { lightWorkspaceId: 'lw_1' } } })).toBe(true)
    expect(isLightWorkerSession({ lightWorkspaceId: 'lw_1' })).toBe(true)
    expect(isLightWorkerSession({ settings: { meshNodeFor: MESH } })).toBe(false)
    expect(isLightWorkerSession({ settings: { lightWorkspaceId: ' ' } })).toBe(false)
    expect(isLightWorkerSession(null)).toBe(false)
  })

  it('auto-launch pending-claim gate does not treat an idle light session as a claimer', () => {
    const light = inst('sess_light', { lightWorkspaceId: 'lw_1' })
    expect(nodeHasLiveSessionPendingClaim(comps([light]), MESH, NODE, { id: 't1' } as any, {})).toBe(false)
    // control: the same idle session without the light marker does suppress the launch
    expect(nodeHasLiveSessionPendingClaim(comps([inst('sess_normal')]), MESH, NODE, { id: 't1' } as any, {})).toBe(true)
  })

  it('the per-node concurrent-session count excludes light sessions', () => {
    expect(liveSessionCountForNode(comps([inst('sess_light', { lightWorkspaceId: 'lw_1' })]), MESH, NODE)).toBe(0)
    expect(liveSessionCountForNode(comps([inst('sess_light', { lightWorkspaceId: 'lw_1' }), inst('sess_normal')]), MESH, NODE)).toBe(1)
  })
})
