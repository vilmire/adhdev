import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// MID-TURN-LIVE-STATE-GATE (broader false-idle RCA follow-up): an incoming agent:generating_completed
// for a session with a resolvable LOCAL live instance is independently re-verified against that
// instance's CURRENT turn state (hasLiveTurnPendingEvidence(), the public wrapper over the same
// discriminators the instance's own getCompletedFinalizationBlock uses: adapter pending-response —
// isWaitingForResponse / currentTurnScope / isProcessing() / a non-empty partial response — OR a live
// approval/choice modal). A screen-redraw parse artifact, a decoupled-immediate emit, or a TOCTOU
// between emit and coordinator receipt can let a genuinely mid-turn session's completion reach the
// coordinator; this gate suppresses that ONE event rather than recording a false completion.
//
// This is a NEW, additive gate ordered BEFORE the existing autoLaunch causal gate (a01d8917) and the
// terminal/dedup logic: mid-turn live-state gate -> autoLaunch causal gate -> terminal/dedup.
// It never wedges: it persists no hold state and simply no-ops when no live instance resolves
// (remote/unknown sessions), leaving their existing async reconcile-loop protections untouched.

const testTmpDir = path.join(tmpdir(), `adhdev-midturn-gate-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ machineId: 'test-machine' } as any)),
}))
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: configMocks.loadConfig,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn() }))
const fastForwardMocks = vi.hoisted(() => ({ fastForwardMeshNode: vi.fn() }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({ fastForwardMeshNode: fastForwardMocks.fastForwardMeshNode }))

import { setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

const NODE_ID = 'node_local_1'
const SESSION_ID = 'live-session-1'
const WORKSPACE = '/repo/local'

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

function mockMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
  meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
}

// A fake live CliProviderInstance-shaped source. `pendingEvidence` simulates
// hasLiveTurnPendingEvidence() — the ONLY method the new gate calls.
function makeLocalComponents(pendingEvidence: boolean | (() => boolean), opts: { withMethod?: boolean } = { withMethod: true }) {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: SESSION_ID,
    workspace: WORKSPACE,
    settings: { meshNodeFor: '', meshNodeId: NODE_ID },
  }
  const source: any = {
    category: 'cli',
    getState: vi.fn(() => sourceState),
  }
  if (opts.withMethod !== false) {
    source.hasLiveTurnPendingEvidence = vi.fn(() =>
      typeof pendingEvidence === 'function' ? pendingEvidence() : pendingEvidence)
  }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => (id === SESSION_ID ? source : undefined)),
    getByCategory: vi.fn((category: string) => (category === 'cli' ? [source] : [])),
  }
  return {
    components: { instanceManager } as any,
    source,
    emit: (event: any) => {
      if (!listener) throw new Error('listener was not registered')
      listener(event)
    },
    setMeshFor: (meshId: string) => { sourceState.settings = { meshNodeFor: meshId, meshNodeId: NODE_ID } },
  }
}

function completedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'agent:generating_completed',
    instanceId: SESSION_ID,
    targetSessionId: SESSION_ID,
    providerType: 'codex-cli',
    finalSummary: 'final answer',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('MID-TURN-LIVE-STATE-GATE — suppresses a premature completion while the adapter proves the turn is still active', () => {
  it('suppresses when the live instance reports mid-tool/streaming pending evidence (interim, not final)', () => {
    const meshId = `mesh_midturn_pending_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit, setMeshFor, source } = makeLocalComponents(true)
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit(completedEvent())

      expect(source.hasLiveTurnPendingEvidence).toHaveBeenCalled()
      // No terminal ledger entry — the premature completion must not be recorded.
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('accepts a genuine final completion (no pending evidence) and processes it exactly once', () => {
    const meshId = `mesh_midturn_final_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit, setMeshFor } = makeLocalComponents(false)
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit(completedEvent())

      // Gate did not short-circuit — execution reached the normal accept path, which
      // re-registers the now-idle session (synchronous side effect proving pass-through).
      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.filter(s => s.sessionId === SESSION_ID)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('adapter state clears -> the NEXT completion (same session) is no longer held (bounded, not a permanent wedge)', () => {
    const meshId = `mesh_midturn_release_${Date.now()}`
    try {
      mockMesh(meshId)
      let pending = true
      const { components, emit, setMeshFor } = makeLocalComponents(() => pending)
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      // First completion arrives while still mid-turn -> suppressed.
      emit(completedEvent({ finalSummary: 'premature' }))
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)

      // The adapter's own state clears (turn genuinely finished) -> the real completion re-fires.
      pending = false
      emit(completedEvent({ finalSummary: 'genuine final' }))

      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.some(s => s.sessionId === SESSION_ID)).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT apply to a remote/unknown session (no resolvable live instance) — never fail-closed on absence of evidence', () => {
    const meshId = `mesh_midturn_remote_${Date.now()}`
    try {
      mockMesh(meshId)
      // No live instance registered at all for this session (simulates a remote worker).
      const instanceManager = {
        onEvent: vi.fn(),
        getInstance: vi.fn(() => undefined),
        getByCategory: vi.fn(() => []),
      }
      let listener: ((event: any) => void) | undefined
      instanceManager.onEvent.mockImplementation((cb: any) => { listener = cb })
      setupMeshEventForwarding({ instanceManager } as any)

      // Without a resolvable instance, the gate is scoped out entirely (typeof check fails), so
      // the event proceeds unaffected by THIS gate. There is no session/nodeId route available in
      // this minimal harness, so this only asserts the call does not throw and does not itself
      // fail-closed via the mid-turn gate (a thrown error would fail this test).
      expect(() => listener?.(completedEvent())).not.toThrow()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('a live instance lacking hasLiveTurnPendingEvidence (legacy/older adapter) is not gated — backward safe', () => {
    const meshId = `mesh_midturn_legacy_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit, setMeshFor } = makeLocalComponents(true, { withMethod: false })
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit(completedEvent())

      // No hasLiveTurnPendingEvidence -> gate no-ops -> normal accept path runs.
      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.some(s => s.sessionId === SESSION_ID)).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

