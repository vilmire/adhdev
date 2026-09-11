import { beforeEach, describe, expect, it, vi } from 'vitest'

// NOTIF-STATUS-LINE. A terminal coordinator notification (worker completed / needs
// approval / stopped / refine · bootstrap finished) now carries a one-line mesh snapshot
// so the coordinator does not have to spend a mesh_status round-trip re-establishing what
// else is in flight.
//
// The four properties that make this safe, each asserted below:
//   (1) the line is appended to TERMINAL events and is content-free (taskId prefixes,
//       status enums, counts — never taskTitle, which is free text cut out of the task
//       message),
//   (2) a SILENT lifecycle event never carries one,
//   (3) the line never exceeds MESH_STATUS_LINE_MAX_CHARS,
//   (4) the snapshot is taken at INJECT time, not emit time — a held event injected an
//       hour later must report the mesh as it is NOW, not as it was when it was queued.

const statusLineMock = vi.hoisted(() => ({
  buildMeshStatusLineForNotification: vi.fn((_meshId: string) => null as string | null),
}))

vi.mock('../../src/mesh/mesh-notification-status-line.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mesh/mesh-notification-status-line.js')>()
  return { ...actual, buildMeshStatusLineForNotification: statusLineMock.buildMeshStatusLineForNotification }
})

import { injectPendingIntoCoordinator } from '../../src/mesh/mesh-reconcile-coordinator-drain.js'
import {
  renderMeshStatusLine,
  MESH_STATUS_LINE_MAX_CHARS,
} from '../../src/mesh/mesh-notification-status-line.js'
import type { MeshActiveWorkRecord, MeshActiveWorkStatus } from '../../src/mesh/mesh-active-work.js'
import type { PendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events-pending.js'

function makeCoordinator() {
  const sent: any[] = []
  return {
    sent,
    onEvent: (name: string, payload: any) => { sent.push({ name, payload }) },
  }
}

function makePending(event: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
  return {
    event,
    meshId: 'mesh-alpha',
    nodeLabel: 'worker-1',
    metadataEvent: {},
    coordinatorMessage: '[System] worker-1 completed its task.',
    queuedAt: Date.now(),
    ...over,
  } as PendingMeshCoordinatorEvent
}

function countsFrom(partial: Partial<Record<MeshActiveWorkStatus, number>>): Record<MeshActiveWorkStatus, number> {
  return {
    pending: 0,
    assigned: 0,
    generating: 0,
    idle: 0,
    failed: 0,
    awaiting_approval: 0,
    awaiting_choice: 0,
    finalizing: 0,
    ...partial,
  }
}

function records(...ids: string[]): MeshActiveWorkRecord[] {
  return ids.map(id => ({
    taskId: id,
    source: 'queue',
    status: 'generating',
    // Free text deliberately present on the record — the renderer must NOT surface it.
    taskTitle: 'refactor the billing module and delete the stale fixtures',
    taskSummary: 'refactor the billing module and delete the stale fixtures',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    elapsedMs: 0,
  })) as MeshActiveWorkRecord[]
}

beforeEach(() => {
  statusLineMock.buildMeshStatusLineForNotification.mockReset()
  statusLineMock.buildMeshStatusLineForNotification.mockReturnValue(null)
})

describe('renderMeshStatusLine', () => {
  it('renders counts and taskId prefixes, and never the free-text taskTitle', () => {
    const line = renderMeshStatusLine({
      activeWork: records('a3f21c8deadbeef', '7b0e441cafe1234'),
      statusCounts: countsFrom({ generating: 2, awaiting_approval: 1, pending: 1 }),
      totalActiveCount: 4,
    })!
    expect(line).toContain('[Mesh] active 4')
    expect(line).toContain('2 generating')
    expect(line).toContain('1 awaiting_approval')
    expect(line).toContain('1 pending')
    expect(line).toContain('a3f21c8')
    expect(line).toContain('7b0e441')
    // The load-bearing assertion: no free text from the task message leaks in.
    expect(line).not.toContain('refactor')
    expect(line).not.toContain('billing')
  })

  it('returns null when there is no active work (no noise line)', () => {
    expect(renderMeshStatusLine({
      activeWork: [],
      statusCounts: countsFrom({}),
      totalActiveCount: 0,
    })).toBeNull()
  })

  it('stays within the 200-char bound and elides surplus ids rather than truncating one', () => {
    const many = Array.from({ length: 80 }, (_, i) => `${i}`.padStart(7, '0') + 'tail')
    const line = renderMeshStatusLine({
      activeWork: records(...many),
      statusCounts: countsFrom({ generating: 40, awaiting_approval: 20, pending: 20 }),
      totalActiveCount: 80,
    })!
    expect(line.length).toBeLessThanOrEqual(MESH_STATUS_LINE_MAX_CHARS)
    expect(line).toContain('...')
    // Every id that IS shown is a whole 7-char prefix — a half id is not a usable handle.
    const shown = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).split(', ').filter(s => s !== '...')
    for (const id of shown) expect(id).toHaveLength(7)
  })
})

