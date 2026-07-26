import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// BOOTSTRAP-POLICY-CONSISTENCY (Fix B, rc.15 orchestration RCA): isLaunchableNode (the auto-launch
// candidacy filter in mesh-queue-assignment.ts) must exclude a node whose worktreeBootstrap.status
// is 'running', mirroring the SAME predicate (shouldDeferDispatchForBootstrap) the claim gate
// (tryAssignQueueTask) already applies. Before this fix, isLaunchableNode passed a bootstrapping
// worktree node through, so maybeAutoLaunchOneQueueSession could spawn an ORPHAN session on it —
// the claim gate then deferred the claim onto that freshly-spawned session anyway (its own
// bootstrap-running gate), stranding the spawn with nothing assigned while the node's real
// bootstrap-driven session comes up separately.

const testTmpDir = path.join(tmpdir(), `adhdev-al-bootstrap-excl-test-${randomUUID().slice(0, 8)}`)
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

import { triggerMeshQueue, handleMeshForwardEvent } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'

const NODE_ID = 'node_worktree_bootstrapping'

function createComponents() {
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? [] : [])),
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
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string, worktreeBootstrapStatus?: string, requiredTags?: string[]) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Bootstrap Exclusion Mesh',
    policy: {},
    nodes: [{
      id: NODE_ID,
      isLocalWorktree: true,
      workspace: `/repo/${NODE_ID}`,
      repoRoot: `/repo/${NODE_ID}`,
      policy: { providerPriority: ['codex-cli'] },
      ...(worktreeBootstrapStatus ? { worktreeBootstrap: { status: worktreeBootstrapStatus, updatedAt: new Date().toISOString() } } : {}),
    }],
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
  __resetAutoLaunchAwaitClaimBackoffForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('BOOTSTRAP-POLICY-CONSISTENCY — auto-launch excludes a node mid worktree bootstrap', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('does NOT auto-launch (no launch_cli call) onto a node whose worktreeBootstrap.status is "running"', async () => {
    const meshId = `mesh_al_bootstrap_running_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, 'running')
      const components = createComponents()
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: NODE_ID, taskMode: 'code_change' })

      await triggerMeshQueue(components, meshId)

      expect(launchCliCalls(components)).toBe(0)
      expect(autoLaunchReason(meshId, task.id)).toBe('node_not_launch_ready')
      // No orphan session: the task stays pending for the real bootstrap-driven claim to pick up.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: auto-launches normally once the node reports NO worktreeBootstrap field (prior behavior)', async () => {
    const meshId = `mesh_al_bootstrap_nofield_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, undefined)
      const components = createComponents()
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: NODE_ID, taskMode: 'code_change' })

      await triggerMeshQueue(components, meshId)

      expect(launchCliCalls(components)).toBe(1)
      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_not_launch_ready')
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: auto-launches normally once the node\'s bootstrap has transitioned to "complete"', async () => {
    const meshId = `mesh_al_bootstrap_complete_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, 'complete')
      const components = createComponents()
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: NODE_ID, taskMode: 'code_change' })

      await triggerMeshQueue(components, meshId)

      expect(launchCliCalls(components)).toBe(1)
      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_not_launch_ready')
    } finally {
      cleanup(meshId)
    }
  })

  it('requiredTags provider pin: a running-bootstrap node is excluded even when the pending task pins a matching required provider', async () => {
    const meshId = `mesh_al_bootstrap_requiredtags_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, 'running')
      const components = createComponents()
      const task = enqueueTask(meshId, 'do codex work', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        requiredTags: ['provider=codex-cli'],
      })

      await triggerMeshQueue(components, meshId)

      // The bootstrap exclusion must hold regardless of a requiredTags provider pin — no bypass.
      expect(launchCliCalls(components)).toBe(0)
      expect(autoLaunchReason(meshId, task.id)).toBe('node_not_launch_ready')
    } finally {
      cleanup(meshId)
    }
  })
})

// Detached bootstrap terminal event coverage: a worktree clone's bootstrap runs on the WORKER
// daemon (clone_mesh_node forwards to the source node's machine), so its terminal transition
// arrives at the coordinator as a forwarded ('detached') worktree_bootstrap_complete /
// worktree_bootstrap_failed event, not a local state change. handleMeshForwardEvent must stamp
// the terminal status onto the coordinator's mesh view (router.markWorktreeBootstrapTerminalState)
// for BOTH outcomes, and never throw — this is the exact WORKTREE-BOOTSTRAP-COORD-STATE gate my
// isLaunchableNode change now also depends on: a stale-stamped node would spuriously stay excluded.
describe('BOOTSTRAP-POLICY-CONSISTENCY — detached (forwarded) bootstrap terminal events reach the coordinator view', () => {
  afterEach(() => { vi.clearAllMocks() })

  function createForwardComponents() {
    return {
      instanceManager: {
        getInstance: vi.fn(() => undefined),
        getByCategory: vi.fn(() => []),
      },
      router: { markWorktreeBootstrapTerminalState: vi.fn() },
    } as any
  }

  it('a detached worktree_bootstrap_complete event stamps the node terminal state as "complete"', () => {
    const meshId = `mesh_al_bootstrap_detached_complete_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, 'running')
      const components = createForwardComponents()

      const result: any = handleMeshForwardEvent(components, {
        event: 'worktree_bootstrap_complete',
        meshId,
        nodeId: NODE_ID,
        workspace: `/repo/${NODE_ID}`,
        timestamp: Date.now(),
      })

      expect(result.success).toBe(true)
      expect(components.router.markWorktreeBootstrapTerminalState).toHaveBeenCalledWith(
        meshId, NODE_ID, 'complete', expect.anything(),
      )
    } finally {
      cleanup(meshId)
    }
  })

  it('a detached worktree_bootstrap_failed event stamps the node terminal state as "failed" (never silently dropped)', () => {
    const meshId = `mesh_al_bootstrap_detached_failed_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, 'running')
      const components = createForwardComponents()

      const result: any = handleMeshForwardEvent(components, {
        event: 'worktree_bootstrap_failed',
        meshId,
        nodeId: NODE_ID,
        workspace: `/repo/${NODE_ID}`,
        timestamp: Date.now(),
      })

      expect(result.success).toBe(true)
      expect(components.router.markWorktreeBootstrapTerminalState).toHaveBeenCalledWith(
        meshId, NODE_ID, 'failed', expect.anything(),
      )
    } finally {
      cleanup(meshId)
    }
  })
})
