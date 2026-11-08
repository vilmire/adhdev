import { describe, expect, it } from 'vitest'
import { quotaPoolForModel, quotaPoolsOf } from '../../src/quota/quota-pools'
import { sessionQuotaPool } from '../../src/providers/completion/completion-flush'

describe('quota pools', () => {
  it('maps antigravity models and bucket names to their pool; other providers are unpooled', () => {
    expect(quotaPoolsOf('antigravity-cli')).toEqual(['gemini', 'claude-gpt'])
    expect(quotaPoolForModel('antigravity-cli', 'claude-opus-5-5-high')).toBe('claude-gpt')
    expect(quotaPoolForModel('antigravity-cli', 'Claude Sonnet 5.5 (High)')).toBe('claude-gpt')
    expect(quotaPoolForModel('antigravity-cli', 'GPT-6')).toBe('claude-gpt')
    expect(quotaPoolForModel('antigravity-cli', 'Gemini 4 Argon (High)')).toBe('gemini')
    expect(quotaPoolForModel('antigravity-cli', 'something-else')).toBeUndefined()
    expect(quotaPoolsOf('claude-cli')).toEqual([])
    expect(quotaPoolForModel('claude-cli', 'claude-opus-5-5')).toBeUndefined()
  })
  it('reads the running model pool from control values first, then launch settings', () => {
    expect(sessionQuotaPool({ type: 'antigravity-cli', settings: { initialModel: 'Gemini 4 Argon (High)' }, controlValues: { model: 'claude-opus-5-5-high' } })).toBe('claude-gpt')
    expect(sessionQuotaPool({ type: 'antigravity-cli', settings: { initialModel: 'Gemini 4 Argon (High)' } })).toBe('gemini')
    expect(sessionQuotaPool({ type: 'antigravity-cli', settings: {} })).toBeUndefined()
  })
})
