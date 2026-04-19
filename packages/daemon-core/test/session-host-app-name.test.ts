import { describe, expect, it } from 'vitest'
import { resolveSessionHostAppName, resolveSessionHostAppNameResolution } from '../src/session-host/app-name'

describe('session host app-name resolution', () => {
  it('keeps cloud/default mode on adhdev but isolates standalone by default', () => {
    expect(resolveSessionHostAppName({ env: {} })).toBe('adhdev')
    expect(resolveSessionHostAppName({ standalone: true, env: {} })).toBe('adhdev-standalone')
  })

  it('lets explicit custom ADHDEV_SESSION_HOST_NAME override both modes', () => {
    const env = { ADHDEV_SESSION_HOST_NAME: 'custom-host' }
    expect(resolveSessionHostAppName({ env })).toBe('custom-host')
    expect(resolveSessionHostAppName({ standalone: true, env })).toBe('custom-host')
  })

  it('falls back away from the reserved adhdev namespace in standalone mode and exposes a warning', () => {
    expect(resolveSessionHostAppName({
      standalone: true,
      env: { ADHDEV_SESSION_HOST_NAME: 'adhdev' },
    })).toBe('adhdev-standalone')

    expect(resolveSessionHostAppNameResolution({
      standalone: true,
      env: { ADHDEV_SESSION_HOST_NAME: 'adhdev' },
    })).toMatchObject({
      appName: 'adhdev-standalone',
      warning: expect.stringMatching(/reserved for the global daemon/i),
    })
  })
})
