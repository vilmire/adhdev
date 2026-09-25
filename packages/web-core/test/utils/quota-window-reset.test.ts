import { describe, expect, it } from 'vitest'
import { buildQuotaDisplayModel, formatQuotaWindow, isQuotaWindowReset, QUOTA_WINDOW_RESET_TEXT } from '../../src/utils/quota-format'

// Owner report 2026-09-25: the preview showed antigravity "5h 100.0% used · resets now · stale"
// after its 5h window had already reset. The daemon's gate already ignores a window whose reset
// passed (mesh-quota-routing isWindowExpired); the chip must not keep showing the previous
// window's usage as current either, nor colour it as exhausted.

const NOW = Date.parse('2026-09-25T14:22:45Z')
const past = NOW - 60 * 60_000
const future = NOW + 2 * 60 * 60_000

describe('quota window whose reset has passed', () => {
  it('is detected, and a future or missing reset is not', () => {
    expect(isQuotaWindowReset({ usedPercent: 100, windowMinutes: 300, resetsAt: past }, NOW)).toBe(true)
    expect(isQuotaWindowReset({ usedPercent: 100, windowMinutes: 300, resetsAt: future }, NOW)).toBe(false)
    expect(isQuotaWindowReset({ usedPercent: 100, windowMinutes: 300, resetsAt: null }, NOW)).toBe(false)
  })

  it('renders one state — no percent, no "resets now", no stale marker', () => {
    const text = formatQuotaWindow({ usedPercent: 100, windowMinutes: 300, resetsAt: past }, NOW, 'stale')
    expect(text).toBe(QUOTA_WINDOW_RESET_TEXT)
    expect(text).not.toMatch(/100|resets now|stale/)
  })

  it('a live window still renders usage and its reset countdown', () => {
    expect(formatQuotaWindow({ usedPercent: 40, windowMinutes: 300, resetsAt: future }, NOW)).toBe('40.0% used · resets in 2h 0m')
  })

  it('axis chip: neutral tone and no percent once reset', () => {
    const model = buildQuotaDisplayModel({
      status: 'error',
      session: { usedPercent: 100, windowMinutes: 300, resetsAt: past },
      weekly: { usedPercent: 39, windowMinutes: 10080, resetsAt: future },
      metadata: { failureKind: 'expired-token', lastGoodWindows: true },
    } as any, NOW)
    const session = model.chips.find(c => c.key === 'session')!
    expect(session.label).toBe(`5h ${QUOTA_WINDOW_RESET_TEXT}`)
    expect(session.tone).toBe('default')
    expect(session.usedPercent).toBeNull()
    const weekly = model.chips.find(c => c.key === 'weekly')!
    expect(weekly.usedPercent).toBe(39)
  })

  it('bucket chips (antigravity pools): the reset pool is neutral, the live pool keeps its tone', () => {
    const model = buildQuotaDisplayModel({
      status: 'error',
      buckets: [
        { name: 'Gemini Models · 5h', usedPercent: 100, windowMinutes: 300, resetsAt: past },
        { name: 'Claude/GPT Bundled Models · 5h', usedPercent: 80, windowMinutes: 300, resetsAt: future },
      ],
      metadata: { failureKind: 'expired-token', lastGoodWindows: true },
    } as any, NOW)
    const gemini = model.chips.find(c => c.label.startsWith('Gemini'))!
    expect(gemini.label).toContain(QUOTA_WINDOW_RESET_TEXT)
    expect(gemini.tone).toBe('default')
    const other = model.chips.find(c => !c.label.startsWith('Gemini'))!
    expect(other.tone).toBe('warn')
    expect(other.usedPercent).toBe(80)
  })
})
