import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetWorkerMailboxForTest,
  depositWorkerMailboxMessage,
  discardWorkerMailboxForTask,
  drainWorkerMailboxForTask,
  MAILBOX_MAX_PENDING_PER_TASK,
  MAILBOX_TEXT_MAX_CHARS,
  peekWorkerMailboxCount,
  renderMailboxBlock,
} from '../../src/mesh/worker-mailbox'
import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  isWorkerMcpEnabled,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation'
import { workerMailboxHandlers } from '../../src/commands/low-family/worker-mailbox'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { commitTaskTerminalAndAdvanceGraph } from '../../src/mesh/mesh-graph-transition-runner'

beforeEach(() => {
  __resetWorkerMailboxForTest()
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
})
afterEach(() => {
  __resetWorkerMailboxForTest()
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
})

// mesh_queue rows live in a process-wide SQLite store — namespace every task id
// per-test so parallel/sequential test cases in this file never collide on the
// primary key (same discipline worker-handoff-notes.test.ts documents).
let seq = 0
function uniqueTaskId(): string {
  seq += 1
  return `mailbox-task-${seq}`
}

function seedQueueEntry(meshId: string, taskId: string): void {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: taskId, meshId, message: 'do the thing', status: 'assigned', createdAt: now, updatedAt: now,
  })
}

// ─── Pure module: deposit/drain/discard (design §9.2 G) ───────────────────

describe('worker mailbox — deposit/drain/discard', () => {
  it('deposits and drains, and draining empties it (delivery IS the stamp)', () => {
    const deposited = depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'stop the refactor' })
    expect(deposited).toMatchObject({ ok: true, pending: 1 })
    expect(peekWorkerMailboxCount('m', 't1')).toBe(1)

    const drained = drainWorkerMailboxForTask('m', 't1')
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ meshId: 'm', taskId: 't1', text: 'stop the refactor' })
    expect(peekWorkerMailboxCount('m', 't1')).toBe(0)

    // A second drain returns nothing — no re-delivery.
    expect(drainWorkerMailboxForTask('m', 't1')).toEqual([])
  })

  it('accumulates multiple messages FIFO', () => {
    depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'first' })
    depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'second' })
    const drained = drainWorkerMailboxForTask('m', 't1')
    expect(drained.map(m => m.text)).toEqual(['first', 'second'])
  })

  it('keeps mailboxes for different tasks independent', () => {
    depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'for t1' })
    depositWorkerMailboxMessage({ meshId: 'm', taskId: 't2', text: 'for t2' })
    expect(drainWorkerMailboxForTask('m', 't1').map(m => m.text)).toEqual(['for t1'])
    expect(drainWorkerMailboxForTask('m', 't2').map(m => m.text)).toEqual(['for t2'])
  })

  it('rejects rather than truncates an over-long message', () => {
    const result = depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'x'.repeat(MAILBOX_TEXT_MAX_CHARS + 1) })
    expect(result).toMatchObject({ ok: false, error: 'text_too_long' })
    expect(peekWorkerMailboxCount('m', 't1')).toBe(0)
  })

  it('rejects invalid input (missing meshId/taskId/text)', () => {
    expect(depositWorkerMailboxMessage({ meshId: '', taskId: 't1', text: 'x' })).toMatchObject({ ok: false, error: 'invalid_input' })
    expect(depositWorkerMailboxMessage({ meshId: 'm', taskId: '', text: 'x' })).toMatchObject({ ok: false, error: 'invalid_input' })
    expect(depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: '  ' })).toMatchObject({ ok: false, error: 'invalid_input' })
  })

  it('caps pending messages per task rather than growing unbounded', () => {
    for (let i = 0; i < MAILBOX_MAX_PENDING_PER_TASK; i++) {
      expect(depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: `msg ${i}` }).ok).toBe(true)
    }
    const overflow = depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'one too many' })
    expect(overflow).toMatchObject({ ok: false, error: 'mailbox_full' })
    expect(peekWorkerMailboxCount('m', 't1')).toBe(MAILBOX_MAX_PENDING_PER_TASK)
  })

  it('discard drops undelivered messages and reports how many (task-terminal lifecycle, §9.2)', () => {
    depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'a' })
    depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'b' })
    expect(discardWorkerMailboxForTask('m', 't1')).toBe(2)
    expect(peekWorkerMailboxCount('m', 't1')).toBe(0)
    // Idempotent — a second discard (e.g. a replayed terminal commit) is harmless.
    expect(discardWorkerMailboxForTask('m', 't1')).toBe(0)
  })

  it('renders a block only when there is something to render', () => {
    expect(renderMailboxBlock([])).toBeNull()
    const deposited = depositWorkerMailboxMessage({ meshId: 'm', taskId: 't1', text: 'read this' })
    expect(deposited.ok).toBe(true)
    const block = renderMailboxBlock(drainWorkerMailboxForTask('m', 't1'))
    expect(block).toContain('read this')
    expect(block).toMatch(/Urgent message/)
  })
})

// ─── Low-family: deposit (coordinator side) ────────────────────────────────

