import { describe, expect, it } from 'vitest'
import { buildSavedHistorySummaryView } from '../../src/utils/saved-history-summary'

describe('saved history summary view', () => {
  it('includes workspace, model, message count, and updated label when available', () => {
    const summary = buildSavedHistorySummaryView({
      title: 'Hermes Agent',
      providerSessionId: 'session-123',
      workspace: '/repo',
      currentModel: 'gpt-5.4',
      messageCount: 4,
      lastMessageAt: 1711111111111,
      preview: 'SECOND',
    })

    expect(summary.title).toBe('Hermes Agent')
    expect(summary.providerSessionId).toBe('session-123')
    expect(summary.metaLine).toContain('/repo')
    expect(summary.metaLine).toContain('gpt-5.4')
    expect(summary.metaLine).toContain('4 msgs')
    expect(summary.updatedLabel).toMatch(/^Updated /)
    expect(summary.preview).toBe('SECOND')
  })

  it('falls back gracefully when optional fields are missing', () => {
    const summary = buildSavedHistorySummaryView({
      providerSessionId: 'session-456',
      messageCount: 0,
    })

    expect(summary.title).toBe('session-456')
    expect(summary.metaLine).toBe('Workspace unknown')
    expect(summary.updatedLabel).toBe('')
    expect(summary.preview).toBe('')
  })
})
