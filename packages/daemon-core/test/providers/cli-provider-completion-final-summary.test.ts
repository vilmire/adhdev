import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// completionFinalSummary backs the `parsed_status:` finalSummary the coordinator
// rides onto a delegated session's inbox preview. Previously the timeout-forced
// finalization unconditionally rode an empty string for a `parsed_status:` block,
// blanking the preview (or, for a LOCAL worktree session, leaving it stuck on the
// dispatched user task). It must instead surface the parsed assistant reply when one
// exists, and only fall back to undefined when there is genuinely no assistant text.
describe('CliProviderInstance.completionFinalSummary', () => {
  function makeInstance() {
    return Object.create(CliProviderInstance.prototype) as CliProviderInstance & {
      adapter: any
      readExternalCompletionMessages(): unknown[] | null
      completionFinalSummary(messages: unknown, turnStartedAt?: number): string | undefined
    }
  }

  it('returns the parsed assistant reply as the final summary', () => {
    const instance = makeInstance()
    // Non-native adapter: chatMessagesOwnedExternally is undefined → screen-parsed path.
    instance.adapter = {}
    const summary = instance.completionFinalSummary([
      { role: 'user', content: 'dispatched task: fix the inbox preview' },
      { role: 'assistant', content: 'Done — the inbox now shows the assistant reply.' },
    ])
    expect(summary).toBe('Done — the inbox now shows the assistant reply.')
  })

  it('returns undefined when the last visible message is not an assistant reply', () => {
    const instance = makeInstance()
    instance.adapter = {}
    const summary = instance.completionFinalSummary([
      { role: 'user', content: 'just a dispatched task with no reply yet' },
    ])
    expect(summary).toBeUndefined()
  })

  // NOTIF Defect-B: native-source providers (claude-cli: chatMessagesOwnedExternally)
  // read the WHOLE session transcript filtered only by session start. A completion debounce
  // that flushes before THIS turn's final assistant bubble lands must turn-scope the read so
  // it never echoes the PRIOR task's last bubble.
  // Realistic epoch-ms instants (Date.now()-scale); small synthetic numbers would trip the
  // reader's seconds-vs-ms heuristic and not compare against the turnStartedAt boundary.
  const TURN_A = 1_700_000_000_000
  const TURN_B = 1_700_000_100_000 // +100s

  it('turn-scopes the native transcript so a completion never echoes the prior task bubble', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    ;(instance as any).readExternalCompletionMessages = () => ([
      { role: 'user', content: 'task A', timestamp: TURN_A },
      { role: 'assistant', content: 'A is done.', timestamp: TURN_A + 500 },
      { role: 'user', content: 'task B', timestamp: TURN_B },
      { role: 'assistant', content: 'B is done.', timestamp: TURN_B + 500 },
    ])
    // Pass turnStartedAt = B's start; only B's bubble is in scope.
    expect(instance.completionFinalSummary([], TURN_B)).toBe('B is done.')
  })

  it('does NOT return the prior task bubble when this turn has no bubble in the transcript yet', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    // The transcript still holds only A's bubble (B's has not been written yet).
    ;(instance as any).readExternalCompletionMessages = () => ([
      { role: 'user', content: 'task A', timestamp: TURN_A },
      { role: 'assistant', content: 'A is done.', timestamp: TURN_A + 500 },
      { role: 'user', content: 'task B', timestamp: TURN_B },
    ])
    // External read yields '' for turn B → fall back to the LIVE screen parse (empty here),
    // never the stale A tail.
    expect(instance.completionFinalSummary([], TURN_B)).toBeUndefined()
  })

  it('falls back to the live screen parse (this turn) when the transcript has no in-turn bubble', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    ;(instance as any).readExternalCompletionMessages = () => ([
      { role: 'assistant', content: 'A is done.', timestamp: TURN_A + 500 },
    ])
    // Screen parse reflects the live (B) turn — that, not the stale A transcript tail, is used.
    const summary = instance.completionFinalSummary(
      [{ role: 'assistant', content: 'B reply from live screen' }],
      TURN_B,
    )
    expect(summary).toBe('B reply from live screen')
  })
})
