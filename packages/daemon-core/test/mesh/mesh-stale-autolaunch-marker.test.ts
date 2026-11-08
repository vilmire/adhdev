import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// PINNED-REMOTE-IDLE (2026-10-06). mesh_send_task to a remote worker that was still
// "starting" queued the task pinned to that session. The worker went idle 0.3 s BEFORE
// the enqueue, and its agent:ready is processed on the WORKER's daemon, so the
// coordinator's remote-idle registry never held the session: the drain never offered
// it its pinned task, which waited out the 15-minute pin TTL and parked. The member's
// pushed runtime summary already told the coordinator the session was idle — the drain
// now offers a pinned task's remote addressee from that held runtime.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-pinned-idle-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'coord-machine' } as any),
  getMachineId: () => 'coord-machine',
  getMachineNickname: () => null,
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
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({ fastForwardMeshNode: vi.fn() }))

import { launchedSessionProvablyGone } from '../../src/mesh/mesh-pinned-remote-idle.js'
import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, requeueTask } from '../../src/mesh/mesh-work-queue.js'
import { MeshNodeGitStateStore } from '../../src/mesh/mesh-node-git-state.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}
const NODE = 'node_remote_mac'
const DAEMON = 'remote-daemon'

function build(sessions: any[] | null, meshId: string) {
  const store = new MeshNodeGitStateStore()
  if (sessions) store.recordRuntimeObservation({ meshId, nodeId: NODE, workspace: '/repo/remote', runtime: { sessions }, source: 'member_push', daemonId: DAEMON })
  const components = withMeshRouter({
    instanceManager: { getByCategory: vi.fn(() => []), getInstance: vi.fn(() => undefined) },
    router: { getCachedInlineMesh: () => undefined, meshNodeGitState: store },
  } as any)
  const mesh = { id: meshId, nodes: [{ id: NODE, workspace: '/repo/remote', health: 'online', daemonId: DAEMON }] }
  return { components, mesh }
}

describe('STALE-AUTOLAUNCH-MARKER', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('a launched remote session absent from a post-launch pushed runtime is provably gone', () => {
    const meshId = `mesh_stale_al_${randomUUID().slice(0, 8)}`
    try {
      const { components, mesh } = build([], meshId)
      expect(launchedSessionProvablyGone(components, meshId, mesh, { nodeId: NODE, sessionId: 'dead', launchedAtMs: Date.now() - 60_000 })).toBe(true)
    } finally { cleanup(meshId) }
  })

  it('is NOT gone while the session is still in the pushed runtime, or without runtime evidence', () => {
    const meshId = `mesh_stale_al_${randomUUID().slice(0, 8)}`
    try {
      const live = build([{ id: 'alive', providerType: 'codex-cli', status: 'idle' }], meshId)
      expect(launchedSessionProvablyGone(live.components, meshId, live.mesh, { nodeId: NODE, sessionId: 'alive', launchedAtMs: Date.now() - 60_000 })).toBe(false)
      const none = build(null, meshId)
      expect(launchedSessionProvablyGone(none.components, meshId, none.mesh, { nodeId: NODE, sessionId: 'dead', launchedAtMs: Date.now() - 60_000 })).toBe(false)
    } finally { cleanup(meshId) }
  })

  it('an explicit requeue clears the stale autoLaunch marker', async () => {
    const meshId = `mesh_stale_al_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'x', { targetNodeId: NODE, difficulty: 'easy', readonly: true })
      const store = (await import('../../src/mesh/mesh-runtime-store.js')).MeshRuntimeStore.getInstance()
      const row = store.findQueueEntryById(meshId, task.id)!
      row.autoLaunch = { status: 'completed', sessionId: 'dead', nodeId: NODE, updatedAt: new Date().toISOString() } as any
      row.status = 'assigned' as any
      store.updateQueueEntry(row)
      requeueTask(meshId, task.id, { force: true })
      expect(getQueue(meshId).find(t => t.id === task.id)!.autoLaunch).toBeUndefined()
    } finally { cleanup(meshId) }
  })
})
