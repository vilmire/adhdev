import { describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

// MULTI-TURN TRANSCRIPT FLICKER (kimi): a pure-PTY provider that reconstructs
// its whole transcript from the rendered buffer (tui transcriptPty scope
// 'buffer', no native history, no provider authority) must be fed the FULL
// accumulated buffer, not the current-turn slice. Otherwise the instant a new
// turn starts (currentTurnScope.bufferStart jumps forward) the slice drops
// every prior turn and read_chat momentarily returns zero messages until the
// new turn emits output — the observed empty→restore flicker.

function makeAdapter(provider: Record<string, any>) {
  const adapter = new ProviderCliAdapter({
    category: 'cli',
    spawn: { command: provider.binary || 'x', args: [], shell: true, env: {} },
    scripts: {
      detectStatus: () => 'generating',
      parseApproval: () => null,
    },
    ...provider,
  } as any, '/tmp/project') as any
  adapter.terminalScreen = { write: vi.fn(), getText: () => '' }
  adapter.scheduleSettle = vi.fn()
  adapter.resolveStartupState = vi.fn()
  return adapter
}

const KIMI_LIKE = {
  type: 'kimi',
  name: 'Kimi',
  binary: 'kimi',
  tui: { transcriptPty: { scope: 'buffer' } },
}

const NATIVE_LIKE = {
  type: 'claude-cli',
  name: 'Claude',
  binary: 'claude',
  nativeHistory: { mode: 'native-source' },
  tui: { transcriptPty: { scope: 'buffer' } },
}

const PROVIDER_OWNED = {
  type: 'owned',
  name: 'Owned',
  binary: 'owned',
  transcriptAuthority: 'provider',
  tui: { transcriptPty: { scope: 'buffer' } },
}

function primeTwoTurns(adapter: any) {
  // Turn 1 output already in the buffer.
  adapter.handleOutput('TURN1_OUTPUT')
  // A new (second) turn starts: scope offset jumps to the end of turn 1.
  const turn2Start = adapter.accumulatedBuffer.length
  adapter.currentTurnScope = {
    prompt: 'second prompt',
    startedAt: Date.now(),
    bufferStart: turn2Start,
    rawBufferStart: adapter.accumulatedRawBuffer.length,
  }
  adapter.isWaitingForResponse = true
  return turn2Start
}

describe('ProviderCliAdapter full-PTY transcript scope (kimi multi-turn flicker)', () => {
  it('classifies kimi-like pure-PTY buffer providers as full-transcript', () => {
    const adapter = makeAdapter(KIMI_LIKE)
    expect(adapter.parsesFullPtyTranscriptFromBuffer()).toBe(true)
  })

  it('does NOT classify native-history providers as full-PTY', () => {
    const adapter = makeAdapter(NATIVE_LIKE)
    expect(adapter.parsesFullPtyTranscriptFromBuffer()).toBe(false)
  })

  it('does NOT classify provider-owned-transcript providers as full-PTY', () => {
    const adapter = makeAdapter(PROVIDER_OWNED)
    expect(adapter.parsesFullPtyTranscriptFromBuffer()).toBe(false)
  })

  it('does NOT classify a non-buffer tui scope as full-PTY', () => {
    const adapter = makeAdapter({ ...KIMI_LIKE, tui: { transcriptPty: { scope: 'tail' } } })
    expect(adapter.parsesFullPtyTranscriptFromBuffer()).toBe(false)
  })

  it('feeds the FULL buffer (scope null) to kimi-like parse on a later turn — prior turn survives', () => {
    const adapter = makeAdapter(KIMI_LIKE)
    // Capture the buffer the parser actually receives.
    let seenBuffer = ''
    adapter.runner = {
      parseSession: (input: any) => {
        seenBuffer = String(input.buffer ?? '')
        return { status: 'generating', messages: [] }
      },
    }
    primeTwoTurns(adapter)
    adapter.runParseSession()
    // Turn 1's output is still present — not sliced away by the turn-2 scope.
    expect(seenBuffer).toContain('TURN1_OUTPUT')
    expect(adapter.transcriptParseScope()).toBeNull()
  })

  it('keeps the current-turn slice for a native-history provider on a later turn', () => {
    const adapter = makeAdapter(NATIVE_LIKE)
    let seenBuffer = ''
    adapter.runner = {
      parseSession: (input: any) => {
        seenBuffer = String(input.buffer ?? '')
        return { status: 'generating', messages: [] }
      },
    }
    primeTwoTurns(adapter)
    adapter.runParseSession()
    // Turn-scoped: the slice starts at turn 2, so turn 1 output is excluded.
    expect(seenBuffer).not.toContain('TURN1_OUTPUT')
    expect(adapter.transcriptParseScope()).toBe(adapter.currentTurnScope)
  })
})
