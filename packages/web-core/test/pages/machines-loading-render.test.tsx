// LIVE RENDER proof for the loading-vs-empty gate on the machines page.
//
// Uses renderToStaticMarkup, so it needs no DOM and runs in the default `node`
// environment (jsdom is declared in package.json but not installed here).
//
// The source-text test (machines-loading-vs-empty.test.ts) pins the shape of
// the fix; this one actually mounts the page and asserts what a user sees in
// the two states that used to be indistinguishable:
//
//   initialLoaded=false, ides=[]  -> "still loading"  (must NOT onboard)
//   initialLoaded=true,  ides=[]  -> genuinely empty  (must onboard)
//
// The production symptom was the first case rendering the second's UI: an
// account with four connected machines showed "0 burrows / 0 online" and
// "Welcome to ADHDev - connect your first machine" for ~5s until the WS
// initial_state landed.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'

// i18n: return the key so assertions are locale-independent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom')
  return { ...actual, useNavigate: () => () => {} }
})

const daemonCtx = { ides: [] as any[], initialLoaded: false }

vi.mock('../../src/compat', () => ({
  useDaemons: () => daemonCtx,
  dashboardWS: { send: () => {}, on: () => {}, off: () => {} },
}))
vi.mock('../../src/hooks/useDaemonMetadataLoader', () => ({
  useDaemonMetadataLoader: () => async () => {},
}))
vi.mock('../../src/hooks/useDaemonMachineRuntimeLoader', () => ({
  useDaemonMachineRuntimeLoader: () => async () => {},
}))
vi.mock('../../src/hooks/useDaemonMachineRuntimeSubscription', () => ({
  useDaemonMachineRuntimeSubscription: () => {},
}))
vi.mock('../../src/components/InstallCommand', () => ({
  default: () => React.createElement('div', null, 'INSTALL_COMMAND'),
}))

async function renderPage(initialLoaded: boolean): Promise<string> {
  daemonCtx.initialLoaded = initialLoaded
  daemonCtx.ides = []
  const { default: MachinesPage } = await import('../../src/pages/Machines')
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(MachinesPage as any)),
  )
}

describe('machines page render — loading vs empty', () => {
  it('while loading: shows the placeholder, NOT the onboarding state', async () => {
    const html = await renderPage(false)
    expect(html).toContain('machine.card.loading')
    // The exact production defect: onboarding while data was still in flight.
    expect(html).not.toContain('machine.card.emptyHeadline')
    expect(html).not.toContain('INSTALL_COMMAND')
  })

  it('while loading: does not claim "0 burrows / 0 online"', async () => {
    const html = await renderPage(false)
    expect(html).not.toContain('machine.card.burrowCount')
    expect(html).not.toContain('machine.card.onlineCount')
  })

  it('once loaded and genuinely empty: shows onboarding', async () => {
    const html = await renderPage(true)
    expect(html).toContain('machine.card.emptyHeadline')
    expect(html).toContain('INSTALL_COMMAND')
    expect(html).not.toContain('machine.card.loading')
  })

  it('once loaded: the counters are rendered', async () => {
    const html = await renderPage(true)
    expect(html).toContain('machine.card.burrowCount')
    expect(html).toContain('machine.card.onlineCount')
  })
})
