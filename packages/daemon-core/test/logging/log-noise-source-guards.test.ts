import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('CLI/provider diagnostic logging noise guards', () => {
  it('keeps settled parser diagnostics out of the default info stream', () => {
    const source = readFileSync(resolve(__dirname, '../../src/cli-adapters/provider-cli-adapter.ts'), 'utf8')

    expect(source).not.toContain("LOG.info(\n            'CLI',\n            `[${this.cliType}] settled diagnostics")
    expect(source).toContain("LOG.debug(\n            'CLI',\n            `[${this.cliType}] settled diagnostics")
  })

  it('keeps provider compatibility script resolution out of the default info stream', () => {
    const source = readFileSync(resolve(__dirname, '../../src/providers/provider-loader.ts'), 'utf8')

    expect(source).not.toContain('this.log(`  [compatibility]')
    expect(source).toContain('this.debugLog(`  [compatibility]')
  })
})
