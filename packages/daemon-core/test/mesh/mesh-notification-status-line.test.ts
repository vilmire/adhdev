import { describe, expect, it } from 'vitest'

// NOTIF-STATUS-LINE. A terminal coordinator notification (worker completed / needs
// approval / stopped / refine · bootstrap finished) carries a one-line mesh snapshot
// so the coordinator does not have to spend a mesh_status round-trip re-establishing what
// else is in flight.
//
// The properties that make this safe, each asserted below:
//   (1) the line is appended to TERMINAL notices and is content-free (taskId prefixes,
//       status enums, counts — never taskTitle, which is free text cut out of the task
//       message),
//   (2) a non-terminal notice never carries one,
//   (3) the line never exceeds MESH_STATUS_LINE_MAX_CHARS,
//   (4) the snapshot is taken at DELIVER time (turn-ledger/deliver renderNotice,
//       wiring-unification C-W3), not when the notice was written — a notice
//       delivered an hour later reports the mesh as it is NOW.

import {
  renderMeshStatusLine,
  MESH_STATUS_LINE_MAX_CHARS,
} from '../../src/mesh/mesh-notification-status-line.js'
import type { MeshActiveWorkRecord, MeshActiveWorkStatus } from '../../src/mesh/mesh-active-work.js'
import { renderNotice } from '../../src/mesh/turn-ledger/deliver.js'

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
  return recordsWithStatus(ids.map(id => [id, 'generating' as MeshActiveWorkStatus]))
}

function recordsWithStatus(entries: Array<[string, MeshActiveWorkStatus]>): MeshActiveWorkRecord[] {
  return entries.map(([id, status], i) => ({
    taskId: id,
    source: 'queue',
    status,
    // Free text deliberately present on the record — the renderer must NOT surface it.
    taskTitle: 'refactor the billing module and delete the stale fixtures',
    taskSummary: 'refactor the billing module and delete the stale fixtures',
    // Ascending so index order == createdAt order, matching how buildMeshActiveWork
    // hands records to the renderer (createdAt-sorted).
    createdAt: new Date(i).toISOString(),
    updatedAt: new Date(i).toISOString(),
    elapsedMs: 0,
  })) as MeshActiveWorkRecord[]
}


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
    // Every shown entry is "<7-char id> <status>" — a half id is not a usable handle.
    const shown = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).split(', ').filter(s => s !== '...')
    for (const entry of shown) {
      const [id, status] = entry.split(' ')
      expect(id).toHaveLength(7)
      expect(status).toBe('generating')
    }
  })

  it('orders both the count breakdown and the id list by actionability, not by count size or createdAt', () => {
    // Oldest record is 'generating' (least actionable here); newest is 'awaiting_approval'.
    const line = renderMeshStatusLine({
      activeWork: recordsWithStatus([
        ['aaaa111generating', 'generating'],
        ['bbbb222approval', 'awaiting_approval'],
      ]),
      statusCounts: countsFrom({ generating: 1, awaiting_approval: 1 }),
      totalActiveCount: 2,
    })!
    // Count breakdown: awaiting_approval must render before generating despite
    // STATUS_RENDER_ORDER previously putting generating first.
    expect(line.indexOf('awaiting_approval')).toBeLessThan(line.indexOf('generating'))
    // Id list: the awaiting_approval id must appear before the generating id even
    // though it has a LATER createdAt (index 1 vs index 0 in recordsWithStatus).
    expect(line.indexOf('bbbb222')).toBeLessThan(line.indexOf('aaaa111'))
  })

  it('tags each id with its own status', () => {
    const line = renderMeshStatusLine({
      activeWork: recordsWithStatus([
        ['a3f21c8deadbeef', 'awaiting_approval'],
        ['9c1d0e2feedface', 'failed'],
      ]),
      statusCounts: countsFrom({ awaiting_approval: 1, failed: 1 }),
      totalActiveCount: 2,
    })!
    expect(line).toContain('a3f21c8 awaiting_approval')
    expect(line).toContain('9c1d0e2 failed')
  })

  it('under elision, keeps actionable ids and drops generating ids first', () => {
    // One awaiting_approval id plus many generating ids, all with long free text,
    // such that not all ids fit within the 200-char bound.
    const generatingIds = Array.from({ length: 30 }, (_, i) => [`gen${i}`.padStart(7, '0'), 'generating' as MeshActiveWorkStatus] as [string, MeshActiveWorkStatus])
    const line = renderMeshStatusLine({
      activeWork: recordsWithStatus([
        ...generatingIds, // older, createdAt index 0..29
        ['zzzz999approval', 'awaiting_approval'], // newest, createdAt index 30
      ]),
      statusCounts: countsFrom({ generating: 30, awaiting_approval: 1 }),
      totalActiveCount: 31,
    })!
    expect(line.length).toBeLessThanOrEqual(MESH_STATUS_LINE_MAX_CHARS)
    expect(line).toContain('...')
    // The single awaiting_approval id survives elision despite being createdAt-newest.
    expect(line).toContain('zzzz999 awaiting_approval')
  })

  it('clampToBound never fires when elision already respects the char bound (head-only fallback stays whole)', () => {
    // Regression guard for the fault: if actionability sorting were reverted, this
    // input's elided line would still fit under the bound by construction (elision
    // guarantees that), so this test alone would not catch the regression — it is
    // the two tests above that pin the sort. This test instead pins that clampToBound's
    // hard slice is never reached for a normal elided line: no trailing '…' marker.
    const many = Array.from({ length: 80 }, (_, i) => `${i}`.padStart(7, '0') + 'tail')
    const line = renderMeshStatusLine({
      activeWork: records(...many),
      statusCounts: countsFrom({ generating: 80 }),
      totalActiveCount: 80,
    })!
    expect(line.length).toBeLessThanOrEqual(MESH_STATUS_LINE_MAX_CHARS)
    expect(line.endsWith('…')).toBe(false)
    // No entry is a bare truncated fragment ending mid-id.
    const shown = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).split(', ').filter(s => s !== '...')
    for (const entry of shown) expect(entry).toMatch(/^\w{7} generating$/)
  })
})

