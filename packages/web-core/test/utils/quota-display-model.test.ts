import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildQuotaDisplayModel } from '../../src/utils/quota-format'

// THE shared quota view-model. Four dashboards render the same
// MeshNodeFactsProviderQuota snapshot (mesh Status tab, machine Overview card,
// session-info dialog, installed-provider row). Each used to re-derive
// cue/buckets/axes/usage/ok-without-windows/failure on its own, and the rules
// drifted apart repeatedly — the 2026-08-24 wave alone re-aligned the monthly
// axis, the ok-without-windows neutral line, antigravity's bucket replacement,
// and cue threading BY HAND in four places. buildQuotaDisplayModel is now the
// single content-assembly step; surfaces only choose how each kind LOOKS.
//
// Two guards live here:
//  1. UNIT — the model over the six representative live snapshot shapes.
//  2. DRIFT — source assertions that every consumer goes through the model and
//     none has re-grown its own assembly out of the raw snapshot.

const q = (overrides: Record<string, unknown>) => ({
  provider: 'codex-cli', status: 'ok', updatedAt: 1, error: null,
  session: null, weekly: null,
  ...overrides,
}) as never

describe('buildQuotaDisplayModel — representative snapshots', () => {
  it('ok with the 5h/7d axes → tinted window chips, session as the compact chip', () => {
    const model = buildQuotaDisplayModel(q({
      session: { usedPercent: 26, windowMinutes: 300, resetsAt: null },
      weekly: { usedPercent: 92, windowMinutes: 10080, resetsAt: null },
    }))
    expect(model.kind).toBe('chips')
    expect(model.chips.map(c => c.label)).toEqual(['5h 26.0% used', '7d 92.0% used'])
    expect(model.chips.map(c => c.hint)).toEqual(['session', 'weekly'])
    // Same 70/90 thresholds as the `adhdev quota` CLI bar colour.
    expect(model.chips.map(c => c.tone)).toEqual(['good', 'danger'])
    expect(model.message).toBeNull()
    expect(model.usageLabel).toBeNull()
    // Tight surfaces (provider-row header) show the 5h reading.
    expect(model.compactChip).toMatchObject({ hint: 'session', label: '5h 26.0% used' })
  })

  it('cursor monthly-only → the 30d billing axis chips, but NO compact chip', () => {
    // The 2026-08-24 drift case: the monthly axis existed in the snapshot but
    // only some surfaces had learned to render it.
    const model = buildQuotaDisplayModel(q({
      provider: 'cursor-cli',
      monthly: { usedPercent: 71.2, windowMinutes: 43200, resetsAt: null },
    }))
    expect(model.kind).toBe('chips')
    expect(model.chips).toHaveLength(1)
    expect(model.chips[0]).toMatchObject({ key: 'monthly', label: '30d 71.2% used', hint: 'monthly', tone: 'warn' })
    // A 30d billing axis alone is not a "how am I doing right now" number —
    // the one-chip surface stays empty rather than promoting it.
    expect(model.compactChip).toBeNull()
  })

  it('cursor ok WITHOUT windows → okNoWindows with the provider message, never a failure', () => {
    // The fetch succeeded and the account state is real; there is just no
    // percentage window. Rendering the failure line here misreported a healthy
    // reading as broken (owner-visible 2026-08-24).
    const withMessage = buildQuotaDisplayModel(q({
      provider: 'cursor-cli',
      metadata: { cursorUsage: { displayMessage: "You've used 0% of your included usage" } },
    }))
    expect(withMessage.kind).toBe('okNoWindows')
    expect(withMessage.message).toBe("You've used 0% of your included usage")
    expect(withMessage.chips).toEqual([])
    expect(withMessage.compactChip).toBeNull()

    // No provider message → message null, so the CALLER renders its own
    // neutral i18n line (each surface keeps its own wording).
    expect(buildQuotaDisplayModel(q({ provider: 'cursor-cli' }))).toMatchObject({ kind: 'okNoWindows', message: null })
  })

  it('antigravity multi-pool buckets REPLACE the collapsed axes; compact chip stays the worst-of-pools 5h', () => {
    const model = buildQuotaDisplayModel(q({
      provider: 'antigravity-cli',
      session: { usedPercent: 44.5, windowMinutes: 300, resetsAt: null },
      weekly: { usedPercent: 9, windowMinutes: 10080, resetsAt: null },
      buckets: [
        { name: 'Gemini Models · 5h Limit Remaining', usedPercent: 44.5, windowMinutes: 300, resetsAt: null },
        { name: 'Gemini Models · Weekly Limit Remaining', usedPercent: 9, windowMinutes: 10080, resetsAt: null },
        { name: 'Claude/GPT Bundled Models · 5h Limit Remaining', usedPercent: 12, windowMinutes: 300, resetsAt: null },
        { name: 'Claude/GPT Bundled Models · Weekly Limit Remaining', usedPercent: 3, windowMinutes: 10080, resetsAt: null },
      ],
    }))
    expect(model.kind).toBe('chips')
    // Per-pool truth, not the axes — showing both would render the same
    // numbers twice.
    expect(model.chips.map(c => c.label)).toEqual([
      'Claude/GPT 5h 12.0% used',
      'Claude/GPT 7d 3.0% used',
      'Gemini 5h 44.5% used',
      'Gemini 7d 9.0% used',
    ])
    expect(model.chips.every(c => c.hint === 'bucket')).toBe(true)
    // …but the one-chip surface wants the worst-of-pools HEADLINE, not one
    // arbitrary pool, so the compact chip is built from the collapsed axes.
    expect(model.compactChip).toMatchObject({ hint: 'session', label: '5h 44.5% used' })
  })

  it('opencode usage shape → usage kind with the tokens/cost label, info tone', () => {
    // A BYO-provider router has no rate-limit percentage to report — absolute
    // usage over a trailing window is the whole reading.
    const model = buildQuotaDisplayModel(q({
      provider: 'opencode',
      metadata: { usage: { days: 7, totalCostUsd: 12.34, inputTokens: 100_000, outputTokens: 84_230, sessions: 5 } },
    }))
    expect(model.kind).toBe('usage')
    expect(model.usageLabel).toBe('7d $12.34 · 184.2K tok · 5 sess')
    expect(model.chips).toEqual([])
    expect(model.compactChip).toMatchObject({ hint: 'usage', tone: 'info', label: '7d $12.34 · 184.2K tok · 5 sess', usedPercent: null })
  })

  it('non-ok without windows → failure with the failureKind-bearing message', () => {
    const model = buildQuotaDisplayModel(q({
      provider: 'kimi', status: 'error', error: 'request failed',
      metadata: { failureKind: 'expired-token' },
    }))
    expect(model.kind).toBe('failure')
    // The kind is what separates "not installed" from "channel broken".
    expect(model.message).toBe('request failed (expired token)')
    expect(model.chips).toEqual([])
    expect(model.compactChip).toBeNull()
  })

  it('threads the freshness cue into every chip label — carry-forward and stale alike', () => {
    // refreshing: last-good carry-forward after a transient failure.
    const refreshing = buildQuotaDisplayModel(q({
      session: { usedPercent: 28, windowMinutes: 300, resetsAt: null },
      metadata: { lastGoodWindows: true },
    }))
    expect(refreshing.cue).toBe('refreshing')
    expect(refreshing.chips[0].label).toBe('5h 28.0% used · refreshing')
    expect(refreshing.compactChip?.label).toBe('5h 28.0% used · refreshing')

    // stale: retained numbers with failureKind no-data (Claude statusline aged
    // out) — nothing is retrying, so it must NOT wear 'refreshing'.
    const stale = buildQuotaDisplayModel(q({
      provider: 'claude-cli', status: 'error', error: 'stale',
      session: { usedPercent: 23.5, windowMinutes: 300, resetsAt: null },
      metadata: { source: 'statusline', failureKind: 'no-data', lastGoodWindows: true },
    }))
    expect(stale.cue).toBe('stale')
    expect(stale.chips[0].label).toBe('5h 23.5% used · stale')
  })
})

