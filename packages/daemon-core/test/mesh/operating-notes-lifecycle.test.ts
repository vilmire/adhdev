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
    const texts = shown.map(n => n.text)
    expect(texts).toContain('pinned-old-recovery')
    expect(texts).toContain('fresh-recovery')
  })

  it('drops expired non-pinned notes', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'expired-recovery', category: 'recovery_lesson', createdAt: daysAgo(30) },
      { text: 'live-quirk', category: 'provider_quirk', createdAt: daysAgo(999) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    const texts = shown.map(n => n.text)
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
    expect(shown.map(n => n.text)).toEqual(['pinned-recovery', 'durable-quirk', 'recent-recovery'])
  })

  it('within a tier, newer notes lead (recency tiebreak)', () => {
    // ledger order is oldest-first; index encodes recency.
    const notes: CoordinatorOperatingNote[] = [
      { text: 'older-quirk', category: 'provider_quirk', createdAt: daysAgo(100) },
      { text: 'newer-quirk', category: 'provider_quirk', createdAt: daysAgo(2) },
    ]
    const { shown } = selectOperatingNotesForPrompt(notes, NOW)
    expect(shown.map(n => n.text)).toEqual(['newer-quirk', 'older-quirk'])
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
    const texts = shown.map(n => n.text)
    // all pinned survive
    for (let i = 0; i < 3; i++) expect(texts).toContain(`pin-${i}`)
    // all durable survive
    for (let i = 0; i < 3; i++) expect(texts).toContain(`quirk-${i}`)
    // remaining slots filled by recency of recovery notes; some omitted
    expect(omittedCount).toBeGreaterThan(0)
    // omitted are the lowest-priority recency tail (recovery_lessons), never pinned/durable
    expect(shown.filter(n => n.pinned).length).toBe(3)
  })

  it('expired-and-dropped notes do not count toward omittedCount', () => {
    const notes: CoordinatorOperatingNote[] = [
      { text: 'keep', category: 'provider_quirk', createdAt: daysAgo(1) },
      { text: 'gone', category: 'recovery_lesson', createdAt: daysAgo(90) },
    ]
    const { shown, omittedCount } = selectOperatingNotesForPrompt(notes, NOW, 20)
    expect(shown.map(n => n.text)).toEqual(['keep'])
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
