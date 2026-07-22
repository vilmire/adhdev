import { describe, expect, it } from 'vitest'
import {
  isNoteExpired,
  OPERATING_NOTE_CATEGORY_TTL_DAYS,
} from '../../src/mesh/mesh-ledger.js'
import {
  selectOperatingNotesForPrompt,
  buildCoordinatorSystemPrompt,
} from '../../src/mesh/coordinator-prompt.js'
import type { CoordinatorOperatingNote } from '../../src/mesh/coordinator-prompt.js'

// Deterministic clock: 2026-07-22T00:00:00Z. All ages are computed relative to
// this `now`, never Date.now(), so the assertions are stable.
const NOW = new Date('2026-07-22T00:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()

describe('operating-notes lifecycle: isNoteExpired per category', () => {
  it('recovery_lesson expires at ~14 days (unpinned)', () => {
    expect(OPERATING_NOTE_CATEGORY_TTL_DAYS.recovery_lesson).toBe(14)
    expect(isNoteExpired({ category: 'recovery_lesson', createdAt: daysAgo(13) }, NOW)).toBe(false)
    expect(isNoteExpired({ category: 'recovery_lesson', createdAt: daysAgo(15) }, NOW)).toBe(true)
    // exactly 14 days → expired (>= boundary)
    expect(isNoteExpired({ category: 'recovery_lesson', createdAt: daysAgo(14) }, NOW)).toBe(true)
  })

  it('pattern_to_avoid expires at ~30 days (unpinned)', () => {
    expect(OPERATING_NOTE_CATEGORY_TTL_DAYS.pattern_to_avoid).toBe(30)
    expect(isNoteExpired({ category: 'pattern_to_avoid', createdAt: daysAgo(29) }, NOW)).toBe(false)
    expect(isNoteExpired({ category: 'pattern_to_avoid', createdAt: daysAgo(31) }, NOW)).toBe(true)
  })

  it('provider_quirk is durable (never expires)', () => {
    expect(OPERATING_NOTE_CATEGORY_TTL_DAYS.provider_quirk).toBeUndefined()
    expect(isNoteExpired({ category: 'provider_quirk', createdAt: daysAgo(365) }, NOW)).toBe(false)
  })

  it('uncategorized is durable (never expires)', () => {
    expect(isNoteExpired({ createdAt: daysAgo(365) }, NOW)).toBe(false)
  })

  it('pinned notes never expire regardless of category or age', () => {
    expect(isNoteExpired({ category: 'recovery_lesson', pinned: true, createdAt: daysAgo(999) }, NOW)).toBe(false)
  })

  it('falls back to entry.timestamp when createdAt absent', () => {
    expect(isNoteExpired({ category: 'recovery_lesson', timestamp: daysAgo(20) }, NOW)).toBe(true)
    expect(isNoteExpired({ category: 'recovery_lesson', timestamp: daysAgo(2) }, NOW)).toBe(false)
  })

  it('unparseable/absent age is treated as NOT expired (never silently dropped)', () => {
    expect(isNoteExpired({ category: 'recovery_lesson' }, NOW)).toBe(false)
    expect(isNoteExpired({ category: 'recovery_lesson', createdAt: 'not-a-date' }, NOW)).toBe(false)
  })

  it('explicit expiresAt in the past expires an unpinned note (overrides category)', () => {
    // provider_quirk is durable by category, but an explicit expiry still applies.
    expect(isNoteExpired({ category: 'provider_quirk', expiresAt: daysAgo(1), createdAt: daysAgo(2) }, NOW)).toBe(true)
    expect(isNoteExpired({ category: 'provider_quirk', expiresAt: daysAgo(-1), createdAt: daysAgo(2) }, NOW)).toBe(false)
  })
})

describe('operating-notes lifecycle: selectOperatingNotesForPrompt', () => {
  it('always includes pinned notes even when their category TTL would expire them', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'pinned-old-recovery', category: 'recovery_lesson', pinned: true, createdAt: daysAgo(999) },
      { text: 'fresh-recovery', category: 'recovery_lesson', createdAt: daysAgo(1) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).toContain('pinned-old-recovery')
    expect(texts).toContain('fresh-recovery')
  })

  it('drops expired non-pinned notes', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'expired-recovery', category: 'recovery_lesson', createdAt: daysAgo(30) },
      { text: 'live-quirk', category: 'provider_quirk', createdAt: daysAgo(999) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).not.toContain('expired-recovery')
    expect(texts).toContain('live-quirk')
  })

  it('ranks pinned > durable > recency', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'durable-quirk', category: 'provider_quirk', createdAt: daysAgo(100) },
      { text: 'recent-recovery', category: 'recovery_lesson', createdAt: daysAgo(1) },
      { text: 'pinned-recovery', category: 'recovery_lesson', pinned: true, createdAt: daysAgo(50) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    expect(shown.map(f => f.note.text)).toEqual(['pinned-recovery', 'durable-quirk', 'recent-recovery'])
  })

  it('within a tier, newer notes lead (recency tiebreak)', () => {
    // ledger order is oldest-first; index encodes recency.
    const notes: CoordinatorOperatingNote[] = [
      { text: 'older-quirk', category: 'provider_quirk', createdAt: daysAgo(100) },
      { text: 'newer-quirk', category: 'provider_quirk', createdAt: daysAgo(2) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    expect(shown.map(f => f.note.text)).toEqual(['newer-quirk', 'older-quirk'])
  })

  it('applies the cap AFTER selection — pinned + durable survive the cap', () => {
    // 3 pinned recovery + 3 durable quirks + a burst of fresh recovery_lessons.
    const notes: CoordinatorOperatingNote[] = []
    for (let i = 0; i < 3; i++) notes.push({ text: `pin-${i}`, category: 'recovery_lesson', pinned: true, createdAt: daysAgo(200 + i) })
    for (let i = 0; i < 3; i++) notes.push({ text: `quirk-${i}`, category: 'provider_quirk', createdAt: daysAgo(150 + i) })
    for (let i = 0; i < 30; i++) notes.push({ text: `recovery-${i}`, category: 'recovery_lesson', createdAt: daysAgo(1) })

    const cap = 20
    const { shown, omittedCount } = selectOperatingNotesForPrompt(notes, NOW, cap)
    expect(shown.length).toBe(cap)
    const texts = shown.map(f => f.note.text)
    // all pinned survive
    for (let i = 0; i < 3; i++) expect(texts).toContain(`pin-${i}`)
    // all durable survive
    for (let i = 0; i < 3; i++) expect(texts).toContain(`quirk-${i}`)
    // remaining slots filled by recency of recovery notes; some omitted
    expect(omittedCount).toBeGreaterThan(0)
    // omitted are the lowest-priority recency tail (recovery_lessons), never pinned/durable
    expect(shown.filter(f => f.note.pinned).length).toBe(3)
  })

  it('expired-and-dropped notes do not count toward omittedCount', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'keep', category: 'provider_quirk', createdAt: daysAgo(1) },
      { text: 'gone', category: 'recovery_lesson', createdAt: daysAgo(90) },
    ]
    const { shown, omittedCount } = selectOperatingNotesForPrompt(notes, NOW, 20)
    expect(shown.map(f => f.note.text)).toEqual(['keep'])
    expect(omittedCount).toBe(0)
  })
})

