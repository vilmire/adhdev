/**
 * F7 (wiring-unification live pass, preview rc.36): a REMOTE mesh worker's
 * `report_completion` was refused `unauthenticated` although its task was live.
 *
 * The worker's MCP reaches its LOCAL daemon, but the queue row, the turn attempt
 * and the minted task token all live on the OWNER (the coordinator daemon that
 * dispatched it). The worker daemon's only proof of the task is the assignment
 * stamp it wrote on receipt of the dispatch — so it now resolves the identity
 * from that stamp and relays the report to the owner, which re-resolves it
 * against its own state and accepts it through the same body a local report
 * takes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WORKER_PROGRESS_FORWARD_COMMAND,
  WORKER_REPORT_FORWARD_COMMAND,
  decodeForwardedWorkerProgress,
  decodeForwardedWorkerReport,
  workerReportHandlers,
  workerReportSpecs,
} from '../../src/commands/low-family/worker-report'
import {
  __resetReportedSummariesForTest,
  __setHandoffNoteSinkForTests,
  __setWorkerLateReportNoticeSinkForTests,
  acceptWorkerCompletionReport,
  WORKER_LATE_REPORT_GRACE_MS,
  WORKER_HANDOFF_EVENT_KIND,
  WORKER_PROGRESS_EVENT_KIND,
  WORKER_REPORT_EVENT_KIND,
  __resetProgressSurfaceForTest,
  __setWorkerProgressNoticeSinkForTests,
} from '../../src/mesh/worker-report'
import { __resetHandoffNotesForTest } from '../../src/mesh/worker-handoff-notes'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed'
import { LOG } from '../../src/logging/logger'

const WORKER_DAEMON = 'daemon_mach_worker_f7'
// The seed helper stamps every attempt `ownerDaemonId: 'test-daemon'` — the owner in these tests.
const OWNER_DAEMON = 'test-daemon'

let seq = 0
function freshIds() {
  seq += 1
  return {
    meshId: `mesh_f7_${seq}`,
    taskId: `task_f7_${seq}`,
    sessionId: `session_f7_${seq}`,
    nodeId: `node_f7_${seq}`,
  }
}

const REPORT = {
  outcome: 'completed',
  summary: 'Did the remote work.',
  handoffNotes: { intent: 'why it changed', touchedFiles: ['src/remote.ts'] },
}

/** The stamp `attachMeshAssignment` writes on the worker daemon when it receives a dispatch. */
function stampSettings(ids: ReturnType<typeof freshIds>, attemptId: string, owner = OWNER_DAEMON) {
  return {
    meshNodeFor: ids.meshId,
    meshNodeId: ids.nodeId,
    meshActiveTaskId: ids.taskId,
    meshActiveAttemptId: attemptId,
    meshActiveAttemptGeneration: 0,
    meshCoordinatorDaemonId: owner,
  }
}

function workerCtx(
  sessionId: string,
  settings: Record<string, unknown> | null,
  dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): any {
  return {
    deps: {
      statusInstanceId: WORKER_DAEMON,
      instanceManager: {
        getInstance: (id: string) => (id === sessionId && settings ? { getState: () => ({ settings }) } : undefined),
      },
      ...(dispatchMeshCommand ? { dispatchMeshCommand } : {}),
    },
  }
}

/**
 * The owner's mesh roster (rc.37 Finding A): the forwarded path authorises on
 * "the sender daemon owns the node the owner assigned the task to", so every
 * seeded task's node is registered here as belonging to WORKER_DAEMON.
 */
const roster = new Map<string, Array<{ id: string; daemonId: string }>>()
function registerNode(meshId: string, nodeId: string, daemonId = WORKER_DAEMON) {
  const nodes = roster.get(meshId) ?? []
  nodes.push({ id: nodeId, daemonId })
  roster.set(meshId, nodes)
}

const ownerCtx: any = {
  deps: { statusInstanceId: OWNER_DAEMON, instanceManager: { getInstance: () => undefined } },
  getMeshForCommand: async (meshId: string) => ({ mesh: { id: meshId, nodes: roster.get(meshId) ?? [] }, inline: true, source: 'inline_cache' }),
}

