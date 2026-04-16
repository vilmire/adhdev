import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function readUpstreamProviderFile(relativePath: string): string {
  const filePath = path.join(os.homedir(), '.adhdev/providers/.upstream', relativePath)
  return fs.readFileSync(filePath, 'utf8')
}

describe('upstream provider readChat kind contract', () => {
  it('cline read_chat stamps explicit built-in kind on parsed messages instead of relying only on _sub', () => {
    const script = readUpstreamProviderFile('extension/cline/scripts/1.0/read_chat.js')

    expect(script).toMatch(/messages\.push\(\{[\s\S]*\bkind(?:\s*:|\s*,)/)
  })

  it('kiro webview_read_chat does not emit legacy text kind aliases and stamps top-level message kind', () => {
    const script = readUpstreamProviderFile('ide/kiro/scripts/1.0/webview_read_chat.js')

    expect(script).not.toContain("kind: 'text'")
    expect(script).toMatch(/messages\.push\(\{[\s\S]*\bkind(?:\s*:|\s*,)/)
  })
})