describe('MID-TURN-LIVE-STATE-GATE — ordering vs. the autoLaunch causal gate (a01d8917)', () => {
  it('fires BEFORE the autoLaunch causal gate: an in-window autoLaunch task whose session is also mid-turn-pending is suppressed by the mid-turn gate, not miscounted', () => {
    const meshId = `mesh_midturn_order_${Date.now()}`
    try {
      mockMesh(meshId)
      // Seed an in-window, unclaimed autoLaunch task naming this session (the Fix A scenario).
      const task = enqueueTask(meshId, 'do worktree work', { taskMode: 'code_change' })
      const store = MeshRuntimeStore.getInstance()
      const entry = store.findQueueEntryById(meshId, task.id)!
      entry.autoLaunch = { status: 'completed', nodeId: NODE_ID, providerType: 'codex-cli', sessionId: SESSION_ID, updatedAt: new Date().toISOString() }
      store.updateQueueEntry(entry)

      const { components, emit, setMeshFor } = makeLocalComponents(true)
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit(completedEvent({ taskId: task.id }))

      // Suppressed either way (both gates would reject it), but the task must stay untouched and
      // no terminal recorded — the important invariant either gate protects.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('regression: autoLaunch causal gate (a01d8917) still fires independently when the mid-turn gate passes (no pending evidence)', () => {
    const meshId = `mesh_midturn_autolaunch_regression_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = enqueueTask(meshId, 'do worktree work', { taskMode: 'code_change' })
      const store = MeshRuntimeStore.getInstance()
      const entry = store.findQueueEntryById(meshId, task.id)!
      entry.autoLaunch = { status: 'completed', nodeId: NODE_ID, providerType: 'codex-cli', sessionId: SESSION_ID, updatedAt: new Date().toISOString() }
      store.updateQueueEntry(entry)

      // Mid-turn gate reports NOT pending (no live evidence) — the a01d8917 causal gate must
      // still independently suppress this premature (no delivery consumed / no turn-start) event.
      const { components, emit, setMeshFor } = makeLocalComponents(false)
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit(completedEvent({ taskId: task.id }))

      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
