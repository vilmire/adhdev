/**
 * IPC-QUEUE-CLAIM-TURN-ATTEMPT (live defect, preview rc.39, 2026-09-24).
 *
 * A queue claim triggered through the COMMAND path (mcp-server
 * `mesh_enqueue_task` / `mesh_launch_session` → `trigger_mesh_queue`, or a
 * relayed `mesh_forward_event`) dispatched the task body without opening a
 * `mesh_queue:` turn attempt: the handlers passed the router's
 * `CommandRouterDeps` (built in boot S5, no `turnLedger`) as `DaemonComponents`,
 * `turnLedgerOf()` returned null and the attempt open was silently skipped.
 * The worker stamped `attempt=?`, the row stayed `assigned` forever.
 *
 * These drive the command THROUGH `DaemonCommandRouter.execute(...)` with a
 * deps object shaped exactly like S5's (no ledger, no router) and components
 * attached the way S7 attaches them — so a handler that reaches for `ctx.deps`
 * instead of `ctx.components()` fails here.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

const testTmpDir = path.join(tmpdir(), `adhdev-ipc-claim-attempt-${randomUUID().slice(0, 8)}`)
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

import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js'
import { tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { LOG } from '../../src/logging/logger.js'
import { testTurnLedger, wipeTurnTablesForTests } from '../mesh/helpers/mesh-turn-ledger-fixture.js'

const NODE_ID = 'node_worker'
const WS = '/repo/worker'
const SESSION_ID = 'sess-worker'

function idleSession(meshId: string) {
  const state = {
    instanceId: SESSION_ID,
    type: 'claude-cli',
    status: 'idle',
    workspace: WS,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, providerType: 'claude-cli' },
  }
  return { category: 'cli', getState: () => state, updateSettings: vi.fn() }
}

/** The S5 deps object, field-for-field what `bootCommandPlane` passes — no `turnLedger`, no `router`. */
function productionShapedDeps(meshId: string): CommandRouterDeps {
  const session = idleSession(meshId)
  const handleCliCommand = vi.fn(async () => ({ success: true }))
  return {
    commandHandler: { handle: async () => ({ success: true }), handleSpec: async () => ({ success: true }), rejectUnknown: async () => ({ success: false }) } as any,
    cliManager: { adapters: new Map([[SESSION_ID, { workingDir: WS }]]), handleCliCommand } as any,
    cdpManagers: new Map(),
    providerLoader: { resolveAlias: (t: string) => t, isMachineProviderEnabled: () => true, getMeta: () => undefined } as any,
    instanceManager: {
      getByCategory: vi.fn((c: string) => (c === 'cli' ? [session] : [])),
      getInstance: vi.fn((id: string) => (id === SESSION_ID ? session : undefined)),
      listInstanceIds: () => [SESSION_ID],
      collectAllStates: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: { get: () => undefined, has: () => false } as any,
    statusInstanceId: 'daemon-local',
  }
}

/** S7: the real components — the deps' collaborators + THIS router + the turn ledger — attached to the router. */
function bootRouter(meshId: string, opts: { attach?: boolean; ledger?: boolean } = {}) {
  const deps = productionShapedDeps(meshId)
  const router = new DaemonCommandRouter(deps)
  const components: any = {
    ...deps,
    router,
    turnLedger: opts.ledger === false ? null : testTurnLedger('daemon-local'),
  }
  if (opts.attach !== false) router.attachComponents(components)
  return { router, deps, components }
}

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'IPC claim mesh',
    policy: {},
    nodes: [{ id: NODE_ID, daemonId: 'daemon-local', workspace: WS, repoRoot: WS, policy: {} }],
  })
}