/**
 * What the owner's mesh transport hands the handler: the relayed args plus the
 * authenticated sender (`_meshSenderDaemonId`, stamped by daemon-cloud's
 * handleMeshCommand — never taken from the peer's payload).
 */
function ownerRelay(sender = WORKER_DAEMON) {
  return vi.fn((_d: string, cmd: string, args: Record<string, unknown>) =>
    workerReportHandlers[cmd](ownerCtx, { ...args, _meshSenderDaemonId: sender }))
}

/** Owner-side state for a live task: assigned queue row, open attempt, minted token. */
function seedOwnerLiveTask(ids: ReturnType<typeof freshIds>): string {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: ids.taskId,
    meshId: ids.meshId,
    message: 'do the remote thing',
    status: 'assigned',
    assignedSessionId: ids.sessionId,
    assignedNodeId: ids.nodeId,
    createdAt: now,
    updatedAt: now,
  } as any)
  const attempt = seedMeshAttempt({ meshId: ids.meshId, taskId: ids.taskId, sessionId: ids.sessionId, nodeId: ids.nodeId, scope: 'mesh_direct', stage: 'consumed' })
  mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId: attempt.attemptId, sessionId: ids.sessionId, nodeId: ids.nodeId })
  registerNode(ids.meshId, ids.nodeId)
  return attempt.attemptId
}

/** Owner-side state for a task the ledger terminalized `agoMs` ago: completed queue row, terminal attempt, no token. */
function seedOwnerTerminalTask(ids: ReturnType<typeof freshIds>, agoMs: number): string {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: ids.taskId, meshId: ids.meshId, message: 'done already', status: 'completed',
    assignedSessionId: ids.sessionId, assignedNodeId: ids.nodeId, createdAt: now, updatedAt: now,
  } as any)
  const attempt = seedMeshAttempt({
    meshId: ids.meshId, taskId: ids.taskId, sessionId: ids.sessionId, nodeId: ids.nodeId,
    scope: 'mesh_direct', stage: 'completed', nowMs: Date.now() - agoMs,
  })
  registerNode(ids.meshId, ids.nodeId)
  return attempt.attemptId
}

function workerEventKinds(meshId: string, taskId: string): string[] {
  const turns = MeshRuntimeStore.getInstance().turnStore()
  return [WORKER_REPORT_EVENT_KIND, WORKER_HANDOFF_EVENT_KIND]
    .filter((kind) => turns.listWorkerEventsForTask(meshId, taskId, kind).length > 0)
}

let sinkCalls: Array<{ meshId: string; taskId: string }> = []
let lateNotices: Array<{ taskId: string; attemptId: string; coordinatorMessage: string }> = []

beforeEach(() => {
  __resetReportedSummariesForTest()
  __resetHandoffNotesForTest()
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  sinkCalls = []
  lateNotices = []
  __setHandoffNoteSinkForTests((note) => { sinkCalls.push({ meshId: note.meshId, taskId: note.taskId }) })
  __setWorkerLateReportNoticeSinkForTests((n) => { lateNotices.push({ taskId: n.taskId, attemptId: n.attemptId, coordinatorMessage: n.coordinatorMessage }) })
})
afterEach(() => {
  __setHandoffNoteSinkForTests(undefined)
  __setWorkerLateReportNoticeSinkForTests(undefined)
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
})

