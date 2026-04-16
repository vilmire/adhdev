import { describe, expect, it } from 'vitest'
import { validateReadChatResultPayload } from '../../src/providers/read-chat-contract.js'

describe('read chat contract validation', () => {
  it('accepts canonical read chat payloads', () => {
    expect(validateReadChatResultPayload({
      id: 'active',
      title: 'Hermes Agent',
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ],
      activeModal: null,
      controlValues: { model: 'sonnet', compact: true },
    }, 'test')).toMatchObject({
      status: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
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
})
