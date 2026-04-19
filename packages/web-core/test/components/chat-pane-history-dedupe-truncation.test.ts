import { describe, expect, it, vi } from 'vitest'
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

  it('prunes history/live duplicate checks to likely live candidates', () => {
    const matcher = vi.fn((historyMessage: any, liveMessage: any) => historyMessage.id === liveMessage.id)
    const live = [
      ...Array.from({ length: 39 }, (_, index) => ({
        role: 'assistant',
        content: `live-message-${index}`,
        receivedAt: index + 1,
        id: `msg-${index}`,
      })),
      { role: 'assistant', content: 'live-message-0', receivedAt: 999, id: 'msg-0' },
    ]
    const history = [
      { role: 'assistant', content: 'live-message-0', receivedAt: 1000, id: 'msg-0' },
    ]

    const result = excludeMessagesPresentInLiveFeed(history, live, matcher)

    expect(result).toEqual([])
    expect(matcher).toHaveBeenCalled()
    expect(matcher.mock.calls.length).toBeLessThan(10)
  })
})
