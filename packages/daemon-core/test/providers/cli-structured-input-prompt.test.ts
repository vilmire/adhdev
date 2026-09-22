import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeInputEnvelope } from '../../src/providers/contracts.js'
import { buildCliStructuredInputPrompt } from '../../src/providers/cli-provider-instance.js'

import { LOG } from '../../src/logging/logger.js'

afterEach(() => vi.restoreAllMocks())

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
    const debug = vi.spyOn(LOG, 'debug').mockImplementation(() => {})
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
    expect(debug).toHaveBeenCalledWith('CLI', `materializeImageDataPart path=${imagePath} bytes=9 partIndex=0`)
    expect(debug).toHaveBeenCalledWith('CLI', 'buildCliStructuredInputPrompt parts=1 images=1 resources=0')
    const logs = JSON.stringify(debug.mock.calls)
    expect(logs).not.toContain('png-bytes')
    expect(logs).not.toContain(Buffer.from('png-bytes').toString('base64'))
    expect(logs).not.toContain('describe this')
  })
})
