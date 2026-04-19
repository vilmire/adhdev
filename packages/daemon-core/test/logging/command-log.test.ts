import { describe, expect, it } from 'vitest'
import { shouldLogCommand } from '../../src/logging/command-log'

describe('command-log noise filter', () => {
  it('skips high-frequency read and seen commands', () => {
    expect(shouldLogCommand('heartbeat')).toBe(false)
    expect(shouldLogCommand('status_report')).toBe(false)
    expect(shouldLogCommand('read_chat')).toBe(false)
    expect(shouldLogCommand('mark_session_seen')).toBe(false)
  })

  it('keeps user-visible control commands loggable', () => {
    expect(shouldLogCommand('send_chat')).toBe(true)
    expect(shouldLogCommand('set_cli_view_mode')).toBe(true)
  })
})
