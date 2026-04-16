import { describe, expect, it } from 'vitest'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'
import {
  assertProviderSupportsDeclaredInput,
  assertTextOnlyInput,
  getDeclaredProviderInputSupport,
} from '../../src/providers/provider-input-support.js'

describe('provider input support', () => {
  it('defaults providers without declared capabilities to text-only input', () => {
    const support = getDeclaredProviderInputSupport(undefined)
    expect(support.multipart).toBe(false)
    expect([...support.mediaTypes]).toEqual(['text'])
  })

  it('rejects non-text input for text-only providers', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'describe this' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
      },
    })

    expect(() => assertTextOnlyInput({ name: 'CLI Test', type: 'cli-test' } as any, input))
      .toThrow('CLI Test only supports text input; unsupported input type: image')
  })

  it('enforces declared media types and multipart support', () => {
    const imageInput = normalizeInputEnvelope({
      input: {
        parts: [{ type: 'image', mimeType: 'image/png', data: 'img-base64' }],
      },
    })
    expect(() => assertProviderSupportsDeclaredInput({
      name: 'ACP Test',
      type: 'acp-test',
      capabilities: { input: { multipart: false, mediaTypes: ['text'] } },
    } as any, imageInput)).toThrow('ACP Test does not support input type: image')

    const multipartInput = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
        textFallback: 'inspect this',
      },
    })
    expect(() => assertProviderSupportsDeclaredInput({
      name: 'ACP Test',
      type: 'acp-test',
      capabilities: { input: { multipart: false, mediaTypes: ['text', 'image'] } },
    } as any, multipartInput)).toThrow('ACP Test does not support multipart input')
  })

  it('accepts declared multipart media input when the provider advertises support', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        ],
        textFallback: 'inspect this',
      },
    })

    expect(() => assertProviderSupportsDeclaredInput({
      name: 'ACP Test',
      type: 'acp-test',
      capabilities: { input: { multipart: true, mediaTypes: ['text', 'image'] } },
    } as any, input)).not.toThrow()
  })
})
