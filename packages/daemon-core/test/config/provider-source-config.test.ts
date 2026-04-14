import { describe, expect, it } from 'vitest'
import { parseProviderSourceConfigUpdate } from '../../src/config/provider-source-config.js'

describe('parseProviderSourceConfigUpdate', () => {
  it('accepts explicit source mode and trims providerDir', () => {
    expect(parseProviderSourceConfigUpdate({
      providerSourceMode: 'no-upstream',
      providerDir: '  /tmp/providers  ',
    })).toEqual({
      ok: true,
      updates: {
        providerSourceMode: 'no-upstream',
        providerDir: '/tmp/providers',
      },
    })
  })

  it('treats empty providerDir as clearing the explicit override root', () => {
    expect(parseProviderSourceConfigUpdate({
      providerDir: '   ',
    })).toEqual({
      ok: true,
      updates: {
        providerDir: undefined,
      },
    })
  })

  it('rejects invalid source modes', () => {
    expect(parseProviderSourceConfigUpdate({
      providerSourceMode: 'builtin-only',
    })).toEqual({
      ok: false,
      error: "providerSourceMode must be 'normal' or 'no-upstream'",
    })
  })
})
