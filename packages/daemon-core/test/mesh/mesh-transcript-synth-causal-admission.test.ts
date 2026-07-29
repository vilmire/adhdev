import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// MID-TURN-CAUSAL-ADMISSION (rc.16 unified completion ingress) regression.
//
// Verified live incidents: the coordinator received a WEAK synthesized completion mid-turn —
// after an interim narration bubble ("Let me find…") — while the worker's raw PTY still showed
// `Working (43s)` and further tool calls (two Explore agents) continued. The transcript-synth
// completion ingresses (reconcile-loop PHASE 4, the assigned-stranded watchdog's early-idle
// propagation, the MCP mesh_status poll) all funnel through
// reconcileDirectDispatchCompletionFromTranscript, which writes the terminal ledger and queues
// the coordinator completion DIRECTLY — bypassing the injectMeshSystemMessage →
// evaluateMeshEventSuppression → hasLiveTurnPendingEvidence gate (3a48f660) that protects the
// native provider-event path. PHASE 4 additionally never ran the trailing-tool-activity veto
// that pollAssignedTaskTerminalEvidence has, so an interim final-LOOKING bubble followed by
// tool calls was promoted to a completion off a momentary inter-tool idle read.
//
// The fix under test: ONE reusable causal admission point inside the transcript-synth choke
// point (reconcileDirectDispatchCompletionFromTranscript) plus caller-side evidence wiring:
//   - a LOCAL live adapter reporting hasLiveTurnPendingEvidence() === true VETOES an eager
//     transcript completion (fail-open when no live instance resolves — remote/unknown);
//   - trailing tool/terminal activity after the latest final-looking assistant bubble VETOES
//     the synth absolutely — a stale weak interim summary must never become final merely
//     because a timeout (fast-track grace / death deadline) fired;
//   - bounded last-resort backstops (acked death deadline, redrive deadline) preserve the
//     genuine-final fail-open / max-wait semantics;
//   - a held synth re-evaluates every tick and releases EXACTLY ONCE once state clears.

