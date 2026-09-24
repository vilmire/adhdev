import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-forward-bootstrap-stamp-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
  getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { meshEventsHandlers } from '../../src/commands/high-family/mesh-events.js'
import { handleMeshForwardEvent } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import { LOG } from '../../src/logging/logger.js'
import { DaemonComponentsNotReadyError } from '../../src/commands/daemon-components-port.js'
import { testTurnLedger } from '../mesh/helpers/mesh-turn-ledger-fixture.js'

const NODE_ID = 'node_wt_remote'

/**
 * The handler now passes the REAL components (`ctx.components()`, attached by
 * boot S7) to handleMeshForwardEvent instead of a hand-built
 * `{ instanceManager, router: {...} }` shim. This fixture's components carry
 * the router surface the stamp + re-fire read and a turn ledger, like
 * production. `ready: false` models the boot window (accessor throws).
 */
function createMinimalContext(stamp = vi.fn(), getCachedInlineMesh: (...args: any[]) => any = vi.fn(() => undefined), opts: { ready?: boolean } = {}) {
  const components = {
    instanceManager: {
      getInstance: vi.fn(() => undefined),
      getByCategory: vi.fn(() => []),
    },
    router: { markWorktreeBootstrapTerminalState: stamp, getCachedInlineMesh },
    turnLedger: testTurnLedger(),
  } as any
  return {
    deps: { instanceManager: components.instanceManager },
    components: () => {
      if (opts.ready === false) throw new DaemonComponentsNotReadyError('high-family command')
      return components
    },
    getMeshForCommand: vi.fn(async () => ({ mesh: null, inlineMesh: null })),
    getCachedAggregateMeshStatus: vi.fn(() => null),
    rememberAggregateMeshStatus: vi.fn(),
    execute: vi.fn(async () => ({ success: true })),
    markWorktreeBootstrapTerminalState: stamp,
    getCachedInlineMesh,
    aggregateMeshStatusCache: new Map(),
    swrRefreshInFlight: new Set(),
    runningRefineJobs: new Map(),
    inlineMeshCache: new Map(),
    meshGitProbeCache: new Map(),
  } as any
}

/** Lets a `setImmediate(...)`-scheduled callback (injectMeshSystemMessage's queue
 *  re-fire) run and settle before assertions inspect its side effects. */
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function createStampArgs(meshId: string) {
  return {
    event: 'worktree_bootstrap_complete',
    meshId,
    nodeId: NODE_ID,
    workspace: `/repo/${NODE_ID}`,
    timestamp: Date.now(),
  }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('MESH-FORWARD-EVENT-BOOTSTRAP-STAMP — remote daemon lacks the coordinator-only router object', () => {
  beforeEach(() => {
    __resetMeshRuntimeStoreForTests()
  })
  afterEach(() => { vi.clearAllMocks() })

  // C-W3: the historical red case (a stampless shim THREW) no longer
  // reproduces — the notice path isolates the stamp. The failure is reported
  // on the result and logged, and the gate-stuck symptom is covered by the
  // green cases below (the handler binds the stamp).
  it('a handler without a router stamp reports the stamp failure instead of throwing', async () => {
    const meshId = `mesh_red_${randomUUID().slice(0, 8)}`
    try {
      const components = { instanceManager: { getInstance: vi.fn(() => undefined) } } as any
      const result = handleMeshForwardEvent(components, createStampArgs(meshId))
      expect(result.error).toMatch(/markWorktreeBootstrapTerminalState/)
    } finally {
      cleanup(meshId)
    }
  })

  it('green fix: mesh_forward_event handler supplies the bound stamp so worktree_bootstrap_complete records complete', async () => {
    const meshId = `mesh_green_${randomUUID().slice(0, 8)}`
    try {
      const stamp = vi.fn()
      const ctx = createMinimalContext(stamp)
      const handler = meshEventsHandlers.mesh_forward_event

      const result = await handler(ctx, createStampArgs(meshId))

      expect(result).toMatchObject({ success: true })
      expect(stamp).toHaveBeenCalledWith(
        meshId,
        NODE_ID,
        'complete',
        expect.objectContaining({ workspace: `/repo/${NODE_ID}` }),
      )
    } finally {
      cleanup(meshId)
    }
  })

  it('green fix: worktree_bootstrap_failed is stamped as failed, not dropped silently', async () => {
    const meshId = `mesh_failed_${randomUUID().slice(0, 8)}`
    try {
      const stamp = vi.fn()
      const ctx = createMinimalContext(stamp)
      const args = createStampArgs(meshId)
      args.event = 'worktree_bootstrap_failed'

      const result = await meshEventsHandlers.mesh_forward_event(ctx, args)

      expect(result).toMatchObject({ success: true })
      expect(stamp).toHaveBeenCalledWith(
        meshId,
        NODE_ID,
        'failed',
        expect.objectContaining({ workspace: `/repo/${NODE_ID}` }),
      )
    } finally {
      cleanup(meshId)
    }
  })
})

/**
 * MESH-FORWARD-EVENT-REFIRE-SHIM
 *
 * Same remaining gap as MESH-CRUD-BOOTSTRAP-REFIRE-SHIM, on the other
 * handleMeshForwardEvent caller: a successful stamp above schedules
 * `setImmediate(() => triggerMeshQueue(components, meshId))` reusing this SAME
 * `{ instanceManager, router: {...} }` shim as `components`. triggerMeshQueue's
 * first line calls `components.router.getCachedInlineMesh(meshId)`
 * unconditionally, so HighFamilyContext (and this handler's shim) needed
 * getCachedInlineMesh bound too — it previously wasn't even part of the type.
 */
describe('MESH-FORWARD-EVENT-REFIRE-SHIM — mesh_forward_event queue re-fire lacked getCachedInlineMesh on the router shim', () => {
  beforeEach(() => {
    __resetMeshRuntimeStoreForTests()
  })
  afterEach(() => { vi.clearAllMocks() })

  // The shim class is structurally gone: the handler no longer builds a
  // components look-alike. Inside the boot window it answers not-ready instead.
  it('boot window: components not attached → daemon_components_not_ready, nothing stamped', async () => {
    const meshId = `mesh_forward_not_ready_${randomUUID().slice(0, 8)}`
    try {
      const stamp = vi.fn()
      const ctx = createMinimalContext(stamp, vi.fn(() => undefined), { ready: false })

      const result = await meshEventsHandlers.mesh_forward_event(ctx, createStampArgs(meshId))

      expect(result).toMatchObject({ success: false, code: 'daemon_components_not_ready' })
      expect(stamp).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('green fix: with ctx.getCachedInlineMesh bound, the queue re-fire completes without a WARN', async () => {
    const meshId = `mesh_forward_refire_green_${randomUUID().slice(0, 8)}`
    const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => {})
    try {
      const ctx = createMinimalContext(vi.fn(), vi.fn(() => undefined))

      const result = await meshEventsHandlers.mesh_forward_event(ctx, createStampArgs(meshId))
      expect(result).toMatchObject({ success: true })

      await flushSetImmediate()
      await flushSetImmediate()

      const reFireFailures = warnSpy.mock.calls.filter(([category, msg]) =>
        category === 'MeshQueue' && typeof msg === 'string' && msg.includes('Queue re-fire after'))
      expect(reFireFailures).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      cleanup(meshId)
    }
  })
})
