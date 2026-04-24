import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ConnectionBanner from '../../../src/components/dashboard/ConnectionBanner'

function renderBanner(props: Partial<React.ComponentProps<typeof ConnectionBanner>> = {}) {
  return renderToStaticMarkup(
    React.createElement(ConnectionBanner, {
      wsStatus: 'connected',
      showReconnected: false,
      ...props,
    }),
  )
}

describe('ConnectionBanner', () => {
  it('renders reconnecting status as a fixed top overlay instead of an inline page banner', () => {
    const html = renderBanner({
      wsStatus: 'reconnecting',
      onReconnect: () => {},
    })

    expect(html).toContain('Reconnecting to server...')
    expect(html).toContain('Reconnect now')
    expect(html).toContain('fixed left-1/2 top-4 z-[1400]')
    expect(html).toContain('translateX(-50%)')
  })

  it('renders the connected confirmation as the same fixed overlay family', () => {
    const html = renderBanner({
      wsStatus: 'connected',
      showReconnected: true,
    })

    expect(html).toContain('Connected')
    expect(html).toContain('fixed left-1/2 top-4 z-[1400]')
  })
})
