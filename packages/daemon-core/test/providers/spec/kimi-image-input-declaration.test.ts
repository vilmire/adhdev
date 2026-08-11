import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEffectiveMessageInputSupport } from '../../../src/providers/provider-input-support.js'

// kimi image-input declaration guard (kimi provider v1.0.8, 2026-08-12).
//
// The daemon rejects image parts at send time unless the provider declares
// them (assertProviderSupportsDeclaredInput), and the dashboard attach button
// gates on mediaTypes including 'image' + multipart. kimi's CLI delivery is
// the generic structured-input path: the image is materialized to a temp file
// and its path is injected as the first prompt line — verified live against
// kimi 0.34.0, which reads the path with its ReadMediaFile tool and answers
// about the image content. This test pins the shipped manifest declaration so
// a manifest edit can't silently disable image attach for kimi sessions.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadKimiManifest(): Record<string, any> {
    let current = path.resolve(__dirname, '..', '..')
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(current, 'adhdev-providers', 'cli', 'kimi', 'provider.v1.json')
        if (fs.existsSync(candidate)) {
            return JSON.parse(fs.readFileSync(candidate, 'utf8'))
        }
        current = path.dirname(current)
    }
    throw new Error('kimi provider.v1.json not found')
}

describe('kimi manifest image-input declaration', () => {
    it('declares multipart text+image input so dashboard attach and send_chat accept images', () => {
        const manifest = loadKimiManifest()
        const support = getEffectiveMessageInputSupport({
            category: 'cli',
            capabilities: manifest.capabilities,
        } as never)
        expect(support.multipart).toBe(true)
        expect(support.mediaTypes).toContain('image')
        expect(support.mediaTypes).toContain('text')
    })
})
