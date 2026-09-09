// @vitest-environment jsdom
//
// (O8) connDebugLog must be silent by default and emit only under the opt-in
// flag — it is the gate that keeps ~67 transport/push diagnostics (including
// the public share viewer's WS metadata dump, G10-3) out of the production
// console. Same flag shape as isSpecDebugEnabled / isMobileDebugBundleEnabled.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connDebugLog, isConnDebugEnabled } from '../../src/utils/debug-flags'

describe('connDebugLog (O8 console.log gate)', () => {
  afterEach(() => {
    delete window.__ADHDEV_DEBUG_CONN__
    vi.restoreAllMocks()
  })

  it('is OFF by default and emits nothing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(isConnDebugEnabled()).toBe(false)
    connDebugLog('[P2P] should not appear')
    expect(spy).not.toHaveBeenCalled()
  })

  it('emits when the devtools global flag is set', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    window.__ADHDEV_DEBUG_CONN__ = true
    expect(isConnDebugEnabled()).toBe(true)
    connDebugLog('[P2P] visible now', 42)
    expect(spy).toHaveBeenCalledWith('[P2P] visible now', 42)
  })
})
