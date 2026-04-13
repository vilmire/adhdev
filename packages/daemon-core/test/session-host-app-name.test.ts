import { describe, expect, it } from 'vitest'
import { resolveSessionHostAppName } from '../src/session-host/app-name'

describe('session host app-name resolution', () => {
  it('keeps cloud/default mode on adhdev but isolates standalone by default', () => {
    expect(resolveSessionHostAppName({ env: {} })).toBe('adhdev')
    expect(resolveSessionHostAppName({ standalone: true, env: {} })).toBe('adhdev-standalone')
  })

  it('lets explicit ADHDEV_SESSION_HOST_NAME override both modes', () => {
    const env = { ADHDEV_SESSION_HOST_NAME: 'custom-host' }
    expect(resolveSessionHostAppName({ env })).toBe('custom-host')
    expect(resolveSessionHostAppName({ standalone: true, env })).toBe('custom-host')
  })
})
