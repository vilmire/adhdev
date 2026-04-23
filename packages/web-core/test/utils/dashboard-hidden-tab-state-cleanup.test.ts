import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard hidden-tab state cleanup', () => {
  it('does not keep dashboard-local hidden-tab key maps and wrapper callbacks once the hook owns target-key conversion', () => {
    const source = readSource('pages/Dashboard.tsx')

    expect(source).not.toContain('hiddenConversationKeyByTabKey')
    expect(source).not.toContain('hideConversationByTabKey')
    expect(source).not.toContain('showConversationByTabKey')
    expect(source).not.toContain('toggleHiddenConversationByTabKey')
    expect(source).not.toContain('getHiddenConversationStorageKey(')
  })
})
