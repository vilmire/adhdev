import { describe, expect, it, vi } from 'vitest'
import {
  AcpProviderInstance,
  buildAcpPromptParts,
} from '../../src/providers/acp-provider-instance.js'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'

describe('ACP prompt part support', () => {
  it('forwards all ACP-supported prompt part types when the agent advertises support', () => {
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

  it('falls back unsupported ACP prompt parts to baseline-compatible forms', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'check the artifacts' },
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/image.png', alt: 'diagram screenshot' },
          { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/audio.mp3', transcript: 'spoken note' },
          { type: 'resource', uri: 'file:///tmp/spec.md', text: '# Embedded spec' },
          { type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/video.mp4' },
        ],
        textFallback: 'check the artifacts',
      },
    })

    expect(buildAcpPromptParts(input, {
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
    })).toEqual([
      { type: 'text', text: 'check the artifacts' },
      { type: 'resource_link', uri: 'file:///tmp/image.png', name: 'image.png', mimeType: 'image/png' },
      { type: 'text', text: 'diagram screenshot' },
      { type: 'resource_link', uri: 'file:///tmp/audio.mp3', name: 'audio.mp3', mimeType: 'audio/mpeg' },
      { type: 'text', text: 'spoken note' },
      { type: 'resource_link', uri: 'file:///tmp/spec.md', name: 'spec.md' },
      { type: 'text', text: '# Embedded spec' },
      { type: 'resource_link', uri: 'file:///tmp/video.mp4', name: 'video.mp4', mimeType: 'video/mp4' },
    ])
  })

  it('falls back to descriptive text when unsupported inline media has no uri', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'image', mimeType: 'image/png', data: 'img-base64', alt: 'whiteboard photo' },
          { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64', transcript: 'meeting note' },
          { type: 'video', mimeType: 'video/mp4', data: 'video-base64' },
        ],
        textFallback: '',
      },
    })

    expect(buildAcpPromptParts(input, {
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
    })).toEqual([
      { type: 'text', text: 'whiteboard photo' },
      { type: 'text', text: 'meeting note' },
      { type: 'text', text: 'Attached video (video/mp4)' },
    ])
  })

  it('passes normalized multipart input through onEvent(send_message)', async () => {
    const instance = Object.create(AcpProviderInstance.prototype) as AcpProviderInstance & {
      sendPrompt: ReturnType<typeof vi.fn>
      agentCapabilities: Record<string, unknown>
    }
    instance.sendPrompt = vi.fn().mockResolvedValue(undefined)
    instance.agentCapabilities = {
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
    }

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
