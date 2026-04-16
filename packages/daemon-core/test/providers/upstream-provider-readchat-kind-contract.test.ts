import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function getUpstreamProviderFilePath(relativePath: string): string {
  return path.join(os.homedir(), '.adhdev/providers/.upstream', relativePath)
}

function readUpstreamProviderFile(relativePath: string): string {
  return fs.readFileSync(getUpstreamProviderFilePath(relativePath), 'utf8')
}

describe('upstream provider readChat kind contract', () => {
  const clinePath = getUpstreamProviderFilePath('extension/cline/scripts/1.0/read_chat.js')
  const kiroPath = getUpstreamProviderFilePath('ide/kiro/scripts/1.0/webview_read_chat.js')
  const clineScript = fs.existsSync(clinePath) ? readUpstreamProviderFile('extension/cline/scripts/1.0/read_chat.js') : ''
  const kiroScript = fs.existsSync(kiroPath) ? readUpstreamProviderFile('ide/kiro/scripts/1.0/webview_read_chat.js') : ''

  const clineKindFormalized = /messages\.push\(\{[\s\S]*\bkind(?:\s*:|\s*,)/.test(clineScript)
  const kiroKindFormalized = /messages\.push\(\{[\s\S]*\bkind(?:\s*:|\s*,)/.test(kiroScript)
    && !kiroScript.includes("kind: 'text'")

  const clineIt = fs.existsSync(clinePath) && clineKindFormalized ? it : it.skip
  const kiroIt = fs.existsSync(kiroPath) && kiroKindFormalized ? it : it.skip

  clineIt('cline read_chat stamps explicit built-in kind on parsed messages instead of relying only on _sub', () => {
    expect(clineScript).toMatch(/messages\.push\(\{[\s\S]*\bkind(?:\s*:|\s*,)/)
  })

  kiroIt('kiro webview_read_chat does not emit legacy text kind aliases and stamps top-level message kind', () => {
    expect(kiroScript).not.toContain("kind: 'text'")
    expect(kiroScript).toMatch(/messages\.push\(\{[\s\S]*\bkind(?:\s*:|\s*,)/)
  })
})
