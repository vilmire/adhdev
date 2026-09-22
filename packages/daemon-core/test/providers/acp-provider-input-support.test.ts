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
      { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64', transcript: 'spoken summary' },
      { type: 'text', text: 'spoken summary' },
      { type: 'resource', resource: { uri: 'file:///tmp/spec.md', text: '# Spec', mimeType: null } },
      { type: 'resource', resource: { uri: 'file:///tmp/blob.bin', blob: 'blob-base64', mimeType: 'application/octet-stream' } },
    ])
  })

  it('preserves image alt text when native ACP image input is supported', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'image', mimeType: 'image/png', data: 'img-base64', uri: 'file:///tmp/diagram.png', alt: 'diagram of flow' },
        ],
      },
    })

    expect(buildAcpPromptParts(input, {
      promptCapabilities: { image: true },
    })).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'img-base64', uri: 'file:///tmp/diagram.png', alt: 'diagram of flow' },
      { type: 'text', text: 'diagram of flow' },
    ])
  })

  it('preserves resource_link semantic metadata in ACP prompt parts', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          {
            type: 'resource_link',
            uri: 'file:///tmp/report.md',
            name: 'report.md',
            title: 'Quarterly report',
            description: 'Executive summary document',
            mimeType: 'text/markdown',
            size: 1234,
            annotations: { audience: ['user'], priority: 0.7 },
          },
        ],
        textFallback: '',
      },
    })

    expect(buildAcpPromptParts(input, { promptCapabilities: {} })).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///tmp/report.md',
        name: 'report.md',
        title: 'Quarterly report',
        description: 'Executive summary document',
        mimeType: 'text/markdown',
        size: 1234,
        annotations: { audience: ['user'], priority: 0.7 },
      },
    ])
  })

  it('serializes resource_link metadata when sending ACP prompts', async () => {
    const prompt = vi.fn().mockResolvedValue({})
    const instance = Object.create(AcpProviderInstance.prototype) as any
    instance.connection = { prompt }
    instance.sessionId = 'session-1'
    instance.type = 'acp-test'
    instance.log = { warn: vi.fn(), info: vi.fn() }
    instance.messages = []
    instance.detectStatusTransition = vi.fn()
    instance.finalizeAssistantMessage = vi.fn()

    await instance.sendPrompt('see resource', [
      {
        type: 'resource_link',
        uri: 'file:///tmp/report.md',
        name: 'report.md',
        title: 'Quarterly report',
        description: 'Executive summary document',
        mimeType: 'text/markdown',
        size: 1234,
        annotations: { audience: ['user'], priority: 0.7 },
      },
    ])

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [
        {
          type: 'resource_link',
          uri: 'file:///tmp/report.md',
          name: 'report.md',
          title: 'Quarterly report',
          description: 'Executive summary document',
          mimeType: 'text/markdown',
          size: 1234,
          annotations: { audience: ['user'], priority: 0.7 },
        },
      ],
    })
  })

  it('degrades image input semantically when the ACP agent does not advertise native image support', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'check the artifacts' },
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/image.png', data: 'img-base64', alt: 'diagram of flow' },
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
      { type: 'resource_link', uri: 'file:///tmp/image.png', name: 'image.png', mimeType: 'image/png', description: 'diagram of flow' },
      { type: 'text', text: 'diagram of flow' },
    ])
  })

  it('degrades URI media to resource links when inline native ACP media data is missing', () => {
    const imageOnly = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/image.png' },
        ],
      },
    })
    expect(buildAcpPromptParts(imageOnly, { promptCapabilities: { image: true } }))
      .toEqual([
        { type: 'resource_link', uri: 'file:///tmp/image.png', name: 'image.png', mimeType: 'image/png' },
      ])

    const audioOnly = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/audio.mp3' },
        ],
      },
    })
    expect(buildAcpPromptParts(audioOnly, { promptCapabilities: { audio: true } }))
      .toEqual([
        { type: 'resource_link', uri: 'file:///tmp/audio.mp3', name: 'audio.mp3', mimeType: 'audio/mpeg' },
      ])
  })

  it('degrades ACP video input to resource link/text because ACP has no native video prompt capability', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [{ type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/video.mp4', transcript: 'walkthrough transcript' }],
      },
    })

    expect(buildAcpPromptParts(input, {
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
    })).toEqual([
      { type: 'resource_link', uri: 'file:///tmp/video.mp4', name: 'video.mp4', mimeType: 'video/mp4', description: 'walkthrough transcript' },
      { type: 'text', text: 'walkthrough transcript' },
    ])
  })

  it('keeps URI-less media visible as descriptive text fallbacks', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'image', mimeType: 'image/png', alt: 'clipboard screenshot' },
          { type: 'audio', mimeType: 'audio/wav', transcript: 'hello from audio' },
          { type: 'video', mimeType: 'video/mp4' },
        ],
      },
    })

    expect(buildAcpPromptParts(input, { promptCapabilities: {} })).toEqual([
      { type: 'text', text: '[Image attachment: clipboard screenshot: image/png]' },
      { type: 'text', text: '[Audio attachment: hello from audio: audio/wav]' },
      { type: 'text', text: '[Video attachment: video/mp4]' },
    ])
  })

  it('passes normalized multipart input through onEvent(send_message)', async () => {
    const instance = Object.create(AcpProviderInstance.prototype) as any
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
    // SEND-RECORD-SYMMETRY: onEvent now refuses a send with no live session rather
    // than firing it into the void, so the fixture must model a connected instance.
    instance.connection = { prompt: vi.fn() }
    instance.sessionId = 'acp-session-1'
    instance._sendPromptInFlight = false

    const ack = await instance.onEvent('send_message', {
      input: {
        parts: [
          { type: 'text', text: 'inspect these assets' },
          { type: 'image', mimeType: 'image/png', data: 'img-base64' },
          { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64' },
        ],
        textFallback: 'inspect these assets',
      },
    })

    expect(ack).toEqual({ success: true, status: 'delivered' })
    await vi.waitFor(() => {
      expect(instance.sendPrompt).toHaveBeenCalledWith('inspect these assets', [
        { type: 'text', text: 'inspect these assets' },
        { type: 'image', mimeType: 'image/png', data: 'img-base64' },
        { type: 'audio', mimeType: 'audio/mpeg', data: 'audio-base64' },
      // onEvent claims the in-flight slot itself so the refusal decision and the
      // claim are atomic; sendPrompt is told not to re-claim.
      ], { alreadyClaimed: true })
    })
  })

  /**
   * SEND-RECORD-SYMMETRY — an ACP send that is refused must say so.
   *
   * Both refusals below return BEFORE any delivery commitment, and both were
   * previously fire-and-forget: handleSendChat reported `success: true` for a prompt
   * the agent never received, leaving a bubble in the transcript with nothing behind
   * it. (The mid-turn `connection.prompt` failure is deliberately NOT covered here —
   * sendPrompt finalizes the turn and returns to idle, treating it as having
   * happened, and the user bubble is intentionally kept.)
   */
  function makeLiveInstance() {
    const instance = Object.create(AcpProviderInstance.prototype) as any
    instance.sendPrompt = vi.fn().mockResolvedValue(undefined)
    instance.agentCapabilities = { promptCapabilities: {} }
    instance.provider = { name: 'ACP Test', type: 'acp-test', capabilities: { input: { multipart: false, mediaTypes: ['text'] } } }
    instance.type = 'acp-test'
    instance.log = { warn: vi.fn(), info: vi.fn() }
    instance.connection = { prompt: vi.fn() }
    instance.sessionId = 'acp-session-1'
    instance._sendPromptInFlight = false
    return instance
  }

  const TEXT_SEND = { input: { parts: [{ type: 'text', text: 'hello' }], textFallback: 'hello' } }

  it('reports failure when there is no live ACP connection or session', async () => {
    const instance = makeLiveInstance()
    instance.connection = null
    instance.sessionId = null

    const ack = await instance.onEvent('send_message', TEXT_SEND)

    expect(ack).toMatchObject({ success: false })
    expect((ack as any).error).toMatch(/connection|session/i)
    // Nothing was attempted — this is the case that must not read as a send.
    expect(instance.sendPrompt).not.toHaveBeenCalled()
  })

  it('reports failure when a prompt is already in flight', async () => {
    const instance = makeLiveInstance()
    instance._sendPromptInFlight = true

    const ack = await instance.onEvent('send_message', TEXT_SEND)

    expect(ack).toMatchObject({ success: false })
    expect((ack as any).error).toMatch(/in flight/i)
    expect(instance.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not leave the in-flight slot claimed after a refused concurrent send', async () => {
    const instance = makeLiveInstance()
    instance._sendPromptInFlight = true

    await instance.onEvent('send_message', TEXT_SEND)

    // The refusal must not clear a claim it never made — the real prompt still owns it.
    expect(instance._sendPromptInFlight).toBe(true)
  })
})