/** A notice row as the ledger stores it: text LOCAL, entry content-free. */
function noticeRow(event: string, coordinatorMessage = '[System] worker-1 completed its task.') {
  return {
    eventId: 'n1', meshId: 'mesh-alpha', attemptId: null, generation: null, sessionId: '', kind: 'notify', source: 'mesh_event',
    verdict: 'applied', rule: null, rejection: null, dedupeKey: 'n1', fromState: null, toState: null,
    payload: { meshId: 'mesh-alpha', notify: 'mesh_event', event, entry: {}, local: { payload: { nodeLabel: 'worker-1', coordinatorMessage } } },
    observedBy: null, srcWriter: 'w', srcSeq: 1, publishState: 'published', publishedSeq: 1, atMs: 0, recordedAt: 0,
  } as any
}

function render(event: string, statusLine: (meshId: string) => string | null) {
  const ctx = { ledger: { getAttempt: () => null, store: { getEvent: () => null } } as any, statusLine }
  return renderNotice(ctx, 'mesh-alpha', { notify: 'mesh_event' }, noticeRow(event)).text
}

describe('renderNotice — status line append (deliver time)', () => {
  it('appends the snapshot to a TERMINAL notice', () => {
    const text = render('refine:completed', () => '[mesh] 2 active: t-abc12 generating')
    expect(text).toBe('[System] worker-1 completed its task.\n\n[mesh] 2 active: t-abc12 generating')
  })

  it('does NOT append to a non-terminal notice', () => {
    let called = 0
    const text = render('mission_close_candidate', () => { called++; return '[mesh] line' })
    expect(text).toBe('[System] worker-1 completed its task.')
    expect(called).toBe(0)
  })

  it('delivers the notice unchanged when the snapshot is unavailable', () => {
    expect(render('worktree_bootstrap_complete', () => null)).toBe('[System] worker-1 completed its task.')
  })

  it('snapshots at DELIVER time, not when the notice was written', () => {
    let state = 'written'
    const statusLine = () => `[mesh] ${state}`
    state = 'delivered'
    expect(render('refine:failed', statusLine)).toContain('[mesh] delivered')
  })
})
