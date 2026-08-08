// LIVE RENDER proof for the loading-vs-empty gate on the notifications page.
//
// Same defect class as Machines.tsx: `machines` is derived from a daemon list
// that starts as an empty array, so `onlineMachines.length === 0` was
// indistinguishable from "the first state has not arrived yet". /notifications
// routes straight under <Layout> with no bootstrap gate above it, so an account
// with connected machines was told "no online machines" until initial_state
// landed.
//
// The page is a SHARED component, so the flag is an optional prop defaulting to
// true — a host that renders only after its data is ready keeps its behavior,
// and only a host with a real pre-load window threads its own flag.
//
// Uses renderToStaticMarkup, so it needs no DOM and runs in the default node
// environment (jsdom is declared in package.json but not installed here).
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'

// i18n: return the key so assertions are locale-independent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../src/hooks/useNotificationPrefs', () => ({
  useNotificationPrefs: () => [
    { master: true, browser: false },
    () => {},
  ],
}))
vi.mock('../../src/hooks/useBrowserNotifications', () => ({
  requestNotificationPermission: async () => 'granted',
}))
vi.mock('../../src/context/TransportContext', () => ({
  useTransport: () => ({ sendCommand: async () => ({}) }),
}))

const ONLINE_MACHINE = {
  id: 'daemon_mach_1',
  machineId: 'mach_1',
  hostname: 'test-host',
  status: 'online',
  providers: [],
} as any

async function render(props: { machines: any[]; initialLoaded?: boolean }): Promise<string> {
  const { default: NotificationsPage } = await import('../../src/pages/Notifications')
  return renderToStaticMarkup(
    React.createElement(NotificationsPage as any, props),
  )
}

describe('notifications page render — loading vs empty', () => {
  it('while loading: does NOT claim "no online machines"', async () => {
    const html = await render({ machines: [], initialLoaded: false })
    expect(html).not.toContain('notifications.noOnlineMachines')
    expect(html).toContain('notifications.loading')
  })

  it('once loaded and genuinely empty: shows "no online machines"', async () => {
    const html = await render({ machines: [], initialLoaded: true })
    expect(html).toContain('notifications.noOnlineMachines')
  })

  it('defaults to loaded so existing hosts are unaffected by the new prop', async () => {
    // No initialLoaded passed at all — must behave exactly as before the prop
    // existed, or adding it silently changes every other caller.
    const html = await render({ machines: [] })
    expect(html).toContain('notifications.noOnlineMachines')
  })

  it('with machines present, renders neither the placeholder nor the empty state', async () => {
    const html = await render({ machines: [ONLINE_MACHINE], initialLoaded: true })
    expect(html).not.toContain('notifications.noOnlineMachines')
    expect(html).not.toContain('notifications.loading')
  })
})
