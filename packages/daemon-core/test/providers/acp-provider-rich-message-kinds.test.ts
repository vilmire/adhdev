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
})
