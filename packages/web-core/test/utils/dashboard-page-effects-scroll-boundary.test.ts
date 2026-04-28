import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard page effects scroll boundary', () => {
  it('does not globally force visible chat panes to an edge when the active conversation changes', () => {
    const source = readSource('hooks/useDashboardPageEffects.ts')

    expect(source).not.toContain("querySelectorAll<HTMLElement>('[data-chat-scroll]')")
    expect(source).not.toContain('el.scrollTop = el.scrollHeight')
  })
})
