import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetHandoffNotesForTest,
  composeTaskDispatchBody,
  getStoredHandoffNote,
  HANDOFF_ENCLOSE_MAX_NOTES,
  HANDOFF_RETENTION_DAYS,
  HANDOFF_RETENTION_MS,
  renderHandoffNotesBlock,
  selectRelevantHandoffNotes,
  storeHandoffNote,
  type HandoffNoteCandidate,
} from '../../src/mesh/worker-handoff-notes'
import { WORKER_HANDOFF_EVENT_KIND } from '../../src/mesh/worker-report'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { meshHandoffTopic, meshEventsTopic, baseTopicDefinitions } from '../../src/seqscribe/topics'

// ★Each test gets its OWN mesh id AND attempt id namespace.
//
// The in-memory note text is reset per test, but mesh_turn_events rows live in
// a process-wide SQLite store and insertTurnEvent is INSERT OR IGNORE. Two
// details make naive reuse silently wrong:
//   - a repeated eventId is ignored; and
//   - the table's UNIQUE key is (attempt_id, kind, dedupe_key) — note it is NOT
//     scoped by mesh_id, so varying only the mesh id is not enough.
// Either way the second insert is dropped while the text store was cleared,
// leaving a meta row with no text that selection correctly skips. Namespacing
// both ids removes the whole class.
let MESH = 'mesh_handoff_test'
let meshSeq = 0

function seedNote(opts: {
  taskId: string
  files: string[]
  intent?: string
  guidance?: string
  recordedAtMs?: number
}): void {
  const recordedAtIso = new Date(opts.recordedAtMs ?? Date.now()).toISOString()
  // The ledger META row — the queryable index (content-free apart from paths).
  MeshRuntimeStore.getInstance().insertTurnEvent({
    eventId: `evt-${MESH}-${opts.taskId}`,
    meshId: MESH,
    attemptId: `attempt-${MESH}-${opts.taskId}`,
    taskId: opts.taskId,
    kind: WORKER_HANDOFF_EVENT_KIND,
    dedupeKey: '',
    payload: JSON.stringify({ touchedFiles: opts.files, intentLength: 10, hasConflictGuidance: !!opts.guidance, followUpCount: 0 }),
    occurredAtMs: opts.recordedAtMs ?? Date.now(),
    recordedAt: recordedAtIso,
  })
  // The TEXT — local mirror + (when configured) the content topic.
  storeHandoffNote({
    meshId: MESH,
    taskId: opts.taskId,
    attemptId: `attempt-${MESH}-${opts.taskId}`,
    notes: {
      intent: opts.intent ?? `intent for ${opts.taskId}`,
      ...(opts.guidance ? { conflictGuidance: opts.guidance } : {}),
      touchedFiles: opts.files,
    },
    recordedAtIso,
  })
}

beforeEach(() => {
  __resetHandoffNotesForTest()
  meshSeq += 1
  MESH = `mesh_handoff_test_${meshSeq}`
})
afterEach(() => { __resetHandoffNotesForTest() })

// ─── Topic boundary (design §9.1) ────────────────────────────────────────

describe('handoff topic', () => {
  it('is a DISTINCT topic from mesh events, not a reuse of it', () => {
    // mesh.<id>.events is metadata class precisely so a cloud peer may hold it.
    // Handoff text is content; putting it there would break that invariant.
    expect(meshHandoffTopic('m1')).not.toBe(meshEventsTopic('m1'))
    expect(meshHandoffTopic('m1')).toBe('mesh.m1.handoff')
  })

  it('is declared content class while the events topic stays metadata', () => {
    const defs = baseTopicDefinitions(['m1'])
    const handoff = defs.find(d => d.topic === meshHandoffTopic('m1'))
    const events = defs.find(d => d.topic === meshEventsTopic('m1'))
    expect(handoff?.policy.access).toBe('content')
    expect(events?.policy.access).toBe('metadata')
    // Content topics must name the fleet authority or proposeFinality throws.
    expect(handoff?.policy.finalityAuthority).toBeTruthy()
  })

  it('registers a handoff topic per mesh, de-duped like the events topic', () => {
    const defs = baseTopicDefinitions(['m1', 'm2', 'm1'])
    const handoffTopics = defs.filter(d => d.topic.endsWith('.handoff')).map(d => d.topic)
    expect(handoffTopics).toEqual(['mesh.m1.handoff', 'mesh.m2.handoff'])
  })

  it('keeps full retention — a note must outlive the ring a transcript would use', () => {
    const defs = baseTopicDefinitions(['m1'])
    const handoff = defs.find(d => d.topic === meshHandoffTopic('m1'))
    // A note exists to be read by work dispatched days later; a ring would
    // evict exactly the older notes a long mission most needs.
    expect(handoff?.policy.retention).toEqual({ mode: 'full' })
  })
})

