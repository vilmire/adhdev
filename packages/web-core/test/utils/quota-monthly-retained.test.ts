import { describe, expect, it } from 'vitest'

import { buildQuotaDisplayModel } from '../../src/utils/quota-format'

// rc12 (2026-10-13): a monthly-only cursor reading retained across a transient
// failure must stay a 30d chip with the refreshing cue — never a failure line —
// and a monthly window with no usable percentage must not render as a number.
// The one-chip compactChip deliberately stays empty for monthly-only (pinned in
// quota-display-model.test.ts); this suite covers the full chip projection.
// Synthetic data only.

const NOW = 1_800_000_000_000

const retainedCursor = (monthly: unknown) => ({
  provider: 'cursor-cli',
  status: 'error',
  error: 'Cursor usage request failed: network',
  updatedAt: NOW - 5 * 60_000,
  session: null,
  weekly: null,
  monthly,
  metadata: {
    failureKind: 'network',
    lastGoodWindows: true,
    retryAtMs: NOW + 60_000,
    lastGood: { measuredAt: NOW - 5 * 60_000, source: 'api', planType: 'pro' },
  },
}) as never

describe('monthly-only retained reading (web projection)', () => {
  it('renders the retained 30d chip with the refreshing cue instead of the failure line', () => {
    const model = buildQuotaDisplayModel(retainedCursor({ usedPercent: 41.4, windowMinutes: 43200, resetsAt: null }), NOW)
    expect(model.kind).toBe('chips')
    expect(model.cue).toBe('refreshing')
    expect(model.chips).toHaveLength(1)
    expect(model.chips[0]).toMatchObject({ key: 'monthly', hint: 'monthly' })
    expect(model.chips[0]!.label).toMatch(/^30d 41\.4% used/)
    expect(model.message).toBeNull()
  })

  it('an unknown monthly percentage is not rendered as a number', () => {
    const model = buildQuotaDisplayModel(retainedCursor({ usedPercent: null, windowMinutes: 43200, resetsAt: null }), NOW)
    expect(model.chips).toEqual([])
    expect(model.kind).toBe('failure')
    expect(JSON.stringify(model)).not.toMatch(/0(\.0)?% used/)
  })
})
