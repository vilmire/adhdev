import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// DOUBLE-DISPATCH Layer (a): maybeAutoLaunchOneQueueSession must NOT spawn a second worker
// when the target node already has a LIVE mesh session on its way to claim (idle / booting /
// momentary non-idle flip). The enqueue→drain race RCA: the idle drain skipped a
// momentarily-non-idle session as a candidate, and the write-only nodeHasActiveAssignment
// gate (status='assigned' rows only) could not see the about-to-claim session either, so a
// duplicate session spawned and the same taskId was sequentially stamped on two sessions.
// The new nodeHasLiveSessionPendingClaim gate closes that. It must still allow the legitimate
// first spawn (no live session) and a read-only launch onto a node whose only session is
// genuinely BUSY (holding its own assigned task).

const testTmpDir = path.join(tmpdir(), `adhdev-double-dispatch-al-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/bin/codex' })) }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

const NODE_ID = 'node_main'

// A fake live CLI instance bound to NODE_ID for `meshId`, in the given status.
function liveSession(meshId: string, sessionId: string, status: string) {
  const state = {
    instanceId: sessionId,
    status,
    workspace: `/repo/${NODE_ID}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[] = []) {
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) =>
        command === 'launch_cli' ? { success: true, sessionId: `spawned-${randomUUID().slice(0, 6)}` } : { success: true }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Double Dispatch Mesh',
    policy: {},
    nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } }],
  })
}

function autoLaunchReason(meshId: string, taskId: string): string | undefined {
  return getQueue(meshId).find(t => t.id === taskId)?.autoLaunch?.reason
}

function launchCliCalls(components: any): number {
  return components.cliManager.handleCliCommand.mock.calls.filter((c: any[]) => c[0] === 'launch_cli').length
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('DOUBLE-DISPATCH Layer (a) — auto-launch suppressed when node has a live pending-claim session', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('skips auto-launch (node_has_live_session_pending_claim) when a live, momentarily non-idle session exists on the node', async () => {
    const meshId = `mesh_al_skip_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // Live session in a NON-idle flip (generating) holding NO assigned task — the idle
      // drain skips it as a candidate, but it will claim the pending task on its next idle.
      const components = createComponents([liveSession(meshId, 'existing-sess', 'generating')])
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change' })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: launches normally (no skip) when the node has NO live session', async () => {
    const meshId = `mesh_al_spawn_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // dead/empty node — legitimate first spawn
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change' })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('DEPENDSON-GATE-SYMMETRY: a task with an unmet dependency is excluded from auto-launch (dependencies_unsatisfied, no spawn)', async () => {
    const meshId = `mesh_al_dep_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // empty node — dependent would otherwise be a legitimate first spawn
      // The prerequisite is in-flight (assigned, NOT completed) so it is not itself a pending
      // auto-launch candidate, leaving the dependent as the sole pending task the loop reaches.
      const dep = enqueueTask(meshId, 'prerequisite', { taskMode: 'code_change' })
      MeshRuntimeStore.getInstance().updateQueueEntry({
        ...dep, status: 'assigned', assignedNodeId: NODE_ID, assignedSessionId: 'other-sess',
        updatedAt: new Date().toISOString(),
      } as any)
      const dependent = enqueueTask(meshId, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id] })

      await triggerMeshQueue(components, meshId)

      // The dependent must NOT spawn a session — the launched session would idle→claim and be
      // refused by the SAME dependency gate in claimNextQueueTask (re-launch churn).
      expect(autoLaunchReason(meshId, dependent.id)).toBe('dependencies_unsatisfied')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('DEPENDSON-GATE-SYMMETRY: once the dependency completes, the dependent auto-launches (gate opens)', async () => {
    const meshId = `mesh_al_depdone_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // empty node → legitimate spawn when unblocked
      const dep = enqueueTask(meshId, 'prerequisite', { taskMode: 'code_change' })
      const dependent = enqueueTask(meshId, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id] })
      // Complete the prerequisite so the gate opens.
      MeshRuntimeStore.getInstance().updateQueueEntry({ ...dep, status: 'completed' } as any)

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, dependent.id)).not.toBe('dependencies_unsatisfied')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: a read-only task still launches when the node\'s only session is genuinely BUSY (holds its own assigned task)', async () => {
    const meshId = `mesh_al_busy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const busySessionId = 'busy-sess'
      // The busy session holds an assigned WRITE task on the node — it is real concurrent
      // work, not a free claimer, so it must NOT suppress a read-only auto-launch.
      const now = new Date().toISOString()
      MeshRuntimeStore.getInstance().insertQueueEntry({
        id: 'assigned-write', meshId, message: 'edit', status: 'assigned', taskMode: 'code_change',
        assignedNodeId: NODE_ID, assignedSessionId: busySessionId, createdAt: now, updatedAt: now,
      } as any)
      const components = createComponents([liveSession(meshId, busySessionId, 'generating')])
      const task = enqueueTask(meshId, 'diagnose', { taskMode: 'live_debug_readonly' })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })
})
