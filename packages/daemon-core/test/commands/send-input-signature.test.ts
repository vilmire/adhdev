import { describe, expect, it } from 'vitest'
import { buildSendInputSignature } from '../../src/commands/chat-commands.js'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'

describe('send input signature', () => {
  it('distinguishes same text fallback with different image URIs or data without embedding full data', () => {
    const base = {
      textFallback: 'inspect this',
      parts: [
        { type: 'text', text: 'inspect this' },
      ],
    }
    const imageA = normalizeInputEnvelope({ input: { ...base, parts: [...base.parts, { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/a.png', data: 'aaa-image-data' }] } })
    const imageB = normalizeInputEnvelope({ input: { ...base, parts: [...base.parts, { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/b.png', data: 'bbb-image-data' }] } })
    const imageC = normalizeInputEnvelope({ input: { ...base, parts: [...base.parts, { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/a.png', data: 'different-image-data' }] } })

    expect(buildSendInputSignature(imageA)).not.toEqual(buildSendInputSignature(imageB))
    expect(buildSendInputSignature(imageA)).not.toEqual(buildSendInputSignature(imageC))
    expect(buildSendInputSignature(imageA)).not.toContain('aaa-image-data')
  })
})