const testTmpDir = path.join(tmpdir(), `adhdev-causal-admission-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

const meshConfigMocks = vi.hoisted(() => ({
  listMeshes: vi.fn(() => [] as any[]),
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  listMeshes: meshConfigMocks.listMeshes,
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
}))

import { reconcileUnterminatedDirectDispatches } from '../../src/mesh/mesh-completion-synthesis.js'
import { reconcileDirectDispatchCompletionFromTranscript } from '../../src/mesh/mesh-events-stale.js'
import { runMeshReconcileTick, __resetReconcileInFlightSynthDebounceForTests, __resetReclaimUnknownStreakForTests } from '../../src/mesh/mesh-reconcile-loop.js'
import {
  __resetMeshRuntimeStoreForTests,
  __clearMeshQueueForTests,
  insertDirectDispatch,
  getActiveDirectDispatches,
  updateDirectDispatchStatus,
  enqueueTask,
  getQueue,
  claimNextTask,
} from '../../src/mesh/mesh-work-queue.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'

const NODE_ID = 'node_worker_1'
const SESSION_ID = 'sess-causal-worker'
const WORKSPACE = '/repo/worktree-causal'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetReclaimUnknownStreakForTests()
  meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
    const p = path.join(getLedgerDir(), `${meshId}${suffix}`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

afterEach(() => {
  delete process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS
  delete process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS
})

// Seed a direct-dispatch ledger entry + dispatch-store row for `taskId`, dispatched
// `ageMs` ago (same pattern as mesh-notif-miss-early-synthesis.test.ts: the public
// appendLedgerEntry always stamps `now`, so the backdated task_dispatched entry the
// grace gate reads is written straight to the runtime store).
function seedDispatch(meshId: string, taskId: string, opts: { ageMs: number; dispatchedToIdleSession?: boolean }) {
  const dispatchedAt = new Date(Date.now() - opts.ageMs).toISOString()
  MeshRuntimeStore.getInstance().appendLedgerEntry({
    id: `dispatch-${taskId}`,
    meshId,
    timestamp: dispatchedAt,
    kind: 'task_dispatched',
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    providerType: 'kimi',
    payload: {
      source: 'direct',
      taskId,
      providerType: 'kimi',
      targetSessionId: SESSION_ID,
      dispatchedToIdleSession: opts.dispatchedToIdleSession === true,
    },
  })
  insertDirectDispatch(meshId, {
    taskId,
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    providerType: 'kimi',
    message: 'do the task',
    via: 'local_direct',
    dispatchedToIdleSession: opts.dispatchedToIdleSession === true,
    dispatchedAt,
  } as any)
  return dispatchedAt
}

// PHASE 4 driver components: a local worker session whose read_chat returns the given
// transcript, and (optionally) a live instance exposing hasLiveTurnPendingEvidence.
function makePhase4Components(opts: {
  isLivePending: () => boolean
  readChat: (cmd: string) => any
  withLiveInstance?: boolean
}) {
  const worker: any = {
    category: 'cli',
    getState: () => ({
      instanceId: SESSION_ID,
      status: 'idle',
      type: 'kimi',
      settings: { meshNodeId: NODE_ID },
    }),
    hasLiveTurnPendingEvidence: vi.fn(() => opts.isLivePending()),
  }
  const resolveInstance = opts.withLiveInstance === false
    ? () => undefined
    : (id: string) => (id === SESSION_ID ? worker : undefined)
  return {
    instanceManager: {
      getInstance: vi.fn(resolveInstance),
      getByCategory: vi.fn((category: string) => (category === 'cli' && opts.withLiveInstance !== false ? [worker] : [])),
    },
    commandHandler: { handle: vi.fn(opts.readChat) },
  } as any
}

const phase4Mesh = (meshId: string) => ({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] }) as any

function completionsQueued(meshId: string) {
  return getPendingMeshCoordinatorEvents(meshId).filter(e => e.event === 'agent:generating_completed')
}

function terminalLedgerEntries(meshId: string) {
  return readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' || e.kind === 'task_failed')
}

describe('MID-TURN-CAUSAL-ADMISSION: transcript-synth completion ingresses', () => {
  // ── Req 1 core: the verified incident shape ────────────────────────────────
  it('PHASE 4 holds the synth while an interim final-looking bubble is followed by trailing tool activity and the live adapter is pending; releases exactly once when genuinely final', async () => {
    const meshId = `mesh_causal_incident_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000 // past every grace window
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })

      let livePending = true
      const interimTs = dispatchAtMs + 30_000
      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle', // momentary inter-tool idle — the over-trusted signal
          providerSessionId: 'kimi-history-1',
          messages: [
            { role: 'user', content: 'implement the fix', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Let me find the ledger code and trace the completion path.', timestamp: interimTs },
            { role: 'assistant', kind: 'tool', content: 'Read mesh-events-stale.ts', timestamp: interimTs + 5_000 },
            { role: 'assistant', kind: 'tool', content: 'Grep reconcileDirectDispatchCompletionFromTranscript', timestamp: interimTs + 10_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => livePending, readChat })

      // Tick while the turn is still executing: NO completion may be recorded or queued.
      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)

      // The tools finish; the genuine final assistant bubble lands AFTER the last tool
      // call; the live adapter no longer reports pending evidence.
      livePending = false
      const finalTs = interimTs + 60_000
      readChat.mockImplementation(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle',
          providerSessionId: 'kimi-history-1',
          messages: [
            { role: 'user', content: 'implement the fix', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Let me find the ledger code and trace the completion path.', timestamp: interimTs },
            { role: 'assistant', kind: 'tool', content: 'Read mesh-events-stale.ts', timestamp: interimTs + 5_000 },
            { role: 'assistant', kind: 'tool', content: 'Grep reconcileDirectDispatchCompletionFromTranscript', timestamp: interimTs + 10_000 },
            { role: 'assistant', content: 'Done — root cause found, fixed, and verified.', timestamp: finalTs },
          ],
        }
      })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)[0].coordinatorMessage).toContain('Done — root cause found, fixed, and verified.')

      // A further tick re-evaluates and stays idempotent — exactly once, never twice.
      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Incident #1 shape (codex): transcript reads idle with a clean final-looking tail,
  //    but the live adapter still reports the turn pending (raw PTY `Working (43s)`). ──
  it('PHASE 4 holds the synth on live-adapter pending evidence even with a clean final-looking transcript tail', async () => {
    const meshId = `mesh_causal_livepending_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle',
          providerSessionId: 'codex-history-1',
          messages: [
            { role: 'user', content: 'audit the stage 4 tasks', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Interim progress: audited 2 of 5 tasks so far.', timestamp: dispatchAtMs + 43_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => true, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Req 3: genuine-final fail-open / max-wait semantics are preserved — a bounded
  //    last-resort backstop (the acked death deadline) still fires under live-pending. ──
  it('PHASE 4 acked death-deadline backstop still synthesizes under live-pending evidence (bounded fail-open preserved)', async () => {
    const meshId = `mesh_causal_backstop_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle',
          providerSessionId: 'kimi-history-2',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Done — the answer was fully rendered, emit lost.', timestamp: dispatchAtMs + 60_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => true, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Req 4: a stale weak interim summary must NOT become final merely because the
  //    death deadline fired while newer transcript/tool activity exists. ──
  it('PHASE 4 death deadline does NOT promote an interim summary that has trailing tool activity', async () => {
    const meshId = `mesh_causal_deadline_tools_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle',
          providerSessionId: 'kimi-history-3',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Let me check the remaining logs.', timestamp: dispatchAtMs + 60_000 },
            { role: 'assistant', kind: 'tool', content: 'Read daemon.log', timestamp: dispatchAtMs + 65_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => false, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Req 3: a remote/missing live source fails OPEN — the existing bounded
  //    transcript evidence behavior is unchanged. ──
  it('PHASE 4 synthesizes for a session with no resolvable live instance (remote/missing source fails open)', async () => {
    const meshId = `mesh_causal_remote_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle',
          providerSessionId: 'kimi-history-4',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Done — remote worker finished.', timestamp: dispatchAtMs + 60_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => true, readChat, withLiveInstance: false })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Req 2: the single reusable causal admission point — choke-point unit semantics ──
  // Each case uses its OWN meshId: readLedgerEntries caches raw entries per mesh and the
  // backdated seed writes straight to the runtime store, so a second seed on the same mesh
  // would be invisible to the reconcile's ledger reads.
  it('choke point: live-pending vetoes an eager synth; a bounded backstop overrides; trailing tool activity vetoes absolutely', () => {
    const runId = Date.now()
    const meshes: string[] = []
    try {
      const makeCase = (label: string) => {
        const meshId = `mesh_causal_unit_${label}_${runId}`
        meshes.push(meshId)
        const taskId = `task-${randomUUID().slice(0, 8)}`
        seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
        return {
          meshId,
          args: {
            meshId,
            nodeId: NODE_ID,
            sessionId: SESSION_ID,
            providerType: 'kimi',
            providerSessionId: 'kimi-history-5',
            taskId,
            finalSummary: 'interim-looking summary',
            transcriptMessageAt: new Date().toISOString(),
            source: 'daemon_reconcile_transcript_completion',
          },
        }
      }

      // (a) live-pending veto
      const a = makeCase('a')
      const vetoed = reconcileDirectDispatchCompletionFromTranscript({
        ...a.args,
        causalAdmission: { liveTurnPendingEvidence: () => true },
      } as any)
      expect(vetoed.reconciled).toBe(false)
      expect(vetoed.reason).toBe('live_turn_pending_evidence')
      expect(terminalLedgerEntries(a.meshId)).toHaveLength(0)

      // (b) bounded backstop overrides the live-pending veto (fail-open max-wait)
      const b = makeCase('b')
      const bounded = reconcileDirectDispatchCompletionFromTranscript({
        ...b.args,
        causalAdmission: { liveTurnPendingEvidence: () => true, boundedBackstop: true },
      } as any)
      expect(bounded.reconciled).toBe(true)

      // (c) trailing tool activity vetoes even a bounded backstop
      const c = makeCase('c')
      const trailing = reconcileDirectDispatchCompletionFromTranscript({
        ...c.args,
        causalAdmission: { boundedBackstop: true, trailingToolActivityAfterFinalAssistant: true },
      } as any)
      expect(trailing.reconciled).toBe(false)
      expect(trailing.reason).toBe('trailing_tool_activity_after_final_assistant')

      // (d) absent / throwing live evidence fails open
      const d = makeCase('d')
      const thrown = reconcileDirectDispatchCompletionFromTranscript({
        ...d.args,
        causalAdmission: {
          liveTurnPendingEvidence: () => { throw new Error('diagnostic failure') },
        },
      } as any)
      expect(thrown.reconciled).toBe(true)
    } finally {
      for (const meshId of meshes) cleanup(meshId)
    }
  })

  // ── Req 4 (watchdog ingress): the early-idle propagation must DEFER — no row flip, no
  //    bare ledger, no queued completion — while the live adapter reports pending, then
  //    release exactly once after the state clears. ──
  it('watchdog early-idle propagation defers under live-pending evidence and releases exactly once after it clears', async () => {
    const meshId = `mesh_causal_watchdog_${Date.now()}`
    const nodeId = NODE_ID
    const sessionId = SESSION_ID
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const dispatchAt = Date.now()
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
      const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
      createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

      let livePending = true
      const summary = 'Done — the genuine final answer.'
      const workerInstance: any = {
        category: 'cli',
        provider: { type: 'kimi', category: 'cli', tui: { transcriptPty: { scope: 'buffer' } } },
        hasLiveTurnPendingEvidence: () => livePending,
        getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
      }
      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'idle',
          providerSessionId: 'kimi-history-6',
          messages: [
            { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
            { role: 'assistant', content: summary, timestamp: dispatchAt + 500 },
          ],
        }
      })
      const components = {
        instanceManager: {
          getByCategory: (category: string) => (category === 'cli' ? [workerInstance] : []),
          getInstance: (id: string) => (id === sessionId ? workerInstance : undefined),
        },
        commandHandler: { handle: readChat },
      } as any
      const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: WORKSPACE }] }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)

      await runMeshReconcileTick(components) // arm the continuous-idle streak
      vi.setSystemTime(Date.now() + 9_000)
      await runMeshReconcileTick(components) // grace elapsed — poll passes, but live adapter is pending

      // DEFERRED: the row is NOT flipped, no terminal ledger, no queued completion.
      expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)

      // Live state clears; the streak re-accumulates and the completion releases exactly once.
      livePending = false
      await runMeshReconcileTick(components) // re-arm
      vi.setSystemTime(Date.now() + 9_000)
      await runMeshReconcileTick(components) // release

      expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('completed')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)[0].coordinatorMessage).toContain(summary)

      vi.setSystemTime(Date.now() + 9_000)
      await runMeshReconcileTick(components) // idempotent — still exactly once
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      cleanup(meshId)
    }
  })
})

