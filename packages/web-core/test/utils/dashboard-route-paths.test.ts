import { describe, expect, it } from 'vitest'
import { getDashboardActiveTabHref } from '../../src/utils/dashboard-route-paths'

describe('dashboard route paths', () => {
  it('builds a dashboard activeTab href instead of pointing at the landing page root', () => {
    expect(getDashboardActiveTabHref('fcf8c522-e914-44fd-bad1-51aadf403a01')).toBe(
      '/dashboard?activeTab=fcf8c522-e914-44fd-bad1-51aadf403a01',
    )
  })

  it('encodes activeTab values safely for URLs', () => {
    expect(getDashboardActiveTabHref('session with spaces/and?symbols')).toBe(
      '/dashboard?activeTab=session%20with%20spaces%2Fand%3Fsymbols',
    )
  })
})