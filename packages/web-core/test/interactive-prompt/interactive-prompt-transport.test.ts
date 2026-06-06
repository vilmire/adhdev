import { describe, expect, it, vi } from 'vitest'
import { submitInteractivePromptResponse } from '../../src/interactive-prompt/interactive-prompt-transport'

const promptSession = {
  daemonId: 'daemon-1',
  sessionId: 'session-1',
  routeId: 'daemon-1:cli:session-1',
  providerType: 'claude-cli',
  prompt: {
    promptId: 'prompt-1',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 123,
    questions: [],
  },
}

const response = {
  promptId: 'prompt-1',
  answers: {
    q1: { selectedLabels: ['Approve'] },
  },
}

describe('interactive prompt transport', () => {
  it('uses cloud P2P command transport when requested', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ success: true, result: { success: true } })
    const fetchImpl = vi.fn()

    await submitInteractivePromptResponse({
      promptSession,
      response,
      useP2PCommand: true,
      sendCommand,
      fetchImpl,
    })

    expect(sendCommand).toHaveBeenCalledWith('daemon-1:cli:session-1', 'interactive_prompt_response', {
      targetSessionId: 'session-1',
      sessionId: 'session-1',
      response,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses standalone HTTP resolve endpoint when P2P is unavailable', async () => {
    const sendCommand = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(),
    })

    await submitInteractivePromptResponse({
      promptSession,
      response,
      useP2PCommand: false,
      sendCommand,
      fetchImpl,
    })

    expect(sendCommand).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/sessions/session-1/interactive-prompt/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(response),
    })
  })
})