function attemptsOf(meshId: string, taskId: string) {
  const store = MeshRuntimeStore.getInstance().turnStore()
  return store.listAttemptsForTask(meshId, taskId).map(a => ({
    attemptId: a.attemptId,
    kinds: store.listEvents(a.attemptId).map(e => e.kind),
  }))
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  wipeTurnTablesForTests()
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('IPC-QUEUE-CLAIM-TURN-ATTEMPT — a command-path claim opens its turn attempt', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('(a) trigger_mesh_queue via router.execute (ipc) opens a mesh_queue: attempt with dispatch_accepted', async () => {
    const meshId = `mesh_ipc_claim_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const { router } = bootRouter(meshId)
      const task = enqueueTask(meshId, 'IPC-CLAIMED TASK', { targetNodeId: NODE_ID, difficulty: 'medium' })

      const result: any = await router.execute('trigger_mesh_queue', { meshId, preferredNodeId: NODE_ID }, 'ipc')
      expect(result.success).toBe(true)

      const attempts = attemptsOf(meshId, task.id)
      expect(attempts.length).toBeGreaterThan(0)
      expect(attempts[0].attemptId).toMatch(/^mesh_queue:/)
      expect(attempts[0].kinds).toContain('dispatch_accepted')
      // The row names the attempt it dispatched into (never an `attempt=?` dispatch).
      const row = getQueue(meshId).find(t => t.id === task.id)
      expect(row?.attemptId).toBe(attempts[0].attemptId)
    } finally {
      cleanup(meshId)
    }
  })

  it('(a2) a relayed agent:ready (mesh_forward_event via router.execute) claims into a mesh_queue: attempt', async () => {
    const meshId = `mesh_fwd_claim_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const { router } = bootRouter(meshId)
      const task = enqueueTask(meshId, 'RELAY-CLAIMED TASK', { targetNodeId: NODE_ID, difficulty: 'medium' })

      const result: any = await router.execute('mesh_forward_event', {
        event: 'agent:ready', meshId, nodeId: NODE_ID, targetSessionId: SESSION_ID, providerType: 'claude-cli', workspace: WS,
      }, 'ipc')
      expect(result.success).toBe(true)

      // The idle claim runs on setImmediate after the (no-op) idle fast-forward check.
      await vi.waitFor(() => expect(attemptsOf(meshId, task.id).length).toBeGreaterThan(0), { timeout: 3000, interval: 10 })
      const attempts = attemptsOf(meshId, task.id)
      expect(attempts[0].attemptId).toMatch(/^mesh_queue:/)
      expect(attempts[0].kinds).toContain('dispatch_accepted')
    } finally {
      cleanup(meshId)
    }
  })

  it('(boot window) before S7 attaches, trigger_mesh_queue answers daemon_components_not_ready and claims nothing', async () => {
    const meshId = `mesh_ipc_notready_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const { router } = bootRouter(meshId, { attach: false })
      const task = enqueueTask(meshId, 'TOO-EARLY TASK', { targetNodeId: NODE_ID, difficulty: 'medium' })

      const result: any = await router.execute('trigger_mesh_queue', { meshId, preferredNodeId: NODE_ID }, 'ipc')
      expect(result).toMatchObject({ success: false, code: 'daemon_components_not_ready' })
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      expect(attemptsOf(meshId, task.id)).toEqual([])
    } finally {
      cleanup(meshId)
    }
  })

  it('attachComponents refuses components that belong to another router', () => {
    const meshId = `mesh_ipc_foreign_${randomUUID().slice(0, 8)}`
    const { router, components } = bootRouter(meshId, { attach: false })
    const other = new DaemonCommandRouter(productionShapedDeps(meshId))
    expect(() => other.attachComponents(components)).toThrow(/not this router/)
    expect(() => router.attachComponents(components)).not.toThrow()
  })
})

describe('IPC-QUEUE-CLAIM-TURN-ATTEMPT — a claim without a turn ledger fails closed', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('(b) ledger-less components: claim refused with a TurnLedger WARN, row stays pending, no dispatch', async () => {
    const meshId = `mesh_noledger_${randomUUID().slice(0, 8)}`
    const warnSpy = vi.spyOn(LOG, 'warn')
    try {
      setMesh(meshId)
      const { components, deps } = bootRouter(meshId, { ledger: false })
      const task = enqueueTask(meshId, 'NO-LEDGER TASK', { targetNodeId: NODE_ID, difficulty: 'medium' })

      const claimed = tryAssignQueueTask(components, meshId, NODE_ID, SESSION_ID, 'claude-cli', undefined, undefined, 'test_no_ledger')

      expect(claimed).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith('TurnLedger', expect.stringMatching(/refusing queue claim .*no turn ledger on this daemon \(claim path test_no_ledger\)/))
      const row = getQueue(meshId).find(t => t.id === task.id)
      expect(row?.status).toBe('pending')
      expect(row?.assignedSessionId).toBeUndefined()
      expect((deps.cliManager as any).handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('(b2) an attempt-open failure refuses the dispatch (row back to pending) instead of dispatching without an attempt', async () => {
    const meshId = `mesh_openfail_${randomUUID().slice(0, 8)}`
    const warnSpy = vi.spyOn(LOG, 'warn')
    try {
      setMesh(meshId)
      const { components, deps } = bootRouter(meshId)
      const throwingLedger = new Proxy(components.turnLedger, {
        get(target, prop) {
          if (prop === 'observe') return () => { throw new Error('ERR_STORAGE injected') }
          return (target as any)[prop]
        },
      })
      components.turnLedger = throwingLedger
      const task = enqueueTask(meshId, 'OPEN-FAIL TASK', { targetNodeId: NODE_ID, difficulty: 'medium' })

      const claimed = tryAssignQueueTask(components, meshId, NODE_ID, SESSION_ID, 'claude-cli', undefined, undefined, 'test_open_fail')

      expect(claimed).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith('TurnLedger', expect.stringMatching(new RegExp(`refusing queue claim of task ${task.id} .*failed to open its turn attempt`)))
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      expect((deps.cliManager as any).handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })
})
