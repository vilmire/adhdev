import { describe, expect, it } from 'vitest'

import { normalizeProviderSessionId } from '../../src/providers/provider-session-id.js'

describe('normalizeProviderSessionId', () => {
  it('accepts stable hermes session ids', () => {
    expect(normalizeProviderSessionId('hermes-cli', ' 20260416_212202_9c583d ')).toBe('20260416_212202_9c583d')
  })

  it('accepts claude uuid session ids and rejects polluted ones', () => {
    expect(normalizeProviderSessionId('claude-cli', ' 323493c3-45ba-4d25-9ab3-3fa45ca87c17 ')).toBe('323493c3-45ba-4d25-9ab3-3fa45ca87c17')
    expect(normalizeProviderSessionId('claude-cli', '../escape')).toBe('')
    expect(normalizeProviderSessionId('claude-cli', 'not-a-uuid')).toBe('')
  })

  it('rejects polluted hermes session ids captured from unrelated terminal text', () => {
    expect(normalizeProviderSessionId('hermes-cli', 'vi')).toBe('')
    expect(normalizeProviderSessionId('hermes-cli', 'undefined')).toBe('')
    expect(normalizeProviderSessionId('hermes-cli', 'session')).toBe('')
  })

  it('still allows non-hermes providers to use stable custom ids', () => {
    expect(normalizeProviderSessionId('codex', 'turns:019d85be|019d85c2')).toBe('turns:019d85be|019d85c2')
  })
})
