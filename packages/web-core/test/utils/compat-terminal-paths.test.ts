import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectionManager } from '../../src/compat'

describe('compat connection manager terminal surface', () => {
  it('does not expose a PTY resize helper on the web-core stub surface', () => {
    expect('sendPtyResize' in connectionManager).toBe(false)
  })

  it('does not wire terminal resize callbacks through the CliTerminal wrapper', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/CliTerminal.tsx'), 'utf8')
    expect(source.includes('onResize={onResize}')).toBe(false)
  })
})
