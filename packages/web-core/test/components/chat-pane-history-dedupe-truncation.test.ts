import { describe, expect, it } from 'vitest'
import { choosePreferredMessage, excludeMessagesPresentInLiveFeed } from '../../src/components/dashboard/message-utils'

describe('message-utils history/live dedupe', () => {
  it('keeps a fuller history message when live feed only has a truncated prefix', () => {
    const history = [
      { role: 'assistant', content: `Intro\n${'x'.repeat(5200)}\nTAIL_MARKER_VISIBLE` },
    ]
    const live = [
      { role: 'assistant', content: `Intro\n${'x'.repeat(5000)}` },
    ]

    const result = excludeMessagesPresentInLiveFeed(history, live)
    expect(result).toHaveLength(1)
    expect(String(result[0]?.content || '')).toContain('TAIL_MARKER_VISIBLE')
  })

  it('prefers the fuller message when two likely-duplicate assistant messages differ only by truncation', () => {
    const full = { role: 'assistant', content: `Intro\n${'x'.repeat(5200)}\nTAIL_MARKER_VISIBLE` }
    const truncated = { role: 'assistant', id: 'msg_1', content: `Intro\n${'x'.repeat(5000)}` }

    const preferred = choosePreferredMessage(full, truncated)
    expect(String(preferred.content || '')).toContain('TAIL_MARKER_VISIBLE')
  })
})