describe('deposit_worker_mailbox low-family handler', () => {
  it('is a no-op refusal when the worker-MCP gate is off (byte-identical promise)', async () => {
    expect(isWorkerMcpEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    const taskId = uniqueTaskId()
    seedQueueEntry('m', taskId)
    const result: any = await workerMailboxHandlers.deposit_worker_mailbox(
      {} as any,
      { meshId: 'm', taskId, text: 'urgent' },
    )
    expect(result).toMatchObject({ success: false, error: 'worker_mcp_disabled' })
    expect(peekWorkerMailboxCount('m', taskId)).toBe(0)
  })

  describe('with the gate on', () => {
    const ON = { ADHDEV_WORKER_MCP: '1' } as NodeJS.ProcessEnv
    let originalEnv: string | undefined

    beforeEach(() => {
      originalEnv = process.env.ADHDEV_WORKER_MCP
      process.env.ADHDEV_WORKER_MCP = '1'
    })
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.ADHDEV_WORKER_MCP
      else process.env.ADHDEV_WORKER_MCP = originalEnv
    })

    it('accepts a deposit when the daemon locally knows the task', async () => {
      const taskId = uniqueTaskId()
      seedQueueEntry('m', taskId)
      const result: any = await workerMailboxHandlers.deposit_worker_mailbox(
        {} as any,
        { meshId: 'm', taskId, text: 'spec changed, stop the refactor' },
      )
      expect(result).toMatchObject({ success: true, pending: 1 })
      expect(peekWorkerMailboxCount('m', taskId)).toBe(1)
    })

    // ★ASYMMETRIC-MACHINE FIXTURE: the coordinator's own daemon is not
    // necessarily the daemon that owns the target task — a mesh spans
    // machines, and this handler runs on whichever daemon `commandForNode`
    // routed the call to. That daemon may not have reconciled this task into
    // its local queue view. Depositing blind in that case would be a silent
    // no-op dressed up as success, so it must refuse with a distinguishable
    // reason instead.
    it('refuses (does not deposit) when THIS daemon has no local queue row for the task', async () => {
      // Deliberately no seedQueueEntry — simulates a remote/unreconciled task.
      const result: any = await workerMailboxHandlers.deposit_worker_mailbox(
        {} as any,
        { meshId: 'm', taskId: 'unknown-to-this-daemon', text: 'urgent' },
      )
      expect(result).toMatchObject({ success: false, error: 'task_not_found_locally' })
      expect(peekWorkerMailboxCount('m', 'unknown-to-this-daemon')).toBe(0)
    })

    it('rejects invalid input', async () => {
      const result: any = await workerMailboxHandlers.deposit_worker_mailbox(
        {} as any,
        { meshId: 'm', taskId: '', text: 'x' },
      )
      expect(result).toMatchObject({ success: false, error: 'invalid_input' })
    })
  })
})

// ─── Low-family: drain (worker side) ───────────────────────────────────────

describe('worker_drain_mailbox low-family handler', () => {
  it('refuses (unauthenticated) for an unresolvable bind/token, never returning a fake-empty success', async () => {
    const result: any = await workerMailboxHandlers.worker_drain_mailbox({} as any, { bind: 'wsb_forged' })
    expect(result).toMatchObject({ success: false, error: 'unauthenticated' })
  })

  it("drains the caller's OWN task mailbox via bind resolution, not a caller-supplied id", async () => {
    const taskId = uniqueTaskId()
    const sessionId = `sess-${taskId}`
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId })
    mintWorkerTaskToken({ meshId: 'm', taskId, attemptId: 'a1', sessionId })
    seedQueueEntry('m', taskId)
    MeshRuntimeStore.getInstance().updateQueueEntry({
      ...MeshRuntimeStore.getInstance().findQueueEntryById('m', taskId)!,
      assignedSessionId: sessionId,
    })
    depositWorkerMailboxMessage({ meshId: 'm', taskId, text: 'read this' })

    const result: any = await workerMailboxHandlers.worker_drain_mailbox({} as any, { bind: bind.bind })
    expect(result.success).toBe(true)
    expect(result.taskId).toBe(taskId)
    expect(result.messages).toEqual([expect.objectContaining({ text: 'read this' })])
    // Drained — a second call returns nothing more.
    const again: any = await workerMailboxHandlers.worker_drain_mailbox({} as any, { bind: bind.bind })
    expect(again.messages).toEqual([])
  })
})

// ─── Terminal-chokepoint integration (design §9.2 G) ───────────────────────

describe('mailbox lifecycle at the terminal chokepoint', () => {
  it('discards an undelivered mailbox message when the task goes terminal', () => {
    const taskId = uniqueTaskId()
    const meshId = `mesh-${taskId}`
    seedQueueEntry(meshId, taskId)
    depositWorkerMailboxMessage({ meshId, taskId, text: 'never delivered — task finished first' })
    expect(peekWorkerMailboxCount(meshId, taskId)).toBe(1)

    const result = commitTaskTerminalAndAdvanceGraph({ meshId, taskId, status: 'completed', source: 'stall_reconcile' })
    expect(result.committed).toBe(true)

    expect(peekWorkerMailboxCount(meshId, taskId)).toBe(0)
  })

  it('is idempotent under the reducer replay fence (a duplicate terminal commit does not throw)', () => {
    const taskId = uniqueTaskId()
    const meshId = `mesh-${taskId}`
    seedQueueEntry(meshId, taskId)

    const first = commitTaskTerminalAndAdvanceGraph({ meshId, taskId, status: 'completed', source: 'stall_reconcile' })
    expect(first.committed).toBe(true)
    expect(first.duplicate).toBe(false)

    // A replay for an already-terminal row re-enters with duplicate:true. The
    // discard hook runs AGAIN on this pass too (it sits after the transaction,
    // gated only on result.committed — true for both a fresh commit and a
    // replay) — and must tolerate that without throwing, sweeping whatever is
    // pending at that moment even if it was deposited between the two calls.
    depositWorkerMailboxMessage({ meshId, taskId, text: 'deposited after terminal — should never be deliverable' })
    const replay = commitTaskTerminalAndAdvanceGraph({ meshId, taskId, status: 'completed', source: 'stall_reconcile' })
    expect(replay.committed).toBe(true)
    expect(replay.duplicate).toBe(true)
    expect(peekWorkerMailboxCount(meshId, taskId)).toBe(0)
  })
})
