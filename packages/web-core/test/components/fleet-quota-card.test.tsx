// Machines page: every machine's plan quota on one machines × CLIs grid.
import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import FleetQuotaCard from '../../src/pages/machine/FleetQuotaCard'
import { MachineQuotaChip } from '../../src/pages/machine/MachineQuotaChip'
import {
    buildQuotaDisplayModel,
    describeQuotaChipTooltip,
    ENGLISH_QUOTA_TEXT,
    selectMachineQuotaChips,
    shortQuotaChipLabel,
} from '../../src/utils/quota-format'

const ok = (provider: string, session: number, weekly: number) => ({
  provider, status: 'ok', updatedAt: 1, error: null,
  session: { usedPercent: session, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: weekly, windowMinutes: 10080, resetsAt: null },
}) as any

/**
 * LIVE_RESPONSE-shaped Antigravity snapshot (two pools × 5h/weekly).
 * Reset stamps are relative to "now" so SSR fleet render (Date.now()) still
 * shows live percentages rather than the post-reset dash.
 */
function antigravityLive(now: number = Date.now()) {
  const gemini5h = now + 2 * 3600_000 + 35 * 60_000
  const claude5h = now + 1 * 3600_000 + 58 * 60_000
  const gemini7d = now + 28 * 3600_000
  const claude7d = now + 13 * 3600_000
  return {
    provider: 'antigravity-cli',
    status: 'ok',
    updatedAt: now,
    error: null,
    session: { usedPercent: 1.34, windowMinutes: 300, resetsAt: claude5h },
    weekly: { usedPercent: 2.35, windowMinutes: 10080, resetsAt: claude7d },
    buckets: [
      { name: 'Gemini Models · Five Hour Limit Remaining', usedPercent: 0, windowMinutes: 300, resetsAt: gemini5h },
      { name: 'Gemini Models · Weekly Limit Remaining', usedPercent: 0.32, windowMinutes: 10080, resetsAt: gemini7d },
      { name: 'Claude and GPT models · Five Hour Limit Remaining', usedPercent: 1.34, windowMinutes: 300, resetsAt: claude5h },
      { name: 'Claude and GPT models · Weekly Limit Remaining', usedPercent: 2.35, windowMinutes: 10080, resetsAt: claude7d },
    ],
  } as any
}

function render(machines: Parameters<typeof FleetQuotaCard>[0]['machines']) {
  return renderToStaticMarkup(<MemoryRouter><FleetQuotaCard machines={machines} /></MemoryRouter>)
}

describe('FleetQuotaCard', () => {
  it('renders nothing until a machine reports quota', () => {
    expect(render([{ machineId: 'm1', label: 'mac', quota: undefined }])).toBe('')
  })

  it('lays out machines as rows and the union of CLIs as columns, with 5h/7d chips', () => {
    const html = render([
      { machineId: 'm1', label: 'mac', quota: { 'claude-cli': ok('claude-cli', 26, 92) } },
      { machineId: 'm2', label: 'windows-box', quota: { 'codex-cli': ok('codex-cli', 5, 40) } },
    ])
    expect(html).toContain('mac')
    expect(html).toContain('windows-box')
    expect(html).toContain('5h 26%')
    expect(html).toContain('7d 92%')
    expect(html).toContain('5h 5%')
    // accessible tooltip (sr-only) carries absolute+relative or unknown — not a bare title=
    expect(html).toContain('reset time unknown')
    expect(html).toContain('data-tooltip')
    // machine without a reading for a column gets a placeholder, not an empty chip
    expect((html.match(/>·</g) ?? []).length).toBe(2)
    // the high weekly reading is toned as danger
    expect(html).toMatch(/bg-red-500\/10[^>]*>7d 92%/)
  })

  it('a just-reset window shows a dash, with the full cue only in the tooltip', () => {
    const quota = { provider: 'claude-cli', status: 'ok', updatedAt: 1, error: null,
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: Date.now() - 60_000 },
      weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } } as any
    const html = render([{ machineId: 'm1', label: 'mac', quota: { 'claude-cli': quota } }])
    expect(html).toContain('>5h —<')
    expect(html).toContain('7d 10%')
  })

  it('Antigravity LIVE two pools → Gemini and Claude/GPT chips, not one compactChip', () => {
    const html = render([
      { machineId: 'm1', label: 'mac', quota: { 'antigravity-cli': antigravityLive() } },
    ])
    expect(html).toContain('Gemini 5h 0%')
    expect(html).toContain('Gemini 7d 0%')
    expect(html).toContain('Claude and GPT 5h 1%')
    expect(html).toContain('Claude and GPT 7d 2%')
    // Must not collapse to the single worst-headline compact chip alone.
    expect(html).not.toMatch(/>5h 1%<\/span>/)
    expect(html).toContain('data-quota-hint="bucket"')
    // Absolute + relative reset for a known resetsAt lands in sr-only tooltip text.
    expect(html).toMatch(/resets .+ · resets in/)
  })

  it('single-pool axes path stays one provider\'s session/weekly without inventing Gemini', () => {
    const html = render([
      { machineId: 'm1', label: 'mac', quota: { 'claude-cli': ok('claude-cli', 10, 20) } },
    ])
    expect(html).toContain('5h 10%')
    expect(html).toContain('7d 20%')
    expect(html).not.toContain('Gemini')
    expect(html).not.toContain('Claude and GPT')
  })
})

