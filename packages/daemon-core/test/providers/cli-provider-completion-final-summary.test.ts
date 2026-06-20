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
      completionFinalSummary(messages: unknown): string | undefined
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
})
