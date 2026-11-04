import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Right after a daemon boot an idle session can reach the queue claim before its mesh is
// resolvable (neither local config nor the router inline cache knows it yet). The claim
// options used to read `mesh.repoIdentity` unguarded and threw
// "Cannot read properties of undefined (reading 'repoIdentity')", which the idle-claim
// edge logged as "Failed to assign idle queue task". An unresolved mesh must degrade to an
// attributable refusal (empty repoIdentity -> ownership unproven), never a TypeError.

const testTmpDir = path.join(tmpdir(), `adhdev-unresolved-mesh-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
const MACHINE_ID = 'mach_1111111111111111111111111111aaaa'

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: MACHINE_ID } as any),
  getMachineId: () => MACHINE_ID,
  getMachineNickname: () => null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(() => undefined as any),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'
import { wipeTurnTablesForTests } from './helpers/mesh-turn-ledger-fixture.js'

const NODE_ID = 'node_unresolved_mesh0000000000000000000'

describe('queue claim with an unresolved mesh', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('does not throw reading repoIdentity and leaves the task pending', () => {
    const meshId = `mesh_unresolved_${randomUUID().slice(0, 8)}`
    try {
      const state = { settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, providerType: 'claude-cli' }, status: 'idle', instanceId: 's1', type: 'claude-cli' }
      const instance = { getState: () => state, updateSettings: vi.fn() }
      const components = withMeshRouter({
        instanceManager: { getInstance: vi.fn(() => instance), getByCategory: vi.fn(() => [instance]), attachMeshAssignmentToInstance: vi.fn(() => ({ stamped: true })) },
        cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
        providerLoader: { resolveAlias: vi.fn((t: string) => t), isMachineProviderEnabled: vi.fn(() => true), getMeta: vi.fn(() => undefined), setCliDetectionResults: vi.fn() },
        statusInstanceId: 'daemon-local',
        onStatusChange: vi.fn(),
      } as any)
      const task = enqueueTask(meshId, 'UNRESOLVED-MESH', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      let claimed: boolean | undefined
      expect(() => { claimed = tryAssignQueueTask(components, meshId, NODE_ID, 's1', 'claude-cli') }).not.toThrow()
      expect(claimed).toBe(false)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      __clearMeshQueueForTests(meshId)
      wipeTurnTablesForTests()
      __resetMeshRuntimeStoreForTests()
      try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})