describe('operating-notes lifecycle: prompt rendering', () => {
  const baseMesh = {
    id: 'mesh_1',
    name: 'ADHDev',
    repoIdentity: 'github.com/acme/adhdev',
    nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  it('renders pinned notes with a pin marker and includes durable notes', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh as any,
      coordinatorCliType: 'claude-cli',
      operatingNotes: [
        { text: 'PINNED_NOTE_ALPHA', category: 'recovery_lesson', pinned: true, createdAt: '2026-01-01T00:00:00Z' },
        { text: 'DURABLE_QUIRK_BETA', category: 'provider_quirk', createdAt: '2026-07-21T00:00:00Z' },
      ],
    })
    expect(prompt).toContain('## Operating Notes')
    expect(prompt).toContain('📌')
    expect(prompt).toContain('PINNED_NOTE_ALPHA')
    expect(prompt).toContain('DURABLE_QUIRK_BETA')
  })
})

// ─── Phase 2 (b): version-supersede ─────────────────────────────────────────
describe('operating-notes Phase 2: version-supersede', () => {
  it('a later note supersedes an earlier one by noteId (earlier hidden)', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'old-lesson', category: 'provider_quirk', createdAt: daysAgo(10), noteId: 'note-a' },
      { text: 'new-lesson', category: 'provider_quirk', createdAt: daysAgo(1), noteId: 'note-b', supersedes: 'note-a' },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).toContain('new-lesson')
    expect(texts).not.toContain('old-lesson')
  })

  it('supersede targets a shared subjectKey (all earlier same-subject notes hidden)', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'v1', category: 'provider_quirk', createdAt: daysAgo(10), subjectKey: 'topic-x' },
      { text: 'v2', category: 'provider_quirk', createdAt: daysAgo(2), subjectKey: 'topic-x', supersedes: 'topic-x' },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).toEqual(['v2'])
  })

  it('never hides a pinned note even when superseded', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'pinned-old', category: 'provider_quirk', pinned: true, createdAt: daysAgo(10), noteId: 'p-1' },
      { text: 'newer', category: 'provider_quirk', createdAt: daysAgo(1), noteId: 'p-2', supersedes: 'p-1' },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).toContain('pinned-old')
    expect(texts).toContain('newer')
  })

  it('lossless legacy: notes without supersedes/subjectKey are all kept', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'legacy-a', category: 'provider_quirk', createdAt: daysAgo(5) },
      { text: 'legacy-b', category: 'provider_quirk', createdAt: daysAgo(1) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).toContain('legacy-a')
    expect(texts).toContain('legacy-b')
  })

  it('an EARLIER note does not supersede a LATER note (direction matters)', () => {
    // note-a records supersedes:note-b but note-b comes AFTER a → b must survive.
    const notes: CoordinatorOperatingNote[] = [
      { text: 'a-early', category: 'provider_quirk', createdAt: daysAgo(10), noteId: 'note-a', supersedes: 'note-b' },
      { text: 'b-late', category: 'provider_quirk', createdAt: daysAgo(1), noteId: 'note-b' },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(f => f.note.text)
    expect(texts).toContain('b-late')
  })
})