// FLOOR-COMPLETION-NON-IDLE-ESCAPE (bounded PHASE-4 non-idle rescue net).
//
// A floor-class worker (codex-cli / kimi / cursor / opencode) whose CLI state engine
// wedged in `generating` — final assistant scrolled outside the PTY live-frame-tail
// while the native transcript holds it (the cli-state-engine transcript-finish defer
// bug) — reads non-idle FOREVER, so PHASE 4's idle gate never rescues it even past
// the acked death deadline. The escape under test lets the death-deadline synth fire
// off a `generating` read, but ONLY under strictly stronger evidence than the idle
// path (acked dispatch + past the death deadline + generating specifically + final
// assistant present + no trailing tool activity + PROVABLE post-dispatch causality;
// unparseable timestamps fail closed here, unlike the idle path).
describe('FLOOR-COMPLETION-NON-IDLE-ESCAPE: PHASE 4 bounded non-idle death-deadline escape', () => {
  // ── Core: the wedged floor-class worker shape — acked, past the death deadline,
  //    reads 'generating' forever, but the transcript holds a causally-proven final
  //    assistant. The synth commits through the death-deadline backstop (bounded
  //    fail-open: it overrides even live-turn-pending evidence). ──
  it('synthesizes for an acked dispatch past the death deadline that reads generating with a post-dispatch final assistant', async () => {
    const meshId = `mesh_nonidle_escape_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'generating', // the floor-class PTY wedge — never settles to idle
          providerSessionId: 'kimi-history-nonidle-1',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Done — the answer landed in the native transcript only.', timestamp: dispatchAtMs + 60_000 },
          ],
        }
      })
      // Live-pending TRUE: the wedged engine still holds the turn open — the
      // death-deadline boundedBackstop must override the live-pending veto, same as
      // the idle death-deadline path.
      const components = makePhase4Components({ isLivePending: () => true, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)[0].coordinatorMessage).toContain('Done — the answer landed in the native transcript only.')

      // Idempotent — a second tick does not double-synthesize.
      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(1)
      expect(completionsQueued(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Guard: the final assistant must be causally attributable to THIS task's
  //    dispatch — a provably pre-dispatch summary is a prior task's output. ──
  it('refuses the non-idle escape when the final assistant predates dispatchedAt', async () => {
    const meshId = `mesh_nonidle_stale_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'generating',
          providerSessionId: 'kimi-history-nonidle-2',
          // Reused-session shape: the latest user-facing assistant bubble is the
          // PRIOR task's summary (this task's prompt is not in the tail yet), so
          // the strict causality guard — not the trailing-user selector — is what
          // must refuse the synth.
          messages: [
            { role: 'user', content: 'prior task', timestamp: dispatchAtMs - 120_000 },
            { role: 'assistant', content: 'Prior task answer — not this task.', timestamp: dispatchAtMs - 60_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => false, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Guard (strict causality): unlike the idle path, an UNPARSEABLE timestamp
  //    fails closed — the escape has no idle re-probe to catch a resumed worker. ──
  it('refuses the non-idle escape when the final assistant timestamp is unparseable', async () => {
    const meshId = `mesh_nonidle_nots_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'generating',
          providerSessionId: 'kimi-history-nonidle-3',
          messages: [
            { role: 'user', content: 'do the task' },
            { role: 'assistant', content: 'Done — but carries no usable timestamp.' },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => false, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Guard (rc.16 trailing-tool veto): interim narration followed by tool
  //    activity is not a turn end, even past the death deadline. ──
  it('refuses the non-idle escape when trailing tool activity follows the final-looking bubble', async () => {
    const meshId = `mesh_nonidle_tools_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'generating',
          providerSessionId: 'kimi-history-nonidle-4',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Let me check the logs first.', timestamp: dispatchAtMs + 60_000 },
            { role: 'assistant', kind: 'tool', content: 'Read daemon.log', timestamp: dispatchAtMs + 65_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => false, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Guard: only `generating` qualifies — a waiting_approval worker is genuinely
  //    BLOCKED and must never be completed by the escape. ──
  it('refuses the non-idle escape for a waiting_approval read', async () => {
    const meshId = `mesh_nonidle_wa_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'waiting_approval',
          providerSessionId: 'kimi-history-nonidle-5',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Done — but the worker is parked on an approval.', timestamp: dispatchAtMs + 60_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => false, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Guard: a NEVER-ACKED dispatch keeps the old `continue` — no in-flight turn
  //    to rescue, so a non-idle read never synthesizes regardless of evidence. ──
  it('refuses the non-idle escape for a never-acked dispatch', async () => {
    const meshId = `mesh_nonidle_neveracked_${Date.now()}`
    process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchAtMs = Date.now() - 5 * 60_000
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000 })
      // Deliberately NOT acked — status stays 'dispatched'.

      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        return {
          success: true,
          status: 'generating',
          providerSessionId: 'kimi-history-nonidle-6',
          messages: [
            { role: 'user', content: 'do the task', timestamp: dispatchAtMs + 500 },
            { role: 'assistant', content: 'Done — but the attempt was never acked.', timestamp: dispatchAtMs + 60_000 },
          ],
        }
      })
      const components = makePhase4Components({ isLivePending: () => false, readChat })

      await reconcileUnterminatedDirectDispatches(components, phase4Mesh(meshId), [], 'daemon-local')
      expect(terminalLedgerEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })
})
