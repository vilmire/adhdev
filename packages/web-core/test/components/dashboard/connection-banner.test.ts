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
  it('renders a manual reconnect action while reconnecting', () => {
    const html = renderBanner({
      wsStatus: 'reconnecting',
      onReconnect: () => {},
    })

    expect(html).toContain('Reconnecting to server...')
    expect(html).toContain('Reconnect now')
  })
})