describe('MachineQuotaChip — hover/focus/tap tooltip contract (SSR + model)', () => {
  it('exposes kind hint + absolute/relative reset via aria-describedby sr-only text', () => {
    const now = Date.now()
    const model = buildQuotaDisplayModel(antigravityLive(now), now)
    const chip = selectMachineQuotaChips(model, 'row').find((c) => c.key === 'Gemini 5h')!
    const tip = describeQuotaChipTooltip(chip, 'Per-pool quota bucket', now, ENGLISH_QUOTA_TEXT, 'en-US')
    expect(tip).toContain('Per-pool quota bucket')
    expect(tip).toContain(formatAbsoluteExpect(chip.resetsAt!))
    expect(tip).toMatch(/resets in/)

    const html = renderToStaticMarkup(
      <MachineQuotaChip
        chip={chip}
        kindHint="Per-pool quota bucket"
        label={shortQuotaChipLabel(chip)}
        now={now}
        locale="en-US"
      />,
    )
    expect(html).toContain('data-tooltip')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('sr-only')
    expect(html).toContain('Gemini 5h 0%')
    expect(html).toContain('Per-pool quota bucket')
    expect(html).toMatch(/resets .+ · resets in/)
  })

  it('unknown resetsAt is explicit in the tooltip', () => {
    const now = Date.now()
    const model = buildQuotaDisplayModel(ok('codex-cli', 5, 40), now)
    const chip = selectMachineQuotaChips(model, 'row')[0]!
    const html = renderToStaticMarkup(
      <MachineQuotaChip chip={chip} kindHint="session hint" label={shortQuotaChipLabel(chip)} now={now} />,
    )
    expect(html).toContain('reset time unknown')
  })
})

function formatAbsoluteExpect(ms: number): string {
  // Same absolute helper path the chip uses — presence check only.
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

describe('Cursor 30d Machines projection', () => {
  it('shows the same 12.1% monthly reading as Session Info, with actual reset in fleet and rows', () => {
    const now = Date.now()
    const resetsAt = now + (6 * 24 + 4) * 3_600_000
    const quota = { provider: 'cursor-cli', session: null, weekly: null,
      monthly: { usedPercent: 12.1, windowMinutes: 43200, resetsAt },
      updatedAt: now, error: null, status: 'ok' } as any
    const model = buildQuotaDisplayModel(quota, now)
    for (const mode of ['fleet', 'row'] as const) {
      const chips = selectMachineQuotaChips(model, mode)
      expect(chips).toHaveLength(1)
      expect(chips[0]).toMatchObject({ hint: 'monthly', usedPercent: 12.1, resetsAt })
      expect(shortQuotaChipLabel(chips[0])).toBe('30d 12.1%')
      expect(describeQuotaChipTooltip(chips[0], 'Monthly', now)).toContain('resets in 6d 4h')
    }
    const html = render([{ machineId: 'cursor-machine', label: 'Cursor box', quota: { 'cursor-cli': quota } }])
    expect(html).toContain('30d 12.1%')
    expect(html).toContain('data-quota-hint="monthly"')
    expect(html).toContain('resets in 6d')
    expect(html).not.toContain('7d ')
  })

  it('keeps missing, stale and already reset monthly readings distinct', () => {
    const now = Date.now()
    const base = { provider: 'cursor-cli', session: null, weekly: null, status: 'ok', error: null, updatedAt: now - 2 * 86_400_000 } as any
    expect(selectMachineQuotaChips(buildQuotaDisplayModel(base, now), 'fleet')).toEqual([])
    const stale = buildQuotaDisplayModel({ ...base, monthly: { usedPercent: 100, windowMinutes: 43200, resetsAt: now + 86_400_000 } }, now)
    expect(selectMachineQuotaChips(stale, 'fleet')[0]).toMatchObject({ hint: 'monthly', usedPercent: 100 })
    expect(shortQuotaChipLabel(selectMachineQuotaChips(stale, 'fleet')[0])).toContain('stale')
    const reset = buildQuotaDisplayModel({ ...base, monthly: { usedPercent: 100, windowMinutes: 43200, resetsAt: now } }, now)
    expect(shortQuotaChipLabel(selectMachineQuotaChips(reset, 'fleet')[0])).toBe('30d —')
  })
})
