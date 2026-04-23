import { describe, expect, it } from 'vitest'

import { normalizeProviderSessionId } from '../../src/providers/provider-session-id.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

const hermes = { sessionIdPattern: '^\\d{8}_\\d{6}_[a-z0-9]+$' } as Partial<ProviderModule> as ProviderModule
const claude = { sessionIdPattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' } as Partial<ProviderModule> as ProviderModule

describe('normalizeProviderSessionId', () => {
  it('accepts stable hermes session ids', () => {
    expect(normalizeProviderSessionId(hermes, ' 20260416_212202_9c583d ')).toBe('20260416_212202_9c583d')
  })

  it('accepts claude uuid session ids and rejects polluted ones', () => {
    expect(normalizeProviderSessionId(claude, ' 323493c3-45ba-4d25-9ab3-3fa45ca87c17 ')).toBe('323493c3-45ba-4d25-9ab3-3fa45ca87c17')
    expect(normalizeProviderSessionId(claude, '../escape')).toBe('')
    expect(normalizeProviderSessionId(claude, 'not-a-uuid')).toBe('')
  })

  it('rejects polluted hermes session ids captured from unrelated terminal text', () => {
    expect(normalizeProviderSessionId(hermes, 'vi')).toBe('')
    expect(normalizeProviderSessionId(hermes, 'undefined')).toBe('')
    expect(normalizeProviderSessionId(hermes, 'session')).toBe('')
  })

  it('still allows providers without sessionIdPattern to use stable custom ids', () => {
    expect(normalizeProviderSessionId(undefined, 'turns:019d85be|019d85c2')).toBe('turns:019d85be|019d85c2')
  })
})