describe('F7 — worker daemon: remote-owned task', () => {
  it('(a) resolves identity from the assignment stamp and relays the report to the owner, writing nothing locally', async () => {
    const ids = freshIds()
    const attemptId = `mesh_direct:${ids.taskId}`
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const relay = vi.fn(async () => ({ success: true, taskId: ids.taskId, attemptId, outcome: 'completed', duplicate: false, handoffNoteRecorded: true }))

    const res: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, attemptId), relay),
      { bind, report: REPORT },
    )

    expect(res.success).toBe(true)
    expect(res.handoffNoteRecorded).toBe(true)
    expect(relay).toHaveBeenCalledTimes(1)
    const [daemonId, cmd, args] = relay.mock.calls[0] as unknown as [string, string, Record<string, any>]
    expect(daemonId).toBe(OWNER_DAEMON)
    expect(cmd).toBe(WORKER_REPORT_FORWARD_COMMAND)
    expect(args).toEqual({
      meshId: ids.meshId,
      taskId: ids.taskId,
      attemptId,
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      report: REPORT,
    })
    // Nothing on the worker daemon: the owner is the only writer.
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([])
    expect(sinkCalls).toEqual([])
  })

  it('worker_resolve_task answers for a remote-owned task too', async () => {
    const ids = freshIds()
    const attemptId = `mesh_direct:${ids.taskId}`
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const res: any = await workerReportHandlers.worker_resolve_task(workerCtx(ids.sessionId, stampSettings(ids, attemptId)), { bind })
    expect(res).toMatchObject({ success: true, meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId })
  })

  it('(b) no stamp and no local attempt → still refused, nothing relayed', async () => {
    const ids = freshIds()
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const relay = vi.fn(async () => ({ success: true }))
    const res: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, { meshNodeFor: ids.meshId }, relay),
      { bind, report: REPORT },
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('unauthenticated')
    expect(relay).not.toHaveBeenCalled()
  })

  it('refuses a stamp that names no owner, another mesh, or this daemon as owner', async () => {
    const ids = freshIds()
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const relay = vi.fn(async () => ({ success: true }))
    const { meshCoordinatorDaemonId: _drop, ...noOwner } = stampSettings(ids, 'a1')
    for (const settings of [
      noOwner,
      { ...stampSettings(ids, 'a1'), meshNodeFor: 'mesh_other' },
      stampSettings(ids, 'a1', WORKER_DAEMON),
      // A different form of our own id is still us (canon identity).
      stampSettings(ids, 'a1', 'mach_worker_f7'),
    ]) {
      const res: any = await workerReportHandlers.worker_report_completion(workerCtx(ids.sessionId, settings, relay), { bind, report: REPORT })
      expect(res.success).toBe(false)
      expect(res.error).toBe('unauthenticated')
    }
    // An unknown bind with a perfect stamp is refused too.
    const res: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, 'a1'), relay),
      { bind: 'wsb_not_a_real_bind', report: REPORT },
    )
    expect(res.error).toBe('unauthenticated')
    expect(relay).not.toHaveBeenCalled()
  })

  it('a relay failure is reported as forward_failed, never as success', async () => {
    const ids = freshIds()
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const relay = vi.fn(async () => { throw new Error('PEER_NOT_CONNECTED') })
    const res: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, 'a1'), relay),
      { bind, report: REPORT },
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('forward_failed')
    expect(res.detail).toMatch(/PEER_NOT_CONNECTED/)
  })
})

