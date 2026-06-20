import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// [I] Force-inject modal guard. The mesh reconcile loop force-injects terminal
// events (completion/approval) into a coordinator parked in `generating` so it is
// not deadlocked awaiting that very event. A force-inject writes raw keystrokes
// into the PTY, bypassing the busy send-guard. If the coordinator is instead parked
// on a HARNESS MODAL (claude-cli AskUserQuestion → waiting_choice, or a tool-consent
// prompt → waiting_approval), those keystrokes are eaten by the modal key handler
// and silently resolve a choice the user never made (data corruption). The
// force-forward chokepoint (onEvent send_message with force:true) must hold the
// inject in that narrow window — generating is still injected (the deadlock break).

type StubInstance = CliProviderInstance & {
  type: string
  provider: any
  adapter: any
  activeInteractivePrompt: any
  settings: Record<string, any>
}

function makeStubInstance(opts: {
  activeInteractivePrompt?: any
  adapterStatus?: string
  autoApprove?: boolean
}): { instance: StubInstance; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn(async () => {})
  const instance = Object.create(CliProviderInstance.prototype) as StubInstance
  instance.type = 'claude-cli'
  // A minimal provider that supports plain text input so buildCliStructuredInputPrompt
  // yields a prompt and assertProviderSupportsDeclaredInput passes.
  instance.provider = {
    name: 'Claude Code',
    messageInput: { text: true },
  }
  instance.adapter = {
    sendMessage,
    getStatus: () => ({ status: opts.adapterStatus ?? 'generating' }),
  }
  instance.activeInteractivePrompt = opts.activeInteractivePrompt ?? null
  instance.settings = { autoApprove: opts.autoApprove === true }
  return { instance, sendMessage }
}

describe('CliProviderInstance force-inject modal guard', () => {
  it('HOLDS a force send_message while parked on an AskUserQuestion prompt (waiting_choice)', () => {
    const { instance, sendMessage } = makeStubInstance({
      activeInteractivePrompt: { promptId: 'ask-1', questions: [{ question: 'pick', options: [] }] },
    })
    instance.onEvent('send_message', {
      input: { text: 'Node done — completion event', textFallback: 'Node done — completion event' },
      force: true,
    })
    // The PTY write is held — the modal would otherwise consume these keystrokes.
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('HOLDS a force send_message while parked on a tool-consent modal (waiting_approval, no auto-approve)', () => {
    const { instance, sendMessage } = makeStubInstance({ adapterStatus: 'waiting_approval', autoApprove: false })
    instance.onEvent('send_message', {
      input: { text: 'completion', textFallback: 'completion' },
      force: true,
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('still FORCE-INJECTS into a plain generating coordinator (the deadlock-break path is untouched)', () => {
    const { instance, sendMessage } = makeStubInstance({ adapterStatus: 'generating' })
    instance.onEvent('send_message', {
      input: { text: 'completion', textFallback: 'completion' },
      force: true,
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toEqual({ force: true })
  })

  it('does NOT guard a non-force send_message — normal queued send proceeds even with an active prompt', () => {
    const { instance, sendMessage } = makeStubInstance({
      activeInteractivePrompt: { promptId: 'ask-2', questions: [{ question: 'pick', options: [] }] },
    })
    instance.onEvent('send_message', {
      input: { text: 'ordinary', textFallback: 'ordinary' },
      // no force — goes through the normal send-guarded path (the adapter decides queueing)
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toEqual({})
  })

  it('waiting_approval with auto-approve is NOT modal-parked (auto-approve dismisses it) → force-injects', () => {
    const { instance, sendMessage } = makeStubInstance({ adapterStatus: 'waiting_approval', autoApprove: true })
    instance.onEvent('send_message', {
      input: { text: 'completion', textFallback: 'completion' },
      force: true,
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toEqual({ force: true })
  })
})
