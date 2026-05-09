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
            { mediaType: 'image', strategies: ['native_acp'], native: true, degradation: ['resource_link', 'text_fallback'] },
          ],
        },
      },
    } as any)
    expect(support.strategies).toEqual([
      { mediaType: 'image', strategies: ['native_acp'], native: true, degradation: ['resource_link', 'text_fallback'] },
    ])
  })

  it('keeps ACP effective support text-only when input media is not declared', () => {
    const support = getEffectiveMessageInputSupport({ category: 'acp' } as any, { promptCapabilities: { image: true, audio: true, embeddedContext: true } })
    expect(support).toEqual({ text: true, multipart: false, mediaTypes: ['text'], strategies: [] })
  })

  it('computes ACP effective native media only from declared input and runtime prompt capabilities and never native video', () => {
    const provider = {
      category: 'acp',
      capabilities: { input: { multipart: true, mediaTypes: ['text', 'image', 'audio', 'video'] } },
    } as any

    const withoutRuntimeCaps = getEffectiveMessageInputSupport(provider, { promptCapabilities: { image: false, audio: false } })
    expect(withoutRuntimeCaps.strategies.find((entry) => entry.mediaType === 'image')?.native).toBe(false)
    expect(withoutRuntimeCaps.strategies.find((entry) => entry.mediaType === 'audio')?.native).toBe(false)

    const withRuntimeCaps = getEffectiveMessageInputSupport(provider, { promptCapabilities: { image: true, audio: true } })
    expect(withRuntimeCaps.strategies.find((entry) => entry.mediaType === 'image')?.strategies).toContain('native_acp')
    expect(withRuntimeCaps.strategies.find((entry) => entry.mediaType === 'audio')?.strategies).toContain('native_acp')
    expect(withRuntimeCaps.strategies.find((entry) => entry.mediaType === 'video')?.strategies).not.toContain('native_acp')
    expect(withRuntimeCaps.strategies.find((entry) => entry.mediaType === 'video')?.degradation).toEqual(['resource_link', 'text_fallback'])
  })
})