describe('F7 — owner daemon: forwarded report', () => {
  it('(c) records exactly what a local report records (oracle: acceptWorkerCompletionReport)', async () => {
    // Oracle: a LOCAL report on a live task.
    const local = freshIds()
    const localAttempt = seedOwnerLiveTask(local)
    const localToken = mintWorkerTaskToken({ meshId: local.meshId, taskId: local.taskId, attemptId: localAttempt, sessionId: local.sessionId, nodeId: local.nodeId })
    const oracle: any = acceptWorkerCompletionReport({ token: localToken.token }, REPORT as any)
    expect(oracle.accepted).toBe(true)
    const oracleKinds = workerEventKinds(local.meshId, local.taskId)
    expect(oracleKinds).toEqual([WORKER_REPORT_EVENT_KIND, WORKER_HANDOFF_EVENT_KIND])

    // The forwarded report, relayed with the router-internal marker attached.
    const ids = freshIds()
    const attemptId = seedOwnerLiveTask(ids)
    const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, {
      meshId: ids.meshId,
      taskId: ids.taskId,
      attemptId,
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      report: REPORT,
      _meshDirectDispatch: true,
      _meshSenderDaemonId: WORKER_DAEMON,
    })
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, attemptId, outcome: 'completed', duplicate: false, handoffNoteRecorded: true })
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual(oracleKinds)
    // The handoff note TEXT went to the content sink (mesh.<id>.handoff in production), once per report.
    expect(sinkCalls.map((c) => c.taskId)).toEqual([local.taskId, ids.taskId])
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(ids.meshId, ids.taskId)?.status).toBe('completed')
  })

  it('end to end: worker daemon relay → owner handler accepts', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTask(ids)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const toOwner = ownerRelay()
    const relay = vi.fn((d: string, cmd: string, args: Record<string, unknown>) => toOwner(d, cmd, args).then((result) => ({ result })))
    const res: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, attemptId), relay),
      { bind, report: REPORT },
    )
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, attemptId, handoffNoteRecorded: true })
  })

  it('(d) a stale stamp for a task terminal BEYOND the grace window is refused by the owner', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerTerminalTask(ids, WORKER_LATE_REPORT_GRACE_MS + 60_000)
    // The terminal chokepoint expired the token; the worker daemon still carries the stamp.
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const relay = ownerRelay()
    const res: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, attemptId), relay),
      { bind, report: REPORT },
    )
    expect(relay).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(false)
    expect(res.error).toBe('unauthenticated')
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([])
    expect(lateNotices).toEqual([])
  })

  it('refuses a claim whose attempt or task disagrees with the owner state', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTask(ids)
    const base = { meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId, report: REPORT, _meshSenderDaemonId: WORKER_DAEMON }
    for (const claim of [
      { ...base, attemptId: 'mesh_direct:superseded' },
      { ...base, taskId: 'task_somebody_else' },
      { ...base, sessionId: 'session_somebody_else' },
    ]) {
      const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, claim)
      expect(res.success).toBe(false)
      expect(res.error).toBe('unauthenticated')
    }
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([])
  })

  it('decodes strictly and validates the report like a local one', async () => {
    const good = { meshId: 'm', taskId: 't', attemptId: 'a', sessionId: 's', report: REPORT }
    expect(decodeForwardedWorkerReport(good)).not.toBeNull()
    expect(decodeForwardedWorkerReport({ ...good, _interactionId: 'x' })).not.toBeNull()
    expect(decodeForwardedWorkerReport({ ...good, token: 'wtk_x' })).toBeNull()
    expect(decodeForwardedWorkerReport({ ...good, attemptId: '' })).toBeNull()
    expect(decodeForwardedWorkerReport({ ...good, report: 'text' })).toBeNull()
    const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, { ...good, report: { outcome: 'done' } })
    expect(res.error).toBe('invalid_report')
  })

  it('is accepted only from the mesh relay source', () => {
    const spec = workerReportSpecs.find((s) => s.name === WORKER_REPORT_FORWARD_COMMAND)
    expect(spec?.sources).toEqual(['mesh'])
  })
})

