import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('handleReadChat CLI hotpath logging', () => {
  it('does not emit always-on info logs for every CLI-like read_chat result', () => {
    const source = readFileSync(resolve(__dirname, '../../src/commands/chat-commands.ts'), 'utf8')
    expect(source).not.toContain("LOG.info('Command', `[read_chat] cli-like resolved")
    expect(source).toContain("LOG.debug('Command', `[read_chat] cli-like resolved")
  })
})