describe('injectPendingIntoCoordinator — status line append', () => {
  it('appends the snapshot to a TERMINAL event notification', () => {
    statusLineMock.buildMeshStatusLineForNotification.mockReturnValue('[Mesh] active 2: 2 generating (a3f21c8, 7b0e441)')
    const coordinator = makeCoordinator()
    injectPendingIntoCoordinator(coordinator as any, makePending('agent:generating_completed'))

    expect(coordinator.sent).toHaveLength(1)
    const text = coordinator.sent[0].payload.input.text as string
    expect(text).toContain('[System] worker-1 completed its task.')
    expect(text).toContain('[Mesh] active 2: 2 generating (a3f21c8, 7b0e441)')
    // textFallback must carry the same appended text — the two must not diverge.
    expect(coordinator.sent[0].payload.input.textFallback).toBe(text)
  })

  it('appends to an approval nudge delivered with forceOverride:false', () => {
    // forceOverride only changes HOW the message reaches the PTY (queued to the adapter's
    // outbound queue vs raw force-write); it still becomes a real coordinator turn, so it
    // must carry the snapshot.
    statusLineMock.buildMeshStatusLineForNotification.mockReturnValue('[Mesh] active 1: 1 awaiting_approval (aaaa111)')
    const coordinator = makeCoordinator()
    injectPendingIntoCoordinator(
      coordinator as any,
      makePending('agent:waiting_approval', { coordinatorMessage: '[System] worker-1 needs approval.' }),
      { forceOverride: false },
    )
    const text = coordinator.sent[0].payload.input.text as string
    expect(text).toContain('[Mesh] active 1: 1 awaiting_approval')
    expect(coordinator.sent[0].payload.force).toBeUndefined()
  })

  it('does NOT append to a silent lifecycle event', () => {
    statusLineMock.buildMeshStatusLineForNotification.mockReturnValue('[Mesh] active 3: 3 generating (aaaa111)')
    const coordinator = makeCoordinator()
    injectPendingIntoCoordinator(
      coordinator as any,
      makePending('agent:ready', { coordinatorMessage: '[System] worker-1 is ready.' }),
    )
    const text = coordinator.sent[0].payload.input.text as string
    expect(text).toBe('[System] worker-1 is ready.')
    expect(text).not.toContain('[Mesh]')
    expect(statusLineMock.buildMeshStatusLineForNotification).not.toHaveBeenCalled()
  })

  it('injects the notification unchanged when the snapshot is unavailable', () => {
    statusLineMock.buildMeshStatusLineForNotification.mockReturnValue(null)
    const coordinator = makeCoordinator()
    injectPendingIntoCoordinator(coordinator as any, makePending('agent:generating_completed'))
    expect(coordinator.sent[0].payload.input.text).toBe('[System] worker-1 completed its task.')
  })

  it('snapshots at INJECT time, not at the time the event was queued', () => {
    // The defect this guards: a held event can sit at drained=0 for a very long time while
    // the coordinator is busy (measured: 1h42m). If the line were rendered when the event
    // was EMITTED, it would deliver counts that are hours stale. Model that by changing the
    // mesh state between queueing the event and injecting it — the injected text must carry
    // the LATER numbers.
    statusLineMock.buildMeshStatusLineForNotification.mockReturnValue('[Mesh] active 5: 5 generating (aaaa111)')
    const pending = makePending('agent:generating_completed', { queuedAt: Date.now() - 6_120_000 })

    // ... mesh state moves on while the event is held ...
    statusLineMock.buildMeshStatusLineForNotification.mockReturnValue('[Mesh] active 1: 1 generating (bbbb222)')

    const coordinator = makeCoordinator()
    injectPendingIntoCoordinator(coordinator as any, pending)

    const text = coordinator.sent[0].payload.input.text as string
    expect(text).toContain('[Mesh] active 1: 1 generating (bbbb222)')
    expect(text).not.toContain('active 5')
    // And the snapshot was taken for this event's own mesh.
    expect(statusLineMock.buildMeshStatusLineForNotification).toHaveBeenCalledWith('mesh-alpha')
  })
})