// ─── Phase 2 (c): same-class deterministic fold ─────────────────────────────
describe('operating-notes Phase 2: same-class fold', () => {
  it('folds same-category notes sharing a leading [tag] into one entry (newest kept)', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: '[flap] first observation', category: 'pattern_to_avoid', createdAt: daysAgo(3), noteId: 'f-1' },
      { text: '[flap] second observation', category: 'pattern_to_avoid', createdAt: daysAgo(1), noteId: 'f-2' },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    // Only the newest survives as the standalone entry; older is subsumed.
    expect(shown.length).toBe(1)
    expect(shown[0].note.text).toBe('[flap] second observation')
    expect(shown[0].subsumedCount).toBe(1)
    expect(shown[0].subsumedIds).toEqual(['f-1'])
  })

  it('fold is deterministic — same input, same output, and lists subsumed ids', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'a', category: 'provider_quirk', createdAt: daysAgo(5), subjectKey: 's', noteId: 'n1' },
      { text: 'b', category: 'provider_quirk', createdAt: daysAgo(3), subjectKey: 's', noteId: 'n2' },
      { text: 'c', category: 'provider_quirk', createdAt: daysAgo(1), subjectKey: 's', noteId: 'n3' },
    ]
    const first = selectOperatingNotesForPrompt(notes, NOW)
    const second = selectOperatingNotesForPrompt(notes, NOW)
    expect(first.shown.length).toBe(1)
    expect(first.shown[0].note.text).toBe('c') // newest survivor
    expect(first.shown[0].subsumedCount).toBe(2)
    expect(first.shown[0].subsumedIds.sort()).toEqual(['n1', 'n2'])
    // deterministic
    expect(second.shown.map(f => f.note.text)).toEqual(first.shown.map(f => f.note.text))
  })

  it('does not fold across different categories or subjects', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: '[x] quirk note', category: 'provider_quirk', createdAt: daysAgo(2) },
      { text: '[x] pattern note', category: 'pattern_to_avoid', createdAt: daysAgo(1) },
      { text: '[y] other quirk', category: 'provider_quirk', createdAt: daysAgo(1) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    expect(shown.length).toBe(3)
    for (const f of shown) expect(f.subsumedCount).toBe(0)
  })

  it('pinned notes never fold — each shown verbatim', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: '[p] pinned one', category: 'provider_quirk', pinned: true, createdAt: daysAgo(3) },
      { text: '[p] pinned two', category: 'provider_quirk', pinned: true, createdAt: daysAgo(1) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    expect(shown.length).toBe(2)
  })

  it('legacy notes with no category/subject never fold (lossless)', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'plain note one', createdAt: daysAgo(2) },
      { text: 'plain note two', createdAt: daysAgo(1) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    expect(shown.length).toBe(2)
  })

  it('renders a fold marker in the prompt when notes are subsumed', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1', name: 'ADHDev', repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
      operatingNotes: [
        { text: '[topic] older', category: 'provider_quirk', createdAt: '2026-07-01T00:00:00Z', noteId: 'old' },
        { text: '[topic] newer', category: 'provider_quirk', createdAt: '2026-07-20T00:00:00Z', noteId: 'new' },
      ],
    })
    expect(prompt).toContain('[topic] newer')
    expect(prompt).not.toContain('[topic] older')
    expect(prompt).toContain('folded')
  })
})

