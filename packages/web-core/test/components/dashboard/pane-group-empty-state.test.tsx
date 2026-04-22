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
