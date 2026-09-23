/**
 * F1 — every dispatched task body ends with the worker protocol footer.
 *
 * Measured 2026-09-23: 635 worker attempts, 3 `report_completion` calls, because
 * the dispatched body carried no instruction about the worker tools. These
 * tests pin the materialization seam so a body can never again leave
 * `resolveDispatchMessage` without the footer, and pin the ordering
 * (message → handoff block → footer) and idempotency on redispatch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  WORKER_PROTOCOL_FOOTER_MARKER,
  hasWorkerProtocolFooter,
  renderWorkerProtocolFooter,
} from '@adhdev/mesh-shared'

import { resolveDispatchMessage } from '../../src/mesh/worker-handoff-dispatch'
import { __resetHandoffNotesForTest, storeHandoffNote } from '../../src/mesh/worker-handoff-notes'
import { WORKER_HANDOFF_EVENT_KIND } from '../../src/mesh/worker-report'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { seedWorkerEvent } from '../helpers/turn-attempt-seed'

// Own mesh id per test: the handoff index (`turn_events`) is process-wide and
// INSERT OR IGNORE — see worker-handoff-notes.test.ts.
let MESH = 'mesh_dispatch_footer'
let meshSeq = 0

function seedNote(taskId: string, files: string[], intent: string): void {
  const recordedAtIso = new Date().toISOString()
  seedWorkerEvent({
    eventId: `evt-${MESH}-${taskId}`,
    meshId: MESH,
    attemptId: `attempt-${MESH}-${taskId}`,
    taskId,
    kind: WORKER_HANDOFF_EVENT_KIND,
    payload: { touchedFiles: files, intentLength: intent.length, hasConflictGuidance: false, followUpCount: 0 },
  })
  storeHandoffNote({
    meshId: MESH,
    taskId,
    attemptId: `attempt-${MESH}-${taskId}`,
    notes: { intent, touchedFiles: files },
    recordedAtIso,
  })
}

function countMarkers(body: string): number {
  return body.split(WORKER_PROTOCOL_FOOTER_MARKER).length - 1
}

const savedGate = process.env.ADHDEV_WORKER_MCP

beforeEach(() => {
  __resetHandoffNotesForTest()
  meshSeq += 1
  MESH = `mesh_dispatch_footer_${meshSeq}`
  delete process.env.ADHDEV_WORKER_MCP
})
afterEach(() => {
  __resetHandoffNotesForTest()
  if (savedGate === undefined) delete process.env.ADHDEV_WORKER_MCP
  else process.env.ADHDEV_WORKER_MCP = savedGate
})

describe('resolveDispatchMessage — worker protocol footer', () => {
  it('appends the footer even when the worker-MCP gate is OFF', () => {
    process.env.ADHDEV_WORKER_MCP = 'off'
    const body = resolveDispatchMessage(
      { id: 'task_off', message: 'Fix the thing.', taskMode: 'code_change', difficulty: 'medium' },
      MESH,
      null,
    )
    expect(body.startsWith('Fix the thing.')).toBe(true)
    expect(hasWorkerProtocolFooter(body)).toBe(true)
    expect(countMarkers(body)).toBe(1)
    // The footer is the tail of the body — nothing rides after it.
    expect(body.trimEnd().endsWith(renderWorkerProtocolFooter({ taskId: 'task_off', taskMode: 'code_change', difficulty: 'medium' }))).toBe(true)
  })

  it('carries the task id, mode, difficulty and read-only axis in the footer', () => {
    const body = resolveDispatchMessage(
      { id: 'task_ro', message: 'Inspect only.', taskMode: 'validation', difficulty: 'easy', readonly: true },
      MESH,
      null,
    )
    const footer = body.slice(body.indexOf(WORKER_PROTOCOL_FOOTER_MARKER))
    expect(footer).toContain('task task_ro')
    expect(footer).toContain('mode validation')
    expect(footer).toContain('difficulty easy')
    expect(footer).toContain('read-only')
    expect(footer).toContain('`report_completion`')
  })

  it('treats live_debug_readonly as read-only without an explicit flag', () => {
    const body = resolveDispatchMessage(
      { id: 'task_ldr', message: 'Look.', taskMode: 'live_debug_readonly', difficulty: 'easy' },
      MESH,
      null,
    )
    expect(body.slice(body.indexOf(WORKER_PROTOCOL_FOOTER_MARKER))).toContain('read-only')
  })

  it('places the handoff block AFTER the message and BEFORE the footer, and counts it in the footer', () => {
    seedNote('task_prev', ['src/a.ts'], 'the earlier intent')
    const body = resolveDispatchMessage(
      { id: 'task_new', message: 'Resolve the conflict in src/a.ts.', taskMode: 'code_change', difficulty: 'medium', touchedFiles: ['src/a.ts'] },
      MESH,
      null,
    )
    const messageAt = body.indexOf('Resolve the conflict in src/a.ts.')
    const handoffAt = body.indexOf('## Handoff notes from related work')
    const footerAt = body.indexOf(WORKER_PROTOCOL_FOOTER_MARKER)
    expect(messageAt).toBe(0)
    expect(handoffAt).toBeGreaterThan(messageAt)
    expect(footerAt).toBeGreaterThan(handoffAt)
    expect(body).toContain('the earlier intent')
    expect(body.slice(footerAt)).toContain('The 1 handoff note(s) above')
    expect(countMarkers(body)).toBe(1)
  })

  it('does NOT enclose handoff notes when the gate is OFF, but still footers', () => {
    process.env.ADHDEV_WORKER_MCP = '0'
    seedNote('task_prev', ['src/a.ts'], 'the earlier intent')
    const body = resolveDispatchMessage(
      { id: 'task_new', message: 'Touch src/a.ts.', taskMode: 'code_change', difficulty: 'medium', touchedFiles: ['src/a.ts'] },
      MESH,
      null,
    )
    expect(body).not.toContain('the earlier intent')
    expect(hasWorkerProtocolFooter(body)).toBe(true)
    expect(body.slice(body.indexOf(WORKER_PROTOCOL_FOOTER_MARKER))).not.toContain('handoff note(s) above')
  })

  it('is idempotent: redispatching an already-footered body neither stacks the footer nor re-encloses notes', () => {
    seedNote('task_prev', ['src/a.ts'], 'the earlier intent')
    const task = { id: 'task_new', message: 'Touch src/a.ts.', taskMode: 'code_change', difficulty: 'medium', touchedFiles: ['src/a.ts'] }
    const first = resolveDispatchMessage(task, MESH, null)
    const second = resolveDispatchMessage({ ...task, message: first }, MESH, null)
    expect(second).toBe(first)
    expect(countMarkers(second)).toBe(1)
    expect(second.split('## Handoff notes from related work').length - 1).toBe(1)
  })

  it('leaves task.message untouched — the footer lives on the dispatched body only', () => {
    const task = { id: 'task_plain', message: 'Do it.', taskMode: 'code_change', difficulty: 'easy' }
    resolveDispatchMessage(task, MESH, null)
    expect(task.message).toBe('Do it.')
  })
})
