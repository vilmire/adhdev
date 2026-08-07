import { afterEach, describe, expect, it, vi } from 'vitest'
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

/**
 * Regression: the default namespace must follow the BUILD TRACK.
 *
 * It was hardcoded to 'adhdev', so a preview daemon started WITHOUT
 * ADHDEV_SESSION_HOST_NAME (manual run, dev run, or an upgrade helper that lost
 * the env) silently adopted the STABLE install's session host. The service
 * installer exporting that env var was the only thing preventing a collision.
 *
 * IDENTITY is snapshotted at module load, so the preview track is exercised in
 * an isolated module registry with the build-channel env set beforehand.
 */
describe('session host app-name is track-scoped', () => {
  const ORIGINAL_CHANNEL = process.env.ADHDEV_BUILD_CHANNEL

  afterEach(() => {
    if (ORIGINAL_CHANNEL === undefined) delete process.env.ADHDEV_BUILD_CHANNEL
    else process.env.ADHDEV_BUILD_CHANNEL = ORIGINAL_CHANNEL
    vi.resetModules()
  })

  async function loadForTrack(channel: 'stable' | 'preview') {
    if (channel === 'preview') process.env.ADHDEV_BUILD_CHANNEL = 'preview'
    else delete process.env.ADHDEV_BUILD_CHANNEL
    vi.resetModules()
    return import('../src/session-host/app-name.js')
  }

  it('defaults a preview build to its own namespace, never the stable one', async () => {
    const mod = await loadForTrack('preview')
    // The bug: this returned 'adhdev' and collided with the stable install.
    expect(mod.resolveSessionHostAppName({ env: {} })).toBe('adhdev-preview')
    expect(mod.DEFAULT_SESSION_HOST_APP_NAME).toBe('adhdev-preview')
  })

  it('leaves the stable build byte-identical to before', async () => {
    const mod = await loadForTrack('stable')
    expect(mod.resolveSessionHostAppName({ env: {} })).toBe('adhdev')
    expect(mod.DEFAULT_SESSION_HOST_APP_NAME).toBe('adhdev')
  })

  it('reserves the preview global namespace against standalone on the preview track', async () => {
    const mod = await loadForTrack('preview')
    expect(mod.resolveSessionHostAppName({
      standalone: true,
      env: { ADHDEV_SESSION_HOST_NAME: 'adhdev-preview' },
    })).toBe('adhdev-standalone')
  })
})