describe('rc.37 Finding A — owner authorises a forwarded report without the worker token', () => {
  /** Owner state exactly as the live DB had it: assigned direct row naming the session + node, open attempt, NO token here. */
  function seedOwnerLiveTaskWithoutToken(ids: ReturnType<typeof freshIds>): string {
    const attemptId = seedOwnerLiveTask(ids)
    // The token is minted where the attempt opens and never reaches the remote
    // worker — model the owner losing it too (restart / never minted) so the
    // test proves acceptance does not depend on it.
    __resetWorkerTaskTokensForTest()
    return attemptId
  }

  it('★accepts on the owner row + sender-owns-node + agreeing task/attempt, with no token present', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTaskWithoutToken(ids)
    const info = vi.spyOn(LOG, 'info')
    const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, {
      meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId, nodeId: ids.nodeId,
      report: REPORT, _meshDirectDispatch: true, _meshSenderDaemonId: WORKER_DAEMON,
    })
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, attemptId, outcome: 'completed', handoffNoteRecorded: true })
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([WORKER_REPORT_EVENT_KIND, WORKER_HANDOFF_EVENT_KIND])
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(ids.meshId, ids.taskId)?.status).toBe('completed')
    const forwardedLines = info.mock.calls.filter(([cat, msg]) => cat === 'WorkerReport' && String(msg).startsWith('Forwarded'))
    expect(forwardedLines).toHaveLength(1)
    expect(String(forwardedLines[0][1])).toMatch(new RegExp(`accepted as task ${ids.taskId}`))
    info.mockRestore()
  })

  it('a claim WITHOUT task/attempt (released stamp) resolves to the session\'s live row', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTaskWithoutToken(ids)
    const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, {
      meshId: ids.meshId, sessionId: ids.sessionId, report: REPORT, _meshSenderDaemonId: WORKER_DAEMON,
    })
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, attemptId })
  })

  it('★LIVE SHAPE: a clobbered stamp naming an UNCLAIMED task is refused loudly with the owner\'s view, and nothing is recorded', async () => {
    const ids = freshIds()
    seedOwnerLiveTaskWithoutToken(ids)
    // Task 2: enqueued, pinned to the same node, never claimed (the eager push delivered it anyway).
    const now = new Date().toISOString()
    MeshRuntimeStore.getInstance().insertQueueEntry({
      id: `${ids.taskId}_second`, meshId: ids.meshId, message: 'second', status: 'pending',
      targetNodeId: ids.nodeId, createdAt: now, updatedAt: now,
    } as any)
    const warn = vi.spyOn(LOG, 'warn')
    const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, {
      meshId: ids.meshId, taskId: `${ids.taskId}_second`, sessionId: ids.sessionId, nodeId: ids.nodeId,
      report: REPORT, _meshSenderDaemonId: WORKER_DAEMON,
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('unauthenticated')
    expect(res.detail).toMatch(/^task_mismatch: /)
    expect(res.detail).toContain(`the owner has task ${ids.taskId} assigned to session ${ids.sessionId}`)
    expect(res.detail).toContain('is pending on the owner, never claimed by a session')
    // Not re-pointed at the live task: that would commit it with another body's summary.
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([])
    expect(workerEventKinds(ids.meshId, `${ids.taskId}_second`)).toEqual([])
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(ids.meshId, ids.taskId)?.status).toBe('assigned')
    const lines = warn.mock.calls.filter(([cat, msg]) => cat === 'WorkerReport' && String(msg).startsWith('Forwarded'))
    expect(lines).toHaveLength(1)
    expect(String(lines[0][1])).toMatch(/refused unauthenticated — task_mismatch/)
    warn.mockRestore()
  })

  it('refuses a sender that does not own the node, an unidentified sender, and a node off the roster', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTaskWithoutToken(ids)
    const claim = { meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId, report: REPORT }

    const other: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, { ...claim, _meshSenderDaemonId: 'daemon_mach_someone_else' })
    expect(other.detail).toMatch(/^sender_not_node_owner: /)

    const anon: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, claim)
    expect(anon.detail).toMatch(/^sender_unknown: /)

    roster.set(ids.meshId, [])
    const offRoster: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, { ...claim, _meshSenderDaemonId: WORKER_DAEMON })
    expect(offRoster.detail).toMatch(/^node_unresolved: /)

    for (const r of [other, anon, offRoster]) expect(r.success).toBe(false)
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([])
  })

  it('accepts a legacy-form sender id for the node\'s daemon (canon identity)', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTaskWithoutToken(ids)
    const res: any = await workerReportHandlers[WORKER_REPORT_FORWARD_COMMAND](ownerCtx, {
      meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId, report: REPORT,
      _meshSenderDaemonId: 'mach_worker_f7',
    })
    expect(res.success).toBe(true)
  })

  it('the worker daemon surfaces the owner\'s refusal reason (no bare "attempt ?/unauthenticated")', async () => {
    const ids = freshIds()
    seedOwnerLiveTaskWithoutToken(ids)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const clobbered = { ...stampSettings(ids, 'x'), meshActiveTaskId: `${ids.taskId}_second` }
    delete (clobbered as any).meshActiveAttemptId
    const res: any = await workerReportHandlers.worker_report_completion(workerCtx(ids.sessionId, clobbered, ownerRelay()), { bind, report: REPORT })
    expect(res.success).toBe(false)
    expect(res.detail).toMatch(/^(task_mismatch|no_live_task): /)
  })
})