// ─── Storage ─────────────────────────────────────────────────────────────

describe('note storage', () => {
  it('stores and reads back note text without a seqscribe node', () => {
    // Authority-less boot defines no content topics; local enclosure must still
    // work, or the feature would silently do nothing on those machines.
    storeHandoffNote({
      meshId: MESH,
      taskId: 't1',
      notes: { intent: 'narrowed the registry key', touchedFiles: ['src/a.ts'] },
      recordedAtIso: new Date().toISOString(),
    })
    expect(getStoredHandoffNote(MESH, 't1')?.notes.intent).toBe('narrowed the registry key')
    expect(getStoredHandoffNote(MESH, 'nope')).toBeNull()
  })
})

// ─── Relevance selection (design §5) ─────────────────────────────────────

describe('relevance selection', () => {
  it('matches on touched-file intersection', () => {
    seedNote({ taskId: 'tA', files: ['src/session-host.ts'], intent: 'idempotent re-establish' })
    seedNote({ taskId: 'tB', files: ['src/unrelated.ts'] })

    const picked = selectRelevantHandoffNotes({
      meshId: MESH, taskId: 'tNew', touchedFiles: ['src/session-host.ts'],
    })
    expect(picked.map(n => n.taskId)).toEqual(['tA'])
    expect(picked[0].reason).toBe('touched_files')
    expect(picked[0].overlap).toEqual(['src/session-host.ts'])
  })

  it('normalizes path separators and case when intersecting', () => {
    seedNote({ taskId: 'tA', files: ['src\\Session-Host.ts'] })
    const picked = selectRelevantHandoffNotes({
      meshId: MESH, taskId: 'tNew', touchedFiles: ['./src/session-host.ts'],
    })
    expect(picked.map(n => n.taskId)).toEqual(['tA'])
  })

  it('never encloses a task its OWN note', () => {
    seedNote({ taskId: 'tSelf', files: ['src/a.ts'] })
    const picked = selectRelevantHandoffNotes({
      meshId: MESH, taskId: 'tSelf', touchedFiles: ['src/a.ts'],
    })
    expect(picked).toEqual([])
  })

  it('falls back to mission match when no files overlap', () => {
    seedNote({ taskId: 'tA', files: ['src/other.ts'] })
    const picked = selectRelevantHandoffNotes({
      meshId: MESH,
      taskId: 'tNew',
      touchedFiles: ['src/mine.ts'],
      missionId: 'mission-1',
      lookupMissionId: (taskId) => (taskId === 'tA' ? 'mission-1' : undefined),
    })
    expect(picked.map(n => n.reason)).toEqual(['same_mission'])
  })

  it('ranks file overlap above mission above branch', () => {
    seedNote({ taskId: 'tFiles', files: ['src/shared.ts'] })
    seedNote({ taskId: 'tMission', files: ['src/x.ts'] })
    seedNote({ taskId: 'tBranch', files: ['src/y.ts'] })

    const picked = selectRelevantHandoffNotes({
      meshId: MESH,
      taskId: 'tNew',
      touchedFiles: ['src/shared.ts'],
      missionId: 'm1',
      branch: 'feat/x',
      lookupMissionId: (t) => (t === 'tMission' ? 'm1' : undefined),
      lookupBranch: (t) => (t === 'tBranch' ? 'feat/x' : undefined),
    })
    expect(picked.map(n => n.taskId)).toEqual(['tFiles', 'tMission', 'tBranch'])
  })

  it('excludes a note past the retention window even before the sweep runs', () => {
    const now = Date.now()
    // Otherwise the effective lifetime would be "30 days, or longer if the
    // daemon happened not to sweep" — which is not a policy.
    seedNote({ taskId: 'tOld', files: ['src/a.ts'], recordedAtMs: now - HANDOFF_RETENTION_MS - 60_000 })
    seedNote({ taskId: 'tFresh', files: ['src/a.ts'], recordedAtMs: now - 1_000 })

    const picked = selectRelevantHandoffNotes({
      meshId: MESH, taskId: 'tNew', touchedFiles: ['src/a.ts'], nowMs: now,
    })
    expect(picked.map(n => n.taskId)).toEqual(['tFresh'])
  })

  it('skips a meta row whose text this daemon does not hold', () => {
    // A note that arrived as a peer's ledger row (or predates a restart) has
    // nothing to enclose.
    MeshRuntimeStore.getInstance().insertTurnEvent({
      eventId: `evt-orphan-${MESH}`, meshId: MESH, attemptId: `a-${MESH}`, taskId: 'tOrphan',
      kind: WORKER_HANDOFF_EVENT_KIND, dedupeKey: '',
      payload: JSON.stringify({ touchedFiles: ['src/a.ts'] }),
      occurredAtMs: Date.now(), recordedAt: new Date().toISOString(),
    })
    const picked = selectRelevantHandoffNotes({ meshId: MESH, taskId: 'tNew', touchedFiles: ['src/a.ts'] })
    expect(picked).toEqual([])
  })

  it('returns nothing when the incoming task declares no files and no mission', () => {
    seedNote({ taskId: 'tA', files: ['src/a.ts'] })
    expect(selectRelevantHandoffNotes({ meshId: MESH, taskId: 'tNew' })).toEqual([])
  })
})

