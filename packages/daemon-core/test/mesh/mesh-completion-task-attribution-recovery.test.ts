import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Per-file isolated config dir → per-file mesh-runtime.db, so this suite's turn
// tables never touch a sibling suite's rows (same convention as
// mesh-rebind-attempt-first-read.test.ts / mesh-duplicate-claim-attempt-rebind.test.ts).
const testTmpDir = path.join(tmpdir(), `adhdev-completion-attribution-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

import {
  openTurnAttempt,
  closeAttemptForReassignment,
  proposeTurnCompletion,
  recoverCompletionTaskIdForSession,
} from '../../src/mesh/mesh-turn-ledger.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

// The live incident (task 307f7b4e, node MoltBook, 2026-09-21 07:50:09Z):
//   WORKER = the session genuinely working the task. antigravity-cli is a
//            native-source `hold` provider ⇒ emitsPtyTurnEvents === false, so it
//            never emits agent:generating_started and the delivered-no-turn
//            watchdog's verdict is structurally reachable for it. The redrive
//            fired at 07:49:54 and — because emitsPtyTurnEvents is false —
//            stopStaleMeshWorker'd this very session. pushEvent's detach on the
//            resulting terminal event wiped the in-memory envelope
//            (currentTurnTaskId / settings.meshActiveTaskId), so the genuine
//            completion that flushed 15s later carried NO taskId at all.
const MESH = 'mesh-attribution-recovery'
const WORKER = '3f3a7a16-bb5c-4b72-8983-751c49e5b893'
const TASK = '307f7b4e-87f2-427d-abb7-fe945944b15a'

describe('COMPLETION-ATTRIBUTION-RECOVERY — recoverCompletionTaskIdForSession', () => {
  beforeEach(() => {
    fs.mkdirSync(testConfigDir, { recursive: true })
    __resetMeshRuntimeStoreForTests()
  })

  afterEach(() => {
    __resetMeshRuntimeStoreForTests()
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  // ── The defect this fix removes ────────────────────────────────────────────

  it('recovers the taskId from the live attempt bound to the completing session', () => {
    const opened = openTurnAttempt({
      meshId: MESH,
      taskId: TASK,
      sessionId: WORKER,
      nodeId: 'node_d82de0cef9b042b6948986609e32142f',
      providerType: 'antigravity-cli',
      dispatchNonce: 1,
    })

    const recovery = recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: WORKER })

    expect(recovery.recovered).toBe(true)
    expect(recovery).toMatchObject({
      recovered: true,
      taskId: TASK,
      attemptId: opened.attempt.attemptId,
      reason: 'attempt_bound_to_session',
    })
  })

  it('recovers after a duplicate-dispatch rebind pointed the attempt at the real holder', () => {
    // The row's claim-time assignedSessionId names the REFUSED session, but the
    // attempt was rebound onto the holder. The recovery must follow the ATTEMPT,
    // which is the binding that tracks who is genuinely working the task.
    const REFUSED = 'b7b6ccbf-87dc-467d-88c4-3c7e0c901adc'
    openTurnAttempt({
      meshId: MESH,
      taskId: TASK,
      sessionId: REFUSED,
      dispatchNonce: 1,
    })
    const store = MeshRuntimeStore.getInstance()
    const attempt = store.getCurrentTurnAttempt(MESH, TASK)!
    store.rebindTurnAttemptSession(attempt.attemptId, WORKER, new Date().toISOString())

    expect(recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: WORKER })).toMatchObject({
      recovered: true,
      taskId: TASK,
    })
    // And the session the attempt was rebound AWAY from no longer resolves.
    expect(recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: REFUSED })).toMatchObject({
      recovered: false,
      reason: 'no_attempt_for_session',
    })
  })

  // ── OVERCORRECTION CONTROL GROUP ───────────────────────────────────────────
  // A completion may legitimately carry no taskId. Attributing those would invent
  // a completion for a task nobody ran, so each must stay UNRECOVERED.

  it('CONTROL: a session that was never dispatched a task stays unattributed', () => {
    // The coordinator's own turn, an ad-hoc dashboard chat on a session whose mesh
    // membership survives detach, and a pre-dispatch boot/greeting artifact all
    // land here. This is the guard that keeps legitimately task-less completions
    // task-less.
    expect(recoverCompletionTaskIdForSession({
      meshId: MESH,
      sessionId: 'coordinator-own-session',
    })).toMatchObject({ recovered: false, reason: 'no_attempt_for_session' })
  })

  it('CONTROL: an already-settled attempt is never re-attributed', () => {
    openTurnAttempt({ meshId: MESH, taskId: TASK, sessionId: WORKER, dispatchNonce: 1 })
    const committed = proposeTurnCompletion({
      meshId: MESH,
      taskId: TASK,
      sessionId: WORKER,
      outcome: 'completed',
      source: 'provider_event',
    })
    expect(committed.committed).toBe(true)

    // A LATER task-less completion from the same session is a new, untracked turn —
    // not a late arrival for the settled task. Attributing it would let a follow-up
    // chat re-complete (or contradict) a finished task.
    expect(recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: WORKER })).toMatchObject({
      recovered: false,
      reason: 'attempt_terminal',
    })
  })

  it('CONTROL: a cancelled/reassigned attempt is never re-attributed', () => {
    openTurnAttempt({ meshId: MESH, taskId: TASK, sessionId: WORKER, dispatchNonce: 1 })
    closeAttemptForReassignment({ meshId: MESH, taskId: TASK, reason: 'delivered_not_consumed_redrive' })

    expect(recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: WORKER })).toMatchObject({
      recovered: false,
      reason: 'attempt_terminal',
    })
  })

  it('CONTROL: never attributes across a mesh boundary', () => {
    openTurnAttempt({ meshId: MESH, taskId: TASK, sessionId: WORKER, dispatchNonce: 1 })

    expect(recoverCompletionTaskIdForSession({
      meshId: 'a-different-mesh',
      sessionId: WORKER,
    })).toMatchObject({ recovered: false, reason: 'attempt_mesh_mismatch' })
  })

  it('CONTROL: an empty session id resolves nothing', () => {
    openTurnAttempt({ meshId: MESH, taskId: TASK, sessionId: WORKER, dispatchNonce: 1 })

    expect(recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: '   ' })).toMatchObject({
      recovered: false,
      reason: 'no_attempt_for_session',
    })
  })

  it('is read-only — recovering does not settle, stage or otherwise mutate the attempt', () => {
    const opened = openTurnAttempt({ meshId: MESH, taskId: TASK, sessionId: WORKER, dispatchNonce: 1 })
    const before = MeshRuntimeStore.getInstance().getTurnAttempt(opened.attempt.attemptId)

    recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: WORKER })
    recoverCompletionTaskIdForSession({ meshId: MESH, sessionId: WORKER })

    const after = MeshRuntimeStore.getInstance().getTurnAttempt(opened.attempt.attemptId)
    expect(after).toEqual(before)
    // The reducer still owns the terminal: a recovered id buys the completion a
    // fair hearing, never an exemption from causality.
    expect(after!.terminalOutcome).toBeNull()
  })
})
