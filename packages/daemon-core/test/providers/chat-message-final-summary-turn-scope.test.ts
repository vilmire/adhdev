import { describe, expect, it } from 'vitest'
import {
  extractFinalSummaryFromMessages,
  extractFinalSummaryFromMessagesAfter,
} from '../../src/providers/chat-message-normalization.js'

// NOTIF Defect-B: the completion event's finalSummary must describe the turn that
// completed, not the prior task's last bubble. extractFinalSummaryFromMessagesAfter
// turn-scopes the native-transcript read so a debounce that flushes before this turn's
// final assistant bubble lands never echoes the previous task's tail.
describe('extractFinalSummaryFromMessagesAfter (turn-scope)', () => {
  // Realistic epoch-ms instants (Date.now()-scale). Small synthetic numbers would trip
  // the reader's seconds-vs-ms heuristic (value > 10_000_000_000 ? value : value*1000).
  const TURN_A = 1_700_000_000_000
  const TURN_B = 1_700_000_100_000 // +100s

  it('returns the in-turn assistant bubble and skips the prior task bubble', () => {
    const messages = [
      { role: 'user', content: 'task A', timestamp: TURN_A },
      { role: 'assistant', content: 'A is done.', timestamp: TURN_A + 500 },
      { role: 'user', content: 'task B', timestamp: TURN_B },
      { role: 'assistant', content: 'B is done.', timestamp: TURN_B + 500 },
    ]
    expect(extractFinalSummaryFromMessagesAfter(messages, TURN_B)).toBe('B is done.')
  })

  it('returns empty (never the prior task bubble) when this turn has no assistant bubble yet', () => {
    // The B turn started (TURN_B) but its assistant bubble has NOT been written to the
    // transcript yet — only A's prior bubble exists. Must NOT echo A.
    const messages = [
      { role: 'user', content: 'task A', timestamp: TURN_A },
      { role: 'assistant', content: 'A is done.', timestamp: TURN_A + 500 },
      { role: 'user', content: 'task B', timestamp: TURN_B },
    ]
    expect(extractFinalSummaryFromMessagesAfter(messages, TURN_B)).toBe('')
  })

  it('treats a bubble exactly at the turn-start boundary as in-turn (inclusive)', () => {
    const messages = [
      { role: 'assistant', content: 'prior', timestamp: TURN_B - 1 },
      { role: 'assistant', content: 'boundary', timestamp: TURN_B },
    ]
    expect(extractFinalSummaryFromMessagesAfter(messages, TURN_B)).toBe('boundary')
  })

  it('keeps bubbles with no parseable timestamp (cannot be proven stale)', () => {
    const messages = [
      { role: 'assistant', content: 'no timestamp reply' },
    ]
    expect(extractFinalSummaryFromMessagesAfter(messages, TURN_B)).toBe('no timestamp reply')
  })

  it('with no boundary behaves identically to the unscoped extractor', () => {
    const messages = [
      { role: 'user', content: 'task A', timestamp: TURN_A },
      { role: 'assistant', content: 'A is done.', timestamp: TURN_A + 500 },
    ]
    expect(extractFinalSummaryFromMessagesAfter(messages, undefined)).toBe(
      extractFinalSummaryFromMessages(messages),
    )
    expect(extractFinalSummaryFromMessagesAfter(messages, undefined)).toBe('A is done.')
  })

  it('parses ISO string timestamps for the boundary comparison', () => {
    const messages = [
      { role: 'assistant', content: 'prior', timestamp: '2026-06-28T00:00:00.000Z' },
      { role: 'assistant', content: 'current', timestamp: '2026-06-28T01:00:00.000Z' },
    ]
    const boundary = new Date('2026-06-28T00:30:00.000Z').getTime()
    expect(extractFinalSummaryFromMessagesAfter(messages, boundary)).toBe('current')
  })
})
