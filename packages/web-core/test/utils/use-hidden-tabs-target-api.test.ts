import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('hidden-tab hook target-owned API', () => {
  it('does not expose redundant raw-key hide/show/toggle helpers once target-based helpers own the conversion', () => {
    const source = readSource('hooks/useHiddenTabs.ts')

    expect(source).not.toContain('const toggleTab =')
    expect(source).not.toContain('const hideTab =')
    expect(source).not.toContain('const showTab =')
    expect(source).not.toContain('return { hiddenTabs, toggleTab, hideTab, showTab,')
  })
})
