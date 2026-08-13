import { describe, expect, it } from 'vitest'
import { formatQuotaWindow } from '../../src/utils/quota-format'

// Companion to daemon-core's carryForwardLastGoodWindows (oss/packages/daemon-core/src/quota/refresh.ts):
// once a snapshot carries metadata.lastGoodWindows, the reader must be able to
// tell "this number is real but not from this tick" from a freshly measured
// value — otherwise the retained number looks indistinguishable from a fresh
// OK read, which defeats the point of surfacing the fresh failure signal.

const win = (usedPercent: number) => ({ usedPercent, windowMinutes: 300, resetsAt: null })

describe('formatQuotaWindow — last-good carry-forward marker', () => {
  it('a freshly measured window renders with no suffix', () => {
    expect(formatQuotaWindow(win(28))).toBe('28.0% used')
  })

  it('a carried-forward window appends "· refreshing"', () => {
    expect(formatQuotaWindow(win(28), undefined, true)).toBe('28.0% used · refreshing')
  })

  it('the refreshing marker composes with a reset time', () => {
    const now = 1_000_000
    const resetsAt = now + 2 * 60 * 60 * 1000 + 14 * 60 * 1000 // 2h14m out
    const window = { usedPercent: 28, windowMinutes: 300, resetsAt }
    expect(formatQuotaWindow(window, now, true)).toBe('28.0% used · resets in 2h 14m · refreshing')
  })

  it('a null window stays null regardless of the flag', () => {
    expect(formatQuotaWindow(null, undefined, true)).toBeNull()
    expect(formatQuotaWindow(undefined, undefined, true)).toBeNull()
  })
})