// ── Drift guard ─────────────────────────────────────────────────────────────
// Every quota display surface must consume buildQuotaDisplayModel and must NOT
// re-grow its own content assembly from the raw snapshot. These are the exact
// symbols whose per-surface copies drifted before the consolidation; a surface
// that needs one of them again should be extending the MODEL, not itself.
describe('drift guard — all quota surfaces consume the shared view-model', () => {
  const SURFACES = [
    '../../src/components/MeshGraph/MeshObservabilitySurface/MeshStatusTab.tsx',
    '../../src/pages/machine/OverviewTab.tsx',
    '../../src/components/dashboard/SessionInfoDialog.tsx',
    '../../src/pages/machine/InstalledProviderRow.tsx',
  ]

  const FORBIDDEN = [
    'collectQuotaBucketChips',      // bucket assembly is the model's job
    'formatQuotaWindow',            // direct axis formatting = re-grown assembly
    'formatQuotaUsage',             // usage fallback decision lives in the model
    'describeQuotaOkWithoutWindows',// ok-vs-failure split lives in the model
    'describeQuotaFailure',         // failure text arrives as model.message
    'quotaWindowCue',               // cue is computed once, inside the model
    'quotaUsageTone',               // tones ride on the chips themselves
    'lastGoodWindows',              // never inspect the raw metadata in a view
  ]

  for (const rel of SURFACES) {
    it(`${path.basename(rel)} renders from buildQuotaDisplayModel only`, () => {
      const source = fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')
      expect(source).toContain('buildQuotaDisplayModel(quota)')
      for (const symbol of FORBIDDEN) {
        expect(source, `${rel} re-grew its own quota assembly (${symbol})`).not.toContain(symbol)
      }
    })
  }

  it('the model itself stays bundle-safe (mesh-shared types only, no daemon-core barrel)', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/utils/quota-format.ts'), 'utf8')
    expect(source).toContain('export function buildQuotaDisplayModel')
    expect(source).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'@adhdev\/daemon-core'/m)
  })
})
