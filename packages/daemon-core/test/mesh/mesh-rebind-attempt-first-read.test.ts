import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Per-file isolated config dir → per-file mesh-runtime.db, so this suite's turn
// tables and ledger JSONL never touch a sibling suite's rows (same convention as
// mesh-duplicate-claim-attempt-rebind.test.ts / mesh-reconcile-loop.test.ts).
const testTmpDir = path.join(tmpdir(), `adhdev-rebind-first-read-${randomUUID().slice(0, 8)}`)
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

import {
  runMeshReconcileTick,
  __resetReconcileInFlightSynthDebounceForTests,
  __resetReclaimUnknownStreakForTests,
} from '../../src/mesh/mesh-reconcile-loop.js'
import {
  __resetMeshRuntimeStoreForTests,
  __clearMeshQueueForTests,
  enqueueTask,
  claimNextTask,
  getQueue,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import {
  rebindAttemptToLiveHolder,
  resolveTaskEvidenceSessionId,
  closeAttemptForReassignment,
  openTurnAttempt,
} from '../../src/mesh/mesh-turn-ledger.js'
import { pollAssignedTaskTerminalEvidence } from '../../src/mesh/mesh-completion-synthesis.js'

// The live incident (task f5edc912, 2026-07-31):
//   HOLDER  = the session that claimed first and is genuinely generating
//   REFUSED = the session the re-fired claim dispatched to; the node refused it,
//             so the rc.34 rebind re-pointed the ATTEMPT at HOLDER — but the queue
//             row's claim-time assignedSessionId still names REFUSED.
const HOLDER = 'f6196842'
const REFUSED = '7c1ff72c'

// Long enough to clear the 25s delivered-not-consumed redrive gate but under the
// 15-min delivered-no-turn deadline: this is the window the incident fired in.
const UNCONSUMED_MS = 60_000

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetReclaimUnknownStreakForTests()
  meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  for (const suffix of ['pending-events.jsonl', 'queue.json']) {
    const p = path.join(getLedgerDir(), `${meshId}.${suffix}`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

beforeEach(() => {
  MeshRuntimeStore.resetForTests()
})
afterEach(() => {
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

function backdateDispatch(meshId: string, taskId: string, ageMs: number) {
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, taskId)!
  entry.dispatchTimestamp = new Date(Date.now() - ageMs).toISOString()
  store.updateQueueEntry(entry)
}

/**
 * Replay the incident: claim+dispatch the task to REFUSED (opening the attempt
 * against it), then apply the rc.34 rebind onto the live HOLDER. The queue row is
 * deliberately left naming REFUSED — that divergence IS the defect under test.
 */
function setupReboundTask(meshId: string, nodeId: string) {
  const claimed = setupClaimedTask(meshId, nodeId)
  const rebind = rebindAttemptToLiveHolder({ meshId, taskId: claimed.id, holderSessionId: HOLDER })
  expect(rebind.rebound).toBe(true)
  return claimed
}

/**
 * Claim + dispatch a task to REFUSED. claimNextTask stamps the row's
 * assignedSessionId; the DISPATCH path (mesh-queue-assignment) is what opens the
 * attempt, so open it here the same way to reproduce the real post-dispatch state.
 */
function setupClaimedTask(meshId: string, nodeId: string) {
  enqueueTask(meshId, 'investigate the failure', { targetNodeId: nodeId,
    difficulty: 'medium',
})
  const claimed = claimNextTask(meshId, nodeId, REFUSED, [])!
  backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, claimed.id)!
  const { attempt } = openTurnAttempt({
    meshId, taskId: claimed.id,
    dispatchNonce: entry.dispatchNonce ?? 0,
    nodeId, sessionId: REFUSED, providerType: 'claude-cli',
  })
  entry.attemptId = attempt.attemptId
  store.updateQueueEntry(entry)
  createSessionDelivery({
    meshId, nodeId, sessionId: REFUSED, taskId: claimed.id,
    kind: 'task', message: 'investigate the failure', status: 'delivered',
  })
  return claimed
}

/**
 * Two live sessions on one node: HOLDER is mid-turn (generating, transcript full of
 * post-dispatch work), REFUSED is parked and idle with an EMPTY transcript — exactly
 * the "idle with 0 messages" the incident logged. Which of the two the watchdog reads
 * is the entire question.
 */
function makeTwoSessionComponents(meshId: string, nodeId: string) {
  const mkInstance = (sessionId: string, status: string) => ({
    category: 'cli',
    provider: { type: 'claude-cli' },
    getState: () => ({
      instanceId: sessionId,
      status,
      type: 'claude-cli',
      settings: { meshNodeFor: meshId, meshNodeId: nodeId },
    }),
  })
  const holder = mkInstance(HOLDER, 'generating')
  const refused = mkInstance(REFUSED, 'idle')

  const readSessions: string[] = []
  const handle = vi.fn(async (cmd: string, args?: any) => {
    if (cmd !== 'read_chat') return { success: true }
    const sid = args?.sessionId ?? args?.targetSessionId
    readSessions.push(sid)
    if (sid === HOLDER) {
      // The real holder: generating, with post-dispatch agent work in flight.
      const base = Date.now() - UNCONSUMED_MS
      return {
        success: true, status: 'generating', messages: [
          { role: 'user', content: 'investigate the failure', timestamp: base + 300 },
          { role: 'assistant', content: 'Let me check the reconcile loop…', timestamp: base + 4_000 },
          { role: 'assistant', content: '', kind: 'tool', timestamp: base + 6_000 },
        ],
      }
    }
    // The refused session: present, parked, running nothing — "idle with 0 messages".
    return { success: true, status: 'idle', messages: [] }
  })

  const components = {
    instanceManager: {
      getByCategory: (c: string) => (c === 'cli' ? [holder, refused] : []),
      getInstance: (id: string) => (id === HOLDER ? holder : id === REFUSED ? refused : undefined),
    },
    commandHandler: { handle },
  } as any
  const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
  meshConfigMocks.listMeshes.mockReturnValue([mesh])
  meshConfigMocks.getMesh.mockReturnValue(mesh)
  return { components, mesh, readSessions }
}

describe('DUP-CLAIM-REBIND rc.35 — the watchdogs must read the ATTEMPT session, not the claim-time row stamp', () => {
  describe('resolveTaskEvidenceSessionId — the resolution rule itself', () => {
    it('★1 prefers the REBOUND attempt session over the row stamp (the defect)', () => {
      const meshId = `mesh_resolve_${Date.now()}`
      try {
        const claimed = setupReboundTask(meshId, 'node_w')
        const row = getQueue(meshId).find(t => t.id === claimed.id)!

        // The row is deliberately NOT rewritten — it still records the claim-time fact.
        expect(row.assignedSessionId).toBe(REFUSED)
        // …but the effective evidence session follows the attempt.
        expect(resolveTaskEvidenceSessionId(meshId, claimed.id, row.assignedSessionId)).toBe(HOLDER)
      } finally { cleanup(meshId) }
    })

    it('★2 falls back to the row when the task has NO attempt (legacy/pre-Stage-5 row)', () => {
      const meshId = `mesh_no_attempt_${Date.now()}`
      try {
        expect(resolveTaskEvidenceSessionId(meshId, 'task-never-opened', REFUSED)).toBe(REFUSED)
      } finally { cleanup(meshId) }
    })

    it('★3 falls back to the row when the attempt is TERMINAL (settled → its session is history)', () => {
      const meshId = `mesh_terminal_${Date.now()}`
      const taskId = 'task-terminal'
      try {
        openTurnAttempt({ meshId, taskId, dispatchNonce: 1, nodeId: 'node_w', sessionId: HOLDER })
        closeAttemptForReassignment({ meshId, taskId, reason: 'dispatch_failed' })

        // Even though the (now terminal) attempt names HOLDER, the row wins.
        expect(resolveTaskEvidenceSessionId(meshId, taskId, REFUSED)).toBe(REFUSED)
      } finally { cleanup(meshId) }
    })

    it('★4 is byte-identical on the never-rebound path (attempt session === row stamp)', () => {
      const meshId = `mesh_normal_${Date.now()}`
      try {
        enqueueTask(meshId, 'ordinary task', { targetNodeId: 'node_w',
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, 'node_w', HOLDER, [])!
        const row = getQueue(meshId).find(t => t.id === claimed.id)!

        expect(row.assignedSessionId).toBe(HOLDER)
        expect(resolveTaskEvidenceSessionId(meshId, claimed.id, row.assignedSessionId)).toBe(HOLDER)
      } finally { cleanup(meshId) }
    })

    it('returns the row value unchanged when the attempt carries no bound session', () => {
      const meshId = `mesh_unbound_${Date.now()}`
      const taskId = 'task-unbound'
      try {
        openTurnAttempt({ meshId, taskId, dispatchNonce: 1, nodeId: 'node_w' })
        expect(resolveTaskEvidenceSessionId(meshId, taskId, REFUSED)).toBe(REFUSED)
      } finally { cleanup(meshId) }
    })

    it('returns undefined when neither the attempt nor the row names a session', () => {
      const meshId = `mesh_none_${Date.now()}`
      try {
        expect(resolveTaskEvidenceSessionId(meshId, 'task-x', undefined)).toBeUndefined()
        expect(resolveTaskEvidenceSessionId(meshId, 'task-x', '   ')).toBeUndefined()
      } finally { cleanup(meshId) }
    })
  })

  describe('★1 regression — the poll must query the HOLDER, not the refused session', () => {
    it('polls the rebound holder and reads its real (mid-turn) transcript', async () => {
      const meshId = `mesh_poll_${Date.now()}`
      const nodeId = 'node_w'
      try {
        const claimed = setupReboundTask(meshId, nodeId)
        const { components, mesh, readSessions } = makeTwoSessionComponents(meshId, nodeId)
        const row = getQueue(meshId).find(t => t.id === claimed.id)!

        const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)

        // THE regression assertion: the transcript read went to the holder.
        // Pre-fix this read REFUSED and got "idle with 0 messages".
        expect(readSessions).toContain(HOLDER)
        expect(readSessions).not.toContain(REFUSED)
        // The holder is generating → not a turn-end → no completion synthesized.
        expect(evidence).toBeNull()
      } finally { cleanup(meshId) }
    })
  })

  describe('★1 regression — the redrive must NOT fire against a rebound, actively-generating holder', () => {
    it('does not re-drive or cancel the attempt while the holder is mid-turn', async () => {
      const meshId = `mesh_redrive_${Date.now()}`
      const nodeId = 'node_w'
      try {
        const claimed = setupReboundTask(meshId, nodeId)
        const { components } = makeTwoSessionComponents(meshId, nodeId)
        const attemptBefore = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, claimed.id)!

        // Several ticks — pre-fix, the IDLE_CONFIRMED verdict read off REFUSED fired the
        // redrive and closed the attempt as cancelled(source=reassignment).
        for (let i = 0; i < 4; i++) await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')

        // The attempt survived, still open and still bound to the holder.
        const attemptAfter = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, claimed.id)!
        expect(attemptAfter.attemptId).toBe(attemptBefore.attemptId)
        expect(attemptAfter.terminalOutcome).toBeNull()
        expect(attemptAfter.sessionId).toBe(HOLDER)

        // And no reclaim/redrive was booked.
        expect(readLedgerEntries(meshId).some(
          e => e.kind === 'task_reclaimed'
            && (e.payload as any)?.reason === 'delivered_not_consumed_redrive',
        )).toBe(false)
      } finally { cleanup(meshId) }
    })
  })

  describe('★4 no-regression — an ordinary (never-rebound) idle row still re-drives', () => {
    it('re-drives a delivered-but-unconsumed row whose bound session is genuinely idle', async () => {
      const meshId = `mesh_normal_redrive_${Date.now()}`
      const nodeId = 'node_w'
      try {
        // No rebind: the row and the attempt both name REFUSED, which is idle and empty.
        setupClaimedTask(meshId, nodeId)
        const { components } = makeTwoSessionComponents(meshId, nodeId)

        for (let i = 0; i < 4; i++) await runMeshReconcileTick(components)

        // The redrive fires exactly as before this fix — the fail-safe path is untouched.
        expect(readLedgerEntries(meshId).some(
          e => e.kind === 'task_reclaimed'
            && (e.payload as any)?.reason === 'delivered_not_consumed_redrive',
        )).toBe(true)
      } finally { cleanup(meshId) }
    })
  })
})