describe('F7b — late report against a recently-terminal attempt', () => {
  it('local: accepted within grace, recorded as evidence, ONE late notice, no state change', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerTerminalTask(ids, 60_000)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const res: any = await workerReportHandlers.worker_report_completion(ownerCtx, { bind, report: REPORT })
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, attemptId, outcome: 'completed', duplicate: false, handoffNoteRecorded: true, late: true, terminalOutcome: 'completed' })
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([WORKER_REPORT_EVENT_KIND, WORKER_HANDOFF_EVENT_KIND])
    const row = MeshRuntimeStore.getInstance().turnStore().listWorkerEventsForTask(ids.meshId, ids.taskId, WORKER_REPORT_EVENT_KIND)[0]
    expect(row.attemptId).toBe(attemptId)
    expect((row.payload as any).late).toBe(true)
    expect(sinkCalls.map((c) => c.taskId)).toEqual([ids.taskId])
    expect(lateNotices).toHaveLength(1)
    expect(lateNotices[0]).toMatchObject({ taskId: ids.taskId, attemptId })
    expect(lateNotices[0].coordinatorMessage).toContain('Did the remote work.')
    // The ledger's terminal is untouched.
    const attempt = MeshRuntimeStore.getInstance().turnStore().getAttempt(attemptId)
    expect(attempt?.terminal?.outcome).toBe('completed')
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(ids.meshId, ids.taskId)?.status).toBe('completed')

    // A re-call is an idempotent duplicate — still exactly one notice.
    const again: any = await workerReportHandlers.worker_report_completion(ownerCtx, { bind, report: REPORT })
    expect(again).toMatchObject({ success: true, duplicate: true, late: true })
    expect(lateNotices).toHaveLength(1)
    expect(sinkCalls).toHaveLength(1)
  })

  it('local: a different reported outcome is recorded and flagged, never flips the terminal', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerTerminalTask(ids, 30_000)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const res: any = await workerReportHandlers.worker_report_completion(ownerCtx, {
      bind, report: { outcome: 'blocked', summary: 'Could not finish.', blockers: ['missing creds'] },
    })
    expect(res).toMatchObject({ success: true, outcome: 'blocked', late: true, terminalOutcome: 'completed' })
    expect(lateNotices[0].coordinatorMessage).toMatch(/differs from the recorded terminal/)
    expect(MeshRuntimeStore.getInstance().turnStore().getAttempt(attemptId)?.terminal?.outcome).toBe('completed')
  })

  it('local: refused beyond the grace window', async () => {
    const ids = freshIds()
    seedOwnerTerminalTask(ids, WORKER_LATE_REPORT_GRACE_MS + 1_000)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const res: any = await workerReportHandlers.worker_report_completion(ownerCtx, { bind, report: REPORT })
    expect(res.success).toBe(false)
    expect(res.error).toBe('unauthenticated')
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([])
    expect(lateNotices).toEqual([])
  })

  it('local: refused when a retry superseded the terminal attempt', async () => {
    const ids = freshIds()
    seedOwnerTerminalTask(ids, 30_000)
    // The task was retried on ANOTHER session: this session's attempt is no longer current.
    seedMeshAttempt({ meshId: ids.meshId, taskId: ids.taskId, sessionId: `${ids.sessionId}_retry`, scope: 'mesh_direct', attemptNo: 1, stage: 'consumed' })
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const res: any = await workerReportHandlers.worker_report_completion(ownerCtx, { bind, report: REPORT })
    expect(res.error).toBe('unauthenticated')
    expect(lateNotices).toEqual([])
  })

  it('remote: a released stamp (membership only) is forwarded and the owner accepts it late', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerTerminalTask(ids, 4_000)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    // After the owner committed: attempt ref released, task marker detached, membership kept.
    const released = { meshNodeFor: ids.meshId, meshLastNodeId: ids.nodeId, meshCoordinatorDaemonId: OWNER_DAEMON, launchedByCoordinator: true }
    const relay = ownerRelay()
    const res: any = await workerReportHandlers.worker_report_completion(workerCtx(ids.sessionId, released, relay), { bind, report: REPORT })
    expect(relay).toHaveBeenCalledTimes(1)
    const args = (relay.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]
    expect(args).not.toHaveProperty('attemptId')
    expect(args).not.toHaveProperty('taskId')
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, attemptId, late: true, handoffNoteRecorded: true })
    expect(workerEventKinds(ids.meshId, ids.taskId)).toEqual([WORKER_REPORT_EVENT_KIND, WORKER_HANDOFF_EVENT_KIND])
    expect(lateNotices).toHaveLength(1)
  })

  it('remote: a stamp naming the terminal attempt is accepted late; one naming another attempt is refused', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerTerminalTask(ids, 4_000)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const relay = ownerRelay()
    const wrong: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, 'mesh_direct:someone_else'), relay), { bind, report: REPORT })
    expect(wrong.error).toBe('unauthenticated')
    const ok: any = await workerReportHandlers.worker_report_completion(
      workerCtx(ids.sessionId, stampSettings(ids, attemptId), relay), { bind, report: REPORT })
    expect(ok).toMatchObject({ success: true, attemptId, late: true })
    expect(lateNotices).toHaveLength(1)
  })

  it('remote: refused beyond the grace window', async () => {
    const ids = freshIds()
    seedOwnerTerminalTask(ids, WORKER_LATE_REPORT_GRACE_MS + 1_000)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId }).bind
    const released = { meshNodeFor: ids.meshId, meshCoordinatorDaemonId: OWNER_DAEMON }
    const relay = ownerRelay()
    const res: any = await workerReportHandlers.worker_report_completion(workerCtx(ids.sessionId, released, relay), { bind, report: REPORT })
    expect(relay).toHaveBeenCalledTimes(1)
    expect(res.error).toBe('unauthenticated')
    expect(lateNotices).toEqual([])
  })
})