// ─── Phase 2 (d): byte-budget-bounded selection ─────────────────────────────
describe('operating-notes Phase 2: byte budget', () => {
  const bigText = (label: string) => `${label} ${'x'.repeat(500)}`

  it('byte budget bounds the unpinned tail (fewer notes than the count cap)', () => {
    // Each note ~520 bytes rendered; a 1200-byte budget fits ~2 of them.
    const notes: CoordinatorOperatingNote[] = []
    for (let i = 0; i < 10; i++) {
      notes.push({ text: bigText(`quirk-${i}`), category: 'provider_quirk', createdAt: daysAgo(10 - i) })
    }
    const { shown } = selectOperatingNotesForPrompt(notes, NOW, 20, 1200)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(10) // budget cut the tail before the count cap
  })

  it('never drops a pinned note to fit the budget — pinned kept even if they exceed it', () => {
    const notes: CoordinatorOperatingNote[] = []
    for (let i = 0; i < 5; i++) {
      notes.push({ text: bigText(`pin-${i}`), category: 'provider_quirk', pinned: true, createdAt: daysAgo(5 - i) })
    }
    // Tiny budget that a single note already exceeds — all 5 pinned must survive.
    const { shown } = selectOperatingNotesForPrompt(notes, NOW, 20, 100)
    expect(shown.length).toBe(5)
    expect(shown.every(f => f.note.pinned)).toBe(true)
  })

  it('at least one unpinned note is always admitted (budget never yields an empty tail)', () => {
    // A single note larger than the whole budget should still be shown (first-fit).
    const notes: CoordinatorOperatingNote[] = [
      { text: bigText('lonely'), category: 'provider_quirk', createdAt: daysAgo(1) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW, 20, 50)
    expect(shown.length).toBe(1)
  })
})
