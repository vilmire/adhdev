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
      reconnectDelayMs: 0,
    })

    expect(html).toContain('Reconnecting to server...')
    expect(html).toContain('Reconnect now')
    expect(html).toContain('fixed left-1/2 top-4 z-[1400]')
    expect(html).toContain('translateX(-50%)')
  })

  it('does not render transient reconnecting status before the grace period elapses', () => {
    const html = renderBanner({
      wsStatus: 'reconnecting',
      onReconnect: () => {},
    })

    expect(html).not.toContain('Reconnecting to server...')
    expect(html).not.toContain('Reconnect now')
  })

  it('does not tell users to restart the server on generic auth failure', () => {
    const html = renderBanner({ wsStatus: 'auth_failed' })

    expect(html).toContain('Connection failed — refresh the page or try again shortly.')
    expect(html).not.toContain('restart the server')
  })

  it('renders a login link for cloud auth failures when provided', () => {
    const html = renderBanner({ wsStatus: 'auth_failed', loginUrl: '/login' })

    expect(html).toContain('Session expired.')
    expect(html).toContain('href="/login"')
    expect(html).not.toContain('refresh the page')
  })

  it('renders the connected confirmation as the same fixed overlay family', () => {
    const html = renderBanner({
      wsStatus: 'connected',
      showReconnected: true,
      reconnectDelayMs: 0,
    })

    expect(html).toContain('Connected')
    expect(html).toContain('fixed left-1/2 top-4 z-[1400]')
  })
})
