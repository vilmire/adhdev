import { describe, expect, it } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'

describe('buildSessionEntries open_panel capability surface', () => {
  it('stays fail-closed by default and does not expose open_panel unless provider state explicitly declares it', () => {
    const sessions = buildSessionEntries([
      {
        category: 'ide',
        type: 'cursor',
        name: 'Cursor',
        instanceId: 'ide-1',
        status: 'idle',
        workspace: '/repo',
        activeChat: null,
        extensions: [
          {
            category: 'extension',
            type: 'claude-code-vscode',
            name: 'Claude Code (VS Code)',
            instanceId: 'ext-1',
            status: 'panel_hidden',
            activeChat: null,
            lastUpdated: 1,
            settings: {},
            pendingEvents: [],
          },
        ],
        lastUpdated: 1,
        settings: {},
        pendingEvents: [],
      } as any,
    ], new Map(), { profile: 'full' })

    const ideSession = sessions.find((session) => session.id === 'ide-1')
    const extSession = sessions.find((session) => session.id === 'ext-1')

    expect(ideSession?.capabilities || []).not.toContain('open_panel')
    expect(extSession?.capabilities || []).not.toContain('open_panel')
  })

  it('preserves open_panel when provider state explicitly declares support from resolved scripts, even if the panel is hidden and no streams are active yet', () => {
    const sessions = buildSessionEntries([
      {
        category: 'ide',
        type: 'cursor',
        name: 'Cursor',
        instanceId: 'ide-2',
        status: 'idle',
        workspace: '/repo',
        activeChat: null,
        sessionCapabilities: ['read_chat', 'send_message', 'open_panel'],
        extensions: [
          {
            category: 'extension',
            type: 'claude-code-vscode',
            name: 'Claude Code (VS Code)',
            instanceId: 'ext-2',
            status: 'panel_hidden',
            activeChat: null,
            sessionCapabilities: ['read_chat', 'send_message', 'open_panel'],
            lastUpdated: 1,
            settings: {},
            pendingEvents: [],
          },
        ],
        lastUpdated: 1,
        settings: {},
        pendingEvents: [],
      } as any,
      {
        category: 'cli',
        type: 'codex-cli',
        name: 'Codex CLI',
        instanceId: 'cli-1',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: null,
      } as any,
    ], new Map(), { profile: 'full' })

    const ideSession = sessions.find((session) => session.id === 'ide-2')
    const extSession = sessions.find((session) => session.id === 'ext-2')
    const cliSession = sessions.find((session) => session.id === 'cli-1')

    expect(ideSession?.capabilities).toContain('open_panel')
    expect(extSession?.capabilities).toContain('open_panel')
    expect(cliSession?.capabilities || []).not.toContain('open_panel')
  })
})
