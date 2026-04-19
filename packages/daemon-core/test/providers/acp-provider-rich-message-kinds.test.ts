import { describe, expect, it } from 'vitest'
import { AcpProviderInstance } from '../../src/providers/acp-provider-instance.js'

describe('AcpProviderInstance richer message kinds', () => {
  it('surfaces agent thought chunks as thought messages during and after a turn', () => {
    const instance = new AcpProviderInstance({
      type: 'acp-test',
      name: 'ACP Test',
      category: 'acp',
    } as any, '/tmp/project') as any

    instance.handleSessionUpdate({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Inspecting repository structure' },
      },
    })

    expect(instance.getState().activeChat.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'thought',
          content: 'Inspecting repository structure',
        }),
      ]),
    )

    instance.partialContent = 'Done'
    instance.finalizeAssistantMessage()

    expect(instance.getState().activeChat.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'thought',
          content: 'Inspecting repository structure',
        }),
        expect.objectContaining({
          kind: 'standard',
          content: 'Done',
        }),
      ]),
    )
  })

  it('materializes terminal and tool call updates into richer assistant bubbles on finalize', () => {
    const instance = new AcpProviderInstance({
      type: 'acp-test',
      name: 'ACP Test',
      category: 'acp',
    } as any, '/tmp/project') as any

    instance.turnToolCalls = [
      {
        toolCallId: 'tc-terminal',
        title: 'Run npm test',
        kind: 'execute',
        status: 'completed',
        rawOutput: 'PASS test/providers/chat-message-normalization.test.ts',
      },
      {
        toolCallId: 'tc-tool',
        title: 'Search files',
        kind: 'search',
        status: 'completed',
        rawInput: { pattern: 'kind' },
      },
    ]
    instance.partialContent = 'Final answer'

    instance.finalizeAssistantMessage()

    expect(instance.getState().activeChat.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          content: 'PASS test/providers/chat-message-normalization.test.ts',
          meta: expect.objectContaining({
            label: 'Run npm test',
            isRunning: false,
          }),
        }),
        expect.objectContaining({
          kind: 'tool',
          content: expect.stringContaining('Search files'),
        }),
        expect.objectContaining({
          kind: 'standard',
          content: 'Final answer',
        }),
      ]),
    )
  })

  it('returns the full ACP transcript without slicing or text truncation', () => {
    const instance = new AcpProviderInstance({
      type: 'acp-test',
      name: 'ACP Test',
      category: 'acp',
    } as any, '/tmp/project') as any

    const longText = 'x'.repeat(2500)
    instance.messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index === 79 ? longText : `message-${index + 1}`,
      timestamp: index + 1,
      receivedAt: index + 1,
    }))

    const messages = instance.getState().activeChat.messages

    expect(messages).toHaveLength(80)
    expect(messages[0]).toEqual(expect.objectContaining({ content: 'message-1' }))
    expect(messages[79]).toEqual(expect.objectContaining({ content: longText }))
  })

  it('keeps all pending ACP events until flush instead of silently slicing to 50', () => {
    const instance = new AcpProviderInstance({
      type: 'acp-test',
      name: 'ACP Test',
      category: 'acp',
    } as any, '/tmp/project') as any

    for (let index = 0; index < 60; index += 1) {
      instance.pushEvent({ event: 'provider:toast', effectId: `acp-${index + 1}`, timestamp: index + 1, message: `toast-${index + 1}` })
    }

    const first = instance.getState()
    expect(first.pendingEvents).toHaveLength(60)
    expect(first.pendingEvents[0]).toEqual(expect.objectContaining({ message: 'toast-1' }))
    expect(first.pendingEvents[59]).toEqual(expect.objectContaining({ message: 'toast-60' }))

    const second = instance.getState()
    expect(second.pendingEvents).toEqual([])
  })
})
