import { describe, expect, it } from 'vitest'
import { getCliScriptCommand } from '../../src/providers/cli-script-results'

describe('cli script command parsing', () => {
  it('preserves an explicit pty_write enter count for slash-command TUIs', () => {
    expect(getCliScriptCommand({
      command: { type: 'pty_write', text: '/model', enterCount: 2 },
    })).toEqual({ type: 'pty_write', text: '/model', enterCount: 2 })
  })

  it('defaults to a single enter when enterCount is absent or invalid', () => {
    expect(getCliScriptCommand({
      command: { type: 'pty_write', text: '/fast off', enterCount: 99 },
    })).toEqual({ type: 'pty_write', text: '/fast off' })
  })
})
