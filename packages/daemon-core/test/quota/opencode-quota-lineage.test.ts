import { describe, expect, it } from 'vitest'
import { readOpencodeQuotaAccountLineage } from '../../src/quota/fetchers/opencode.js'
import { readCurrentQuotaAccountLineage } from '../../src/quota/account-lineage-readers.js'
import { canTransferQuotaReading, quotaAccountLineage } from '../../src/quota/account-lineage.js'

// opencode has no owning account; its usage comes from its local session store,
// so readings are keyed to that store. Before this, opencode stayed UNKNOWN and
// lost every reading on a daemon restart or failed check.

const reading = (lineage: unknown) => ({
  provider: 'opencode', status: 'ok', session: null, weekly: null, monthly: null, buckets: [],
  metadata: { accountLineage: lineage },
} as any)

describe('opencode quota lineage', () => {
  it('is a stable key for the same local store', () => {
    const a = readOpencodeQuotaAccountLineage({ env: { HOME: '/home/u' } })
    const b = readOpencodeQuotaAccountLineage({ env: { HOME: '/home/u' } })
    expect(quotaAccountLineage(a).kind).toBe('account')
    expect(a).toEqual(b)
    expect(readOpencodeQuotaAccountLineage({ env: { HOME: '/x', XDG_DATA_HOME: '/home/u/.local/share' } })).toEqual(a)
  })

  it('isolates a different store', () => {
    const a = readOpencodeQuotaAccountLineage({ env: { HOME: '/home/u' } })
    const other = readOpencodeQuotaAccountLineage({ env: { HOME: '/home/v' } })
    expect(other).not.toEqual(a)
    expect(canTransferQuotaReading(reading(a), reading(other))).toBe(false)
  })

  it('lets a matching reading carry over and is the reader used for restart hydration', () => {
    const env = { HOME: '/home/u' }
    const a = readOpencodeQuotaAccountLineage({ env })
    expect(canTransferQuotaReading(reading(a), reading(readOpencodeQuotaAccountLineage({ env })))).toBe(true)
    expect(readCurrentQuotaAccountLineage('opencode', env)).toEqual(a)
  })
})
