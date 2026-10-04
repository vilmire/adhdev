// The approval push shows the first 80 characters of modalMessage. Codex puts
// "Environment:" and "Reason:" lines before "$ <command>", so the command was
// cut off; the shell-command line is now sent first (same text, new order).
import { describe, expect, it } from 'vitest'
import { commandFirstModalMessage, projectServerStatusEvent } from '../../src/status/status-event.js'

const codex = [
  'Would you like to run the following command?',
  'Environment: local',
  'Reason: Allow me to create and remove the requested file in your home',
  'directory?',
  '$ touch ~/adhdev-outside-check2 && rm ~/adhdev-outside-check2',
].join('\n')

describe('commandFirstModalMessage', () => {
  it('moves the shell command line to the front, keeping every other line', () => {
    const out = commandFirstModalMessage(codex)
    expect(out.split('\n')[0]).toBe('$ touch ~/adhdev-outside-check2 && rm ~/adhdev-outside-check2')
    expect(out.split('\n').slice(1)).toEqual(codex.split('\n').slice(0, 4))
    expect(out.slice(0, 80)).toContain('touch ~/adhdev-outside-check2')
  })

  it('leaves messages without a $ line, or already starting with it, unchanged', () => {
    const claude = 'Bash command\ntouch .adhdev-deep-check && rm .adhdev-deep-check\nCreate and remove a temp marker file'
    expect(commandFirstModalMessage(claude)).toBe(claude)
    expect(commandFirstModalMessage('$ ls\nfoo')).toBe('$ ls\nfoo')
  })

  it('is applied to the server status event payload', () => {
    const payload = projectServerStatusEvent({ event: 'agent:waiting_approval', modalMessage: codex } as any) as any
    expect(payload?.modalMessage?.split('\n')[0]).toMatch(/^\$ touch/)
  })
})
