/**
 * Durable worker-report delivery — the DAEMON half (missions d5ed7a7b / 62bbb95c / 4dc23885).
 *
 * Under daemon overload a worker's `report_completion` IPC call timed out three times in a
 * row and a finished investigation never reached the coordinator. The mcp-server now keeps
 * reports in a durable outbox and re-sends them; that is only safe if the daemon:
 *
 *   1. recognises a re-send of a report it already accepted (`deliveryId`) and answers it
 *      from the replay record — exactly one ledger effect, one coordinator page; and
 *   2. files a report written BEFORE the session was handed its current task against the
 *      attempt that was live when it was written (`reportedAtMs`), never against the new task.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { workerReportHandlers } from '../../src/commands/low-family/worker-report'
import {
  __resetProgressSurfaceForTest,
  __resetReportedSummariesForTest,
  __setHandoffNoteSinkForTests,
  __setWorkerLateReportNoticeSinkForTests,
  __setWorkerProgressNoticeSinkForTests,
  WORKER_PROGRESS_EVENT_KIND,
  WORKER_REPORT_EVENT_KIND,
  WORKER_REPORT_MAX_DELIVERY_DELAY_MS,
} from '../../src/mesh/worker-report'
import { __resetWorkerDeliveryReplayForTests } from '../../src/mesh/worker-report-idempotency'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed'

const OWNER_DAEMON = 'test-daemon'
const ctx: any = { deps: { statusInstanceId: OWNER_DAEMON, instanceManager: { getInstance: () => undefined } } }

let seq = 0
function fresh() {
  seq += 1
  return { meshId: `mesh_dd_${seq}`, sessionId: `session_dd_${seq}`, nodeId: `node_dd_${seq}` }
}

function seedLiveTask(meshId: string, sessionId: string, nodeId: string, taskId: string, acceptedAtMs = Date.now()): string {
  const iso = new Date(acceptedAtMs).toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: taskId, meshId, message: 'work', status: 'assigned',
    assignedSessionId: sessionId, assignedNodeId: nodeId, createdAt: iso, updatedAt: iso,
  } as any)
  const attempt = seedMeshAttempt({ meshId, taskId, sessionId, nodeId, scope: 'mesh_direct', stage: 'consumed', nowMs: acceptedAtMs })
  mintWorkerTaskToken({ meshId, taskId, attemptId: attempt.attemptId, sessionId, nodeId })
  return attempt.attemptId
}

function seedTerminalTask(meshId: string, sessionId: string, nodeId: string, taskId: string, atMs: number): string {
  const iso = new Date(atMs).toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: taskId, meshId, message: 'done', status: 'completed',
    assignedSessionId: sessionId, assignedNodeId: nodeId, createdAt: iso, updatedAt: iso,
  } as any)
  return seedMeshAttempt({ meshId, taskId, sessionId, nodeId, scope: 'mesh_direct', stage: 'completed', nowMs: atMs }).attemptId
}

function reportRows(meshId: string, taskId: string) {
  return MeshRuntimeStore.getInstance().turnStore().listWorkerEventsForTask(meshId, taskId, WORKER_REPORT_EVENT_KIND)
}

const REPORT = { outcome: 'completed', summary: 'Investigated the OS difference; findings in detail.', touchedFiles: [] }

let lateNotices: Array<{ taskId: string; attemptId: string }> = []
let progressNotices: Array<{ taskId: string }> = []

beforeEach(() => {
  __resetReportedSummariesForTest()
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  __resetWorkerDeliveryReplayForTests()
  __resetProgressSurfaceForTest()
  lateNotices = []
  progressNotices = []
  __setHandoffNoteSinkForTests(() => {})
  __setWorkerLateReportNoticeSinkForTests((n) => { lateNotices.push({ taskId: n.taskId, attemptId: n.attemptId }) })
  __setWorkerProgressNoticeSinkForTests((n) => { progressNotices.push({ taskId: n.taskId }) })
})
afterEach(() => {
  __setHandoffNoteSinkForTests(undefined)
  __setWorkerLateReportNoticeSinkForTests(undefined)
  __setWorkerProgressNoticeSinkForTests(undefined)
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  __resetWorkerDeliveryReplayForTests()
})

describe('deliveryId — a re-send of an accepted report lands exactly once', () => {
  it('the same deliveryId after the session moved on returns the ORIGINAL answer, not a filing against the new task', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    const attemptA = seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_a`, Date.now() - 60_000)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    const args = { bind, report: REPORT, deliveryId: 'wr_0123456789abcdef', reportedAtMs: Date.now() - 1_000 }

    // First delivery: the daemon processes it, but (in production) the answer is lost to an IPC timeout.
    const first: any = await workerReportHandlers.worker_report_completion(ctx, args)
    expect(first).toMatchObject({ success: true, taskId: `${meshId}_task_a`, duplicate: false })

    // Meanwhile the ledger closes A's attempt and the queue hands the same session a new task.
    seedMeshAttempt({ meshId, taskId: `${meshId}_task_a`, sessionId, nodeId, scope: 'mesh_direct', attemptId: attemptA, stage: 'completed', nowMs: Date.now() - 500 })
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_b`)

    // The outbox re-sends the identical delivery.
    const again: any = await workerReportHandlers.worker_report_completion(ctx, args)
    expect(again).toMatchObject({ success: true, taskId: `${meshId}_task_a`, duplicate: true })
    expect(reportRows(meshId, `${meshId}_task_a`)).toHaveLength(1)
    expect(reportRows(meshId, `${meshId}_task_b`)).toHaveLength(0)
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(meshId, `${meshId}_task_b`)?.status).toBe('assigned')
  })

  it('a progress note re-sent with the same deliveryId pages the coordinator once and records one row', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_p`, Date.now() - 60_000)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    const args = {
      bind,
      note: 'Finished the schema migration; now rewriting the three consumers of the old table.',
      deliveryId: 'wp_0123456789abcdef',
      reportedAtMs: Date.now() - 500,
    }
    const first: any = await workerReportHandlers.worker_progress_update(ctx, args)
    if (first?.success !== true) throw new Error(`first progress refused: ${JSON.stringify(first)}`)
    const noticesAfterFirst = progressNotices.length
    expect(noticesAfterFirst).toBe(first.surfacedToCoordinator ? 1 : 0)
    const again: any = await workerReportHandlers.worker_progress_update(ctx, args)
    expect(progressNotices).toHaveLength(noticesAfterFirst)
    expect(first).toMatchObject({ success: true, taskId: `${meshId}_task_p` })
    expect(again).toMatchObject({ success: true, taskId: `${meshId}_task_p`, duplicate: true })
    const rows = MeshRuntimeStore.getInstance().turnStore().listWorkerEventsForTask(meshId, `${meshId}_task_p`, WORKER_PROGRESS_EVENT_KIND)
    expect(rows).toHaveLength(1)
  })
})

describe('reportedAtMs — a queued report is filed against the attempt it was written for', () => {
  it('a report written before the session got its current task lands (late) on the earlier task, and the current task is untouched', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    const now = Date.now()
    // Task A: dispatched and — because the report never arrived — terminalized by a probe.
    const attemptA = seedTerminalTask(meshId, sessionId, nodeId, `${meshId}_task_a`, now - 120_000)
    // The worker wrote its report 20s after that terminal; delivery kept timing out.
    const reportedAtMs = now - 100_000
    // Then the queue handed the same session task B.
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_b`, now - 30_000)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind

    const res: any = await workerReportHandlers.worker_report_completion(ctx, {
      bind, report: REPORT, deliveryId: 'wr_fedcba9876543210', reportedAtMs,
    })

    expect(res).toMatchObject({ success: true, taskId: `${meshId}_task_a`, attemptId: attemptA, late: true })
    expect(reportRows(meshId, `${meshId}_task_a`)).toHaveLength(1)
    expect(reportRows(meshId, `${meshId}_task_b`)).toHaveLength(0)
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(meshId, `${meshId}_task_b`)?.status).toBe('assigned')
    expect(lateNotices).toEqual([{ taskId: `${meshId}_task_a`, attemptId: attemptA }])
  })

  it('refuses stale_report (never files it against the new task) when the earlier attempt is outside the late window', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    const now = Date.now()
    seedTerminalTask(meshId, sessionId, nodeId, `${meshId}_task_a`, now - 60 * 60_000)
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_b`, now - 30_000)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind

    // Written 40 min after A's terminal — beyond the 15-min late-report grace.
    const res: any = await workerReportHandlers.worker_report_completion(ctx, {
      bind, report: REPORT, reportedAtMs: now - 20 * 60_000,
    })
    expect(res).toMatchObject({ success: false, error: 'stale_report' })
    expect(reportRows(meshId, `${meshId}_task_b`)).toHaveLength(0)
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(meshId, `${meshId}_task_b`)?.status).toBe('assigned')
  })

  it('a report older than the delivery window is refused stale_report', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_x`, Date.now() - WORKER_REPORT_MAX_DELIVERY_DELAY_MS - 120_000)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    const res: any = await workerReportHandlers.worker_report_completion(ctx, {
      bind, report: REPORT, reportedAtMs: Date.now() - WORKER_REPORT_MAX_DELIVERY_DELAY_MS - 60_000,
    })
    expect(res).toMatchObject({ success: false, error: 'stale_report' })
  })

  it('a queued progress note written before the current task is refused, not recorded on it', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_b`, Date.now() - 10_000)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    const res: any = await workerReportHandlers.worker_progress_update(ctx, {
      bind, note: 'Old milestone from the previous task, delivered late.', reportedAtMs: Date.now() - 60_000,
    })
    expect(res).toMatchObject({ success: false, error: 'stale_report' })
    expect(MeshRuntimeStore.getInstance().turnStore().listWorkerEventsForTask(meshId, `${meshId}_task_b`, WORKER_PROGRESS_EVENT_KIND)).toHaveLength(0)
  })

  it('without reportedAtMs (an older client) the live task takes the report exactly as before', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task_live`)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    const res: any = await workerReportHandlers.worker_report_completion(ctx, { bind, report: REPORT })
    expect(res).toMatchObject({ success: true, taskId: `${meshId}_task_live`, duplicate: false })
  })
})
