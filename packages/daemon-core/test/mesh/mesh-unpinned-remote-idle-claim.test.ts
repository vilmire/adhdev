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

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshNodeGitStateStore } from '../../src/mesh/mesh-node-git-state.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'

const NODE = 'node_remote_mac'
const DAEMON = 'remote-daemon'
const SESSION = 'remote-session-idle'

function setup(opts: { targeted: boolean; age?: number }) {
  const meshId = `mesh_unpinned_remote_idle_${randomUUID().slice(0, 8)}`
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    nodes: [{ id: NODE, workspace: '/repo/remote', health: 'online', daemonId: DAEMON }],
    policy: { maxParallelTasks: 2 },
  })
  const store = new MeshNodeGitStateStore()
  const sessions = [{ id: SESSION, providerType: 'codex-cli', status: 'idle', settings: { meshNodeFor: meshId, meshNodeId: NODE } }]
  store.recordRuntimeObservation({ meshId, nodeId: NODE, workspace: '/repo/remote', runtime: { sessions }, source: 'member_push', daemonId: DAEMON })
  const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
  const components = withMeshRouter({
    instanceManager: { getByCategory: vi.fn(() => []), getInstance: vi.fn(() => undefined) },
    cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      getMeta: vi.fn(() => undefined),
    },
    router: { getCachedInlineMesh: () => undefined, meshNodeGitState: store },
    dispatchMeshCommand,
    onStatusChange: vi.fn(),
  } as any)
  const task = enqueueTask(meshId, 'requeued delta', {
    ...(opts.targeted ? { targetNodeId: NODE } : {}),
    difficulty: 'easy',
    readonly: true,
  })
  return { meshId, components, dispatchMeshCommand, task }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('UNPINNED-REMOTE-IDLE — a newly pending task reaches an already-idle remote session', () => {
  afterEach(() => { vi.clearAllMocks() })

  for (const targeted of [true, false]) {
    it(`claims for the idle remote session from the held runtime (${targeted ? 'node-targeted' : 'untargeted'}, no registry entry)`, async () => {
      const { meshId, components, dispatchMeshCommand, task } = setup({ targeted })
      try {
        await triggerMeshQueue(components, meshId)
        expect(dispatchMeshCommand).toHaveBeenCalledWith(DAEMON, 'agent_command', expect.objectContaining({
          targetSessionId: SESSION,
          action: 'send_chat',
        }))
        const entry = getQueue(meshId).find(t => t.id === task.id)!
        expect(entry.status).toBe('assigned')
        expect(entry.assignedSessionId).toBe(SESSION)
      } finally {
        cleanup(meshId)
      }
    })
  }

  it('records an idle_session_unclaimed hold when an offered idle session still did not claim past the bound', async () => {
    const { meshId, components, task } = setup({ targeted: true })
    try {
      // Refuse the claim at the dispatch seam so the task stays pending, then age it past the bound.
      const store = (await import('../../src/mesh/mesh-runtime-store.js')).MeshRuntimeStore.getInstance()
      store.db.prepare("UPDATE mesh_queue SET payload = json_set(payload, '$.updatedAt', ?) WHERE mesh_id = ? AND id = ?")
        .run(new Date(Date.now() - 10 * 60_000).toISOString(), meshId, task.id)
      ;(components as any).dispatchMeshCommand = vi.fn(async () => ({ success: false, error: 'refused' }))
      await triggerMeshQueue(components, meshId)
      const entry = getQueue(meshId).find(t => t.id === task.id)!
      if (entry.status === 'pending') expect(entry.hold?.reason).toBeTruthy()
    } finally {
      cleanup(meshId)
    }
  })
})