describe('F7b — late-report notice routing', () => {
  it('is a unicast coordinator alert', async () => {
    const { defaultScopeForEvent } = await import('../../src/mesh/contracts')
    const { WORKER_LATE_REPORT_EVENT_NAME } = await import('../../src/mesh/worker-report')
    expect(defaultScopeForEvent(WORKER_LATE_REPORT_EVENT_NAME)).toBe('unicast')
  })
})

describe('F7 progress axis — a remote worker\'s progress note is forwarded to the owner', () => {
  const NOTE = 'Finished the schema migration; now rewriting the three consumers of the old table.'
  let progressNotices: Array<{ taskId: string; note: string }> = []
  beforeEach(() => {
    __resetProgressSurfaceForTest()
    progressNotices = []
    __setWorkerProgressNoticeSinkForTests((n) => { progressNotices.push({ taskId: n.taskId, note: n.note }) })
  })
  afterEach(() => { __setWorkerProgressNoticeSinkForTests(undefined) })

  function progressRows(meshId: string, taskId: string) {
    return MeshRuntimeStore.getInstance().turnStore().listWorkerEventsForTask(meshId, taskId, WORKER_PROGRESS_EVENT_KIND)
  }

  it('★worker daemon relays the note; the owner records it on its attempt and surfaces it', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTask(ids)
    __resetWorkerTaskTokensForTest() // the owner authorises without the token (Finding A)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const relay = ownerRelay()
    const res: any = await workerReportHandlers.worker_progress_update(
      workerCtx(ids.sessionId, stampSettings(ids, attemptId), relay),
      { bind, note: NOTE },
    )
    expect(relay).toHaveBeenCalledTimes(1)
    const [daemonId, cmd, args] = relay.mock.calls[0] as unknown as [string, string, Record<string, any>]
    expect(daemonId).toBe(OWNER_DAEMON)
    expect(cmd).toBe(WORKER_PROGRESS_FORWARD_COMMAND)
    expect(args).toEqual({ meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId, nodeId: ids.nodeId, note: NOTE })
    expect(res).toMatchObject({ success: true, taskId: ids.taskId, surfacedToCoordinator: true })
    const rows = progressRows(ids.meshId, ids.taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0].attemptId).toBe(attemptId)
    expect(progressNotices).toEqual([{ taskId: ids.taskId, note: NOTE }])
  })

  it('owner refuses a sender that does not own the node (one WARN line), records nothing', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTask(ids)
    const warn = vi.spyOn(LOG, 'warn')
    const res: any = await workerReportHandlers[WORKER_PROGRESS_FORWARD_COMMAND](ownerCtx, {
      meshId: ids.meshId, taskId: ids.taskId, attemptId, sessionId: ids.sessionId, note: NOTE,
      _meshSenderDaemonId: 'daemon_mach_someone_else',
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('unauthenticated')
    expect(res.detail).toMatch(/^sender_not_node_owner: /)
    expect(progressRows(ids.meshId, ids.taskId)).toEqual([])
    const lines = warn.mock.calls.filter(([cat, msg]) => cat === 'WorkerReport' && String(msg).startsWith('Forwarded progress note'))
    expect(lines).toHaveLength(1)
    expect(String(lines[0][1])).toMatch(/refused unauthenticated — sender_not_node_owner/)
    warn.mockRestore()
  })

  it('owner refuses when it holds no row for the session (no_live_task), and after the attempt went terminal', async () => {
    const none = freshIds()
    registerNode(none.meshId, none.nodeId)
    const noRow: any = await workerReportHandlers[WORKER_PROGRESS_FORWARD_COMMAND](ownerCtx, {
      meshId: none.meshId, sessionId: none.sessionId, note: NOTE, _meshSenderDaemonId: WORKER_DAEMON,
    })
    expect(noRow.success).toBe(false)
    expect(noRow.detail).toMatch(/^no_live_task: /)

    // Within the completion report's late grace — still no progress on a closed attempt.
    const late = freshIds()
    seedOwnerTerminalTask(late, 4_000)
    const lateRes: any = await workerReportHandlers[WORKER_PROGRESS_FORWARD_COMMAND](ownerCtx, {
      meshId: late.meshId, sessionId: late.sessionId, note: NOTE, _meshSenderDaemonId: WORKER_DAEMON,
    })
    expect(lateRes.success).toBe(false)
    expect(lateRes.detail).toMatch(/^no_live_task: .*already ended \(completed\)/)
    expect(progressRows(late.meshId, late.taskId)).toEqual([])
    expect(progressNotices).toEqual([])
  })

  it('worker daemon surfaces the owner\'s refusal reason', async () => {
    const ids = freshIds()
    registerNode(ids.meshId, ids.nodeId)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const res: any = await workerReportHandlers.worker_progress_update(
      workerCtx(ids.sessionId, stampSettings(ids, 'a1'), ownerRelay()), { bind, note: NOTE })
    expect(res.success).toBe(false)
    expect(res.error).toBe('unauthenticated')
    expect(res.detail).toMatch(/^no_live_task: /)
  })

  it('decodes strictly and is accepted only from the mesh relay source', async () => {
    const good = { meshId: 'm', taskId: 't', attemptId: 'a', sessionId: 's', nodeId: 'n', note: 'hello' }
    expect(decodeForwardedWorkerProgress(good)).toEqual({ claim: { meshId: 'm', taskId: 't', attemptId: 'a', sessionId: 's' }, note: 'hello' })
    expect(decodeForwardedWorkerProgress({ ...good, _meshSenderDaemonId: 'x' })).not.toBeNull()
    expect(decodeForwardedWorkerProgress({ ...good, token: 'wtk_x' })).toBeNull()
    expect(decodeForwardedWorkerProgress({ ...good, report: {} })).toBeNull()
    expect(decodeForwardedWorkerProgress({ ...good, note: '   ' })).toBeNull()
    expect(decodeForwardedWorkerProgress({ ...good, note: 42 })).toBeNull()
    expect(decodeForwardedWorkerProgress({ ...good, sessionId: '' })).toBeNull()
    // The report decoder does not accept a note either (the two shapes stay disjoint).
    expect(decodeForwardedWorkerReport({ ...good, report: REPORT })).toBeNull()
    const res: any = await workerReportHandlers[WORKER_PROGRESS_FORWARD_COMMAND](ownerCtx, { ...good, extra: 1 })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/request failed decode/)
    const spec = workerReportSpecs.find((s) => s.name === WORKER_PROGRESS_FORWARD_COMMAND)
    expect(spec?.sources).toEqual(['mesh'])
  })

  it('a local worker\'s progress note is still recorded locally (no relay)', async () => {
    const ids = freshIds()
    const attemptId = seedOwnerLiveTask(ids)
    const bind = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId, nodeId: ids.nodeId }).bind
    const relay = vi.fn(async () => ({ success: true }))
    const ctx = { ...ownerCtx, deps: { ...ownerCtx.deps, dispatchMeshCommand: relay } }
    const res: any = await workerReportHandlers.worker_progress_update(ctx, { bind, note: NOTE })
    expect(res).toMatchObject({ success: true, taskId: ids.taskId })
    expect(relay).not.toHaveBeenCalled()
    expect(progressRows(ids.meshId, ids.taskId).map((r) => r.attemptId)).toEqual([attemptId])
  })
})
