import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatQuotaWindow, quotaWindowCue } from '../../src/utils/quota-format'

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

describe('formatQuotaWindow — no-data stale marker', () => {
  const claudeStale = {
    provider: 'claude-cli',
    status: 'error',
    session: { usedPercent: 23.5, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 11, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1,
    error: 'Claude quota reading is stale (1201 min old) — open a Claude Code session to refresh',
    metadata: { source: 'statusline', failureKind: 'no-data' },
  } as const

  it('no-data with retained windows is stale, not refreshing', () => {
    expect(quotaWindowCue(claudeStale as never)).toBe('stale')
    expect(formatQuotaWindow(claudeStale.weekly, undefined, quotaWindowCue(claudeStale as never)))
      .toBe('11.0% used · stale')
    expect(formatQuotaWindow(claudeStale.session, undefined, quotaWindowCue(claudeStale as never)))
      .toBe('23.5% used · stale')
  })

  it('stale and refreshing are distinct suffixes', () => {
    expect(formatQuotaWindow(win(11), undefined, 'stale')).toBe('11.0% used · stale')
    expect(formatQuotaWindow(win(11), undefined, 'refreshing')).toBe('11.0% used · refreshing')
    expect(formatQuotaWindow(win(11), undefined, true)).toBe('11.0% used · refreshing')
  })

  it('lastGoodWindows wins over no-data when both are present', () => {
    const both = {
      ...claudeStale,
      metadata: { source: 'statusline', failureKind: 'no-data', lastGoodWindows: true },
    }
    expect(quotaWindowCue(both as never)).toBe('refreshing')
  })

  it('no-data without windows has no cue', () => {
    expect(quotaWindowCue({
      provider: 'claude-cli',
      status: 'error',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: 'no snapshot yet',
      metadata: { failureKind: 'no-data' },
    } as never)).toBeUndefined()
  })

  it('every dashboard surface that formats a window passes quotaWindowCue', () => {
    const files = [
      '../../src/pages/machine/OverviewTab.tsx',
      '../../src/pages/machine/InstalledProviderRow.tsx',
      '../../src/components/dashboard/SessionInfoDialog.tsx',
      '../../src/components/MeshGraph/MeshObservabilitySurface/MeshStatusTab.tsx',
    ]
    for (const rel of files) {
      const source = fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')
      expect(source, rel).toContain('quotaWindowCue(quota)')
      expect(source, rel).not.toContain('lastGoodWindows === true')
    }
  })
})
