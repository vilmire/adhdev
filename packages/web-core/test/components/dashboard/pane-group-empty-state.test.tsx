import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PaneGroupEmptyState from '../../../src/components/dashboard/PaneGroupEmptyState'
import { DASHBOARD_NEW_SESSION_DESCRIPTION, DASHBOARD_NEW_SESSION_LABEL } from '../../../src/components/dashboard/dashboard-session-cta'

function renderEmptyState(props: Partial<React.ComponentProps<typeof PaneGroupEmptyState>> = {}) {
  return renderToStaticMarkup(
    <PaneGroupEmptyState
      conversationsCount={0}
      isSplitMode={false}
      isStandalone={true}
      hasRegisteredMachines={false}
      {...props}
    />,
  )
}

describe('PaneGroupEmptyState', () => {
  it('keeps daemon waiting copy only before any machine is connected', () => {
    const html = renderEmptyState()

    expect(html).toContain('Waiting for your daemon')
    expect(html).toContain('Start the ADHDev daemon to connect this dashboard.')
    expect(html).not.toContain(DASHBOARD_NEW_SESSION_LABEL)
  })

  // Until the first snapshot lands, "zero conversations" and "no data yet" are
  // the same observation. Asserting either terminal copy in that window is what
  // made a returning user see the install CTA before their machines loaded.
  it('shows loading copy instead of any empty-state claim while the first snapshot is in flight', () => {
    const html = renderEmptyState({ isLoading: true })

    expect(html).toContain('Loading sessions')
    expect(html).not.toContain('Waiting for your daemon')
    expect(html).not.toContain('No conversations yet')
  })

  it('does not claim the account has no machines while still loading', () => {
    const html = renderEmptyState({ isStandalone: false, hasRegisteredMachines: false, isLoading: true })

    expect(html).toContain('Loading sessions')
    expect(html).not.toContain('Connect your machines')
    // The install command is the most damaging thing to show a user who already
    // has machines, so guard it explicitly.
    expect(html).not.toContain('npm install')
  })

  it('keeps the suppressed watermark blank even while loading', () => {
    const html = renderEmptyState({ isLoading: true, suppressGuide: true })

    expect(html).not.toContain('Loading sessions')
  })

  it('switches to a no-conversations CTA when a machine is already connected', () => {
    const html = renderEmptyState({
      hasRegisteredMachines: true,
      onOpenNewSession: () => {},
    })

    expect(html).toContain('No conversations yet')
    expect(html).toContain(DASHBOARD_NEW_SESSION_DESCRIPTION)
    expect(html).toContain(DASHBOARD_NEW_SESSION_LABEL)
    expect(html).not.toContain('Waiting for your daemon')
  })
})
