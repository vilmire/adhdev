// Machines page: every machine's plan quota on one machines × CLIs grid.
import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import FleetQuotaCard from '../../src/pages/machine/FleetQuotaCard'

const ok = (provider: string, session: number, weekly: number) => ({
  provider, status: 'ok', updatedAt: 1, error: null,
  session: { usedPercent: session, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: weekly, windowMinutes: 10080, resetsAt: null },
}) as any

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
    // full reading stays in the hover title
    expect(html).toContain('5h 26.0% used')
    // machine without a reading for a column gets a placeholder, not an empty chip
    expect((html.match(/>·</g) ?? []).length).toBe(2)
    // the high weekly reading is toned as danger
    expect(html).toMatch(/bg-red-500\/10[^>]*>7d 92%/)
  })

  it('a just-reset window shows a dash, with the full cue only in the title', () => {
    const quota = { provider: 'claude-cli', status: 'ok', updatedAt: 1, error: null,
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: Date.now() - 60_000 },
      weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } } as any
    const html = render([{ machineId: 'm1', label: 'mac', quota: { 'claude-cli': quota } }])
    expect(html).toContain('>5h —<')
    expect(html).toContain('7d 10%')
  })
})
