import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('DashboardDockviewWorkspace popout chrome', () => {
  it('deduplicates popout headers by clearing any stale copies before wiring the chrome controls', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../src/components/dashboard/DashboardDockviewWorkspace.tsx'), 'utf8')
    expect(source.includes("const existingHeaders = Array.from(ownerDoc.querySelectorAll<HTMLElement>('#adhdev-popout-header'))")).toBe(true)
    expect(source.includes('for (const existingHeader of existingHeaders) existingHeader.remove()')).toBe(true)
    expect(source.includes("const header = ownerDoc.createElement('div')")).toBe(true)
    expect(source.includes("header.id = 'adhdev-popout-header'")).toBe(true)
  })
})
