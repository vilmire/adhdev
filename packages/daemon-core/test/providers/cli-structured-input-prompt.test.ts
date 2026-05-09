import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'
import { buildCliStructuredInputPrompt } from '../../src/providers/cli-provider-instance.js'

describe('CLI structured input prompt builder', () => {
  it('places local image file path first so Hermes file-drop image detection can consume it', () => {
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/screenshot.png', alt: 'dashboard screenshot' },
        ],
        textFallback: 'what is in this image?',
      },
    })

    expect(buildCliStructuredInputPrompt(input)).toBe('/tmp/screenshot.png\nwhat is in this image?\ndashboard screenshot')
  })

  it('materializes base64 image data to a temporary image file before building the prompt', () => {
    const materializeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-cli-image-input-'))
    const input = normalizeInputEnvelope({
      input: {
        parts: [
          { type: 'image', mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') },
        ],
        textFallback: 'describe this',
      },
    })

    const prompt = buildCliStructuredInputPrompt(input, { materializeDir })
    const [imagePath, text] = prompt.split('\n')

    expect(imagePath.startsWith(materializeDir)).toBe(true)
    expect(imagePath.endsWith('.png')).toBe(true)
    expect(fs.readFileSync(imagePath, 'utf8')).toBe('png-bytes')
    expect(text).toBe('describe this')
  })
})
