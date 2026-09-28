import { describe, expect, it } from 'vitest'
import { AcpProviderInstance } from '../../src/providers/acp-provider-instance.js'
import { MessageIdentityLedger } from '../../src/chat/message-identity-ledger.js'
import { toMessageIdentityInput } from '../../src/commands/read-chat-message-identity.js'

/**
 * ACP partial → final succession (design 2026-09-28 §3.4): the streaming
 * partial thought/answer bubbles and the messages `finalizeAssistantMessage`
 * pushes carry the SAME `acp` source address, so the identity ledger keeps one
 * bubble id from the first partial to the final message.
 */
describe('AcpProviderInstance message source addresses', () => {
  function makeInstance(): any {
    return new AcpProviderInstance({ type: 'acp-test', name: 'ACP Test', category: 'acp' } as any, '/tmp/project') as any
  }

  it('partial and finalized thought/answer share a source address; tools key on toolCallId', () => {
    const instance = makeInstance()
    instance.acpTurnSeq = 3
    instance.currentStatus = 'generating'
    instance.partialThoughtContent = 'Inspecting'
    instance.partialContent = 'Partial answ'
    const partial = instance.getState().activeChat.messages
    expect(partial.map((m: any) => m._src)).toEqual([
      { cls: 'acp', id: 't3.thought' },
      { cls: 'acp', id: 't3.answer' },
    ])

    instance.turnToolCalls = [{ toolCallId: 'tc-1', title: 'Search', kind: 'search', status: 'completed', rawInput: { q: 'x' } }]
    instance.partialContent = 'Partial answer, finished'
    instance.finalizeAssistantMessage()
    instance.currentStatus = 'idle'
    const final = instance.getState().activeChat.messages
    expect(final.map((m: any) => m._src)).toEqual([
      { cls: 'acp', id: 't3.thought' },
      { cls: 'acp', id: 't3.tool.tc-1' },
      { cls: 'acp', id: 't3.answer' },
    ])

    const ledger = new MessageIdentityLedger()
    const before = ledger.observe(partial.map(toMessageIdentityInput))
    const after = ledger.observe(final.map(toMessageIdentityInput))
    expect(after.assignments[0].messageId).toBe(before.assignments[0].messageId)
    expect(after.assignments[2].messageId).toBe(before.assignments[1].messageId)
    expect(after.deletes).toEqual([])
  })

  it('stamps pushed system messages with unique local ids', () => {
    const instance = makeInstance()
    instance.appendSystemMessage('one')
    instance.appendSystemMessage('two')
    const ids = instance.messages.map((m: any) => m._src?.id)
    expect(ids).toEqual(['m1', 'm2'])
  })
})
