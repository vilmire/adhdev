import { describe, expect, it } from 'vitest'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'
import {
  assertProviderSupportsDeclaredInput,
  assertTextOnlyInput,
  getDeclaredProviderInputSupport,
  getEffectiveMessageInputSupport,
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
      name: 'CLI Test',
      type: 'cli-test',
      capabilities: { input: { multipart: false, mediaTypes: ['text'] } },
    } as any, imageInput)).toThrow('CLI Test does not support input type: image')

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
      name: 'CLI Test',
      type: 'cli-test',
      capabilities: { input: { multipart: false, mediaTypes: ['text', 'image'] } },
    } as any, multipartInput)).toThrow('CLI Test does not support multipart input')
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
      name: 'CLI Test',
      type: 'cli-test',
      capabilities: { input: { multipart: true, mediaTypes: ['text', 'image'] } },
    } as any, input)).not.toThrow()
  })

  it('accepts strategy descriptors and still defaults absent capabilities to text-only', () => {
    const absent = getDeclaredProviderInputSupport(undefined)
    expect(absent.multipart).toBe(false)
    expect([...absent.mediaTypes]).toEqual(['text'])

    const support = getDeclaredProviderInputSupport({
      capabilities: {
        input: {
          multipart: true,
          mediaTypes: ['text', 'image'],
          strategies: [
            { mediaType: 'image', strategies: ['native'], native: true, degradation: ['resource_link', 'text_fallback'] },
          ],
        },
      },
    } as any)
    expect(support.strategies).toEqual([
      { mediaType: 'image', strategies: ['native'], native: true, degradation: ['resource_link', 'text_fallback'] },
    ])
  })

  it('exposes declared provider input support without enabling undeclared providers', () => {
    expect(getEffectiveMessageInputSupport({ category: 'cli' } as any)).toEqual({ text: true, multipart: false, mediaTypes: ['text'], strategies: [] })

    const support = getEffectiveMessageInputSupport({
      category: 'cli',
      capabilities: {
        input: {
          multipart: true,
          mediaTypes: ['text', 'image'],
          strategies: [
            { mediaType: 'image', strategies: ['resource_link', 'text_fallback'], native: false, degradation: ['text_fallback'] },
          ],
        },
      },
    } as any)

    expect(support).toEqual({
      text: true,
      multipart: true,
      mediaTypes: ['text', 'image'],
      strategies: [
        { mediaType: 'image', strategies: ['resource_link', 'text_fallback'], native: false, degradation: ['text_fallback'] },
      ],
    })
  })
})
