import { describe, expect, it } from 'vitest'
import { extractProviderSourceConfigPayload, normalizeProviderDirInput } from '../../src/pages/machine/providerSourceConfig.js'

describe('providerSourceConfig helpers', () => {
  it('extracts provider source config payloads from daemon command responses', () => {
    expect(extractProviderSourceConfigPayload({
      result: {
        sourceMode: 'normal',
        disableUpstream: false,
        explicitProviderDir: null,
        userDir: '/Users/test/.adhdev/providers',
        upstreamDir: '/Users/test/.adhdev/providers/.upstream',
        providerRoots: ['/Users/test/.adhdev/providers', '/Users/test/.adhdev/providers/.upstream'],
      },
    })).toEqual({
      sourceMode: 'normal',
      disableUpstream: false,
      explicitProviderDir: null,
      userDir: '/Users/test/.adhdev/providers',
      upstreamDir: '/Users/test/.adhdev/providers/.upstream',
      providerRoots: ['/Users/test/.adhdev/providers', '/Users/test/.adhdev/providers/.upstream'],
    })

    expect(extractProviderSourceConfigPayload({
      sourceMode: 'no-upstream',
      disableUpstream: true,
      explicitProviderDir: '/tmp/providers',
      userDir: '/tmp/providers',
      upstreamDir: '/Users/test/.adhdev/providers/.upstream',
      providerRoots: ['/tmp/providers', '/Users/test/.adhdev/providers/.upstream'],
    })).toEqual({
      sourceMode: 'no-upstream',
      disableUpstream: true,
      explicitProviderDir: '/tmp/providers',
      userDir: '/tmp/providers',
      upstreamDir: '/Users/test/.adhdev/providers/.upstream',
      providerRoots: ['/tmp/providers', '/Users/test/.adhdev/providers/.upstream'],
    })
  })

  it('normalizes blank providerDir input to null and trims explicit paths', () => {
    expect(normalizeProviderDirInput('   ')).toBeNull()
    expect(normalizeProviderDirInput('  /tmp/providers  ')).toBe('/tmp/providers')
  })
})
