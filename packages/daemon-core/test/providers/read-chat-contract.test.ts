import { describe, expect, it } from 'vitest'
import { validateReadChatResultPayload } from '../../src/providers/read-chat-contract.js'

describe('read chat contract validation', () => {
  it('accepts canonical read chat payloads plus additive transcript identity fields', () => {
    expect(validateReadChatResultPayload({
      id: 'active',
      title: 'Hermes Agent',
      status: 'idle',
      currentTurnId: 'turn-1',
      turnStatus: 'complete',
      messages: [
        { role: 'user', content: 'hello', bubbleId: 'bubble-user-1', providerUnitKey: 'provider:user:1', bubbleState: 'final' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          _turnKey: 'turn-1',
          bubbleId: 'bubble-assistant-1',
          providerUnitKey: 'provider:assistant:1',
          bubbleState: 'streaming',
          transcriptVisibility: 'internal',
          visibility: 'debug',
          audience: 'debug',
          source: 'runtime_activity',
          userFacing: false,
          internal: true,
          isInternal: true,
          debug: true,
          meta: { transcriptVisibility: 'internal', source: 'runtime_activity', audience: 'debug', userFacing: false, internal: true, isInternal: true, debug: true },
        },
      ],
      activeModal: null,
      controlValues: { model: 'sonnet', compact: true },
    }, 'test')).toMatchObject({
      status: 'idle',
      currentTurnId: 'turn-1',
      turnStatus: 'complete',
      messages: [
        { role: 'user', content: 'hello', bubbleId: 'bubble-user-1', providerUnitKey: 'provider:user:1', bubbleState: 'final' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          _turnKey: 'turn-1',
          bubbleId: 'bubble-assistant-1',
          providerUnitKey: 'provider:assistant:1',
          bubbleState: 'streaming',
          transcriptVisibility: 'internal',
          visibility: 'debug',
          audience: 'debug',
          source: 'runtime_activity',
          userFacing: false,
          internal: true,
          isInternal: true,
          debug: true,
          meta: { transcriptVisibility: 'internal', source: 'runtime_activity', audience: 'debug', userFacing: false, internal: true, isInternal: true, debug: true },
        },
      ],
      controlValues: { model: 'sonnet', compact: true },
    })
  })

  it('rejects invalid statuses', () => {
    expect(() => validateReadChatResultPayload({
      status: 'broken',
      messages: [],
    }, 'test')).toThrow('status must be one of')
  })

  it('rejects invalid message roles and content', () => {
    expect(() => validateReadChatResultPayload({
      status: 'idle',
      messages: [{ role: 'bot', content: 'hello' }],
    }, 'test')).toThrow('messages[0].role must be one of')

    expect(() => validateReadChatResultPayload({
      status: 'idle',
      messages: [{ role: 'assistant', content: { text: 'hello' } }],
    }, 'test')).toThrow('messages[0].content must be a string or structured content array')
  })

  it('rejects waiting_approval payloads without a valid modal', () => {
    expect(() => validateReadChatResultPayload({
      status: 'waiting_approval',
      messages: [],
    }, 'test')).toThrow('waiting_approval status requires activeModal with buttons')

    expect(() => validateReadChatResultPayload({
      status: 'waiting_approval',
      messages: [],
      activeModal: { message: 'Approve?', buttons: [''] },
    }, 'test')).toThrow('activeModal.buttons must be a non-empty string array')
  })

  it('rejects non-scalar control values', () => {
    expect(() => validateReadChatResultPayload({
      status: 'idle',
      messages: [],
      controlValues: { model: { value: 'sonnet' } },
    }, 'test')).toThrow('controlValues.model must be string, number, or boolean')
  })

  it('passes through native turn-terminal markers with light shape validation', () => {
    const validated = validateReadChatResultPayload({
      status: 'idle',
      messages: [],
      turnTerminalMarkers: [
        { receivedAt: 1720000000000, outcome: 'completed', summary: 'done', turnId: '3' },
        { receivedAt: 1720000001000, outcome: 'aborted', summary: '' },
      ],
    }, 'test')
    expect(validated.turnTerminalMarkers).toEqual([
      { receivedAt: 1720000000000, outcome: 'completed', summary: 'done', turnId: '3' },
      { receivedAt: 1720000001000, outcome: 'aborted', summary: '' },
    ])

    // Empty array is valid: "native read happened, no terminal marker".
    expect(validateReadChatResultPayload({
      status: 'idle',
      messages: [],
      turnTerminalMarkers: [],
    }, 'test').turnTerminalMarkers).toEqual([])

    // Absent field stays absent (old daemon / PTY fallback signal).
    expect(validateReadChatResultPayload({
      status: 'idle',
      messages: [],
    }, 'test').turnTerminalMarkers).toBeUndefined()

    expect(() => validateReadChatResultPayload({
      status: 'idle',
      messages: [],
      turnTerminalMarkers: [{ receivedAt: 1720000000000, outcome: 'finished', summary: 'done' }],
    }, 'test')).toThrow("turnTerminalMarkers[0].outcome must be 'completed' or 'aborted'")

    expect(() => validateReadChatResultPayload({
      status: 'idle',
      messages: [],
      turnTerminalMarkers: [{ outcome: 'completed', summary: 'done' }],
    }, 'test')).toThrow('turnTerminalMarkers[0].receivedAt must be a finite number')
  })
})
