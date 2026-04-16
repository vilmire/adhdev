import { describe, expect, it, vi } from 'vitest'
import {
  AcpProviderInstance,
  buildAcpPromptParts,
} from '../../src/providers/acp-provider-instance.js'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'

describe('ACP prompt part support', () => {
  it('forwards ACP-supported prompt part types when the agent advertises support', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'summarize attached context' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
          { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64', transcript: 'spoken summary' },
          { type: 'resource', uri: 'file:///tmp/spec.md', text: '# Spec' },
          { type: 'resource', uri: 'file:///tmp/blob.bin', data: 'blob-base64', mimeType: 'application/octet-stream' },
        ],
        textFallback: 'summarize attached context',
      },
    })

    expect(buildAcpPromptParts(input, {
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
    })).toEqual([
      { type: 'text', text: 'summarize attached context' },
      { type: 'image', mimeType: 'image/png', data: 'img-base64' },
      { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64' },
      { type: 'resource', resource: { uri: 'file:///tmp/spec.md', text: '# Spec', mimeType: null } },
      { type: 'resource', resource: { uri: 'file:///tmp/blob.bin', blob: 'blob-base64', mimeType: 'application/octet-stream' } },
    ])
  })

  it('fails closed when the ACP agent does not advertise support for a requested input type', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'check the artifacts' },
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/image.png', data: 'img-base64' },
        ],
        textFallback: 'check the artifacts',
      },
    })

    expect(() => buildAcpPromptParts(input, {
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
    })).toThrow('ACP agent does not support input type: image')
  })

  it('fails closed when inline ACP media data is missing', () => {
    const imageOnly = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/image.png' },
        ],
      },
    })
    expect(() => buildAcpPromptParts(imageOnly, { promptCapabilities: { image: true } }))
      .toThrow('ACP image input requires inline image data')

    const audioOnly = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/audio.mp3' },
        ],
      },
    })
    expect(() => buildAcpPromptParts(audioOnly, { promptCapabilities: { audio: true } }))
      .toThrow('ACP audio input requires inline audio data')
  })

  it('fails closed for unsupported ACP video input', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [{ type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/video.mp4' }],
      },
    })

    expect(() => buildAcpPromptParts(input, {
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
    })).toThrow('ACP agent does not support input type: video')
  })

  it('passes normalized multipart input through onEvent(send_message)', async () => {
    const instance = Object.create(AcpProviderInstance.prototype) as AcpProviderInstance & {
      sendPrompt: ReturnType<typeof vi.fn>
      agentCapabilities: Record<string, unknown>
      provider: any
      type: string
      log: { warn: ReturnType<typeof vi.fn> }
    }
    instance.sendPrompt = vi.fn().mockResolvedValue(undefined)
    instance.agentCapabilities = {
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
    }
    instance.provider = {
      name: 'ACP Test',
      type: 'acp-test',
      capabilities: {
        input: {
          multipart: true,
          mediaTypes: ['text', 'image', 'audio'],
        },
      },
    }
    instance.type = 'acp-test'
    instance.log = { warn: vi.fn() }

    instance.onEvent('send_message', {
      input: {
        parts: [
          { type: 'text', text: 'inspect these assets' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
          { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64' },
        ],
        textFallback: 'inspect these assets',
      },
    })

    await vi.waitFor(() => {
      expect(instance.sendPrompt).toHaveBeenCalledWith('inspect these assets', [
        { type: 'text', text: 'inspect these assets' },
        { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64' },
      ])
    })
  })
})