// ─── Rendering + enclosure ───────────────────────────────────────────────

function candidate(taskId: string, over: Partial<HandoffNoteCandidate> = {}): HandoffNoteCandidate {
  return {
    meshId: MESH,
    taskId,
    notes: { intent: `intent ${taskId}`, touchedFiles: ['src/a.ts'] },
    recordedAtIso: new Date().toISOString(),
    reason: 'touched_files',
    overlap: ['src/a.ts'],
    ...over,
  }
}

describe('rendering', () => {
  it('renders nothing for an empty selection', () => {
    expect(renderHandoffNotesBlock([])).toBeNull()
  })

  it('includes intent, conflict guidance and the overlap reason', () => {
    const block = renderHandoffNotesBlock([
      candidate('tA', { notes: { intent: 'narrowed the key', conflictGuidance: 'keep the narrow one', touchedFiles: ['src/a.ts'] } }),
    ])!
    expect(block.text).toContain('narrowed the key')
    expect(block.text).toContain('keep the narrow one')
    expect(block.text).toContain('src/a.ts')
    expect(block.included).toBe(1)
    expect(block.omitted).toBe(0)
  })

  it('ANNOUNCES omission rather than truncating silently', () => {
    const many = Array.from({ length: HANDOFF_ENCLOSE_MAX_NOTES + 3 }, (_, i) => candidate(`t${i}`))
    const block = renderHandoffNotesBlock(many)!
    expect(block.included).toBe(HANDOFF_ENCLOSE_MAX_NOTES)
    expect(block.omitted).toBe(3)
    // A worker told nothing was dropped will reason as if it saw everything.
    expect(block.text).toMatch(/3 further related note\(s\) omitted/)
  })

  it('admits the first note even when it alone busts the byte budget', () => {
    const huge = candidate('tBig', { notes: { intent: 'x'.repeat(20_000), touchedFiles: ['src/a.ts'] } })
    const block = renderHandoffNotesBlock([huge, candidate('tSmall')], { maxBytes: 100 })!
    expect(block.included).toBe(1)
    expect(block.omitted).toBe(1)
  })
})

describe('dispatch enclosure', () => {
  it('returns the message UNCHANGED when nothing is relevant', () => {
    const original = 'Do the thing.'
    const out = composeTaskDispatchBody(original, { meshId: MESH, taskId: 'tNew', touchedFiles: ['src/none.ts'] })
    expect(out.body).toBe(original)
    expect(out.enclosedNotes).toBe(0)
  })

  it('appends the notes block after the original message, preserving it verbatim', () => {
    seedNote({ taskId: 'tA', files: ['src/a.ts'], intent: 'the earlier intent' })
    const original = 'Resolve the conflict in src/a.ts.'
    const out = composeTaskDispatchBody(original, { meshId: MESH, taskId: 'tNew', touchedFiles: ['src/a.ts'] })
    expect(out.body.startsWith(original)).toBe(true)
    expect(out.body).toContain('the earlier intent')
    expect(out.enclosedNotes).toBe(1)
  })
})

describe('retention constant', () => {
  it('is the owner-decided 30 days', () => {
    expect(HANDOFF_RETENTION_DAYS).toBe(30)
    expect(HANDOFF_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
