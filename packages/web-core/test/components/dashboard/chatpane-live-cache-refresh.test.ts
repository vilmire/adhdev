import { describe, expect, it } from 'vitest'
import { mergeLiveChatMessages } from '../../../src/components/dashboard/message-utils'

describe('mergeLiveChatMessages', () => {
  it('allows a fuller active conversation message to replace a stale truncated cached live message', () => {
    const cached = [
      { role: 'assistant', id: 'msg_1', content: `Intro\n${'x'.repeat(5000)}` },
    ]
    const active = [
      { role: 'assistant', id: 'msg_1', content: `Intro\n${'x'.repeat(5200)}\nTAIL_MARKER_VISIBLE` },
    ]

    const merged = mergeLiveChatMessages(cached, active)
    expect(merged).toHaveLength(1)
    expect(String(merged[0]?.content || '')).toContain('TAIL_MARKER_VISIBLE')
  })
})
